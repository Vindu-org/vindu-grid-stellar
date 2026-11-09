import { InvalidConfigError, InvalidInputError } from '@vindu/grid-core';
import { TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { mapResultCodes } from '../src/result-codes';
import { stellarSdk } from '../src/sdk';
import { inspectSignedTransaction, submitSignedTransaction } from '../src/submit';
import { FakeGateway } from './fake-gateway';

const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = stellarSdk;

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

type Tx = ReturnType<InstanceType<typeof TransactionBuilder>['build']>;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A real payment envelope signed with a throwaway key on the testnet passphrase. No network. */
function signedPayment(maxTimeSeconds: number): { xdr: string; hash: string; tx: Tx } {
  const source = Keypair.random();
  const issuer = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(source.publicKey(), '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: maxTimeSeconds },
  })
    .addOperation(
      Operation.payment({ destination: Keypair.random().publicKey(), asset: new Asset('USDC', issuer), amount: '25.5' }),
    )
    .build();
  tx.sign(source);
  return { xdr: tx.toXDR(), hash: hex(tx.hash()), tx };
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
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    expect(inspectSignedTransaction(xdr, TESTNET_NETWORK_PASSPHRASE)).toEqual({ hash, maxTime: IN_ONE_HOUR });
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
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
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
      checkedLedger: { sequence: 101, closedAt: new Date((maxTime + 5) * 1000).toISOString() },
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

  it('expired_not_landed once a ledger closed after maxTime and a later lookup finds nothing', async () => {
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime + 6, 77);
    const result = await run(gateway, xdr);
    expect(result).toEqual({
      status: 'expired_not_landed',
      hash,
      maxTime,
      checkedLedger: { sequence: 77, closedAt: new Date((maxTime + 6) * 1000).toISOString() },
    });
    // The ledger was read before the lookup that found nothing.
    expect(gateway.ledgerReads).toEqual([0]);
    expect(gateway.transactionLookups).toEqual([hash]);
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
    const { xdr } = signedPayment(maxTime);
    const gateway = new FakeGateway();
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
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(maxTime - 30);
    gateway.onLookup = (_h, count) => {
      if (count === 3) gateway.ledger = ledgerAt(maxTime + 1);
    };
    expect(await run(gateway, xdr)).toMatchObject({ status: 'expired_not_landed', hash });
    expect(gateway.transactionLookups.length).toBe(4);
  });

  it('a failing latest-ledger read never counts as expired', async () => {
    const { xdr, hash } = signedPayment(T0 / 1000 - 3600);
    const gateway = new FakeGateway();
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

  it('a transaction without maxTime never reads the ledger and is never expired', async () => {
    const { xdr } = signedPayment(0);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = ledgerAt(T0 / 1000 + 10 * 365 * 86_400);
    expect((await run(gateway, xdr, clock(), { maxWaitMs: 10 * 60_000 })).status).toBe('unknown');
    expect(gateway.ledgerReads).toEqual([]);
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
    });
  });

  it('looks up the outer hash, then the inner hash', async () => {
    const inner = signedPayment(IN_ONE_HOUR);
    const ours = feeBumped(inner.tx);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const result = await run(gateway, ours.xdr, clock(), { maxWaitMs: 0 });
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
    const record = { found: true as const, hash: theirs.hash, successful: true, ledger: 7 };
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
    gateway.transactions.set(plain.hash, { found: true, hash: theirs.hash, successful: true, ledger: 2 });
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
