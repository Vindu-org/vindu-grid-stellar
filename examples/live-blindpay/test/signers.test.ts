// Offline: builds transactions locally with throwaway keys, never touches a network.
import { type AccountRef, type Signer, type SigningContext, money, stellarAsset } from '@vindu/grid-core';
import { PayoutXdrMismatchError, TESTNET_NETWORK_PASSPHRASE, inspectSignedTransaction } from '@vindu/grid-stellar';

import { Account, Asset, FeeBumpTransaction, Keypair, Operation, TransactionBuilder } from '../src/sdk';
import { describeUnsignedPayout, feeBumpingSigner, lateSigner, observingSigner } from '../src/signers';
import { TestKeySigner } from '../src/test-key-signer';

const PASSPHRASE = TESTNET_NETWORK_PASSPHRASE;
const NOW = Date.parse('2026-11-11T03:00:00Z');
const client = Keypair.random();
const issuer = Keypair.random();
const usdb = stellarAsset('USDB', issuer.publicKey());
const account: AccountRef = { chain: 'stellar', address: client.publicKey() };
const context: SigningContext = {
  transferId: 't-1',
  state: 'awaiting_signature',
  quoteId: 'q-1',
  expiresAt: new Date(NOW + 300_000).toISOString(),
  // Development pays the USDB issuer itself.
  expected: { source: client.publicKey(), destination: issuer.publicKey(), amount: money('10', usdb) },
};

/** Shaped like a development authorize answer: one payment, fee 100, maxTime 30 s out, no memo. */
function unsigned(amount = '10'): string {
  return new TransactionBuilder(new Account(client.publicKey(), '41'), { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: issuer.publicKey(), asset: new Asset('USDB', issuer.publicKey()), amount }))
    .setTimebounds(0, Math.floor(NOW / 1000) + 30)
    .build()
    .toXDR();
}

const testKey = () => new TestKeySigner(client, PASSPHRASE, { now: () => NOW });

describe('describeUnsignedPayout', () => {
  it('reports the fields the findings are about', () => {
    expect(describeUnsignedPayout(unsigned(), PASSPHRASE)).toEqual({
      operations: 1, type: 'payment', destination: issuer.publicKey(), amount: '10.0000000', assetCode: 'USDB',
      assetIssuer: issuer.publicKey(), feeStroops: '100', minTime: 0, maxTime: Math.floor(NOW / 1000) + 30,
      memoType: 'none', source: client.publicKey(),
    });
  });
});

describe('observingSigner', () => {
  it('sees the XDR, then the real signer decides and signs once', async () => {
    const seen: string[] = [];
    let calls = 0;
    const inner: Signer = { custody: 'test_key', signStellar: async (...args) => { calls += 1; return testKey().signStellar(...args); } };
    const signer = observingSigner(inner, (xdr) => {
      seen.push(xdr);
      throw new Error('a broken observer never blocks or changes the signature');
    });
    const signed = await signer.signStellar(account, unsigned(), context);
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(inspectSignedTransaction(signed, PASSPHRASE).source).toBe(client.publicKey());
  });

  it('still refuses what the test-key signer refuses', async () => {
    await expect(observingSigner(testKey(), () => undefined).signStellar(account, unsigned('11'), context)).rejects.toThrow(PayoutXdrMismatchError);
  });
});

describe('feeBumpingSigner', () => {
  it('wraps the one checked payment in a fee bump paid by the same account', async () => {
    const bumped = await feeBumpingSigner(testKey(), client, PASSPHRASE, '200').signStellar(account, unsigned(), context);
    const envelope = TransactionBuilder.fromXDR(bumped, PASSPHRASE);
    expect(envelope).toBeInstanceOf(FeeBumpTransaction);
    const info = inspectSignedTransaction(bumped, PASSPHRASE);
    expect(info.innerHash).toBeDefined();
    expect(info.hash).not.toBe(info.innerHash);
    expect((envelope as InstanceType<typeof FeeBumpTransaction>).feeSource).toBe(client.publicKey());
  });

  it('never wraps a transaction the inner signer refused', async () => {
    await expect(feeBumpingSigner(testKey(), client, PASSPHRASE, '200').signStellar(account, unsigned('11'), context)).rejects.toThrow(PayoutXdrMismatchError);
  });
});

describe('lateSigner', () => {
  it('waits until past maxTime, then signs once with the inner checks', async () => {
    let t = NOW;
    const waits: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
    const signed = await lateSigner(testKey(), PASSPHRASE, clock, 5_000).signStellar(account, unsigned(), context);
    expect(waits).toEqual([35_000]);
    expect(inspectSignedTransaction(signed, PASSPHRASE).maxTime).toBe(Math.floor(NOW / 1000) + 30);
  });
});
