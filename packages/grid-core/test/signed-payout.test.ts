import { fiat, stellarAsset } from '../src/assets';
import {
  InvalidInputError,
  PartnerHttpError,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  QuoteExpiredError,
  SignerRefusedError,
  SigningNotAllowedError,
} from '../src/errors';
import { money } from '../src/money';
import type { ExecutePayoutInput, LegQuote, LegRef, PayoutAuthorization } from '../src/ports';
import {
  DEFAULT_EXPIRY_MARGIN_MS,
  type ConfirmedSubmitOutcome,
  type RunSignedPayoutInput,
  type SignedPayoutSigning,
  retryPayoutExecute,
  runSignedPayout,
  signingContextFor,
} from '../src/signed-payout';
import { type Signer, assertSigningAllowed } from '../src/signer';
import type { StellarSubmitter, SubmitOutcome } from '../src/submission';
import { type TransferState, type TransitionReason, transition } from '../src/transfer-states';

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
  // The caller's stored state, moved only through the transition table.
  const store = { state: 'payout_quoted' as TransferState };
  const onAuthorized = jest.fn(async (_auth: PayoutAuthorization) => {
    order.push('authorized');
    store.state = transition(store.state, 'awaiting_signature', 'signed_payout_flow').to;
    return store.state;
  });
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
  const onSubmitted = jest.fn(async (_outcome: ConfirmedSubmitOutcome) => {
    order.push('recorded');
    store.state = transition(store.state, 'payout_submitted', 'signed_and_on_chain').to;
  });
  const signer: Signer = { custody: 'test_key', signStellar };
  const input: RunSignedPayoutInput = {
    adapter: { id: 'p', preparePayout, executePayout },
    context: { transferId: 'tr_1', state: 'payout_quoted', quote, account },
    funded: money('100', USDC),
    signing: {
      signer,
      submitter: { submit },
      submission: 'client_submits',
      destination: DESTINATION,
      onAuthorized,
      onSubmitted,
    },
    now: options.clock ?? (() => NOW),
    idempotencyKey: KEY,
  };
  return { input, order, store, preparePayout, onAuthorized, onSubmitted, executePayout, signStellar, submit };
}

/** The input for a partner that needs no signature: no signing group at all. */
function withoutSigning(input: RunSignedPayoutInput): RunSignedPayoutInput {
  const copy: { -readonly [K in keyof RunSignedPayoutInput]?: RunSignedPayoutInput[K] } = { ...input };
  delete copy.signing;
  return copy as RunSignedPayoutInput;
}

/** The input with some signing fields changed. */
function withSigning(
  input: RunSignedPayoutInput,
  change: { [K in keyof SignedPayoutSigning]?: SignedPayoutSigning[K] | undefined },
): RunSignedPayoutInput {
  return { ...input, signing: { ...input.signing, ...change } as SignedPayoutSigning };
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
    const { input, order, onAuthorized, executePayout, signStellar, submit } = setup();
    const res = await runSignedPayout(input);

    expect(order).toEqual(['prepare', 'authorized', 'sign', 'submit', 'recorded', 'execute']);
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(onAuthorized).toHaveBeenCalledWith({ kind: 'stellar_xdr', unsignedXdr: UNSIGNED });
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
    const res = await runSignedPayout(withSigning(input, { submission: 'partner_submits' }));
    expect(order).toEqual(['prepare', 'authorized', 'sign', 'execute']);
    expect(executePayout).toHaveBeenCalledWith({ quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED });
    expect(res.txHash).toBeUndefined();
  });

  it('goes straight to execute when the partner needs no signature', async () => {
    const { input, order, onAuthorized, executePayout, signStellar } = setup({ auth: { kind: 'none' } });
    const res = await runSignedPayout(input);
    expect(order).toEqual(['prepare', 'execute']);
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(signStellar).not.toHaveBeenCalled();
    expect(executePayout).toHaveBeenCalledWith({ quote, account, transferId: 'tr_1', idempotencyKey: KEY });
    expect(res).toMatchObject({ leg: LEG, authorization: 'none' });
  });

  it('needs no signing inputs when the partner needs no signature', async () => {
    const { input, order, executePayout } = setup({ auth: { kind: 'none' } });
    const res = await runSignedPayout(withoutSigning(input));
    expect(order).toEqual(['prepare', 'execute']);
    expect(executePayout).toHaveBeenCalledWith({ quote, account, transferId: 'tr_1', idempotencyKey: KEY });
    expect(res).toMatchObject({ leg: LEG, authorization: 'none' });
  });

  describe('authorization failures', () => {
    it('refuses a transaction to sign when the run has no signing inputs, still in payout_quoted', async () => {
      const { input, store, executePayout } = setup();
      const e = await caught(runSignedPayout(withoutSigning(input)));
      expect(e).toBeInstanceOf(PayoutAuthorizationError);
      expect(e).toMatchObject({ failure: 'invalid_authorization' });
      expect(store.state).toBe('payout_quoted');
      expect(executePayout).not.toHaveBeenCalled();
    });

    it('refuses a Stellar transaction for an account on another chain, before onAuthorized', async () => {
      const { input, onAuthorized, signStellar } = setup();
      const other = { ...input, context: { ...input.context, account: { chain: 'other-chain', address: SOURCE } } };
      const e = await caught(runSignedPayout(other));
      expect(e).toBeInstanceOf(PayoutAuthorizationError);
      expect(e).toMatchObject({ failure: 'invalid_authorization' });
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ['another kind', { kind: 'evm_tx' }],
      ['an empty XDR', { kind: 'stellar_xdr', unsignedXdr: '' }],
      ['an XDR that is not a string', { kind: 'stellar_xdr', unsignedXdr: 42 }],
      ['null', null],
      ['nothing', undefined],
      ['a bare string', 'AAAAUNSIGNED'],
    ])('refuses %s before onAuthorized and the signer', async (_name, auth) => {
      const { input, preparePayout, onAuthorized, signStellar, executePayout } = setup();
      preparePayout.mockResolvedValueOnce(auth as PayoutAuthorization);
      const e = await caught(runSignedPayout(input));
      expect(e).toBeInstanceOf(PayoutAuthorizationError);
      expect(e).toMatchObject({ code: 'payout_authorization_failed', failure: 'invalid_authorization' });
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
      expect(executePayout).not.toHaveBeenCalled();
    });

    it('wraps a preparePayout that throws, keeping the code and not the text', async () => {
      const { input, preparePayout, onAuthorized, signStellar } = setup();
      const cause = new PartnerHttpError({
        partner: 'p',
        method: 'POST',
        path: '/authorize',
        status: 400,
        bodySnippet: 'wallet of Jane Doe is frozen',
      });
      preparePayout.mockRejectedValueOnce(cause);
      const warn = jest.fn();
      const logger = { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() };
      const e = (await caught(runSignedPayout({ ...input, logger }))) as PayoutAuthorizationError;
      expect(e).toBeInstanceOf(PayoutAuthorizationError);
      expect(e).toMatchObject({ failure: 'threw', causeCode: 'partner_http' });
      expect(e.cause).toBeUndefined();
      expect(e.message).not.toMatch(/Jane/);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Jane/);
      expect(warn).toHaveBeenCalledWith('payout authorization failed', expect.objectContaining({ causeCode: 'partner_http' }));
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
    });
  });

  describe('error -> transition table', () => {
    type Row = [
      name: string,
      arrange: (s: ReturnType<typeof setup>) => RunSignedPayoutInput,
      error: { type: new (...args: never[]) => Error; stage?: string },
      edge: [from: TransferState, to: TransferState, reason: TransitionReason],
    ];
    const expiredAt = Date.parse(EXPIRES_AT);
    const rows: Row[] = [
      [
        'a quote too close to expiry before authorizing',
        (s) => ({ ...s.input, now: () => expiredAt }),
        { type: QuoteExpiredError, stage: 'authorization' },
        ['payout_quoted', 'funded', 'quote_expired_before_authorization'],
      ],
      [
        'a quote that expired while the partner authorized',
        (s) => {
          s.preparePayout.mockImplementationOnce(async () => {
            t = expiredAt;
            return { kind: 'stellar_xdr', unsignedXdr: UNSIGNED };
          });
          return s.input;
        },
        { type: QuoteExpiredError, stage: 'authorization' },
        ['payout_quoted', 'funded', 'quote_expired_before_authorization'],
      ],
      [
        'a preparePayout that throws',
        (s) => {
          s.preparePayout.mockRejectedValueOnce(new Error('authorize 500'));
          return s.input;
        },
        { type: PayoutAuthorizationError },
        ['payout_quoted', 'needs_attention', 'authorization_failed'],
      ],
      [
        'a preparePayout that returns garbage',
        (s) => {
          s.preparePayout.mockResolvedValueOnce({ kind: 'nope' } as unknown as PayoutAuthorization);
          return s.input;
        },
        { type: PayoutAuthorizationError },
        ['payout_quoted', 'needs_attention', 'authorization_failed'],
      ],
      [
        'a quote that expired between authorization and signing',
        (s) => {
          s.onAuthorized.mockImplementationOnce(async () => {
            s.store.state = transition(s.store.state, 'awaiting_signature', 'signed_payout_flow').to;
            t = expiredAt;
            return s.store.state;
          });
          return s.input;
        },
        { type: QuoteExpiredError, stage: 'signing' },
        ['awaiting_signature', 'funded', 'quote_expired_before_signing'],
      ],
      [
        'a quote that expired while signing',
        (s) => {
          s.signStellar.mockImplementationOnce(async () => {
            t = expiredAt;
            return SIGNED;
          });
          return s.input;
        },
        { type: QuoteExpiredError, stage: 'signing' },
        ['awaiting_signature', 'funded', 'quote_expired_before_signing'],
      ],
      [
        'a submit that is not a success',
        (s) => {
          s.submit.mockResolvedValueOnce({ status: 'rejected', hash: HASH });
          return s.input;
        },
        { type: PayoutIncompleteError, stage: 'submit' },
        ['awaiting_signature', 'needs_attention', 'submission_rejected_or_unknown'],
      ],
      [
        'a failed create after a confirmed submit',
        (s) => {
          s.executePayout.mockRejectedValueOnce(new Error('503'));
          return s.input;
        },
        { type: PayoutIncompleteError, stage: 'create' },
        ['payout_submitted', 'needs_attention', 'partner_refused_or_unknown'],
      ],
      [
        'a failed create with partner_submits',
        (s) => {
          s.executePayout.mockRejectedValueOnce(new Error('503'));
          return withSigning(s.input, { submission: 'partner_submits' });
        },
        { type: PayoutIncompleteError, stage: 'create' },
        ['awaiting_signature', 'needs_attention', 'submission_rejected_or_unknown'],
      ],
    ];
    let t = NOW;
    beforeEach(() => {
      t = NOW;
    });

    it.each(rows)('%s', async (_name, arrange, error, [from, to, reason]) => {
      const s = setup({ clock: () => t });
      const e = await caught(runSignedPayout(arrange(s)));
      expect(e).toBeInstanceOf(error.type);
      if (error.stage !== undefined) expect(e).toMatchObject({ stage: error.stage });
      expect(s.store.state).toBe(from);
      expect(transition(from, to, reason)).toMatchObject({ from, to, reason });
      expect(s.signStellar.mock.calls.length).toBeLessThanOrEqual(1);
      expect(s.onAuthorized).toHaveBeenCalledTimes(from === 'payout_quoted' ? 0 : 1);
    });
  });

  describe('onAuthorized', () => {
    it('stops before signing when it does not return awaiting_signature', async () => {
      const { input, onAuthorized, signStellar } = setup();
      onAuthorized.mockResolvedValueOnce('payout_quoted');
      const e = await caught(runSignedPayout(input));
      expect(e).toBeInstanceOf(SigningNotAllowedError);
      expect((e as Error).message).toMatch(/payout_quoted, not awaiting_signature/);
      expect(signStellar).not.toHaveBeenCalled();
    });

    // Review probe: the expiry was checked first, so a wrong state on an expiring
    // quote surfaced as QuoteExpiredError(signing), whose edge starts in a state
    // the transfer was not in.
    it('checks the returned state before the expiry', async () => {
      let t = NOW;
      const { input, onAuthorized, signStellar } = setup({ clock: () => t });
      onAuthorized.mockImplementationOnce(async () => {
        t = Date.parse(EXPIRES_AT);
        return 'payout_quoted';
      });
      const e = await caught(runSignedPayout(input));
      expect(e).toBeInstanceOf(SigningNotAllowedError);
      expect(signStellar).not.toHaveBeenCalled();
    });

    it('stops before signing when it throws, with its own error', async () => {
      const { input, onAuthorized, signStellar } = setup();
      onAuthorized.mockRejectedValueOnce(new Error('db down'));
      await expect(runSignedPayout(input)).rejects.toThrow('db down');
      expect(signStellar).not.toHaveBeenCalled();
    });

    it('may return the state synchronously', async () => {
      const { input, store, signStellar } = setup();
      const onAuthorized = () => (store.state = transition(store.state, 'awaiting_signature', 'signed_payout_flow').to);
      await runSignedPayout(withSigning(input, { onAuthorized }));
      expect(signStellar).toHaveBeenCalledTimes(1);
    });
  });

  describe('onSubmitted', () => {
    // Review probe: nothing was stored between a confirmed submit and the create,
    // so a crash there left the transfer in awaiting_signature after the money moved.
    it('stores payout_submitted after a confirmed success and before the partner is called', async () => {
      const { input, store, onSubmitted, executePayout } = setup();
      executePayout.mockImplementationOnce(async () => {
        expect(store.state).toBe('payout_submitted');
        return LEG;
      });
      await runSignedPayout(input);
      expect(onSubmitted).toHaveBeenCalledTimes(1);
      expect(onSubmitted).toHaveBeenCalledWith({ status: 'success', hash: HASH });
      expect(executePayout).toHaveBeenCalledTimes(1);
    });

    it('is not called with partner_submits', async () => {
      const { input, onSubmitted } = setup();
      await runSignedPayout(withSigning(input, { submission: 'partner_submits', submitter: undefined }));
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('is not called on a submit that is not a success', async () => {
      const { input, onSubmitted } = setup({ outcome: { status: 'unknown', hash: HASH } });
      await expect(runSignedPayout(input)).rejects.toMatchObject({ stage: 'submit' });
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('stops with stage record when it throws, never calling the partner, and the retry creates the payout', async () => {
      const { input, store, onSubmitted, executePayout, signStellar, submit } = setup();
      const cause = new Error('db down');
      onSubmitted.mockRejectedValueOnce(cause);
      const e = (await caught(runSignedPayout(input))) as PayoutIncompleteError<ExecutePayoutInput>;
      expect(e).toBeInstanceOf(PayoutIncompleteError);
      expect(e).toMatchObject({ code: 'payout_not_recorded', stage: 'record', txHash: HASH, signedXdr: SIGNED });
      expect(e.cause).toBe(cause);
      expect(e.message).toMatch(/money has moved/);
      expect(executePayout).not.toHaveBeenCalled();
      const body = { quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH };
      expect(e.pending).toEqual({ body, idempotencyKey: KEY });

      // The caller stores the move, then creates the payout. Nothing is signed or submitted again.
      expect(store.state).toBe('awaiting_signature');
      store.state = transition(store.state, 'payout_submitted', 'signed_and_on_chain').to;
      await expect(retryPayoutExecute(input.adapter, e.pending!)).resolves.toMatchObject({ leg: LEG, txHash: HASH });
      expect(executePayout).toHaveBeenCalledWith(body);
      expect(signStellar).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
    });
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
      expect(e).toMatchObject({ code: 'quote_expired', quoteId: 'q_1', expiresAt: EXPIRES_AT, stage: 'authorization' });
      expect(preparePayout).not.toHaveBeenCalled();
    });

    it('accepts a quote with one millisecond more than the margin', async () => {
      const { input } = setup({ clock: () => Date.parse(EXPIRES_AT) - DEFAULT_EXPIRY_MARGIN_MS - 1 });
      await expect(runSignedPayout(input)).resolves.toMatchObject({ leg: LEG });
    });

    it('does not sign a quote that expired while preparing', async () => {
      let reads = 0;
      const { input, onAuthorized, signStellar } = setup({ clock: () => (reads++ === 0 ? NOW : Date.parse(EXPIRES_AT)) });
      const e = await caught(runSignedPayout(input));
      expect(e).toBeInstanceOf(QuoteExpiredError);
      expect(e).toMatchObject({ stage: 'authorization' });
      expect(onAuthorized).not.toHaveBeenCalled();
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
      await expect(runSignedPayout(input)).rejects.toMatchObject({ code: 'quote_expired', stage: 'signing' });
      expect(signStellar).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(executePayout).not.toHaveBeenCalled();
    });

    // Review probe: the flow read expiries with Date.parse, so an HTTP date passed
    // the flow and was refused only by a signer that used the strict guard.
    it.each(['soon', 'Tue, 01 Jan 2030 00:05:00 GMT', '2030-01-01T00:05:00', '2030-01-01'])(
      'refuses the quote expiry %p, as the signer guard does',
      async (expiresAt) => {
        const { input, preparePayout } = setup();
        const bad = { ...input, context: { ...input.context, quote: { ...quote, expiresAt } } };
        await expect(runSignedPayout(bad)).rejects.toMatchObject({ code: 'quote_expired', stage: 'authorization' });
        expect(preparePayout).not.toHaveBeenCalled();
        const guard = signingContextFor({ ...bad.context, destination: DESTINATION }, 'awaiting_signature');
        expect(() => assertSigningAllowed(guard, new Date(NOW))).toThrow(/invalid expiry/);
      },
    );
  });

  describe('the submit budget', () => {
    const BUDGET = 150_000;
    const expiry = Date.parse(EXPIRES_AT);
    const needed = DEFAULT_EXPIRY_MARGIN_MS + BUDGET;
    const budgeted = (i: RunSignedPayoutInput, submit: StellarSubmitter['submit'], maxDurationMs: number) =>
      withSigning(i, { submitter: { submit, maxDurationMs } });

    // Review probe: a one-minute margin with a submitter that may take 150 s let a
    // transaction be signed whose submit could run past the quote.
    it('drops a quote that cannot outlive the margin plus the submit, before onAuthorized', async () => {
      const { input, submit, preparePayout, onAuthorized, signStellar } = setup({ clock: () => expiry - needed });
      const e = await caught(runSignedPayout(budgeted(input, submit, BUDGET)));
      expect(e).toBeInstanceOf(QuoteExpiredError);
      expect(e).toMatchObject({ stage: 'authorization' });
      expect(preparePayout).toHaveBeenCalledTimes(1);
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
    });

    it('refuses to sign when the margin plus the submit no longer fits after onAuthorized', async () => {
      let t = expiry - needed - 1;
      const { input, submit, onAuthorized, signStellar, store } = setup({ clock: () => t });
      onAuthorized.mockImplementationOnce(async () => {
        store.state = transition(store.state, 'awaiting_signature', 'signed_payout_flow').to;
        t += 1;
        return store.state;
      });
      const e = await caught(runSignedPayout(budgeted(input, submit, BUDGET)));
      expect(e).toBeInstanceOf(QuoteExpiredError);
      expect(e).toMatchObject({ stage: 'signing' });
      expect(signStellar).not.toHaveBeenCalled();
    });

    it('signs with one millisecond more than the margin plus the submit', async () => {
      const { input, submit, signStellar } = setup({ clock: () => expiry - needed - 1 });
      await expect(runSignedPayout(budgeted(input, submit, BUDGET))).resolves.toMatchObject({ txHash: HASH });
      expect(signStellar).toHaveBeenCalledTimes(1);
    });

    it('does not apply to partner_submits, where nothing is submitted here', async () => {
      const { input, submit } = setup({ clock: () => expiry - DEFAULT_EXPIRY_MARGIN_MS - 1 });
      const run = withSigning(budgeted(input, submit, BUDGET), { submission: 'partner_submits' });
      await expect(runSignedPayout(run)).resolves.toMatchObject({ authorization: 'stellar_xdr' });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, '1000' as unknown as number])(
      'refuses a maxDurationMs of %p before any call',
      async (maxDurationMs) => {
        const { input, submit, preparePayout } = setup();
        await expect(runSignedPayout(budgeted(input, submit, maxDurationMs))).rejects.toThrow(/maxDurationMs/);
        expect(preparePayout).not.toHaveBeenCalled();
      },
    );
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

  it.each(['awaiting_signature', 'funded'] as const)('refuses to start in %s, before any call', async (state) => {
    const { input, preparePayout, signStellar } = setup();
    const moved = { ...input, context: { ...input.context, state: state as unknown as 'payout_quoted' } };
    await expect(runSignedPayout(moved)).rejects.toThrow(/runs from payout_quoted/);
    expect(preparePayout).not.toHaveBeenCalled();
    expect(signStellar).not.toHaveBeenCalled();
  });

  describe('a signer that does not sign', () => {
    // Review probe: a plain Error from a custodian, or a non-string result, had no
    // edge in the table; a refusal shared its error with a wrong stored state.
    it.each<[string, (s: ReturnType<typeof setup>) => void, string, string | undefined]>([
      ['refuses with SigningNotAllowedError', (s) => s.signStellar.mockRejectedValueOnce(new SigningNotAllowedError('pays GXYZ')), 'threw', 'signing_not_allowed'],
      ['throws a plain Error', (s) => s.signStellar.mockRejectedValueOnce(new Error('ECONNRESET to custodian')), 'threw', undefined],
      ['throws a code-shaped error', (s) => s.signStellar.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'threw', 'ETIMEDOUT'],
      ['rejects with a string', (s) => s.signStellar.mockRejectedValueOnce('no'), 'threw', undefined],
      ['throws synchronously', (s) => s.signStellar.mockImplementationOnce(() => { throw new Error('sync'); }), 'threw', undefined],
      ['returns an empty string', (s) => s.signStellar.mockResolvedValueOnce(''), 'invalid_result', undefined],
      ['returns a number', (s) => s.signStellar.mockResolvedValueOnce(42 as unknown as string), 'invalid_result', undefined],
    ])('becomes SignerRefusedError when it %s, and nothing is submitted', async (_name, arrange, failure, causeCode) => {
      const s = setup();
      arrange(s);
      const e = await caught(runSignedPayout(s.input));
      expect(e).toBeInstanceOf(SignerRefusedError);
      expect(e).toMatchObject({ code: 'signer_refused', failure, causeCode });
      expect((e as Error).message).not.toMatch(/GXYZ|ECONNRESET|sync/);
      expect(s.store.state).toBe('awaiting_signature');
      expect(transition(s.store.state, 'needs_attention', 'signer_refused')).toBeDefined();
      expect(s.submit).not.toHaveBeenCalled();
      expect(s.executePayout).not.toHaveBeenCalled();
    });
  });

  it('hands the signed XDR to onSigned before submitting, and stops if it throws', async () => {
    const ok = setup();
    const onSigned = jest.fn(async (xdr: string) => {
      ok.order.push(`stored ${xdr}`);
    });
    await runSignedPayout(withSigning(ok.input, { onSigned }));
    expect(ok.order).toEqual(['prepare', 'authorized', 'sign', `stored ${SIGNED}`, 'submit', 'recorded', 'execute']);

    const failing = setup();
    await expect(
      runSignedPayout(withSigning(failing.input, { onSigned: () => Promise.reject(new Error('db down')) })),
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

  describe('retry input', () => {
    const body = { quote, account, transferId: 'tr_1', idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH };
    type Pending = Parameters<typeof retryPayoutExecute>[1];

    // Review probe: retryPayoutExecute(adapter, undefined) failed with a TypeError.
    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['no body', { idempotencyKey: KEY }],
      ['no key', { body }],
      ['an empty key', { body: { ...body, idempotencyKey: '' }, idempotencyKey: '' }],
      ['a body and key that disagree', { body: { ...body, idempotencyKey: 'other' }, idempotencyKey: KEY }],
      ['no transfer id', { body: { ...body, transferId: '' }, idempotencyKey: KEY }],
      ['a funding quote', { body: { ...body, quote: { ...quote, kind: 'funding' } }, idempotencyKey: KEY }],
      ['no quote', { body: { ...body, quote: undefined }, idempotencyKey: KEY }],
      ['no account', { body: { ...body, account: null }, idempotencyKey: KEY }],
      ['an empty signed XDR', { body: { ...body, signedXdr: '' }, idempotencyKey: KEY }],
      ['a malformed hash', { body: { ...body, txHash: 'zz' }, idempotencyKey: KEY }],
      ['a hash without a signed XDR', { body: { ...body, signedXdr: undefined }, idempotencyKey: KEY }],
    ])('refuses %s before calling the partner', async (_name, pending) => {
      const { input, executePayout } = setup();
      await expect(retryPayoutExecute(input.adapter, pending as Pending)).rejects.toThrow(InvalidInputError);
      expect(executePayout).not.toHaveBeenCalled();
    });

    it('sends a well-formed pending create as is', async () => {
      const { input, executePayout } = setup();
      await expect(retryPayoutExecute(input.adapter, { body, idempotencyKey: KEY })).resolves.toMatchObject({ leg: LEG });
      expect(executePayout).toHaveBeenCalledWith(body);
    });
  });

  describe('the amount is bounded by the funds', () => {
    const withQuote = (i: RunSignedPayoutInput, source: LegQuote['source']): RunSignedPayoutInput => ({
      ...i,
      context: { ...i.context, quote: { ...quote, source } },
    });

    it('signs for a quote below the funded amount, expecting the quote amount', async () => {
      const { input, signStellar } = setup();
      await runSignedPayout({ ...input, funded: money('100.1234567', USDC), context: { ...input.context, quote } });
      expect(signStellar).toHaveBeenCalledWith(
        account,
        UNSIGNED,
        expect.objectContaining({ expected: expect.objectContaining({ amount: quote.source }) }),
      );
    });

    // Review probe: a partner answering with twice the requested amount made the
    // signer expect, and sign, the larger amount.
    it.each<[string, (i: RunSignedPayoutInput) => RunSignedPayoutInput]>([
      ['a quote above the funded amount', (i) => withQuote(i, money('200', USDC))],
      ['a quote one stroop above the funded amount', (i) => withQuote(i, money('100.0000001', USDC))],
      ['a negative quote amount', (i) => withQuote(i, money('-5', USDC))],
      ['a zero quote amount', (i) => withQuote(i, money('0', USDC))],
      ['a quote in another asset', (i) => withQuote(i, money('100', fiat('USD')))],
      ['a quote for USDC from another issuer', (i) => withQuote(i, money('100', stellarAsset('USDC', DESTINATION)))],
      ['a malformed quote amount', (i) => withQuote(i, { amount: '1e3', asset: USDC })],
      ['no funded amount', (i) => ({ ...i, funded: undefined as unknown as RunSignedPayoutInput['funded'] })],
      ['a malformed funded amount', (i) => ({ ...i, funded: { amount: 'lots', asset: USDC } })],
    ])('refuses %s before any call', async (_name, change) => {
      const { input, preparePayout, signStellar } = setup();
      await expect(runSignedPayout(change(input))).rejects.toThrow(InvalidInputError);
      expect(preparePayout).not.toHaveBeenCalled();
      expect(signStellar).not.toHaveBeenCalled();
    });
  });

  it.each<[string, (i: RunSignedPayoutInput) => RunSignedPayoutInput]>([
    ['client_submits without a submitter', (i) => withSigning(i, { submitter: undefined })],
    ['client_submits without onSubmitted', (i) => withSigning(i, { onSubmitted: undefined })],
    ['an empty idempotency key', (i) => ({ ...i, idempotencyKey: '' })],
    ['an unknown submission mode', (i) => withSigning(i, { submission: 'nobody' as SignedPayoutSigning['submission'] })],
    ['a funding quote', (i) => ({ ...i, context: { ...i.context, quote: { ...quote, kind: 'funding' } } })],
    ['no onAuthorized', (i) => withSigning(i, { onAuthorized: undefined })],
    ['a signer without signStellar', (i) => withSigning(i, { signer: {} as Signer })],
    ['a destination that is not a Stellar account', (i) => withSigning(i, { destination: 'nowhere' })],
    ['a quote from another partner', (i) => ({ ...i, context: { ...i.context, quote: { ...quote, partner: 'other' } } })],
    ['an adapter without an id', (i) => ({ ...i, adapter: { ...i.adapter, id: '' } })],
  ])('refuses %s before any call', async (_name, change) => {
    const { input, preparePayout } = setup();
    await expect(runSignedPayout(change(input))).rejects.toThrow(InvalidInputError);
    expect(preparePayout).not.toHaveBeenCalled();
  });
});
