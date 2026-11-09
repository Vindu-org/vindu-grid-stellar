/**
 * Client configuration. Everything is passed in by the application: the
 * library never reads environment variables. BlindPay has no separate sandbox
 * host; the instance behind the API key decides development or production.
 */
import { InvalidConfigError, type Logger, type OnPartnerCall, noopLogger } from '@vindu/grid-core';


/** Partner id used in leg refs, errors and `onCall` reports. */
export const BLINDPAY_PARTNER_ID = 'blindpay';
export const DEFAULT_BASE_URL = 'https://api.blindpay.com';
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BlindPayConfig {
  /** Secret API key, scoped to one instance. Never logged, reported or put in errors. */
  readonly apiKey: string;
  /** Instance id, `in_...`. */
  readonly instanceId: string;
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  readonly baseUrl?: string;
  /** Defaults to the global `fetch`. Inject a mock in tests. */
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  /** Called once per HTTP call with metadata only (method, path, status, timing, ids). */
  readonly onCall?: OnPartnerCall;
  /** Per-request timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Debug only. When true, a failed call keeps a capped excerpt of BlindPay's
   * error response in `bodySnippet`. BlindPay may echo request data there, so
   * the excerpt can hold client data (names, tax ids, bank details): never
   * turn this on where errors reach logs or error trackers. Default false:
   * errors carry the status, BlindPay's error code and the idempotency key only.
   */
  readonly includeErrorBodies?: boolean;
}

/** Validated config with defaults applied. The API key stays out of it on purpose. */
export interface ResolvedConfig {
  readonly instanceId: string;
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly logger: Logger;
  readonly onCall: OnPartnerCall | undefined;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly includeErrorBodies: boolean;
}

const INSTANCE_ID_RE = /^in_[A-Za-z0-9]+$/;
// Header-safe token: rejects whitespace and control characters without echoing the value.
const API_KEY_RE = /^[\x21-\x7e]+$/;

/** Validates the config. Returns the resolved settings and the API key separately. */
export function resolveConfig(config: BlindPayConfig): { resolved: ResolvedConfig; apiKey: string } {
  if (typeof config.apiKey !== 'string' || !API_KEY_RE.test(config.apiKey)) {
    throw new InvalidConfigError('apiKey must be a non-empty string without spaces');
  }
  if (typeof config.instanceId !== 'string' || !INSTANCE_ID_RE.test(config.instanceId)) {
    throw new InvalidConfigError('instanceId must look like in_...');
  }
  const baseUrl = parseBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidConfigError('timeoutMs must be a positive integer');
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new InvalidConfigError('No fetch implementation: pass config.fetch');
  }
  return {
    apiKey: config.apiKey,
    resolved: {
      instanceId: config.instanceId,
      baseUrl,
      fetch: fetchImpl,
      logger: config.logger ?? noopLogger,
      onCall: config.onCall,
      timeoutMs,
      now: config.now ?? Date.now,
      includeErrorBodies: config.includeErrorBodies === true,
    },
  };
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidConfigError('baseUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    // Plain http would send the API key in clear text; only a local mock may use it.
    throw new InvalidConfigError('baseUrl must use https; http is allowed only for localhost, 127.0.0.0/8 or ::1');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new InvalidConfigError('baseUrl must not carry a query, fragment or credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

/** `localhost`, `127.0.0.0/8` or `::1`: the only hosts plain http may reach. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}
