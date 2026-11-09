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
   * What `executePayout` sends in `signed_transaction`; UNCONFIRMED which one
   * BlindPay expects. Default `signed_xdr`. With `tx_hash`, the payout must be
   * submitted by us first (`client_submits`).
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
  const now = config.now ?? Date.now;
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
      return legQuote(partnerId, 'funding', res.data, input.source.asset, input.targetAsset);
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
      return legQuote(partnerId, 'payout', res.data, input.source.asset, input.targetAsset, requested);
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
      const txHash = legTxHash(resource);
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
      const txHash = legTxHash(resource);
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

/**
 * Core's quote from BlindPay's answer. Refuses, with {@link BlindPayQuoteError},
 * an `expires_at` that is not epoch milliseconds (e.g. epoch seconds), an
 * amount that is not a positive integer, and, when `requestedSender` is
 * given, a `sender_amount` that differs from it.
 */
function legQuote(
  partner: string,
  kind: LegKind,
  q: { id: string; expires_at: number; sender_amount: number; receiver_amount: number },
  sourceAsset: Asset,
  targetAsset: Asset,
  requestedSender?: number,
): LegQuote {
  if (!Number.isSafeInteger(q.expires_at) || q.expires_at <= MIN_EPOCH_MS) {
    throw new BlindPayQuoteError('expires_at', `Quote ${String(q.id)} has an expires_at that is not epoch milliseconds`);
  }
  for (const field of ['sender_amount', 'receiver_amount'] as const) {
    const minor = q[field];
    if (!Number.isSafeInteger(minor) || minor <= 0) {
      throw new BlindPayQuoteError(field, `Quote ${String(q.id)} has a ${field} that is not a positive integer: ${String(minor)}`);
    }
  }
  if (requestedSender !== undefined && q.sender_amount !== requestedSender) {
    throw new BlindPayQuoteError(
      'sender_amount',
      `Quote ${String(q.id)} moves ${q.sender_amount} minor units, not the ${requestedSender} requested`,
    );
  }
  return {
    id: q.id,
    partner,
    kind,
    expiresAt: new Date(q.expires_at).toISOString(),
    source: fromBlindPayAmount(q.sender_amount, sourceAsset),
    target: fromBlindPayAmount(q.receiver_amount, targetAsset),
    fees: [],
  };
}
