/**
 * Scenario 3: a fee bump is found by its outer hash and by its inner
 * transaction's hash. Submitting the bare inner envelope, or another fee
 * bump around the same inner transaction, after it landed reports the
 * landing and moves nothing more.
 */
import { money } from '@vindu/grid-core';
import { InMemoryCursorStore, createReadLayer, inspectSignedTransaction, matchPaymentToLeg } from '@vindu/grid-stellar';

import { balanceOf, check, plus } from '../check';
import type { Report } from '../report';
import { waitFor } from '../retry';
import { Operation, TransactionBuilder } from '../sdk';
import type { World } from '../world';

const AMOUNT = '2';

export async function feeBumpScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver, feePayer, funder, asset } = world;
  const passphrase = testnet.networkPassphrase;
  /** What Horizon itself answers, without any lookup by hash. */
  const rawAnswer = async (xdr: string): Promise<string> => {
    const raw = await testnet.gateway.submitTransaction(xdr);
    if (raw.kind === 'accepted') {
      const which = raw.hash === info.hash ? 'the fee bump hash' : raw.hash === innerHash ? 'the inner hash' : 'another hash';
      return `accepted with ${which}`;
    }
    if (raw.kind === 'rejected') return `rejected ${raw.status} ${raw.transactionCode ?? ''} ${raw.operationCodes.join(',')}`.trim();
    return raw.kind;
  };
  const startBalance = balanceOf(await testnet.settledAccount(receiver.publicKey()), asset) ?? '0';

  const inner = testnet.build(sender, [
    Operation.payment({ destination: receiver.publicKey(), asset: world.sdkAsset, amount: AMOUNT }),
  ]);
  const innerXdr = testnet.sign(inner, sender);
  const bump = TransactionBuilder.buildFeeBumpTransaction(feePayer.publicKey(), '2000', inner, passphrase);
  const bumpXdr = testnet.sign(bump, feePayer);
  const info = inspectSignedTransaction(bumpXdr, passphrase);
  check(info.innerHash !== undefined, 'inspectSignedTransaction should give the inner hash of a fee bump');
  check(info.source === sender.publicKey(), 'The fee bump proof account should be the inner source');
  const innerHash = info.innerHash;

  const landed = await testnet.submit(bumpXdr);
  check(landed.status === 'success', `Fee bump submit ended ${landed.status}`);
  check(landed.hash === info.hash, 'The fee bump landed under another hash');
  report.step(`fee bump landed: outer ${info.hash.slice(0, 12)}..., inner ${innerHash.slice(0, 12)}...`);

  // Horizon finds the same transaction by either hash.
  const byOuter = await testnet.gateway.transaction(info.hash);
  const byInner = await testnet.gateway.transaction(innerHash);
  check(byOuter.found && byOuter.successful, 'Lookup by the outer hash found nothing');
  check(byInner.found && byInner.successful, 'Lookup by the inner hash found nothing');
  check(byOuter.innerHash === innerHash, 'The outer record should name the inner hash');
  // The envelope on the ledger is the fee bump, whichever hash found it.
  check(byInner.hash === info.hash, `The inner lookup should report the fee bump's hash, got ${byInner.hash === innerHash ? 'the inner hash' : 'another hash'}`);
  check(byInner.innerHash === innerHash, 'The inner lookup should name the inner hash');
  report.step(
    `lookup by outer hash: record hash ${byOuter.hash === info.hash ? 'outer' : 'inner'}; ` +
      `lookup by inner hash: record hash ${byInner.hash === info.hash ? 'outer' : 'inner'}, inner_transaction.hash inner`,
  );

  const again = await testnet.submit(bumpXdr);
  check(again.status === 'success' && again.hash === info.hash, `Resubmitting the fee bump ended ${again.status}`);

  // The bare inner envelope: it landed inside the fee bump.
  report.step(`Horizon's own answer to the bare inner envelope: ${await rawAnswer(innerXdr)}`);
  const bare = await testnet.submit(innerXdr);
  check(bare.status === 'success', `Submitting the bare inner envelope ended ${bare.status}`);
  check(bare.hash === info.hash || bare.hash === innerHash, 'The bare inner envelope reported an unrelated hash');
  report.step(
    `bare inner envelope after the fee bump landed: success` +
      (bare.foundBy === undefined ? ' (from Horizon)' : ` (found by ${bare.foundBy}${bare.submittedHash === undefined ? '' : ', landed under the fee bump hash'})`),
  );

  // Someone else's fee bump around the same inner transaction.
  const other = TransactionBuilder.buildFeeBumpTransaction(funder.publicKey(), '3000', inner, passphrase);
  const otherXdr = testnet.sign(other, funder);
  const otherInfo = inspectSignedTransaction(otherXdr, passphrase);
  check(otherInfo.hash !== info.hash && otherInfo.innerHash === innerHash, 'The second fee bump should share only the inner hash');
  report.step(`Horizon's own answer to a second fee bump around it: ${await rawAnswer(otherXdr)}`);
  const wrapped = await testnet.submit(otherXdr);
  check(wrapped.status === 'success', `A second fee bump around the landed inner transaction ended ${wrapped.status}`);
  check(wrapped.foundBy === 'inner_hash', `The second fee bump should be found by its inner hash, got ${String(wrapped.foundBy)}`);
  check(wrapped.submittedHash === otherInfo.hash, 'The result should name the envelope that was submitted');
  check(wrapped.hash === info.hash, `The result should carry the hash that landed (the first fee bump's), got ${wrapped.hash === innerHash ? 'the inner hash' : 'another hash'}`);
  report.step(`a second fee bump around the same inner transaction: success, found by inner_hash, nothing new sent`);

  // The payment on chain carries the fee bump's hash, so a leg that knows
  // the hash the submitter reported matches it.
  const seen = await waitFor(
    async () => {
      const { payments } = await createReadLayer({ gateway: testnet.gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined }).reconcile(receiver.publicKey());
      return payments.find((p) => p.txHash === info.hash || p.txHash === innerHash);
    },
    { attempts: 10, intervalMs: 1_500, sleep: testnet.sleep },
  );
  check(seen !== undefined, 'The fee-bumped payment was not found on the receiver');
  check(seen.txHash === info.hash, 'The fee-bumped payment should carry the fee bump hash');
  const leg = { legId: 'fee-bumped', destination: receiver.publicKey(), amount: money(AMOUNT, asset), txHash: wrapped.hash };
  const match = matchPaymentToLeg(seen, [leg]);
  check(match.status === 'matched', `The payment did not match a leg with the reported hash: ${JSON.stringify(match)}`);
  report.step('the payment record carries the fee bump hash and matches a leg holding the reported hash');
  // Finding, not a failure: when Horizon itself accepts the bare inner
  // envelope it answers with the inner hash, which the payment record does
  // not carry. Match such a leg by destination, asset and amount instead.
  if (bare.hash !== seen.txHash) {
    report.step('note: the bare inner envelope was reported under the inner hash; the payment record carries the fee bump hash');
  }

  const expected = plus(startBalance, AMOUNT);
  const held = await testnet.balanceReaches(receiver.publicKey(), asset, expected);
  check(held === expected, `Receiver holds ${String(held)}, expected ${expected}: paid more than once?`);
  report.step(`receiver balance ${startBalance} -> ${expected}: paid once over four submits`);
}
