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
