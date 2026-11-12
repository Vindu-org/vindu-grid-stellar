/**
 * The accounts and the test asset of one run.
 *
 * Friendbot funds one account, which creates the others. A throwaway issuer
 * issues the run's test asset; the sender and the receiver open trustlines
 * for it, and the sender gets a balance to pay with. Every key is new for
 * the run and lives only in these objects.
 */
import { type Asset, stellarAsset } from '@vindu/grid-core';
import { checkReceiveReadiness } from '@vindu/grid-stellar';

import { check } from './check';
import type { Report } from './report';
import { waitFor } from './retry';
import { Asset as SdkAsset, Keypair, Operation, type StellarSdk } from './sdk';
import { type Testnet, short } from './testnet';

/** Code of the run's test asset. Its issuer is new on every run. */
export const ASSET_CODE = 'LIVE';

/** Amount of the test asset issued to the sender. */
export const ISSUED = '1000';

/** Lumens each created account starts with. */
const STARTING_XLM = '50';

export interface World {
  readonly testnet: Testnet;
  /** Funded by friendbot; creates the others. */
  readonly funder: StellarSdk.Keypair;
  /** Issues the run's test asset. */
  readonly issuer: StellarSdk.Keypair;
  /** Holds the test asset and pays. */
  readonly sender: StellarSdk.Keypair;
  /** The registered account the read layer follows. */
  readonly receiver: StellarSdk.Keypair;
  /** Pays for fee bumps. */
  readonly feePayer: StellarSdk.Keypair;
  /** The test asset, as core sees it (code and issuer). */
  readonly asset: Asset;
  /** The same code from an issuer that never issued it: a different asset. */
  readonly lookalike: Asset;
  /** The test asset for the SDK's operations. */
  readonly sdkAsset: StellarSdk.Asset;
}

export async function createWorld(testnet: Testnet, report: Report): Promise<World> {
  const funder = Keypair.random();
  const issuer = Keypair.random();
  const sender = Keypair.random();
  const receiver = Keypair.random();
  const feePayer = Keypair.random();
  const lookalikeIssuer = Keypair.random();
  const asset = stellarAsset(ASSET_CODE, issuer.publicKey());
  const sdkAsset = new SdkAsset(ASSET_CODE, issuer.publicKey());

  await testnet.checkHorizon();
  report.step('Horizon serves the testnet passphrase');

  await testnet.friendbot(funder.publicKey());
  await testnet.load(funder);
  report.step(`friendbot funded ${short(funder.publicKey())}`);

  const created = [issuer, sender, receiver, feePayer];
  await testnet.land(
    'create accounts',
    funder,
    () => created.map((kp) => Operation.createAccount({ destination: kp.publicKey(), startingBalance: STARTING_XLM })),
    [funder],
  );
  for (const kp of created) await testnet.load(kp);
  report.step(
    `created issuer ${short(issuer.publicKey())}, sender ${short(sender.publicKey())}, ` +
      `receiver ${short(receiver.publicKey())}, fee payer ${short(feePayer.publicKey())}`,
  );

  const before = await checkReceiveReadiness(testnet.gateway, receiver.publicKey(), asset);
  check(!before.ready && before.issues.includes('no_trustline'), 'Before its trustline the receiver should not be ready');

  await testnet.land(
    'trustlines and issue',
    sender,
    () => [
      Operation.changeTrust({ asset: sdkAsset }),
      Operation.changeTrust({ asset: sdkAsset, source: receiver.publicKey() }),
      Operation.payment({ destination: sender.publicKey(), asset: sdkAsset, amount: ISSUED, source: issuer.publicKey() }),
    ],
    [sender, receiver, issuer],
  );
  // A load-balanced Horizon may answer from an instance a ledger behind.
  const ready = await waitFor(
    async () => {
      const r = await checkReceiveReadiness(testnet.gateway, receiver.publicKey(), asset, { checkReserve: true, amount: '100' });
      return r.ready ? r : undefined;
    },
    { attempts: 10, intervalMs: 1_500, sleep: testnet.sleep },
  );
  check(ready !== undefined, `checkReceiveReadiness should accept the receiver once it trusts ${ASSET_CODE}`);
  report.step(`issued ${ISSUED} ${ASSET_CODE} to the sender; trustlines open; checkReceiveReadiness ready`);

  return {
    testnet,
    funder,
    issuer,
    sender,
    receiver,
    feePayer,
    asset,
    lookalike: stellarAsset(ASSET_CODE, lookalikeIssuer.publicKey()),
    sdkAsset,
  };
}
