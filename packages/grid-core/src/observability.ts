/**
 * Observability hooks.
 *
 * The library logs through a {@link Logger} the application passes in, and
 * reports each partner call through an optional `onCall` hook. Neither ever
 * carries API keys, signing material, or request and response bodies.
 */
import type { PartnerId } from './ports';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Discards everything. The default when no logger is given. */
export const noopLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/**
 * One partner API call, as reported to `onCall`. Metadata only: never keys,
 * headers, or request and response bodies.
 */
export interface PartnerCall {
  readonly partner: PartnerId;
  /** HTTP method, e.g. `'POST'`. */
  readonly method: string;
  /** Request path without query string or host, e.g. `/v1/instances/{id}/payouts`. */
  readonly path: string;
  /** HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  readonly durationMs: number;
  /** Non-secret ids that help correlate the call: transfer, quote, payout, request id. */
  readonly ids?: Readonly<Record<string, string>>;
  /** Failure kind when no response arrived, e.g. `'timeout'` or `'network'`. */
  readonly error?: string;
}

export type OnPartnerCall = (call: PartnerCall) => void;

/**
 * Calls `onCall` and swallows anything it throws, so a broken hook never
 * breaks a payment flow. The hook failure is logged without the call payload.
 */
export function reportPartnerCall(
  onCall: OnPartnerCall | undefined,
  call: PartnerCall,
  logger: Logger = noopLogger,
): void {
  if (onCall === undefined) return;
  try {
    onCall(call);
  } catch (e) {
    logger.warn('onCall hook threw', {
      partner: call.partner,
      method: call.method,
      error: e instanceof Error ? e.name : typeof e,
    });
  }
}
