/**
 * The stablecoins BlindPay moves on Stellar, checked by code AND issuer.
 *
 * A Stellar asset is its code plus its issuer: `USDC` from any other issuer is
 * a different asset. The adapter knows the issuers only from its options, and
 * refuses anything it cannot match exactly:
 * - `USDC` is allowed on both networks, with the configured issuer.
 * - `USDB`, BlindPay's development token, only on `stellar_testnet`.
 */
import { type Asset, InvalidConfigError, InvalidInputError, isStellarAccountId, stellarAsset } from '@vindu/grid-core';

import type { BlindPayNetwork, StellarToken } from './types';

/** Issuer account (G...) of each token the adapter may move. */
export type StablecoinIssuers = Readonly<Partial<Record<StellarToken, string>>>;

export interface Stablecoins {
  /** BlindPay's `token` for `asset`. Throws {@link InvalidInputError} unless code and issuer match. */
  tokenFor(asset: Asset): StellarToken;
  /** The asset behind a BlindPay `token`, or `undefined` when it is not allowed or its issuer is not configured. */
  assetFor(token: unknown): Asset | undefined;
}

const TOKENS_BY_NETWORK: Readonly<Record<BlindPayNetwork, readonly StellarToken[]>> = {
  stellar: ['USDC'],
  stellar_testnet: ['USDC', 'USDB'],
};

export function stablecoins(network: BlindPayNetwork, issuers: StablecoinIssuers = {}): Stablecoins {
  const allowed = TOKENS_BY_NETWORK[network];
  for (const [code, issuer] of Object.entries(issuers)) {
    if (issuer === undefined) continue;
    if (!allowed.includes(code as StellarToken)) {
      throw new InvalidConfigError(`${code} is not available on ${network}`);
    }
    if (typeof issuer !== 'string' || !isStellarAccountId(issuer)) {
      throw new InvalidConfigError(`The ${code} issuer must be a Stellar account id (G...)`);
    }
  }
  const issuerOf = (code: StellarToken): string | undefined =>
    Object.hasOwn(issuers, code) ? issuers[code] : undefined;

  return {
    tokenFor(asset) {
      const code = asset.code as StellarToken;
      if (!allowed.includes(code)) {
        throw new InvalidInputError(`Token ${asset.code} is not supported on ${network}; use ${allowed.join(' or ')}`);
      }
      const expected = issuerOf(code);
      if (expected === undefined) {
        throw new InvalidConfigError(`No ${code} issuer configured: set options.assetIssuers.${code}`);
      }
      if (asset.issuer !== expected) {
        throw new InvalidInputError(`${code} must be issued by the configured issuer ${expected}`);
      }
      return code;
    },
    assetFor(token) {
      if (typeof token !== 'string' || !allowed.includes(token as StellarToken)) return undefined;
      const issuer = issuerOf(token as StellarToken);
      return issuer === undefined ? undefined : stellarAsset(token, issuer);
    },
  };
}
