/**
 * Scenario 4: the sequence-based expiry proof against the real network.
 *
 * - An envelope with a maxTime a few seconds ahead is signed and never sent
 *   (the gateway "loses" every submission). Once a ledger closed after its
 *   maxTime, `submitSignedTransaction` proves it `expired_not_landed` from
 *   Horizon's ledger, a lookup by hash and the source account's sequence.
 * - A late real submission of such an envelope is refused by the network,
 *   and still proven expired.
 * - Once another transaction used that sequence number, the never-sent
 *   envelope is no longer proven expired: the answer is `unknown`.
 * - The converse: an envelope that landed is never reported expired, before
 *   or after its maxTime passed, and not by a Horizon that lost its history.
 */
import type { HorizonGateway, SubmitResult } from '@vindu/grid-stellar';

import { check } from '../check';
import type { Report } from '../report';
import { Operation } from '../sdk';
import { nowSeconds } from '../testnet';
import type { World } from '../world';

/** Seconds between building the short-lived envelope and its maxTime. */
const SHORT_LIFE_S = 5;
/** maxTime of the envelope that lands: long enough to submit, short enough to wait out. */
const LANDING_LIFE_S = 25;

/** The real gateway, except that a submission never leaves: it answers as a timed-out request. */
function losingSubmissions(gateway: HorizonGateway): HorizonGateway & { readonly attempts: number } {
  let attempts = 0;
  return {
    networkPassphrase: gateway.networkPassphrase,
    latestLedger: (o) => gateway.latestLedger(o),
    paymentsForAccount: (a, q, o) => gateway.paymentsForAccount(a, q, o),
    transaction: (h, o) => gateway.transaction(h, o),
    account: (a, o) => gateway.account(a, o),
    async submitTransaction() {
      attempts += 1;
      return { kind: 'timeout' };
    },
    get attempts() {
      return attempts;
    },
  };
}

/** Like {@link losingSubmissions}, on an instance that no longer keeps any transaction history. */
function withoutHistory(gateway: HorizonGateway): HorizonGateway {
  const losing = losingSubmissions(gateway);
  return {
    ...losing,
    networkPassphrase: gateway.networkPassphrase,
    submitTransaction: () => losing.submitTransaction(''),
    async transaction(hash, options) {
      const real = await gateway.transaction(hash, options);
      return { found: false, ...(real.latestLedger === undefined ? {} : { latestLedger: real.latestLedger }) };
    },
  };
}

function describe(result: SubmitResult): string {
  if (result.status === 'expired_not_landed') {
    return (
      `expired_not_landed: ledger ${result.checkedLedger.sequence} closed ${result.checkedLedger.closedAt} ` +
      `after maxTime ${new Date(result.maxTime * 1000).toISOString()}; source sequence ${result.sourceAccount.sequence} ` +
      `< ${result.transactionSequence} as of ledger ${result.sourceAccount.latestLedger}`
    );
  }
  return result.status;
}

/** Proof checks, quick: the submission is lost, so only lookups and reads run. */
const PROBE = { timeoutMs: 1_000, maxWaitMs: 45_000, pollIntervalMs: 3_000, resubmit: false } as const;

export async function expiryScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver } = world;
  const payment = (amount: string) =>
    Operation.payment({ destination: receiver.publicKey(), asset: world.sdkAsset, amount });

  // 4a: never sent. Built from a copy of the sequence, so the next real
  // transaction of the sender uses the same number.
  const maxTime = nowSeconds() + SHORT_LIFE_S;
  const neverSent = testnet.sign(testnet.build(sender, [payment('1')], { maxTime, detached: true }), sender);
  const losing = losingSubmissions(testnet.gateway);
  const early = await testnet.submit(neverSent, { ...PROBE, gateway: losing, maxWaitMs: 0 });
  check(early.status === 'unknown', `Before its maxTime a lost envelope should be unknown, got ${early.status}`);

  const closed = await testnet.ledgerClosedAfter(maxTime);
  report.step(`ledger ${closed.sequence} closed at ${closed.closedAt.toISOString()}, after maxTime ${new Date(maxTime * 1000).toISOString()}`);
  const proven = await testnet.submit(neverSent, { ...PROBE, gateway: losing });
  check(proven.status === 'expired_not_landed', `The never-sent envelope ended ${proven.status}, not expired_not_landed`);
  check(proven.maxTime === maxTime, 'The proof names another maxTime');
  check(Date.parse(proven.checkedLedger.closedAt) / 1000 > maxTime, 'The checked ledger did not close after maxTime');
  check(BigInt(proven.sourceAccount.sequence) < BigInt(proven.transactionSequence), 'The proof shows a used sequence');
  check(proven.sourceAccount.latestLedger >= proven.checkedLedger.sequence, 'The account read is older than the checked ledger');
  check(losing.attempts === 2, `The envelope should never leave; the lost-submission gateway saw ${losing.attempts} attempts`);
  report.step(`never-sent envelope: ${describe(proven)}`);

  // 4b: a late real submission of another envelope with the same short life.
  const lateMaxTime = nowSeconds() + 2;
  const late = testnet.sign(testnet.build(sender, [payment('1')], { maxTime: lateMaxTime, detached: true }), sender);
  await testnet.ledgerClosedAfter(lateMaxTime);
  const refused = await testnet.submit(late);
  check(refused.status === 'expired_not_landed', `A late real submission ended ${refused.status}, not expired_not_landed`);
  report.step(`late real submission: refused by the network, then ${describe(refused)}`);

  // 4c: the converse, an envelope that lands. It uses the sequence number
  // the never-sent envelope was built with.
  const landingMaxTime = nowSeconds() + LANDING_LIFE_S;
  const landing = testnet.sign(testnet.build(sender, [payment('1')], { maxTime: landingMaxTime }), sender);
  const landed = await testnet.submit(landing);
  check(landed.status === 'success', `The landing envelope ended ${landed.status}`);
  const checkNow = await testnet.submit(landing, { ...PROBE, gateway: losingSubmissions(testnet.gateway) });
  check(checkNow.status === 'success', `Re-checking the landed envelope before its maxTime gave ${checkNow.status}`);
  report.step(`landed in ledger ${String(landed.ledger)}; re-check before maxTime: success`);

  const reused = await testnet.submit(neverSent, { ...PROBE, gateway: losingSubmissions(testnet.gateway), maxWaitMs: 6_000 });
  // Unknown: the sequence number is used, and the proof cannot tell by what.
  // An instance that had not yet ingested the landing may still prove it
  // expired, which is also true: its maxTime passed before that ledger.
  const staleButTrue =
    reused.status === 'expired_not_landed' && landed.ledger !== undefined && reused.sourceAccount.latestLedger < landed.ledger;
  check(
    reused.status === 'unknown' || staleButTrue,
    `After its sequence number was used elsewhere the never-sent envelope gave ${describe(reused)}`,
  );
  report.step(`never-sent envelope after its sequence number was used by another transaction: ${reused.status}`);

  await testnet.ledgerClosedAfter(landingMaxTime);
  const afterLost = await testnet.submit(landing, { ...PROBE, gateway: losingSubmissions(testnet.gateway) });
  check(afterLost.status === 'success', `Re-checking the landed envelope after its maxTime gave ${afterLost.status}`);
  const afterReal = await testnet.submit(landing);
  check(afterReal.status === 'success', `Resubmitting the landed envelope after its maxTime gave ${afterReal.status}`);
  const pruned = await testnet.submit(landing, { ...PROBE, gateway: withoutHistory(testnet.gateway), maxWaitMs: 6_000 });
  check(pruned.status === 'unknown', `With no history, the landed envelope after its maxTime gave ${pruned.status}`);
  report.step('after its maxTime the landed envelope is still success (lookup and real resubmit), and unknown without history');
}
