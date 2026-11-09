/**
 * Price tolerance on the payout leg.
 *
 * Each leg has its own quote. The source amount, the funding rate and the
 * platform spread are final when the client confirms. The amount the
 * beneficiary receives is shown as an estimate, and it is only confirmed by
 * the payout quote once the stablecoin reaches the account. When that quote
 * misses the estimate by more than the tolerance, in either direction, the
 * transfer moves to `needs_attention` and the stablecoin stays in the account.
 */
import { InvalidMoneyError } from './errors';
import { type Money, assertBps, assertSameAsset, exceedsBps, isPositive, relativeDifferenceBps } from './money';

export type ToleranceResult =
  | {
      readonly ok: true;
      /** |quoted - estimated| / estimated, in bps rounded up. */
      readonly deviationBps: number;
    }
  | {
      readonly ok: false;
      readonly deviationBps: number;
      readonly nextState: 'needs_attention';
    };

/**
 * Checks a fresh payout quote against the estimate shown to the client.
 * Within means at most `toleranceBps` away; exactly on the boundary passes.
 * The decision is exact decimal arithmetic; `deviationBps` is for display.
 *
 * @param toleranceBps integer basis points, e.g. 30 for 0.30%.
 * @throws {AssetMismatchError} when the two amounts are in different assets.
 */
export function checkPayoutTolerance(
  estimatedTarget: Money,
  quotedTarget: Money,
  toleranceBps: number,
): ToleranceResult {
  assertBps(toleranceBps, 'toleranceBps');
  assertSameAsset(estimatedTarget, quotedTarget);
  if (!isPositive(estimatedTarget)) {
    throw new InvalidMoneyError('Estimated payout amount must be positive');
  }
  const deviationBps = relativeDifferenceBps(quotedTarget, estimatedTarget);
  if (exceedsBps(quotedTarget, estimatedTarget, toleranceBps)) {
    return { ok: false, deviationBps, nextState: 'needs_attention' };
  }
  return { ok: true, deviationBps };
}
