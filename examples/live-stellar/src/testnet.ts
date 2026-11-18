/**
 * The live testnet: a real Horizon gateway, friendbot funding, sequence
 * numbers kept locally per account, and helpers to build, sign and land
 * transactions for the setup.
 *
 * Every key is a throwaway made with `Keypair.random()` for this run. Secret
 * keys stay in memory: nothing here writes them to disk or prints them.
 */
import type { Asset, Logger } from '@vindu/grid-core';
import {
  type HorizonAccount,
  type HorizonGateway,
  type SubmitResult,
  createHorizonGateway,
  submitSignedTransaction,
} from '@vindu/grid-stellar';

import { balanceOf } from './check';
import { type LiveNetwork, assertHorizonRootIsTestnet, assertTestnet } from './network';
import { type Sleep, realSleep, waitFor, withRetry } from './retry';
import { Account, type StellarSdk, TransactionBuilder } from './sdk';

/** Fee per operation, in stroops, for every transaction of the run. */
export const FEE_PER_OP = '1000';

/** Submit settings for the run: long enough for a slow testnet ledger. */
export const SUBMIT_TIMINGS = Object.freeze({ timeoutMs: 30_000, maxWaitMs: 60_000, pollIntervalMs: 3_000 });

/** `G...WXYZ`: enough to tell accounts apart in the output, never a secret. */
export function short(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

export interface BuildOptions {
  /** Unix seconds. Default: now + 5 minutes. */
  readonly maxTime?: number;
  readonly fee?: string;
  readonly memo?: StellarSdk.Memo;
  /**
   * Build from a copy of the account's sequence number, leaving the local
   * one where it is. For transactions that are never meant to land.
   */
  readonly detached?: boolean;
}

/** Thrown when friendbot keeps failing after the bounded retries. */
export class FriendbotError extends Error {
  constructor(readonly status: number | null) {
    super(`friendbot did not fund the account (status ${status ?? 'none'})`);
    this.name = 'FriendbotError';
  }
}

export class Testnet {
  readonly gateway: HorizonGateway;
  private readonly accounts = new Map<string, StellarSdk.Account>();
  /**
   * Highest ledger a transaction of this run landed in. Account reads are
   * only believed from an instance that had ingested it (`Latest-Ledger`).
   */
  private landedLedger = 0;

  constructor(
    readonly network: LiveNetwork,
    readonly logger: Logger,
    readonly sleep: Sleep = realSleep,
  ) {
    assertTestnet(network);
    this.gateway = createHorizonGateway({ horizonUrl: network.horizonUrl, networkPassphrase: network.networkPassphrase });
  }

  get networkPassphrase(): string {
    return this.network.networkPassphrase;
  }

  /** Reads Horizon's root and refuses to go on unless it serves testnet. */
  async checkHorizon(): Promise<void> {
    const root = await withRetry(
      async () => {
        const res = await fetch(`${this.network.horizonUrl}/`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (res.status !== 200) throw new Error(`Horizon answered HTTP ${res.status}`);
        return (await res.json()) as unknown;
      },
      { attempts: 4, delayMs: 2_000, sleep: this.sleep },
    );
    assertHorizonRootIsTestnet(root);
  }

  /** Funds `address` with friendbot, retrying errors and rate limits a bounded number of times. */
  async friendbot(address: string): Promise<void> {
    await withRetry(
      async () => {
        let status: number | null = null;
        try {
          const res = await fetch(`${this.network.friendbotUrl}/?addr=${encodeURIComponent(address)}`, {
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          });
          status = res.status;
          await res.arrayBuffer(); // the body is not used, and never printed
        } catch {
          // Network error: retried below.
        }
        if (status === 200) return;
        // Friendbot answers 400 when the account already exists, e.g. after a
        // retried request that did fund it.
        if (status === 400 && (await this.gateway.account(address)) !== null) return;
        throw new FriendbotError(status);
      },
      { attempts: 6, delayMs: 2_000, maxDelayMs: 15_000, sleep: this.sleep },
    );
  }

  /**
   * Reads `address` until it exists and its sequence number is at least
   * `minSequence`. A load-balanced Horizon can answer from an instance a
   * ledger behind, so one stale answer is not a failure.
   */
  async settledAccount(address: string, minSequence = '0'): Promise<HorizonAccount> {
    const account = await waitFor(
      async () => {
        let found: HorizonAccount | null;
        try {
          found = await this.gateway.account(address);
        } catch {
          return undefined;
        }
        if (found === null || !this.isCurrent(found)) return undefined;
        return BigInt(found.sequence) >= BigInt(minSequence) ? found : undefined;
      },
      { attempts: 20, intervalMs: 1_500, sleep: this.sleep },
    );
    if (account === undefined) throw new Error(`Account ${short(address)} did not reach sequence ${minSequence}`);
    return account;
  }

  /**
   * Waits until `address` holds exactly `expected` of `asset` and returns
   * the last balance seen. A stale instance shows a lower balance for a
   * while; a payment made twice would never show `expected`.
   */
  async balanceReaches(address: string, asset: Asset, expected: string): Promise<string | undefined> {
    let last: string | undefined;
    await waitFor(
      async () => {
        try {
          const account = await this.gateway.account(address);
          if (account === null || !this.isCurrent(account)) return undefined;
          last = balanceOf(account, asset);
        } catch {
          return undefined;
        }
        return last === expected ? last : undefined;
      },
      { attempts: 15, intervalMs: 1_500, sleep: this.sleep },
    );
    return last;
  }

  /** Whether the read came from an instance that had ingested every ledger this run landed in. */
  private isCurrent(account: HorizonAccount): boolean {
    return account.latestLedger !== undefined && account.latestLedger >= this.landedLedger;
  }

  /** Notes the ledger a transaction landed in, so later reads are only believed once they include it. */
  noteLanded(ledger: number | undefined): void {
    if (ledger !== undefined) this.landedLedger = Math.max(this.landedLedger, ledger);
  }

  /** Loads the account's sequence number from Horizon into the local copy. */
  async load(keypair: StellarSdk.Keypair): Promise<void> {
    const account = await this.settledAccount(keypair.publicKey());
    this.accounts.set(keypair.publicKey(), new Account(keypair.publicKey(), account.sequence));
  }

  /** The sequence number the account's next transaction will use. */
  nextSequence(keypair: StellarSdk.Keypair): string {
    return (BigInt(this.local(keypair).sequenceNumber()) + 1n).toString();
  }

  private local(keypair: StellarSdk.Keypair): StellarSdk.Account {
    const account = this.accounts.get(keypair.publicKey());
    if (account === undefined) throw new Error(`Account ${short(keypair.publicKey())} was not loaded`);
    return account;
  }

  /** Builds an unsigned transaction from `source` with `operations`. */
  build(
    source: StellarSdk.Keypair,
    operations: readonly StellarSdk.xdr.Operation[],
    options: BuildOptions = {},
  ): StellarSdk.Transaction {
    const local = this.local(source);
    const account = options.detached === true ? new Account(local.accountId(), local.sequenceNumber()) : local;
    const maxTime = options.maxTime ?? nowSeconds() + 300;
    const builder = new TransactionBuilder(account, {
      fee: options.fee ?? FEE_PER_OP,
      networkPassphrase: this.networkPassphrase,
      timebounds: { minTime: 0, maxTime },
      ...(options.memo === undefined ? {} : { memo: options.memo }),
    });
    for (const op of operations) builder.addOperation(op);
    return builder.build();
  }

  /** Signs `tx` with every keypair and returns the envelope as base64 XDR. */
  sign(tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction, ...signers: StellarSdk.Keypair[]): string {
    for (const signer of signers) tx.sign(signer);
    return tx.toXDR();
  }

  /** Submits through grid-stellar's `submitSignedTransaction` with the run's timings. */
  async submit(signedXdr: string, overrides: Partial<Omit<Parameters<typeof submitSignedTransaction>[0], 'signedXdr'>> = {}): Promise<SubmitResult> {
    const result = await submitSignedTransaction({
      gateway: this.gateway,
      networkPassphrase: this.networkPassphrase,
      logger: this.logger,
      ...SUBMIT_TIMINGS,
      ...overrides,
      signedXdr,
    });
    if (result.status === 'success' || result.status === 'failed') this.noteLanded(result.ledger);
    return result;
  }

  /**
   * Builds, signs and submits a setup transaction and requires `success`.
   * On a refusal for a stale sequence number it reloads the source account
   * and builds again, at most twice.
   */
  async land(
    label: string,
    source: StellarSdk.Keypair,
    operations: () => readonly StellarSdk.xdr.Operation[],
    signers: readonly StellarSdk.Keypair[],
    options: BuildOptions = {},
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const tx = this.build(source, operations(), options);
      const result = await this.submit(this.sign(tx, ...signers));
      if (result.status === 'success') return result.hash;
      const code = result.status === 'rejected' && result.reason === 'refused' ? result.error.code : undefined;
      if (code === 'bad_seq' && attempt < 3) {
        await this.load(source);
        continue;
      }
      throw new Error(`${label}: submit ended ${result.status}${code === undefined ? '' : ` (${code})`}`);
    }
  }

  /** Waits until Horizon's latest ingested ledger closed strictly after `unixSeconds`. */
  async ledgerClosedAfter(unixSeconds: number): Promise<{ sequence: number; closedAt: Date }> {
    const ledger = await waitFor(
      async () => {
        try {
          const latest = await this.gateway.latestLedger();
          return Math.floor(latest.closedAt.getTime() / 1000) > unixSeconds ? latest : undefined;
        } catch {
          return undefined;
        }
      },
      { attempts: 60, intervalMs: 2_000, sleep: this.sleep },
    );
    if (ledger === undefined) throw new Error('No ledger closed after the time limit within two minutes');
    return ledger;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
