import {
  fetchCompetitionTable,
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

  await writeToFirestore(allPlayers, log);
  await writeToBigQuery(allPlayers, log);

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
    kickbase_total_points: null,
    last_synced_at: now
  }));

  await mergeMarketValueRows({ rows: mvRows, log });
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
