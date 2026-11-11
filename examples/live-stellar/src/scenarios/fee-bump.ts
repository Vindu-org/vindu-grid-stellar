/**
 * Scenario 3: a fee bump is found by its outer hash and by its inner
 * transaction's hash. Submitting the bare inner envelope, or another fee
 * bump around the same inner transaction, after it landed reports the
 * landing and moves nothing more.
 */
import { inspectSignedTransaction } from '@vindu/grid-stellar';

import { balanceOf, check, plus } from '../check';
import type { Report } from '../report';
import { Operation, TransactionBuilder } from '../sdk';
import type { World } from '../world';

const AMOUNT = '2';

export async function feeBumpScenario(world: World, report: Report): Promise<void> {
  const { testnet, sender, receiver, feePayer, funder, asset } = world;
  const passphrase = testnet.networkPassphrase;
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
  check(byInner.hash === info.hash || byInner.hash === innerHash, 'The inner lookup returned an unrelated record');
  check(byInner.innerHash === innerHash, 'The inner lookup should name the inner hash');
  report.step(
    `lookup by outer hash: record hash ${byOuter.hash === info.hash ? 'outer' : 'inner'}; ` +
      `lookup by inner hash: record hash ${byInner.hash === info.hash ? 'outer' : 'inner'}, inner_transaction.hash inner`,
  );

  const again = await testnet.submit(bumpXdr);
  check(again.status === 'success' && again.hash === info.hash, `Resubmitting the fee bump ended ${again.status}`);

  // The bare inner envelope: it landed inside the fee bump.
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
  const wrapped = await testnet.submit(otherXdr);
  check(wrapped.status === 'success', `A second fee bump around the landed inner transaction ended ${wrapped.status}`);
  check(wrapped.foundBy === 'inner_hash', `The second fee bump should be found by its inner hash, got ${String(wrapped.foundBy)}`);
  check(wrapped.submittedHash === otherInfo.hash, 'The result should name the envelope that was submitted');
  report.step(`a second fee bump around the same inner transaction: success, found by inner_hash, nothing new sent`);

  const expected = plus(startBalance, AMOUNT);
  const held = await testnet.balanceReaches(receiver.publicKey(), asset, expected);
  check(held === expected, `Receiver holds ${String(held)}, expected ${expected}: paid more than once?`);
  report.step(`receiver balance ${startBalance} -> ${expected}: paid once over four submits`);
}
