import { parseArgs } from "node:util";
import { createLogger } from "./config/logger.config.js";
import { syncPlayerSnapshot } from "./services/playerSnapshot.services.js";
import {
  syncCurrentSeason,
  syncHistoric,
  syncMatchday,
  syncOneSeason
} from "./services/sync.services.js";
import { syncUnderstatRange } from "./services/understatSync.services.js";

const log = createLogger();

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: process.env.SCOUT_MODE ?? "current-season" },
    matchday: { type: "string" },
    "since-season": { type: "string", default: "2010/2011" },
    season: { type: "string" },
    "understat-start": { type: "string" },
    "understat-end": { type: "string" },
    "understat-season": { type: "string" }
  },
  allowPositionals: false
});

try {
  let result;
  switch (values.mode) {
    case "current-season":
      result = await syncCurrentSeason(log);
      break;
    case "historic":
      result = await syncHistoric({ sinceSeason: values["since-season"], log });
      break;
    case "matchday": {
      if (!values.matchday) throw new Error("--matchday=<n> is required for mode=matchday");
      result = await syncMatchday({ matchday: Number(values.matchday), log });
      break;
    }
    case "season":
      if (!values.season) throw new Error("--season=YYYY/YYYY is required for mode=season");
      result = await syncOneSeason({ season: values.season, log });
      break;
    case "player-snapshot":
      result = await syncPlayerSnapshot(log);
      break;
    case "understat-range": {
      const startId = Number(values["understat-start"]);
      const endId = Number(values["understat-end"]);
      const season = Number(values["understat-season"]);
      if (!startId || !endId || !season) {
        throw new Error(
          "mode=understat-range requires --understat-start, --understat-end, --understat-season"
        );
      }
      result = await syncUnderstatRange({ startId, endId, season, log });
      break;
    }
    default:
      throw new Error(`Unknown mode: ${values.mode}`);
  }
  log.info({ mode: values.mode, result }, "Scout run complete");
  process.exit(0);
} catch (err) {
  log.error({ err: err.message, stack: err.stack, mode: values.mode }, "Scout run failed");
  process.exit(1);
}
