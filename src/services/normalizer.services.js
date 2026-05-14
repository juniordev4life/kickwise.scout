/**
 * Convert an openligadb season-year integer (e.g. 2024) into the Kickwise
 * season-id format used in BigQuery (e.g. "2024/2025").
 *
 * @param {number|string} startYear openligadb season year, e.g. 2024
 * @returns {string} Kickwise season-id, e.g. "2024/2025"
 *
 * @example
 *   buildSeasonId(2024)  // "2024/2025"
 */
export function buildSeasonId(startYear) {
  const y = Number(startYear);
  return `${y}/${y + 1}`;
}

/**
 * Normalize an openligadb match into the Kickwise `matches`-table row shape.
 *
 * openligadb fields are PascalCase-ish; Kickwise stores snake_case.
 *
 * @param {object} raw openligadb match object
 * @param {object} ctx
 * @param {string} ctx.seasonId Kickwise season id (e.g. "2024/2025")
 * @returns {object} row for the BQ `matches` table
 *
 * @example
 *   const row = toMatchRow(raw, { seasonId: "2024/2025" });
 */
export function toMatchRow(raw, { seasonId }) {
  const home = raw.team1 ?? raw.Team1 ?? {};
  const away = raw.team2 ?? raw.Team2 ?? {};
  const final = (raw.matchResults ?? raw.MatchResults ?? []).find(
    (r) => r.resultName === "Endergebnis" || r.ResultName === "Endergebnis"
  );
  const homeScore = final?.pointsTeam1 ?? final?.PointsTeam1 ?? null;
  const awayScore = final?.pointsTeam2 ?? final?.PointsTeam2 ?? null;
  const isFinished = raw.matchIsFinished ?? raw.MatchIsFinished ?? false;

  return {
    match_id: String(raw.matchID ?? raw.MatchID),
    season_id: seasonId,
    matchday: raw.group?.groupOrderID ?? raw.Group?.GroupOrderID ?? null,
    home_team_id: String(home.teamId ?? home.TeamId ?? ""),
    away_team_id: String(away.teamId ?? away.TeamId ?? ""),
    kickoff_at: raw.matchDateTimeUTC ?? raw.MatchDateTimeUTC ?? raw.matchDateTime,
    home_score: homeScore,
    away_score: awayScore,
    status: isFinished ? "finished" : "scheduled",
    last_synced_at: new Date().toISOString()
  };
}

/**
 * Extract team rows from an openligadb match (home + away).
 * Multiple matches reference the same team, so the caller dedupes by team_id.
 *
 * @param {object} raw openligadb match
 * @returns {Array<object>} two team rows for the BQ `teams` table
 *
 * @example
 *   const teamRows = matches.flatMap(toTeamRowsFromMatch);
 */
export function toTeamRowsFromMatch(raw) {
  const now = new Date().toISOString();
  const make = (t) => ({
    team_id: String(t.teamId ?? t.TeamId ?? ""),
    name: t.teamName ?? t.TeamName ?? "",
    short_name: t.shortName ?? t.ShortName ?? null,
    league: "BL1",
    founded_year: null,
    logo_url: t.teamIconUrl ?? t.TeamIconUrl ?? null,
    last_synced_at: now
  });
  return [make(raw.team1 ?? raw.Team1 ?? {}), make(raw.team2 ?? raw.Team2 ?? {})];
}

/**
 * Build the season row from a list of matches (uses earliest kickoff as start_date,
 * latest as end_date).
 *
 * @param {string} seasonId Kickwise season id
 * @param {Array<object>} matches openligadb match objects of that season
 * @param {boolean} isCurrent whether this is the live season
 * @returns {object} row for the BQ `seasons` table
 *
 * @example
 *   const row = buildSeasonRow("2024/2025", matches, true);
 */
export function buildSeasonRow(seasonId, matches, isCurrent) {
  const kickoffs = matches
    .map((m) => m.matchDateTimeUTC ?? m.MatchDateTimeUTC ?? m.matchDateTime)
    .filter(Boolean)
    .map((s) => new Date(s));
  kickoffs.sort((a, b) => a - b);
  return {
    season_id: seasonId,
    league: "BL1",
    start_date: kickoffs[0] ? kickoffs[0].toISOString().slice(0, 10) : null,
    end_date: kickoffs.at(-1) ? kickoffs.at(-1).toISOString().slice(0, 10) : null,
    is_current: isCurrent,
    last_synced_at: new Date().toISOString()
  };
}
