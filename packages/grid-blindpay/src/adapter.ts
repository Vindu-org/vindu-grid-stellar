/**
 * BlindPay as a core `PartnerAdapter`, Stellar only.
 *
 * - Funding: PIX payin quote and payin; USDC (USDB on development) lands in the
 *   client's registered Stellar wallet (`account.partnerAccountId` = `bw_...`).
 * - Payout: quote on `/quotes`, `preparePayout` returns the unsigned XDR to
 *   sign, `executePayout` hands BlindPay the signed result. For the full safe
 *   sequence (expiry checks, submit, retries) use `runStellarPayout`.
 *
 * Fees: BlindPay quotes report fee amounts, but the docs do not say in which
 * currency, so `LegQuote.fees` is left empty rather than guessed. Read the raw
 * quote through `adapter.client` when you need them.
 */
import {
  type Asset,
  InvalidConfigError,
  InvalidInputError,
  isStellarAccountId,
  type LegKind,
  type LegQuote,
  type LegRef,
  type PartnerAdapter,
} from '@vindu/grid-core';

import { floorToBlindPayAmount, fromBlindPayAmount, toBlindPayAmount } from './amounts';
import { BlindPayQuoteError } from './errors';
import { BLINDPAY_CAPABILITIES } from './capabilities';
import { type BlindPayClient, createBlindPayClient } from './client';
import { BLINDPAY_PARTNER_ID, type BlindPayConfig, assertPartnerId } from './config';
import { type StablecoinIssuers, stablecoins } from './tokens';
import type { BlindPayNetwork, SignedTransactionField } from './types';
import { legAmount, legChangedAt, legTxHash, toLegStatus } from './legs';
import { assertWebhookSecret, assertWebhookTolerance, parseWebhookEvent, verifyWebhook } from './webhooks';

export interface BlindPayAdapterOptions {
  /**
   * The id this adapter answers to: `adapter.id`, `LegQuote.partner`,
   * `LegRef.partner` on refs and events, and the partner in errors and
   * `onCall` reports. Use the same id as the key of `BLINDPAY_CAPABILITIES`
   * in your capability registry. Default {@link BLINDPAY_PARTNER_ID}.
   */
  readonly partnerId?: string;
  /** `stellar` in production, `stellar_testnet` on a development instance. */
  readonly network: BlindPayNetwork;
  /**
   * Issuer (G...) of each stablecoin this adapter may move. Assets are matched
   * by code AND issuer: a quote for USDC from another issuer, or for a token
   * with no issuer here, is refused. `USDB` is accepted on `stellar_testnet`
   * only. Leg amounts are reported only for tokens listed here.
   */
  readonly assetIssuers?: StablecoinIssuers;
  /**
   * `whsec_...`. Required for `parseWebhook`. Checked when the adapter is
   * built: a malformed or short secret throws `InvalidConfigError`.
   */
  readonly webhookSecret?: string;
  readonly webhookToleranceSec?: number;
  /** Whether quotes ask BlindPay to cover fees from the amount. Default false. */
  readonly coverFees?: boolean;
  /**
   * The partner fee (`pf_...`) that carries the platform spread on a leg.
   * When a funding quote asks for `spreadBps > 0` and this returns nothing,
   * the quote is refused rather than silently priced without the spread.
   */
  readonly partnerFeeIdFor?: (leg: LegKind, spreadBps: number | undefined) => string | undefined;
  /**
   * What `executePayout` sends in `signed_transaction`. Default `signed_xdr`,
   * the signed envelope: the only form a development instance accepted
   * (2026-11-11); it refused a hash with `transaction_xdr_invalid`. With
   * `tx_hash`, the payout must be submitted by us first (`client_submits`).
   */
  readonly signedTransactionField?: SignedTransactionField;
  /**
   * The Stellar account (G...) BlindPay payouts must pay. Get it from
   * BlindPay in writing and configure it here; never read it from the
   * transaction BlindPay returns, which is what the signer checks against
   * it. `runStellarPayout` uses it when `signing.destination` is absent,
   * and refuses a `signing.destination` that differs. Checked when the
   * adapter is built: anything but a G account throws `InvalidConfigError`.
   */
  readonly payoutDestination?: string;
  /**
   * The longest quote lifetime accepted, in milliseconds: a quote whose
   * `expires_at` is more than this after now is refused with
   * `BlindPayQuoteError`, as is one already expired. Default
   * {@link DEFAULT_MAX_QUOTE_TTL_MS} (one hour). Must be a finite number > 0.
   */
  readonly maxQuoteTtlMs?: number;
  /**
   * Clock in epoch milliseconds, for quote expiries and webhook timestamps.
   * Defaults to the config's `now`, then `Date.now`. A reading that is not a
   * finite number throws `InvalidInputError`.
   */
  readonly now?: () => number;
  /** Reuse an existing client instead of building one from the config. Its `partnerId` must match. */
  readonly client?: BlindPayClient;
}

export interface BlindPayAdapter extends PartnerAdapter {
  readonly client: BlindPayClient;
  /** The `signedTransactionField` option in effect. */
  readonly signedTransactionField: SignedTransactionField;
  /** The `payoutDestination` option: the account BlindPay payouts pay, when configured. */
  readonly payoutDestination: string | undefined;
}

/** Default longest quote lifetime the adapter accepts: one hour. */
export const DEFAULT_MAX_QUOTE_TTL_MS = 3_600_000;

export function createBlindPayAdapter(config: BlindPayConfig, options: BlindPayAdapterOptions): BlindPayAdapter {
  if (options.network !== 'stellar' && options.network !== 'stellar_testnet') {
    throw new InvalidConfigError('network must be stellar or stellar_testnet');
  }
  const coins = stablecoins(options.network, options.assetIssuers);
  if (options.webhookToleranceSec !== undefined) assertWebhookTolerance(options.webhookToleranceSec);
  if (options.webhookSecret !== undefined) assertWebhookSecret(options.webhookSecret);
  const partnerId = assertPartnerId(options.partnerId ?? config.partnerId ?? BLINDPAY_PARTNER_ID);
  const client = options.client ?? createBlindPayClient({ ...config, partnerId });
  if (client.http.config.partnerId !== partnerId) {
    throw new InvalidConfigError('options.client was built with another partnerId');
  }
  const now = options.now ?? config.now ?? Date.now;
  if (typeof now !== 'function') throw new InvalidConfigError('now must be a clock function');
  const maxQuoteTtlMs = options.maxQuoteTtlMs ?? DEFAULT_MAX_QUOTE_TTL_MS;
  if (typeof maxQuoteTtlMs !== 'number' || !Number.isFinite(maxQuoteTtlMs) || maxQuoteTtlMs <= 0) {
    throw new InvalidConfigError(`maxQuoteTtlMs must be a finite number of ms > 0: ${String(maxQuoteTtlMs)}`);
  }
  /** The window a quote's `expires_at` must fall in, read from the clock now. */
  const quoteWindow = (): QuoteWindow => {
    const at: unknown = now();
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new InvalidInputError('The clock gave an invalid time: refusing to read the quote');
    }
    return { now: at, maxTtlMs: maxQuoteTtlMs };
  };
  const coverFees = options.coverFees ?? false;
  const field = options.signedTransactionField ?? 'signed_xdr';
  if (field !== 'signed_xdr' && field !== 'tx_hash') {
    throw new InvalidConfigError(`Unknown signedTransactionField: ${String(field)}`);
  }
  const payoutDestination = options.payoutDestination;
  if (payoutDestination !== undefined && (typeof payoutDestination !== 'string' || !isStellarAccountId(payoutDestination))) {
    throw new InvalidConfigError('payoutDestination must be the Stellar account (G...) BlindPay gave you for payouts');
  }
  const ref = (kind: LegKind, id: string): LegRef => ({ partner: partnerId, kind, id });

  const feeId = (leg: LegKind, spreadBps: number | undefined) => {
    if (spreadBps !== undefined && (!Number.isSafeInteger(spreadBps) || spreadBps < 0)) {
      throw new InvalidInputError(`spreadBps must be a non-negative integer number of basis points: ${spreadBps}`);
    }
    const id = options.partnerFeeIdFor?.(leg, spreadBps);
    if (id === undefined && spreadBps !== undefined && spreadBps > 0) {
      throw new InvalidInputError(`No partner fee configured for a ${spreadBps} bps spread on the ${leg} leg`);
    }
    return id === undefined ? {} : { partner_fee_id: id };
  };

  return {
    id: partnerId,
    client,
    signedTransactionField: field,
    payoutDestination,

    async quoteFunding(input) {
      if (input.rail !== 'pix') throw new InvalidInputError(`Funding rail ${input.rail} is not supported; use pix`);
      if (input.account.chain !== 'stellar') throw new InvalidInputError('BlindPay funds Stellar accounts only');
      const walletId = input.account.partnerAccountId;
      if (walletId === undefined) throw new InvalidInputError('account.partnerAccountId must be the bw_ wallet id');
      const res = await client.payinQuotes.create({
        blockchain_wallet_id: walletId,
        currency_type: 'sender',
        cover_fees: coverFees,
        request_amount: toBlindPayAmount(input.source),
        payment_method: 'pix',
        token: coins.tokenFor(input.targetAsset),
        ...(input.allowedPayerTaxIds === undefined ? {} : { payer_rules: { pix_allowed_tax_ids: input.allowedPayerTaxIds } }),
        ...feeId('funding', input.spreadBps),
      });
      return legQuote(partnerId, 'funding', res.data, input.source.asset, input.targetAsset, quoteWindow());
    },

    async createFunding(input) {
      const res = await client.payins.create({ payin_quote_id: input.quote.id }, { idempotencyKey: input.idempotencyKey });
      // BlindPay has no field for our transfer id (open question), so transferId is not sent.
      const pixCode = res.data.pix_code;
      return {
        leg: ref('funding', res.data.id),
        rail: 'pix',
        amount:
          typeof res.data.sender_amount === 'number'
            ? fromBlindPayAmount(res.data.sender_amount, input.quote.source.asset)
            : input.quote.source,
        ...(typeof pixCode === 'string' && pixCode !== '' ? { pixCode } : {}),
      };
    },

    async quotePayout(input) {
      if (input.account.chain !== 'stellar') throw new InvalidInputError('BlindPay pays out from Stellar accounts only');
      // The payout leg's own corridor: the funding side is not part of this quote.
      if (!offersPayout(input.targetAsset.code, input.rail)) {
        throw new InvalidInputError(`Payout of ${input.targetAsset.code} by ${input.rail} is not supported`);
      }
      // A funded balance can have sub-cent digits; BlindPay takes cents. Round
      // down: the rest stays in the account. The quote's source is what moves.
      const requested = floorToBlindPayAmount(input.source);
      const res = await client.payoutQuotes.create({
        bank_account_id: input.beneficiaryId,
        currency_type: 'sender',
        cover_fees: coverFees,
        request_amount: requested,
        network: options.network,
        token: coins.tokenFor(input.source.asset),
        ...feeId('payout', undefined),
      });
      // A sender quote moves exactly what was asked: never an amount BlindPay picked.
      return legQuote(partnerId, 'payout', res.data, input.source.asset, input.targetAsset, quoteWindow(), requested);
    },

    async preparePayout(input) {
      const { unsignedXdr } = await client.stellarPayouts.authorize({
        quote_id: input.quote.id,
        sender_wallet_address: input.account.address,
      });
      return { kind: 'stellar_xdr', unsignedXdr };
    },

    async executePayout(input) {
      const signed = field === 'signed_xdr' ? input.signedXdr : input.txHash;
      if (signed === undefined || signed === '') {
        throw new InvalidInputError(field === 'signed_xdr' ? 'executePayout needs signedXdr' : 'executePayout needs txHash');
      }
      const res = await client.stellarPayouts.create(
        { quote_id: input.quote.id, signed_transaction: signed, sender_wallet_address: input.account.address },
        { idempotencyKey: input.idempotencyKey },
      );
      return ref('payout', res.data.id);
    },

    async readLeg(leg) {
      if (leg.partner !== partnerId) throw new InvalidInputError(`Leg ${leg.id} belongs to ${leg.partner}, not ${partnerId}`);
      const resource = leg.kind === 'funding' ? await client.payins.get(leg.id) : await client.stellarPayouts.getPayout(leg.id);
      const amount = legAmount(leg.kind, resource, options.network, coins);
      const updatedAt = legChangedAt(resource);
      const txHash = legTxHash(leg.kind, resource);
      return {
        ref: ref(leg.kind, resource.id),
        status: toLegStatus(resource.status),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(amount === undefined ? {} : { amount }),
        ...(txHash === undefined ? {} : { txHash }),
      };
    },

    async parseWebhook(rawBody, headers) {
      if (options.webhookSecret === undefined) throw new InvalidConfigError('parseWebhook needs options.webhookSecret');
      const verified = verifyWebhook({
        rawBody,
        headers,
        secret: options.webhookSecret,
        now,
        ...(options.webhookToleranceSec === undefined ? {} : { toleranceSec: options.webhookToleranceSec }),
      });
      const event = parseWebhookEvent(rawBody);
      if (event.kind !== 'payin' && event.kind !== 'payout') return null;
      const resource = event.kind === 'payin' ? event.payin : event.payout;
      const kind: LegKind = event.kind === 'payin' ? 'funding' : 'payout';
      const amount = legAmount(kind, resource, options.network, coins);
      const occurredAt = legChangedAt(resource);
      const txHash = legTxHash(kind, resource);
      return {
        eventId: verified.eventId,
        ref: ref(kind, resource.id),
        // The status field decides the outcome, never the event name.
        status: toLegStatus(resource.status),
        ...(amount === undefined ? {} : { amount }),
        // The resource's own change time, when BlindPay gives one. Never the Svix time.
        ...(occurredAt === undefined ? {} : { occurredAt }),
        // The Svix timestamp is when the message was sent: delivery time, not for ordering.
        deliveredAt: new Date(verified.timestamp * 1000).toISOString(),
        ...(txHash === undefined ? {} : { txHash }),
      };
    },
  };
}

/** True when BlindPay pays out `currency` by `rail`. Reads own keys only. */
function offersPayout(currency: string, rail: string): boolean {
  const { offRamp } = BLINDPAY_CAPABILITIES;
  const rails = Object.hasOwn(offRamp, currency) ? offRamp[currency] : undefined;
  return Array.isArray(rails) && rails.includes(rail);
}

/** Below this, an `expires_at` is not epoch milliseconds (1e12 ms is September 2001). */
const MIN_EPOCH_MS = 1e12;

/** When the quote was read, and the longest lifetime accepted. */
interface QuoteWindow {
  readonly now: number;
  readonly maxTtlMs: number;
}

/**
 * Core's quote from BlindPay's answer. Refuses, with {@link BlindPayQuoteError}
 * and never a raw `RangeError`:
 * - a missing or empty `id`;
 * - an `expires_at` that is not epoch milliseconds (e.g. epoch seconds), is
 *   not after `now`, or is more than `maxTtlMs` after it;
 * - an amount that is not a positive safe integer;
 * - when `requestedSender` is given, a `sender_amount` that differs from it.
 */
function legQuote(
  partner: string,
  kind: LegKind,
  answer: unknown,
  sourceAsset: Asset,
  targetAsset: Asset,
  window: QuoteWindow,
  requestedSender?: number,
): LegQuote {
  const q = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>;
  const id = q['id'];
  if (typeof id !== 'string' || id === '') {
    throw new BlindPayQuoteError('id', 'The quote has no id');
  }
  const expiresAt = q['expires_at'];
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= MIN_EPOCH_MS) {
    throw new BlindPayQuoteError('expires_at', `Quote ${id} has an expires_at that is not epoch milliseconds`);
  }
  if (expiresAt <= window.now) {
    throw new BlindPayQuoteError('expires_at', `Quote ${id} has already expired`);
  }
  if (expiresAt - window.now > window.maxTtlMs) {
    throw new BlindPayQuoteError(
      'expires_at',
      `Quote ${id} expires more than ${window.maxTtlMs} ms from now: not a quote this adapter accepts`,
    );
  }
  const minor = { sender_amount: q['sender_amount'], receiver_amount: q['receiver_amount'] };
  for (const field of ['sender_amount', 'receiver_amount'] as const) {
    const value = minor[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new BlindPayQuoteError(field, `Quote ${id} has a ${field} that is not a positive integer: ${String(value)}`);
    }
  }
  const sender = minor.sender_amount as number;
  if (requestedSender !== undefined && sender !== requestedSender) {
    throw new BlindPayQuoteError(
      'sender_amount',
      `Quote ${id} moves ${sender} minor units, not the ${requestedSender} requested`,
    );
  }
  return {
    id,
    partner,
    kind,
    expiresAt: new Date(expiresAt).toISOString(),
    source: fromBlindPayAmount(sender, sourceAsset),
    target: fromBlindPayAmount(minor.receiver_amount as number, targetAsset),
    fees: [],
  };
}
