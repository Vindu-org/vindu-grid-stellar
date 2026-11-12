/**
 * Assets.
 *
 * An asset is an object with a `code` and, for Stellar-issued assets, the
 * `issuer` account. Fiat currencies have no issuer (`{ code: 'BRL' }`). A
 * Stellar asset is identified by both fields together: two `USDC` assets from
 * different issuers are different assets.
 *
 * The object form was chosen over a bare string code because the same code
 * can exist on several issuers, and the issuer must survive every hop so the
 * read layer can match on-chain payments exactly.
 */

/** Codes used by the two-leg flow. Any other code is allowed. */
export type AssetCode = 'BRL' | 'USD' | 'USDC' | 'USDB' | (string & {});

export interface Asset {
  readonly code: AssetCode;
  /** Stellar issuer account (G...). Absent for fiat currencies. */
  readonly issuer?: string;
}

const CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

/** True when `code` is a valid asset code (1 to 12 letters or digits, as on Stellar). */
export function isValidAssetCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** True when `address` has the shape of a Stellar public account id. Does not verify the checksum. */
export function isStellarAccountId(address: string): boolean {
  return STELLAR_ACCOUNT_RE.test(address);
}

/** A fiat currency or any asset without an issuer. */
export function fiat(code: AssetCode): Asset {
  if (!isValidAssetCode(code)) throw new TypeError(`Invalid asset code: ${code}`);
  return { code };
}

/** A Stellar-issued asset, such as USDC from a given issuer. */
export function stellarAsset(code: AssetCode, issuer: string): Asset {
  if (!isValidAssetCode(code)) throw new TypeError(`Invalid asset code: ${code}`);
  if (!isStellarAccountId(issuer)) throw new TypeError(`Invalid Stellar issuer: ${issuer}`);
  return { code, issuer };
}

/** Stable string key for an asset: `CODE` or `CODE:ISSUER`. */
export function assetKey(asset: Asset): string {
  return asset.issuer === undefined ? asset.code : `${asset.code}:${asset.issuer}`;
}

/** Same code and same issuer (or both without issuer). */
export function sameAsset(a: Asset, b: Asset): boolean {
  return a.code === b.code && a.issuer === b.issuer;
}
