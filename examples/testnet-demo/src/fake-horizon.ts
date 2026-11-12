/**
 * An in-memory Horizon, so the demo runs with no network.
 *
 * It implements `HorizonGateway` from `@vindu/grid-stellar`, the same
 * interface `createHorizonGateway` implements over the real Horizon. It
 * applies single-payment transactions to a tiny ledger: it checks the source
 * signature, the sequence number and the time bounds, and records the
 * payment so the read layer can see it. It does not track balances.
 *
 * It reports what a real instance reports about its own ingestion, so the
 * submitter's proof runs in full: every transaction lookup and account read
 * gives the latest ledger it had ingested (`latestLedger`, Horizon's
 * `Latest-Ledger` header), and an applied transaction uses its source
 * account's sequence number. It is one instance, never a load balancer: the
 * ledger read, the lookups and the account reads always agree.
 *
 * `timeOutNextSubmission()` makes the next submission land on the ledger but
 * answer like a Horizon 504, to show what the submitter does when it does
 * not know whether a transaction landed. `loseNextSubmission()` answers 504
 * too, but the transaction never reaches the ledger. `rejectNextSubmission()`
 * makes the next submission fail without touching the ledger, like a
 * Horizon 400.
 */
import type {
  HorizonAccount,
  HorizonPaymentRecord,
  HorizonGateway,
  HorizonLedger,
  HorizonSubmitResponse,
  HorizonTransactionFound,
  HorizonTransactionLookup,
  PaymentsQuery,
} from '@vindu/grid-stellar';

import { Keypair, TransactionBuilder } from './sdk';
import { decodePayment } from './stellar-tx';

type Rejection = Extract<HorizonSubmitResponse, { kind: 'rejected' }>;

const reject = (transactionCode: string): Rejection => ({ kind: 'rejected', status: 400, transactionCode, operationCodes: [] });

export class FakeHorizon implements HorizonGateway {
  private readonly accounts = new Map<string, HorizonAccount>();
  private readonly records: HorizonPaymentRecord[] = [];
  private readonly transactions = new Map<string, HorizonTransactionFound>();
  private ledger = 1000;
  private timeoutNext = false;
  private loseNext = false;
  private rejectNext: string | undefined;
  /** Every envelope submitted, in order. */
  readonly submissions: string[] = [];
  /** Every hash looked up, in order. */
  readonly lookups: string[] = [];

  constructor(
    readonly networkPassphrase: string,
    private readonly now: () => number,
  ) {}

  /** Adds an account as it would exist on the network. */
  addAccount(account: HorizonAccount): void {
    this.accounts.set(account.id, account);
  }

  /** The next submission lands on the ledger, but Horizon answers 504. */
  timeOutNextSubmission(): void {
    this.timeoutNext = true;
  }

  /** The next submission answers 504 and never reaches the ledger. */
  loseNextSubmission(): void {
    this.loseNext = true;
  }

  /** The next submission is refused with `transactionCode` and never applied. */
  rejectNextSubmission(transactionCode = 'tx_insufficient_fee'): void {
    this.rejectNext = transactionCode;
  }

  /** The newest ledger, closed at the demo clock's current second. */
  async latestLedger(): Promise<HorizonLedger> {
    return { sequence: this.ledger, closedAt: new Date(Math.floor(this.now() / 1000) * 1000) };
  }

  async paymentsForAccount(account: string, query: PaymentsQuery): Promise<readonly HorizonPaymentRecord[]> {
    const touching = this.records.filter((r) => r.from === account || r.to === account);
    const ordered = query.order === 'asc' ? touching : [...touching].reverse();
    const start = query.cursor === undefined ? 0 : ordered.findIndex((r) => r.paging_token === query.cursor) + 1;
    return ordered.slice(start, start + query.limit);
  }

  /** The transaction, with the latest ledger ingested when it was looked up. */
  async transaction(hash: string): Promise<HorizonTransactionLookup> {
    this.lookups.push(hash);
    return { ...(this.transactions.get(hash) ?? { found: false }), latestLedger: this.ledger };
  }

  async submitTransaction(signedXdr: string): Promise<HorizonSubmitResponse> {
    this.submissions.push(signedXdr);
    if (this.rejectNext !== undefined) {
      const code = this.rejectNext;
      this.rejectNext = undefined;
      return reject(code);
    }
    if (this.loseNext) {
      this.loseNext = false;
      return { kind: 'timeout', status: 504 };
    }
    const applied = this.apply(signedXdr);
    if (applied.kind === 'rejected') return applied;
    if (this.timeoutNext) {
      this.timeoutNext = false;
      return { kind: 'timeout', status: 504 };
    }
    return applied;
  }

  /** The account, with the latest ledger ingested when it was read. */
  async account(address: string): Promise<HorizonAccount | null> {
    const account = this.accounts.get(address);
    return account === undefined ? null : { ...account, latestLedger: this.ledger };
  }

  private apply(signedXdr: string): HorizonSubmitResponse {
    const tx = decodePayment(signedXdr, this.networkPassphrase);
    if (this.transactions.has(tx.hash)) return reject('tx_bad_seq'); // already applied once
    const source = this.accounts.get(tx.source);
    if (source === undefined) return reject('tx_no_source_account');
    if (BigInt(tx.sequence) !== BigInt(source.sequence) + 1n) return reject('tx_bad_seq');
    if (tx.maxTime !== undefined && this.now() > tx.maxTime * 1000) return reject('tx_too_late');
    if (!this.signedBySource(signedXdr, tx.source)) return reject('tx_bad_auth');

    this.ledger += 1;
    this.accounts.set(tx.source, { ...source, sequence: tx.sequence });
    const createdAt = new Date(this.now()).toISOString();
    const token = String(this.ledger * 4096 + 1);
    this.records.push({
      id: token,
      paging_token: token,
      type: 'payment',
      transaction_hash: tx.hash,
      transaction_successful: true,
      created_at: createdAt,
      source_account: tx.source,
      from: tx.source,
      to: tx.destination,
      asset_type: tx.amount.asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
      asset_code: tx.amount.asset.code,
      asset_issuer: tx.amount.asset.issuer as string,
      amount: padded(tx.amount.amount),
      ...(tx.memo === undefined ? {} : { memo: tx.memo, memo_type: 'text' }),
    });
    this.transactions.set(tx.hash, { found: true, hash: tx.hash, successful: true, ledger: this.ledger, createdAt });
    return { kind: 'accepted', hash: tx.hash, ledger: this.ledger, successful: true };
  }

  private signedBySource(signedXdr: string, source: string): boolean {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const key = Keypair.fromPublicKey(source);
    return tx.signatures.some((s) => key.verify(tx.hash(), s.signature));
  }
}

/** Horizon's 7-decimal amount format: "9972" becomes "9972.0000000". */
function padded(amount: string): string {
  const [int, frac = ''] = amount.split('.');
  return `${int}.${frac.padEnd(7, '0')}`;
}
