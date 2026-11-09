import { money, stellarAsset } from '@vindu/grid-core';
import { TESTNET_NETWORK_PASSPHRASE, createStellarSubmitter } from '@vindu/grid-stellar';

import { FakeHorizon } from '../src/fake-horizon';
import { Keypair, TransactionBuilder } from '../src/sdk';
import { buildPaymentXdr } from '../src/stellar-tx';

const PASSPHRASE = TESTNET_NETWORK_PASSPHRASE;
const T0 = Date.parse('2026-11-09T12:00:00Z');

function setup() {
  let t = T0;
  const ledger = new FakeHorizon(PASSPHRASE, () => t);
  const client = Keypair.random();
  ledger.addAccount({ id: client.publicKey(), sequence: '100', subentry_count: 0, balances: [] });
  const usdc = stellarAsset('USDC', Keypair.random().publicKey());
  const signed = (maxTime: number) => {
    const xdr = buildPaymentXdr({
      source: client.publicKey(),
      sequence: '100',
      destination: Keypair.random().publicKey(),
      amount: money('10', usdc),
      maxTime,
      networkPassphrase: PASSPHRASE,
    });
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(client);
    return tx.toXDR();
  };
  const submitter = createStellarSubmitter({
    gateway: ledger,
    networkPassphrase: PASSPHRASE,
    pollIntervalMs: 5_000,
    maxWaitMs: 60_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { ledger, signed, submitter };
}

describe('FakeHorizon', () => {
  it('reports its own ingestion: the elder ledger, and the latest ledger on every lookup', async () => {
    const { ledger } = setup();
    expect(await ledger.latestLedger()).toMatchObject({ sequence: 1000, elderLedger: 1 });
    expect(await ledger.transaction('ab'.repeat(32))).toEqual({ found: false, latestLedger: 1000 });
  });

  it('finds a transaction that landed behind a 504, with the latest ledger it had ingested', async () => {
    const { ledger, signed, submitter } = setup();
    ledger.timeOutNextSubmission();
    const outcome = await submitter.submit(signed(Math.floor(T0 / 1000) + 300));
    expect(outcome).toMatchObject({ status: 'success', detail: { ledger: 1001 } });
    expect(ledger.lookups).toHaveLength(1);
  });
});
