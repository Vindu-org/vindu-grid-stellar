/**
 * Everything this example prints goes through a redactor first.
 *
 * It removes the secrets it was given (the API key, the instance id) and
 * anything that looks like a value from the instance: BlindPay ids
 * (`re_...`, `bw_...`, `po_...`), emails, Stellar accounts and transaction
 * hashes. Accounts and hashes keep their last four characters, so two lines
 * can still be compared by eye; nothing else is kept.
 */

/**
 * BlindPay id: a known prefix, `_`, then at least 8 letters or digits. Status
 * words such as `on_hold` or `auth_required` are not ids.
 */
const BLINDPAY_ID_RE = /\b(?:in|re|bw|qu|pi|po|pf|ba|bl|to|va|tr|pa|wh)_[A-Za-z0-9]{8,}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Stellar account (G...), muxed account (M...) or secret seed (S...). */
const STRKEY_RE = /\b([GMS])[A-Z2-7]{55,68}\b/g;
const HASH_RE = /\b[0-9a-f]{64}\b/gi;
/** A base64 run this long is an XDR envelope or another blob: never printed. */
const BLOB_RE = /[A-Za-z0-9+/]{80,}={0,2}/g;

export type Redactor = (text: string) => string;

/**
 * @param secrets values that must never appear, whatever their shape. Empty
 *   strings are ignored.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const exact = secrets.filter((s) => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const secret of exact) out = out.split(secret).join('<redacted>');
    return out
      .replace(BLOB_RE, (m) => `<blob ${m.length} chars>`)
      .replace(STRKEY_RE, (m, kind: string) => (kind === 'S' ? '<secret seed>' : `${kind}...${m.slice(-4)}`))
      .replace(HASH_RE, (m) => `#...${m.slice(-4)}`)
      .replace(EMAIL_RE, '<email>')
      .replace(BLINDPAY_ID_RE, (m) => `<${m.slice(0, m.indexOf('_'))}_id>`);
  };
}
