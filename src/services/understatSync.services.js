import { scanBundesligaRange } from "../adapters/understat.adapter.js";
import { bqTable, getBigQueryClient } from "../config/bigQuery.config.js";

/**
 * Map Understat team names to the team names openligadb uses. Understat's
 * naming is fairly consistent ("Bayern Munich", "Bayer Leverkusen", ...),
 * while openligadb uses German full names ("FC Bayern München",
 * "Bayer 04 Leverkusen"). Built once, used to join Understat matches
 * against the openligadb matches table.
 */
const UNDERSTAT_TO_OPENLIGADB_NAME = {
  "Bayern Munich": "Bayern München",
  "Bayer Leverkusen": "Bayer Leverkusen",
  "Borussia Dortmund": "Borussia Dortmund",
  "RasenBallsport Leipzig": "RB Leipzig",
  "VfB Stuttgart": "VfB Stuttgart",
  "Eintracht Frankfurt": "Eintracht Frankfurt",
  "Borussia M.Gladbach": "Borussia Mönchengladbach",
  "Union Berlin": "1. FC Union Berlin",
  Hoffenheim: "TSG 1899 Hoffenheim",
  Wolfsburg: "VfL Wolfsburg",
  Freiburg: "SC Freiburg",
  "Mainz 05": "1. FSV Mainz 05",
  Augsburg: "FC Augsburg",
  "St. Pauli": "FC St. Pauli",
  "Werder Bremen": "Werder Bremen",
  "FC Heidenheim": "1. FC Heidenheim 1846",
  "FC Cologne": "1. FC Köln",
  "Holstein Kiel": "Holstein Kiel",
  Bochum: "VfL Bochum",
  "Hertha Berlin": "Hertha BSC",
  Schalke: "FC Schalke 04",
  "Hamburger SV": "Hamburger SV",
  Stuttgart: "VfB Stuttgart",
  "Greuther Fürth": "SpVgg Greuther Fürth",
  "Hertha BSC": "Hertha BSC",
  "1899 Hoffenheim": "TSG 1899 Hoffenheim",
  "Arminia Bielefeld": "Arminia Bielefeld"
};

/**
 * Build a lookup of openligadb (name -> team_id) for one or more seasons so
 * we can resolve Understat team names to ids when MERGEing xG rows.
 *
 * @param {string[]} seasonIds e.g. ["2024/2025", "2025/2026"]
 * @returns {Promise<Map<string, string>>} name → team_id
 */
async function loadTeamIdLookup(seasonIds) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT DISTINCT t.team_id, t.name
      FROM \`${bqTable("matches")}\` m
      JOIN \`${bqTable("teams")}\` t
        ON t.team_id IN (m.home_team_id, m.away_team_id)
      WHERE m.season_id IN UNNEST(@seasons)
    `,
    params: { seasons: seasonIds }
  });
  const map = new Map();
  for (const r of rows) map.set(r.name, r.team_id);
  return map;
}

/**
 * Resolve an Understat match to its openligadb match_id and team_ids by
 * matching on date + team names.
 */
async function findOpenligadbMatch({ understatMatch, teamIdByName, seasonId, log }) {
  const homeName = UNDERSTAT_TO_OPENLIGADB_NAME[understatMatch.team_h] ?? understatMatch.team_h;
  const awayName = UNDERSTAT_TO_OPENLIGADB_NAME[understatMatch.team_a] ?? understatMatch.team_a;
  const homeId = teamIdByName.get(homeName);
  const awayId = teamIdByName.get(awayName);
  if (!homeId || !awayId) {
    log?.warn(
      { homeName, awayName, season: seasonId },
      "Could not resolve team ids for Understat match"
    );
    return null;
  }
  const matchDate = understatMatch.date?.slice(0, 10);
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT match_id
      FROM \`${bqTable("matches")}\`
      WHERE season_id = @season
        AND home_team_id = @homeId
        AND away_team_id = @awayId
        AND DATE(kickoff_at) = DATE(@matchDate)
      LIMIT 1
    `,
    params: { season: seasonId, homeId, awayId, matchDate }
  });
  if (rows.length === 0) return null;
  return { matchId: rows[0].match_id, homeTeamId: homeId, awayTeamId: awayId };
}

function understatSeasonToKickwise(season) {
  const start = Number(season);
  return `${start}/${start + 1}`;
}

/**
 * Full Understat sync over the given match-id range. Filters to Bundesliga
 * matches of the requested season, joins against the matches BigQuery table
 * to resolve openligadb match_id, and MERGE-upserts the xg_match_data
 * table (2 rows per match, one per side).
 *
 * @param {object} options
 * @param {number} options.startId
 * @param {number} options.endId
 * @param {number} options.season 4-digit start year (e.g. 2024 for 2024/2025)
 * @param {import("pino").Logger} options.log
 * @returns {Promise<{ scanned: number, found: number, matched: number, written: number }>}
 *
 * @example
 *   await syncUnderstatRange({ startId: 27500, endId: 28400, season: 2024, log });
 */
export async function syncUnderstatRange({ startId, endId, season, log }) {
  const seasonId = understatSeasonToKickwise(season);
  log.info({ startId, endId, season, seasonId }, "Understat scan + sync");

  const matches = await scanBundesligaRange({ startId, endId, season, log });
  log.info({ found: matches.length }, "Understat BL matches found");

  const teamIdByName = await loadTeamIdLookup([seasonId]);
  log.info({ teamCount: teamIdByName.size }, "Loaded openligadb team lookup");

  const rows = [];
  let matched = 0;
  for (const u of matches) {
    const res = await findOpenligadbMatch({
      understatMatch: u,
      teamIdByName,
      seasonId,
      log
    });
    if (!res) continue;
    matched++;
    const now = new Date().toISOString();
    rows.push({
      match_id: res.matchId,
      team_id: res.homeTeamId,
      season_id: seasonId,
      is_home: true,
      xg: parseFloatOrNull(u.h_xg),
      xga: parseFloatOrNull(u.a_xg),
      shots: parseIntOrNull(u.h_shot),
      shots_on_target: parseIntOrNull(u.h_shotOnTarget),
      deep_passes: parseIntOrNull(u.h_deep),
      ppda: parseFloatOrNull(u.h_ppda),
      source: "understat",
      understat_match_id: String(u.id),
      last_synced_at: now
    });
    rows.push({
      match_id: res.matchId,
      team_id: res.awayTeamId,
      season_id: seasonId,
      is_home: false,
      xg: parseFloatOrNull(u.a_xg),
      xga: parseFloatOrNull(u.h_xg),
      shots: parseIntOrNull(u.a_shot),
      shots_on_target: parseIntOrNull(u.a_shotOnTarget),
      deep_passes: parseIntOrNull(u.a_deep),
      ppda: parseFloatOrNull(u.a_ppda),
      source: "understat",
      understat_match_id: String(u.id),
      last_synced_at: now
    });
  }

  if (rows.length > 0) {
    await mergeXgRows({ rows, log });
  }

  return { scanned: endId - startId + 1, found: matches.length, matched, written: rows.length };
}

function parseFloatOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseIntOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function mergeXgRows({ rows, log }) {
  const bq = getBigQueryClient();
  const dataset = process.env.BQ_DATASET ?? "kickwise_main";
  const dsRef = bq.dataset(dataset);
  const tableName = "xg_match_data";
  const targetTable = dsRef.table(tableName);
  const stagingName = `_staging_xg_${Date.now()}`;
  const staging = dsRef.table(stagingName);

  const [{ schema }] = await targetTable.getMetadata();
  await dsRef.createTable(stagingName, {
    schema,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });
  await staging.insert(rows, { skipInvalidRows: false, ignoreUnknownValues: false });

  const columns = schema.fields.map((f) => f.name);
  const updateClauses = columns
    .filter((c) => !["match_id", "team_id"].includes(c))
    .map((c) => `T.${c} = S.${c}`);
  const insertColumns = columns.join(", ");
  const insertValues = columns.map((c) => `S.${c}`).join(", ");

  const mergeSql = `
    MERGE \`${bqTable(tableName)}\` AS T
    USING \`${bqTable(stagingName)}\` AS S
    ON T.match_id = S.match_id AND T.team_id = S.team_id
    WHEN MATCHED THEN UPDATE SET ${updateClauses.join(", ")}
    WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues})
  `;
  const [job] = await bq.createQueryJob({
    query: mergeSql,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });
  await job.getQueryResults();
  await staging.delete({ ignoreNotFound: true });
  log.info({ rows: rows.length }, "xg_match_data merged");
}
