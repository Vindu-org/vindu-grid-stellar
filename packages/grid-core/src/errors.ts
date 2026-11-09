/**
 * Typed errors. Every error thrown by this library extends {@link GridError}
 * and carries a stable `code`, so callers can branch on it without parsing
 * messages.
 */
import type { SubmitOutcome } from './submission';

/** Codes raised by this package. Adapters add their own through the open string. */
export type CoreErrorCode =
  | 'invalid_money'
  | 'asset_mismatch'
  | 'invalid_transition'
  | 'route_not_found'
  | 'route_immutable'
  | 'tolerance_exceeded'
  | 'signing_not_allowed'
  | 'signer_refused'
  | 'partner_http'
  | 'invalid_config'
  | 'invalid_input'
  | 'webhook_rejected'
  | 'quote_expired'
  | 'payout_authorization_failed'
  | 'payout_incomplete'
  | 'payout_interrupted';

/**
 * Every code a {@link GridError} may carry: core's own, plus any code an
 * adapter defines (e.g. a partner-specific refusal). Branch on the core codes;
 * treat any other as adapter-specific.
 */
export type GridErrorCode = CoreErrorCode | (string & {});

export class GridError extends Error {
  readonly code: GridErrorCode;

  constructor(code: GridErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** An amount string is malformed, has too many decimals or is out of range. */
export class InvalidMoneyError extends GridError {
  constructor(message: string) {
    super('invalid_money', message);
  }
}

/** Two amounts that must share an asset do not. */
export class AssetMismatchError extends GridError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super('asset_mismatch', `Asset mismatch: ${left} vs ${right}`);
  }
}

/**
 * A transfer was asked to move between two states the transition table does
 * not link, for a reason the table does not list, or without the reason a
 * pair with several rules needs.
 */
export class InvalidTransitionError extends GridError {
  /** The reason that was asked for, when one was. */
  readonly reason: string | undefined;
  /** The reasons the table allows for this pair, when one must be chosen. */
  readonly choices: readonly string[] | undefined;

  constructor(
    readonly from: string,
    readonly to: string,
    detail: { readonly reason?: string; readonly choices?: readonly string[] } = {},
  ) {
    super(
      'invalid_transition',
      detail.choices !== undefined
        ? `Transition ${from} -> ${to} needs a reason: one of ${detail.choices.join(', ')}`
        : detail.reason !== undefined
          ? `Transition not allowed: ${from} -> ${to} (${detail.reason})`
          : `Transition not allowed: ${from} -> ${to}`,
    );
    this.reason = detail.reason;
    this.choices = detail.choices;
  }
}

/** Why a routing candidate was left out. Mirrors `ExclusionReason` in routing. */
export interface RouteExclusion {
  readonly partner: string;
  readonly chain: string;
  readonly reason: string;
}

/** No candidate survived the routing filters. `excluded` says why each one was dropped. */
export class RouteNotFoundError extends GridError {
  constructor(readonly excluded: readonly RouteExclusion[]) {
    super(
      'route_not_found',
      excluded.length === 0
        ? 'No route: no candidates were given'
        : `No route: all ${excluded.length} candidate(s) were excluded`,
    );
  }
}

/** Someone tried to change the route of a transfer whose funding leg already exists. */
export class RouteImmutableError extends GridError {
  constructor(
    readonly state: string,
    readonly current: string,
    readonly proposed: string,
  ) {
    super(
      'route_immutable',
      `Route is fixed once the funding leg exists (state ${state}): ${current} cannot become ${proposed}`,
    );
  }
}

/** A payout quote is outside the price tolerance. Optional: `checkPayoutTolerance` returns a result instead. */
export class ToleranceExceededError extends GridError {
  constructor(
    readonly deviationBps: number,
    readonly toleranceBps: number,
  ) {
    super(
      'tolerance_exceeded',
      `Payout quote deviates ${deviationBps} bps from the estimate (tolerance ${toleranceBps} bps)`,
    );
  }
}

/** The configuration passed to a client or adapter is unusable. The message never echoes a secret. */
export class InvalidConfigError extends GridError {
  constructor(message: string) {
    super('invalid_config', message);
  }
}

/** An argument is malformed, e.g. an id with the wrong prefix or an amount with too much precision. */
export class InvalidInputError extends GridError {
  constructor(message: string) {
    super('invalid_input', message);
  }
}

/**
 * Where a payout run stopped on an expiring quote, which tells the caller
 * the transfer's state and the edge to take:
 * - `authorization`: before the partner's authorization was handed over, so
 *   the transfer is still in `payout_quoted`: take `payout_quoted -> funded`.
 * - `signing`: after the transfer moved to `awaiting_signature`, before the
 *   signed transaction left: take `awaiting_signature -> funded`.
 */
export type QuoteExpiredStage = 'authorization' | 'signing';

/**
 * The quote expired, or is too close to expiry, before the transaction was
 * signed or submitted. Get a fresh quote and a new transaction; never reuse
 * the old one. `stage` says how far the run got.
 */
export class QuoteExpiredError extends GridError {
  constructor(
    readonly quoteId: string,
    readonly expiresAt: string,
    readonly stage: QuoteExpiredStage,
  ) {
    super(
      'quote_expired',
      `Quote ${quoteId} expired at ${expiresAt}, before ${stage}: get a fresh quote and authorize again; do not reuse the old transaction`,
    );
  }
}

/** How the partner's authorize step failed. */
export type PayoutAuthorizationFailure = 'threw' | 'invalid_authorization';

/** Longest cause code an error keeps. */
const CAUSE_CODE_MAX = 48;
/** A lowercase snake or kebab code: `partner_http`, `payout-xdr-mismatch`. */
const CAUSE_CODE_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
/** A system error constant made of capital letters and underscores only: `ETIMEDOUT`, `UND_ERR_SOCKET`. */
const SYSTEM_CONSTANT_RE = /^[A-Z]+(?:_[A-Z]+)*$/;

/**
 * The `code` of an error, when it is safe to keep: a lowercase snake or
 * kebab code of at most 48 characters (`partner_http`). A system constant of
 * capital letters and underscores only (`ETIMEDOUT`) is kept lowercased
 * (`etimedout`). Anything else is dropped, so a secret or client data put in
 * `code` (`sk_live_SECRET123`, `Jane Doe`) never reaches an error or a log.
 * Every cause code in this library and its adapters comes from here.
 */
export function causeCodeOf(cause: unknown): string | undefined {
  const raw = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof raw !== 'string') return undefined;
  const code = SYSTEM_CONSTANT_RE.test(raw) ? raw.toLowerCase() : raw;
  return code.length <= CAUSE_CODE_MAX && CAUSE_CODE_RE.test(code) ? code : undefined;
}

/**
 * The partner's authorize step (`preparePayout`) threw, or returned an
 * authorization the flow does not know. Nothing was signed or submitted,
 * and the transfer is still in `payout_quoted`: take
 * `payout_quoted -> needs_attention`.
 *
 * It keeps the cause's `code` (e.g. `partner_http`), never its message or
 * the error itself: a partner's error text can carry client data.
 */
export class PayoutAuthorizationError extends GridError {
  readonly failure: PayoutAuthorizationFailure;
  /** The `code` of what `preparePayout` threw, as {@link causeCodeOf} keeps it. */
  readonly causeCode: string | undefined;

  constructor(failure: PayoutAuthorizationFailure, cause?: unknown) {
    const causeCode = causeCodeOf(cause);
    super(
      'payout_authorization_failed',
      failure === 'threw'
        ? `The partner's payout authorization failed (${causeCode ?? 'no code'}): nothing was signed`
        : "The partner returned a payout authorization this flow does not know: nothing was signed",
    );
    this.failure = failure;
    this.causeCode = causeCode;
  }
}

/**
 * Signing is not allowed in the transfer's stored state.
 *
 * In the payout flow it means one thing: `onAuthorized` returned a state
 * other than `awaiting_signature`. Nothing was signed, and it has no edge of
 * its own: the stored state is not what the flow expected, so an operator
 * looks first. Signers also throw it (through {@link assertSigningAllowed}
 * and their own checks) to refuse; the payout flow wraps whatever a signer
 * throws in {@link SignerRefusedError}.
 */
export class SigningNotAllowedError extends GridError {
  constructor(message: string) {
    super('signing_not_allowed', message);
  }
}

/** How the signer failed: it threw or rejected, or it returned no signed transaction. */
export type SignerRefusalKind = 'threw' | 'invalid_result';

/**
 * The signer did not return a signed transaction: it refused (a check
 * failed), it broke (e.g. a custodian timeout), or it returned something
 * that is not a signed XDR. Nothing was submitted or sent to the partner.
 * The transfer is in `awaiting_signature`: take
 * `awaiting_signature -> needs_attention` (`signer_refused`).
 *
 * It keeps the cause's `code` when {@link causeCodeOf} accepts it (e.g.
 * `signing_not_allowed`), never its message or the error itself: a signer's
 * error text can quote the transaction or client data.
 */
export class SignerRefusedError extends GridError {
  readonly failure: SignerRefusalKind;
  /** The `code` of what the signer threw, as {@link causeCodeOf} keeps it. */
  readonly causeCode: string | undefined;

  constructor(failure: SignerRefusalKind, cause?: unknown) {
    const causeCode = failure === 'threw' ? causeCodeOf(cause) : undefined;
    super(
      'signer_refused',
      failure === 'threw'
        ? `The signer refused or failed (${causeCode ?? 'no code'}): nothing was submitted`
        : 'The signer returned no signed transaction: nothing was submitted',
    );
    this.failure = failure;
    this.causeCode = causeCode;
  }
}

/**
 * A partner webhook was refused: a missing or wrong signature, a stale
 * timestamp or a body that cannot be read. Never act on its content.
 * `reason` is a short code the adapter chooses, e.g. `signature_mismatch`.
 */
export class WebhookRejectedError extends GridError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super('webhook_rejected', message);
    this.reason = reason;
  }
}

/** Longest response excerpt a {@link PartnerHttpError} keeps. */
export const PARTNER_ERROR_SNIPPET_MAX = 256;

export interface PartnerHttpErrorInit {
  readonly partner: string;
  readonly method: string;
  /** Request path without query string. */
  readonly path: string;
  /** HTTP status, or `null` when no response arrived (timeout, network error). */
  readonly status: number | null;
  /** The partner's own error code, when it sends one. */
  readonly code?: string;
  /**
   * Short excerpt of the partner's error response, capped at
   * {@link PARTNER_ERROR_SNIPPET_MAX} characters. Adapters put only the partner's
   * error message here, never request bodies, keys or client data.
   */
  readonly bodySnippet?: string;
  /**
   * Overrides the status-based default of {@link PartnerHttpError.retryable},
   * for partner-specific cases such as a 409 that means "original still running".
   */
  readonly retryable?: boolean;
  /** Wait the partner asked for (from `Retry-After`), in milliseconds. Information only. */
  readonly retryAfterMs?: number;
  /** The Idempotency-Key sent with the request, when it had one. */
  readonly idempotencyKey?: string;
  readonly cause?: unknown;
}

/** A partner API call failed. Shared shape for every adapter. */
export class PartnerHttpError extends GridError {
  readonly partner: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly partnerCode: string | undefined;
  readonly bodySnippet: string | undefined;
  /** Wait the partner asked for before a retry, in milliseconds. The library never retries on its own. */
  readonly retryAfterMs: number | undefined;
  /** The Idempotency-Key that was sent. Retry with the same key and the same body. */
  readonly idempotencyKey: string | undefined;
  private readonly retryableOverride: boolean | undefined;

  constructor(init: PartnerHttpErrorInit) {
    const status = init.status === null ? 'no response' : `HTTP ${init.status}`;
    super('partner_http', `${init.partner} ${init.method} ${init.path} failed: ${status}`, {
      cause: init.cause,
    });
    this.partner = init.partner;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.partnerCode = init.code;
    this.bodySnippet =
      init.bodySnippet === undefined ? undefined : capSnippet(init.bodySnippet);
    this.retryAfterMs = init.retryAfterMs;
    this.idempotencyKey = init.idempotencyKey;
    this.retryableOverride = init.retryable;
  }

  /**
   * True when repeating the same idempotent request is safe and useful: no
   * response, 408, 429 or 5xx, unless the adapter set `retryable` explicitly.
   */
  get retryable(): boolean {
    if (this.retryableOverride !== undefined) return this.retryableOverride;
    return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function capSnippet(text: string): string {
  return text.length <= PARTNER_ERROR_SNIPPET_MAX
    ? text
    : `${text.slice(0, PARTNER_ERROR_SNIPPET_MAX)}...`;
}

/** Everything needed to repeat the partner's payout call unchanged. */
export interface PendingPayout<TBody = unknown> {
  /** The exact request that was sent. Send it again as is. */
  readonly body: TBody;
  /** Same key on every retry, so the partner never creates a second payout. */
  readonly idempotencyKey: string;
}

/**
 * Where a payout stopped after something may have moved:
 * - `submit`: the submit did not reach a confirmed success.
 * - `record`: the submit succeeded, but storing that failed.
 * - `create`: the partner payout call failed.
 */
export type PayoutIncompleteStage = 'submit' | 'record' | 'create';

export interface PayoutIncompleteInit<TBody = unknown> {
  readonly stage: PayoutIncompleteStage;
  readonly signedXdr?: string;
  readonly txHash?: string;
  /** What the submitter reported, for `stage: 'submit'`. Absent when it threw. */
  readonly outcome?: SubmitOutcome;
  /** Undefined only when the partner body needs something not known yet (e.g. a hash). */
  readonly pending?: PendingPayout<TBody>;
  readonly cause?: unknown;
}

/**
 * A payout stopped part way, after something may have moved.
 *
 * - `stage: 'submit'`: the signed transaction did not reach a confirmed
 *   success. `outcome` says what is known. Never sign a replacement unless
 *   `canSignReplacement(outcome)` is true; with `unknown` or `rejected` the
 *   first transaction could still land. The partner payout was not created.
 * - `stage: 'record'`: the transaction is on the ledger as a success (the
 *   money has moved), but `onSubmitted` threw, so the transfer may still be
 *   stored in `awaiting_signature`. Store
 *   `awaiting_signature -> payout_submitted` (`signed_and_on_chain`) with
 *   `txHash`, then create the payout with `pending` through
 *   `retryPayoutExecute`. If the transfer is already in `payout_submitted`,
 *   `onSubmitted` stored the move before it threw: the store is done, so go
 *   straight to `retryPayoutExecute`. Never re-quote and never sign again.
 * - `stage: 'create'`: the partner's create call failed. Without a
 *   signature nothing was signed; with one, the transaction was signed, and
 *   also submitted when we submit (`txHash` is set). Retry it with
 *   `pending`: the same body and the same idempotency key.
 */
export class PayoutIncompleteError<TBody = unknown> extends GridError {
  readonly stage: PayoutIncompleteStage;
  readonly signedXdr: string | undefined;
  readonly txHash: string | undefined;
  readonly outcome: SubmitOutcome | undefined;
  readonly pending: PendingPayout<TBody> | undefined;

  constructor(init: PayoutIncompleteInit<TBody>) {
    super(
      'payout_incomplete',
      init.stage === 'submit'
        ? `Stellar submit ended ${init.outcome?.status ?? 'without an outcome'}: check the transaction on Stellar before anything else; do not sign again`
        : init.stage === 'record'
          ? 'The payout transaction is on Stellar but storing payout_submitted failed: the money has moved; store it, then retry the create with the pending body and key; never re-quote'
          : 'Payout create failed: retry it with the same body and idempotency key',
      { cause: init.cause },
    );
    this.stage = init.stage;
    this.signedXdr = init.signedXdr;
    this.txHash = init.txHash;
    this.outcome = init.outcome;
    this.pending = init.pending;
  }
}

/**
 * What a payout run was doing when it was interrupted after `onAuthorized`
 * stored `awaiting_signature`:
 * - `clock`: the clock threw or gave a time that is not a finite number;
 * - `on_signed`: the `onSigned` hook threw;
 * - `run`: anything else the run did not expect.
 */
export type PayoutInterruptedStage = 'clock' | 'on_signed' | 'run';

export interface PayoutInterruptedInit {
  readonly stage: PayoutInterruptedStage;
  /** The signed XDR, when the signer had returned one. It was never submitted by the run. */
  readonly signedXdr?: string;
  readonly cause?: unknown;
}

/**
 * A payout run stopped after the transfer moved to `awaiting_signature`, for
 * a reason that has no edge of its own: a hook threw, the clock broke, or
 * something else went wrong. Nothing was submitted or sent to the partner by
 * the run. Take `awaiting_signature -> needs_attention` (`run_interrupted`);
 * never sign again for this quote.
 *
 * `signedXdr` is set when the signer had already signed: store it with the
 * transfer so an operator can look its hash up, but never submit it.
 *
 * It keeps the cause's `code` when {@link causeCodeOf} accepts it, never its
 * message or the error itself: a hook's error text can carry client data.
 */
export class PayoutInterruptedError extends GridError {
  readonly stage: PayoutInterruptedStage;
  readonly signedXdr: string | undefined;
  /** The `code` of what interrupted the run, as {@link causeCodeOf} keeps it. */
  readonly causeCode: string | undefined;

  constructor(init: PayoutInterruptedInit) {
    const causeCode = causeCodeOf(init.cause);
    super(
      'payout_interrupted',
      `The payout run was interrupted after awaiting_signature was stored (${init.stage}, ${causeCode ?? 'no code'}): ` +
        'nothing was submitted; take awaiting_signature -> needs_attention and do not sign again',
    );
    this.stage = init.stage;
    this.signedXdr = init.signedXdr;
    this.causeCode = causeCode;
  }
}
