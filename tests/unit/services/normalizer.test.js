import { describe, expect, it } from "vitest";
import {
  buildSeasonId,
  buildSeasonRow,
  toMatchRow,
  toTeamRowsFromMatch
} from "../../../src/services/normalizer.services.js";

describe("buildSeasonId", () => {
  it("forms 'YYYY/YYYY+1' from a single start year", () => {
    expect(buildSeasonId(2024)).toBe("2024/2025");
    expect(buildSeasonId("2010")).toBe("2010/2011");
  });
});

describe("toMatchRow", () => {
  it("maps openligadb fields and extracts the final score", () => {
    const raw = {
      matchID: 12345,
      matchDateTimeUTC: "2024-08-23T18:30:00Z",
      matchIsFinished: true,
      group: { groupOrderID: 1 },
      team1: { teamId: 10, teamName: "RB Leipzig" },
      team2: { teamId: 20, teamName: "FC Bayern" },
      matchResults: [
        { resultName: "Halbzeit", pointsTeam1: 0, pointsTeam2: 2 },
        { resultName: "Endergebnis", pointsTeam1: 2, pointsTeam2: 3 }
      ]
    };

    const row = toMatchRow(raw, { seasonId: "2024/2025" });

    expect(row).toMatchObject({
      match_id: "12345",
      season_id: "2024/2025",
      matchday: 1,
      home_team_id: "10",
      away_team_id: "20",
      kickoff_at: "2024-08-23T18:30:00Z",
      home_score: 2,
      away_score: 3,
      status: "finished"
    });
  });

  it("marks unfinished games as 'scheduled' with null scores", () => {
    const raw = {
      matchID: 1,
      matchDateTimeUTC: "2026-05-31T15:30:00Z",
      matchIsFinished: false,
      group: { groupOrderID: 34 },
      team1: { teamId: 1, teamName: "A" },
      team2: { teamId: 2, teamName: "B" },
      matchResults: []
    };
    const row = toMatchRow(raw, { seasonId: "2025/2026" });
    expect(row.status).toBe("scheduled");
    expect(row.home_score).toBeNull();
    expect(row.away_score).toBeNull();
  });
});

describe("toTeamRowsFromMatch", () => {
  it("returns both teams with the BL1 league code", () => {
    const raw = {
      team1: {
        teamId: 10,
        teamName: "RB Leipzig",
        shortName: "RBL",
        teamIconUrl: "https://x/y.png"
      },
      team2: { teamId: 20, teamName: "FC Bayern", shortName: "FCB", teamIconUrl: "https://x/z.png" }
    };
    const rows = toTeamRowsFromMatch(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0].team_id).toBe("10");
    expect(rows[0].league).toBe("BL1");
    expect(rows[1].short_name).toBe("FCB");
  });
});

describe("buildSeasonRow", () => {
  it("derives start/end date from earliest/latest match", () => {
    const matches = [
      { matchDateTimeUTC: "2024-08-23T18:30:00Z" },
      { matchDateTimeUTC: "2025-05-17T15:30:00Z" },
      { matchDateTimeUTC: "2025-01-15T20:00:00Z" }
    ];
    const row = buildSeasonRow("2024/2025", matches, true);
    expect(row.season_id).toBe("2024/2025");
    expect(row.start_date).toBe("2024-08-23");
    expect(row.end_date).toBe("2025-05-17");
    expect(row.is_current).toBe(true);
  });
});
