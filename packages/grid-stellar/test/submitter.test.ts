import {
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

function signed(maxTime = MAX_TIME): { xdr: string; hash: string } {
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
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex') };
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

  it('expired_not_landed keeps the ledger evidence and allows a replacement', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.ledger = { sequence: 9, closedAt: new Date((MAX_TIME + 1) * 1000) };
    const outcome = await submitterFor(gateway).submit(xdr);
    expect(outcome).toEqual({
      status: 'expired_not_landed',
      hash,
      detail: {
        maxTime: MAX_TIME,
        checkedLedger: { sequence: 9, closedAt: new Date((MAX_TIME + 1) * 1000).toISOString() },
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
    const executePayout = jest.fn(async () => ({ partner: 'test', kind: 'payout' as const, id: 'po_1' }));
    const signer: Signer = { custody: 'test_key', signStellar: async () => signedXdr };
    const run = () =>
      runSignedPayout({
        adapter: { preparePayout: async () => ({ kind: 'stellar_xdr', unsignedXdr: 'AAAA' }), executePayout },
        signer,
        submitter: submitterFor(gateway),
        submission: 'client_submits',
        context: {
          transferId: 't1',
          state: 'awaiting_signature',
          quote,
          account: { chain: 'stellar', address: client.publicKey() },
          destination,
        },
        now: () => T0,
        idempotencyKey: 'k1',
      });
    return { run, executePayout };
  }

  it('a rejected submit stops the flow before the payout is created', async () => {
    // Review probe: a submitter wired straight to the submit result let the
    // payout be created after Horizon refused the transaction.
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [
      { kind: 'rejected', status: 400, transactionCode: 'tx_insufficient_balance', operationCodes: [] },
    ];
    const { run, executePayout } = flow(gateway, xdr);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayoutIncompleteError);
    expect(error).toMatchObject({ stage: 'submit', txHash: hash });
    expect((error as { outcome?: SubmitOutcome }).outcome?.status).toBe('rejected');
    expect(executePayout).not.toHaveBeenCalled();
  });

  it('a hash mismatch stops the flow before the payout is created', async () => {
    const { xdr } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'accepted', hash: 'ef'.repeat(32), successful: true }];
    const { run, executePayout } = flow(gateway, xdr);
    await expect(run()).rejects.toBeInstanceOf(PayoutIncompleteError);
    expect(executePayout).not.toHaveBeenCalled();
  });

  it('a landed transaction creates the payout with its hash', async () => {
    const { xdr, hash } = signed();
    const gateway = new FakeGateway();
    gateway.submitResponses = [{ kind: 'timeout' }];
    gateway.transactions.set(hash, { found: true, hash, successful: true, ledger: 5 });
    const { run, executePayout } = flow(gateway, xdr);
    const result = await run();
    expect(result.txHash).toBe(hash);
    expect(executePayout).toHaveBeenCalledWith(expect.objectContaining({ txHash: hash, signedXdr: xdr }));
  });
});
