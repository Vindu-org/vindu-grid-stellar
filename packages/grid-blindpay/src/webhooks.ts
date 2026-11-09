/**
 * BlindPay webhooks are delivered by Svix.
 *
 * Verification works on the exact raw bytes of the request body: never parse
 * and re-serialise the JSON before verifying. `svix-id` is stable across
 * retries of the same delivery, so use it to drop duplicates.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { GridError, type WebhookHeaders } from '@vindu/grid-core';

import type { BlockchainWallet, Customer, Payin, Payout } from './types';

export type WebhookFailureReason =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale'
  | 'bad_secret'
  | 'signature_mismatch'
  | 'malformed_body';

export class WebhookVerificationError extends GridError {
  constructor(readonly reason: WebhookFailureReason, message: string) {
    super('webhook_rejected', message);
  }
}

/** Plain header record (any case) or a Fetch `Headers` object. */
export type HeaderSource = WebhookHeaders | { get(name: string): string | null };

export interface VerifyWebhookInput {
  readonly rawBody: Uint8Array | string;
  readonly headers: HeaderSource;
  /** Endpoint signing secret, `whsec_<base64>`. */
  readonly secret: string;
  /** Largest accepted gap between `svix-timestamp` and now, both directions. Default 300 s. */
  readonly toleranceSec?: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
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

/** Verifies the Svix signature and timestamp. Throws {@link WebhookVerificationError} on any failure. */
export function verifyWebhook(input: VerifyWebhookInput): VerifiedWebhook {
  const id = header(input.headers, 'svix-id');
  const ts = header(input.headers, 'svix-timestamp');
  const sig = header(input.headers, 'svix-signature');
  if (id === undefined || ts === undefined || sig === undefined) {
    throw new WebhookVerificationError('missing_headers', 'Missing svix-id, svix-timestamp or svix-signature');
  }
  const key = decodeSecret(input.secret);
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError('bad_timestamp', 'svix-timestamp is not epoch seconds');
  const timestamp = Number(ts);
  const tolerance = input.toleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
  const nowSec = Math.floor((input.now ?? Date.now)() / 1000);
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
    .filter((part) => part.startsWith('v1,'))
    .some((part) => {
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
  if (key.length === 0) throw new WebhookVerificationError('bad_secret', 'Webhook secret must be whsec_ followed by base64');
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
