import {
  fetchCompetitionTable,
  fetchPlayerDetail,
  fetchTeamProfile,
  getActiveKickbaseToken
} from "../adapters/kickbase.adapter.js";
import { getFirestoreClient } from "../config/firestore.config.js";
import { mergeRows } from "./bigquery.services.js";

const COMPETITION_ID = "1"; // 1. Bundesliga

function snapshotDate(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Run a full Kickbase player snapshot:
 *   1. read active Kickbase token from Firestore
 *   2. fetch the competition table -> list of 18 active BL teams
 *   3. for each team, fetch the team profile -> ~26 players
 *   4. upsert each player into Firestore (latest state)
 *   5. MERGE into BigQuery `players` (Kickbase-enriched stammdaten)
 *   6. INSERT into BigQuery `kickbase_market_values` (one row per player per day)
 *
 * @param {import("pino").Logger} log
 * @returns {Promise<{players: number, teams: number, snapshot: string}>}
 *
 * @example
 *   await syncPlayerSnapshot(logger);
 */
export async function syncPlayerSnapshot(log) {
  const kbToken = await getActiveKickbaseToken();
  if (!kbToken) {
    throw new Error(
      "No Kickbase token found in Firestore — log in via Striker so Scout can reuse the session."
    );
  }

  log.info("Fetching competition table for BL1");
  const teams = await fetchCompetitionTable({ kbToken, competitionId: COMPETITION_ID, log });
  log.info({ teamCount: teams.length }, "Got teams");

  const allPlayers = [];
  for (const team of teams) {
    const profile = await fetchTeamProfile({
      kbToken,
      teamId: team.teamId,
      competitionId: COMPETITION_ID,
      log
    });
    log.info({ teamId: team.teamId, players: profile.players.length }, "Got team profile");
    for (const p of profile.players) {
      allPlayers.push({ ...p, teamName: profile.teamName });
    }
  }

  log.info({ totalPlayers: allPlayers.length }, "Aggregated player list");

  // Enrich every player with detail data (averagePoints, totalPoints,
  // pointsHistory). Sequentially to be polite to Kickbase — 489 calls at
  // ~150 ms each finishes in well under 3 minutes.
  log.info("Enriching with player-detail data (avg points / total points)");
  let enriched = 0;
  let detailFailures = 0;
  for (const p of allPlayers) {
    try {
      const detail = await fetchPlayerDetail({
        kbToken,
        playerId: p.playerId,
        competitionId: COMPETITION_ID,
        log
      });
      p.averagePoints = detail.averagePoints ?? null;
      p.totalPoints = detail.totalPoints ?? null;
      p.shirtNumber = detail.shirtNumber ?? null;
      p.goals = detail.goals ?? null;
      p.assists = detail.assists ?? null;
      p.yellowCards = detail.yellowCards ?? null;
      p.redCards = detail.redCards ?? null;
      p.pointsHistory = detail.pointsHistory ?? [];
      enriched++;
    } catch (err) {
      detailFailures++;
      log.warn({ playerId: p.playerId, err: err.message }, "Player detail fetch failed");
    }
  }
  log.info({ enriched, detailFailures }, "Player detail enrichment complete");

  await writeToFirestore(allPlayers, log);
  await writeToBigQuery(allPlayers, log);
  await writePointsHistoryToBigQuery(allPlayers, log);

  return { players: allPlayers.length, teams: teams.length, snapshot: snapshotDate() };
}

async function writeToFirestore(players, log) {
  const db = getFirestoreClient();
  const collection = db.collection("players");
  const now = new Date();

  // Firestore batches max 500 ops at a time.
  const CHUNK = 400;
  for (let i = 0; i < players.length; i += CHUNK) {
    const slice = players.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const p of slice) {
      batch.set(
        collection.doc(p.playerId),
        {
          playerId: p.playerId,
          name: p.name,
          position: p.position,
          status: p.status,
          teamId: p.teamId,
          teamName: p.teamName ?? null,
          marketValue: p.marketValue,
          marketValueTrend24h: p.marketValueTrend24h,
          startingProbability: p.startingProbability,
          imageUrl: p.imageUrl,
          // Enriched from player-detail endpoint
          averagePoints: p.averagePoints ?? null,
          totalPoints: p.totalPoints ?? null,
          shirtNumber: p.shirtNumber ?? null,
          goals: p.goals ?? null,
          assists: p.assists ?? null,
          yellowCards: p.yellowCards ?? null,
          redCards: p.redCards ?? null,
          pointsHistory: p.pointsHistory ?? [],
          lastSyncedAt: now
        },
        { merge: true }
      );
    }
    await batch.commit();
    log.info({ written: slice.length }, "Firestore batch committed");
  }
}

async function writeToBigQuery(players, log) {
  const now = new Date().toISOString();
  const today = snapshotDate();

  // 1) MERGE into players table (Kickbase stammdaten)
  const playerRows = players.map((p) => ({
    player_id: p.playerId,
    name: p.name,
    team_id: p.teamId,
    position: p.position,
    dob: null,
    nationality: null,
    shirt_number: null,
    last_synced_at: now
  }));
  await mergeRows({ tableName: "players", keyColumn: "player_id", rows: playerRows, log });

  // 2) MERGE into kickbase_market_values (composite key: player_id + snapshot_date)
  //    so re-runs on the same day update instead of duplicating.
  const mvRows = players.map((p) => ({
    player_id: p.playerId,
    snapshot_date: today,
    market_value: p.marketValue ?? null,
    delta_24h: p.marketValueTrend24h ?? null,
    delta_7d: null,
    kickbase_total_points: p.totalPoints ?? null,
    last_synced_at: now
  }));

  await mergeMarketValueRows({ rows: mvRows, log });
}

/**
 * Persist every player's pointsHistory to BigQuery. Kickbase's player-detail
 * endpoint returns one entry per matchday for the current season, so we tag
 * each row with the current season_id from the `seasons` table and MERGE on
 * (player_id, season_id, matchday).
 *
 * Idempotent — re-runs on the same day overwrite the matching row, and
 * partial pointsHistory (e.g. matchdays 1–18 mid-season) leaves earlier rows
 * untouched.
 *
 * @param {Array<object>} players
 * @param {import("pino").Logger} log
 */
async function writePointsHistoryToBigQuery(players, log) {
  const currentSeasonId = await loadCurrentSeasonId(log);
  if (!currentSeasonId) {
    log.warn("No current season in BQ — skipping points history write");
    return;
  }
  const now = new Date().toISOString();
  const rows = [];
  for (const p of players) {
    for (const entry of p.pointsHistory ?? []) {
      // Kickbase's thin pointsHistory enumerates matchdays 1..N for the
      // current season. Anything beyond 34 is bogus (carry-over from
      // pagination glitches) — clamp defensively.
      if (typeof entry.matchday !== "number" || entry.matchday < 1 || entry.matchday > 34) {
        continue;
      }
      rows.push({
        player_id: p.playerId,
        season_id: currentSeasonId,
        matchday: entry.matchday,
        points: typeof entry.points === "number" ? entry.points : null,
        has_played: entry.hasPlayed === true,
        source: "kickbase-snapshot",
        last_synced_at: now
      });
    }
  }
  if (rows.length === 0) {
    log.info("No points-history rows to merge");
    return;
  }
  await mergeRows({
    tableName: "kickbase_player_points",
    keyColumn: ["player_id", "season_id", "matchday"],
    rows,
    log
  });
  log.info({ rowsMerged: rows.length, seasonId: currentSeasonId }, "Points history merged");
}

async function loadCurrentSeasonId(log) {
  const { getBigQueryClient, bqTable } = await import("../config/bigQuery.config.js");
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `SELECT season_id FROM \`${bqTable("seasons")}\` WHERE is_current LIMIT 1`
  });
  if (rows[0]) return rows[0].season_id;
  // Fallback: latest by lexicographic order (works for YYYY/YYYY+1 format).
  const [fallback] = await bq.query({
    query: `SELECT season_id FROM \`${bqTable("seasons")}\` ORDER BY season_id DESC LIMIT 1`
  });
  if (fallback[0]) {
    log.warn({ seasonId: fallback[0].season_id }, "No is_current=TRUE season — using latest");
    return fallback[0].season_id;
  }
  return null;
}

async function mergeMarketValueRows({ rows, log }) {
  if (rows.length === 0) {
    log.info("No market_value rows to merge");
    return;
  }

  const { getBigQueryClient, bqTable } = await import("../config/bigQuery.config.js");
  const bq = getBigQueryClient();
  const dataset = process.env.BQ_DATASET ?? "kickwise_main";
  const dsRef = bq.dataset(dataset);
  const tableName = "kickbase_market_values";
  const targetTable = dsRef.table(tableName);

  const stagingName = `_staging_kbmv_${Date.now()}`;
  const staging = dsRef.table(stagingName);

  const [{ schema }] = await targetTable.getMetadata();
  await dsRef.createTable(stagingName, {
    schema,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });

  await staging.insert(rows, { skipInvalidRows: false, ignoreUnknownValues: false });

  const columns = schema.fields.map((f) => f.name);
  const updateClauses = columns
    .filter((c) => !["player_id", "snapshot_date"].includes(c))
    .map((c) => `T.${c} = S.${c}`);
  const insertColumns = columns.join(", ");
  const insertValues = columns.map((c) => `S.${c}`).join(", ");

  const mergeSql = `
    MERGE \`${bqTable(tableName)}\` AS T
    USING \`${bqTable(stagingName)}\` AS S
    ON T.player_id = S.player_id AND T.snapshot_date = S.snapshot_date
    WHEN MATCHED THEN UPDATE SET ${updateClauses.join(", ")}
    WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues})
  `;

  const [job] = await bq.createQueryJob({
    query: mergeSql,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });
  await job.getQueryResults();

  await staging.delete({ ignoreNotFound: true });
  log.info({ rowsMerged: rows.length, tableName }, "Market values merged");
}
