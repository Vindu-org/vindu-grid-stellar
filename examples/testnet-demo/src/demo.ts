/**
 * A full two-leg transfer, offline: BRL by PIX -> USDC on Stellar -> USD by wire.
 *
 * Everything outside the application is simulated (see `world.ts`), but the
 * code paths are the real ones from `@vindu/grid-core` and
 * `@vindu/grid-stellar`: routing, the transition table, price tolerance,
 * the signed payout flow (`runSignedPayout` with `createStellarSubmitter`),
 * the read layer and matching.
 */
import { type AccountRef, type RouteDecision, type TransferState, money, selectRoute } from '@vindu/grid-core';
import { checkReceiveReadiness } from '@vindu/grid-stellar';

import { watchAccount } from './chain-watch';
import { fmt, short } from './format';
import { runFundingLeg } from './funding-leg';
import type { LegContext } from './leg-context';
import { runPayoutLeg } from './payout-leg';
import { type Log, Transfer } from './transfer';
import { BRL, USD, createWorld } from './world';

export interface DemoOptions {
  /** Where the lines go. Default: nowhere. */
  readonly log?: Log;
  /** Clock in ms since epoch. Default `Date.now`. */
  readonly now?: () => number;
  /** Make Horizon time out once on the payout submission. Default true. */
  readonly simulateHorizonTimeout?: boolean;
  /**
   * Make Horizon refuse the payout submission. The transfer then stops in
   * `needs_attention` and the partner payout is never created. Default false.
   */
  readonly simulateSubmitRejection?: boolean;
  /**
   * Make the partner refuse to authorize the payout. The transfer then stops
   * in `needs_attention` straight from `payout_quoted`, and nothing is
   * signed. Default false.
   */
  readonly simulateAuthorizationFailure?: boolean;
}

export interface DemoResult {
  readonly transferId: string;
  readonly finalState: TransferState;
  /** Every state the transfer went through, in order. */
  readonly history: readonly TransferState[];
  readonly route: RouteDecision;
  readonly payoutTxHash: string | undefined;
}

const TRANSFER_ID = 'demo-transfer-1';
const CUSTOMER_ID = 'demo-customer';
/** The Stellar route loses only if its price is worse than this, in basis points. */
const STELLAR_PRICE_LIMIT_BPS = 100;

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const world = createWorld(now);
  const account: AccountRef = { chain: 'stellar', address: world.clientAddress };

  log('Two-leg transfer on Stellar, offline: mock partners, in-memory Horizon, throwaway testnet keys');
  log(`  network passphrase: ${world.networkPassphrase}`);
  log(`  client account ${short(world.clientAddress)} (key held by a ${world.signer.custody} signer)`);
  log(`  ${world.partner.id} treasury ${short(world.partner.treasuryAddress)}, USDC issuer ${short(world.usdc.issuer ?? '')}`);

  // The client's account must be able to receive USDC before it can be routed to.
  const readiness = await checkReceiveReadiness(world.ledger, world.clientAddress, world.usdc, { checkReserve: true });
  log(
    `  account ready for USDC: ${readiness.ready ? 'yes' : `no (${readiness.issues.join(', ')})`}` +
      (readiness.reserve === undefined ? '' : `, reserve ${readiness.reserve.required} XLM of ${readiness.reserve.available}`),
  );

  // Routing, once, at quote time.
  const source = money('52500', BRL);
  const corridor = { sourceCurrency: 'BRL', fundingRail: 'pix', targetCurrency: 'USD', payoutRail: 'wire' };
  log('');
  log(`Routing ${fmt(source)} by PIX to USD by wire`);
  const candidates = [world.partner, world.offchain].map((p) => {
    const chain = world.registry[p.id]?.chains[0] ?? 'unknown';
    const price = p.indicativePrice(source, USD);
    log(`  ${p.id} on ${chain}: ${fmt(price.source)} -> ${fmt(price.target)}`);
    return { partner: p.id, chain, customerApproved: true, accountReady: chain !== 'stellar' || readiness.ready, price };
  });
  const decision = selectRoute(candidates, {
    registry: world.registry,
    corridor,
    stellarRoutingEnabled: true,
    stellarPriceLimitBps: STELLAR_PRICE_LIMIT_BPS,
  });
  log(
    `  selected ${decision.route.partner} on ${decision.route.chain}, reason ${decision.reason}` +
      (decision.stellarPriceGapBps === undefined
        ? ''
        : `: its price is ${decision.stellarPriceGapBps} bps worse, within the ${STELLAR_PRICE_LIMIT_BPS} bps safeguard`),
  );
  if (decision.route.partner !== world.partner.id) throw new Error('The demo expects the Stellar route');
  const estimate = decision.price.target;

  // Leg one.
  const transfer = new Transfer(TRANSFER_ID, decision.route, log);
  const fundingQuote = await world.partner.quoteFunding({
    customerId: CUSTOMER_ID,
    account,
    source,
    targetAsset: world.usdc,
    rail: 'pix',
  });
  log('');
  log(`Transfer ${transfer.id}, estimated delivery ${fmt(estimate)}`);
  log(`  ${transfer.state}: funding quote ${fundingQuote.id}, ${fmt(fundingQuote.source)} -> ${fmt(fundingQuote.target)}`);

  const ctx: LegContext = {
    world,
    transfer,
    account,
    customerId: CUSTOMER_ID,
    watch: watchAccount(world.ledger, world.clientAddress),
    log,
    now,
  };
  const funded = await runFundingLeg(ctx, fundingQuote);

  // Leg two.
  const payoutTxHash =
    funded === undefined
      ? undefined
      : await runPayoutLeg(ctx, funded, estimate, {
          simulateHorizonTimeout: options.simulateHorizonTimeout ?? true,
          simulateSubmitRejection: options.simulateSubmitRejection ?? false,
          simulateAuthorizationFailure: options.simulateAuthorizationFailure ?? false,
        });

  log('');
  log(`Final state: ${transfer.state}`);
  log(`  path: ${transfer.history.join(' -> ')}`);
  return { transferId: transfer.id, finalState: transfer.state, history: transfer.history, route: decision, payoutTxHash };
}
