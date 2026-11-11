import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvalidConfigError, InvalidInputError, canSignReplacement } from '@vindu/grid-core';
import { createHorizonGateway } from '../src/horizon';
import { TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { mapResultCodes } from '../src/result-codes';
import { stellarSdk } from '../src/sdk';
import { inspectSignedTransaction, submitSignedTransaction } from '../src/submit';
import { FakeGateway } from './fake-gateway';

const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = stellarSdk;

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

type Tx = ReturnType<InstanceType<typeof TransactionBuilder>['build']>;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * A real payment envelope signed with a throwaway key on the testnet
 * passphrase. No network. The source account is at `accountSequence`, so the
 * transaction's sequence number is one more (101 by default).
 */
function signedPayment(
  maxTimeSeconds: number,
  accountSequence = '100',
): { xdr: string; hash: string; tx: Tx; source: string } {
  const source = Keypair.random();
  const issuer = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(source.publicKey(), accountSequence), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: maxTimeSeconds },
  })
    .addOperation(
      Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset('USDC', issuer), amount: '25.5' }),
    )
    .build();
  tx.sign(source);
  return { xdr: tx.toXDR(), hash: hex(tx.hash()), tx, source: source.publicKey() };
}

/** `inner` wrapped in a fee bump paid and signed by a throwaway key. */
function feeBumped(inner: Tx, fee = '200'): { xdr: string; hash: string } {
  const feeSource = Keypair.random();
  const fb = TransactionBuilder.buildFeeBumpTransaction(feeSource, fee, inner, Networks.TESTNET);
  fb.sign(feeSource);
  return { xdr: fb.toXDR(), hash: hex(fb.hash()) };
}

/** Fake clock: `sleep` advances it. */
function clock(start = T0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

function run(gateway: FakeGateway, xdr: string, c = clock(), extra: Partial<Parameters<typeof submitSignedTransaction>[0]> = {}) {
  return submitSignedTransaction({
    gateway,
    signedXdr: xdr,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    timeoutMs: 1_000,
    pollIntervalMs: 5_000,
    maxWaitMs: 60_000,
    now: c.now,
    sleep: c.sleep,
    ...extra,
  });
}

const IN_ONE_HOUR = T0 / 1000 + 3600;

/** A ledger Horizon has ingested, closed at `seconds` (unix). */
const ledgerAt = (seconds: number, sequence = 100) => ({ sequence, closedAt: new Date(seconds * 1000) });

describe('submit', () => {
  it('computes the hash locally, equal to the SDK hash and the returned hash', async () => {
    const { xdr, hash, tx } = signedPayment(IN_ONE_HOUR);
    expect(inspectSignedTransaction(xdr, TESTNET_NETWORK_PASSPHRASE)).toEqual({
      hash,
      maxTime: IN_ONE_HOUR,
      source: tx.source,
      sequence: '101',
    });
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash, ledger: 7, successful: true }];
    const result = await run(gateway, xdr);
    expect(result).toEqual({ status: 'success', hash, ledger: 7 });
  });

  it('reads no maxTime from an envelope without an upper time bound', () => {
    const { xdr } = signedPayment(0);
    expect(inspectSignedTransaction(xdr, TESTNET_NETWORK_PASSPHRASE).maxTime).toBeUndefined();
  });

  it('success path submits once and never looks anything up', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash, successful: true }];
    expect((await run(gateway, xdr)).status).toBe('success');
    expect(gateway.submitted).toEqual([xdr]);
    expect(gateway.transactionLookups).toEqual([]);
  });

  it('timeout then hash found: success, with no second submission', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout', status: 504 }];
    gateway.transactions.set(hash, { found: true, hash, successful: true, ledger: 9 });
    const result = await run(gateway, xdr);
    expect(result).toEqual({ status: 'success', hash, ledger: 9, foundBy: 'hash' });
    expect(gateway.submitted).toEqual([xdr]);
    expect(gateway.transactionLookups).toEqual([hash]);
  });

  it('a submit call that hangs past timeoutMs is treated as a timeout and the hash is checked', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = ['hang'];
    gateway.transactions.set(hash, { found: true, hash, successful: true });
    const result = await run(gateway, xdr, clock(), { timeoutMs: 5 });
    expect(result).toEqual({ status: 'success', hash, foundBy: 'hash' });
  });

  it('a network error then a later landing: only the same signed envelope is ever resubmitted', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [new Error('socket hang up'), { kind: 'unavailable', status: 503 }];
    gateway.onLookup = (_h, count) => {
      if (count === 3) gateway.transactions.set(hash, { found: true, hash, successful: true });
    };
    const result = await run(gateway, xdr);
    expect(result.status).toBe('success');
    expect(gateway.submitted.length).toBeGreaterThan(1);
    expect(new Set(gateway.submitted)).toEqual(new Set([xdr]));
  });

  it('timeout then never found before maxTime: unknown, never expired_not_landed', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const c = clock();
    const result = await run(gateway, xdr, c);
    expect(result).toEqual({ status: 'unknown', hash });
    expect(c.now()).toBeGreaterThanOrEqual(T0 + 60_000);
    expect(c.now()).toBeLessThan(IN_ONE_HOUR * 1000);
  });

  it('timeout on an envelope without maxTime: unknown, never expired_not_landed', async () => {
    const { xdr } = signedPayment(0);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const result = await run(gateway, xdr, clock(), { maxWaitMs: 10 * 60_000 });
    expect(result.status).toBe('unknown');
  });

  it('a failing hash lookup never counts as not found', async () => {
    const maxTime = T0 / 1000 - 3600;
    const { xdr } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.ledger = ledgerAt(T0 / 1000);
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transaction = async () => {
      throw new Error('horizon down');
    };
    const result = await run(gateway, xdr);
    expect(result.status).toBe('unknown');
  });

  it('found in a ledger as failed: failed', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash, successful: false, ledger: 3 });
    expect(await run(gateway, xdr)).toEqual({ status: 'failed', hash, ledger: 3, foundBy: 'hash' });
  });

  it('maps tx_bad_seq to a typed rejection after checking the hash', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    const result = await run(gateway, xdr);
    expect(result).toEqual({
      status: 'rejected',
      reason: 'refused',
      hash,
      error: { code: 'bad_seq', transactionCode: 'tx_bad_seq', operationCodes: [] },
    });
    expect(gateway.transactionLookups).toEqual([hash]);
  });

  it('tx_bad_seq on an envelope that already landed is a success', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    gateway.transactions.set(hash, { found: true, hash, successful: true });
    expect((await run(gateway, xdr)).status).toBe('success');
  });

  it('maps tx_too_late: rejected until an ingested ledger closed after maxTime, expired_not_landed then', async () => {
    const maxTime = T0 / 1000 - 10;
    const { xdr, hash, source } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_too_late', operationCodes: [] }];
    // The local clock is far past maxTime; Horizon has not ingested a later ledger.
    gateway.ledger = ledgerAt(maxTime - 1);
    expect(await run(gateway, xdr, clock(T0 + 3_600_000))).toMatchObject({
      status: 'rejected',
      reason: 'refused',
      error: { code: 'too_late' },
    });

    gateway.ledger = ledgerAt(maxTime + 5, 101);
    expect(await run(gateway, xdr)).toEqual({
      status: 'expired_not_landed',
      hash,
      maxTime,
      transactionSequence: '101',
      checkedLedger: { sequence: 101, closedAt: new Date((maxTime + 5) * 1000).toISOString() },
      sourceAccount: { id: source, sequence: '100', latestLedger: 101 },
    });
  });

  it('maps operation failures to typed codes', async () => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'rejected', status: 400, transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] },
    ];
    expect(await run(gateway, xdr)).toMatchObject({ status: 'rejected', error: { code: 'underfunded' } });
  });

  it('rejects invalid options and envelopes before sending anything', async () => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    await expect(run(gateway, xdr, clock(), { timeoutMs: 0 })).rejects.toThrow(InvalidInputError);
    await expect(run(gateway, 'not-xdr')).rejects.toThrow(InvalidInputError);
    expect(gateway.submitted).toEqual([]);
  });

  it.each([
    ['timeoutMs', Number.NaN],
    ['timeoutMs', Number.POSITIVE_INFINITY],
    ['timeoutMs', 2 ** 31],
    ['pollIntervalMs', Number.NaN],
    ['pollIntervalMs', Number.POSITIVE_INFINITY],
    ['pollIntervalMs', 0],
    ['maxWaitMs', Number.NaN],
    ['maxWaitMs', Number.POSITIVE_INFINITY],
    ['maxWaitMs', -1],
  ] as const)('fails closed on %s = %p', async (name, value) => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    await expect(run(gateway, xdr, clock(), { [name]: value })).rejects.toThrow(InvalidInputError);
    expect(gateway.submitted).toEqual([]);
  });

  it('refuses a passphrase that differs from the gateway, before sending anything', async () => {
    // Review probe: an envelope signed for testnet, submitted with the mainnet
    // passphrase, hashes differently, so a landed transaction looked missing.
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    await expect(run(gateway, xdr, clock(), { networkPassphrase: Networks.PUBLIC })).rejects.toThrow(InvalidConfigError);
    gateway.networkPassphrase = Networks.PUBLIC;
    await expect(run(gateway, xdr)).rejects.toThrow(InvalidConfigError);
    expect(gateway.submitted).toEqual([]);
    expect(gateway.transactionLookups).toEqual([]);
  });

  it('fails closed on a clock that returns NaN, before sending anything', async () => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    await expect(run(gateway, xdr, clock(), { now: () => Number.NaN })).rejects.toThrow(InvalidInputError);
    expect(gateway.submitted).toEqual([]);
  });

  it('ends the wait with unknown when the clock breaks mid-way', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    let calls = 0;
    const result = await run(gateway, xdr, clock(), { now: () => (++calls > 2 ? Number.NaN : T0) });
    expect(result).toMatchObject({ status: 'unknown', hash });
  });
});

describe('submit: expiry is decided by the ingested ledger', () => {
  const maxTime = T0 / 1000 + 60;

  it('expired_not_landed once a ledger closed after maxTime, the lookup finds nothing and the sequence is unused', async () => {
    const { xdr, hash, source } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime + 6, 77);
    const result = await run(gateway, xdr);
    expect(result).toEqual({
      status: 'expired_not_landed',
      hash,
      maxTime,
      transactionSequence: '101',
      checkedLedger: { sequence: 77, closedAt: new Date((maxTime + 6) * 1000).toISOString() },
      sourceAccount: { id: source, sequence: '100', latestLedger: 77 },
    });
    // Nothing is read before submitting; the ledger is read before the lookup.
    expect(gateway.ledgerReads).toEqual([0]);
    expect(gateway.transactionLookups).toEqual([hash]);
    expect(gateway.accountReads).toEqual([source]);
  });

  it('Horizon lagging behind the local clock: unknown, then success when it ingests the landing', async () => {
    // Review probe: the local clock is minutes past maxTime, but Horizon has
    // not ingested a ledger after maxTime. The old local-clock rule declared
    // expired_not_landed here; the transaction then showed up.
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime - 2);
    const late = clock(T0 + 10 * 60_000);
    expect(await run(gateway, xdr, late, { maxWaitMs: 5 * 60_000 })).toEqual({ status: 'unknown', hash });

    gateway.onLookup = (_h, count) => {
      if (count >= 3) gateway.transactions.set(hash, { found: true, hash, successful: true, ledger: 99 });
    };
    gateway.transactionLookups.length = 0;
    expect(await run(gateway, xdr, clock(T0 + 20 * 60_000), { maxWaitMs: 5 * 60_000 })).toEqual({
      status: 'success',
      hash,
      ledger: 99,
      foundBy: 'hash',
    });
  });

  it('a ledger closed exactly at maxTime is not past it: the transaction could still be in the next one', async () => {
    const { xdr, source } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime);
    expect((await run(gateway, xdr)).status).toBe('unknown');
  });

  it('the lookup that settles expiry is made after the ledger read', async () => {
    // Horizon ingests the ledger holding the transaction and a later one
    // between two polls. Reading the ledger first means the lookup sees the
    // transaction; looking up first would have declared it expired.
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime - 5);
    const read = gateway.latestLedger.bind(gateway);
    gateway.latestLedger = async () => {
      if (gateway.ledgerReads.length === 1) {
        gateway.ledger = ledgerAt(maxTime + 5);
        gateway.transactions.set(hash, { found: true, hash, successful: true, ledger: 12 });
      }
      return read();
    };
    expect(await run(gateway, xdr)).toEqual({ status: 'success', hash, ledger: 12, foundBy: 'hash' });
  });

  it('a ledger that moves past maxTime during the wait settles as expired_not_landed', async () => {
    const { xdr, hash, source } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime - 30);
    gateway.onLookup = (_h, count) => {
      if (count === 3) gateway.ledger = ledgerAt(maxTime + 1);
    };
    expect(await run(gateway, xdr)).toMatchObject({ status: 'expired_not_landed', hash });
    expect(gateway.transactionLookups.length).toBe(4);
  });

  it('a failing latest-ledger read never counts as expired', async () => {
    const { xdr, hash, source } = signedPayment(T0 / 1000 - 3600);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = new Error('horizon down');
    expect(await run(gateway, xdr, clock(T0 + 86_400_000))).toEqual({ status: 'unknown', hash });
  });

  it('an unusable latest ledger never counts as expired', async () => {
    const { xdr } = signedPayment(T0 / 1000 - 3600);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = { sequence: 5, closedAt: new Date(Number.NaN) };
    expect((await run(gateway, xdr)).status).toBe('unknown');
    gateway.ledger = { sequence: Number.NaN, closedAt: new Date(T0) };
    expect((await run(gateway, xdr)).status).toBe('unknown');
  });

  it('a transaction without maxTime never reads the ledger or the account and is never expired', async () => {
    const { xdr, source } = signedPayment(0);
    const gateway = new FakeGateway();
    gateway.setAccount(source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(T0 / 1000 + 10 * 365 * 86_400);
    expect((await run(gateway, xdr, clock(), { maxWaitMs: 10 * 60_000 })).status).toBe('unknown');
    expect(gateway.ledgerReads).toEqual([]);
    expect(gateway.accountReads).toEqual([]);
  });
});

describe('submit: hash mismatch', () => {
  it('an accepted answer with another hash is rejected as hash_mismatch, never success', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const other = 'ab'.repeat(32);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: other, ledger: 7, successful: true }];
    const errors: string[] = [];
    const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) };
    const result = await run(gateway, xdr, clock(), { logger });
    expect(result).toEqual({ status: 'rejected', reason: 'hash_mismatch', hash, returnedHash: other });
    expect(result.status).not.toBe('success');
    expect(errors).toEqual(['Horizon returned a different hash']);
  });

  it('a fee bump accepted under its inner hash is a mismatch: Horizon answers with the outer hash', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: inner.hash, successful: true }];
    expect(await run(gateway, ours.xdr)).toEqual({
      status: 'rejected',
      reason: 'hash_mismatch',
      hash: ours.hash,
      innerHash: inner.hash,
      returnedHash: inner.hash,
    });
  });

  it('a resubmission accepted under another hash is a mismatch too', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }, { kind: 'accepted', hash: 'cd'.repeat(32), successful: false }];
    expect(await run(gateway, xdr)).toMatchObject({ status: 'rejected', reason: 'hash_mismatch', hash });
  });

  it('accepts the same hash in upper case', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: hash.toUpperCase(), successful: true }];
    expect(await run(gateway, xdr)).toEqual({ status: 'success', hash });
  });
});

describe('submit: fee bumps', () => {
  it('computes both the outer and the inner hash', () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    expect(inspectSignedTransaction(ours.xdr, TESTNET_NETWORK_PASSPHRASE)).toEqual({
      hash: ours.hash,
      innerHash: inner.hash,
      maxTime: IN_ONE_HOUR,
      // The inner transaction's: the fee source spends no sequence number.
      source: inner.tx.source,
      sequence: '101',
    });
  });

  it('reads the base account of a muxed source', () => {
    const source = Keypair.random();
    const muxed = new stellarSdk.MuxedAccount(new Account(source.publicKey(), '41'), '7');
    const tx = new TransactionBuilder(muxed, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: IN_ONE_HOUR },
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '50' }))
      .build();
    tx.sign(source);
    expect(tx.source.startsWith('M')).toBe(true);
    expect(inspectSignedTransaction(tx.toXDR(), TESTNET_NETWORK_PASSPHRASE)).toMatchObject({
      source: source.publicKey(),
      sequence: '42',
    });
  });

  it('looks up the outer hash, then the inner hash', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const result = await run(gateway, ours.xdr, clock(), { maxWaitMs: 1_000 });
    expect(result).toEqual({ status: 'unknown', hash: ours.hash, innerHash: inner.hash });
    expect(gateway.transactionLookups).toEqual([ours.hash, inner.hash]);
  });

  it('our own fee bump found by its outer hash: success', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(ours.hash, { found: true, hash: ours.hash, successful: true, ledger: 7 });
    expect(await run(gateway, ours.xdr)).toEqual({
      status: 'success',
      hash: ours.hash,
      innerHash: inner.hash,
      ledger: 7,
      foundBy: 'hash',
    });
  });

  it('accepted fee bump reports both hashes', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: ours.hash, successful: true, ledger: 4 }];
    expect(await run(gateway, ours.xdr)).toEqual({ status: 'success', hash: ours.hash, innerHash: inner.hash, ledger: 4 });
  });

  it('the same inner transaction landed inside someone else\'s fee bump: success under the hash that landed', async () => {
    // Review probe: our envelope is refused, a third party re-wraps the same
    // signed inner transaction in its own fee bump and that lands. Horizon
    // finds it by the inner hash and reports the other envelope's hash.
    const inner = signedPayment(T0 / 1000 + 60);
    const ours = feeBumped(inner.tx);
    const theirs = feeBumped(inner.tx, '500');
    const record = { found: true as const, hash: theirs.hash, innerHash: inner.hash, successful: true, ledger: 7 };
    const gateway = new FakeGateway();
    gateway.transactions.set(theirs.hash, record);
    gateway.transactions.set(inner.hash, record);
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    gateway.ledger = ledgerAt(T0 / 1000 + 120);
    const result = await run(gateway, ours.xdr, clock(T0 + 120_000));
    expect(result).toEqual({
      status: 'success',
      hash: theirs.hash,
      innerHash: inner.hash,
      ledger: 7,
      foundBy: 'inner_hash',
      submittedHash: ours.hash,
    });
    expect(gateway.transactionLookups).toEqual([ours.hash, inner.hash]);
  });

  it('a fee bump expires only when neither hash is found after the ledger passed maxTime', async () => {
    const inner = signedPayment(T0 / 1000 + 60);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.setAccount(inner.source, '100');
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(T0 / 1000 + 61);
    expect(await run(gateway, ours.xdr)).toMatchObject({
      status: 'expired_not_landed',
      hash: ours.hash,
      innerHash: inner.hash,
    });
    expect(gateway.transactionLookups).toEqual([ours.hash, inner.hash]);
  });

  it('inner hash found after a timeout, never expired_not_landed', async () => {
    const inner = signedPayment(T0 / 1000 + 60);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(T0 / 1000 + 120);
    gateway.onLookup = (h) => {
      if (h === inner.hash) gateway.transactions.set(inner.hash, { found: true, hash: inner.hash, successful: false });
    };
    const result = await run(gateway, ours.xdr, clock(), { maxWaitMs: 600_000 });
    expect(result).toMatchObject({ status: 'failed', hash: inner.hash, foundBy: 'inner_hash', submittedHash: ours.hash });
  });

  it('a plain transaction wrapped by someone else\'s fee bump is found by its own hash', async () => {
    const plain = signedPayment(IN_ONE_HOUR);
    const theirs = feeBumped(plain.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(plain.hash, { found: true, hash: theirs.hash, innerHash: plain.hash, successful: true, ledger: 2 });
    expect(await run(gateway, plain.xdr)).toEqual({
      status: 'success',
      hash: theirs.hash,
      ledger: 2,
      foundBy: 'hash',
      submittedHash: plain.hash,
    });
  });

  it('a failing inner lookup never counts as not found', async () => {
    const inner = signedPayment(T0 / 1000 - 3600);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.ledger = ledgerAt(T0 / 1000);
    gateway.submitResponses = [{ kind: 'timeout' }];
    const lookup = gateway.transaction.bind(gateway);
    gateway.transaction = async (h) => {
      if (h === inner.hash) throw new Error('horizon down');
      return lookup(h);
    };
    expect((await run(gateway, ours.xdr)).status).toBe('unknown');
  });
});

describe('submit result code mapping', () => {
  it.each([
    ['tx_bad_seq', [], 'bad_seq'],
    ['tx_too_late', [], 'too_late'],
    ['tx_too_early', [], 'too_early'],
    ['tx_insufficient_fee', [], 'insufficient_fee'],
    ['tx_bad_auth', [], 'bad_auth'],
    ['tx_failed', ['op_success', 'op_no_trust'], 'no_trust'],
    ['tx_failed', ['op_underfunded'], 'underfunded'],
    ['tx_failed', ['op_line_full'], 'line_full'],
    ['tx_failed', ['op_under_dest_min'], 'path_failed'],
    ['tx_fee_bump_inner_failed', ['op_no_destination'], 'no_destination'],
    ['tx_failed', [], 'failed'],
    ['tx_something_new', [], 'other'],
  ] as const)('%s %j -> %s', (tx, ops, code) => {
    expect(mapResultCodes(tx, ops).code).toBe(code);
  });

  it('drops anything that is not a short result code', () => {
    const error = mapResultCodes('tx_failed', ['op_underfunded', 'AAAA{"envelope_xdr":"..."}']);
    expect(error).toEqual({ code: 'underfunded', transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] });
    expect(mapResultCodes('<html>', [])).toEqual({ code: 'other', operationCodes: [] });
  });
});

describe('submit: the source account sequence proves expiry', () => {
  const maxTime = T0 / 1000 + 60;

  /** A timed-out submission with an ingested ledger past maxTime and an unused sequence: expiry hinges on the proof. */
  function pastMaxTime(accountSequence = '100') {
    const { xdr, hash, source } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime + 6, 77);
    gateway.setAccount(source, accountSequence);
    return { xdr, hash, source, gateway };
  }

  it('the proof holds: expired_not_landed', async () => {
    const { xdr, gateway } = pastMaxTime();
    const result = await run(gateway, xdr);
    expect(result.status).toBe('expired_not_landed');
    expect(canSignReplacement(result)).toBe(true);
  });

  it('a used sequence number with nothing found is unknown, never expired_not_landed', async () => {
    // A transaction that landed used its sequence number. The instance may
    // no longer keep its history, so a lookup finding nothing proves nothing.
    for (const used of ['101', '102', '9000']) {
      const { xdr, hash, gateway } = pastMaxTime(used);
      const result = await run(gateway, xdr);
      expect(result).toEqual({ status: 'unknown', hash });
      expect(canSignReplacement(result)).toBe(false);
    }
  });

  it('a missing source account is unknown', async () => {
    const { xdr, hash, source, gateway } = pastMaxTime();
    gateway.accounts.delete(source);
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    expect(gateway.accountReads.length).toBeGreaterThan(0);
  });

  it('an account read from an instance behind the checked ledger is unknown', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    gateway.accountLedger = 76;
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    gateway.accountLedger = 77;
    expect((await run(gateway, xdr)).status).toBe('expired_not_landed');
  });

  it('an account read without a Latest-Ledger header is unknown', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    gateway.accountLedger = null;
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
  });

  it('an account read that fails, hangs, or answers for another account is unknown', async () => {
    const { xdr, hash, source, gateway } = pastMaxTime();
    const read = gateway.account.bind(gateway);
    gateway.account = async () => {
      throw new Error('horizon down');
    };
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    gateway.account = () => new Promise<never>(() => undefined);
    expect(await run(gateway, xdr, clock(), { requestTimeoutMs: 5 })).toEqual({ status: 'unknown', hash });
    gateway.account = async (address) => {
      const account = await read(address);
      return account === null ? null : { ...account, id: Keypair.random().publicKey() };
    };
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    gateway.account = async (address) => {
      const account = await read(address);
      return account === null ? null : { ...account, sequence: '1e3' };
    };
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    gateway.account = read;
    expect((await run(gateway, xdr)).status).toBe('expired_not_landed');
    expect(gateway.accountReads.every((a) => a === source)).toBe(true);
  });

  it('compares sequence numbers as integers, beyond 2^53', async () => {
    // As JavaScript numbers 9007199254740992 and 9007199254740993 are equal.
    const { xdr, hash, source } = signedPayment(maxTime, '9007199254740992');
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime + 6, 77);
    gateway.setAccount(source, '9007199254740992');
    expect(await run(gateway, xdr)).toMatchObject({
      status: 'expired_not_landed',
      transactionSequence: '9007199254740993',
      sourceAccount: { sequence: '9007199254740992' },
    });
    gateway.setAccount(source, '9007199254740993');
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
  });

  it("a fee bump reads the inner transaction's source, never the fee source", async () => {
    const inner = signedPayment(maxTime);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime + 6, 77);
    gateway.setAccount(inner.source, '100');
    expect(await run(gateway, ours.xdr)).toMatchObject({
      status: 'expired_not_landed',
      hash: ours.hash,
      innerHash: inner.hash,
      sourceAccount: { id: inner.source, sequence: '100', latestLedger: 77 },
    });
    expect(gateway.accountReads).toEqual([inner.source]);

    // The inner source used its sequence: unknown, whatever the lookups say.
    gateway.setAccount(inner.source, '101');
    expect(await run(gateway, ours.xdr)).toEqual({ status: 'unknown', hash: ours.hash, innerHash: inner.hash });
  });

  it("a lookup's Latest-Ledger header is not part of the proof: the account read is", async () => {
    const { xdr, gateway } = pastMaxTime();
    gateway.lookupLedger = null;
    expect((await run(gateway, xdr)).status).toBe('expired_not_landed');
  });

  it('a failed lookup still blocks the proof', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    gateway.transaction = async () => {
      throw new Error('horizon down');
    };
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash });
    expect(gateway.accountReads).toEqual([]);
  });

  it('re-running a stored envelope that landed long ago, on pruned history: unknown, never expired', async () => {
    // Review probe: the transaction landed in an early ledger; the instance
    // has since pruned that history, so every lookup finds nothing, and the
    // ledger is days past maxTime. Its sequence number is used, though.
    const old = T0 / 1000 - 3 * 86_400;
    const { xdr, hash, source } = signedPayment(old);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_too_late', operationCodes: [] }];
    gateway.ledger = ledgerAt(T0 / 1000, 10_000);
    gateway.setAccount(source, '101');
    const result = await run(gateway, xdr);
    expect(result).toMatchObject({ status: 'rejected', reason: 'refused', hash, error: { code: 'too_late' } });
    expect(canSignReplacement(result)).toBe(false);

    // The same envelope that never landed: its sequence is unused.
    gateway.setAccount(source, '100');
    expect(await run(gateway, xdr)).toMatchObject({ status: 'expired_not_landed', hash });
  });

  it('reads nothing before the first submission', async () => {
    const { xdr, gateway } = pastMaxTime();
    const order: string[] = [];
    const read = gateway.latestLedger.bind(gateway);
    gateway.latestLedger = async () => {
      order.push('ledger');
      return read();
    };
    const submit = gateway.submitTransaction.bind(gateway);
    gateway.submitTransaction = async (signed) => {
      order.push('submit');
      return submit(signed);
    };
    const account = gateway.account.bind(gateway);
    gateway.account = async (address) => {
      order.push('account');
      return account(address);
    };
    await run(gateway, xdr);
    expect(order).toEqual(['submit', 'ledger', 'account']);
  });

  it('with maxWaitMs 0 nothing is read or looked up, so it never expires', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    expect(await run(gateway, xdr, clock(), { maxWaitMs: 0 })).toEqual({ status: 'unknown', hash });
    expect(gateway.ledgerReads).toEqual([]);
    expect(gateway.transactionLookups).toEqual([]);
    expect(gateway.accountReads).toEqual([]);
  });

  it('with maxWaitMs 0 a quick network error is unknown without a lookup', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    gateway.submitResponses = [{ kind: 'unavailable', status: null }];
    expect(await run(gateway, xdr, clock(), { maxWaitMs: 0 })).toEqual({ status: 'unknown', hash });
    expect(gateway.transactionLookups).toEqual([]);
  });

  it('with maxWaitMs 0 a refusal is reported as is, without a lookup', async () => {
    const { xdr, hash, gateway } = pastMaxTime();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    gateway.transactions.set(hash, { found: true, hash, successful: true });
    expect(await run(gateway, xdr, clock(), { maxWaitMs: 0 })).toMatchObject({
      status: 'rejected',
      reason: 'refused',
      error: { code: 'bad_seq' },
    });
    expect(gateway.transactionLookups).toEqual([]);
  });
});

describe('submit: load-balanced Horizon (real HTTP, default gateway)', () => {
  // Review probe: two Horizon instances behind one URL. Instance A has
  // ingested ledger 105 (closed after maxTime); instance B lags at 102. The
  // transaction landed in ledger 104, before maxTime, so A shows its
  // sequence number used and B does not yet. Reads that reach B must never
  // prove expiry.
  let server: Server;
  let url: string;
  const maxTime = Math.floor(Date.now() / 1000) + 30;
  const { xdr, hash, source } = signedPayment(maxTime);
  const instances = {
    A: { ledger: 105, closed: maxTime + 3, has: true, sequence: '101' },
    B: { ledger: 102, closed: maxTime - 6, has: false, sequence: '100' },
  };
  let route: (req: IncomingMessage) => keyof typeof instances;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const i = instances[route(req)];
      res.setHeader('content-type', 'application/hal+json');
      res.setHeader('Latest-Ledger', String(i.ledger));
      const path = req.url ?? '';
      if (path === '/') {
        res.end(
          JSON.stringify({
            history_latest_ledger: i.ledger,
            history_latest_ledger_closed_at: new Date(i.closed * 1000).toISOString(),
          }),
        );
      } else if (path.startsWith('/transactions/') && i.has) {
        res.end(JSON.stringify({ hash, successful: true, ledger: 104 }));
      } else if (path === `/accounts/${source}`) {
        res.end(JSON.stringify({ id: source, sequence: i.sequence, subentry_count: 0, balances: [] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: 404, title: 'Resource Missing' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  function submitThrough() {
    const gateway = createHorizonGateway({ horizonUrl: url, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, allowHttp: true });
    gateway.submitTransaction = async () => ({ kind: 'timeout', status: 504 });
    return submitSignedTransaction({
      gateway,
      signedXdr: xdr,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      maxWaitMs: 1_000,
      pollIntervalMs: 5_000,
      sleep: async () => undefined,
    });
  }

  it('ledger read on the leading instance, the rest on the lagging one: unknown, never expired_not_landed', async () => {
    route = (req) => (req.url === '/' ? 'A' : 'B');
    const result = await submitThrough();
    expect(result).toEqual({ status: 'unknown', hash });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('lookup on the lagging instance, account on the leading one: the used sequence gives unknown', async () => {
    route = (req) => (req.url?.startsWith('/transactions/') === true ? 'B' : 'A');
    expect(await submitThrough()).toEqual({ status: 'unknown', hash });
  });

  it('the same lookup on the leading instance finds the landing', async () => {
    route = () => 'A';
    expect(await submitThrough()).toMatchObject({ status: 'success', hash, ledger: 104 });
  });
});

describe('submit: re-run on an instance with pruned history (real HTTP, default gateway)', () => {
  // Review probe: one Horizon instance that keeps recent history only. A
  // stored envelope that landed long ago is submitted again: Horizon
  // refuses it as too late and no lookup finds it. Only its source account
  // still shows that it landed.
  let server: Server;
  let url: string;
  const maxTime = Math.floor(Date.now() / 1000) - 3 * 86_400;
  const { xdr, hash, source } = signedPayment(maxTime);
  let account: 'used' | 'unused' | 'missing' | 'no_header';

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/hal+json');
      const path = req.url ?? '';
      if (!(account === 'no_header' && path.startsWith('/accounts/'))) res.setHeader('Latest-Ledger', '10000');
      if (path === '/') {
        res.end(JSON.stringify({ history_latest_ledger: 10_000, history_latest_ledger_closed_at: new Date().toISOString() }));
      } else if (path === `/accounts/${source}` && account !== 'missing') {
        res.end(JSON.stringify({ id: source, sequence: account === 'used' ? '101' : '100', subentry_count: 0, balances: [] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: 404, title: 'Resource Missing' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  function rerun() {
    const gateway = createHorizonGateway({ horizonUrl: url, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, allowHttp: true });
    gateway.submitTransaction = async () => ({ kind: 'rejected', status: 400, transactionCode: 'tx_too_late', operationCodes: [] });
    return submitSignedTransaction({
      gateway,
      signedXdr: xdr,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      maxWaitMs: 20,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
  }

  it('the sequence number is used: never expired_not_landed', async () => {
    account = 'used';
    const result = await rerun();
    expect(result).toMatchObject({ status: 'rejected', reason: 'refused', hash, error: { code: 'too_late' } });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('the source account is missing, or its read has no Latest-Ledger: never expired_not_landed', async () => {
    for (const mode of ['missing', 'no_header'] as const) {
      account = mode;
      const result = await rerun();
      expect(result.status).toBe('rejected');
      expect(canSignReplacement(result)).toBe(false);
    }
  });

  it('the sequence number is unused: expired_not_landed', async () => {
    account = 'unused';
    const result = await rerun();
    expect(result).toMatchObject({
      status: 'expired_not_landed',
      hash,
      transactionSequence: '101',
      sourceAccount: { id: source, sequence: '100', latestLedger: 10_000 },
    });
    expect(canSignReplacement(result)).toBe(true);
  });
});

describe("submit: someone else's fee bump, as testnet Horizon answers (real HTTP, default gateway)", () => {
  // Seen on the public testnet: looked up by the inner hash, Horizon answers
  // with a record whose own `hash` is the inner hash and names the envelope
  // on the ledger in `fee_bump_transaction`. Only account reads carry a
  // Latest-Ledger header. The payment's records carry the fee bump's hash,
  // so that is the hash the result must report.
  let server: Server;
  let url: string;
  const inner = signedPayment(Math.floor(Date.now() / 1000) + 300);
  const ours = feeBumped(inner.tx, '300');
  const theirs = feeBumped(inner.tx, '500');
  const asHorizonAnswers = {
    hash: inner.hash,
    successful: true,
    ledger: 77,
    envelope_xdr: theirs.xdr,
    fee_bump_transaction: { hash: theirs.hash, signatures: [] },
    inner_transaction: { hash: inner.hash, signatures: [], max_fee: '200' },
  };
  /** What the fake Horizon answers for the inner hash. */
  let record: Record<string, unknown> = asHorizonAnswers;

  /** Submits our fee bump; Horizon refuses it as `tx_bad_seq`, or gives no answer with `answer: 'timeout'`. */
  const submit = (answer: 'bad_seq' | 'timeout' = 'bad_seq') => {
    const gateway = createHorizonGateway({ horizonUrl: url, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, allowHttp: true });
    gateway.submitTransaction = async () =>
      answer === 'timeout'
        ? { kind: 'timeout' }
        : { kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] };
    return submitSignedTransaction({
      gateway,
      signedXdr: ours.xdr,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      maxWaitMs: 20,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
  };

  beforeEach(() => {
    record = asHorizonAnswers;
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/hal+json');
      const path = req.url ?? '';
      if (path === '/') {
        res.end(JSON.stringify({ history_latest_ledger: 78, history_latest_ledger_closed_at: new Date().toISOString() }));
      } else if (path === `/transactions/${inner.hash}`) {
        res.end(JSON.stringify(record));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: 404, title: 'Resource Missing' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('reports the hash that landed, found by the inner hash', async () => {
    const result = await submit();
    expect(result).toEqual({
      status: 'success',
      hash: theirs.hash,
      innerHash: inner.hash,
      ledger: 77,
      foundBy: 'inner_hash',
      submittedHash: ours.hash,
    });
  });

  it("a fee bump hash field that is not the envelope's hash is unknown, never success", async () => {
    // Well formed, but not the hash of the envelope Horizon returned.
    record = { ...asHorizonAnswers, fee_bump_transaction: { hash: 'ab'.repeat(32) } };
    const result = await submit('timeout');
    expect(result).toEqual({ status: 'unknown', hash: ours.hash, innerHash: inner.hash });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('a record with a well-formed fee_bump_transaction.hash but no inner_transaction is unknown', async () => {
    const { inner_transaction: _dropped, ...withoutInner } = asHorizonAnswers;
    record = withoutInner;
    const result = await submit('timeout');
    expect(result).toEqual({ status: 'unknown', hash: ours.hash, innerHash: inner.hash });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('a fee bump record without its envelope is unknown', async () => {
    const { envelope_xdr: _dropped, ...withoutEnvelope } = asHorizonAnswers;
    record = withoutEnvelope;
    expect(await submit('timeout')).toEqual({ status: 'unknown', hash: ours.hash, innerHash: inner.hash });
  });

  it('a refused submission whose lookup record disagrees with its envelope stays refused, never success', async () => {
    record = { ...asHorizonAnswers, fee_bump_transaction: { hash: 'ab'.repeat(32) } };
    const result = await submit();
    expect(result).toMatchObject({ status: 'rejected', reason: 'refused', hash: ours.hash });
    expect(canSignReplacement(result)).toBe(false);
  });
});

describe('submit: Horizon reads time out', () => {
  const maxTime = T0 / 1000 - 60;
  const hang = () => new Promise<never>(() => undefined);

  it('a hanging lookup counts as an error, never as not found', async () => {
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(T0 / 1000);
    gateway.transaction = hang;
    const result = await run(gateway, xdr, clock(), { requestTimeoutMs: 5, maxWaitMs: 1_000 });
    expect(result).toEqual({ status: 'unknown', hash });
  });

  it('a hanging ledger read counts as an error and the run still ends', async () => {
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.latestLedger = hang;
    const result = await run(gateway, xdr, clock(), { requestTimeoutMs: 5, maxWaitMs: 10_000 });
    expect(result).toEqual({ status: 'unknown', hash });
  });

  it('aborts the signal of a read it gives up on', async () => {
    const { xdr } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const signals: AbortSignal[] = [];
    gateway.transaction = (_h, options) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return hang();
    };
    await run(gateway, xdr, clock(), { requestTimeoutMs: 5, maxWaitMs: 1_000 });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])('fails closed on requestTimeoutMs = %p', async (requestTimeoutMs) => {
    const { xdr } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    await expect(run(gateway, xdr, clock(), { requestTimeoutMs })).rejects.toThrow(InvalidInputError);
    expect(gateway.submitted).toEqual([]);
  });
});

describe('submit: a broken clock ends the run', () => {
  it('a clock that returns NaN once after the deadline is fixed ends with unknown, no tight loop', async () => {
    // Review probe: the deadline used to be read from a second clock call; a
    // NaN there made `t >= deadline` false forever and the loop spun.
    const { xdr, hash } = signedPayment(T0 / 1000 + 60);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    let calls = 0;
    let sleeps = 0;
    const result = await run(gateway, xdr, clock(), {
      now: () => (++calls === 2 ? Number.NaN : T0),
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 1_000) throw new Error('tight loop');
      },
      resubmit: false,
      maxWaitMs: 1_000,
    });
    expect(result).toEqual({ status: 'unknown', hash });
    expect(sleeps).toBe(0);
  });

  it('a clock that never moves ends after maxWaitMs / pollIntervalMs rounds', async () => {
    const { xdr, hash } = signedPayment(T0 / 1000 + 60);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    let sleeps = 0;
    const result = await run(gateway, xdr, clock(), {
      now: () => T0,
      sleep: async () => {
        sleeps += 1;
      },
      maxWaitMs: 60_000,
      pollIntervalMs: 5_000,
    });
    expect(result).toMatchObject({ status: 'unknown', hash });
    expect(sleeps).toBe(12);
  });

  it('a clock that throws mid-way ends with unknown', async () => {
    const { xdr, hash } = signedPayment(T0 / 1000 + 60);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls > 1) throw new Error('clock gone');
      return T0;
    };
    expect(await run(gateway, xdr, clock(), { now })).toEqual({ status: 'unknown', hash });
    expect(gateway.submitted).toEqual([xdr]);
  });
});

describe('submit: a lookup must return our transaction', () => {
  it('a lookup that returns another hash is unknown with detail, never success', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const other = 'b'.repeat(64);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash: other, successful: true, ledger: 4 });
    const result = await run(gateway, xdr);
    expect(result).toEqual({ status: 'unknown', hash, reason: 'unexpected_lookup_hash', returnedHash: other });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('a record with a malformed hash is unknown, and the malformed value is not echoed', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash: '<script>', successful: true });
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash, reason: 'unexpected_lookup_hash' });
  });

  it('a record whose inner hash is ours but whose own hash is malformed is unknown, never success', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash: 'NOT A HASH <x>', innerHash: hash, successful: true, ledger: 5 });
    const result = await run(gateway, xdr);
    expect(result).toEqual({ status: 'unknown', hash, reason: 'unexpected_lookup_hash', returnedInnerHash: hash });
    expect(canSignReplacement(result)).toBe(false);
  });

  it('a record whose hash is ours but whose inner hash is malformed is unknown, never success', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash, innerHash: 'zz', successful: true, ledger: 5 });
    expect(await run(gateway, xdr)).toEqual({ status: 'unknown', hash, reason: 'unexpected_lookup_hash', returnedHash: hash });
  });

  it("someone else's fee bump whose inner hash is not ours is unknown", async () => {
    const plain = signedPayment(IN_ONE_HOUR);
    const unrelated = signedPayment(IN_ONE_HOUR);
    const theirs = feeBumped(unrelated.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(plain.hash, { found: true, hash: theirs.hash, innerHash: unrelated.hash, successful: true });
    expect(await run(gateway, plain.xdr)).toEqual({
      status: 'unknown',
      hash: plain.hash,
      reason: 'unexpected_lookup_hash',
      returnedHash: theirs.hash,
      returnedInnerHash: unrelated.hash,
    });
  });

  it('a fee bump found by its inner hash, with the inner hash as the record hash: success', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(inner.hash, { found: true, hash: inner.hash, successful: true, ledger: 6 });
    expect(await run(gateway, ours.xdr)).toMatchObject({ status: 'success', hash: inner.hash, foundBy: 'inner_hash' });
  });
});

describe('submit: a landed failure keeps its own result codes', () => {
  it("a resubmission's tx_bad_seq never replaces the landed transaction's codes", async () => {
    // Review probe: the first submission timed out, the transaction landed
    // as failed, the resubmission got tx_bad_seq, and the result said bad_seq.
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'timeout' },
      { kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] },
    ];
    gateway.onLookup = (_h, count) => {
      if (count === 2) {
        gateway.transactions.set(hash, {
          found: true,
          hash,
          successful: false,
          ledger: 8,
          resultCodes: { transaction: 'tx_failed', operations: ['op_underfunded'] },
        });
      }
    };
    expect(await run(gateway, xdr)).toEqual({
      status: 'failed',
      hash,
      ledger: 8,
      foundBy: 'hash',
      error: { code: 'underfunded', transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] },
    });
    expect(gateway.submitted.length).toBe(2);
  });

  it('a first-submission tx_bad_seq on a transaction that landed failed: failed, without the refusal', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    gateway.transactions.set(hash, { found: true, hash, successful: false, ledger: 3 });
    expect(await run(gateway, xdr)).toEqual({ status: 'failed', hash, ledger: 3, foundBy: 'hash' });
  });
});
