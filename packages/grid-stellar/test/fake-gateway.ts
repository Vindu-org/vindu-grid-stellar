/**
 * In-memory Horizon gateway for tests. No network.
 */
import type {
  HorizonAccount,
  HorizonGateway,
  HorizonLedger,
  HorizonPaymentRecord,
  HorizonRequestOptions,
  HorizonSubmitResponse,
  HorizonTransactionLookup,
  PaymentsQuery,
} from '../src/horizon';
import { stellarSdk } from '../src/sdk';

const { Networks } = stellarSdk;

export const ACCOUNT = `G${'A'.repeat(55)}`;
export const OTHER = `G${'B'.repeat(55)}`;
export const THIRD = `G${'C'.repeat(55)}`;
export const USDC_ISSUER = `G${'D'.repeat(55)}`;

export class FakeGateway implements HorizonGateway {
  networkPassphrase: string = Networks.TESTNET;
  /** The latest ingested ledger; set it to move Horizon's view of time. An `Error` makes the call fail. */
  ledger: HorizonLedger | Error = { sequence: 1, closedAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 0)) };
  /**
   * Latest ingested ledger a lookup reports, as Horizon's `Latest-Ledger`
   * header does. Default: the current `ledger`'s sequence. `null`: no header.
   */
  lookupLedger: number | null | undefined;
  /**
   * Latest ingested ledger an account read reports, as Horizon's
   * `Latest-Ledger` header does. Default: the current `ledger`'s sequence.
   * `null`: no header.
   */
  accountLedger: number | null | undefined;
  readonly ledgerReads: number[] = [];
  readonly accountReads: string[] = [];
  /** Payment history per account, oldest first. */
  readonly payments = new Map<string, HorizonPaymentRecord[]>();
  readonly paymentQueries: Array<{ account: string; query: PaymentsQuery }> = [];
  readonly transactions = new Map<string, HorizonTransactionLookup>();
  readonly transactionLookups: string[] = [];
  readonly submitted: string[] = [];
  readonly accounts = new Map<string, HorizonAccount>();
  /** Answers for successive submissions; the last one repeats. */
  submitResponses: Array<HorizonSubmitResponse | Error | 'hang'> = [];
  /** Runs after each lookup, e.g. to make a transaction appear later. */
  onLookup: ((hash: string, count: number) => void) | undefined;

  async latestLedger(_options?: HorizonRequestOptions): Promise<HorizonLedger> {
    this.ledgerReads.push(this.transactionLookups.length);
    if (this.ledger instanceof Error) throw this.ledger;
    return this.ledger;
  }

  async paymentsForAccount(
    account: string,
    query: PaymentsQuery,
    _options?: HorizonRequestOptions,
  ): Promise<readonly HorizonPaymentRecord[]> {
    this.paymentQueries.push({ account, query });
    const all = this.payments.get(account) ?? [];
    const start = query.cursor === undefined ? 0 : all.findIndex((r) => r.paging_token === query.cursor) + 1;
    return all.slice(start, start + query.limit);
  }

  async transaction(hash: string, _options?: HorizonRequestOptions): Promise<HorizonTransactionLookup> {
    this.transactionLookups.push(hash);
    this.onLookup?.(hash, this.transactionLookups.length);
    const latest = this.lookupLedger === undefined ? (this.ledger instanceof Error ? null : this.ledger.sequence) : this.lookupLedger;
    const ingested = latest === null ? {} : { latestLedger: latest };
    return { ...(this.transactions.get(hash) ?? { found: false }), ...ingested };
  }

  async submitTransaction(signedXdr: string): Promise<HorizonSubmitResponse> {
    this.submitted.push(signedXdr);
    const next = this.submitResponses.length > 1 ? this.submitResponses.shift() : this.submitResponses[0];
    if (next === undefined) throw new Error('no submit response configured');
    if (next === 'hang') return new Promise(() => undefined);
    if (next instanceof Error) throw next;
    return next;
  }

  async account(address: string, _options?: HorizonRequestOptions): Promise<HorizonAccount | null> {
    this.accountReads.push(address);
    const account = this.accounts.get(address);
    if (account === undefined) return null;
    const latest = this.accountLedger === undefined ? (this.ledger instanceof Error ? null : this.ledger.sequence) : this.accountLedger;
    return { ...account, ...(latest === null ? {} : { latestLedger: latest }) };
  }

  /** Registers `address` with sequence number `sequence` and no balances. */
  setAccount(address: string, sequence: string): void {
    this.accounts.set(address, { id: address, sequence, subentry_count: 0, balances: [] });
  }
}

let seq = 0;

/** A Horizon `payment` record; override any field, or remove it with `undefined`. */
export function paymentRecord(
  overrides: { [K in keyof HorizonPaymentRecord]?: HorizonPaymentRecord[K] | undefined } = {},
): HorizonPaymentRecord {
  seq += 1;
  const record: Record<string, unknown> = {
    id: `op-${seq}`,
    paging_token: `${seq * 4096}`,
    type: 'payment',
    transaction_hash: `${seq.toString(16).padStart(64, '0')}`,
    transaction_successful: true,
    created_at: '2026-11-09T12:00:00Z',
    from: OTHER,
    to: ACCOUNT,
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,
    amount: '10.0000000',
    ...overrides,
  };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  return record as unknown as HorizonPaymentRecord;
}
