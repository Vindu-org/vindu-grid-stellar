/**
 * Scenario 2: submitting the same signed envelope twice moves the money
 * once. The second submit is recognised by its hash and reports the same
 * landed transaction.
 */
import { createStellarSubmitter, inspectSignedTransaction } from '@vindu/grid-stellar';

import { balanceOf, check, plus } from '../check';
import type { Report } from '../report';
import { Operation } from '../sdk';
import { SUBMIT_TIMINGS } from '../testnet';
import type { World } from '../world';

const AMOUNT = '3';

export async function resubmitScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver, asset } = world;
  const before = await testnet.settledAccount(receiver.publicKey());
  const startBalance = balanceOf(before, asset) ?? '0';

  const tx = testnet.build(sender, [
    Operation.payment({ destination: receiver.publicKey(), asset: world.sdkAsset, amount: AMOUNT }),
  ]);
  const signedXdr = testnet.sign(tx, sender);
  const info = inspectSignedTransaction(signedXdr, testnet.networkPassphrase);

  const submitter = createStellarSubmitter({
    gateway: testnet.gateway,
    networkPassphrase: testnet.networkPassphrase,
    logger: testnet.logger,
    ...SUBMIT_TIMINGS,
  });

  const first = await submitter.submit(signedXdr);
  check(first.status === 'success', `First submit ended ${first.status}`);
  check(first.hash === info.hash, 'First submit reported another hash');
  testnet.noteLanded(first.detail.ledger);
  report.step(`first submit: success in ledger ${String(first.detail.ledger)}, hash ${info.hash.slice(0, 12)}...`);

  // Horizon's own answer to the duplicate, without any lookup by hash.
  const raw = await testnet.submit(signedXdr, { maxWaitMs: 0 });
  const rawCode = raw.status === 'rejected' && raw.reason === 'refused' ? ` (${raw.error.transactionCode ?? raw.error.code})` : '';
  report.step(`Horizon's own answer to the same envelope again: ${raw.status}${rawCode}`);

  const second = await submitter.submit(signedXdr);
  check(second.status === 'success', `Second submit of the same envelope ended ${second.status}`);
  check(second.hash === info.hash, 'Second submit reported another hash');
  check(
    second.detail.ledger === undefined || first.detail.ledger === undefined || second.detail.ledger === first.detail.ledger,
    `Second submit reported ledger ${String(second.detail.ledger)}, the first ${String(first.detail.ledger)}`,
  );
  report.step(
    `second submit: success, same hash` +
      (second.detail.foundBy === undefined ? ' (Horizon answered with the landed result)' : ` (found by ${second.detail.foundBy})`),
  );

  const lookup = await testnet.gateway.transaction(info.hash);
  check(lookup.found && lookup.successful, 'The transaction should be found on Horizon as successful');

  // Money moved once: one sequence number used, one payment's worth arrived.
  const senderAfter = await testnet.settledAccount(sender.publicKey(), info.sequence);
  check(senderAfter.sequence === info.sequence, `Sender sequence ${senderAfter.sequence}, expected exactly ${info.sequence}`);
  const expected = plus(startBalance, AMOUNT);
  const held = await testnet.balanceReaches(receiver.publicKey(), asset, expected);
  check(held === expected, `Receiver holds ${String(held)}, expected ${expected}`);
  report.step(`receiver balance ${startBalance} -> ${expected}: paid once; sender sequence used once`);

  // A transaction that lands as failed: its sequence number is spent and
  // nothing moved. The submitter reads the landed result's own codes.
  const tooMuch = testnet.build(sender, [
    Operation.payment({ destination: receiver.publicKey(), asset: world.sdkAsset, amount: '1000000' }),
  ]);
  const failedXdr = testnet.sign(tooMuch, sender);
  const failedInfo = inspectSignedTransaction(failedXdr, testnet.networkPassphrase);
  const failed = await submitter.submit(failedXdr);
  check(failed.status === 'failed', `An underfunded payment ended ${failed.status}, not failed`);
  check(failed.detail.error?.code === 'underfunded', `The failure should carry op_underfunded, got ${JSON.stringify(failed.detail.error)}`);
  testnet.noteLanded(failed.detail.ledger);
  const failedAgain = await submitter.submit(failedXdr);
  check(failedAgain.status === 'failed', `Resubmitting the failed envelope ended ${failedAgain.status}, not failed`);
  check(failedAgain.detail.error?.code === 'underfunded', 'The resubmitted failure should keep its own codes');
  const senderAfterFailure = await testnet.settledAccount(sender.publicKey(), failedInfo.sequence);
  check(senderAfterFailure.sequence === failedInfo.sequence, 'The failed transaction should spend exactly its sequence number');
  const stillHeld = await testnet.balanceReaches(receiver.publicKey(), asset, expected);
  check(stillHeld === expected, `The failed payment moved money: receiver holds ${String(stillHeld)}`);
  report.step(
    `an underfunded payment landed as failed (${failed.detail.error.transactionCode ?? ''} ` +
      `${failed.detail.error.operationCodes.join(',')}), also on resubmit; nothing moved`,
  );
}
