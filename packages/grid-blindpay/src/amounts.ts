/**
 * Amount conversion between core `Money` (decimal strings) and BlindPay's
 * integer minor units.
 *
 * BlindPay sends every amount as an integer with 2 decimals, on the fiat side
 * and on the stablecoin side alike: `request_amount: 10000` is 100.00 USD, and
 * also 100 USDC ("100 USDC = 10000" in BlindPay's docs). This surprises people
 * used to USDC's 6 or 7 on-chain decimals, so it is written down here.
 *
 * Conversion is exact: an amount with sub-cent precision throws, it is never
 * rounded. The one exception is {@link floorToBlindPayAmount}, for paying out
 * a funded balance: it rounds down and the sub-cent rest stays in the account.
 */
import {
  type Asset,
  InvalidInputError,
  MAX_DECIMALS,
  type Money,
  fromMinorUnits,
  isPositive,
  toMinorUnits,
  toUnits,
} from '@vindu/grid-core';


/** Decimals of every BlindPay amount, fiat and stablecoin. */
export const BLINDPAY_DECIMALS = 2;

/**
 * Development instances decide the outcome from `request_amount`: `66600`
 * (666.00) ends `failed`, `77700` (777.00) ends `refunded`, anything else
 * `completed`. Production ignores them.
 */
export const DEV_SENTINEL_AMOUNTS = { failed: 66_600, refunded: 77_700 } as const;

/** `Money` to BlindPay minor units. Throws on sub-cent precision, zero, negatives and unsafe sizes. */
export function toBlindPayAmount(value: Money): number {
  if (!isPositive(value)) throw new InvalidInputError(`Amount must be positive: ${value.amount}`);
  let minor: bigint;
  try {
    minor = toMinorUnits(value, BLINDPAY_DECIMALS);
  } catch {
    throw new InvalidInputError(
      `${value.amount} ${value.asset.code} has sub-cent precision; BlindPay takes ${BLINDPAY_DECIMALS} decimals`,
    );
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidInputError('Amount too large');
  return Number(minor);
}

/**
 * `Money` to BlindPay minor units, rounded DOWN to the cent. For a payout of a
 * funded balance, which can carry Stellar's 7 decimals: `100.1234567` USDC
 * becomes `10012` (100.12), and the `0.0034567` rest stays in the account.
 * Never rounds up, so it never asks for more than the account holds. Throws
 * when less than one cent is left, and on unsafe sizes.
 */
export function floorToBlindPayAmount(value: Money): number {
  const minor = toUnits(value) / 10n ** BigInt(MAX_DECIMALS - BLINDPAY_DECIMALS);
  if (minor <= 0n) throw new InvalidInputError(`Amount must be at least 0.01: ${value.amount}`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidInputError('Amount too large');
  return Number(minor);
}

/** BlindPay minor units to `Money`. Throws unless `minor` is a safe integer. */
export function fromBlindPayAmount(minor: number, asset: Asset): Money {
  if (!Number.isSafeInteger(minor)) throw new InvalidInputError(`Not an integer amount in minor units: ${minor}`);
  return fromMinorUnits(minor, BLINDPAY_DECIMALS, asset);
}
