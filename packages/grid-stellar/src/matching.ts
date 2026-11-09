/**
 * Matching on-chain payments to transfer legs.
 *
 * A payment matches a leg when the destination, the asset (code and issuer)
 * and the exact amount agree, and, when the leg carries them, the
 * transaction hash and the memo or partner reference agree too. Some partner
 * flows build the transaction themselves and cannot carry a memo; there the
 * registered destination account is what ties a payment to a client, so
 * follow those accounts rather than a shared treasury address.
 *
 * Funding counts only when the partner's figure and the chain agree:
 * {@link partnerAndChainAgree}.
 */
import {
  InvalidMoneyError,
  type Money,
  assertBps,
  equals,
  exceedsBps,
  isPositive,
  money,
  relativeDifferenceBps,
  sameAsset,
} from '@vindu/grid-core';
import type { ChainPayment } from './payments';

/** What the application expects one leg to look like on chain. */
export interface ExpectedLeg {
  /** The application's id for the leg or transfer. Returned on a match. */
  readonly legId: string;
  /** Account the stablecoin must arrive at. */
  readonly destination: string;
  /** Exact amount and asset (with issuer) expected on chain. */
  readonly amount: Money;
  /** Account the payment must come from, when known. */
  readonly source?: string;
  /** Transaction hash, when the leg already knows it (e.g. after submission). */
  readonly txHash?: string;
  /**
   * Memo or partner reference the payment must carry. Compared with the
   * transaction memo and with the muxed destination id.
   */
  readonly reference?: string;
}

export type MatchField = 'destination' | 'source' | 'asset' | 'amount' | 'tx_hash' | 'reference';

export interface LegMismatch {
  readonly legId: string;
  /** Every field that did not agree. */
  readonly failed: readonly MatchField[];
}

export type MatchResult =
  | {
      readonly status: 'matched';
      readonly leg: ExpectedLeg;
      /** Fields that agreed, e.g. `['destination', 'asset', 'amount', 'tx_hash']`. */
      readonly matchedOn: readonly MatchField[];
    }
  | {
      readonly status: 'ambiguous';
      /** Legs the payment fits equally well. Resolve by hand or add a hash or reference. */
      readonly candidates: readonly ExpectedLeg[];
      readonly reason: 'several_legs_fit';
    }
  | {
      readonly status: 'unmatched';
      /** Why each leg was rejected. Empty when no legs were given. */
      readonly mismatches: readonly LegMismatch[];
    };

/**
 * Matches one payment against the open legs. A single fitting leg is a
 * match. When several fit, a leg that also agreed on a hash or reference
 * wins if it is the only such leg; otherwise the result is `ambiguous`.
 */
export function matchPaymentToLeg(payment: ChainPayment, expectedLegs: readonly ExpectedLeg[]): MatchResult {
  const fits: Array<{ leg: ExpectedLeg; matchedOn: MatchField[] }> = [];
  const mismatches: LegMismatch[] = [];
  for (const leg of expectedLegs) {
    const { failed, matchedOn } = compareLeg(payment, leg);
    if (failed.length === 0) fits.push({ leg, matchedOn });
    else mismatches.push({ legId: leg.legId, failed });
  }

  if (fits.length === 1) return { status: 'matched', leg: fits[0]!.leg, matchedOn: fits[0]!.matchedOn };
  if (fits.length === 0) return { status: 'unmatched', mismatches };

  const strong = fits.filter((f) => f.matchedOn.includes('tx_hash') || f.matchedOn.includes('reference'));
  if (strong.length === 1) return { status: 'matched', leg: strong[0]!.leg, matchedOn: strong[0]!.matchedOn };
  return { status: 'ambiguous', candidates: fits.map((f) => f.leg), reason: 'several_legs_fit' };
}

function compareLeg(payment: ChainPayment, leg: ExpectedLeg): { failed: MatchField[]; matchedOn: MatchField[] } {
  const failed: MatchField[] = [];
  const matchedOn: MatchField[] = [];
  const check = (field: MatchField, ok: boolean): void => {
    (ok ? matchedOn : failed).push(field);
  };

  check('destination', payment.to === leg.destination);
  if (leg.source !== undefined) check('source', payment.from === leg.source);
  const assetOk = sameAsset(payment.asset, leg.amount.asset);
  check('asset', assetOk);
  // Amounts only compare within one asset; a different asset already failed.
  check('amount', assetOk && equals(money(payment.amount, payment.asset), leg.amount));
  if (leg.txHash !== undefined) check('tx_hash', payment.txHash.toLowerCase() === leg.txHash.toLowerCase());
  if (leg.reference !== undefined) {
    check('reference', payment.memo === leg.reference || payment.toMuxedId === leg.reference);
  }
  return { failed, matchedOn };
}

export type AgreementResult =
  | {
      readonly agree: true;
      /** |chain - partner| / partner, in bps rounded up. For display. */
      readonly differenceBps: number;
    }
  | {
      readonly agree: false;
      readonly reason: 'asset_mismatch' | 'beyond_limit';
      /** Present for `beyond_limit`. */
      readonly differenceBps?: number;
      readonly nextState: 'needs_attention';
    };

/**
 * Do the partner's figure and the on-chain amount agree? Both must agree
 * before a funding leg counts as funded. Within means at most `limitBps`
 * apart, relative to the partner's amount; exactly on the limit agrees. Use
 * 0 to require an exact match. Different assets (including a different
 * issuer) never agree.
 *
 * @param limitBps integer basis points.
 * @throws {InvalidMoneyError} when the partner amount is not positive.
 */
export function partnerAndChainAgree(partnerAmount: Money, chainAmount: Money, limitBps: number): AgreementResult {
  assertBps(limitBps, 'limitBps');
  if (!sameAsset(partnerAmount.asset, chainAmount.asset)) {
    return { agree: false, reason: 'asset_mismatch', nextState: 'needs_attention' };
  }
  if (!isPositive(partnerAmount)) throw new InvalidMoneyError('Partner amount must be positive');
  const differenceBps = relativeDifferenceBps(chainAmount, partnerAmount);
  if (exceedsBps(chainAmount, partnerAmount, limitBps)) {
    return { agree: false, reason: 'beyond_limit', differenceBps, nextState: 'needs_attention' };
  }
  return { agree: true, differenceBps };
}
