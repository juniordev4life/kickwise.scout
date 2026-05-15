import { request } from "undici";
import { getFirestoreClient } from "../config/firestore.config.js";
import { withRetry } from "../utils/retry.utils.js";

const DEFAULT_WINGER_URL = "https://kickwise-euw3-run-winger-2zf6f7v3pq-ey.a.run.app";

function wingerUrl() {
  return process.env.WINGER_URL ?? DEFAULT_WINGER_URL;
}

/**
 * Read any active Kickbase token from Firestore. Picks the most recently
 * `lastSeen` user — Scout doesn't care which user supplied the token, only
 * that it's still valid.
 *
 * @returns {Promise<string|null>} a Kickbase bearer token, or null if no
 *   user has logged in recently
 *
 * @example
 *   const token = await getActiveKickbaseToken();
 *   if (!token) throw new Error("No active session — ask Marco to log in");
 */
export async function getActiveKickbaseToken() {
  const db = getFirestoreClient();
  const snap = await db.collection("users").orderBy("lastSeen", "desc").limit(1).get();

  if (snap.empty) return null;
  const data = snap.docs[0].data();
  return data.kbToken ?? null;
}

async function callWinger(kbToken, apiPath, log) {
  return withRetry(
    async () => {
      const url = new URL(apiPath, wingerUrl()).toString();
      const response = await request(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${kbToken}`
        },
        headersTimeout: 15_000,
        bodyTimeout: 30_000
      });
      const text = await response.body.text();
      if (response.statusCode !== 200) {
        const err = new Error(
          `Winger ${response.statusCode} for ${apiPath}: ${text.slice(0, 200)}`
        );
        err.statusCode = response.statusCode;
        throw err;
      }
      return JSON.parse(text).data;
    },
    { maxAttempts: 3, baseMs: 500, log }
  );
}

/**
 * Fetch all currently active teams in the given Kickbase competition.
 *
 * @param {object} options
 * @param {string} options.kbToken Kickbase bearer token
 * @param {string} [options.competitionId="1"] Kickbase competition id
 *   (default 1 = 1. Bundesliga)
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<Array<object>>} normalized team rows
 *
 * @example
 *   const teams = await fetchCompetitionTable({ kbToken });
 */
export async function fetchCompetitionTable({ kbToken, competitionId = "1", log }) {
  const data = await callWinger(
    kbToken,
    `/api/v1/kickbase/competitions/${encodeURIComponent(competitionId)}/table`,
    log
  );
  return data.teams ?? [];
}

/**
 * Fetch the full team profile (player list) for a single team.
 *
 * @param {object} options
 * @param {string} options.kbToken
 * @param {string} options.teamId
 * @param {string} [options.competitionId="1"]
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<{ teamId: string, teamName: string|null, players: Array<object> }>}
 *
 * @example
 *   const profile = await fetchTeamProfile({ kbToken, teamId: "43" });
 */
export async function fetchTeamProfile({ kbToken, teamId, competitionId = "1", log }) {
  return callWinger(
    kbToken,
    `/api/v1/kickbase/competitions/${encodeURIComponent(competitionId)}/teams/${encodeURIComponent(teamId)}/profile`,
    log
  );
}

/**
 * Fetch per-player detail (averagePoints, totalPoints, pointsHistory,
 * cards, shirt number).
 *
 * @param {object} options
 * @param {string} options.kbToken
 * @param {string} options.playerId
 * @param {string} [options.competitionId="1"]
 * @param {import("pino").Logger} [options.log]
 * @returns {Promise<object>} normalized player detail (see Winger normalizer)
 *
 * @example
 *   const detail = await fetchPlayerDetail({ kbToken, playerId: "8227" });
 */
export async function fetchPlayerDetail({ kbToken, playerId, competitionId = "1", log }) {
  return callWinger(
    kbToken,
    `/api/v1/kickbase/competitions/${encodeURIComponent(competitionId)}/players/${encodeURIComponent(playerId)}`,
    log
  );
}

/**
 * Multi-season matchday history for a single player — the endpoint the
 * Striker player-detail page uses for the per-matchday chart. Each
 * matchday carries the real day number, points, opponent and match id,
 * so it's also what we use to populate `kickbase_player_points`.
 *
 * @param {object} args
 * @param {string} args.kbToken
 * @param {string} args.playerId
 * @param {string} [args.competitionId="1"]
 * @param {import("pino").Logger} [args.log]
 * @returns {Promise<{seasons: Array<{seasonId: string, matchdays: Array}>}>}
 *
 * @example
 *   const perf = await fetchPlayerPerformance({ kbToken, playerId: "8227" });
 *   perf.seasons[0].matchdays[0].matchday // real matchday number, not array index
 */
export async function fetchPlayerPerformance({ kbToken, playerId, competitionId = "1", log }) {
  return callWinger(
    kbToken,
    `/api/v1/kickbase/competitions/${encodeURIComponent(competitionId)}/players/${encodeURIComponent(playerId)}/performance`,
    log
  );
}
