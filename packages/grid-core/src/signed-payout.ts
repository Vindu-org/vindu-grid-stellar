/**
 * The payout leg, end to end, for any partner adapter. The transfer starts
 * in `payout_quoted`:
 *
 *   check the quote -> preparePayout (the partner's authorize step)
 *     -> none: executePayout (the partner moves the funds itself)
 *     -> stellar_xdr: check the quote -> onAuthorized (the caller stores
 *          `awaiting_signature`) -> check the quote and the signing context
 *          -> sign once -> check the quote again
 *          -> [client_submits: submit, success only] -> executePayout
 *
 * Pure orchestration: no network of its own, no state storage. The caller
 * stores the transfer state: it moves `payout_quoted -> awaiting_signature`
 * in `onAuthorized`, only once the partner's authorization exists, so a
 * failed authorization still finds the transfer in `payout_quoted`.
 *
 * Safety rules:
 * - The signer is called at most once per run, and only after `onAuthorized`
 *   returned `awaiting_signature`. A quote with no more than
 *   `expiryMarginMs` left is refused with {@link QuoteExpiredError} before
 *   authorizing, before signing, and again before the signed transaction
 *   leaves this function: get a fresh quote and a new transaction. An old
 *   XDR is never reused.
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
  PayoutAuthorizationError,
  PayoutIncompleteError,
  type PendingPayout,
  QuoteExpiredError,
  type QuoteExpiredStage,
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
   * The transfer's stored state when the run starts. It must be
   * `payout_quoted`: the run moves on to `awaiting_signature` only through
   * {@link RunSignedPayoutInput.onAuthorized}.
   */
  readonly state: 'payout_quoted';
  /** The fresh payout quote, within tolerance. `quote.source` is what the transaction must move. */
  readonly quote: LegQuote;
  /** The client's account the payout leaves from. Also the transaction's expected source. */
  readonly account: AccountRef;
  /** The partner's account the transaction must pay (G...). */
  readonly destination: string;
}

/** The partner's authorization when a key holder must sign. */
export type StellarXdrAuthorization = Extract<PayoutAuthorization, { kind: 'stellar_xdr' }>;

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
   * Called once, after the partner returned a transaction to sign and the
   * quote was checked again, and before the signer. Store
   * `payout_quoted -> awaiting_signature` (reason `signed_payout_flow`) here,
   * and return the state now stored. The signer receives that state, so
   * anything but `awaiting_signature` stops the run with
   * {@link SigningNotAllowedError} before signing.
   *
   * Not called when the partner needs no signature, when the authorization
   * fails, or when the quote expires first. If it throws, nothing is signed
   * and the error propagates.
   */
  readonly onAuthorized: (authorization: StellarXdrAuthorization) => TransferState | Promise<TransferState>;
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
 * Runs the payout leg once, from `payout_quoted`. See the module notes for
 * the safety rules.
 *
 * Where it stops, and the edge of the transition table the caller takes:
 *
 * | Error | Stage | Transfer is in | Caller takes |
 * |---|---|---|---|
 * | {@link QuoteExpiredError} | `authorization` | `payout_quoted` | `payout_quoted -> funded` (`quote_expired_before_authorization`): get a fresh quote |
 * | {@link PayoutAuthorizationError} | authorize (`preparePayout` threw or returned an unknown authorization) | `payout_quoted` | `payout_quoted -> needs_attention` (`authorization_failed`) |
 * | {@link QuoteExpiredError} | `signing` | `awaiting_signature` | `awaiting_signature -> funded` (`quote_expired_before_signing`): any signed XDR was never submitted, drop it |
 * | {@link PayoutIncompleteError} | `submit` | `awaiting_signature` | `awaiting_signature -> needs_attention` (`submission_rejected_or_unknown`) |
 * | {@link PayoutIncompleteError} | `create` | `payout_submitted` (`client_submits`, stored on the success), `awaiting_signature` (`partner_submits`) or `payout_quoted` (`none`) | retry with {@link retryPayoutExecute}; if the partner never takes a signed payout, `payout_submitted -> needs_attention` (`partner_refused_or_unknown`) or `awaiting_signature -> needs_attention` |
 *
 * On success the caller takes `payout_quoted -> payout_processing` for an
 * `authorization` of `none`, and `awaiting_signature -> payout_submitted`
 * (if the submitter did not already) then `payout_submitted -> payout_processing`
 * for `stellar_xdr`.
 *
 * The other errors have no edge of their own: nothing was submitted, and the
 * transfer stays where it is for an operator. {@link InvalidInputError} for
 * unusable input (before any call, the transfer in `payout_quoted`) or a
 * clock that breaks; {@link SigningNotAllowedError} when `onAuthorized`
 * returned another state or the signer refused; and whatever `onAuthorized`
 * or `onSigned` throw, unchanged.
 */
export async function runSignedPayout(input: RunSignedPayoutInput): Promise<SignedPayoutResult> {
  const margin = input.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  checkInput(input, margin);
  const { adapter, signer, context } = input;
  const { quote, account, transferId } = context;
  const logger = input.logger ?? noopLogger;
  const assertFresh = (stage: QuoteExpiredStage): number => assertQuoteFresh(quote, input.now(), margin, stage);

  assertFresh('authorization');
  const auth = await authorize(adapter, context, logger);
  const base: ExecutePayoutInput = { quote, account, transferId, idempotencyKey: input.idempotencyKey };

  if (auth.kind === 'none') {
    logger.info('payout needs no signature', { transferId, quoteId: quote.id });
    return execute(adapter, { body: base, idempotencyKey: input.idempotencyKey }, logger);
  }

  // Authorized but not yet handed over: the transfer is still in payout_quoted.
  assertFresh('authorization');
  const state = await input.onAuthorized(auth);
  const signingContext = signingContextFor(context, state);
  const at = assertFresh('signing');
  assertSigningAllowed(signingContext, new Date(at));
  const signedXdr = await signer.signStellar(account, auth.unsignedXdr, signingContext);
  if (typeof signedXdr !== 'string' || signedXdr === '') {
    throw new SigningNotAllowedError('The signer returned an empty transaction');
  }
  logger.info('payout signed', { transferId, quoteId: quote.id, custody: signer.custody });
  await input.onSigned?.(signedXdr);

  // Still unsubmitted: an expired quote here is safe to abandon, and the signed XDR is dropped.
  assertFresh('signing');

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

/**
 * The signing context the signer receives: everything it must compare with
 * the XDR, and the transfer's stored `state`, which must be
 * `awaiting_signature` for the signer to go ahead.
 */
export function signingContextFor(context: Omit<SignedPayoutContext, 'state'>, state: TransferState): SigningContext {
  return {
    transferId: context.transferId,
    state,
    quoteId: context.quote.id,
    expiresAt: context.quote.expiresAt,
    expected: {
      source: context.account.address,
      destination: context.destination,
      amount: context.quote.source,
    },
  };
}

/**
 * Calls the partner's authorize step. A throw, or an authorization this flow
 * does not know, becomes {@link PayoutAuthorizationError} (cause code only).
 */
async function authorize(
  adapter: Pick<PartnerAdapter, 'preparePayout'>,
  context: SignedPayoutContext,
  logger: Logger,
): Promise<PayoutAuthorization> {
  const { quote, account, transferId } = context;
  let auth: unknown;
  try {
    auth = await adapter.preparePayout({ quote, account, transferId });
  } catch (cause) {
    const error = new PayoutAuthorizationError('threw', cause);
    logger.warn('payout authorization failed', { transferId, quoteId: quote.id, causeCode: error.causeCode ?? 'none' });
    throw error;
  }
  if (isKnownAuthorization(auth)) return auth;
  logger.warn('payout authorization not recognised', { transferId, quoteId: quote.id });
  throw new PayoutAuthorizationError('invalid_authorization');
}

function isKnownAuthorization(value: unknown): value is PayoutAuthorization {
  if (typeof value !== 'object' || value === null) return false;
  const auth = value as { kind?: unknown; unsignedXdr?: unknown };
  if (auth.kind === 'none') return true;
  return auth.kind === 'stellar_xdr' && typeof auth.unsignedXdr === 'string' && auth.unsignedXdr !== '';
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
function assertQuoteFresh(quote: LegQuote, now: number, marginMs: number, stage: QuoteExpiredStage): number {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new InvalidInputError('The clock gave an invalid time: refusing to continue the payout');
  }
  const expiresAt = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now <= marginMs) {
    throw new QuoteExpiredError(quote.id, quote.expiresAt, stage);
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
  if (typeof input.onAuthorized !== 'function') {
    throw new InvalidInputError('onAuthorized is required: store awaiting_signature there before signing');
  }
  if (input.context.state !== 'payout_quoted') {
    throw new InvalidInputError(
      `Transfer ${input.context.transferId} is in ${String(input.context.state)}: the payout runs from payout_quoted`,
    );
  }
  if (input.context.quote.kind !== 'payout') {
    throw new InvalidInputError(`Quote ${input.context.quote.id} is a ${input.context.quote.kind} quote, not a payout quote`);
  }
}
