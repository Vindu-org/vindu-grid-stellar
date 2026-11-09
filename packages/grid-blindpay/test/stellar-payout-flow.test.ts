import {
  type ExecutePayoutInput,
  InvalidInputError,
  type LegQuote,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  type PayoutSubmission,
  QuoteExpiredError,
  type SignedPayoutContext,
  type Signer,
  SignerRefusedError,
  SigningNotAllowedError,
  type TransferState,
  type StellarSubmitter,
  type SubmitOutcome,
  fiat,
  money,
  stellarAsset,
} from '@vindu/grid-core';

import { createBlindPayAdapter } from '../src/adapter';
import {
  type RunStellarPayoutInput,
  type StellarPayoutSigning,
  retryStellarPayoutCreate,
  runStellarPayout,
} from '../src/stellar-payout-flow';
import type { SignedTransactionField } from '../src/types';
import { type MockReply, STELLAR_ADDRESS, USDB_ISSUER, WALLET_ID, caught, config, mockFetch } from './helpers';

const QUOTE_ID = 'qu_000000000000';
const UNSIGNED = 'AAAAUNSIGNEDXDR==';
const SIGNED = 'AAAASIGNEDXDR==';
const HASH = 'ab'.repeat(32);
const NOW = Date.parse('2030-01-01T00:00:00Z');
const KEY = 'payout-key-1';
const TREASURY = `G${'B'.repeat(55)}`;
const usdb = stellarAsset('USDB', USDB_ISSUER);

const quote: LegQuote = {
  id: QUOTE_ID,
  partner: 'blindpay',
  kind: 'payout',
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  source: money('100', usdb),
  target: money('100', fiat('USD')),
  fees: [],
};
const account = { chain: 'stellar', address: STELLAR_ADDRESS, partnerAccountId: WALLET_ID } as const;
const context: SignedPayoutContext = { transferId: 'tr_000000000000', state: 'payout_quoted', quote, account };
const FUNDED = money('100', usdb);

const AUTHORIZED: MockReply = { body: { transaction_hash: UNSIGNED } };
const CREATED: MockReply = { body: { id: 'po_000000000000', status: 'processing' } };
const SUCCESS: SubmitOutcome = { status: 'success', hash: HASH };

function setup(replies: MockReply[], opts: { clock?: () => number; field?: SignedTransactionField } = {}) {
  const { fetch, calls } = mockFetch(replies);
  const adapter = createBlindPayAdapter(config(fetch), {
    network: 'stellar_testnet',
    assetIssuers: { USDB: USDB_ISSUER },
    ...(opts.field === undefined ? {} : { signedTransactionField: opts.field }),
  });
  const signStellar = jest.fn(async () => SIGNED);
  const signer: Signer = { custody: 'test_key', signStellar };
  const submit = jest.fn<Promise<SubmitOutcome>, [string]>(async () => SUCCESS);
  const onAuthorized = jest.fn(async (): Promise<TransferState> => 'awaiting_signature');
  const onSubmitted = jest.fn(async () => undefined);
  const base: RunStellarPayoutInput = {
    adapter,
    context,
    funded: FUNDED,
    signing: { signer, submitter: { submit }, destination: TREASURY, onAuthorized, onSubmitted },
    idempotencyKey: KEY,
    now: opts.clock ?? (() => NOW),
  };
  const paths = () => calls.map((c) => c.url.replace(/^.*\/in_000000000000/, ''));
  return { calls, paths, adapter, signStellar, submit, onAuthorized, onSubmitted, base };
}

/** The input with some signing fields changed. */
function withSigning(
  input: RunStellarPayoutInput,
  change: { [K in keyof StellarPayoutSigning]?: StellarPayoutSigning[K] | undefined },
): RunStellarPayoutInput {
  return { ...input, signing: { ...input.signing, ...change } as StellarPayoutSigning };
}

describe('stellar payout flow', () => {
  it.each<[PayoutSubmission, SignedTransactionField, string, number]>([
    ['client_submits', 'signed_xdr', SIGNED, 1],
    ['client_submits', 'tx_hash', HASH, 1],
    ['partner_submits', 'signed_xdr', SIGNED, 0],
  ])('payout with %s and %s sends the right signed_transaction', async (submission, field, sent, submits) => {
    const { calls, paths, signStellar, submit, onAuthorized, base } = setup([AUTHORIZED, CREATED], { field });
    const res = await runStellarPayout(withSigning(base, { submission }));

    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(onAuthorized).toHaveBeenCalledWith({ kind: 'stellar_xdr', unsignedXdr: UNSIGNED });
    expect(onAuthorized.mock.invocationCallOrder[0]).toBeLessThan(signStellar.mock.invocationCallOrder[0] ?? 0);
    expect(paths()).toEqual(['/payouts/stellar/authorize', '/payouts/stellar']);
    expect(calls[0]?.body).toEqual({ quote_id: QUOTE_ID, sender_wallet_address: STELLAR_ADDRESS });
    expect(calls[1]?.body).toEqual({ quote_id: QUOTE_ID, signed_transaction: sent, sender_wallet_address: STELLAR_ADDRESS });
    expect(calls[1]?.headers['Idempotency-Key']).toBe(KEY);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(signStellar).toHaveBeenCalledWith(account, UNSIGNED, {
      transferId: context.transferId, state: 'awaiting_signature', quoteId: QUOTE_ID, expiresAt: quote.expiresAt,
      expected: { source: STELLAR_ADDRESS, destination: TREASURY, amount: quote.source },
    });
    expect(submit).toHaveBeenCalledTimes(submits);
    if (submits === 1) expect(submit).toHaveBeenCalledWith(SIGNED);
    expect(res).toMatchObject({ leg: { partner: 'blindpay', kind: 'payout', id: 'po_000000000000' }, authorization: 'stellar_xdr', signedXdr: SIGNED });
    expect(res.pending.idempotencyKey).toBe(KEY);
    expect(res.txHash).toBe(submits === 1 ? HASH : undefined);
  });

  it('payout with partner_submits and a tx_hash adapter is refused before any call or signature', async () => {
    const { calls, signStellar, base } = setup([], { field: 'tx_hash' });
    await expect(runStellarPayout(withSigning(base, { submission: 'partner_submits' }))).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout with client_submits and no submitter is refused up front', async () => {
    const { calls, signStellar, base } = setup([]);
    await expect(runStellarPayout(withSigning(base, { submitter: undefined }))).rejects.toThrow(/submitter/);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout refuses a quote from another partner and a non-Stellar account before any call', async () => {
    const { calls, base } = setup([]);
    await expect(runStellarPayout({ ...base, context: { ...context, quote: { ...quote, partner: 'other' } } })).rejects.toThrow(/other/);
    await expect(runStellarPayout({ ...base, context: { ...context, account: { ...account, chain: 'other-chain' } } })).rejects.toThrow(/Stellar/);
    expect(calls).toHaveLength(0);
  });

  it('payout without signing inputs is refused before any call', async () => {
    const { calls, base } = setup([]);
    const noSigning: { -readonly [K in keyof RunStellarPayoutInput]?: RunStellarPayoutInput[K] } = { ...base };
    delete noSigning.signing;
    await expect(runStellarPayout(noSigning as RunStellarPayoutInput)).rejects.toThrow(/signing is required/);
    expect(calls).toHaveLength(0);
  });

  it('payout with client_submits and no onSubmitted is refused before any call', async () => {
    const { calls, signStellar, base } = setup([]);
    await expect(runStellarPayout(withSigning(base, { onSubmitted: undefined }))).rejects.toThrow(/onSubmitted/);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout stores the confirmed submit before BlindPay hears about it', async () => {
    const { calls, onSubmitted, submit, base } = setup([AUTHORIZED, CREATED]);
    await runStellarPayout(base);
    expect(onSubmitted).toHaveBeenCalledWith(SUCCESS);
    expect(submit.mock.invocationCallOrder[0]).toBeLessThan(onSubmitted.mock.invocationCallOrder[0] ?? 0);
    // Two calls: authorize, then create; onSubmitted ran between the submit and the create.
    expect(calls).toHaveLength(2);
  });

  it('payout whose onSubmitted throws stops with stage record, and the retry creates it', async () => {
    const { calls, adapter, onSubmitted, signStellar, submit, base } = setup([AUTHORIZED, CREATED]);
    onSubmitted.mockRejectedValueOnce(new Error('db down'));
    const e = (await caught(runStellarPayout(base))) as PayoutIncompleteError<ExecutePayoutInput>;
    expect(e).toMatchObject({ stage: 'record', txHash: HASH });
    expect(calls).toHaveLength(1);
    await expect(retryStellarPayoutCreate(adapter, e.pending!)).resolves.toMatchObject({ txHash: HASH });
    expect(calls).toHaveLength(2);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['above the funded amount', money('99.99', usdb)],
    ['in another asset', money('100', stellarAsset('USDC', USDB_ISSUER))],
  ])('payout of a quote %s is refused before any call', async (_name, funded) => {
    const { calls, signStellar, base } = setup([AUTHORIZED, CREATED]);
    await expect(runStellarPayout({ ...base, funded })).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout whose signer throws stops with SignerRefusedError and never submits', async () => {
    const { paths, signStellar, submit, base } = setup([AUTHORIZED, CREATED]);
    signStellar.mockRejectedValueOnce(new Error('custodian timeout'));
    await expect(runStellarPayout(base)).rejects.toBeInstanceOf(SignerRefusedError);
    expect(submit).not.toHaveBeenCalled();
    expect(paths()).toEqual(['/payouts/stellar/authorize']);
  });

  it('payout on an expired quote throws QuoteExpiredError and never authorizes or signs', async () => {
    const { calls, signStellar, onAuthorized, base } = setup([], { clock: () => Date.parse(quote.expiresAt) });
    const e = await caught(runStellarPayout(base));
    expect(e).toBeInstanceOf(QuoteExpiredError);
    expect(e).toMatchObject({ code: 'quote_expired', quoteId: QUOTE_ID, stage: 'authorization' });
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it("uses core's one-minute expiry margin by default", async () => {
    const tooClose = setup([], { clock: () => Date.parse(quote.expiresAt) - 60_000 });
    await expect(runStellarPayout(tooClose.base)).rejects.toBeInstanceOf(QuoteExpiredError);
    expect(tooClose.calls).toHaveLength(0);
    const inTime = setup([AUTHORIZED, CREATED], { clock: () => Date.parse(quote.expiresAt) - 60_001 });
    await expect(runStellarPayout(inTime.base)).resolves.toMatchObject({ txHash: HASH });
  });

  it('payout honours a larger expiry margin before authorizing', async () => {
    const { calls, signStellar, base } = setup([AUTHORIZED]);
    await expect(runStellarPayout({ ...base, expiryMarginMs: 5 * 60_000 })).rejects.toMatchObject({ stage: 'authorization' });
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout whose quote expires during authorize is not signed', async () => {
    let reads = 0;
    const clock = () => (reads++ === 0 ? NOW : Date.parse(quote.expiresAt) + 1);
    const { calls, signStellar, onAuthorized, base } = setup([AUTHORIZED], { clock });
    await expect(runStellarPayout(base)).rejects.toMatchObject({ code: 'quote_expired', stage: 'authorization' });
    expect(calls).toHaveLength(1);
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout whose quote expires while signing is never submitted or created', async () => {
    let t = NOW;
    const { calls, signStellar, submit, base } = setup([AUTHORIZED], { clock: () => t });
    signStellar.mockImplementation(async () => {
      t = Date.parse(quote.expiresAt) + 1;
      return SIGNED;
    });
    await expect(runStellarPayout(base)).rejects.toMatchObject({ code: 'quote_expired', stage: 'signing' });
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('payout refuses to start outside payout_quoted, before any call', async () => {
    const { calls, signStellar, base } = setup([AUTHORIZED]);
    const funded = { ...context, state: 'funded' as unknown as 'payout_quoted' };
    await expect(runStellarPayout({ ...base, context: funded })).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout refuses to sign when onAuthorized did not store awaiting_signature', async () => {
    const { signStellar, onAuthorized, base } = setup([AUTHORIZED]);
    onAuthorized.mockResolvedValueOnce('payout_quoted' as unknown as 'awaiting_signature');
    await expect(runStellarPayout(base)).rejects.toBeInstanceOf(SigningNotAllowedError);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('payout fails closed when the clock reads %s, even on a quote that expired in 2001', async (_name, reading) => {
    const { calls, signStellar, base } = setup([AUTHORIZED, CREATED], { clock: () => reading });
    const old = { ...context, quote: { ...quote, expiresAt: '2001-01-01T00:00:00Z' } };
    const partnerSubmits = withSigning(base, { submission: 'partner_submits' });
    await expect(runStellarPayout({ ...partnerSubmits, context: old })).rejects.toThrow(InvalidInputError);
    expect(signStellar).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('payout refuses expiryMarginMs %p before any call', async (expiryMarginMs) => {
    const { calls, signStellar, base } = setup([AUTHORIZED, CREATED]);
    await expect(runStellarPayout({ ...base, expiryMarginMs })).rejects.toThrow(InvalidInputError);
    expect(signStellar).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  describe('a submit that is not a confirmed success never creates the payout', () => {
    const outcomes: [string, StellarSubmitter['submit']][] = [
      ['rejected', async () => ({ status: 'rejected', hash: HASH, detail: { transactionCode: 'tx_insufficient_balance' } })],
      ['unknown', async () => ({ status: 'unknown', hash: HASH })],
      ['expired_not_landed', async () => ({ status: 'expired_not_landed', hash: HASH })],
      ['failed', async () => ({ status: 'failed', hash: HASH })],
      ['a bare { hash } with no status', async () => ({ hash: HASH }) as unknown as SubmitOutcome],
      ['success with a malformed hash', async () => ({ status: 'success', hash: 'nope' })],
      ['a submitter that throws', async () => { throw new Error('horizon timeout'); }],
    ];

    it.each(outcomes)('%s', async (_name, submit) => {
      for (const field of ['signed_xdr', 'tx_hash'] as const) {
        const { paths, signStellar, base } = setup([AUTHORIZED, CREATED], { field });
        const e = (await caught(runStellarPayout(withSigning(base, { submitter: { submit } })))) as PayoutIncompleteError;
        expect(e).toBeInstanceOf(PayoutIncompleteError);
        expect(e).toMatchObject({ stage: 'submit', code: 'payout_not_recorded', signedXdr: SIGNED, pending: undefined });
        expect(e.message).toMatch(/check the transaction on Stellar/);
        expect(paths()).toEqual(['/payouts/stellar/authorize']);
        expect(signStellar).toHaveBeenCalledTimes(1);
      }
    });

    it('keeps the outcome and hash for the operator', async () => {
      const { base } = setup([AUTHORIZED]);
      const outcome: SubmitOutcome = { status: 'unknown', hash: HASH };
      const run = withSigning(base, { submitter: { submit: async () => outcome } });
      const e = (await caught(runStellarPayout(run))) as PayoutIncompleteError;
      expect(e).toMatchObject({ txHash: HASH, outcome });
    });
  });

  it.each<[SignedTransactionField, string]>([
    ['signed_xdr', SIGNED],
    ['tx_hash', HASH],
  ])('payout create failing after submit (%s) is retried with the same body and key', async (field, sent) => {
    const { calls, adapter, signStellar, submit, base } = setup(
      [
        AUTHORIZED,
        { status: 503, body: { message: 'unavailable' } },
        { status: 409, body: { code: 'idempotency_key_in_flight' }, headers: { 'Retry-After': '2' } },
        { ...CREATED, headers: { 'Idempotency-Replayed': 'true' } },
      ],
      { field },
    );
    const e = (await caught(runStellarPayout(base))) as PayoutIncompleteError<ExecutePayoutInput>;
    expect(e).toBeInstanceOf(PayoutIncompleteError);
    expect(e).toMatchObject({ stage: 'create', txHash: HASH, signedXdr: SIGNED });
    expect(e.pending).toEqual({
      body: { quote, account, transferId: context.transferId, idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH },
      idempotencyKey: KEY,
    });
    expect(e.cause).toMatchObject({ status: 503, retryable: true });

    const e2 = (await caught(retryStellarPayoutCreate(adapter, e.pending!))) as PayoutIncompleteError<ExecutePayoutInput>;
    expect(e2.cause).toMatchObject({ status: 409, retryable: true, retryAfterMs: 2000 });
    const ok = await retryStellarPayoutCreate(adapter, e2.pending!);
    expect(ok).toMatchObject({ txHash: HASH, leg: { id: 'po_000000000000' } });

    const creates = calls.slice(1);
    expect(creates).toHaveLength(3);
    for (const c of creates) {
      expect(c.headers['Idempotency-Key']).toBe(KEY);
      expect(c.body).toEqual({ quote_id: QUOTE_ID, signed_transaction: sent, sender_wallet_address: STELLAR_ADDRESS });
    }
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MockReply]>([
    ['lacking the XDR', { body: {} }],
    ['an HTTP error', { status: 400, body: { message: 'wallet bw_secret of Jane Doe is not approved' } }],
  ])('payout with an authorize response %s throws PayoutAuthorizationError before onAuthorized', async (_name, reply) => {
    const { paths, signStellar, onAuthorized, base } = setup([reply]);
    const e = (await caught(runStellarPayout(base))) as PayoutAuthorizationError;
    expect(e).toBeInstanceOf(PayoutAuthorizationError);
    expect(e).toMatchObject({ code: 'payout_authorization_failed', failure: 'threw', causeCode: 'partner_http' });
    expect(e.message).not.toMatch(/Jane|bw_secret/);
    expect(paths()).toEqual(['/payouts/stellar/authorize']);
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(signStellar).not.toHaveBeenCalled();
  });
});
