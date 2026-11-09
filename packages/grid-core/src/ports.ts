/**
 * The partner adapter port.
 *
 * Every partner client implements {@link PartnerAdapter}. The transfer engine
 * only talks to this interface, so a new partner is a new adapter, never a
 * change to the engine. Money crosses the port as decimal strings with an
 * explicit asset; each adapter converts to its partner's own units.
 *
 * Adapters take credentials and base URLs as constructor arguments and never
 * read the environment.
 */
import type { Asset } from './assets';
import type { Money } from './money';

/** A partner's id, chosen by the application, e.g. `'blindpay'`. */
export type PartnerId = string;

/** Settlement chain. Stellar is the default rail; other chains are plain strings. */
export type Chain = 'stellar' | (string & {});

export type LegKind = 'funding' | 'payout';

/** How a client pays the funding leg. */
export type FundingRail = 'pix' | (string & {});

/** How a payout reaches the beneficiary. */
export type OffRampRail = 'wire' | 'ach' | 'rtp' | 'swift' | 'sepa' | 'spei' | 'pix' | (string & {});

/** A client account that holds the stablecoin between the two legs. */
export interface AccountRef {
  readonly chain: Chain;
  /** On-chain address, e.g. a Stellar G... account. */
  readonly address: string;
  /** The partner's own id for this account, when it registers one. */
  readonly partnerAccountId?: string;
}

export interface Fee {
  /** Who charges it, e.g. `'partner'`, `'network'`, `'platform'`. */
  readonly kind: 'partner' | 'network' | 'platform' | (string & {});
  readonly amount: Money;
}

/** A partner quote for one leg. */
export interface LegQuote {
  readonly id: string;
  readonly partner: PartnerId;
  readonly kind: LegKind;
  /** ISO-8601 instant after which the quote can no longer be used. */
  readonly expiresAt: string;
  /** What the client pays into the leg. */
  readonly source: Money;
  /** What the leg delivers. */
  readonly target: Money;
  readonly fees: readonly Fee[];
}

/** Reference to a leg created at a partner. */
export interface LegRef {
  readonly partner: PartnerId;
  readonly kind: LegKind;
  /** The partner's id for the payin or payout. */
  readonly id: string;
}

export interface FundingQuoteInput {
  /** The partner's id for the customer. */
  readonly customerId: string;
  /** Account the stablecoin lands in. */
  readonly account: AccountRef;
  /** Amount the client pays, e.g. BRL by PIX. */
  readonly source: Money;
  /** Asset the leg delivers, e.g. USDC. */
  readonly targetAsset: Asset;
  readonly rail: FundingRail;
  /** Platform spread on the funding leg, in basis points. It is locked with this quote. */
  readonly spreadBps?: number;
  /**
   * Tax ids allowed to pay the funding leg, for partners that can restrict the
   * payer (e.g. a PIX payment must come from the client's own account).
   */
  readonly allowedPayerTaxIds?: readonly string[];
}

export interface CreateFundingInput {
  readonly quote: LegQuote;
  readonly customerId: string;
  readonly account: AccountRef;
  /** The application's transfer id, sent as the partner's external reference where supported. */
  readonly transferId: string;
  /** Same key on every retry of this call, so a timeout never creates a duplicate. */
  readonly idempotencyKey: string;
}

/** How the client pays the funding leg. */
export interface FundingInstructions {
  readonly leg: LegRef;
  readonly rail: FundingRail;
  readonly amount: Money;
  /** PIX copy-and-paste code, for `rail: 'pix'`. */
  readonly pixCode?: string;
  /** ISO-8601 instant after which the instructions should not be paid. */
  readonly expiresAt?: string;
}

export interface PayoutQuoteInput {
  readonly customerId: string;
  /** Account the stablecoin leaves from. */
  readonly account: AccountRef;
  /** Stablecoin amount to pay out, e.g. USDC. */
  readonly source: Money;
  /** Currency delivered to the beneficiary, e.g. USD. */
  readonly targetAsset: Asset;
  readonly rail: OffRampRail;
  /** The partner's id for the beneficiary bank account. */
  readonly beneficiaryId: string;
}

export interface PreparePayoutInput {
  readonly quote: LegQuote;
  readonly account: AccountRef;
  readonly transferId: string;
}

/**
 * What the payout needs before it can run. `none` when the partner moves the
 * funds from a partner-custodied account on its own; `stellar_xdr` when a key
 * holder must sign an unsigned Stellar transaction first.
 */
export type PayoutAuthorization =
  | { readonly kind: 'none' }
  | { readonly kind: 'stellar_xdr'; readonly unsignedXdr: string };

export interface ExecutePayoutInput {
  readonly quote: LegQuote;
  readonly account: AccountRef;
  readonly transferId: string;
  /** Same key on every retry of this call. */
  readonly idempotencyKey: string;
  /** Signed XDR, for the signed payout flow. */
  readonly signedXdr?: string;
  /**
   * Hash of the submitted Stellar transaction, when the caller submitted it.
   * Set only after the submitter reported `success`: a payout is never
   * created for a transaction that is not confirmed on the ledger.
   */
  readonly txHash?: string;
}

/** Partner-side status of a leg, normalised. */
export type LegStatusValue =
  | 'pending'
  | 'processing'
  | 'on_hold'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'unknown';

export interface LegStatus {
  readonly ref: LegRef;
  readonly status: LegStatusValue;
  /** ISO-8601 instant of the partner's last update. */
  readonly updatedAt?: string;
  /**
   * Amount the partner reports for the leg, in the asset it moved: the
   * stablecoin delivered on a funding leg, the stablecoin taken on a payout.
   * Compare it with what the chain shows before treating a funding leg as
   * funded. Absent when the partner does not report one.
   */
  readonly amount?: Money;
  /** On-chain transaction hash, when the leg touched a chain. */
  readonly txHash?: string;
}

/** A verified partner webhook, normalised to a leg status change. */
export interface LegEvent {
  /** The partner's event id. Use it to drop duplicate deliveries. */
  readonly eventId: string;
  readonly ref: LegRef;
  readonly status: LegStatusValue;
  /** Amount the partner reports for the leg, as in {@link LegStatus.amount}. */
  readonly amount?: Money;
  /**
   * ISO-8601 instant the partner gives for the change on the resource itself.
   * Absent when the partner sends none. Use it to order events.
   */
  readonly occurredAt?: string;
  /**
   * ISO-8601 instant the webhook was sent or delivered. Retries and
   * redeliveries change it, so it is for logs and replay windows only:
   * never order events by it.
   */
  readonly deliveredAt?: string;
  readonly txHash?: string;
}

export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface PartnerAdapter {
  readonly id: PartnerId;
  quoteFunding(input: FundingQuoteInput): Promise<LegQuote>;
  createFunding(input: CreateFundingInput): Promise<FundingInstructions>;
  quotePayout(input: PayoutQuoteInput): Promise<LegQuote>;
  /** `none` for partner-custodied accounts; an unsigned XDR for the signed payout flow. */
  preparePayout(input: PreparePayoutInput): Promise<PayoutAuthorization>;
  executePayout(input: ExecutePayoutInput): Promise<LegRef>;
  readLeg(ref: LegRef): Promise<LegStatus>;
  /**
   * Verifies the webhook signature over the exact raw body and resolves with
   * the event, or `null` for event types the adapter does not track. Rejects
   * when the signature is missing, wrong or stale. Asynchronous so an adapter
   * can verify with async crypto or fetch a signing key.
   */
  parseWebhook(rawBody: Uint8Array | string, headers: WebhookHeaders): Promise<LegEvent | null>;
}
