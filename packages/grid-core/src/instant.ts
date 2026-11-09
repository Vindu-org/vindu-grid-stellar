/**
 * The one strict parser for quote expiries. The payout flow and the signer
 * guard both read `expiresAt` through it, so they can never disagree on
 * whether a quote is still valid.
 */

/** ISO-8601 date and time with an explicit offset. Anything looser is refused rather than guessed. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Milliseconds since epoch for an ISO-8601 instant with an explicit offset
 * (`Z` or `+hh:mm`), or `undefined` for anything else: a date without a
 * time, a time without an offset, an HTTP date, a number, an impossible date.
 */
export function parseInstantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
