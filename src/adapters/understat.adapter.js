import { request } from "undici";

const BASE_URL = "https://understat.com";
const MATCH_INFO_RE = /var\s+match_info\s*=\s*JSON\.parse\('([^']+)'\)/;

/**
 * Fetch the embedded match_info JSON for a single Understat match id.
 *
 * Understat's HTML contains a `var match_info = JSON.parse('...')` block
 * with the team-level xG, shot, and PPDA fields. The string inside is
 * hex-encoded (`\x22`, `\x7B`, ...) so we run it through `unescape`-style
 * decoding before JSON parsing.
 *
 * @param {number|string} matchId
 * @param {import("pino").Logger} [log]
 * @returns {Promise<object|null>} parsed match_info, or null if the response
 *   doesn't contain a match_info block (= match id doesn't exist)
 *
 * @example
 *   const info = await fetchUnderstatMatchInfo(28000);
 *   //  info.league === "Bundesliga"
 */
export async function fetchUnderstatMatchInfo(matchId, log) {
  const url = `${BASE_URL}/match/${encodeURIComponent(matchId)}`;
  try {
    const r = await request(url, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0 (compatible; kickwise-scout)" },
      headersTimeout: 8_000,
      bodyTimeout: 8_000
    });
    const html = await r.body.text();
    if (r.statusCode !== 200) {
      log?.warn({ matchId, statusCode: r.statusCode }, "Understat non-200");
      return null;
    }
    const m = html.match(MATCH_INFO_RE);
    if (!m) return null;
    return JSON.parse(decodeHex(m[1]));
  } catch (err) {
    log?.warn({ matchId, err: err.message }, "Understat fetch error");
    return null;
  }
}

/**
 * Scan a range of Understat match ids and return all Bundesliga matches for
 * the given season.
 *
 * @param {object} options
 * @param {number} options.startId inclusive
 * @param {number} options.endId inclusive
 * @param {number} options.season 4-digit start year (e.g. 2024 for 2024/2025)
 * @param {import("pino").Logger} [options.log]
 * @param {number} [options.throttleMs=100] sleep between requests
 * @returns {Promise<Array<object>>} list of normalized BL match_info objects
 *
 * @example
 *   const matches = await scanBundesligaRange({ startId: 27500, endId: 28350, season: 2024 });
 */
export async function scanBundesligaRange({ startId, endId, season, log, throttleMs = 100 }) {
  const out = [];
  let scanned = 0;
  for (let id = startId; id <= endId; id++) {
    const info = await fetchUnderstatMatchInfo(id, log);
    scanned++;
    if (info && info.league === "Bundesliga" && Number(info.season) === Number(season)) {
      out.push(info);
    }
    if (scanned % 50 === 0) {
      log?.info({ scanned, found: out.length }, "Understat range progress");
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }
  return out;
}

function decodeHex(s) {
  // The encoded string uses \xHH JS escapes. Replace them with the actual
  // characters before parsing.
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
