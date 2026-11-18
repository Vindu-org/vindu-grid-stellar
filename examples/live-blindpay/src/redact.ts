/**
 * Everything this example prints goes through a redactor first.
 *
 * It removes the secrets it was given (the API key, the instance id), in
 * any letter case and, for a prefixed id such as `in_...`, also without its
 * prefix. Then anything that looks like a value from the instance:
 * - BlindPay ids: a known prefix (`in`, `re`, `bw`, `qu`, `pi`, `po`, `pf`,
 *   `ba`, `bl`, `to`, `va`, `tr`, `pa`, `wh`) in either case, then `_` and
 *   at least 4 letters or digits, or `-` and at least 4 letters or digits
 *   with a digit or capital among them (so `re-quote` stays); and any other
 *   two- or three-letter lowercase prefix, `_`, then at least 4 letters or
 *   digits with a digit or capital among them (so `on_hold` and
 *   `op_underfunded` stay). An id must start a word (the `in_flight` of
 *   `key_in_flight` stays) but may be followed by `_` or any other
 *   non-alphanumeric character;
 * - emails, Stellar accounts, secret seeds, transaction hashes and base64
 *   blobs of 80 characters or more.
 * Accounts and hashes keep their last four characters, so two lines can
 * still be compared by eye; nothing else is kept.
 */

const KNOWN_PREFIXES = ['in', 're', 'bw', 'qu', 'pi', 'po', 'pf', 'ba', 'bl', 'to', 'va', 'tr', 'pa', 'wh'];
/** `re` -> `[rR][eE]`: either case, while the rest of the pattern stays case-sensitive. */
const KNOWN = `(${KNOWN_PREFIXES.map((p) => [...p].map((c) => `[${c}${c.toUpperCase()}]`).join('')).join('|')})`;
/** Starts a word; not followed by a letter or digit, so a trailing `_` does not hide it. */
const END = '(?![A-Za-z0-9])';
/** At least 4 letters or digits, one of them a digit or a capital. */
const ID_SHAPED = '(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{4,}';
const KNOWN_ID_RE = new RegExp(`\\b${KNOWN}(?:_[A-Za-z0-9]{4,}|-${ID_SHAPED})${END}`, 'g');
const OTHER_ID_RE = new RegExp(`\\b([a-z]{2,3})_${ID_SHAPED}${END}`, 'g');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Stellar account (G...), muxed account (M...) or secret seed (S...). */
const STRKEY_RE = /\b([GMS])[A-Z2-7]{55,68}\b/g;
const HASH_RE = /\b[0-9a-f]{64}\b/gi;
/** A base64 run this long is an XDR envelope or another blob: never printed. */
const BLOB_RE = /[A-Za-z0-9+/]{80,}={0,2}/g;
/** A secret's part after a short lowercase prefix, e.g. the id inside `in_...`. */
const PREFIXED_SECRET_RE = /^[a-z]{2,3}[_-]([A-Za-z0-9]{6,})$/;

export type Redactor = (text: string) => string;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param secrets values that must never appear, whatever their shape. Empty
 *   strings are ignored.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const given = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  const bare = given.map((s) => PREFIXED_SECRET_RE.exec(s)?.[1]).filter((s): s is string => s !== undefined);
  const exact = [...new Set([...given, ...bare])].sort((a, b) => b.length - a.length);
  const secretRe = exact.length === 0 ? null : new RegExp(exact.map(escape).join('|'), 'gi');
  return (text) => {
    let out = String(text);
    if (secretRe !== null) out = out.replace(secretRe, '<redacted>');
    return out
      .replace(BLOB_RE, (m) => `<blob ${m.length} chars>`)
      .replace(STRKEY_RE, (m, kind: string) => (kind === 'S' ? '<secret seed>' : `${kind}...${m.slice(-4)}`))
      .replace(HASH_RE, (m) => `#...${m.slice(-4)}`)
      .replace(EMAIL_RE, '<email>')
      .replace(KNOWN_ID_RE, (_m, prefix: string) => `<${prefix.toLowerCase()}_id>`)
      .replace(OTHER_ID_RE, (_m, prefix: string) => `<${prefix}_id>`);
  };
}
