/**
 * In-memory Horizon gateway for tests. No network.
 */
import type {
  HorizonAccount,
  HorizonGateway,
  HorizonPaymentRecord,
  HorizonSubmitResponse,
  HorizonTransactionLookup,
  PaymentsQuery,
} from '../src/horizon';

export const ACCOUNT = `G${'A'.repeat(55)}`;
export const OTHER = `G${'B'.repeat(55)}`;
export const THIRD = `G${'C'.repeat(55)}`;
export const USDC_ISSUER = `G${'D'.repeat(55)}`;

export class FakeGateway implements HorizonGateway {
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

  async paymentsForAccount(account: string, query: PaymentsQuery): Promise<readonly HorizonPaymentRecord[]> {
    this.paymentQueries.push({ account, query });
    const all = this.payments.get(account) ?? [];
    const start = query.cursor === undefined ? 0 : all.findIndex((r) => r.paging_token === query.cursor) + 1;
    return all.slice(start, start + query.limit);
  }

  async transaction(hash: string): Promise<HorizonTransactionLookup> {
    this.transactionLookups.push(hash);
    this.onLookup?.(hash, this.transactionLookups.length);
    return this.transactions.get(hash) ?? { found: false };
  }

  async submitTransaction(signedXdr: string): Promise<HorizonSubmitResponse> {
    this.submitted.push(signedXdr);
    const next = this.submitResponses.length > 1 ? this.submitResponses.shift() : this.submitResponses[0];
    if (next === undefined) throw new Error('no submit response configured');
    if (next === 'hang') return new Promise(() => undefined);
    if (next instanceof Error) throw next;
    return next;
  }

  async account(address: string): Promise<HorizonAccount | null> {
    return this.accounts.get(address) ?? null;
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
    paging_token: `pt-${seq}`,
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
