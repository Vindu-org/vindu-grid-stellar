/**
 * BlindPay request and response types, Stellar scope only. Field names follow
 * the API (snake_case). Amounts are integers in minor units (see `amounts.ts`).
 * Response fields the docs do not list are left out; fields the docs show but
 * whose presence is not guaranteed are optional.
 */

/** BlindPay's network names in scope: `stellar` in production, `stellar_testnet` in development. */
export type BlindPayNetwork = 'stellar' | 'stellar_testnet';

/** `USDC` on Stellar mainnet; `USDB` is BlindPay's development token. */
export type StellarToken = 'USDC' | 'USDB';

/** Payin and payout status. `completed`, `failed` and `refunded` are terminal. */
export type TransferStatus = 'processing' | 'on_hold' | 'completed' | 'failed' | 'refunded';

export const BLINDPAY_TERMINAL_STATUSES: readonly TransferStatus[] = ['completed', 'failed', 'refunded'];

export type TrackingStep = 'processing' | 'on_hold' | 'pending_review' | 'pending_refund_review' | 'completed';

export interface Tracking {
  readonly step?: TrackingStep;
  readonly status?: string | null;
  readonly transaction_hash?: string | null;
  readonly completed_at?: string | null;
}

/**
 * Payin quote: `sender` = the fiat the payer sends, `receiver` = the stablecoin
 * received. Payout quote: reversed, `sender` = stablecoin sent, `receiver` = fiat.
 */
export type CurrencyType = 'sender' | 'receiver';

/** Pagination params. With any of them set, list responses are wrapped in `{ data, pagination }`. */
export interface ListParams {
  readonly limit?: number;
  readonly starting_after?: string;
  readonly ending_before?: string;
}

export interface Pagination {
  readonly has_more: boolean;
  readonly next_page?: string | null;
  readonly prev_page?: string | null;
}

/** A list, normalised: BlindPay returns a bare array when no pagination param is sent. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly pagination?: Pagination;
}

// Customers (re_)

export type CustomerType = 'individual' | 'business';
export type KycType = 'standard' | 'enhanced';
export type KycStatus =
  | 'verifying'
  | 'approved'
  | 'rejected'
  | 'deprecated'
  | 'pending_review'
  | 'awaiting_contract'
  | 'compliance_request'
  | 'approved_rfi';

interface CustomerCommonFields {
  readonly tos_id: string;
  readonly kyc_type: KycType;
  readonly email: string;
  readonly tax_id: string;
  readonly address_line_1: string;
  readonly address_line_2?: string;
  readonly city: string;
  readonly state_province_region: string;
  /** ISO 3166-1 alpha-2, e.g. `BR`. */
  readonly country: string;
  readonly postal_code: string;
  readonly phone_number?: string;
  readonly ip_address?: string;
}

export interface CreateBusinessCustomerRequest extends CustomerCommonFields {
  readonly type: 'business';
  readonly legal_name: string;
  readonly alternate_name?: string;
  /** Date as BlindPay expects it, e.g. `2020-01-31`. */
  readonly formation_date: string;
  readonly website?: string;
  /** Beneficial owners. Their field list is not in the docs read so far; passed through as given. */
  readonly owners: readonly Readonly<Record<string, unknown>>[];
  readonly incorporation_doc_file: string;
  readonly proof_of_ownership_doc_file: string;
  readonly proof_of_address_doc_type: string;
  readonly proof_of_address_doc_file: string;
}

export interface CreateIndividualCustomerRequest extends CustomerCommonFields {
  readonly type: 'individual';
  /**
   * Individual-only fields (names, birth date, documents). The docs read so far
   * do not list them, so they are passed through as given.
   */
  readonly extra_fields?: Readonly<Record<string, unknown>>;
}

export type CreateCustomerRequest = CreateBusinessCustomerRequest | CreateIndividualCustomerRequest;

export interface Customer {
  readonly id: string;
  readonly type?: CustomerType;
  readonly kyc_status: KycStatus;
  readonly is_tos_accepted?: boolean;
  readonly kyc_warnings?: unknown;
  readonly fraud_warnings?: unknown;
  readonly country?: string;
}

export interface CustomerLimits {
  readonly success: boolean;
  /** Remaining amounts in USD cents. */
  readonly limits: {
    readonly payin: { readonly daily: number; readonly monthly: number };
    readonly payout: { readonly daily: number; readonly monthly: number };
  };
}

// Blockchain wallets (bw_)

export interface BlockchainWallet {
  readonly id: string;
  readonly name: string;
  readonly network: BlindPayNetwork;
  readonly is_account_abstraction: boolean;
  readonly address: string;
  /** `null` until answered. Saved once; cannot be changed afterwards. */
  readonly is_self_custody: boolean | null;
}

// Payin quotes and payins (qu_, pi_)

export interface PayerRules {
  /** Only these tax ids may pay the PIX. */
  readonly pix_allowed_tax_ids: readonly string[];
}

export interface CreatePayinQuoteRequest {
  readonly blockchain_wallet_id: string;
  readonly currency_type: CurrencyType;
  readonly cover_fees: boolean;
  /** Minor units of the side chosen by `currency_type`. */
  readonly request_amount: number;
  readonly payment_method: 'pix';
  readonly token: StellarToken;
  readonly payer_rules?: PayerRules;
  readonly partner_fee_id?: string;
}

interface QuoteAmounts {
  readonly id: string;
  /** Epoch milliseconds. Quotes last about 5 minutes. */
  readonly expires_at: number;
  readonly sender_amount: number;
  readonly receiver_amount: number;
  readonly commercial_quotation?: number;
  readonly blindpay_quotation?: number;
  readonly flat_fee?: number;
  readonly partner_fee_amount?: number;
  readonly billing_fee_amount?: number;
}

export interface PayinQuote extends QuoteAmounts {
  readonly is_otc?: boolean;
}

/**
 * Fields BlindPay may send on a payin or payout that the docs read so far do
 * not list. UNCONFIRMED: used when present, never required.
 */
interface UnconfirmedLegFields {
  /** The stablecoin moved, e.g. `USDC`. */
  readonly token?: string;
  readonly network?: string;
  /** ISO-8601 instant of the last change. */
  readonly updated_at?: string;
  readonly created_at?: string;
}

export interface Payin extends UnconfirmedLegFields {
  readonly id: string;
  readonly status: TransferStatus;
  readonly customer_id?: string;
  readonly payment_method?: string;
  readonly sender_amount?: number;
  readonly receiver_amount?: number;
  readonly partner_fee?: number;
  readonly billing_fee_amount?: number;
  readonly transaction_fee_amount?: number;
  /** PIX copy-and-paste code. The literal `<development>` on development instances. */
  readonly pix_code?: string | null;
  readonly memo_code?: string | null;
  readonly tracking_transaction?: Tracking;
  readonly tracking_payment?: Tracking;
  readonly tracking_complete?: Tracking;
}

// Payout quotes and payouts (qu_, po_)

export interface CreatePayoutQuoteRequest {
  readonly bank_account_id: string;
  readonly currency_type: CurrencyType;
  readonly cover_fees: boolean;
  readonly request_amount: number;
  readonly network: BlindPayNetwork;
  readonly token: StellarToken;
  readonly partner_fee_id?: string;
}

export interface PayoutQuote extends QuoteAmounts {
  /** `null` on Stellar. */
  readonly contract?: unknown;
}

export interface AuthorizeStellarPayoutRequest {
  readonly quote_id: string;
  readonly sender_wallet_address: string;
}

/**
 * What goes in `signed_transaction` when creating a Stellar payout: the signed
 * XDR envelope (`signed_xdr`) or the Stellar transaction hash (`tx_hash`).
 * UNCONFIRMED which one BlindPay expects, so it is an adapter option.
 */
export type SignedTransactionField = 'signed_xdr' | 'tx_hash';

export interface CreateStellarPayoutRequest {
  readonly quote_id: string;
  /**
   * What goes here (signed XDR envelope or Stellar transaction hash) is
   * UNCONFIRMED. See {@link SignedTransactionField}.
   */
  readonly signed_transaction: string;
  readonly sender_wallet_address: string;
}

/**
 * Response shape assumed to match a payout (UNCONFIRMED for the Stellar create
 * call). As on a payout quote, `sender` is the stablecoin and `receiver` the fiat.
 */
export interface Payout extends UnconfirmedLegFields {
  readonly id: string;
  readonly status: TransferStatus;
  /** Stablecoin taken from the wallet, minor units. */
  readonly sender_amount?: number;
  /** Fiat delivered to the bank account, minor units. */
  readonly receiver_amount?: number;
  readonly sender_wallet_address?: string;
  readonly customer_id?: string;
  readonly bank_account_id?: string;
  readonly partner_fee?: number;
  readonly billing_fee_amount?: number;
  readonly tracking_transaction?: Tracking;
  readonly tracking_payment?: Tracking;
  readonly tracking_complete?: Tracking;
}

// Partner fees (pf_)

export interface CreatePartnerFeeRequest {
  readonly name: string;
  /** Basis points. */
  readonly payin_percentage_fee: number;
  /** Minor units. */
  readonly payin_flat_fee: number;
  /** Basis points. */
  readonly payout_percentage_fee: number;
  /** Minor units. */
  readonly payout_flat_fee: number;
}

export interface PartnerFee extends CreatePartnerFeeRequest {
  readonly id: string;
}
