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
  type LegKind,
  type LegQuote,
  type LegRef,
  type LegStatusValue,
  type PartnerAdapter,
  supportsCorridor,
} from '@vindu/grid-core';

import { fromBlindPayAmount, toBlindPayAmount } from './amounts';
import { BLINDPAY_CAPABILITIES } from './capabilities';
import { type BlindPayClient, createBlindPayClient } from './client';
import { BLINDPAY_PARTNER_ID, type BlindPayConfig } from './config';
import type { SignedTransactionField } from './stellar-payout-flow';
import type { StellarNetwork, StellarToken, Tracking } from './types';
import { assertWebhookTolerance, parseWebhookEvent, verifyWebhook } from './webhooks';

export interface BlindPayAdapterOptions {
  /** `stellar` in production, `stellar_testnet` on a development instance. */
  readonly network: StellarNetwork;
  /** `whsec_...`. Required for `parseWebhook`. */
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
  /** What goes in `signed_transaction`; UNCONFIRMED which one BlindPay expects. Default `signed_xdr`. */
  readonly signedTransactionField?: SignedTransactionField;
  /** Reuse an existing client instead of building one from the config. */
  readonly client?: BlindPayClient;
}

export interface BlindPayAdapter extends PartnerAdapter {
  readonly client: BlindPayClient;
}

const TOKENS: readonly string[] = ['USDC', 'USDB'];

export function createBlindPayAdapter(config: BlindPayConfig, options: BlindPayAdapterOptions): BlindPayAdapter {
  if (options.network !== 'stellar' && options.network !== 'stellar_testnet') {
    throw new InvalidConfigError('network must be stellar or stellar_testnet');
  }
  if (options.webhookToleranceSec !== undefined) assertWebhookTolerance(options.webhookToleranceSec);
  const client = options.client ?? createBlindPayClient(config);
  const now = config.now ?? Date.now;
  const coverFees = options.coverFees ?? false;
  const field = options.signedTransactionField ?? 'signed_xdr';
  const ref = (kind: LegKind, id: string): LegRef => ({ partner: BLINDPAY_PARTNER_ID, kind, id });

  const feeId = (leg: LegKind, spreadBps: number | undefined) => {
    const id = options.partnerFeeIdFor?.(leg, spreadBps);
    if (id === undefined && spreadBps !== undefined && spreadBps > 0) {
      throw new InvalidInputError(`No partner fee configured for a ${spreadBps} bps spread on the ${leg} leg`);
    }
    return id === undefined ? {} : { partner_fee_id: id };
  };

  return {
    id: BLINDPAY_PARTNER_ID,
    client,

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
        token: token(input.targetAsset),
        ...(input.allowedPayerTaxIds === undefined ? {} : { payer_rules: { pix_allowed_tax_ids: input.allowedPayerTaxIds } }),
        ...feeId('funding', input.spreadBps),
      });
      return legQuote('funding', res.data, input.source.asset, input.targetAsset);
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
      const corridor = { sourceCurrency: 'BRL', fundingRail: 'pix', targetCurrency: input.targetAsset.code, payoutRail: input.rail };
      if (!supportsCorridor(BLINDPAY_CAPABILITIES, 'stellar', corridor)) {
        throw new InvalidInputError(`Payout of ${input.targetAsset.code} by ${input.rail} is not supported`);
      }
      const res = await client.payoutQuotes.create({
        bank_account_id: input.beneficiaryId,
        currency_type: 'sender',
        cover_fees: coverFees,
        request_amount: toBlindPayAmount(input.source),
        network: options.network,
        token: token(input.source.asset),
        ...feeId('payout', undefined),
      });
      return legQuote('payout', res.data, input.source.asset, input.targetAsset);
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
      const resource = leg.kind === 'funding' ? await client.payins.get(leg.id) : await client.stellarPayouts.getPayout(leg.id);
      const txHash = hashOf(resource.tracking_transaction);
      return { ref: ref(leg.kind, resource.id), status: toLegStatus(resource.status), ...(txHash === undefined ? {} : { txHash }) };
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
      const txHash = hashOf(resource.tracking_transaction);
      return {
        eventId: verified.eventId,
        ref: ref(event.kind === 'payin' ? 'funding' : 'payout', resource.id),
        // The status field decides the outcome, never the event name.
        status: toLegStatus(resource.status),
        // The Svix timestamp is when the message was sent, not when the payin
        // or payout changed, so it is the delivery time. BlindPay's resource
        // carries no change time of its own, so occurredAt stays empty.
        deliveredAt: new Date(verified.timestamp * 1000).toISOString(),
        ...(txHash === undefined ? {} : { txHash }),
      };
    },
  };
}

/** BlindPay payin or payout status to core's leg status. Anything unexpected is `unknown`. */
export function toLegStatus(status: unknown): LegStatusValue {
  switch (status) {
    case 'processing':
    case 'on_hold':
    case 'completed':
    case 'failed':
    case 'refunded':
      return status;
    default:
      return 'unknown';
  }
}

function token(asset: Asset): StellarToken {
  if (!TOKENS.includes(asset.code)) throw new InvalidInputError(`Token ${asset.code} is not supported; use USDC or USDB`);
  return asset.code as StellarToken;
}

function hashOf(tracking: Tracking | undefined): string | undefined {
  const h = tracking?.transaction_hash;
  return typeof h === 'string' && h !== '' ? h : undefined;
}

function legQuote(
  kind: LegKind,
  q: { id: string; expires_at: number; sender_amount: number; receiver_amount: number },
  sourceAsset: Asset,
  targetAsset: Asset,
): LegQuote {
  if (!Number.isSafeInteger(q.expires_at)) throw new InvalidInputError('Quote has no valid expires_at');
  return {
    id: q.id,
    partner: BLINDPAY_PARTNER_ID,
    kind,
    expiresAt: new Date(q.expires_at).toISOString(),
    source: fromBlindPayAmount(q.sender_amount, sourceAsset),
    target: fromBlindPayAmount(q.receiver_amount, targetAsset),
    fees: [],
  };
}
