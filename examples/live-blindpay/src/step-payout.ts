/**
 * Step 4: Stellar payouts through `runStellarPayout`, the library's flow:
 * quote -> authorize -> onAuthorized (compare-and-set) -> the test-key signer
 * (assertPayoutXdrMatches, then sign once) -> submission -> create.
 *
 * Each scenario gets its own fresh quote and transaction; nothing is ever
 * signed twice. What it finds out:
 * (a) who submits: with `partner_submits` nothing here sends the transaction,
 *     so finding its hash on testnet afterwards means BlindPay submitted it;
 *     `client_submits` checks BlindPay also takes one already on the ledger;
 * (b) the create takes the signed envelope (the default `signed_xdr`);
 * (c) the time bounds and fee of the authorize transaction;
 * (d) the account it pays, across every quote of the run;
 * (e) a fee-bumped envelope;
 * (f) the single payout read (`readLeg`) and its statuses;
 * (g) the payout quote's `expires_at`.
 */
import { DEV_SENTINEL_AMOUNTS, runStellarPayout } from '@vindu/grid-blindpay';
import {
  GridError,
  type LegStatusValue,
  type Money,
  type PayoutSubmission,
  type Signer,
  compare,
  fiat,
  formatAmount,
  money,
  parseAmount,
} from '@vindu/grid-core';
import {
  InMemoryCursorStore,
  createReadLayer,
  createStellarSubmitter,
  inspectSignedTransaction,
  matchPaymentToLeg,
} from '@vindu/grid-stellar';
import { randomUUID } from 'node:crypto';

import { createBankAccount, listBankAccounts, mintUsdb } from './dev-endpoints';
import { type UnsignedPayoutFacts, describeUnsignedPayout, feeBumpingSigner, observingSigner } from './signers';
import { waitFor } from './step-setup';
import { TestKeySigner } from './test-key-signer';
import { NETWORK_PASSPHRASE, type World } from './world';

const STEP = '4 payout';
const USD = fiat('USD');
const BANK_ACCOUNT_NAME = 'live-blindpay test receiver';

/** Clearly fake US ACH details. Development instances skip the bank submission. */
const FAKE_ACH = {
  type: 'ach',
  name: BANK_ACCOUNT_NAME,
  recipient_relationship: 'vendor_or_supplier',
  beneficiary_name: 'Test Receiver',
  routing_number: '110000000',
  account_number: '000123456789',
  account_type: 'checking',
  account_class: 'individual',
  address_line_1: '1 Test Street',
  city: 'Testville',
  state_province_region: 'NY',
  country: 'US',
  postal_code: '10001',
} as const;

interface Scenario {
  readonly label: string;
  readonly amount: string;
  readonly submission: PayoutSubmission;
  readonly feeBump?: boolean;
  readonly expect: LegStatusValue;
  readonly step: string;
}

const SCENARIOS: readonly Scenario[] = [
  { label: 'partner_submits', amount: '10', submission: 'partner_submits', expect: 'completed', step: 'a who submits' },
  { label: 'client_submits', amount: '10', submission: 'client_submits', expect: 'completed', step: 'a who submits' },
  { label: 'fee bump', amount: '10', submission: 'partner_submits', feeBump: true, expect: 'completed', step: 'e fee bump' },
  { label: `sentinel ${DEV_SENTINEL_AMOUNTS.failed}`, amount: String(DEV_SENTINEL_AMOUNTS.failed / 100), submission: 'partner_submits', expect: 'failed', step: '3 sentinels' },
  { label: `sentinel ${DEV_SENTINEL_AMOUNTS.refunded}`, amount: String(DEV_SENTINEL_AMOUNTS.refunded / 100), submission: 'partner_submits', expect: 'refunded', step: '3 sentinels' },
];

export async function runPayouts(w: World): Promise<void> {
  const { account, usdb, keypair, customerId, payoutDestination } = w.found;
  if (account === undefined || usdb === undefined || keypair === undefined || customerId === undefined || payoutDestination === undefined) {
    throw new Error('setup did not finish');
  }

  // Funds: the payouts move about 1473 USDB; development mints test USDB.
  const need = SCENARIOS.reduce((sum, s) => sum + Number(s.amount), 0);
  const balance = await usdbBalance(w);
  if (Number(balance.amount) < need) {
    await mintUsdb(w.client, account.address, String(Math.ceil(need - Number(balance.amount)) + 10));
    await waitFor(w, async () => (Number((await usdbBalance(w)).amount) >= need ? true : undefined), 30_000);
  }
  const funded = await usdbBalance(w);
  if (!w.report.check(STEP, Number(funded.amount) >= need, `Test account holds ${funded.amount} USDB for the payouts (minted on development)`)) return;

  const bankAccountId = await bankAccount(w, customerId);
  w.found.bankAccountId = bankAccountId;
  w.report.pass(STEP, `Receiver: a fake ACH bank account ${bankAccountId}`);

  const destinations = new Set<string>();
  const facts: Array<{ scenario: string; facts: UnsignedPayoutFacts; maxTimeAfterNowSec: number | undefined; quoteLeftSec: number }> = [];
  let readLayerChecked = false;
  const submitter = createStellarSubmitter({ gateway: w.gateway, networkPassphrase: NETWORK_PASSPHRASE, timeoutMs: 20_000, maxWaitMs: 30_000 });

  for (const s of SCENARIOS) {
    const transferId = `live-payout-${randomUUID()}`;
    const adapter = w.adapter();
    const asked = w.now();
    const quote = await adapter.quotePayout({
      customerId, account, source: money(s.amount, usdb), targetAsset: USD, rail: 'ach', beneficiaryId: bankAccountId,
    });
    const ttlSec = Math.round((Date.parse(quote.expiresAt) - asked) / 1000);
    if (s === SCENARIOS[0]) {
      w.report.pass(STEP, `Payout quote: ${quote.source.amount} USDB -> ${quote.target.amount} USD`);
      w.report.finding('g quote ttl', `Payout quote expires_at is ${ttlSec} s after the request`);
    }
    w.store.set(transferId, 'payout_quoted');

    const testKey = new TestKeySigner(keypair, NETWORK_PASSPHRASE, { now: w.now });
    let signer: Signer = observingSigner(testKey, (unsignedXdr, context) => {
      const f = describeUnsignedPayout(unsignedXdr, NETWORK_PASSPHRASE);
      if (f.destination !== undefined) destinations.add(f.destination);
      facts.push({
        scenario: s.label,
        facts: f,
        maxTimeAfterNowSec: f.maxTime === undefined ? undefined : f.maxTime - Math.floor(w.now() / 1000),
        quoteLeftSec: Math.round((Date.parse(context.expiresAt) - w.now()) / 1000),
      });
    });
    if (s.feeBump === true) signer = feeBumpingSigner(signer, keypair, NETWORK_PASSPHRASE, '200');

    let signedXdr: string | undefined;
    let result: Awaited<ReturnType<typeof runStellarPayout>>;
    try {
      result = await runStellarPayout({
        adapter,
        context: { transferId, state: 'payout_quoted', quote, account },
        funded: await usdbBalance(w),
        signing: {
          signer,
          submission: s.submission,
          ...(s.submission === 'client_submits' ? { submitter } : {}),
          onAuthorized: () => w.store.cas(transferId, 'payout_quoted', 'awaiting_signature'),
          onSigned: (xdr) => {
            signedXdr = xdr;
          },
          ...(s.submission === 'client_submits'
            ? { onSubmitted: () => void w.store.cas(transferId, 'awaiting_signature', 'payout_submitted') }
            : {}),
        },
        idempotencyKey: randomUUID(),
        now: w.now,
        logger: w.logger,
      });
    } catch (e) {
      w.report.fail(s.step, `${s.label}: runStellarPayout stopped with ${describeError(e)}${signedXdr === undefined ? ', nothing signed' : ''}`);
      continue;
    }
    if (s.submission === 'partner_submits') w.store.cas(transferId, 'awaiting_signature', 'payout_submitted');
    const signed = inspectSignedTransaction(result.signedXdr ?? '', NETWORK_PASSPHRASE);
    w.report.pass(s.step, `${s.label}: runStellarPayout created the payout ${result.leg.id}, signed once, hash ${signed.hash}${signed.innerHash === undefined ? '' : ` (inner ${signed.innerHash})`}`);

    // On chain? With partner_submits nobody here sent it.
    const landed = await waitFor(w, async () => {
      const found = await w.gateway.transaction(signed.hash);
      return found.found ? found : undefined;
    }, 30_000);
    const landedOk = landed !== undefined && landed.successful;
    if (s.submission === 'partner_submits') {
      w.report.check(s.step, landedOk, `${s.label}: the transaction is on testnet, successful, and only BlindPay could have sent it`);
    } else {
      w.report.check(s.step, landedOk, `${s.label}: grid-stellar submitted it first and BlindPay still took the create`);
    }

    const leg = await waitFor(w, async () => {
      const read = await adapter.readLeg(result.leg);
      return ['completed', 'failed', 'refunded'].includes(read.status) ? read : undefined;
    }, 60_000, 5_000);
    w.report.check(s.step, leg?.status === s.expect, `${s.label}: readLeg (GET /payouts/{id}) says ${leg?.status ?? 'not final in 60 s'} (expected ${s.expect})`);
    if (leg !== undefined) {
      w.report.check(s.step, leg.txHash === signed.hash, `${s.label}: readLeg's txHash is the hash of the envelope BlindPay was given${s.feeBump === true ? ' (the outer fee-bump hash)' : ''}`);
      w.report.check(s.step, leg.amount !== undefined && compare(leg.amount, quote.source) === 0, `${s.label}: readLeg amount ${leg.amount?.amount ?? '?'} USDB is the quote's ${quote.source.amount}`);
    }

    if (!readLayerChecked && landedOk) {
      readLayerChecked = true;
      const layer = createReadLayer({ gateway: w.gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined, logger: w.logger });
      const window = await layer.reconcile(account.address);
      const expected = { legId: transferId, destination: payoutDestination, source: account.address, amount: quote.source, txHash: signed.hash };
      const matched = window.payments.filter((p) => matchPaymentToLeg(p, [expected], { requireSource: true }).status === 'matched');
      w.report.check(STEP, matched.length === 1, `Read layer matched the payout on testnet: source, destination, asset and issuer, exact amount, hash (${matched.length})`);
    }

    if (s.expect === 'refunded' && leg?.status === 'refunded') {
      const back = await waitFor(w, async () => {
        const layer = createReadLayer({ gateway: w.gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined });
        const window = await layer.reconcile(account.address);
        const refund = window.payments.find((p) => p.direction === 'incoming' && p.amount === quote.source.amount && p.from === payoutDestination);
        return refund;
      }, 30_000, 10_000);
      w.report.finding(s.step, back === undefined
        ? `A refunded Stellar payout sent nothing back on testnet within 30 s: ${quote.source.amount} USDB stays with BlindPay`
        : `A refunded Stellar payout sent ${back.amount} USDB back on testnet`);
    }
    if (s.expect === 'failed' && leg?.status === 'failed' && landedOk) {
      w.report.finding(s.step, `A failed payout still took the ${quote.source.amount} USDB on testnet (BlindPay submitted the transaction, then failed the payout)`);
    }
  }

  reportXdrFacts(w, facts, destinations, payoutDestination);
}

function reportXdrFacts(
  w: World,
  facts: ReadonlyArray<{ scenario: string; facts: UnsignedPayoutFacts; maxTimeAfterNowSec: number | undefined; quoteLeftSec: number }>,
  destinations: ReadonlySet<string>,
  payoutDestination: string,
): void {
  if (facts.length === 0) return;
  const fees = [...new Set(facts.map((f) => f.facts.feeStroops))].join(', ');
  const windows = facts.map((f) => f.maxTimeAfterNowSec).filter((x): x is number => x !== undefined);
  const minTimes = [...new Set(facts.map((f) => String(f.facts.minTime)))].join(', ');
  const memos = [...new Set(facts.map((f) => f.facts.memoType))].join(', ');
  const fits = facts.every((f) => f.maxTimeAfterNowSec !== undefined && f.maxTimeAfterNowSec <= f.quoteLeftSec);
  w.report.finding(
    'c time bounds',
    `Authorize XDR: one payment, fee ${fees} stroops, minTime ${minTimes}, memo ${memos}, ` +
      `maxTime ${range(windows)} s after signing; the quote had ${Math.min(...facts.map((f) => f.quoteLeftSec))} s or more left`,
  );
  w.report.check('c time bounds', fits, 'Every authorize maxTime is no later than its quote expiry (assertPayoutXdrMatches agreed before signing)');
  w.report.check(
    'd destination',
    destinations.size === 1 && destinations.has(payoutDestination),
    `Every one of ${facts.length} authorize transactions paid the same account, the configured payoutDestination ${payoutDestination}`,
  );
}

function range(values: readonly number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? String(lo) : `${lo} to ${hi}`;
}

async function usdbBalance(w: World): Promise<Money> {
  const usdb = w.found.usdb;
  const address = w.found.account?.address;
  if (usdb === undefined || address === undefined) throw new Error('setup did not finish');
  const account = await w.gateway.account(address);
  const line = account?.balances.find((b) => b.asset_code === usdb.code && b.asset_issuer === usdb.issuer);
  return money(line === undefined ? '0' : formatAmount(parseAmount(line.balance)), usdb);
}

async function bankAccount(w: World, customerId: string): Promise<string> {
  const existing = (await listBankAccounts(w.client, customerId)).find((b) => b.name === BANK_ACCOUNT_NAME && b.type === 'ach');
  if (existing !== undefined) return existing.id;
  const created = await createBankAccount(w.client, customerId, FAKE_ACH, randomUUID());
  return created.id;
}

/** Error class and code only: never the message, which may quote partner data. */
export function describeError(e: unknown): string {
  if (e instanceof GridError) {
    const extra = e as unknown as { stage?: unknown; causeCode?: unknown; status?: unknown };
    const parts = [e.name, e.code];
    if (typeof extra.stage === 'string') parts.push(`stage ${extra.stage}`);
    if (typeof extra.causeCode === 'string') parts.push(`cause ${extra.causeCode}`);
    if (typeof extra.status === 'number') parts.push(`HTTP ${extra.status}`);
    return parts.join(' ');
  }
  return e instanceof Error ? e.name : typeof e;
}
