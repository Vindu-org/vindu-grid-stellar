/**
 * Small assertion helpers for the scenarios. A failed check throws
 * {@link CheckFailed} with a message that carries no secret: hashes,
 * statuses and shortened public addresses only.
 */
import { type Asset, formatAmount, parseAmount, sameAsset } from '@vindu/grid-core';
import { type HorizonAccount, type HorizonBalanceLine, NATIVE_ASSET_CODE } from '@vindu/grid-stellar';

export class CheckFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckFailed';
  }
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

/** Runs `fn` and returns what it threw, or fails the check when it did not throw. */
export function thrown(fn: () => unknown, message: string): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new CheckFailed(message);
}

/** The account's balance of `asset`, canonical ("12.5"), or `undefined` without a trustline. */
export function balanceOf(account: HorizonAccount, asset: Asset): string | undefined {
  const line = account.balances.find((b) => {
    const a = assetFromHorizonLine(b);
    return a !== null && sameAsset(a, asset);
  });
  return line === undefined ? undefined : formatAmount(parseAmount(line.balance));
}

/** `a + b` for canonical amounts. */
export function plus(a: string, b: string): string {
  return formatAmount(parseAmount(a) + parseAmount(b));
}

function assetFromHorizonLine(line: HorizonBalanceLine): Asset | null {
  if (line.asset_type === 'native') return { code: NATIVE_ASSET_CODE };
  const issued = line.asset_type === 'credit_alphanum4' || line.asset_type === 'credit_alphanum12';
  if (issued && line.asset_code !== undefined && line.asset_issuer !== undefined) {
    return { code: line.asset_code, issuer: line.asset_issuer };
  }
  return null;
}
