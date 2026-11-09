/**
 * Client configuration. Everything is passed in by the application: the
 * library never reads environment variables. BlindPay has no separate sandbox
 * host; the instance behind the API key decides development or production.
 */
import { type Logger, type OnPartnerCall, noopLogger } from '@vindu/grid-core';

import { InvalidConfigError } from './errors';

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
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidConfigError('baseUrl must use https (or http for a local mock)');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new InvalidConfigError('baseUrl must not carry a query, fragment or credentials');
  }
  return url.toString().replace(/\/+$/, '');
}
