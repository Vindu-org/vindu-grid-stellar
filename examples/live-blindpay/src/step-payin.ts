/**
 * Steps 2 and 3: PIX payins to the test wallet, through the adapter.
 *
 * `startPayins` quotes and creates them (the normal one and the two sentinel
 * amounts); `settlePayins` waits for each to reach a final status and, for
 * the completed one, checks with grid-stellar that the USDB arrived on
 * testnet with the amount the quote said.
 */
import { DEV_SENTINEL_AMOUNTS } from '@vindu/grid-blindpay';
import { type LegQuote, type LegRef, type LegStatusValue, fiat, money } from '@vindu/grid-core';
import { InMemoryCursorStore, createReadLayer, matchPaymentToLeg, partnerAndChainAgree } from '@vindu/grid-stellar';
import { randomUUID } from 'node:crypto';

import type { World } from './world';

const BRL = fiat('BRL');
const FINAL: readonly LegStatusValue[] = ['completed', 'failed', 'refunded'];

export interface StartedPayin {
  readonly label: string;
  readonly step: string;
  readonly expect: LegStatusValue;
  readonly quote: LegQuote;
  readonly leg: LegRef;
  /** When the payin was created, ms since epoch. */
  readonly createdAt: number;
}

/** The three payins: 100.00 BRL (completes), 666.00 (fails) and 777.00 (refunded). */
export async function startPayins(w: World): Promise<StartedPayin[]> {
  const plan = [
    { label: '100.00 BRL', step: '2 payin', amount: '100', expect: 'completed' as const },
    { label: `sentinel ${DEV_SENTINEL_AMOUNTS.failed}`, step: '3 sentinels', amount: String(DEV_SENTINEL_AMOUNTS.failed / 100), expect: 'failed' as const },
    { label: `sentinel ${DEV_SENTINEL_AMOUNTS.refunded}`, step: '3 sentinels', amount: String(DEV_SENTINEL_AMOUNTS.refunded / 100), expect: 'refunded' as const },
  ];
  const adapter = w.adapter();
  const account = w.found.account;
  const usdb = w.found.usdb;
  const customerId = w.found.customerId;
  if (account === undefined || usdb === undefined || customerId === undefined) throw new Error('setup did not finish');
  const started: StartedPayin[] = [];
  for (const p of plan) {
    const asked = w.now();
    const quote = await adapter.quoteFunding({ customerId, account, source: money(p.amount, BRL), targetAsset: usdb, rail: 'pix' });
    const ttlSec = Math.round((Date.parse(quote.expiresAt) - asked) / 1000);
    if (p.expect === 'completed') {
      w.report.pass(p.step, `Payin quote: ${quote.source.amount} BRL -> ${quote.target.amount} USDB, expires_at = now + ${ttlSec} s`);
      w.report.finding('g quote ttl', `Payin quote expires_at is ${ttlSec} s after the request (docs: about 5 minutes)`);
    }
    const funding = await adapter.createFunding({ quote, customerId, account, transferId: `live-payin-${randomUUID()}`, idempotencyKey: randomUUID() });
    w.report.check(p.step, funding.pixCode === '<development>', `Payin created for ${p.label}; PIX code is the development placeholder`);
    started.push({ ...p, quote, leg: funding.leg, createdAt: w.now() });
  }
  return started;
}

/** Waits for every payin to end, then checks each outcome. */
export async function settlePayins(w: World, payins: readonly StartedPayin[]): Promise<void> {
  const adapter = w.adapter();
  const startedAt = w.now();
  const final = new Map<string, Awaited<ReturnType<typeof adapter.readLeg>>>();
  let last = new Map<string, Awaited<ReturnType<typeof adapter.readLeg>>>();
  while (final.size < payins.length && w.now() - startedAt <= w.env.payinWaitMs) {
    last = new Map(last);
    for (const p of payins) {
      if (final.has(p.leg.id)) continue;
      const read = await adapter.readLeg(p.leg);
      last.set(p.leg.id, read);
      if (FINAL.includes(read.status)) final.set(p.leg.id, read);
    }
    if (final.size < payins.length) await w.sleep(15_000);
  }

  for (const p of payins) {
    let read = final.get(p.leg.id);
    if (read === undefined) {
      const raw = await w.client.payins.get(p.leg.id);
      if (raw.status === 'processing') {
        w.report.finding(
          p.step,
          `Payin ${p.label} still ${raw.status} ${Math.round((w.now() - p.createdAt) / 1000)} s after it was created (tracking: transaction ${raw.tracking_transaction?.step ?? '?'}, ` +
            `payment ${raw.tracking_payment?.step ?? '?'}, complete ${raw.tracking_complete?.step ?? '?'}); docs say about 30 s`,
        );
        continue;
      }
      // Not "still processing": it may have ended since the last poll, so read it once more.
      const again = await adapter.readLeg(p.leg);
      last.set(p.leg.id, again);
      if (!FINAL.includes(again.status) || again.status !== raw.status) {
        w.report.fail(p.step, `Payin ${p.label}: BlindPay's status is ${String(raw.status)} but readLeg says ${again.status}`);
        continue;
      }
      final.set(p.leg.id, again);
      read = again;
    }
    w.report.check(p.step, read.status === p.expect, `Payin ${p.label} ended ${read.status} (expected ${p.expect})`);
  }

  const normal = payins.find((p) => p.expect === 'completed');
  const done = normal === undefined ? undefined : final.get(normal.leg.id);
  const stillOpen = normal === undefined ? undefined : last.get(normal.leg.id);
  if (normal !== undefined) await checkDeliveryOnChain(w, normal, done?.status === 'completed' ? done : stillOpen);
}

/**
 * For a completed payin, the USDB must be on testnet: found by the read layer,
 * matched to the leg (account, asset and issuer, exact amount, hash), and the
 * partner's figure and the chain's must agree. For an open one, checks that
 * nothing arrived either.
 */
async function checkDeliveryOnChain(
  w: World,
  payin: StartedPayin,
  read: Awaited<ReturnType<ReturnType<World['adapter']>['readLeg']>> | undefined,
): Promise<void> {
  const step = '2 payin';
  const account = w.found.account;
  const usdb = w.found.usdb;
  if (account === undefined || usdb === undefined) return;
  const layer = createReadLayer({
    gateway: w.gateway,
    cursorStore: new InMemoryCursorStore(),
    onEvent: () => undefined,
    logger: w.logger,
  });
  const window = await layer.reconcile(account.address);
  const incoming = window.payments.filter((p) => p.direction === 'incoming' && p.asset.code === 'USDB' && p.asset.issuer === usdb.issuer);

  if (read?.status !== 'completed') {
    const delivery = incoming.find((p) => p.amount === payin.quote.target.amount);
    w.report.finding(
      step,
      delivery === undefined
        ? `No USDB delivery of ${payin.quote.target.amount} on testnet either (read layer saw ${incoming.length} incoming USDB payments, all from the test mints)`
        : `A USDB payment of ${payin.quote.target.amount} is on testnet although BlindPay still says ${String(read?.status)}`,
    );
    return;
  }
  const raw = await w.client.payins.get(payin.leg.id);
  w.report.info(step, `Payin amounts: sender ${String(raw.sender_amount)} BRL cents, receiver ${String(raw.receiver_amount)} USDB cents, transaction_fee_amount ${String(raw.transaction_fee_amount)}, partner_fee ${String(raw.partner_fee)}`);
  w.report.check(step, read.amount !== undefined && read.amount.amount === payin.quote.target.amount, `readLeg amount ${read.amount?.amount ?? '?'} USDB equals the quote's ${payin.quote.target.amount}`);
  // On EVM payins the delivery hash is in tracking_complete; for a Stellar
  // payin that is unconfirmed, and readLeg falls back to tracking_transaction.
  const sameHash = (h: unknown): boolean => typeof h === 'string' && read.txHash !== undefined && h.toLowerCase() === read.txHash.toLowerCase();
  if (read.txHash === undefined) {
    w.report.fail(step, 'readLeg carries no delivery hash for a completed payin');
  } else if (sameHash(raw.tracking_complete?.transaction_hash)) {
    w.report.pass(step, `readLeg's delivery hash ${read.txHash} is the payin's tracking_complete.transaction_hash`);
  } else if (sameHash(raw.tracking_transaction?.transaction_hash)) {
    w.report.finding(step, `A Stellar payin's delivery hash ${read.txHash} is in tracking_transaction, not tracking_complete: readLeg used its fallback`);
  } else {
    w.report.fail(step, `readLeg's delivery hash ${read.txHash} is in neither tracking field of the raw payin`);
  }
  const expected = { legId: payin.leg.id, destination: account.address, amount: payin.quote.target, ...(read.txHash === undefined ? {} : { txHash: read.txHash }) };
  const matches = window.payments.map((p) => ({ p, m: matchPaymentToLeg(p, [expected]) })).filter((x) => x.m.status === 'matched');
  const hit = matches[0];
  if (!w.report.check(step, matches.length === 1 && hit !== undefined, `Read layer found exactly one testnet payment matching the leg (${matches.length})`) || hit === undefined) return;
  w.report.info(step, `Delivery came from ${hit.p.from}`);
  if (read.amount === undefined) return;
  const agree = partnerAndChainAgree(read.amount, money(hit.p.amount, hit.p.asset), 0);
  w.report.check(step, agree.agree, `Partner and chain agree on ${hit.p.amount} USDB`);
}
