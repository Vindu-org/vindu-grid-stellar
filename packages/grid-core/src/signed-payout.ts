/**
 * The payout leg, end to end, for any partner adapter:
 *
 *   preparePayout
 *     -> none: executePayout (the partner moves the funds itself)
 *     -> stellar_xdr: check the quote -> check the signing context -> sign once
 *          -> check the quote again -> [client_submits: submit, success only]
 *          -> executePayout
 *
 * Pure orchestration: no network of its own, no state storage. The caller
 * stores the transfer state, and moves the transfer to `awaiting_signature`
 * before calling when the account uses the signed payout flow.
 *
 * Safety rules:
 * - The signer is called at most once per run. A quote with no more than
 *   `expiryMarginMs` left is refused with {@link QuoteExpiredError} before
 *   signing, and again before the signed transaction leaves this function:
 *   get a fresh quote and a new transaction. An old XDR is never reused.
 * - With `client_submits`, only `{ status: 'success' }` lets the payout be
 *   created. Any other outcome, or a submitter that throws, stops with
 *   {@link PayoutIncompleteError} (`stage: 'submit'`) carrying the outcome,
 *   and `executePayout` is never called.
 * - When `executePayout` fails, {@link PayoutIncompleteError}
 *   (`stage: 'create'`) carries the exact input and idempotency key. Retry
 *   with {@link retryPayoutExecute}; it never signs or submits anything.
 * - A clock that returns a non-finite time, or a non-finite margin, fails closed.
 */
import {
  InvalidInputError,
  PayoutIncompleteError,
  type PendingPayout,
  QuoteExpiredError,
  SigningNotAllowedError,
} from './errors';
import { type Logger, noopLogger } from './observability';
import type {
  AccountRef,
  ExecutePayoutInput,
  LegQuote,
  LegRef,
  PartnerAdapter,
  PayoutAuthorization,
} from './ports';
import { type Signer, type SigningContext, assertSigningAllowed } from './signer';
import type { StellarSubmitter, SubmitOutcome } from './submission';
import type { TransferState } from './transfer-states';

/**
 * Who puts the signed transaction on Stellar.
 * - `client_submits`: our submitter does, and the partner is told after a success.
 * - `partner_submits`: the partner receives the signed XDR and submits it.
 */
export type PayoutSubmission = 'client_submits' | 'partner_submits';

/** Default time a quote must still have left before signing or submitting: one minute. */
export const DEFAULT_EXPIRY_MARGIN_MS = 60_000;

/** The transfer and payout quote the run belongs to. */
export interface SignedPayoutContext {
  readonly transferId: string;
  /**
   * The transfer's stored state. Signing is refused unless it is
   * `awaiting_signature`; it is not checked when the partner needs no signature.
   */
  readonly state: TransferState;
  /** The fresh payout quote, within tolerance. `quote.source` is what the transaction must move. */
  readonly quote: LegQuote;
  /** The client's account the payout leaves from. Also the transaction's expected source. */
  readonly account: AccountRef;
  /** The partner's account the transaction must pay (G...). */
  readonly destination: string;
}

export interface RunSignedPayoutInput {
  readonly adapter: Pick<PartnerAdapter, 'preparePayout' | 'executePayout'>;
  readonly signer: Signer;
  /** Required for `client_submits`. */
  readonly submitter?: StellarSubmitter;
  readonly submission: PayoutSubmission;
  readonly context: SignedPayoutContext;
  /** Clock in ms since epoch. A non-finite reading stops the run. */
  readonly now: () => number;
  /**
   * Refuse to sign or submit when no more than this is left on the quote.
   * Default {@link DEFAULT_EXPIRY_MARGIN_MS}. Must be a finite number >= 0.
   */
  readonly expiryMarginMs?: number;
  /** Key for `executePayout`. Store it before calling, and reuse it on every retry. */
  readonly idempotencyKey: string;
  /**
   * Called once with the signed XDR, before it is submitted or sent to the
   * partner. Store it here (and its hash), so a crash after submission still
   * leaves a way to look the transaction up. If this throws, nothing is
   * submitted and the error propagates.
   */
  readonly onSigned?: (signedXdr: string) => void | Promise<void>;
  readonly logger?: Logger;
}

export interface SignedPayoutResult {
  readonly leg: LegRef;
  /** Which path ran: `none` (no signature) or `stellar_xdr` (signed). */
  readonly authorization: PayoutAuthorization['kind'];
  readonly signedXdr?: string;
  /** Hash of the submitted transaction, with `client_submits`. */
  readonly txHash?: string;
  /** The exact `executePayout` input and key that created the payout. */
  readonly pending: PendingPayout<ExecutePayoutInput>;
}

const TX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Runs the payout leg once. See the module notes for the safety rules.
 *
 * @throws {QuoteExpiredError} before anything is signed or submitted, when the quote is too close to expiry.
 * @throws {SigningNotAllowedError} when the transfer is not in a signable state, or the signer refuses.
 * @throws {PayoutIncompleteError} with `stage: 'submit'` or `'create'`; its `pending` is
 *   `PendingPayout<ExecutePayoutInput>` for {@link retryPayoutExecute}.
 * @throws {InvalidInputError} for unusable input, including a broken clock.
 */
export async function runSignedPayout(input: RunSignedPayoutInput): Promise<SignedPayoutResult> {
  const margin = input.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  checkInput(input, margin);
  const { adapter, signer, context } = input;
  const { quote, account, transferId } = context;
  const logger = input.logger ?? noopLogger;
  const assertFresh = (): number => assertQuoteFresh(quote, input.now(), margin);

  assertFresh();
  const auth = await adapter.preparePayout({ quote, account, transferId });
  const base: ExecutePayoutInput = { quote, account, transferId, idempotencyKey: input.idempotencyKey };

  if (auth.kind === 'none') {
    logger.info('payout needs no signature', { transferId, quoteId: quote.id });
    return execute(adapter, { body: base, idempotencyKey: input.idempotencyKey }, logger);
  }
  if (auth.kind !== 'stellar_xdr' || typeof auth.unsignedXdr !== 'string' || auth.unsignedXdr === '') {
    throw new InvalidInputError('preparePayout returned an authorization this flow does not know');
  }

  const signingContext = signingContextFor(context);
  const at = assertFresh();
  assertSigningAllowed(signingContext, new Date(at));
  const signedXdr = await signer.signStellar(account, auth.unsignedXdr, signingContext);
  if (typeof signedXdr !== 'string' || signedXdr === '') {
    throw new SigningNotAllowedError('The signer returned an empty transaction');
  }
  logger.info('payout signed', { transferId, quoteId: quote.id, custody: signer.custody });
  await input.onSigned?.(signedXdr);

  // Still unsubmitted: an expired quote here is safe to abandon, and the signed XDR is dropped.
  assertFresh();

  let txHash: string | undefined;
  if (input.submission === 'client_submits') {
    const submitter = input.submitter as StellarSubmitter;
    let outcome: SubmitOutcome;
    try {
      outcome = await submitter.submit(signedXdr);
    } catch (cause) {
      throw new PayoutIncompleteError({ stage: 'submit', signedXdr, cause });
    }
    if (!isConfirmedSuccess(outcome)) {
      const hash = hashOf(outcome);
      logger.warn('payout submit did not succeed', { transferId, quoteId: quote.id, status: statusOf(outcome) });
      throw new PayoutIncompleteError({
        stage: 'submit',
        signedXdr,
        ...(hash === undefined ? {} : { txHash: hash }),
        ...(isOutcome(outcome) ? { outcome } : {}),
      });
    }
    txHash = outcome.hash;
    logger.info('payout submitted', { transferId, quoteId: quote.id, txHash });
  }

  const body: ExecutePayoutInput = { ...base, signedXdr, ...(txHash === undefined ? {} : { txHash }) };
  return execute(adapter, { body, idempotencyKey: input.idempotencyKey }, logger);
}

/**
 * Sends `executePayout` again with exactly the pending input and key. Use it
 * after {@link PayoutIncompleteError} with `stage: 'create'`. Never signs or
 * submits anything.
 */
export async function retryPayoutExecute(
  adapter: Pick<PartnerAdapter, 'executePayout'>,
  pending: PendingPayout<ExecutePayoutInput>,
  logger: Logger = noopLogger,
): Promise<SignedPayoutResult> {
  if (pending.body.idempotencyKey !== pending.idempotencyKey) {
    throw new InvalidInputError('The pending payout body and its idempotency key do not match');
  }
  return execute(adapter, pending, logger);
}

/** The signing context the signer receives: everything it must compare with the XDR. */
export function signingContextFor(context: SignedPayoutContext): SigningContext {
  return {
    transferId: context.transferId,
    state: context.state,
    quoteId: context.quote.id,
    expiresAt: context.quote.expiresAt,
    expected: {
      source: context.account.address,
      destination: context.destination,
      amount: context.quote.source,
    },
  };
}

async function execute(
  adapter: Pick<PartnerAdapter, 'executePayout'>,
  pending: PendingPayout<ExecutePayoutInput>,
  logger: Logger,
): Promise<SignedPayoutResult> {
  const { signedXdr, txHash } = pending.body;
  let leg: LegRef;
  try {
    leg = await adapter.executePayout(pending.body);
  } catch (cause) {
    logger.warn('payout create failed', { transferId: pending.body.transferId, quoteId: pending.body.quote.id });
    throw new PayoutIncompleteError<ExecutePayoutInput>({
      stage: 'create',
      ...(signedXdr === undefined ? {} : { signedXdr }),
      ...(txHash === undefined ? {} : { txHash }),
      pending,
      cause,
    });
  }
  return {
    leg,
    authorization: signedXdr === undefined ? 'none' : 'stellar_xdr',
    ...(signedXdr === undefined ? {} : { signedXdr }),
    ...(txHash === undefined ? {} : { txHash }),
    pending,
  };
}

/** Returns `now` when the quote has more than `marginMs` left; throws otherwise. */
function assertQuoteFresh(quote: LegQuote, now: number, marginMs: number): number {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new InvalidInputError('The clock gave an invalid time: refusing to continue the payout');
  }
  const expiresAt = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now <= marginMs) {
    throw new QuoteExpiredError(quote.id, quote.expiresAt);
  }
  return now;
}

function isOutcome(value: unknown): value is SubmitOutcome {
  return typeof value === 'object' && value !== null && typeof (value as { status?: unknown }).status === 'string';
}

function isConfirmedSuccess(outcome: unknown): outcome is Extract<SubmitOutcome, { status: 'success' }> {
  return isOutcome(outcome) && outcome.status === 'success' && typeof outcome.hash === 'string' && TX_HASH_RE.test(outcome.hash);
}

function hashOf(outcome: unknown): string | undefined {
  const hash = isOutcome(outcome) ? (outcome as { hash?: unknown }).hash : undefined;
  return typeof hash === 'string' && TX_HASH_RE.test(hash) ? hash : undefined;
}

function statusOf(outcome: unknown): string {
  return isOutcome(outcome) ? outcome.status : 'malformed';
}

function checkInput(input: RunSignedPayoutInput, margin: number): void {
  if (input.submission !== 'client_submits' && input.submission !== 'partner_submits') {
    throw new InvalidInputError(`Unknown submission mode: ${String(input.submission)}`);
  }
  if (input.submission === 'client_submits' && input.submitter === undefined) {
    throw new InvalidInputError('client_submits needs a submitter');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
    throw new InvalidInputError('idempotencyKey is required and must be reused on every retry');
  }
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) {
    throw new InvalidInputError(`expiryMarginMs must be a finite number of ms >= 0: ${String(margin)}`);
  }
  if (typeof input.now !== 'function') {
    throw new InvalidInputError('now must be a clock function');
  }
  if (input.context.quote.kind !== 'payout') {
    throw new InvalidInputError(`Quote ${input.context.quote.id} is a ${input.context.quote.kind} quote, not a payout quote`);
  }
}
