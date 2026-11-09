import { fiat, stellarAsset } from '../src/assets';
import {
  InvalidInputError,
  PayoutIncompleteError,
  QuoteExpiredError,
  SigningNotAllowedError,
} from '../src/errors';
import { money } from '../src/money';
import type { ExecutePayoutInput, LegQuote, LegRef, PayoutAuthorization } from '../src/ports';
import {
  DEFAULT_EXPIRY_MARGIN_MS,
  type RunSignedPayoutInput,
  retryPayoutExecute,
  runSignedPayout,
} from '../src/signed-payout';
import type { Signer } from '../src/signer';
import type { SubmitOutcome } from '../src/submission';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const EXPIRES_AT = new Date(NOW + 5 * 60_000).toISOString();
const SOURCE = `G${'A'.repeat(55)}`;
const DESTINATION = `G${'D'.repeat(55)}`;
const USDC = stellarAsset('USDC', `G${'I'.repeat(55)}`);
const UNSIGNED = 'AAAAUNSIGNED';
const SIGNED = 'AAAASIGNED';
const HASH = 'ab'.repeat(32);
const KEY = 'tr_1:payout';
const LEG: LegRef = { partner: 'p', kind: 'payout', id: 'po_1' };

const quote: LegQuote = {
  id: 'q_1',
  partner: 'p',
  kind: 'payout',
  expiresAt: EXPIRES_AT,
  source: money('100', USDC),
  target: money('99.5', fiat('USD')),
  fees: [],
};
const account = { chain: 'stellar', address: SOURCE } as const;

function setup(options: { auth?: PayoutAuthorization; outcome?: SubmitOutcome; clock?: () => number } = {}) {
  const order: string[] = [];
  const preparePayout = jest.fn(async () => {
    order.push('prepare');
    return options.auth ?? { kind: 'stellar_xdr' as const, unsignedXdr: UNSIGNED };
  });
  const executePayout = jest.fn(async (_input: ExecutePayoutInput) => {
    order.push('execute');
    return LEG;
  });
  const signStellar = jest.fn(async () => {
    order.push('sign');
    return SIGNED;
  });
  const submit = jest.fn(async (): Promise<SubmitOutcome> => {
    order.push('submit');
    return options.outcome ?? { status: 'success', hash: HASH };
  });
  const signer: Signer = { custody: 'test_key', signStellar };
  const input: RunSignedPayoutInput = {
    adapter: { preparePayout, executePayout },
    signer,
    submitter: { submit },
    submission: 'client_submits',
    context: { transferId: 'tr_1', state: 'awaiting_signature', quote, account, destination: DESTINATION },
    now: options.clock ?? (() => NOW),
    idempotencyKey: KEY,
  };
  return { input, order, preparePayout, executePayout, signStellar, submit };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('signed payout', () => {
  it('signs once, submits, then executes with the hash and the same key', async () => {
    const { input, order, executePayout, signStellar, submit } = setup();
    const res = await runSignedPayout(input);

    expect(order).toEqual(['prepare', 'sign', 'submit', 'execute']);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(signStellar).toHaveBeenCalledWith(account, UNSIGNED, {
      transferId: 'tr_1',
      state: 'awaiting_signature',
      quoteId: 'q_1',
      expiresAt: EXPIRES_AT,
      expected: { source: SOURCE, destination: DESTINATION, amount: quote.source },
    });
    expect(submit).toHaveBeenCalledWith(SIGNED);
    const body = { quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH };
    expect(executePayout).toHaveBeenCalledWith(body);
    expect(res).toEqual({
      leg: LEG,
      authorization: 'stellar_xdr',
      signedXdr: SIGNED,
      txHash: HASH,
      pending: { body, idempotencyKey: KEY },
    });
  });

  it('with partner_submits, hands the signed XDR to the partner and never submits', async () => {
    const { input, order, executePayout } = setup();
    const res = await runSignedPayout({ ...input, submission: 'partner_submits' });
    expect(order).toEqual(['prepare', 'sign', 'execute']);
    expect(executePayout).toHaveBeenCalledWith({ quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED });
    expect(res.txHash).toBeUndefined();
  });

  it('goes straight to execute when the partner needs no signature', async () => {
    const { input, order, executePayout, signStellar } = setup({ auth: { kind: 'none' } });
    const res = await runSignedPayout({ ...input, context: { ...input.context, state: 'payout_quoted' } });
    expect(order).toEqual(['prepare', 'execute']);
    expect(signStellar).not.toHaveBeenCalled();
    expect(executePayout).toHaveBeenCalledWith({ quote, account, transferId: 'tr_1', idempotencyKey: KEY });
    expect(res).toMatchObject({ leg: LEG, authorization: 'none' });
  });

  it('refuses an authorization it does not know, before signing', async () => {
    const { input, signStellar } = setup({ auth: { kind: 'evm_tx' } as unknown as PayoutAuthorization });
    await expect(runSignedPayout(input)).rejects.toThrow(InvalidInputError);
    expect(signStellar).not.toHaveBeenCalled();
  });

  describe('submit outcomes', () => {
    // A failed submit must never let the payout be created: the old flow accepted any hash.
    it.each<SubmitOutcome>([
      { status: 'failed', hash: HASH, detail: { transactionCode: 'tx_failed' } },
      { status: 'rejected', hash: HASH, detail: { operationCodes: ['op_underfunded'] } },
      { status: 'unknown', hash: HASH },
      { status: 'expired_not_landed', hash: HASH },
    ])('stops on $status, carrying the outcome, and never executes', async (outcome) => {
      const { input, executePayout, signStellar } = setup({ outcome });
      const e = (await caught(runSignedPayout(input))) as PayoutIncompleteError;
      expect(e).toBeInstanceOf(PayoutIncompleteError);
      expect(e).toMatchObject({ code: 'payout_not_recorded', stage: 'submit', outcome, txHash: HASH, signedXdr: SIGNED });
      expect(e.pending).toBeUndefined();
      expect(executePayout).not.toHaveBeenCalled();
      expect(signStellar).toHaveBeenCalledTimes(1);
    });

    it('stops when the submitter throws, keeping the cause', async () => {
      const { input, submit, executePayout } = setup();
      const cause = new Error('horizon timeout');
      submit.mockRejectedValueOnce(cause);
      const e = (await caught(runSignedPayout(input))) as PayoutIncompleteError;
      expect(e).toMatchObject({ stage: 'submit', signedXdr: SIGNED, outcome: undefined, txHash: undefined });
      expect(e.cause).toBe(cause);
      expect(executePayout).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ['a malformed hash', { status: 'success', hash: 'nope' }],
      ['no hash', { status: 'success' }],
      ['a bare hash without a status', { hash: HASH }],
      ['nothing', undefined],
    ])('treats a success with %s as not confirmed', async (_name, outcome) => {
      const { input, submit, executePayout } = setup();
      submit.mockResolvedValueOnce(outcome as SubmitOutcome);
      await expect(runSignedPayout(input)).rejects.toMatchObject({ stage: 'submit' });
      expect(executePayout).not.toHaveBeenCalled();
    });

    it('executes after a success even if the quote expired during submission: the payment moved', async () => {
      let t = NOW;
      const { input, submit, executePayout } = setup({ clock: () => t });
      submit.mockImplementationOnce(async () => {
        t = Date.parse(EXPIRES_AT) + 150_000;
        return { status: 'success', hash: HASH };
      });
      await expect(runSignedPayout(input)).resolves.toMatchObject({ txHash: HASH });
      expect(executePayout).toHaveBeenCalledTimes(1);
    });
  });

  describe('quote expiry', () => {
    it('defaults to a one minute margin', () => {
      expect(DEFAULT_EXPIRY_MARGIN_MS).toBe(60_000);
    });

    it('refuses a quote with exactly the margin left, before preparing', async () => {
      const { input, preparePayout } = setup({ clock: () => Date.parse(EXPIRES_AT) - DEFAULT_EXPIRY_MARGIN_MS });
      const e = await caught(runSignedPayout(input));
      expect(e).toBeInstanceOf(QuoteExpiredError);
      expect(e).toMatchObject({ code: 'quote_expired', quoteId: 'q_1', expiresAt: EXPIRES_AT });
      expect(preparePayout).not.toHaveBeenCalled();
    });

    it('accepts a quote with one millisecond more than the margin', async () => {
      const { input } = setup({ clock: () => Date.parse(EXPIRES_AT) - DEFAULT_EXPIRY_MARGIN_MS - 1 });
      await expect(runSignedPayout(input)).resolves.toMatchObject({ leg: LEG });
    });

    it('does not sign a quote that expired while preparing', async () => {
      let reads = 0;
      const { input, signStellar } = setup({ clock: () => (reads++ === 0 ? NOW : Date.parse(EXPIRES_AT)) });
      await expect(runSignedPayout(input)).rejects.toBeInstanceOf(QuoteExpiredError);
      expect(signStellar).not.toHaveBeenCalled();
    });

    // One millisecond from expiry, then a slow signer: with no margin and no
    // second check, the old flow signed and submitted an expired quote.
    it('never submits a transaction whose quote expired while signing', async () => {
      let t = NOW;
      const { input, signStellar, submit, executePayout } = setup({ clock: () => t });
      signStellar.mockImplementationOnce(async () => {
        t = Date.parse(EXPIRES_AT) - 1;
        return SIGNED;
      });
      await expect(runSignedPayout(input)).rejects.toBeInstanceOf(QuoteExpiredError);
      expect(signStellar).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(executePayout).not.toHaveBeenCalled();
    });

    it('refuses an unparseable quote expiry', async () => {
      const { input, preparePayout } = setup();
      const bad = { ...input, context: { ...input.context, quote: { ...quote, expiresAt: 'soon' } } };
      await expect(runSignedPayout(bad)).rejects.toBeInstanceOf(QuoteExpiredError);
      expect(preparePayout).not.toHaveBeenCalled();
    });
  });

  describe('fails closed', () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'on a clock that reads %p, even for a quote that expired long ago',
      async (reading) => {
        const { input, preparePayout, signStellar } = setup({ clock: () => reading });
        const old = { ...input, context: { ...input.context, quote: { ...quote, expiresAt: '2001-01-01T00:00:00Z' } } };
        await expect(runSignedPayout(old)).rejects.toThrow(/invalid time/);
        expect(preparePayout).not.toHaveBeenCalled();
        expect(signStellar).not.toHaveBeenCalled();
      },
    );

    it('on a clock that breaks after preparing', async () => {
      let reads = 0;
      const { input, signStellar } = setup({ clock: () => (reads++ === 0 ? NOW : Number.NaN) });
      await expect(runSignedPayout(input)).rejects.toThrow(InvalidInputError);
      expect(signStellar).not.toHaveBeenCalled();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('on an expiry margin of %p', async (expiryMarginMs) => {
      const { input, preparePayout, signStellar } = setup();
      await expect(runSignedPayout({ ...input, expiryMarginMs })).rejects.toThrow(/expiryMarginMs/);
      expect(preparePayout).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
    });
  });

  it('refuses to sign outside awaiting_signature', async () => {
    const { input, signStellar } = setup();
    const funded = { ...input, context: { ...input.context, state: 'payout_quoted' as const } };
    await expect(runSignedPayout(funded)).rejects.toBeInstanceOf(SigningNotAllowedError);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('stops when the signer refuses or returns nothing', async () => {
    const refused = setup();
    refused.signStellar.mockRejectedValueOnce(new SigningNotAllowedError('wrong destination'));
    await expect(runSignedPayout(refused.input)).rejects.toThrow(/wrong destination/);
    expect(refused.submit).not.toHaveBeenCalled();

    const empty = setup();
    empty.signStellar.mockResolvedValueOnce('');
    await expect(runSignedPayout(empty.input)).rejects.toThrow(/empty transaction/);
    expect(empty.submit).not.toHaveBeenCalled();
  });

  it('hands the signed XDR to onSigned before submitting, and stops if it throws', async () => {
    const ok = setup();
    const onSigned = jest.fn(async (xdr: string) => {
      ok.order.push(`stored ${xdr}`);
    });
    await runSignedPayout({ ...ok.input, onSigned });
    expect(ok.order).toEqual(['prepare', 'sign', `stored ${SIGNED}`, 'submit', 'execute']);

    const failing = setup();
    await expect(
      runSignedPayout({ ...failing.input, onSigned: () => Promise.reject(new Error('db down')) }),
    ).rejects.toThrow('db down');
    expect(failing.submit).not.toHaveBeenCalled();
    expect(failing.executePayout).not.toHaveBeenCalled();
  });

  it('keeps the execute input when create fails, and a retry reuses it unchanged', async () => {
    const { input, executePayout, signStellar, submit } = setup();
    const cause = new Error('503');
    executePayout.mockRejectedValueOnce(cause).mockRejectedValueOnce(new Error('409 in flight'));

    const e = (await caught(runSignedPayout(input))) as PayoutIncompleteError<ExecutePayoutInput>;
    expect(e).toMatchObject({ stage: 'create', signedXdr: SIGNED, txHash: HASH });
    expect(e.cause).toBe(cause);
    const pending = e.pending!;
    expect(pending.idempotencyKey).toBe(KEY);
    expect(pending.body).toEqual({ quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH });

    const e2 = (await caught(retryPayoutExecute(input.adapter, pending))) as PayoutIncompleteError<ExecutePayoutInput>;
    expect(e2).toMatchObject({ stage: 'create', pending });
    const ok = await retryPayoutExecute(input.adapter, e2.pending!);
    expect(ok).toMatchObject({ leg: LEG, authorization: 'stellar_xdr', txHash: HASH });

    expect(executePayout).toHaveBeenCalledTimes(3);
    for (const call of executePayout.mock.calls) expect(call[0]).toBe(pending.body);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('wraps a create failure without a signature the same way', async () => {
    const { input, executePayout } = setup({ auth: { kind: 'none' } });
    executePayout.mockRejectedValueOnce(new Error('503'));
    const e = (await caught(runSignedPayout(input))) as PayoutIncompleteError;
    expect(e).toMatchObject({ stage: 'create', signedXdr: undefined, txHash: undefined });
    expect(e.pending?.idempotencyKey).toBe(KEY);
  });

  it('refuses a retry whose body and key disagree', async () => {
    const { input, executePayout } = setup();
    const body = { quote, account, transferId: 'tr_1', idempotencyKey: 'other' };
    await expect(retryPayoutExecute(input.adapter, { body, idempotencyKey: KEY })).rejects.toThrow(InvalidInputError);
    expect(executePayout).not.toHaveBeenCalled();
  });

  it.each<[string, (i: RunSignedPayoutInput) => RunSignedPayoutInput]>([
    ['client_submits without a submitter', ({ submitter: _s, ...rest }) => rest],
    ['an empty idempotency key', (i) => ({ ...i, idempotencyKey: '' })],
    ['an unknown submission mode', (i) => ({ ...i, submission: 'nobody' as RunSignedPayoutInput['submission'] })],
    ['a funding quote', (i) => ({ ...i, context: { ...i.context, quote: { ...quote, kind: 'funding' } } })],
  ])('refuses %s before any call', async (_name, change) => {
    const { input, preparePayout } = setup();
    await expect(runSignedPayout(change(input))).rejects.toThrow(InvalidInputError);
    expect(preparePayout).not.toHaveBeenCalled();
  });
});
