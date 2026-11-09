/**
 * `--blindpay-dry-run`: the same flow shape through `@vindu/grid-blindpay`,
 * against a mocked `fetch`. Nothing leaves the process.
 *
 * It prints each request BlindPay would receive (method, path and body;
 * headers are never printed). The credentials are placeholders that only
 * pass the client's format checks: the mocked `fetch` ignores them. Ids and
 * amounts in the answers are made up for the demo.
 */
import { createBlindPayAdapter, runStellarPayout } from '@vindu/grid-blindpay';
import { type AccountRef, type TransferState, type TransitionReason, money, transition } from '@vindu/grid-core';
import { createStellarSubmitter } from '@vindu/grid-stellar';

import { fmt, short } from './format';
import { buildPaymentXdr } from './stellar-tx';
import { type Log, StateConflictError } from './transfer';
import { BRL, USD, createWorld } from './world';

const INSTANCE_PREFIX = '/v1/instances/in_demo';
const WALLET_ID = 'bw_demo1';

export interface DryRunResult {
  /** `METHOD /path` of every request, in order. */
  readonly requests: readonly string[];
  readonly payoutId: string;
  readonly txHash: string | undefined;
}

export async function runBlindPayDryRun(log: Log, now: () => number = Date.now): Promise<DryRunResult> {
  const world = createWorld(now);
  const account: AccountRef = { chain: 'stellar', address: world.clientAddress, partnerAccountId: WALLET_ID };
  const expiresAt = now() + 5 * 60 * 1000;
  const usdc = (amount: string) => money(amount, world.usdc);
  const usdcIssuer = world.usdc.issuer;
  if (usdcIssuer === undefined) throw new Error('The demo USDC has an issuer');
  const requests: string[] = [];

  // Answers BlindPay might give, keyed by path. The authorize answer is a
  // real unsigned transaction from the client's account.
  const answer = async (path: string): Promise<unknown> => {
    switch (path) {
      case '/payin-quotes':
        return { id: 'qu_payin1', expires_at: expiresAt, sender_amount: 5_250_000, receiver_amount: 1_000_000 };
      case '/payins/evm':
        return { id: 'pi_demo1', status: 'processing', pix_code: 'MOCKPIX:blindpay:BRL:52500:not-payable' };
      case '/quotes':
        return { id: 'qu_payout1', expires_at: expiresAt, sender_amount: 1_000_000, receiver_amount: 997_200 };
      case '/payouts/stellar/authorize': {
        const source = await world.ledger.account(world.clientAddress);
        const unsigned = buildPaymentXdr({
          source: world.clientAddress,
          sequence: source?.sequence ?? '0',
          destination: world.partner.treasuryAddress,
          amount: usdc('10000'),
          maxTime: Math.floor(expiresAt / 1000),
          networkPassphrase: world.networkPassphrase,
        });
        return { transaction_hash: unsigned }; // BlindPay's name for the unsigned XDR
      }
      case '/payouts/stellar':
        return { id: 'po_demo1', status: 'processing', sender_wallet_address: world.clientAddress };
      default:
        throw new Error(`The dry run has no answer for ${path}`);
    }
  };

  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(INSTANCE_PREFIX, '');
    const method = init.method ?? 'GET';
    requests.push(`${method} ${path}`);
    const body = typeof init.body === 'string' ? ` ${summarise(init.body)}` : '';
    log(`    ${method} ${INSTANCE_PREFIX}${path}${body}`);
    return new Response(JSON.stringify(await answer(path)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  log('');
  log('BlindPay dry run: @vindu/grid-blindpay against a mocked fetch (no network, placeholder credentials)');
  const adapter = createBlindPayAdapter(
    { apiKey: 'dry-run-placeholder', instanceId: 'in_demo', baseUrl: 'https://blindpay.invalid', fetch, now },
    // The USDC issuer this demo accepts: the throwaway issuer of the run.
    { network: 'stellar_testnet', assetIssuers: { USDC: usdcIssuer } },
  );

  const fundingQuote = await adapter.quoteFunding({
    customerId: 're_demo1',
    account,
    source: money('52500', BRL),
    targetAsset: world.usdc,
    rail: 'pix',
  });
  log(`  funding quote ${fundingQuote.id}: ${fmt(fundingQuote.source)} -> ${fmt(fundingQuote.target)}`);
  const funding = await adapter.createFunding({
    quote: fundingQuote,
    customerId: 're_demo1',
    account,
    transferId: 'demo-transfer-2',
    idempotencyKey: 'demo-transfer-2-funding',
  });
  log(`  payin ${funding.leg.id}: PIX code ${funding.pixCode ?? '(none)'}`);

  const payoutQuote = await adapter.quotePayout({
    customerId: 're_demo1',
    account,
    source: usdc('10000'),
    targetAsset: USD,
    rail: 'wire',
    beneficiaryId: 'ba_demo1',
  });
  log(`  payout quote ${payoutQuote.id}: ${fmt(payoutQuote.source)} -> ${fmt(payoutQuote.target)}`);

  // From payout_quoted: check the funds -> authorize -> store awaiting_signature
  // -> check state and quote -> sign once -> submit (hash checked)
  // -> store payout_submitted -> create
  let state: TransferState = 'payout_quoted';
  // A compare-and-set on the stored state, as the payout flow requires: the
  // move happens only if the transfer is still where this run left it.
  const store = (expected: TransferState, to: TransferState, reason: TransitionReason, detail: string): TransferState => {
    if (state !== expected) throw new StateConflictError('demo-transfer-2', expected, state);
    const rule = transition(state, to, reason);
    state = rule.to;
    log(`  ${rule.from} -> ${rule.to} (${rule.label}): ${detail}`);
    return state;
  };
  const result = await runStellarPayout({
    adapter,
    context: { transferId: 'demo-transfer-2', state: 'payout_quoted', quote: payoutQuote, account },
    // What the funding leg delivered: the payout quote may not move more.
    funded: usdc('10000'),
    idempotencyKey: 'demo-transfer-2-payout',
    now,
    signing: {
      signer: world.signer,
      submitter: createStellarSubmitter({ gateway: world.ledger, networkPassphrase: world.networkPassphrase, now }),
      destination: world.partner.treasuryAddress,
      onAuthorized: () =>
        store('payout_quoted', 'awaiting_signature', 'signed_payout_flow', 'BlindPay authorized, stored before signing'),
      onSubmitted: () => {
        store('awaiting_signature', 'payout_submitted', 'signed_and_on_chain', 'stored before BlindPay is told');
      },
    },
  });
  log(`  payout ${result.leg.id} created after a confirmed submit, tx ${short(result.txHash ?? '')}`);
  return { requests, payoutId: result.leg.id, txHash: result.txHash };
}

/** The JSON body with long values (XDR, addresses) shortened. */
function summarise(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const short = Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' && v.length > 24 ? `${v.slice(0, 8)}...` : v]),
  );
  return JSON.stringify(short);
}
