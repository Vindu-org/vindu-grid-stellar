/**
 * Money as decimal strings, with exact arithmetic.
 *
 * Amounts cross every port as decimal strings with an explicit asset. Internally
 * they are scaled to bigint units of 10^-7 (Stellar's precision), so additions,
 * subtractions and comparisons never have floating point error: 0.1 + 0.2 is
 * exactly 0.3.
 */
import { type Asset, assetKey, sameAsset } from './assets';
import { AssetMismatchError, InvalidMoneyError } from './errors';

export interface Money {
  /** Decimal string, at most {@link MAX_DECIMALS} fractional digits, e.g. "50000" or "9512.3456789". */
  readonly amount: string;
  readonly asset: Asset;
}

/** Most fractional digits an amount may carry (Stellar's precision). */
export const MAX_DECIMALS = 7;

const SCALE = 10n ** BigInt(MAX_DECIMALS);
const AMOUNT_RE = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,7}))?$/;
/** Guards against absurd inputs; far above any real transfer. */
const MAX_INTEGER_DIGITS = 30;

/** True when `amount` is a well-formed decimal string this library accepts. */
export function isValidAmount(amount: string): boolean {
  const m = AMOUNT_RE.exec(amount);
  return m !== null && (m[2] ?? '').length <= MAX_INTEGER_DIGITS;
}

/**
 * Parses a decimal string into scaled units (10^-7). Rejects exponents, signs
 * other than a leading minus, leading zeros, a bare dot and more than 7 decimals.
 */
export function parseAmount(amount: string): bigint {
  if (typeof amount !== 'string') throw new InvalidMoneyError('Amount must be a string');
  const m = AMOUNT_RE.exec(amount);
  if (m === null) throw new InvalidMoneyError(`Invalid amount: "${amount}"`);
  const [, sign, int = '0', frac = ''] = m;
  if (int.length > MAX_INTEGER_DIGITS) throw new InvalidMoneyError('Amount too large');
  const units = BigInt(int) * SCALE + BigInt(frac.padEnd(MAX_DECIMALS, '0'));
  return sign === '-' ? -units : units;
}

/** Formats scaled units as a canonical decimal string: no trailing zeros, no "-0". */
export function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(MAX_DECIMALS, '0').replace(/0+$/, '');
  const body = frac === '' ? int.toString() : `${int}.${frac}`;
  return negative ? `-${body}` : body;
}

/** Validates the amount and returns Money with the amount in canonical form ("10.50" becomes "10.5"). */
export function money(amount: string, asset: Asset): Money {
  return { amount: formatAmount(parseAmount(amount)), asset };
}

/** Scaled units (10^-7) of a Money value. */
export function toUnits(value: Money): bigint {
  return parseAmount(value.amount);
}

/** Money from scaled units (10^-7). */
export function fromUnits(units: bigint, asset: Asset): Money {
  return { amount: formatAmount(units), asset };
}

/**
 * Integer minor units for a partner API, e.g. cents with `decimals = 2`.
 * Throws when the amount has more precision than `decimals` allows, instead of rounding.
 */
export function toMinorUnits(value: Money, decimals: number): bigint {
  assertDecimals(decimals);
  const units = toUnits(value);
  const divisor = 10n ** BigInt(MAX_DECIMALS - decimals);
  if (units % divisor !== 0n) {
    throw new InvalidMoneyError(`${value.amount} has more than ${decimals} decimals`);
  }
  return units / divisor;
}

/** Money from integer minor units, e.g. `fromMinorUnits(1050, 2, usd)` is 10.5 USD. */
export function fromMinorUnits(minor: bigint | number, decimals: number, asset: Asset): Money {
  assertDecimals(decimals);
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new InvalidMoneyError(`Minor units must be a safe integer: ${minor}`);
  }
  return fromUnits(BigInt(minor) * 10n ** BigInt(MAX_DECIMALS - decimals), asset);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new InvalidMoneyError(`Decimals must be an integer from 0 to ${MAX_DECIMALS}`);
  }
}

/** Throws {@link AssetMismatchError} unless both values share the asset. */
export function assertSameAsset(a: Money, b: Money): void {
  if (!sameAsset(a.asset, b.asset)) throw new AssetMismatchError(assetKey(a.asset), assetKey(b.asset));
}

export function add(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return fromUnits(toUnits(a) + toUnits(b), a.asset);
}

export function sub(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return fromUnits(toUnits(a) - toUnits(b), a.asset);
}

/** -1, 0 or 1. Both values must share the asset. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameAsset(a, b);
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

export function isZero(value: Money): boolean {
  return toUnits(value) === 0n;
}

export function isPositive(value: Money): boolean {
  return toUnits(value) > 0n;
}

/** Throws unless `bps` is a non-negative safe integer number of basis points. */
export function assertBps(bps: number, name = 'bps'): void {
  if (!Number.isSafeInteger(bps) || bps < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of basis points: ${bps}`);
  }
}

/**
 * |value - reference| / |reference| in basis points, rounded up to 0.01 bps
 * so it never understates the gap. For display and logs; use
 * {@link exceedsBps} to decide.
 */
export function relativeDifferenceBps(value: Money, reference: Money): number {
  const [diff, ref] = absDiffAndRef(value, reference);
  // bps with two extra digits, rounded up.
  const scaled = (diff * 1_000_000n + ref - 1n) / ref;
  return Number(scaled) / 100;
}

/** Exact test of |value - reference| / |reference| > limitBps / 10000. */
export function exceedsBps(value: Money, reference: Money, limitBps: number): boolean {
  assertBps(limitBps, 'limitBps');
  const [diff, ref] = absDiffAndRef(value, reference);
  return diff * 10_000n > BigInt(limitBps) * ref;
}

function absDiffAndRef(value: Money, reference: Money): [bigint, bigint] {
  assertSameAsset(value, reference);
  const ref = abs(toUnits(reference));
  if (ref === 0n) throw new InvalidMoneyError('Reference amount must not be zero');
  return [abs(toUnits(value) - toUnits(reference)), ref];
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
