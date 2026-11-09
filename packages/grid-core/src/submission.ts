/**
 * The Stellar submitter port.
 *
 * Puts a signed transaction on Stellar and says what is known about it. The
 * payout flow creates the partner payout only after `{ status: 'success' }`;
 * any other outcome stops the flow with the signed XDR and the hash, so a
 * person or a later check can settle it. `@vindu/grid-stellar` provides an
 * implementation; any object of this shape works.
 *
 * What each status allows next:
 *
 * | Status | On the ledger? | Sign a replacement? |
 * |---|---|---|
 * | `success` | yes, applied | no: the payment moved |
 * | `failed` | yes, failed: fee and sequence number spent, nothing moved | yes |
 * | `expired_not_landed` | no, and its `maxTime` has passed on the network, so it never can | yes |
 * | `rejected` | no, but it may still land until its `maxTime` | **no** |
 * | `unknown` | not known: it may be on the ledger or still land | **no** |
 *
 * Never sign a replacement while the first transaction could still land:
 * that is how a payout gets paid twice.
 */

export type SubmitOutcomeStatus = 'success' | 'failed' | 'rejected' | 'unknown' | 'expired_not_landed';

/** Extra, non-secret facts about an outcome, for logs and operators. Never the signed XDR. */
export type SubmitOutcomeDetail = Readonly<Record<string, unknown>>;

export type SubmitOutcome =
  | {
      readonly status: 'success';
      /** Hex hash of the transaction as it is on the ledger. */
      readonly hash: string;
    }
  | {
      readonly status: Exclude<SubmitOutcomeStatus, 'success'>;
      /** Hex hash of the signed transaction, to look it up later. */
      readonly hash: string;
      readonly detail?: SubmitOutcomeDetail;
    };

export interface StellarSubmitter {
  /**
   * The longest one `submit` call can take, in milliseconds, including every
   * wait and lookup. The payout flow refuses to sign unless the quote has
   * more than its expiry margin plus this left, so a slow submit cannot run
   * past the quote. Leave it out only for a submitter that answers at once.
   * Must be a finite number >= 0.
   */
  readonly maxDurationMs?: number;
  /**
   * Submits `signedXdr` and resolves with what is known about it. Network and
   * Horizon errors should become `unknown`, not a rejection, because the
   * transaction may have reached the network before the error.
   */
  submit(signedXdr: string): Promise<SubmitOutcome>;
}

/** Statuses after which the first transaction can never move money, so a new one may be signed. */
export const REPLACEMENT_ALLOWED_STATUSES: readonly SubmitOutcomeStatus[] = ['failed', 'expired_not_landed'];

/**
 * True only for `failed` and `expired_not_landed`: the first transaction can
 * never move money, so a replacement may be signed. False for everything
 * else, including `unknown` and `rejected`, where the first one could still land.
 */
export function canSignReplacement(outcome: Pick<SubmitOutcome, 'status'>): boolean {
  return REPLACEMENT_ALLOWED_STATUSES.includes(outcome.status);
}
