/**
 * Run a fetch-like function with exponential backoff retries.
 *
 * Retries on thrown errors. Caller is responsible for *not* throwing on
 * non-transient failures (e.g. 4xx) — otherwise they will also be retried.
 *
 * @template T
 * @param {() => Promise<T>} fn the operation to call
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=5] total attempts including the first one
 * @param {number} [opts.baseMs=300] base backoff in milliseconds
 * @param {import("pino").Logger} [opts.log] optional logger
 * @returns {Promise<T>} resolves with fn's return value
 *
 * @example
 *   await withRetry(() => fetch(url).then(r => r.json()), { log });
 */
export async function withRetry(fn, opts = {}) {
  const { maxAttempts = 5, baseMs = 300, log } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const backoff = baseMs * 2 ** (attempt - 1);
      log?.warn({ attempt, maxAttempts, err: err.message, backoff }, "Retrying after error");
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
