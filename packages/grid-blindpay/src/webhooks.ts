/**
 * BlindPay webhooks are delivered by Svix.
 *
 * Verification works on the exact raw bytes of the request body: never parse
 * and re-serialise the JSON before verifying. `svix-id` is stable across
 * retries of the same delivery, so use it to drop duplicates.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { InvalidConfigError, InvalidInputError, type WebhookHeaders, WebhookRejectedError } from '@vindu/grid-core';

import type { BlockchainWallet, Customer, Payin, Payout } from './types';

/** Why a delivery was refused. A broken setup (a bad secret) is `InvalidConfigError` instead. */
export type WebhookFailureReason =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale'
  | 'signature_mismatch'
  | 'malformed_body';

/**
 * A BlindPay webhook delivery was refused. It is core's
 * `WebhookRejectedError` (code `webhook_rejected`), so code that handles any
 * partner's webhooks can catch that, with a BlindPay-specific `reason`.
 */
export class WebhookVerificationError extends WebhookRejectedError {
  declare readonly reason: WebhookFailureReason;

  constructor(reason: WebhookFailureReason, message: string) {
    super(reason, message);
  }
}

/** Plain header record (any case) or a Fetch `Headers` object. */
export type HeaderSource = WebhookHeaders | { get(name: string): string | null };

export interface VerifyWebhookInput {
  readonly rawBody: Uint8Array | string;
  readonly headers: HeaderSource;
  /**
   * Endpoint signing secret, `whsec_<base64>` of at least 16 bytes. Anything
   * else throws {@link InvalidConfigError}: it is a setup mistake, not a bad delivery.
   */
  readonly secret: string;
  /**
   * Largest accepted gap between `svix-timestamp` and now, both directions.
   * Default 300 s. Must be a finite number of seconds above zero: anything
   * else throws {@link InvalidConfigError} rather than accept every timestamp.
   */
  readonly toleranceSec?: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. A non-finite reading throws {@link InvalidInputError}. */
  readonly now?: () => number;
}

export interface VerifiedWebhook {
  /** `svix-id`: the dedupe key. */
  readonly eventId: string;
  /** `svix-timestamp`, epoch seconds. */
  readonly timestamp: number;
}

export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;
const SECRET_PREFIX = 'whsec_';
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Svix secrets are 24 bytes or more; anything under 16 is a mistake, not a key. */
const MIN_SECRET_BYTES = 16;

/** Throws {@link InvalidConfigError} unless `toleranceSec` is a finite number above zero. */
export function assertWebhookTolerance(toleranceSec: number): void {
  if (typeof toleranceSec !== 'number' || !Number.isFinite(toleranceSec) || toleranceSec <= 0) {
    throw new InvalidConfigError(`Webhook toleranceSec must be a finite number of seconds above zero: ${String(toleranceSec)}`);
  }
}

/**
 * Throws {@link InvalidConfigError} unless `secret` is `whsec_` followed by
 * strict base64 of at least 16 bytes. The message never echoes the secret.
 */
export function assertWebhookSecret(secret: string): void {
  decodeSecret(secret);
}

/**
 * Verifies the Svix signature and timestamp. Throws {@link WebhookVerificationError}
 * on any failure of the delivery, and fails closed on a broken setup: a
 * malformed secret or an invalid tolerance throws {@link InvalidConfigError},
 * a clock that gives a non-finite time throws {@link InvalidInputError}.
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifiedWebhook {
  const tolerance = input.toleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
  assertWebhookTolerance(tolerance);
  const key = decodeSecret(input.secret);
  const nowMs = (input.now ?? Date.now)();
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new InvalidInputError('The clock gave an invalid time: refusing to verify the webhook');
  }
  const id = header(input.headers, 'svix-id');
  const ts = header(input.headers, 'svix-timestamp');
  const sig = header(input.headers, 'svix-signature');
  if (id === undefined || ts === undefined || sig === undefined) {
    throw new WebhookVerificationError('missing_headers', 'Missing svix-id, svix-timestamp or svix-signature');
  }
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError('bad_timestamp', 'svix-timestamp is not epoch seconds');
  const timestamp = Number(ts);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      'stale',
      timestamp > nowSec ? 'svix-timestamp is too far in the future' : 'svix-timestamp is too old',
    );
  }

  const raw = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : Buffer.from(input.rawBody);
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]))
    .digest();
  const matched = sig
    .split(' ')
    .filter((part) => part.startsWith('v1,') && BASE64_RE.test(part.slice(3)))
    .some((part) => {
      // Strict base64 only: Buffer.from would skip stray characters and still match.
      const candidate = Buffer.from(part.slice(3), 'base64');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
  if (!matched) throw new WebhookVerificationError('signature_mismatch', 'No v1 signature matches');
  return { eventId: id, timestamp };
}

function decodeSecret(secret: string): Buffer {
  const b64 = typeof secret === 'string' && secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : '';
  const key = BASE64_RE.test(b64) ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  // Never echo the secret.
  if (key.length < MIN_SECRET_BYTES) {
    throw new InvalidConfigError(`Webhook secret must be whsec_ followed by base64 of at least ${MIN_SECRET_BYTES} bytes`);
  }
  return key;
}

function header(headers: HeaderSource, name: string): string | undefined {
  let value: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    value = (headers as { get(n: string): string | null }).get(name);
  } else {
    const record = headers as WebhookHeaders;
    const key = Object.keys(record).find((k) => k.toLowerCase() === name);
    value = key === undefined ? undefined : record[key];
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

// Events

export type PayinEventName = 'payin.new' | 'payin.update' | 'payin.complete';
export type PayoutEventName = 'payout.new' | 'payout.update' | 'payout.complete';
export type BlockchainWalletEventName = 'blockchainWallet.new' | 'blockchainWallet.update';

/**
 * A parsed event. The docs disagree on which event fires for which outcome
 * (`payin.complete` may fire on a refund or failure; a failed payout fires
 * `payout.update`), so the resource's `status` is the only source of truth
 * for the outcome. Never infer it from the event name.
 */
export type BlindPayWebhookEvent =
  | { readonly kind: 'payin'; readonly event: PayinEventName; readonly payin: Payin }
  | { readonly kind: 'payout'; readonly event: PayoutEventName; readonly payout: Payout }
  | { readonly kind: 'customer'; readonly event: 'customer.update'; readonly customer: Customer }
  | { readonly kind: 'blockchain_wallet'; readonly event: BlockchainWalletEventName; readonly wallet: BlockchainWallet }
  | { readonly kind: 'other'; readonly event: string };

const PAYIN_EVENTS: readonly string[] = ['payin.new', 'payin.update', 'payin.complete'];
const PAYOUT_EVENTS: readonly string[] = ['payout.new', 'payout.update', 'payout.complete'];
const WALLET_EVENTS: readonly string[] = ['blockchainWallet.new', 'blockchainWallet.update'];

/**
 * Parses a verified body: `webhook_event` plus the resource's own fields at
 * the top level. Call only after {@link verifyWebhook}.
 */
export function parseWebhookEvent(rawBody: Uint8Array | string): BlindPayWebhookEvent {
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError('malformed_body', 'Webhook body is not JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new WebhookVerificationError('malformed_body', 'Webhook body is not an object');
  }
  const { webhook_event: event, ...resource } = body as Record<string, unknown>;
  if (typeof event !== 'string' || event === '') {
    throw new WebhookVerificationError('malformed_body', 'Webhook body has no webhook_event');
  }
  const needsIdAndStatus = () => {
    if (typeof resource['id'] !== 'string' || typeof resource['status'] !== 'string') {
      throw new WebhookVerificationError('malformed_body', `${event} has no id or status`);
    }
  };
  if (PAYIN_EVENTS.includes(event)) {
    needsIdAndStatus();
    return { kind: 'payin', event: event as PayinEventName, payin: resource as unknown as Payin };
  }
  if (PAYOUT_EVENTS.includes(event)) {
    needsIdAndStatus();
    return { kind: 'payout', event: event as PayoutEventName, payout: resource as unknown as Payout };
  }
  if (event === 'customer.update') return { kind: 'customer', event, customer: resource as unknown as Customer };
  if (WALLET_EVENTS.includes(event)) {
    return { kind: 'blockchain_wallet', event: event as BlockchainWalletEventName, wallet: resource as unknown as BlockchainWallet };
  }
  return { kind: 'other', event };
}
