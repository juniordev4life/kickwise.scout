import {
  fetchMatchday,
  fetchSeasonMatches,
  fetchSeasonTeams
} from "../adapters/openligadb.adapter.js";
import { mergeRows } from "./bigquery.services.js";
import {
  buildSeasonId,
  buildSeasonRow,
  toMatchRow,
  toTeamRowsFromMatch
} from "./normalizer.services.js";

const LEAGUE = "BL1";
const LEAGUE_SHORTCUT = "bl1";

function currentSeasonStartYear(now = new Date()) {
  // Bundesliga starts in August; before August, the "current" season is the one from previous year
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

function dedupeBy(rows, keyColumn) {
  const map = new Map();
  for (const row of rows) {
    map.set(row[keyColumn], row);
  }
  return [...map.values()];
}

async function syncSeason({ startYear, isCurrent, log }) {
  const seasonId = buildSeasonId(startYear);
  log.info({ seasonId, isCurrent }, "Syncing season");

  const rawMatches = await fetchSeasonMatches({
    leagueShortcut: LEAGUE_SHORTCUT,
    seasonYear: String(startYear),
    log
  });

  if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
    log.warn({ seasonId }, "No matches returned for season");
    return { season: seasonId, matches: 0, teams: 0 };
  }

  const matchRows = rawMatches.map((raw) => toMatchRow(raw, { seasonId }));
  const teamRows = dedupeBy(rawMatches.flatMap(toTeamRowsFromMatch), "team_id");
  const seasonRow = buildSeasonRow(seasonId, rawMatches, isCurrent);

  await mergeRows({ tableName: "teams", keyColumn: "team_id", rows: teamRows, log });
  await mergeRows({ tableName: "seasons", keyColumn: "season_id", rows: [seasonRow], log });
  await mergeRows({ tableName: "matches", keyColumn: "match_id", rows: matchRows, log });

  log.info({ seasonId, matches: matchRows.length, teams: teamRows.length }, "Season sync complete");

  return { season: seasonId, matches: matchRows.length, teams: teamRows.length };
}

/**
 * Sync the currently running Bundesliga season.
 *
 * @param {import("pino").Logger} log
 * @returns {Promise<{season: string, matches: number, teams: number}>}
 *
 * @example
 *   await syncCurrentSeason(logger);
 */
export async function syncCurrentSeason(log) {
  const startYear = currentSeasonStartYear();
  return syncSeason({ startYear, isCurrent: true, log });
}

/**
 * Backfill every season since the given start (inclusive). Marks the latest one
 * as current.
 *
 * @param {object} params
 * @param {string} params.sinceSeason e.g. "2010/2011"
 * @param {import("pino").Logger} params.log
 * @returns {Promise<Array<object>>} per-season summaries
 *
 * @example
 *   await syncHistoric({ sinceSeason: "2010/2011", log });
 */
export async function syncHistoric({ sinceSeason, log }) {
  const startFrom = Number(sinceSeason.split("/")[0]);
  const currentYear = currentSeasonStartYear();
  const results = [];
  for (let year = startFrom; year <= currentYear; year++) {
    const summary = await syncSeason({
      startYear: year,
      isCurrent: year === currentYear,
      log
    });
    results.push(summary);
  }
  return results;
}

/**
 * Sync a single matchday of the current season.
 *
 * @param {object} params
 * @param {number} params.matchday
 * @param {import("pino").Logger} params.log
 *
 * @example
 *   await syncMatchday({ matchday: 30, log });
 */
export async function syncMatchday({ matchday, log }) {
  const startYear = currentSeasonStartYear();
  const seasonId = buildSeasonId(startYear);
  const rawMatches = await fetchMatchday({
    leagueShortcut: LEAGUE_SHORTCUT,
    seasonYear: String(startYear),
    matchday,
    log
  });
  if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
    log.warn({ seasonId, matchday }, "No matches returned for matchday");
    return { season: seasonId, matchday, matches: 0 };
  }
  const matchRows = rawMatches.map((raw) => toMatchRow(raw, { seasonId }));
  const teamRows = dedupeBy(rawMatches.flatMap(toTeamRowsFromMatch), "team_id");

  await mergeRows({ tableName: "teams", keyColumn: "team_id", rows: teamRows, log });
  await mergeRows({ tableName: "matches", keyColumn: "match_id", rows: matchRows, log });

  return { season: seasonId, matchday, matches: matchRows.length };
}

/**
 * Sync a single, explicitly named season.
 *
 * @param {object} params
 * @param {string} params.season e.g. "2020/2021"
 * @param {import("pino").Logger} params.log
 *
 * @example
 *   await syncOneSeason({ season: "2020/2021", log });
 */
export async function syncOneSeason({ season, log }) {
  const startYear = Number(season.split("/")[0]);
  const isCurrent = startYear === currentSeasonStartYear();
  return syncSeason({ startYear, isCurrent, log });
}

// Expose for unit testing
export const _internals = { currentSeasonStartYear, dedupeBy };
