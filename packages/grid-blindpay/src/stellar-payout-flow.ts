/**
 * The signed Stellar payout through BlindPay, end to end:
 *
 *   authorize -> check the quote and transfer state -> sign once
 *     -> [client_submits: submit, success only] -> create
 *
 * A thin wrapper over core's `runSignedPayout` with the BlindPay adapter, so
 * the safety rules are core's:
 * - The signer is called at most once. A quote with no more than
 *   `expiryMarginMs` (default one minute) left throws `QuoteExpiredError`
 *   before signing, and again before the signed transaction leaves.
 * - With `client_submits`, only a submitter outcome `{ status: 'success' }`
 *   with a valid hash creates the payout. `rejected`, `unknown`,
 *   `expired_not_landed`, `failed`, a malformed outcome or a throw stop with
 *   `PayoutIncompleteError` (`stage: 'submit'`), and BlindPay is never told.
 * - A failed create throws `PayoutIncompleteError` (`stage: 'create'`) with
 *   the exact input and key. Retry with {@link retryStellarPayoutCreate}.
 * - A clock or margin that is not a finite number fails closed.
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
  type PayoutSubmission,
  type PendingPayout,
  type SignedPayoutContext,
  type SignedPayoutResult,
  type Signer,
  type StellarSubmitter,
  retryPayoutExecute,
  runSignedPayout,
} from '@vindu/grid-core';

import type { BlindPayAdapter } from './adapter';

/** The parts of the BlindPay adapter the flow uses. */
export type StellarPayoutAdapter = Pick<BlindPayAdapter, 'id' | 'signedTransactionField' | 'preparePayout' | 'executePayout'>;

export interface RunStellarPayoutInput {
  readonly adapter: StellarPayoutAdapter;
  readonly signer: Signer;
  /** Core's submitter port. Required for `client_submits`. */
  readonly submitter?: StellarSubmitter;
  /** Default `client_submits`. */
  readonly submission?: PayoutSubmission;
  /**
   * The transfer, its stored state, the fresh payout quote from this adapter,
   * the client's Stellar account (`partnerAccountId` = `bw_...`) and the
   * BlindPay account the transaction must pay. The signer receives the
   * expected source, destination and amount from it.
   */
  readonly context: SignedPayoutContext;
  /** Key for BlindPay's create. Store it before calling, and reuse it on every retry. */
  readonly idempotencyKey: string;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Refuse to sign or submit with this little left on the quote. Default core's `DEFAULT_EXPIRY_MARGIN_MS`. */
  readonly expiryMarginMs?: number;
  /** Store the signed XDR (and its hash) here before it is submitted or sent. */
  readonly onSigned?: (signedXdr: string) => void | Promise<void>;
  readonly logger?: Logger;
}

/**
 * Runs the payout once. See the module notes.
 *
 * @throws {InvalidInputError} before any call for `partner_submits` with a
 *   `tx_hash` adapter, a quote from another partner, or a non-Stellar account.
 * @throws core's `QuoteExpiredError`, `SigningNotAllowedError` and `PayoutIncompleteError`.
 */
export async function runStellarPayout(input: RunStellarPayoutInput): Promise<SignedPayoutResult> {
  const submission = input.submission ?? 'client_submits';
  const { adapter, context } = input;
  if (submission === 'partner_submits' && adapter.signedTransactionField === 'tx_hash') {
    throw new InvalidInputError('partner_submits cannot send a tx_hash: nothing was submitted, so there is no hash');
  }
  if (context.quote.partner !== adapter.id) {
    throw new InvalidInputError(`Quote ${context.quote.id} is from ${context.quote.partner}, not ${adapter.id}`);
  }
  if (context.account.chain !== 'stellar') {
    throw new InvalidInputError('BlindPay pays out from Stellar accounts only');
  }
  return runSignedPayout({
    adapter,
    signer: input.signer,
    ...(input.submitter === undefined ? {} : { submitter: input.submitter }),
    submission,
    context,
    now: input.now ?? Date.now,
    ...(input.expiryMarginMs === undefined ? {} : { expiryMarginMs: input.expiryMarginMs }),
    idempotencyKey: input.idempotencyKey,
    ...(input.onSigned === undefined ? {} : { onSigned: input.onSigned }),
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
