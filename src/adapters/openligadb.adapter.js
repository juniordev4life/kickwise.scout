import { request } from "undici";
import { withRetry } from "../utils/retry.utils.js";

const DEFAULT_BASE_URL = "https://api.openligadb.de";

function baseUrl() {
  return process.env.OPENLIGADB_BASE_URL ?? DEFAULT_BASE_URL;
}

async function get(path, log) {
  return withRetry(
    async () => {
      const url = new URL(path, baseUrl()).toString();
      const response = await request(url, { method: "GET", headersTimeout: 15_000 });
      const text = await response.body.text();
      if (response.statusCode !== 200) {
        throw new Error(`openligadb ${response.statusCode} for ${path}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    },
    { maxAttempts: 5, baseMs: 300, log }
  );
}

/**
 * Fetch all matches of a Bundesliga season from openligadb.
 *
 * @param {object} options
 * @param {string} options.leagueShortcut e.g. "bl1" for 1. Bundesliga
 * @param {string} options.seasonYear e.g. "2024" (start year of the season)
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<Array<object>>} raw openligadb match objects
 *
 * @example
 *   const raw = await fetchSeasonMatches({ leagueShortcut: "bl1", seasonYear: "2024" });
 */
export async function fetchSeasonMatches({ leagueShortcut, seasonYear, log }) {
  return get(`/getmatchdata/${leagueShortcut}/${seasonYear}`, log);
}

/**
 * Fetch teams playing in a given season.
 *
 * @param {object} options
 * @param {string} options.leagueShortcut
 * @param {string} options.seasonYear
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<Array<object>>} raw openligadb team objects
 *
 * @example
 *   const teams = await fetchSeasonTeams({ leagueShortcut: "bl1", seasonYear: "2024" });
 */
export async function fetchSeasonTeams({ leagueShortcut, seasonYear, log }) {
  return get(`/getavailableteams/${leagueShortcut}/${seasonYear}`, log);
}

/**
 * Fetch all matches of a single matchday.
 *
 * @param {object} options
 * @param {string} options.leagueShortcut
 * @param {string} options.seasonYear
 * @param {number} options.matchday
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<Array<object>>}
 *
 * @example
 *   const md30 = await fetchMatchday({ leagueShortcut: "bl1", seasonYear: "2024", matchday: 30 });
 */
export async function fetchMatchday({ leagueShortcut, seasonYear, matchday, log }) {
  return get(`/getmatchdata/${leagueShortcut}/${seasonYear}/${matchday}`, log);
}
