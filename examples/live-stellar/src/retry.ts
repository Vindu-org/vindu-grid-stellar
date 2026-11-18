/**
 * Bounded retries for testnet flakiness (friendbot errors, rate limits, a
 * load-balanced Horizon instance that is a ledger behind). Only the example
 * retries; the packages never do it on their own.
 */

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Total tries, at least 1. */
  readonly attempts: number;
  /** Pause before the second try; doubles after each failure, up to `maxDelayMs`. */
  readonly delayMs: number;
  readonly maxDelayMs?: number;
  /** Whether an error is worth another try. Default: every error. */
  readonly retryable?: (error: unknown) => boolean;
  readonly sleep?: Sleep;
}

/** Runs `fn` until it resolves, at most `attempts` times. Rethrows the last error. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new RangeError('attempts must be at least 1');
  const sleep = options.sleep ?? realSleep;
  const retryable = options.retryable ?? (() => true);
  let delay = options.delayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= options.attempts || !retryable(e)) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, options.maxDelayMs ?? Number.POSITIVE_INFINITY);
    }
  }
}

export interface WaitOptions {
  /** Most checks, at least 1. */
  readonly attempts: number;
  readonly intervalMs: number;
  readonly sleep?: Sleep;
}

/**
 * Calls `check` until it returns something other than `undefined`, at most
 * `attempts` times, pausing `intervalMs` between calls. Returns `undefined`
 * when it never did. Errors from `check` propagate.
 */
export async function waitFor<T>(check: (attempt: number) => Promise<T | undefined>, options: WaitOptions): Promise<T | undefined> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new RangeError('attempts must be at least 1');
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const value = await check(attempt);
    if (value !== undefined) return value;
    if (attempt < options.attempts) await sleep(options.intervalMs);
  }
  return undefined;
}
