/**
 * The one strict parser for quote expiries. The payout flow and the signer
 * guard both read `expiresAt` through it, so they can never disagree on
 * whether a quote is still valid.
 */

/** ISO-8601 date and time with an explicit offset. Anything looser is refused rather than guessed. */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Milliseconds since epoch for an ISO-8601 instant with an explicit offset
 * (`Z` or `+hh:mm`), or `undefined` for anything else: a date without a
 * time, a time without an offset, an HTTP date, a number, an impossible
 * date (`2030-02-31`, `2030-02-29`), an hour of 24 or more, a minute or
 * second of 60 or more, or an offset beyond `23:59`.
 *
 * Each component is checked by a round trip through `Date`: the date is
 * built from the parts and must give the same parts back, so nothing is
 * silently rolled over to the next day or month.
 */
export function parseInstantMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_INSTANT_RE.exec(value);
  if (m === null) return undefined;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const offsetHours = m[9] === undefined ? 0 : Number(m[9]);
  const offsetMinutes = m[10] === undefined ? 0 : Number(m[10]);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;

  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  const sign = m[8] === '-' ? -1 : 1;
  const result = date.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return Number.isFinite(result) ? result : undefined;
}
