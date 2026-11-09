/**
 * The signed Stellar payout through BlindPay, end to end, from `payout_quoted`:
 *
 *   check the funds -> authorize -> onAuthorized (store `awaiting_signature`)
 *     -> check the stored state and the quote -> sign once
 *     -> [client_submits: submit, success only -> onSubmitted (store
 *        `payout_submitted`)] -> create
 *
 * A thin wrapper over core's `runSignedPayout` with the BlindPay adapter, so
 * the safety rules, and the error to transition table in its doc, are core's:
 * - Core checks before any call that the quote is from this adapter's id and
 *   that `quote.source` is a positive amount of the funded asset, no more
 *   than `funded`. The adapter already refuses a quote whose `sender_amount`
 *   is not the amount requested.
 * - The signer is called at most once, after `onAuthorized` stored
 *   `awaiting_signature` with a compare-and-set. A quote with no more than
 *   `expiryMarginMs` (default one minute) left throws `QuoteExpiredError`
 *   before authorizing (`stage: 'authorization'`); with `client_submits`,
 *   one with no more than `expiryMarginMs` plus the submitter's
 *   `maxDurationMs` left throws it before signing and before the signed
 *   transaction leaves.
 * - A failed authorize call, or an answer without the XDR, throws
 *   `PayoutAuthorizationError` while the transfer is still in `payout_quoted`.
 * - Anything the signer throws becomes `SignerRefusedError`.
 * - With `client_submits`, only a submitter outcome `{ status: 'success' }`
 *   with a valid hash creates the payout, and only after `onSubmitted`
 *   stored it. `rejected`, `unknown`, `expired_not_landed`, `failed`, a
 *   malformed outcome or a throw stop with `PayoutIncompleteError`
 *   (`stage: 'submit'`), and BlindPay is never told. If `onSubmitted`
 *   throws, `PayoutIncompleteError` (`stage: 'record'`): the money moved;
 *   store it, then call {@link retryStellarPayoutCreate}. Never re-quote.
 * - A failed create throws `PayoutIncompleteError` (`stage: 'create'`) with
 *   the exact input and key. Retry with {@link retryStellarPayoutCreate}.
 * - A clock, margin or submit budget that is not a finite number fails closed.
 *
 * Two BlindPay answers are still open, so both are options:
 * - `submission`: we submit to Stellar first (`client_submits`, the docs'
 *   example and the default) or BlindPay receives the signed XDR (`partner_submits`).
 * - The adapter's `signedTransactionField`: `signed_transaction` carries the
 *   signed XDR (`signed_xdr`, default) or the hash (`tx_hash`). `tx_hash`
 *   needs `client_submits`: without a submit there is no hash.
 */
import {
  type ExecutePayoutInput,
  InvalidInputError,
  type Logger,
  type Money,
  type PayoutSubmission,
  type PendingPayout,
  type SignedPayoutContext,
  type SignedPayoutResult,
  type SignedPayoutSigning,
  retryPayoutExecute,
  runSignedPayout,
} from '@vindu/grid-core';

import type { BlindPayAdapter } from './adapter';

/** The parts of the BlindPay adapter the flow uses. */
export type StellarPayoutAdapter = Pick<BlindPayAdapter, 'id' | 'signedTransactionField' | 'preparePayout' | 'executePayout'>;

/**
 * Core's signing group, with `submission` defaulting to `client_submits`.
 * BlindPay always returns a transaction to sign, so it is required here.
 * With `client_submits`, `submitter` and `onSubmitted` are required.
 */
export interface StellarPayoutSigning extends Omit<SignedPayoutSigning, 'submission'> {
  /** Default `client_submits`. */
  readonly submission?: PayoutSubmission;
}

export interface RunStellarPayoutInput {
  readonly adapter: StellarPayoutAdapter;
  /**
   * The transfer (stored in `payout_quoted`), the fresh payout quote from
   * this adapter, and the client's Stellar account (`partnerAccountId` =
   * `bw_...`). The signer receives the expected source and amount from it.
   */
  readonly context: SignedPayoutContext;
  /** The amount confirmed in the account. The quote may not move more. */
  readonly funded: Money;
  /** Signer, submission, submitter, BlindPay's account to pay (`destination`) and the hooks. */
  readonly signing: StellarPayoutSigning;
  /** Key for BlindPay's create. Store it before calling, and reuse it on every retry. */
  readonly idempotencyKey: string;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Refuse to sign or submit with this little left on the quote. Default core's `DEFAULT_EXPIRY_MARGIN_MS`. */
  readonly expiryMarginMs?: number;
  readonly logger?: Logger;
}

/**
 * Runs the payout once. See the module notes.
 *
 * @throws {InvalidInputError} before any call for missing signing inputs,
 *   `partner_submits` with a `tx_hash` adapter, a non-Stellar account, and
 *   everything core refuses up front (a quote from another partner, a quote
 *   above `funded`, `client_submits` without a submitter or `onSubmitted`).
 * @throws core's `QuoteExpiredError`, `PayoutAuthorizationError`,
 *   `SigningNotAllowedError`, `SignerRefusedError` and `PayoutIncompleteError`;
 *   see core's `runSignedPayout` for the edge each one takes.
 */
export async function runStellarPayout(input: RunStellarPayoutInput): Promise<SignedPayoutResult> {
  const { adapter, context } = input;
  if (typeof input.signing !== 'object' || input.signing === null) {
    throw new InvalidInputError('BlindPay payouts are always signed: signing is required');
  }
  const submission = input.signing.submission ?? 'client_submits';
  if (submission === 'partner_submits' && adapter.signedTransactionField === 'tx_hash') {
    throw new InvalidInputError('partner_submits cannot send a tx_hash: nothing was submitted, so there is no hash');
  }
  if (context.account.chain !== 'stellar') {
    throw new InvalidInputError('BlindPay pays out from Stellar accounts only');
  }
  return runSignedPayout({
    adapter,
    context,
    funded: input.funded,
    signing: { ...input.signing, submission },
    now: input.now ?? Date.now,
    ...(input.expiryMarginMs === undefined ? {} : { expiryMarginMs: input.expiryMarginMs }),
    idempotencyKey: input.idempotencyKey,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
}
/**
 * Sends BlindPay's create again with exactly the pending input and key, after
 * `PayoutIncompleteError` with `stage: 'create'`. Use the same adapter
 * configuration, so the body is byte for byte the same. Never signs or submits.
 * BlindPay keeps idempotency keys for 24 hours.
 */
export async function retryStellarPayoutCreate(
  adapter: Pick<BlindPayAdapter, 'executePayout'>,
  pending: PendingPayout<ExecutePayoutInput>,
  logger?: Logger,
): Promise<SignedPayoutResult> {
  return retryPayoutExecute(adapter, pending, logger);
}
