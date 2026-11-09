import {
  type ConfirmedSubmitOutcome,
  InvalidConfigError,
  InvalidInputError,
  type LegQuote,
  PayoutIncompleteError,
  type Signer,
  type StellarSubmitter,
  type SubmitOutcome,
  canSignReplacement,
  fiat,
  money,
  runSignedPayout,
} from '@vindu/grid-core';
import { TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { stellarSdk } from '../src/sdk';
import { createStellarSubmitter, toSubmitOutcome } from '../src/submit';
import { FakeGateway } from './fake-gateway';

const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = stellarSdk;

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MAX_TIME = T0 / 1000 + 300;

function signed(maxTime = MAX_TIME): { xdr: string; hash: string; source: string } {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: new Asset('USDC', Keypair.random().publicKey()),
        amount: '25.5',
      }),
    )
    .build();
  tx.sign(source);
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex'), source: source.publicKey() };
}

function submitterFor(gateway: FakeGateway, extra: { maxWaitMs?: number } = {}) {
  let t = T0;
  return createStellarSubmitter({
    gateway,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    timeoutMs: 1_000,
    pollIntervalMs: 5_000,
    maxWaitMs: extra.maxWaitMs ?? 30_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
}

describe('createStellarSubmitter', () => {
  it("is core's StellarSubmitter", () => {
    const submitter: StellarSubmitter = submitterFor(new FakeGateway());
    expect(typeof submitter.submit).toBe('function');
  });

  it('success only when the transaction landed, with the detail kept', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash, ledger: 8, successful: true }];
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome).toEqual({ status: 'success', hash, detail: { ledger: 8 } });
    expect(canSignReplacement(outcome)).toBe(false);
  });

  it('a refused submission is rejected, with the error codes in detail, and allows no replacement', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'rejected', status: 400, transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] },
    ];
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome).toEqual({
      status: 'rejected',
      hash,
      detail: {
        reason: 'refused',
        error: { code: 'underfunded', transactionCode: 'tx_failed', operationCodes: ['op_underfunded'] },
      },
    });
    expect(canSignReplacement(outcome)).toBe(false);
  });

  it('a hash mismatch is rejected with detail.reason hash_mismatch', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: 'ef'.repeat(32), successful: true }];
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome).toEqual({
      status: 'rejected',
      hash,
      detail: { reason: 'hash_mismatch', returnedHash: 'ef'.repeat(32) },
    });
    expect(canSignReplacement(outcome)).toBe(false);
  });

  it('expired_not_landed keeps the ledger and account evidence and allows a replacement', async () => {
    const { xdr, hash, source } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = { sequence: 9, closedAt: new Date((MAX_TIME + 1) * 1000) };
    gateway.setAccount(source, '100');
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome).toEqual({
      status: 'expired_not_landed',
      hash,
      detail: {
        maxTime: MAX_TIME,
        transactionSequence: '101',
        checkedLedger: { sequence: 9, closedAt: new Date((MAX_TIME + 1) * 1000).toISOString() },
        sourceAccount: { id: source, sequence: '100', latestLedger: 9 },
      },
    });
    expect(canSignReplacement(outcome)).toBe(true);
  });

  it('unknown allows no replacement', async () => {
    const { xdr } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome.status).toBe('unknown');
    expect(canSignReplacement(outcome)).toBe(false);
  });

  it('maps every SubmitResult field into detail', () => {
    expect(
      toSubmitOutcome({
        status: 'success',
        hash: 'a'.repeat(64),
        innerHash: 'b'.repeat(64),
        ledger: 3,
        foundBy: 'inner_hash',
        submittedHash: 'c'.repeat(64),
      }),
    ).toEqual({
      status: 'success',
      hash: 'a'.repeat(64),
      detail: { innerHash: 'b'.repeat(64), ledger: 3, foundBy: 'inner_hash', submittedHash: 'c'.repeat(64) },
    });
  });

  it('reports maxDurationMs = timeoutMs + maxWaitMs, read-only', () => {
    const gateway = new FakeGateway();
    const submitter = createStellarSubmitter({
      gateway,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      timeoutMs: 7_000,
      maxWaitMs: 45_000,
    });
    expect(submitter.maxDurationMs).toBe(52_000);
    expect(() => {
      (submitter as { maxDurationMs: number }).maxDurationMs = 1;
    }).toThrow(TypeError);
    expect(submitter.maxDurationMs).toBe(52_000);
    // The defaults: 30 s to submit plus 2 min of waiting.
    expect(createStellarSubmitter({ gateway, networkPassphrase: TESTNET_NETWORK_PASSPHRASE }).maxDurationMs).toBe(150_000);
  });

  it('one submit never runs longer than maxDurationMs, even when every Horizon call hangs', async () => {
    const { xdr } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = ['hang'];
    const hang = () => new Promise<never>(() => undefined);
    gateway.latestLedger = hang;
    gateway.transaction = hang;
    const submitter = createStellarSubmitter({
      gateway,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      timeoutMs: 40,
      maxWaitMs: 80,
      pollIntervalMs: 20,
      requestTimeoutMs: 1_000,
    });
    const started = Date.now();
    const outcome = await submitter.submit(xdr);
    const elapsed = Date.now() - started;
    expect(outcome.status).toBe('unknown');
    // Timers may fire late on a busy machine; the bound that matters is far
    // below the 1 s request timeout that would apply without the deadline.
    expect(elapsed).toBeLessThan(submitter.maxDurationMs + 300);
  });

  it('checks the passphrase and durations when it is created', () => {
    const gateway = new FakeGateway();
    expect(() => createStellarSubmitter({ gateway, networkPassphrase: Networks.PUBLIC })).toThrow(InvalidConfigError);
    expect(() =>
      createStellarSubmitter({ gateway, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, maxWaitMs: Number.NaN }),
    ).toThrow(InvalidInputError);
  });
});

describe('createStellarSubmitter in the signed payout flow', () => {
  const destination = Keypair.random().publicKey();
  const client = Keypair.random();
  const quote: LegQuote = {
    id: 'qu_1',
    partner: 'test',
    kind: 'payout',
    expiresAt: new Date(T0 + 600_000).toISOString(),
    source: money('25.5', fiat('USDC')),
    target: money('25.5', fiat('USD')),
    fees: [],
  };

  function flow(gateway: FakeGateway, signedXdr: string) {
    const order: string[] = [];
    const executePayout = jest.fn(async () => {
      order.push('execute');
      return { partner: 'test', kind: 'payout' as const, id: 'po_1' };
    });
    const onSubmitted = jest.fn(async (_outcome: ConfirmedSubmitOutcome) => {
      order.push('recorded');
    });
    const signer: Signer = { custody: 'test_key', signStellar: async () => signedXdr };
    const run = () =>
      runSignedPayout({
        adapter: { id: 'test', preparePayout: async () => ({ kind: 'stellar_xdr', unsignedXdr: 'AAAA' }), executePayout },
        context: {
          transferId: 't1',
          state: 'payout_quoted',
          quote,
          account: { chain: 'stellar', address: client.publicKey() },
        },
        funded: money('25.5', fiat('USDC')),
        signing: {
          signer,
          submitter: submitterFor(gateway),
          submission: 'client_submits',
          destination,
          onAuthorized: () => 'awaiting_signature',
          onSubmitted,
        },
        now: () => T0,
        idempotencyKey: 'k1',
      });
    return { run, executePayout, onSubmitted, order };
  }

  it('a rejected submit stops the flow before the payout is created', async () => {
    // Review probe: a submitter wired straight to the submit result let the
    // payout be created after Horizon refused the transaction.
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'rejected', status: 400, transactionCode: 'tx_insufficient_balance', operationCodes: [] },
    ];
    const { run, executePayout, onSubmitted } = flow(gateway, xdr);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayoutIncompleteError);
    expect(error).toMatchObject({ stage: 'submit', txHash: hash });
    expect((error as { outcome?: SubmitOutcome }).outcome?.status).toBe('rejected');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(executePayout).not.toHaveBeenCalled();
  });

  it('a hash mismatch stops the flow before the payout is created', async () => {
    const { xdr } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: 'ef'.repeat(32), successful: true }];
    const { run, executePayout, onSubmitted } = flow(gateway, xdr);
    await expect(run()).rejects.toBeInstanceOf(PayoutIncompleteError);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(executePayout).not.toHaveBeenCalled();
  });

  it('a landed transaction is recorded, then creates the payout with its hash', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash, successful: true, ledger: 5 });
    const { run, executePayout, onSubmitted, order } = flow(gateway, xdr);
    const result = await run();
    expect(result.txHash).toBe(hash);
    expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', hash }));
    expect(order).toEqual(['recorded', 'execute']);
    expect(executePayout).toHaveBeenCalledWith(expect.objectContaining({ txHash: hash, signedXdr: xdr }));
  });
});
