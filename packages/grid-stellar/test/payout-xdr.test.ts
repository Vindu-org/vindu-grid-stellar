import { InvalidConfigError, type SigningContext, fiat, money } from '@vindu/grid-core';
import { TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { DEFAULT_MAX_FEE_STROOPS, PayoutXdrMismatchError, assertPayoutXdrMatches } from '../src/payout-xdr';
import { stellarSdk } from '../src/sdk';

const { Account, Asset, Keypair, MuxedAccount, Networks, Operation, TransactionBuilder } = stellarSdk;

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const EXPIRES_AT = new Date(T0 + 600_000).toISOString();
const MAX_TIME = (T0 + 300_000) / 1000;

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const USDC = new Asset('USDC', issuer);

const context: SigningContext = {
  transferId: 'tr_1',
  state: 'awaiting_signature',
  quoteId: 'qu_1',
  expiresAt: EXPIRES_AT,
  expected: { source, destination, amount: money('25.5', { code: 'USDC', issuer }) },
};

type Builder = InstanceType<typeof TransactionBuilder>;

interface Shape {
  readonly txSource?: string;
  readonly fee?: string;
  readonly maxTime?: number;
  readonly passphrase?: string;
  readonly operations?: ReadonlyArray<ReturnType<typeof Operation.payment>>;
  readonly tweak?: (builder: Builder) => Builder;
}

/** A real unsigned payment transaction, as base64 XDR. Overrides change one thing at a time. */
function payout(shape: Shape = {}): string {
  const txSource = shape.txSource ?? source;
  const account = txSource.startsWith('M') ? MuxedAccount.fromAddress(txSource, '100') : new Account(txSource, '100');
  let builder = new TransactionBuilder(account, {
    fee: shape.fee ?? '100',
    networkPassphrase: shape.passphrase ?? Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: shape.maxTime ?? MAX_TIME },
  });
  for (const op of shape.operations ?? [payment()]) builder = builder.addOperation(op);
  if (shape.tweak !== undefined) builder = shape.tweak(builder);
  return builder.build().toXDR();
}

function payment(overrides: Partial<Parameters<typeof Operation.payment>[0]> = {}) {
  return Operation.payment({ destination, asset: USDC, amount: '25.5', ...overrides });
}

const check = (xdr: string, ctx: SigningContext = context, extra: { maxFeeStroops?: number } = {}) =>
  assertPayoutXdrMatches(xdr, ctx, { networkPassphrase: TESTNET_NETWORK_PASSPHRASE, ...extra });

/** The check that refused `xdr`, or `null` when it was accepted. */
function refusal(xdr: string, ctx: SigningContext = context, extra: { maxFeeStroops?: number } = {}): string | null {
  try {
    check(xdr, ctx, extra);
    return null;
  } catch (e) {
    if (e instanceof PayoutXdrMismatchError) return e.check;
    throw e;
  }
}

describe('assertPayoutXdrMatches', () => {
  it('accepts the exact payment', () => {
    expect(() => check(payout())).not.toThrow();
  });

  it('accepts an operation source equal to the expected source, plain or muxed', () => {
    const muxed = new MuxedAccount(new Account(source, '1'), '42').accountId();
    expect(muxed.startsWith('M')).toBe(true);
    expect(refusal(payout({ operations: [payment({ source })] }))).toBeNull();
    expect(refusal(payout({ operations: [payment({ source: muxed })] }))).toBeNull();
  });

  it('accepts the native asset when lumens are expected', () => {
    const xlm: SigningContext = { ...context, expected: { ...context.expected, amount: money('3', { code: 'XLM' }) } };
    expect(refusal(payout({ operations: [payment({ asset: Asset.native(), amount: '3' })] }), xlm)).toBeNull();
  });

  it('accepts a fee exactly at the cap, and zeroed newer preconditions', () => {
    // 1 operation x 1 000 000 stroops = the default cap.
    expect(refusal(payout({ fee: String(DEFAULT_MAX_FEE_STROOPS) }))).toBeNull();
    const zeros = payout({
      tweak: (b) => b.setLedgerbounds(0, 0).setMinAccountSequenceAge(0n).setMinAccountSequenceLedgerGap(0),
    });
    expect(refusal(zeros)).toBeNull();
  });

  it('throws a typed error that never carries the XDR', () => {
    const xdr = payout({ operations: [payment({ amount: '26' })] });
    const error = (() => {
      try {
        check(xdr);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(PayoutXdrMismatchError);
    expect(error).toMatchObject({ code: 'payout_xdr_mismatch', check: 'amount' });
    expect(String((error as Error).message)).not.toContain(xdr);
  });

  // Each row: what is wrong, the transaction, the check that refuses it, and a context when not the default.
  const refusals: Array<[string, () => string, string, SigningContext]> = [
    ['not an envelope', () => 'AAAA', 'decode', context],
    [
      'a fee bump',
      () => {
        const inner = TransactionBuilder.fromXDR(payout(), Networks.TESTNET) as InstanceType<typeof stellarSdk.Transaction>;
        return TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '200', inner, Networks.TESTNET).toXDR();
      },
      'fee_bump',
      context,
    ],
    ['two operations', () => payout({ operations: [payment(), payment()] }), 'operations', context],
    [
      'another operation type',
      () =>
        payout({
          operations: [Operation.createAccount({ destination, startingBalance: '25.5' }) as ReturnType<typeof Operation.payment>],
        }),
      'operation_type',
      context,
    ],
    ['another transaction source', () => payout({ txSource: Keypair.random().publicKey() }), 'source', context],
    [
      'a muxed transaction source',
      () => payout({ txSource: new MuxedAccount(new Account(source, '1'), '7').accountId() }),
      'source',
      context,
    ],
    ['another operation source', () => payout({ operations: [payment({ source: Keypair.random().publicKey() })] }), 'operation_source', context],
    [
      'a muxed operation source of another account',
      () =>
        payout({
          operations: [payment({ source: new MuxedAccount(new Account(Keypair.random().publicKey(), '1'), '42').accountId() })],
        }),
      'operation_source',
      context,
    ],
    ['another destination', () => payout({ operations: [payment({ destination: Keypair.random().publicKey() })] }), 'destination', context],
    [
      'a muxed destination',
      () => payout({ operations: [payment({ destination: new MuxedAccount(new Account(destination, '1'), '9').accountId() })] }),
      'destination',
      context,
    ],
    ['another asset code', () => payout({ operations: [payment({ asset: new Asset('USDB', issuer) })] }), 'asset', context],
    [
      'the same code from another issuer',
      () => payout({ operations: [payment({ asset: new Asset('USDC', Keypair.random().publicKey()) })] }),
      'asset',
      context,
    ],
    ['lumens instead of the asset', () => payout({ operations: [payment({ asset: Asset.native() })] }), 'asset', context],
    ['a larger amount', () => payout({ operations: [payment({ amount: '25.5000001' })] }), 'amount', context],
    ['a smaller amount', () => payout({ operations: [payment({ amount: '25' })] }), 'amount', context],
    ['a fee above the cap', () => payout({ fee: String(DEFAULT_MAX_FEE_STROOPS + 1) }), 'fee', context],
    ['no maxTime', () => payout({ maxTime: 0 }), 'max_time', context],
    ['a maxTime after the quote expiry', () => payout({ maxTime: (T0 + 600_000) / 1000 + 1 }), 'max_time', context],
    [
      'a minimum account sequence',
      () => payout({ tweak: (b) => b.setMinAccountSequence('5') }),
      'preconditions',
      context,
    ],
    [
      'a minimum account sequence age',
      () => payout({ tweak: (b) => b.setMinAccountSequenceAge(60n) }),
      'preconditions',
      context,
    ],
    [
      'a minimum account sequence ledger gap',
      () => payout({ tweak: (b) => b.setMinAccountSequenceLedgerGap(3) }),
      'preconditions',
      context,
    ],
    [
      'extra signers',
      () => payout({ tweak: (b) => b.setExtraSigners([Keypair.random().publicKey()]) }),
      'preconditions',
      context,
    ],
    ['ledger bounds', () => payout({ tweak: (b) => b.setLedgerbounds(10, 0) }), 'preconditions', context],
    ['an upper ledger bound', () => payout({ tweak: (b) => b.setLedgerbounds(0, 900) }), 'preconditions', context],
    [
      'an expiry the context cannot parse',
      () => payout(),
      'max_time',
      { ...context, expiresAt: 'tomorrow' },
    ],
  ];

  it.each(refusals)('refuses %s', (_name, build, expected, ctx) => {
    expect(refusal(build(), ctx)).toBe(expected);
  });

  it('cannot check the network from the unsigned envelope, and needs the passphrase set', () => {
    // An envelope does not name its network: the same bytes decode under any
    // passphrase, so one built for another network passes. What binds it to
    // one network is the hash the signer signs, computed for the passphrase
    // it signs under. An empty passphrase is a configuration error.
    expect(refusal(payout({ passphrase: Networks.PUBLIC }))).toBeNull();
    expect(() => assertPayoutXdrMatches(payout(), context, { networkPassphrase: '' })).toThrow(InvalidConfigError);
  });

  it('honours a lower fee cap and refuses a bad one', () => {
    expect(refusal(payout({ fee: '500' }), context, { maxFeeStroops: 499 })).toBe('fee');
    expect(refusal(payout({ fee: '500' }), context, { maxFeeStroops: 500 })).toBeNull();
    for (const maxFeeStroops of [0, -1, 1.5, Number.NaN]) {
      expect(() => check(payout(), context, { maxFeeStroops })).toThrow(InvalidConfigError);
    }
  });

  it('uses the issuer, not just the code, for a fiat-looking expected asset', () => {
    const fiatUsdc: SigningContext = { ...context, expected: { ...context.expected, amount: money('25.5', fiat('USDC')) } };
    expect(refusal(payout(), fiatUsdc)).toBe('asset');
  });
});
