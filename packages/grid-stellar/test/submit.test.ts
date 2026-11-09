import { TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { mapResultCodes } from '../src/result-codes';
import { stellarSdk } from '../src/sdk';
import { inspectSignedTransaction, submitSignedTransaction } from '../src/submit';
import { FakeGateway } from './fake-gateway';

const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = stellarSdk;

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

/** A real payment envelope signed with a throwaway key on the testnet passphrase. No network. */
function signedPayment(maxTimeSeconds: number): { xdr: string; hash: string } {
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
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex') };
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
    expiryGraceMs: 30_000,
    now: c.now,
    sleep: c.sleep,
    ...extra,
  });
}

const IN_ONE_HOUR = T0 / 1000 + 3600;

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
    expect(result).toEqual({ status: 'success', hash, ledger: 9 });
    expect(gateway.submitted).toEqual([xdr]);
    expect(gateway.transactionLookups).toEqual([hash]);
  });

  it('a submit call that hangs past timeoutMs is treated as a timeout and the hash is checked', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = ['hang'];
    gateway.transactions.set(hash, { found: true, hash, successful: true });
    const result = await run(gateway, xdr, clock(), { timeoutMs: 5 });
    expect(result).toEqual({ status: 'success', hash });
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

  it('maxTime passed and still not found: expired_not_landed', async () => {
    const maxTime = T0 / 1000 + 20;
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const c = clock();
    const result = await run(gateway, xdr, c, { maxWaitMs: 5 * 60_000 });
    expect(result).toEqual({ status: 'expired_not_landed', hash, maxTime });
    // Not before maxTime plus the grace period.
    expect(c.now()).toBeGreaterThan(maxTime * 1000 + 30_000);
  });

  it('a failing hash lookup never counts as not found', async () => {
    const maxTime = T0 / 1000 - 3600;
    const { xdr } = signedPayment(maxTime);
    const gateway = new FakeGateway();
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
    expect(await run(gateway, xdr)).toEqual({ status: 'failed', hash, ledger: 3 });
  });

  it('maps tx_bad_seq to a typed rejection after checking the hash', async () => {
    const { xdr, hash } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_bad_seq', operationCodes: [] }];
    const result = await run(gateway, xdr);
    expect(result).toEqual({
      status: 'rejected',
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

  it('maps tx_too_late: rejected inside the grace period, expired_not_landed after it', async () => {
    const maxTime = T0 / 1000 - 10;
    const { xdr, hash } = signedPayment(maxTime);
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'rejected', status: 400, transactionCode: 'tx_too_late', operationCodes: [] }];
    expect(await run(gateway, xdr)).toMatchObject({ status: 'rejected', error: { code: 'too_late' } });

    const later = clock(T0 + 60_000);
    expect(await run(gateway, xdr, later)).toEqual({ status: 'expired_not_landed', hash, maxTime });
  });

  it('maps operation failures to typed codes', async () => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'rejected', status: 400, transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] },
    ];
    expect(await run(gateway, xdr)).toMatchObject({ status: 'rejected', error: { code: 'underfunded' } });
  });

  it('rejects invalid options and envelopes', async () => {
    const { xdr } = signedPayment(IN_ONE_HOUR);
    const gateway = new FakeGateway();
    await expect(run(gateway, xdr, clock(), { timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(run(gateway, 'not-xdr')).rejects.toThrow();
    expect(gateway.submitted).toEqual([]);
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
