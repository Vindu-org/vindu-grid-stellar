/**
 * The objects one live run shares: the BlindPay client and adapter, the
 * Horizon gateway, the reporter, a transfer store, and what earlier steps
 * found out (the customer, the test account, the USDB issuer).
 */
import { type BlindPayAdapter, type BlindPayClient, createBlindPayAdapter, createBlindPayClient } from '@vindu/grid-blindpay';
import { type AccountRef, type Asset, type Logger, type PartnerCall, type TransferState } from '@vindu/grid-core';
import { type HorizonGateway, TESTNET_HORIZON_URL, TESTNET_NETWORK_PASSPHRASE, createHorizonGateway } from '@vindu/grid-stellar';

import type { LiveEnv } from './env';
import { pacedFetch } from './pacer';
import type { Redactor } from './redact';
import type { Reporter } from './report';
import type { StellarSdk } from './sdk';

/** Stays under the development limit of 40 a minute, with room for the odd retry. */
export const BLINDPAY_REQUESTS_PER_MINUTE = 30;
export const NETWORK_PASSPHRASE = TESTNET_NETWORK_PASSPHRASE;
export const FRIENDBOT_URL = 'https://friendbot.stellar.org';

/** What the steps learn as they go. */
export interface Found {
  customerId?: string;
  keypair?: StellarSdk.Keypair;
  account?: AccountRef;
  usdb?: Asset;
  payoutDestination?: string;
  /**
   * True when `payoutDestination` is the development fallback (the USDB
   * issuer, read from BlindPay's own trustline XDR) rather than
   * `BLINDPAY_PAYOUT_DESTINATION`. Checking payouts against it is circular.
   */
  payoutDestinationIsFallback?: boolean;
  bankAccountId?: string;
}

export interface World {
  readonly env: LiveEnv;
  readonly report: Reporter;
  readonly redact: Redactor;
  readonly client: BlindPayClient;
  readonly gateway: HorizonGateway;
  readonly store: TransferStore;
  readonly logger: Logger;
  readonly found: Found;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetch: typeof globalThis.fetch;
  /** BlindPay requests sent so far. */
  readonly requests: () => number;
  /** Builds the adapter once the USDB issuer and the payout destination are known. */
  adapter(): BlindPayAdapter;
}

/**
 * The transfer states of this run, in memory. `cas` is the compare-and-set
 * core asks `onAuthorized` to be: it moves only from the expected state.
 */
export class TransferStore {
  private readonly states = new Map<string, TransferState>();

  set(transferId: string, state: TransferState): void {
    this.states.set(transferId, state);
  }

  get(transferId: string): TransferState | undefined {
    return this.states.get(transferId);
  }

  cas(transferId: string, from: TransferState, to: TransferState): TransferState {
    const current = this.states.get(transferId);
    if (current !== from) throw new Error(`Transfer is in ${String(current)}, not ${from}`);
    this.states.set(transferId, to);
    return to;
  }
}

export interface WorldDeps {
  readonly env: LiveEnv;
  readonly report: Reporter;
  readonly redact: Redactor;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly print: (line: string) => void;
}

export function createWorld(deps: WorldDeps): World {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const paced = pacedFetch((input, init) => deps.fetch(input, init), {
    maxPerMinute: BLINDPAY_REQUESTS_PER_MINUTE,
    now,
    sleep,
    onWait: (ms, reason) => {
      if (reason === 'retry_after') deps.report.finding('rate', `BlindPay answered 429; waited ${Math.ceil(ms / 1000)} s as Retry-After asked`);
    },
  });
  const say = (level: string) => (msg: string, fields?: unknown) =>
    deps.print(deps.redact(`        ${level} ${msg} ${fields === undefined ? '' : JSON.stringify(fields)}`));
  const logger: Logger = { debug: () => undefined, info: () => undefined, warn: say('warn'), error: say('error') };
  const onCall = (call: PartnerCall) => {
    if (call.status === null || call.status >= 400) {
      deps.print(deps.redact(`        call ${call.method} ${call.path} -> ${String(call.status ?? call.error)}`));
    }
  };
  const config = {
    apiKey: deps.env.apiKey,
    instanceId: deps.env.instanceId,
    ...(deps.env.baseUrl === undefined ? {} : { baseUrl: deps.env.baseUrl }),
    fetch: paced,
    logger,
    onCall,
    now,
  };
  const client = createBlindPayClient(config);
  const gateway = createHorizonGateway({ horizonUrl: TESTNET_HORIZON_URL, networkPassphrase: NETWORK_PASSPHRASE });
  const found: Found = {};
  let adapter: BlindPayAdapter | undefined;
  return {
    env: deps.env,
    report: deps.report,
    redact: deps.redact,
    client,
    gateway,
    store: new TransferStore(),
    logger,
    found,
    now,
    sleep,
    fetch: deps.fetch,
    requests: paced.requests,
    adapter() {
      if (adapter !== undefined) return adapter;
      if (found.usdb?.issuer === undefined) throw new Error('The USDB issuer is not known yet');
      adapter = createBlindPayAdapter(config, {
        network: 'stellar_testnet',
        client,
        assetIssuers: { USDB: found.usdb.issuer },
        ...(found.payoutDestination === undefined ? {} : { payoutDestination: found.payoutDestination }),
        now,
      });
      return adapter;
    },
  };
}
