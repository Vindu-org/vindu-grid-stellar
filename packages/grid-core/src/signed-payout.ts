/**
 * The payout leg, end to end, for any partner adapter. The transfer starts
 * in `payout_quoted`:
 *
 *   check the input, the funds and the quote -> preparePayout (the partner's
 *   authorize step)
 *     -> none: check the quote -> executePayout (the partner moves the
 *          funds itself; no `signing` inputs needed)
 *     -> stellar_xdr: check the quote -> onAuthorized (the caller stores
 *          `awaiting_signature`) -> check the stored state, then the quote
 *          -> sign once -> onSigned -> check the quote again
 *          -> client_submits: submit, success only -> onSubmitted (the
 *               caller stores `payout_submitted`) -> executePayout
 *          -> partner_submits: executePayout with the signed XDR
 *
 * Pure orchestration: no network of its own, no state storage. The caller
 * stores the transfer state in the hooks, only once each step happened: a
 * failed authorization still finds the transfer in `payout_quoted`, and a
 * confirmed submit is stored as `payout_submitted` before the partner hears
 * about it.
 *
 * Safety rules:
 * - Core checks what any adapter could get wrong: the quote's `partner` is
 *   the adapter's `id`; the quote moves a positive amount of the funded
 *   asset, no more than `funded`; a transaction to sign is for a Stellar
 *   account. The signer's expected amount is the quote's `source` only after
 *   those checks.
 * - `onAuthorized` must be a compare-and-set on the stored state: move
 *   `payout_quoted -> awaiting_signature` only if the transfer is still in
 *   `payout_quoted`. When the compare fails, throw (or return the state
 *   found, as long as it is not `awaiting_signature`): never return
 *   `awaiting_signature` for a move this call did not make. Two concurrent
 *   runs for one transfer then cannot both sign. A store that cannot
 *   compare and set must lock the transfer around the whole run.
 * - The signer is called at most once per run, and only after `onAuthorized`
 *   returned `awaiting_signature`. A quote with no more than
 *   `expiryMarginMs` left is refused with {@link QuoteExpiredError} before
 *   authorizing, and, when the partner needs no signature, again before the
 *   payout is created. With `client_submits`, the quote must also outlive the
 *   submitter's `maxDurationMs`: no more than `expiryMarginMs +
 *   maxDurationMs` left is refused before `onAuthorized`, before signing,
 *   and again before the signed transaction leaves this function. Get a
 *   fresh quote and a new transaction; an old XDR is never reused.
 * - Anything the signer throws, or a result that is not a signed XDR, stops
 *   with {@link SignerRefusedError}; nothing is submitted.
 * - With `client_submits`, only `{ status: 'success' }` lets the payout be
 *   created. Any other outcome, or a submitter that throws, stops with
 *   {@link PayoutIncompleteError} (`stage: 'submit'`) carrying the outcome,
 *   and `executePayout` is never called.
 * - When `executePayout` fails, {@link PayoutIncompleteError}
 *   (`stage: 'create'`) carries the exact input and idempotency key. Retry
 *   with {@link retryPayoutExecute}; it never signs or submits anything.
 * - A clock that returns a non-finite time, a non-finite margin or submit
 *   budget, or a quote expiry that is not a strict ISO-8601 instant fails closed.
 */
import { assetKey, isStellarAccountId, sameAsset } from './assets';
import {
  InvalidInputError,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  type PendingPayout,
  QuoteExpiredError,
  type QuoteExpiredStage,
  SignerRefusedError,
  SigningNotAllowedError,
} from './errors';
import { parseInstantMs } from './instant';
import { type Money, compare, isPositive, isValidAmount } from './money';
import { type Logger, noopLogger } from './observability';
import type {
  AccountRef,
  ExecutePayoutInput,
  LegQuote,
  LegRef,
  PartnerAdapter,
  PayoutAuthorization,
} from './ports';
import type { Signer, SigningContext } from './signer';
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
   * {@link SignedPayoutSigning.onAuthorized}.
   */
  readonly state: 'payout_quoted';
  /** The fresh payout quote, within tolerance. `quote.source` is what the transaction must move. */
  readonly quote: LegQuote;
  /** The client's account the payout leaves from. Also the transaction's expected source. */
  readonly account: AccountRef;
}

/** The partner's authorization when a key holder must sign. */
export type StellarXdrAuthorization = Extract<PayoutAuthorization, { kind: 'stellar_xdr' }>;

/**
 * What the run needs when the partner returns a transaction to sign. Leave
 * it out for a partner that moves the funds itself (`authorization: none`);
 * a run without it that gets a `stellar_xdr` authorization stops with
 * {@link PayoutAuthorizationError} while the transfer is in `payout_quoted`.
 */
export interface SignedPayoutSigning {
  readonly signer: Signer;
  readonly submission: PayoutSubmission;
  /** Required for `client_submits`. */
  readonly submitter?: StellarSubmitter;
  /** The partner's account the transaction must pay (G...). */
  readonly destination: string;
  /**
   * Called once, after the partner returned a transaction to sign and the
   * quote was checked again, and before the signer. Store
   * `payout_quoted -> awaiting_signature` (reason `signed_payout_flow`) here,
   * and return the state now stored. The signer receives that state, so
   * anything but `awaiting_signature` stops the run with
   * {@link SigningNotAllowedError} before signing.
   *
   * It must be a compare-and-set: store `awaiting_signature` only if the
   * transfer is still in `payout_quoted` (e.g.
   * `UPDATE ... SET state = 'awaiting_signature' WHERE id = ? AND state = 'payout_quoted'`).
   * When nothing was updated, another run got there first: throw, and never
   * return `awaiting_signature` for a move this call did not make. That is
   * what keeps two concurrent runs from both signing.
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
  /**
   * Required for `client_submits`. Called once, after the submitter reported
   * a confirmed `success` and before `executePayout`. Store
   * `awaiting_signature -> payout_submitted` (reason `signed_and_on_chain`)
   * and the hash here: the money has moved, so the stored state must say so
   * before the partner is called.
   *
   * If it throws, the run stops with {@link PayoutIncompleteError}
   * (`stage: 'record'`) carrying `txHash` and `pending`. The money has
   * moved: store `payout_submitted`, then call {@link retryPayoutExecute}
   * with `pending`. Never re-quote and never sign again.
   */
  readonly onSubmitted?: (outcome: ConfirmedSubmitOutcome) => void | Promise<void>;
}

/** A submit outcome that is a confirmed success on the ledger. */
export type ConfirmedSubmitOutcome = Extract<SubmitOutcome, { status: 'success' }>;

export interface RunSignedPayoutInput {
  /** The partner adapter. Its `id` must be the quote's `partner`. */
  readonly adapter: Pick<PartnerAdapter, 'id' | 'preparePayout' | 'executePayout'>;
  readonly context: SignedPayoutContext;
  /**
   * The amount confirmed in the client's account for this transfer: what the
   * funding leg delivered and the chain shows. The quote's `source` must be
   * positive, in the same asset (code and issuer) and no more than this,
   * before anything is authorized; only then is it what the signer expects.
   * A partner can never pick an amount larger than the funds.
   */
  readonly funded: Money;
  /** Required when the partner may return a transaction to sign. See {@link SignedPayoutSigning}. */
  readonly signing?: SignedPayoutSigning;
  /** Clock in ms since epoch. A non-finite reading stops the run. */
  readonly now: () => number;
  /**
   * Refuse to sign or submit when no more than this is left on the quote.
   * Default {@link DEFAULT_EXPIRY_MARGIN_MS}. Must be a finite number >= 0.
   */
  readonly expiryMarginMs?: number;
  /** Key for `executePayout`. Store it before calling, and reuse it on every retry. */
  readonly idempotencyKey: string;
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
 * Where it stops, and the edge of the transition table the caller takes.
 * Every row names one rule of `TRANSITIONS`, with its reason:
 *
 * | Error | Where it stopped | Transfer is in | Caller takes |
 * |---|---|---|---|
 * | {@link QuoteExpiredError} `authorization` | before the authorization was handed over, or, with no signature needed, before the create | `payout_quoted` | `payout_quoted -> funded` (`quote_expired_before_authorization`): get a fresh quote |
 * | {@link PayoutAuthorizationError} | `preparePayout` threw, or returned an authorization the run cannot use (unknown, `stellar_xdr` without `signing`, or for an account on another chain) | `payout_quoted` | `payout_quoted -> needs_attention` (`authorization_failed`): nothing was signed |
 * | {@link PayoutIncompleteError} `create`, no `signedXdr` | the partner needed no signature and its create failed | `payout_quoted` | retry with {@link retryPayoutExecute}; if the partner never takes it, `payout_quoted -> needs_attention` (`payout_create_failed`) |
 * | {@link QuoteExpiredError} `signing` | after `onAuthorized`, before the signed transaction left | `awaiting_signature` | `awaiting_signature -> funded` (`quote_expired_before_signing`): drop any signed XDR, it was never submitted |
 * | {@link SignerRefusedError} | the signer threw, rejected or returned no signed XDR | `awaiting_signature` | `awaiting_signature -> needs_attention` (`signer_refused`): nothing was submitted |
 * | {@link PayoutIncompleteError} `submit` | the submit was not a confirmed success | `awaiting_signature` | `awaiting_signature -> needs_attention` (`submission_rejected_or_unknown`): check the hash on Stellar, never sign again |
 * | {@link PayoutIncompleteError} `record` | the transaction is on the ledger, `onSubmitted` threw | `awaiting_signature` | `awaiting_signature -> payout_submitted` (`signed_and_on_chain`): the money moved; store it, then retry with {@link retryPayoutExecute}; never re-quote |
 * | {@link PayoutIncompleteError} `create`, with `txHash` | `client_submits`: the create failed after `onSubmitted` stored the move | `payout_submitted` | retry with {@link retryPayoutExecute}; if the partner never takes it, `payout_submitted -> needs_attention` (`partner_refused_or_unknown`) |
 * | {@link PayoutIncompleteError} `create`, `signedXdr` but no `txHash` | `partner_submits`: the partner did not confirm taking the signed XDR | `awaiting_signature` | retry with {@link retryPayoutExecute}; if the partner never confirms, `awaiting_signature -> needs_attention` (`partner_submission_unknown`) |
 *
 * On success the caller takes `payout_quoted -> payout_processing`
 * (`partner_custodied_account`) for an `authorization` of `none`. For
 * `stellar_xdr` the transfer is in `payout_submitted` with `client_submits`
 * (stored by `onSubmitted`), and in `awaiting_signature` with
 * `partner_submits`, which then takes `awaiting_signature -> payout_submitted`;
 * both then take `payout_submitted -> payout_processing` once the partner
 * accepts.
 *
 * These have no edge: nothing was signed or submitted by this run, and the
 * transfer stays where it is for an operator.
 * - {@link InvalidInputError}: unusable input, before any call, with the
 *   transfer in `payout_quoted`; or a clock that breaks during the run.
 * - {@link SigningNotAllowedError}: `onAuthorized` returned a state other
 *   than `awaiting_signature`, e.g. a concurrent run already moved it.
 * - Whatever `onAuthorized` or `onSigned` throw, unchanged.
 */
export async function runSignedPayout(input: RunSignedPayoutInput): Promise<SignedPayoutResult> {
  const margin = input.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  // Read once: what submitting may take. The quote must outlive it, not just the margin.
  const submitBudget = checkInput(input, margin);
  const { adapter, context, signing } = input;
  const { quote, account, transferId } = context;
  const logger = input.logger ?? noopLogger;
  const assertFresh = (stage: QuoteExpiredStage, extraMs = 0): number =>
    assertQuoteFresh(quote, input.now(), margin + extraMs, stage);

  assertFresh('authorization');
  const auth = await authorize(adapter, context, logger);
  const base: ExecutePayoutInput = { quote, account, transferId, idempotencyKey: input.idempotencyKey };

  if (auth.kind === 'none') {
    // The partner moves the funds on create: a quote that ran out while it
    // authorized is dropped here, still in payout_quoted, never created.
    assertFresh('authorization');
    logger.info('payout needs no signature', { transferId, quoteId: quote.id });
    return execute(adapter, { body: base, idempotencyKey: input.idempotencyKey }, logger);
  }

  if (signing === undefined) {
    logger.warn('payout needs a signature but the run has no signing inputs', { transferId, quoteId: quote.id });
    throw new PayoutAuthorizationError('invalid_authorization');
  }
  if (account.chain !== 'stellar') {
    logger.warn('payout authorization is a Stellar transaction for a non-Stellar account', { transferId, quoteId: quote.id });
    throw new PayoutAuthorizationError('invalid_authorization');
  }
  const { signer } = signing;

  // Authorized but not yet handed over: the transfer is still in payout_quoted.
  // A quote that cannot outlive the submit is dropped here, before anything moves.
  assertFresh('authorization', submitBudget);
  const state = await signing.onAuthorized(auth);
  // The stored state first: a wrong state is an operator's question, whatever the clock says.
  if (state !== 'awaiting_signature') {
    throw new SigningNotAllowedError(
      `Transfer ${transferId} is in ${String(state)}, not awaiting_signature: nothing was signed`,
    );
  }
  assertFresh('signing', submitBudget);
  const signingContext = signingContextFor({ ...context, destination: signing.destination }, state);
  const signedXdr = await sign(signer, account, auth.unsignedXdr, signingContext, logger);
  logger.info('payout signed', { transferId, quoteId: quote.id, custody: signer.custody });
  await signing.onSigned?.(signedXdr);

  // Still unsubmitted: an expired quote here is safe to abandon, and the signed XDR is dropped.
  assertFresh('signing', submitBudget);

  if (signing.submission === 'client_submits') {
    const submitter = signing.submitter as StellarSubmitter;
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
    const txHash = outcome.hash;
    logger.info('payout submitted', { transferId, quoteId: quote.id, txHash });
    const pending = { body: { ...base, signedXdr, txHash }, idempotencyKey: input.idempotencyKey };
    // The money has moved: record it before the partner hears about it.
    const onSubmitted = signing.onSubmitted as NonNullable<SignedPayoutSigning['onSubmitted']>;
    try {
      await onSubmitted(outcome);
    } catch (cause) {
      logger.error('payout on chain but not recorded', { transferId, quoteId: quote.id, txHash });
      throw new PayoutIncompleteError<ExecutePayoutInput>({ stage: 'record', signedXdr, txHash, pending, cause });
    }
    return execute(adapter, pending, logger);
  }

  return execute(adapter, { body: { ...base, signedXdr }, idempotencyKey: input.idempotencyKey }, logger);
}

/**
 * Sends `executePayout` again with exactly the pending input and key. Use it
 * after {@link PayoutIncompleteError} with `stage: 'create'`, or with
 * `stage: 'record'` once `payout_submitted` is stored. Never signs or
 * submits anything.
 */
export async function retryPayoutExecute(
  adapter: Pick<PartnerAdapter, 'executePayout'>,
  pending: PendingPayout<ExecutePayoutInput>,
  logger: Logger = noopLogger,
): Promise<SignedPayoutResult> {
  checkPending(pending);
  if (typeof adapter?.executePayout !== 'function') throw new InvalidInputError('The adapter has no executePayout');
  return execute(adapter, pending, logger);
}

/**
 * The pending create must be what a run stored: a body and key that agree,
 * the transfer and the payout quote, and, when present, a signed XDR and a
 * well-formed hash. Anything else is refused before the partner is called.
 */
function checkPending(pending: unknown): asserts pending is PendingPayout<ExecutePayoutInput> {
  const fail = (what: string): never => {
    throw new InvalidInputError(`The pending payout is not usable: ${what}`);
  };
  if (typeof pending !== 'object' || pending === null) fail('it is missing');
  const { body, idempotencyKey } = pending as { body?: unknown; idempotencyKey?: unknown };
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') fail('no idempotency key');
  if (typeof body !== 'object' || body === null) fail('no body');
  const b = body as Partial<Record<keyof ExecutePayoutInput, unknown>>;
  if (b.idempotencyKey !== idempotencyKey) fail('the body and its idempotency key do not match');
  if (typeof b.transferId !== 'string' || b.transferId === '') fail('no transfer id');
  const quote = b.quote as { id?: unknown; kind?: unknown } | null | undefined;
  if (typeof quote !== 'object' || quote === null || typeof quote.id !== 'string' || quote.kind !== 'payout') {
    fail('no payout quote');
  }
  const account = b.account as { address?: unknown } | null | undefined;
  if (typeof account !== 'object' || account === null || typeof account.address !== 'string') fail('no account');
  if (b.signedXdr !== undefined && (typeof b.signedXdr !== 'string' || b.signedXdr === '')) fail('an empty signed XDR');
  if (b.txHash !== undefined && (typeof b.txHash !== 'string' || !TX_HASH_RE.test(b.txHash))) fail('a malformed hash');
  if (b.txHash !== undefined && b.signedXdr === undefined) fail('a hash without a signed XDR');
}

/**
 * The signing context the signer receives: everything it must compare with
 * the XDR, and the transfer's stored `state`, which must be
 * `awaiting_signature` for the signer to go ahead. `expected.amount` is the
 * quote's `source`; {@link runSignedPayout} checks it against the funded
 * amount before it builds this.
 */
export function signingContextFor(
  context: Omit<SignedPayoutContext, 'state'> & { readonly destination: string },
  state: TransferState,
): SigningContext {
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
 * Calls the signer once. Anything it throws or rejects with, and anything
 * but a non-empty string, becomes {@link SignerRefusedError} (cause code only).
 */
async function sign(
  signer: Signer,
  account: AccountRef,
  unsignedXdr: string,
  context: SigningContext,
  logger: Logger,
): Promise<string> {
  const ids = { transferId: context.transferId, quoteId: context.quoteId, custody: signer.custody };
  let signed: unknown;
  try {
    signed = await signer.signStellar(account, unsignedXdr, context);
  } catch (cause) {
    const error = new SignerRefusedError('threw', cause);
    logger.warn('payout signer refused', { ...ids, causeCode: error.causeCode ?? 'none' });
    throw error;
  }
  if (typeof signed !== 'string' || signed === '') {
    logger.warn('payout signer returned no transaction', ids);
    throw new SignerRefusedError('invalid_result');
  }
  return signed;
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
  // The same strict parser as the signer guard: they never disagree on a quote.
  const expiresAt = parseInstantMs(quote.expiresAt);
  if (expiresAt === undefined || expiresAt - now <= marginMs) {
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

/** Checks everything that can be checked before any call. Returns the submit budget in ms. */
function checkInput(input: RunSignedPayoutInput, margin: number): number {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
    throw new InvalidInputError('idempotencyKey is required and must be reused on every retry');
  }
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) {
    throw new InvalidInputError(`expiryMarginMs must be a finite number of ms >= 0: ${String(margin)}`);
  }
  if (typeof input.now !== 'function') {
    throw new InvalidInputError('now must be a clock function');
  }
  const { context, adapter } = input;
  if (context.state !== 'payout_quoted') {
    throw new InvalidInputError(
      `Transfer ${context.transferId} is in ${String(context.state)}: the payout runs from payout_quoted`,
    );
  }
  if (context.quote.kind !== 'payout') {
    throw new InvalidInputError(`Quote ${context.quote.id} is a ${context.quote.kind} quote, not a payout quote`);
  }
  if (typeof adapter.id !== 'string' || adapter.id === '' || context.quote.partner !== adapter.id) {
    throw new InvalidInputError(`Quote ${context.quote.id} is from ${String(context.quote.partner)}, not ${String(adapter.id)}`);
  }
  checkFunded(context.quote, input.funded);
  return input.signing === undefined ? 0 : checkSigning(input.signing);
}

/** The quote's source must be a positive amount of the funded asset, no more than the funds. */
function checkFunded(quote: LegQuote, funded: Money): void {
  if (!isMoney(funded)) throw new InvalidInputError('funded must be the amount confirmed in the account');
  if (!isMoney(quote.source)) throw new InvalidInputError(`Quote ${quote.id} has no valid source amount`);
  if (!sameAsset(quote.source.asset, funded.asset)) {
    throw new InvalidInputError(
      `Quote ${quote.id} moves ${assetKey(quote.source.asset)}, but the account was funded with ${assetKey(funded.asset)}`,
    );
  }
  if (!isPositive(quote.source)) throw new InvalidInputError(`Quote ${quote.id} moves a non-positive amount: ${quote.source.amount}`);
  if (compare(quote.source, funded) > 0) {
    throw new InvalidInputError(`Quote ${quote.id} moves ${quote.source.amount}, more than the ${funded.amount} funded`);
  }
}

function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const { amount, asset } = value as { amount?: unknown; asset?: unknown };
  return (
    typeof amount === 'string' &&
    isValidAmount(amount) &&
    typeof asset === 'object' &&
    asset !== null &&
    typeof (asset as { code?: unknown }).code === 'string'
  );
}

/** Checks the signing inputs. Returns the submitter's `maxDurationMs` for `client_submits`, else 0. */
function checkSigning(signing: SignedPayoutSigning): number {
  if (signing.submission !== 'client_submits' && signing.submission !== 'partner_submits') {
    throw new InvalidInputError(`Unknown submission mode: ${String(signing.submission)}`);
  }
  if (typeof signing.signer?.signStellar !== 'function') {
    throw new InvalidInputError('signing.signer must have signStellar');
  }
  if (typeof signing.destination !== 'string' || !isStellarAccountId(signing.destination)) {
    throw new InvalidInputError('signing.destination must be the Stellar account (G...) the transaction pays');
  }
  if (typeof signing.onAuthorized !== 'function') {
    throw new InvalidInputError('onAuthorized is required: store awaiting_signature there before signing');
  }
  if (signing.onSigned !== undefined && typeof signing.onSigned !== 'function') {
    throw new InvalidInputError('onSigned must be a function');
  }
  if (signing.submission === 'client_submits' && typeof signing.submitter?.submit !== 'function') {
    throw new InvalidInputError('client_submits needs a submitter');
  }
  const budget = signing.submission === 'client_submits' ? signing.submitter?.maxDurationMs : undefined;
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)) {
    throw new InvalidInputError(`submitter.maxDurationMs must be a finite number of ms >= 0: ${String(budget)}`);
  }
  if (signing.submission === 'client_submits' && typeof signing.onSubmitted !== 'function') {
    throw new InvalidInputError('client_submits needs onSubmitted: store payout_submitted there before the payout is created');
  }
  return budget ?? 0;
}
