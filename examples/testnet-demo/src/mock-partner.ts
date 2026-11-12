/**
 * Mock partners for the demo. Both implement core's `PartnerAdapter`, the
 * same interface a real partner client such as `@vindu/grid-blindpay`
 * implements, and keep their legs in memory.
 *
 * - `mock-partner` settles on Stellar with external accounts: the client's
 *   own Stellar account receives the stablecoin, and a key holder signs the
 *   payout. Its treasury key is a throwaway key made for the demo run.
 * - `mock-offchain` has no Stellar support. It quotes a slightly better price,
 *   so routing shows that the Stellar route still wins by priority.
 *
 * The `simulate*` methods stand in for things that happen outside the
 * application: the client paying the PIX, the partner settling, the fiat
 * reaching the beneficiary. `refuseNextAuthorization` makes the partner's
 * authorize step fail once, to show that failure edge.
 */
import {
  type AccountRef,
  type Asset,
  type Chain,
  type CreateFundingInput,
  type ExecutePayoutInput,
  type FundingInstructions,
  type FundingQuoteInput,
  GridError,
  type LegKind,
  type LegQuote,
  type LegRef,
  type LegStatus,
  type LegStatusValue,
  type Money,
  type PartnerAdapter,
  type PartnerCapabilities,
  type PartnerId,
  type PayoutAuthorization,
  type PayoutQuoteInput,
  type PreparePayoutInput,
  type RoutePrice,
  equals,
  fromUnits,
  toUnits,
} from '@vindu/grid-core';
import { type SubmitResult, submitSignedTransaction } from '@vindu/grid-stellar';

import type { FakeHorizon } from './fake-horizon';
import { type StellarSdk, TransactionBuilder } from './sdk';
import { buildPaymentXdr, decodePayment } from './stellar-tx';

/** Capabilities as data, the way an application registers them for routing. */
export const MOCK_PARTNER_CAPABILITIES: PartnerCapabilities = {
  chains: ['stellar'],
  accounts: { stellar: 'external' },
  onRamp: { BRL: ['pix'] },
  offRamp: { USD: ['wire', 'ach'] },
};

/** Same rails, but no Stellar: it settles on its own books. */
export const MOCK_OFFCHAIN_CAPABILITIES: PartnerCapabilities = {
  chains: ['offchain'],
  accounts: { offchain: 'partner_managed' },
  onRamp: { BRL: ['pix'] },
  offRamp: { USD: ['wire', 'ach'] },
};

const QUOTE_TTL_MS = 5 * 60 * 1000;
const SCALE = 10_000_000n;

export interface MockStellarSettings {
  readonly ledger: FakeHorizon;
  readonly networkPassphrase: string;
  /** Sends the funding stablecoin and receives the payout stablecoin. */
  readonly treasury: StellarSdk.Keypair;
}

export interface MockPartnerOptions {
  readonly id: PartnerId;
  readonly chain: Chain;
  readonly capabilities: PartnerCapabilities;
  /** BRL the client pays per unit of stablecoin. */
  readonly brlPerUsdc: string;
  /** USD the beneficiary gets per unit of stablecoin, as shown when the client confirms. */
  readonly usdPerUsdc: string;
  /** Rate the payout quote gives later, once the market has moved. Defaults to `usdPerUsdc`. */
  readonly payoutUsdPerUsdc?: string;
  readonly now: () => number;
  /** Required when `chain` is `stellar`. */
  readonly stellar?: MockStellarSettings;
}

interface Leg {
  readonly ref: LegRef;
  readonly quote: LegQuote;
  readonly account: AccountRef;
  status: LegStatusValue;
  txHash?: string;
}

export class MockPartner implements PartnerAdapter {
  readonly id: PartnerId;
  private readonly legs = new Map<string, Leg>();
  private readonly quotes = new Map<string, LegQuote>();
  private readonly counters = new Map<string, number>();
  private refuseAuthorization = false;

  constructor(private readonly options: MockPartnerOptions) {
    this.id = options.id;
    if (options.chain === 'stellar' && options.stellar === undefined) {
      throw new TypeError('A Stellar mock partner needs stellar settings');
    }
  }

  /** The partner's Stellar treasury account (G...). */
  get treasuryAddress(): string {
    return this.stellar().treasury.publicKey();
  }

  /** All-in indicative price for routing: what `source` BRL buys at the beneficiary. */
  indicativePrice(source: Money, targetAsset: Asset): RoutePrice {
    const usdc = divide(source, this.options.brlPerUsdc, targetAsset);
    return { source, target: multiply(usdc, this.options.usdPerUsdc, targetAsset) };
  }

  async quoteFunding(input: FundingQuoteInput): Promise<LegQuote> {
    if (input.rail !== 'pix') throw new GridError('invalid_input', `${this.id} funds by PIX only`);
    this.assertChain(input.account);
    const target = divide(input.source, this.options.brlPerUsdc, input.targetAsset);
    return this.quote('funding', input.source, target);
  }

  async createFunding(input: CreateFundingInput): Promise<FundingInstructions> {
    const quote = this.liveQuote(input.quote.id);
    const leg = this.addLeg('funding', quote, input.account);
    return {
      leg: leg.ref,
      rail: 'pix',
      amount: quote.source,
      pixCode: fakePixCode(this.id, quote.source.amount),
      expiresAt: quote.expiresAt,
    };
  }

  async quotePayout(input: PayoutQuoteInput): Promise<LegQuote> {
    this.assertChain(input.account);
    const rails = this.options.capabilities.offRamp[input.targetAsset.code] ?? [];
    if (!rails.includes(input.rail)) throw new GridError('invalid_input', `${this.id} has no ${input.rail} payout`);
    const rate = this.options.payoutUsdPerUsdc ?? this.options.usdPerUsdc;
    return this.quote('payout', input.source, multiply(input.source, rate, input.targetAsset));
  }

  async preparePayout(input: PreparePayoutInput): Promise<PayoutAuthorization> {
    if (this.refuseAuthorization) {
      this.refuseAuthorization = false;
      throw new GridError('authorization_refused', `${this.id} refused to authorize payout of quote ${input.quote.id}`);
    }
    const quote = this.liveQuote(input.quote.id);
    if (this.options.chain !== 'stellar') return { kind: 'none' };
    const { ledger, networkPassphrase } = this.stellar();
    const account = await ledger.account(input.account.address);
    if (account === null) throw new GridError('invalid_input', 'The client account does not exist');
    // Like a real partner, return an unsigned transaction that pays the
    // quoted stablecoin to the partner, with the quote id as memo.
    const unsignedXdr = buildPaymentXdr({
      source: input.account.address,
      sequence: account.sequence,
      destination: this.treasuryAddress,
      amount: quote.source,
      maxTime: Math.floor(Date.parse(quote.expiresAt) / 1000),
      memo: quote.id,
      networkPassphrase,
    });
    return { kind: 'stellar_xdr', unsignedXdr };
  }

  async executePayout(input: ExecutePayoutInput): Promise<LegRef> {
    const quote = this.liveQuote(input.quote.id);
    if (this.options.chain === 'stellar') await this.checkPayoutOnChain(quote, input);
    const leg = this.addLeg('payout', quote, input.account);
    leg.status = 'processing';
    if (input.txHash !== undefined) leg.txHash = input.txHash;
    return leg.ref;
  }

  async readLeg(ref: LegRef): Promise<LegStatus> {
    const leg = this.leg(ref.id);
    return {
      ref: leg.ref,
      status: leg.status,
      updatedAt: new Date(this.options.now()).toISOString(),
      ...(leg.status === 'completed' ? { amount: leg.quote.target } : {}),
      ...(leg.txHash === undefined ? {} : { txHash: leg.txHash }),
    };
  }

  async parseWebhook(): Promise<never> {
    throw new GridError('webhook_rejected', `${this.id} sends no webhooks; read legs with readLeg`);
  }

  /** The next `preparePayout` throws, as a partner that refuses to authorize would. */
  refuseNextAuthorization(): void {
    this.refuseAuthorization = true;
  }

  /** The client paid the PIX: the partner starts processing the funding leg. */
  simulatePixPaid(legId: string): void {
    this.leg(legId).status = 'processing';
  }

  /**
   * The partner settles the funding leg: it sends the stablecoin from its
   * treasury to the client's account, through the same submitter the
   * application uses.
   */
  async simulateFundingSettled(legId: string): Promise<SubmitResult> {
    const leg = this.leg(legId);
    const { ledger, networkPassphrase, treasury } = this.stellar();
    const account = await ledger.account(treasury.publicKey());
    if (account === null) throw new Error('Treasury account missing from the ledger');
    const tx = TransactionBuilder.fromXDR(
      buildPaymentXdr({
        source: treasury.publicKey(),
        sequence: account.sequence,
        destination: leg.account.address,
        amount: leg.quote.target,
        maxTime: Math.floor(this.options.now() / 1000) + 300,
        networkPassphrase,
      }),
      networkPassphrase,
    );
    tx.sign(treasury);
    const result = await submitSignedTransaction({
      gateway: ledger,
      signedXdr: tx.toXDR(),
      networkPassphrase,
      now: this.options.now,
    });
    if (result.status === 'success') {
      leg.status = 'completed';
      leg.txHash = result.hash;
    }
    return result;
  }

  /** The beneficiary's bank received the fiat. */
  simulateFiatLanded(legId: string): void {
    this.leg(legId).status = 'completed';
  }

  /** A partner re-validates the signed transaction and checks it landed before it pays out. */
  private async checkPayoutOnChain(quote: LegQuote, input: ExecutePayoutInput): Promise<void> {
    if (input.signedXdr === undefined || input.txHash === undefined) {
      throw new GridError('invalid_input', `${this.id} needs the signed transaction and its hash`);
    }
    const { ledger, networkPassphrase } = this.stellar();
    const tx = decodePayment(input.signedXdr, networkPassphrase);
    if (tx.hash !== input.txHash) throw new GridError('invalid_input', 'txHash does not match the signed transaction');
    if (tx.destination !== this.treasuryAddress || !equals(tx.amount, quote.source) || tx.memo !== quote.id) {
      throw new GridError('invalid_input', 'The signed transaction does not match the quote');
    }
    const found = await ledger.transaction(tx.hash);
    if (!found.found || !found.successful) throw new GridError('invalid_input', 'The transaction is not on the ledger');
  }

  private quote(kind: LegKind, source: Money, target: Money): LegQuote {
    const quote: LegQuote = {
      id: this.nextId(kind === 'funding' ? 'fq' : 'pq'),
      partner: this.id,
      kind,
      expiresAt: new Date(this.options.now() + QUOTE_TTL_MS).toISOString(),
      source,
      target,
      fees: [],
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  private liveQuote(id: string): LegQuote {
    const quote = this.quotes.get(id);
    if (quote === undefined) throw new GridError('invalid_input', `Unknown quote ${id}`);
    if (this.options.now() >= Date.parse(quote.expiresAt)) throw new GridError('quote_expired', `Quote ${id} expired`);
    return quote;
  }

  private addLeg(kind: LegKind, quote: LegQuote, account: AccountRef): Leg {
    const leg: Leg = {
      ref: { partner: this.id, kind, id: this.nextId(kind === 'funding' ? 'payin' : 'payout') },
      quote,
      account,
      status: 'pending',
    };
    this.legs.set(leg.ref.id, leg);
    return leg;
  }

  private leg(id: string): Leg {
    const leg = this.legs.get(id);
    if (leg === undefined) throw new GridError('invalid_input', `Unknown leg ${id}`);
    return leg;
  }

  private assertChain(account: AccountRef): void {
    if (account.chain !== this.options.chain) {
      throw new GridError('invalid_input', `${this.id} settles on ${this.options.chain}, not ${account.chain}`);
    }
  }

  private stellar(): MockStellarSettings {
    if (this.options.stellar === undefined) throw new GridError('invalid_input', `${this.id} has no Stellar support`);
    return this.options.stellar;
  }

  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${this.id}-${prefix}-${n}`;
  }
}

/** `value / rate`, rounded down to 7 decimals. */
function divide(value: Money, rate: string, asset: Asset): Money {
  return fromUnits((toUnits(value) * SCALE) / toUnits({ amount: rate, asset }), asset);
}

/** `value * rate`, rounded down to 7 decimals. */
function multiply(value: Money, rate: string, asset: Asset): Money {
  return fromUnits((toUnits(value) * toUnits({ amount: rate, asset })) / SCALE, asset);
}

/** Stands in for a PIX copy-and-paste code. Not payable anywhere. */
function fakePixCode(partner: string, amount: string): string {
  return `MOCKPIX:${partner}:BRL:${amount}:not-payable`;
}
