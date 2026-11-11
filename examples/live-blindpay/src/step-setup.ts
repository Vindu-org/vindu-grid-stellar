/**
 * Steps 0 and 1: the instance guard, a customer, and a throwaway Stellar
 * testnet account registered as the customer's blockchain wallet.
 */
import { checkReceiveReadiness, submitSignedTransaction } from '@vindu/grid-stellar';
import { stellarAsset } from '@vindu/grid-core';

import { createAssetTrustline, getInstanceType, listCustomers, mintUsdb } from './dev-endpoints';
import { Keypair, Transaction, TransactionBuilder } from './sdk';
import { FRIENDBOT_URL, NETWORK_PASSPHRASE, type World } from './world';

/** Step 0. Before any write: the instance must be a development one. Returns false to stop the run. */
export async function guardInstance(w: World): Promise<boolean> {
  const type = await getInstanceType(w.client);
  if (type !== 'development') {
    w.report.fail('0 instance', `The instance type is ${String(type)}, not development: refusing to write anything`);
    return false;
  }
  w.report.pass('0 instance', 'GET instance: type is development');
  return true;
}

/** Step 1. Returns false when the run cannot go on. */
export async function setUpAccount(w: World): Promise<boolean> {
  const step = '1 setup';
  const customers = await listCustomers(w.client);
  const customer = customers.find((c) => c.kyc_status === 'approved');
  if (customer === undefined) {
    w.report.fail(step, 'No approved customer on the instance: create one in the BlindPay dashboard first');
    return false;
  }
  w.found.customerId = customer.id;
  w.report.pass(step, `Picked an approved ${customer.type ?? ''} customer (${customer.country ?? '?'}) out of ${customers.length}`);

  const keypair = Keypair.random();
  const address = keypair.publicKey();
  w.found.keypair = keypair;
  const fb = await w.fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
  await fb.body?.cancel().catch(() => undefined);
  if (!w.report.check(step, fb.ok, `Friendbot funded a throwaway testnet account ${address} (HTTP ${fb.status})`)) return false;

  // The trustline: BlindPay builds it, the throwaway key signs it, grid-stellar submits it.
  const unsigned = await createAssetTrustline(w.client, address);
  const tx = TransactionBuilder.fromXDR(unsigned, NETWORK_PASSPHRASE);
  if (!(tx instanceof Transaction)) {
    w.report.fail(step, 'create-asset-trustline did not return a plain transaction');
    return false;
  }
  const op = tx.operations[0];
  if (tx.operations.length !== 1 || op?.type !== 'changeTrust' || !('code' in op.line) || tx.source !== address) {
    w.report.fail(step, 'create-asset-trustline returned something other than one changeTrust from the test account');
    return false;
  }
  const line = op.line as { code: string; issuer: string };
  if (line.code !== 'USDB') {
    w.report.fail(step, `The trustline is for ${line.code}, not USDB`);
    return false;
  }
  const usdb = stellarAsset('USDB', line.issuer);
  w.found.usdb = usdb;
  w.report.finding(
    step,
    `create-asset-trustline answers { xdr } with one changeTrust for USDB issued by ${line.issuer}, fee ${tx.fee} stroops, ` +
      `maxTime ${maxTimeFromNow(tx.timeBounds?.maxTime, w.now())}`,
  );
  tx.sign(keypair);
  const submitted = await submitSignedTransaction({
    gateway: w.gateway, signedXdr: tx.toXDR(), networkPassphrase: NETWORK_PASSPHRASE, timeoutMs: 30_000, maxWaitMs: 30_000,
  });
  if (!w.report.check(step, submitted.status === 'success', `Trustline submitted with grid-stellar: ${submitted.status} ${submitted.hash}`)) return false;

  const before = await checkReceiveReadiness(w.gateway, address, usdb);
  if (before.issues.includes('trustline_not_authorized')) {
    w.report.finding(step, 'The USDB issuer requires authorization: right after create-asset-trustline the trustline is not authorized (checkReceiveReadiness: trustline_not_authorized)');
  } else {
    w.report.info(step, `Readiness right after the trustline: ${before.ready ? 'ready' : before.issues.join(', ')}`);
  }
  await mintUsdb(w.client, address, '1');
  const after = await waitFor(w, async () => {
    const r = await checkReceiveReadiness(w.gateway, address, usdb);
    return r.ready && r.trustline?.balance !== '0' ? r : undefined;
  }, 30_000);
  if (!w.report.check(step, after !== undefined, 'mint-usdb-stellar (1 USDB) authorized the trustline and the USDB arrived (checkReceiveReadiness: ready)')) return false;
  if (!before.ready) w.report.finding(step, 'mint-usdb-stellar is what authorizes the trustline (the issuer is auth_required); create-asset-trustline alone leaves the account unable to hold USDB');

  const wallet = await w.client.blockchainWallets.create(w.found.customerId, {
    name: 'live-blindpay check', network: 'stellar_testnet', address, is_self_custody: true,
  });
  w.found.account = { chain: 'stellar', address, partnerAccountId: wallet.data.id };
  const shapeOk = wallet.data.network === 'stellar_testnet' && wallet.data.address === address && wallet.data.is_account_abstraction === true;
  w.report.check(step, shapeOk, `Registered the account as a stellar_testnet blockchain wallet ${wallet.data.id} (no ownership proof asked)`);
  w.report.finding(step, 'Stellar wallets take the direct-address flow only (is_account_abstraction: true): BlindPay checks the address format, no signature or proof of ownership');

  w.found.payoutDestination = w.env.payoutDestination ?? line.issuer;
  if (w.env.payoutDestination === undefined) {
    w.report.finding(step, 'BLINDPAY_PAYOUT_DESTINATION not set: payoutDestination is the USDB issuer, the account every development payout paid so far. In production take it from BlindPay in writing');
  }
  return shapeOk;
}

/** Polls `probe` until it returns a value or `timeoutMs` passes. */
export async function waitFor<T>(w: World, probe: () => Promise<T | undefined>, timeoutMs: number, everyMs = 3_000): Promise<T | undefined> {
  const until = w.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (w.now() >= until) return undefined;
    await w.sleep(everyMs);
  }
}

export function maxTimeFromNow(maxTime: string | number | undefined, nowMs: number): string {
  if (maxTime === undefined || Number(maxTime) === 0) return 'none';
  return `now + ${Number(maxTime) - Math.floor(nowMs / 1000)} s`;
}
