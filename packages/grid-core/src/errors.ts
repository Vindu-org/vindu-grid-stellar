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
  | 'partner_http'
  | 'invalid_config'
  | 'invalid_input'
  | 'webhook_rejected'
  | 'quote_expired'
  | 'payout_not_recorded';

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
 * The quote expired, or is too close to expiry, before the transaction was
 * signed or submitted. Get a fresh quote and a new transaction; never reuse
 * the old one.
 */
export class QuoteExpiredError extends GridError {
  constructor(
    readonly quoteId: string,
    readonly expiresAt: string,
  ) {
    super(
      'quote_expired',
      `Quote ${quoteId} expired at ${expiresAt}: get a fresh quote and authorize again; do not reuse the old transaction`,
    );
  }
}

/** A signer refused to sign, or was asked to sign in a state where signing is not allowed. */
export class SigningNotAllowedError extends GridError {
  constructor(message: string) {
    super('signing_not_allowed', message);
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

export interface PayoutIncompleteInit<TBody = unknown> {
  readonly stage: 'submit' | 'create';
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
 * - `stage: 'create'`: the partner call failed after the transaction was
 *   signed (and submitted, when we submit). Retry it with `pending`: the same
 *   body and the same idempotency key.
 */
export class PayoutIncompleteError<TBody = unknown> extends GridError {
  readonly stage: 'submit' | 'create';
  readonly signedXdr: string | undefined;
  readonly txHash: string | undefined;
  readonly outcome: SubmitOutcome | undefined;
  readonly pending: PendingPayout<TBody> | undefined;

  constructor(init: PayoutIncompleteInit<TBody>) {
    super(
      'payout_not_recorded',
      init.stage === 'submit'
        ? `Stellar submit ended ${init.outcome?.status ?? 'without an outcome'}: check the transaction on Stellar before anything else; do not sign again`
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
