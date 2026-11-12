/**
 * On-chain payments, normalised.
 *
 * Horizon reports payments in its own shape, with amounts as 7-decimal
 * strings ("10.0000000") and assets split over three fields. The read layer
 * turns each record into a {@link ChainPayment}: core assets, canonical core
 * amounts, and the direction relative to the account being followed.
 */
import { type Asset, InvalidInputError, formatAmount, parseAmount } from '@vindu/grid-core';
import type { HorizonPaymentRecord } from './horizon';

/** Operation types the read layer reports. Everything else is skipped. */
export type ChainPaymentType =
  | 'payment'
  | 'path_payment_strict_send'
  | 'path_payment_strict_receive'
  | 'create_account';

export const CHAIN_PAYMENT_TYPES: readonly ChainPaymentType[] = [
  'payment',
  'path_payment_strict_send',
  'path_payment_strict_receive',
  'create_account',
];

/** Code used for the native asset (lumens). It has no issuer. */
export const NATIVE_ASSET_CODE = 'XLM';

export interface ChainPayment {
  /** Horizon operation id. Unique per payment: use it to drop duplicate deliveries. */
  readonly id: string;
  /** Horizon paging token of the operation: a decimal string. */
  readonly pagingToken: string;
  readonly txHash: string;
  readonly type: ChainPaymentType;
  /** Relative to the followed account. `self` when it paid itself. */
  readonly direction: 'incoming' | 'outgoing' | 'self';
  readonly from: string;
  readonly to: string;
  /** Muxed id of the destination, when it was paid through a muxed (M...) address. */
  readonly toMuxedId?: string;
  /** Asset that arrived at `to`. Native lumens are `{ code: 'XLM' }`. */
  readonly asset: Asset;
  /** Amount that arrived at `to`, as a canonical core amount string ("10", not "10.0000000"). */
  readonly amount: string;
  /** Path payments only: what left `from`. */
  readonly sourceAsset?: Asset;
  readonly sourceAmount?: string;
  /** Memo of the transaction, when Horizon returned it. */
  readonly memo?: string;
  readonly memoType?: string;
  /** ISO-8601 close time of the ledger. */
  readonly createdAt: string;
}

/**
 * Normalises one Horizon record for `account`. Returns `null` when the record
 * is not a payment type this package reports, did not succeed, or does not
 * have `account` as sender or receiver.
 *
 * @throws {InvalidInputError} when the record has no string `id` or
 * `transaction_hash`, or no `paging_token` made of decimal digits, whatever
 * its type: without them it cannot be told apart from others or passed over.
 * @throws {InvalidMoneyError} when Horizon sends an amount that is not a valid decimal.
 */
export function normalisePayment(record: HorizonPaymentRecord, account: string): ChainPayment | null {
  if (!hasIdentity(record)) {
    throw new InvalidInputError('Horizon payment record without a string id, a decimal paging_token or a transaction_hash');
  }
  if (record.transaction_successful === false) return null;
  if (!isChainPaymentType(record.type)) return null;

  let from: string | undefined;
  let to: string | undefined;
  let asset: Asset | null;
  let amount: string | undefined;
  if (record.type === 'create_account') {
    from = record.funder;
    to = record.account;
    asset = { code: NATIVE_ASSET_CODE };
    amount = record.starting_balance;
  } else {
    from = record.from;
    to = record.to;
    asset = assetFromHorizon(record.asset_type, record.asset_code, record.asset_issuer);
    amount = record.amount;
  }
  if (from === undefined || to === undefined || asset === null || amount === undefined) return null;
  if (from !== account && to !== account) return null;

  const base = {
    id: record.id,
    pagingToken: record.paging_token,
    txHash: record.transaction_hash,
    type: record.type,
    direction: from === to ? 'self' : to === account ? 'incoming' : 'outgoing',
    from,
    to,
    asset,
    amount: canonical(amount),
    createdAt: record.created_at,
  } as const;

  const extra: { -readonly [K in keyof ChainPayment]?: ChainPayment[K] } = {};
  if (record.to_muxed_id !== undefined) extra.toMuxedId = record.to_muxed_id;
  if (record.type === 'path_payment_strict_send' || record.type === 'path_payment_strict_receive') {
    const sourceAsset = assetFromHorizon(record.source_asset_type, record.source_asset_code, record.source_asset_issuer);
    if (sourceAsset !== null) extra.sourceAsset = sourceAsset;
    if (record.source_amount !== undefined) extra.sourceAmount = canonical(record.source_amount);
  }
  if (record.memo !== undefined) extra.memo = record.memo;
  if (record.memo_type !== undefined) extra.memoType = record.memo_type;
  return { ...base, ...extra };
}

/** Horizon paging tokens are decimal numbers. Anything else (empty, signed, spaced) is malformed. */
export const PAGING_TOKEN = /^[0-9]+$/;

/** True when the record has the string fields that identify it and its position. */
function hasIdentity(record: unknown): boolean {
  const r = record as Partial<Record<'id' | 'paging_token' | 'transaction_hash', unknown>> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.id === 'string' &&
    typeof r.paging_token === 'string' &&
    PAGING_TOKEN.test(r.paging_token) &&
    typeof r.transaction_hash === 'string'
  );
}

function isChainPaymentType(type: string): type is ChainPaymentType {
  return (CHAIN_PAYMENT_TYPES as readonly string[]).includes(type);
}

/** Core asset from Horizon's asset fields; `null` for anything that is not native or an issued asset. */
export function assetFromHorizon(type: string | undefined, code: string | undefined, issuer: string | undefined): Asset | null {
  if (type === 'native') return { code: NATIVE_ASSET_CODE };
  if ((type === 'credit_alphanum4' || type === 'credit_alphanum12') && code !== undefined && issuer !== undefined) {
    return { code, issuer };
  }
  return null;
}

/** "10.0000000" becomes "10"; at most 7 decimals, exact. */
function canonical(amount: string): string {
  return formatAmount(parseAmount(amount));
}
