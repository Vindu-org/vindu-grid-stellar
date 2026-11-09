/**
 * Typed errors. Every error thrown by this library extends {@link GridError}
 * and carries a stable `code`, so callers can branch on it without parsing
 * messages.
 */

export type GridErrorCode =
  | 'invalid_money'
  | 'asset_mismatch'
  | 'invalid_transition'
  | 'route_not_found'
  | 'route_immutable'
  | 'tolerance_exceeded'
  | 'signing_not_allowed'
  | 'partner_http';

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

/** A transfer was asked to move between two states the transition table does not link. */
export class InvalidTransitionError extends GridError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super('invalid_transition', `Transition not allowed: ${from} -> ${to}`);
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
  }

  /** True for statuses where repeating the same idempotent request is safe and useful. */
  get retryable(): boolean {
    return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function capSnippet(text: string): string {
  return text.length <= PARTNER_ERROR_SNIPPET_MAX
    ? text
    : `${text.slice(0, PARTNER_ERROR_SNIPPET_MAX)}...`;
}
