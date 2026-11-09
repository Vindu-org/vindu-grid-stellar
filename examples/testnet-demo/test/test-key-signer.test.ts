import {
  type AccountRef,
  type SigningContext,
  SigningNotAllowedError,
  money,
  stellarAsset,
} from '@vindu/grid-core';
import {
  DEFAULT_MAX_FEE_STROOPS,
  type PayoutXdrCheck,
  PayoutXdrMismatchError,
  TESTNET_NETWORK_PASSPHRASE,
} from '@vindu/grid-stellar';

import { Account, Asset, Keypair, Operation, type StellarSdk, TransactionBuilder } from '../src/sdk';
import { TestKeySigner } from '../src/test-key-signer';

const PASSPHRASE = TESTNET_NETWORK_PASSPHRASE;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const EXPIRES_AT = NOW + 5 * 60 * 1000;
const MAX_TIME = Math.floor(EXPIRES_AT / 1000);

const client = Keypair.random();
const treasury = Keypair.random();
const issuer = Keypair.random();
const stranger = Keypair.random();
const usdc = stellarAsset('USDC', issuer.publicKey());
const account: AccountRef = { chain: 'stellar', address: client.publicKey() };

const context = (overrides: Partial<SigningContext> = {}): SigningContext => ({
  transferId: 't-1',
  state: 'awaiting_signature',
  quoteId: 'pq-1',
  expiresAt: new Date(EXPIRES_AT).toISOString(),
  expected: { source: client.publicKey(), destination: treasury.publicKey(), amount: money('100', usdc) },
  ...overrides,
});

interface TxOptions {
  readonly fee?: string;
  readonly maxTime?: number;
  readonly operations?: readonly ReturnType<typeof Operation.payment>[];
  /** Changes the builder before the transaction is built, e.g. to set a precondition. */
  readonly tweak?: (builder: StellarSdk.TransactionBuilder) => void;
}

const payment = (opts: { source?: string; destination?: string; amount?: string; issuer?: string } = {}) =>
  Operation.payment({
    destination: opts.destination ?? treasury.publicKey(),
    asset: new Asset('USDC', opts.issuer ?? issuer.publicKey()),
    amount: opts.amount ?? '100',
    ...(opts.source === undefined ? {} : { source: opts.source }),
  });

function build(opts: TxOptions = {}): StellarSdk.Transaction {
  const builder = new TransactionBuilder(new Account(client.publicKey(), '100'), {
    fee: opts.fee ?? '100',
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime: opts.maxTime ?? MAX_TIME },
  });
  for (const op of opts.operations ?? [payment()]) builder.addOperation(op);
  opts.tweak?.(builder);
  return builder.build();
}

const xdr = (opts: TxOptions = {}) => build(opts).toXDR();
const signer = (maxFeeStroops?: number) =>
  new TestKeySigner(client, PASSPHRASE, { now: () => NOW, ...(maxFeeStroops === undefined ? {} : { maxFeeStroops }) });

/** The signer's refusal of a transfer state, a quote or an account: the message. */
async function refusal(sign: Promise<string>): Promise<string> {
  try {
    await sign;
  } catch (e) {
    expect(e).toBeInstanceOf(SigningNotAllowedError);
    return (e as Error).message;
  }
  throw new Error('expected the signer to refuse');
}

/** The signer's refusal of the transaction itself: which check failed, and the message. */
async function mismatch(sign: Promise<string>): Promise<{ check: PayoutXdrCheck; message: string }> {
  try {
    await sign;
  } catch (e) {
    expect(e).toBeInstanceOf(PayoutXdrMismatchError);
    return { check: (e as PayoutXdrMismatchError).check, message: (e as Error).message };
  }
  throw new Error('expected the signer to refuse');
}

describe('TestKeySigner', () => {
  it('signs a payment that matches the context', async () => {
    const signed = await signer().signStellar(account, xdr(), context());
    const tx = TransactionBuilder.fromXDR(signed, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(1);
    expect(client.verify(tx.hash(), tx.signatures[0]!.signature)).toBe(true);
  });

  it('signs when the operation names the expected source itself', async () => {
    const unsigned = xdr({ operations: [payment({ source: client.publicKey() })] });
    await expect(signer().signStellar(account, unsigned, context())).resolves.toEqual(expect.any(String));
  });

  describe('refuses', () => {
    it('outside awaiting_signature', async () => {
      expect(await refusal(signer().signStellar(account, xdr(), context({ state: 'payout_quoted' })))).toMatch(
        /payout_quoted, not awaiting_signature/,
      );
    });

    it('an expired quote', async () => {
      const expired = context({ expiresAt: new Date(NOW - 1000).toISOString() });
      expect(await refusal(signer().signStellar(account, xdr(), expired))).toMatch(/expired/);
    });

    it('an account it holds no key for', async () => {
      const other: AccountRef = { chain: 'stellar', address: stranger.publicKey() };
      expect(await refusal(signer().signStellar(other, xdr(), context()))).toMatch(/holds no key/);
    });

    it('a payment operation that spends from another account', async () => {
      const unsigned = xdr({ operations: [payment({ source: stranger.publicKey() })] });
      expect(await mismatch(signer().signStellar(account, unsigned, context()))).toMatchObject({
        check: 'operation_source',
        message: expect.stringMatching(/other than the expected source/),
      });
    });

    it('two payment operations', async () => {
      const unsigned = xdr({ operations: [payment(), payment()] });
      expect(await mismatch(signer().signStellar(account, unsigned, context()))).toMatchObject({
        check: 'operations',
        message: 'Expected exactly one operation, got 2',
      });
    });

    it('an operation that is not a payment', async () => {
      const trust = Operation.changeTrust({ asset: new Asset('USDC', stranger.publicKey()) });
      const unsigned = xdr({ operations: [trust as unknown as ReturnType<typeof Operation.payment>] });
      expect(await mismatch(signer().signStellar(account, unsigned, context()))).toMatchObject({
        check: 'operation_type',
        message: expect.stringMatching(/Expected a payment operation/),
      });
    });

    it('a fee bump envelope', async () => {
      const inner = build();
      inner.sign(client);
      const bump = TransactionBuilder.buildFeeBumpTransaction(stranger, '200', inner, PASSPHRASE).toXDR();
      expect(await mismatch(signer().signStellar(account, bump, context()))).toMatchObject({ check: 'fee_bump' });
    });

    it('a fee above the default cap', async () => {
      const unsigned = xdr({ fee: String(DEFAULT_MAX_FEE_STROOPS + 1) });
      expect(await mismatch(signer().signStellar(account, unsigned, context()))).toMatchObject({
        check: 'fee',
        message: 'The fee of 1000001 stroops is above the cap of 1000000',
      });
      await expect(signer().signStellar(account, xdr({ fee: String(DEFAULT_MAX_FEE_STROOPS) }), context())).resolves.toEqual(
        expect.any(String),
      );
    });

    it('a fee above a configured cap', async () => {
      expect(await mismatch(signer(200).signStellar(account, xdr({ fee: '201' }), context()))).toMatchObject({
        check: 'fee',
        message: expect.stringMatching(/above the cap of 200/),
      });
    });

    it('another destination, asset issuer or amount', async () => {
      const cases = [
        [xdr({ operations: [payment({ destination: stranger.publicKey() })] }), 'destination'],
        [xdr({ operations: [payment({ issuer: stranger.publicKey() })] }), 'asset'],
        [xdr({ operations: [payment({ amount: '100.0000001' })] }), 'amount'],
      ] as const;
      for (const [unsigned, check] of cases) {
        expect(await mismatch(signer().signStellar(account, unsigned, context()))).toMatchObject({ check });
      }
    });

    it('a transaction with no maxTime, or one later than the quote expiry', async () => {
      expect(await mismatch(signer().signStellar(account, xdr({ maxTime: 0 }), context()))).toMatchObject({
        check: 'max_time',
        message: expect.stringMatching(/no maxTime/),
      });
      expect(await mismatch(signer().signStellar(account, xdr({ maxTime: MAX_TIME + 1 }), context()))).toMatchObject({
        check: 'max_time',
        message: expect.stringMatching(/may land after quote pq-1 expires/),
      });
    });

  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a fee cap of %p', (cap) => {
    expect(() => new TestKeySigner(client, PASSPHRASE, { maxFeeStroops: cap })).toThrow(/maxFeeStroops/);
  });
});
