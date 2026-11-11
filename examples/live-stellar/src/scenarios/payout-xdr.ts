/**
 * Scenario 5: `assertPayoutXdrMatches` accepts a real single-payment
 * transaction, built from the sender's live sequence number, and refuses
 * every tampered variant. The accepted one is then signed and lands.
 */
import { type SigningContext, money } from '@vindu/grid-core';
import {
  DEFAULT_MAX_FEE_STROOPS,
  type PayoutXdrCheck,
  PayoutXdrMismatchError,
  assertPayoutXdrMatches,
  createStellarSubmitter,
} from '@vindu/grid-stellar';

import { check, thrown } from '../check';
import type { Report } from '../report';
import { Asset as SdkAsset, Keypair, Operation, Transaction, TransactionBuilder } from '../sdk';
import { SUBMIT_TIMINGS, nowSeconds } from '../testnet';
import type { World } from '../world';

const AMOUNT = '25';

export async function payoutXdrScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver, feePayer, asset, lookalike } = world;
  const passphrase = testnet.networkPassphrase;
  await testnet.load(sender);
  const expiresAtS = nowSeconds() + 600;
  const maxTime = expiresAtS - 300;
  const context: SigningContext = {
    transferId: 'live-transfer-1',
    state: 'awaiting_signature',
    quoteId: 'live-quote-1',
    expiresAt: new Date(expiresAtS * 1000).toISOString(),
    expected: { source: sender.publicKey(), destination: receiver.publicKey(), amount: money(AMOUNT, asset) },
  };
  const options = { networkPassphrase: passphrase };

  const pay = (o: { destination?: string; amount?: string; asset?: InstanceType<typeof SdkAsset>; source?: string } = {}) =>
    Operation.payment({
      destination: o.destination ?? receiver.publicKey(),
      asset: o.asset ?? world.sdkAsset,
      amount: o.amount ?? AMOUNT,
      ...(o.source === undefined ? {} : { source: o.source }),
    });
  const tampered = (ops = [pay()], extra: { fee?: string; maxTime?: number } = {}) =>
    testnet.build(sender, ops, { maxTime: extra.maxTime ?? maxTime, detached: true, ...(extra.fee === undefined ? {} : { fee: extra.fee }) }).toXDR();

  const genuine = tampered();
  assertPayoutXdrMatches(genuine, context, options);
  report.step('accepted the real single-payment transaction');

  const overCapFee = String(DEFAULT_MAX_FEE_STROOPS + 1);

  const cases: ReadonlyArray<readonly [string, PayoutXdrCheck, string]> = [
    ['other destination', 'destination', tampered([pay({ destination: feePayer.publicKey() })])],
    ['other amount', 'amount', tampered([pay({ amount: '25.0000001' })])],
    [
      'same code, other issuer',
      'asset',
      tampered([pay({ asset: new SdkAsset(lookalike.code, lookalike.issuer ?? Keypair.random().publicKey()) })]),
    ],
    ['fee over the cap', 'fee', tampered([pay()], { fee: overCapFee })],
    ['no maxTime', 'max_time', tampered([pay()], { maxTime: 0 })],
    ['maxTime after the quote expires', 'max_time', tampered([pay()], { maxTime: expiresAtS + 1 })],
    ['an extra operation', 'operations', tampered([pay(), pay({ amount: '1' })])],
    ['the payment spends from another account', 'operation_source', tampered([pay({ source: feePayer.publicKey() })])],
    [
      'a fee bump around the real transaction',
      'fee_bump',
      TransactionBuilder.buildFeeBumpTransaction(
        feePayer.publicKey(),
        '1000',
        new Transaction(genuine, passphrase),
        passphrase,
      ).toXDR(),
    ],
  ];
  for (const [name, expected, xdr] of cases) {
    const error = thrown(() => assertPayoutXdrMatches(xdr, context, options), `${name}: accepted, should be refused`);
    check(error instanceof PayoutXdrMismatchError, `${name}: threw ${String(error)}, not PayoutXdrMismatchError`);
    check(error.check === expected, `${name}: refused on ${error.check}, expected ${expected}`);
  }
  report.step(`refused ${cases.length} tampered variants, each on the expected check: ${cases.map((c) => c[1]).join(', ')}`);

  // The checked transaction is the real thing: signed, it lands.
  const live = testnet.build(sender, [pay()], { maxTime });
  check(live.toXDR() === genuine, 'The transaction to sign should be the one that was checked');
  assertPayoutXdrMatches(live.toXDR(), context, options);
  const submitter = createStellarSubmitter({ gateway: testnet.gateway, networkPassphrase: passphrase, logger: testnet.logger, ...SUBMIT_TIMINGS });
  const outcome = await submitter.submit(testnet.sign(live, sender));
  check(outcome.status === 'success', `The checked payment ended ${outcome.status}`);
  testnet.noteLanded(outcome.detail.ledger);
  report.step(`signed the checked transaction and it landed in ledger ${String(outcome.detail.ledger)}`);
}
