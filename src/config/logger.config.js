import pino from "pino";

/**
 * Create a Pino logger appropriate for the current environment.
 *
 * In production: structured JSON (Cloud Run friendly).
 * Otherwise: pretty-printed via pino-pretty.
 *
 * @returns {import("pino").Logger} configured logger
 * @example
 *   import { createLogger } from "./config/logger.config.js";
 *   const log = createLogger();
 *   log.info({ matchday: 1 }, "Starting sync");
 */
export function createLogger() {
  const isProd = process.env.NODE_ENV === "production";
  const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

  if (isProd) {
    return pino({ level });
  }

  return pino({
    level,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" }
    }
  });
}
