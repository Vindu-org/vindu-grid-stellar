/**
 * A `fetch` for the BlindPay client that stays under a development
 * instance's rate limit (40 requests a minute) and honours `Retry-After`.
 *
 * - At most `maxPerMinute` requests start in any 60 second window; a call
 *   over that waits.
 * - A `429` is retried, after `Retry-After` (or 10 s without one), with the
 *   very same request: same headers, so the same Idempotency-Key, and the
 *   same body. A rate-limited request did not run, and BlindPay replays a
 *   finished one for a key it has seen, so this never acts twice.
 *
 * The client itself has no retry loop on purpose; this one lives in the
 * example, where the only retried status is 429.
 */
import type { FetchLike } from '@vindu/grid-blindpay';

export interface PacerOptions {
  readonly maxPerMinute: number;
  /** Retries of one request after a 429. Default 3. */
  readonly maxRetries?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told about each wait, in ms, and why. */
  readonly onWait?: (ms: number, reason: 'window' | 'retry_after') => void;
}

const WINDOW_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 10_000;

export function pacedFetch(inner: FetchLike, options: PacerOptions): FetchLike & { readonly requests: () => number } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 3;
  if (!Number.isSafeInteger(options.maxPerMinute) || options.maxPerMinute <= 0) {
    throw new RangeError('maxPerMinute must be a positive integer');
  }
  const started: number[] = [];
  let total = 0;
  // One slot at a time, so concurrent callers cannot both take the last one.
  let queue: Promise<void> = Promise.resolve();

  const takeSlot = (): Promise<void> => {
    const turn = queue.then(async () => {
      for (;;) {
        const t = now();
        while (started.length > 0 && (started[0] as number) <= t - WINDOW_MS) started.shift();
        if (started.length < options.maxPerMinute) {
          started.push(t);
          total += 1;
          return;
        }
        const wait = (started[0] as number) + WINDOW_MS - t;
        options.onWait?.(wait, 'window');
        await sleep(wait);
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  const fetch: FetchLike = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      await takeSlot();
      const res = await inner(input, init);
      if (res.status !== 429 || attempt >= maxRetries) return res;
      const wait = retryAfterMs(res.headers.get('retry-after'), now()) ?? DEFAULT_RETRY_AFTER_MS;
      await res.body?.cancel().catch(() => undefined);
      options.onWait?.(wait, 'retry_after');
      await sleep(wait);
    }
  };
  return Object.assign(fetch, { requests: () => total });
}

/** `Retry-After` in seconds or as an HTTP date, in ms from `nowMs`. */
export function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
