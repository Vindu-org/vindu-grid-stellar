/**
 * Scenario 1: the read layer delivers each payment to a registered account
 * exactly once, also across a restart that resumes from the saved cursor,
 * and matching links each payment to the right transfer leg.
 */
import { type ExpectedLeg, type ChainPayment, type CursorStore, createReadLayer, matchPaymentToLeg, partnerAndChainAgree } from '@vindu/grid-stellar';
import { money } from '@vindu/grid-core';

import { check } from '../check';
import type { Report } from '../report';
import { waitFor } from '../retry';
import { Memo, Operation } from '../sdk';
import { short } from '../testnet';
import type { World } from '../world';

/**
 * Stands in for the application's database: it outlives each read layer
 * instance, so a new instance resumes where the last one stored its cursor.
 */
class SavedCursors implements CursorStore {
  private readonly rows = new Map<string, string>();
  readonly writes: string[] = [];

  async get(account: string): Promise<string | undefined> {
    return this.rows.get(account);
  }

  async set(account: string, cursor: string): Promise<void> {
    this.rows.set(account, cursor);
    this.writes.push(cursor);
  }
}

interface Delivery {
  readonly instance: number;
  readonly payment: ChainPayment;
}

export async function readLayerScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver, asset, lookalike } = world;
  const account = receiver.publicKey();
  const cursors = new SavedCursors();
  const deliveries: Delivery[] = [];

  const startLayer = (instance: number) =>
    createReadLayer({
      gateway: testnet.gateway,
      cursorStore: cursors,
      logger: testnet.logger,
      onEvent: (payment) => {
        deliveries.push({ instance, payment });
      },
    });

  /** Polls until a payment with `txHash` was delivered, for a Horizon that may be a ledger behind. */
  const pollUntilSeen = async (layer: ReturnType<typeof startLayer>, txHash: string): Promise<ChainPayment> => {
    const seen = await waitFor(
      async () => {
        await layer.pollAccount(account);
        return deliveries.find((d) => d.payment.txHash === txHash)?.payment;
      },
      { attempts: 15, intervalMs: 2_000, sleep: testnet.sleep },
    );
    check(seen !== undefined, `The read layer never delivered the payment in ${txHash}`);
    return seen;
  };

  const pay = (amount: string, memo: string) =>
    testnet.land(
      `pay ${amount}`,
      sender,
      () => [Operation.payment({ destination: account, asset: world.sdkAsset, amount })],
      [sender],
      { memo: Memo.text(memo) },
    );

  // First instance: the account's history so far, then the first payment.
  const first = startLayer(1);
  const hashA = await pay('12.5', 'leg-a');
  const paymentA = await pollUntilSeen(first, hashA);
  const savedCursor = await cursors.get(account);
  check(savedCursor === paymentA.pagingToken, `The saved cursor should be the payment's paging token, got ${savedCursor}`);
  report.step(`instance 1 delivered ${deliveries.length} record(s), including 12.5 ${asset.code} in ${hashA.slice(0, 12)}...`);
  check(
    deliveries.some((d) => d.payment.type === 'create_account' && d.payment.to === account),
    'The account creation should be delivered as a create_account payment',
  );

  // Restart: a new instance with the same saved cursors, then a second payment.
  const second = startLayer(2);
  const hashB = await pay('7', 'leg-b');
  const paymentB = await pollUntilSeen(second, hashB);
  report.step(`instance 2 resumed from cursor ${savedCursor} and delivered 7 ${asset.code} in ${hashB.slice(0, 12)}...`);
  check(
    deliveries.filter((d) => d.instance === 2).every((d) => BigInt(d.payment.pagingToken) > BigInt(savedCursor)),
    'The restarted instance delivered a payment from before its saved cursor',
  );

  // Nothing new: both a further poll and a third instance deliver nothing.
  const again = await second.pollAccount(account);
  const third = await startLayer(3).pollAccount(account);
  check(again.delivered === 0 && third.delivered === 0, `Polls with nothing new delivered ${again.delivered} and ${third.delivered}`);

  const counts = new Map<string, number>();
  for (const d of deliveries) counts.set(d.payment.id, (counts.get(d.payment.id) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  check(repeated.length === 0, `Payments delivered more than once: ${repeated.join(', ')}`);
  check(counts.get(paymentA.id) === 1 && counts.get(paymentB.id) === 1, 'Each payment should be delivered exactly once');
  report.step(`${deliveries.length} deliveries over three instances, each operation id once; cursor writes ${cursors.writes.length}`);

  // The payments as the chain recorded them.
  for (const [p, amount, memo] of [
    [paymentA, '12.5', 'leg-a'],
    [paymentB, '7', 'leg-b'],
  ] as const) {
    check(p.direction === 'incoming' && p.from === sender.publicKey() && p.to === account, `${memo}: wrong direction or accounts`);
    check(p.asset.code === asset.code && p.asset.issuer === asset.issuer, `${memo}: wrong asset`);
    check(p.amount === amount, `${memo}: amount ${p.amount}, expected ${amount}`);
    check(p.memo === memo && p.memoType === 'text', `${memo}: memo ${String(p.memo)} (${String(p.memoType)})`);
  }

  // Reconcile re-reads the whole history without moving the saved cursor.
  const cursorBefore = await cursors.get(account);
  const reconciled = await startLayer(4).reconcile(account);
  check((await cursors.get(account)) === cursorBefore, 'reconcile moved the saved cursor');
  check(
    reconciled.payments.filter((p) => p.id === paymentA.id || p.id === paymentB.id).length === 2,
    'reconcile should list both payments once',
  );

  // Matching: each payment to its leg; a lookalike asset never matches.
  const legs: ExpectedLeg[] = [
    { legId: 'leg-a', destination: account, amount: money('12.5', asset), source: sender.publicKey(), reference: 'leg-a' },
    { legId: 'leg-b', destination: account, amount: money('7', asset), reference: 'leg-b' },
    { legId: 'lookalike', destination: account, amount: money('12.5', lookalike) },
  ];
  const matchA = matchPaymentToLeg(paymentA, legs);
  const matchB = matchPaymentToLeg(paymentB, legs);
  check(matchA.status === 'matched' && matchA.leg.legId === 'leg-a', `Payment A matched ${JSON.stringify(matchA.status)}`);
  check(matchB.status === 'matched' && matchB.leg.legId === 'leg-b', `Payment B matched ${JSON.stringify(matchB.status)}`);
  const lookalikeOnly = matchPaymentToLeg(paymentA, [legs[2]!]);
  check(
    lookalikeOnly.status === 'unmatched' && lookalikeOnly.mismatches[0]!.failed.includes('asset'),
    'The lookalike asset (same code, other issuer) should not match',
  );
  const agreement = partnerAndChainAgree(money('12.5', asset), money(paymentA.amount, paymentA.asset), 0);
  check(agreement.agree, 'The partner figure and the chain should agree exactly');
  report.step(
    `matched A to leg-a on ${matchA.matchedOn.join(', ')}; B to leg-b; ` +
      `lookalike issuer ${short(lookalike.issuer ?? '')} refused on asset`,
  );
}
