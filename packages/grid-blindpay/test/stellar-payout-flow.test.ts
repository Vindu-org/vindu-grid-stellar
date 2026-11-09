import {
  InvalidInputError,
  PayoutIncompleteError,
  QuoteExpiredError,
  type Signer,
  type SigningContext,
  SigningNotAllowedError,
  fiat,
  money,
} from '@vindu/grid-core';

import { createBlindPayClient } from '../src/client';
import {
  type PayoutSubmission,
  type RunStellarPayoutInput,
  type SignedTransactionField,
  StellarPayoutIncompleteError,
  retryStellarPayoutCreate,
  runStellarPayout,
} from '../src/stellar-payout-flow';
import { type MockReply, STELLAR_ADDRESS, WALLET_ID, caught, config, mockFetch } from './helpers';

const QUOTE_ID = 'qu_000000000000';
const UNSIGNED = 'AAAAUNSIGNEDXDR==';
const SIGNED = 'AAAASIGNEDXDR==';
const HASH = 'ab'.repeat(32);
const NOW = Date.parse('2030-01-01T00:00:00Z');
const KEY = 'payout-key-1';

const ctx: SigningContext = {
  transferId: 'tr_000000000000',
  state: 'awaiting_signature',
  quoteId: QUOTE_ID,
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  expected: { source: STELLAR_ADDRESS, destination: `G${'B'.repeat(55)}`, amount: money('100', fiat('USDC')) },
};

const AUTHORIZED: MockReply = { body: { transaction_hash: UNSIGNED } };
const CREATED: MockReply = { body: { id: 'po_000000000000', status: 'processing' } };

function setup(replies: MockReply[], clock: () => number = () => NOW) {
  const { fetch, calls } = mockFetch(replies);
  const client = createBlindPayClient(config(fetch));
  const signStellar = jest.fn(async () => SIGNED);
  const signer: Signer = { custody: 'test_key', signStellar };
  const submit = jest.fn(async () => ({ hash: HASH }));
  const base: RunStellarPayoutInput = {
    client, quoteId: QUOTE_ID, senderAddress: STELLAR_ADDRESS, walletId: WALLET_ID,
    signer, signingContext: ctx, submitter: { submit }, idempotencyKey: KEY, now: clock,
  };
  return { calls, client, signStellar, submit, base };
}

describe('stellar payout flow', () => {
  it.each<[PayoutSubmission, SignedTransactionField, string, number]>([
    ['client_submits', 'signed_xdr', SIGNED, 1],
    ['client_submits', 'tx_hash', HASH, 1],
    ['partner_submits', 'signed_xdr', SIGNED, 0],
  ])('payout with %s and %s sends the right signed_transaction', async (submission, field, sent, submits) => {
    const { calls, signStellar, submit, base } = setup([AUTHORIZED, CREATED]);
    const res = await runStellarPayout({ ...base, submission, signedTransactionField: field });

    expect(calls.map((c) => c.url.replace(/^.*\/in_000000000000/, ''))).toEqual(['/payouts/stellar/authorize', '/payouts/stellar']);
    expect(calls[0]?.body).toEqual({ quote_id: QUOTE_ID, sender_wallet_address: STELLAR_ADDRESS });
    expect(calls[1]?.body).toEqual({ quote_id: QUOTE_ID, signed_transaction: sent, sender_wallet_address: STELLAR_ADDRESS });
    expect(calls[1]?.headers['Idempotency-Key']).toBe(KEY);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(signStellar).toHaveBeenCalledWith({ chain: 'stellar', address: STELLAR_ADDRESS, partnerAccountId: WALLET_ID }, UNSIGNED, ctx);
    expect(submit).toHaveBeenCalledTimes(submits);
    if (submits === 1) expect(submit).toHaveBeenCalledWith(SIGNED);
    expect(res).toMatchObject({ payout: { id: 'po_000000000000' }, signedXdr: SIGNED, idempotencyKey: KEY });
    expect(res.txHash).toBe(submits === 1 ? HASH : undefined);
  });

  it('payout with partner_submits and tx_hash is refused before any call or signature', async () => {
    const { calls, signStellar, base } = setup([]);
    await expect(runStellarPayout({ ...base, submission: 'partner_submits', signedTransactionField: 'tx_hash' })).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout with client_submits and no submitter is refused up front', async () => {
    const { calls, signStellar, base } = setup([]);
    const noSubmitter: { -readonly [K in keyof RunStellarPayoutInput]?: RunStellarPayoutInput[K] } = { ...base };
    delete noSubmitter.submitter;
    await expect(runStellarPayout(noSubmitter as RunStellarPayoutInput)).rejects.toThrow(/submitter/);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout on an expired quote throws QuoteExpiredError and never authorizes or signs', async () => {
    const { calls, signStellar, base } = setup([], () => Date.parse(ctx.expiresAt));
    const e = await caught(runStellarPayout(base));
    expect(e).toBeInstanceOf(QuoteExpiredError);
    expect(e).toMatchObject({ code: 'quote_expired', quoteId: QUOTE_ID });
    expect((e as Error).message).toMatch(/fresh quote/);
    expect(calls).toHaveLength(0);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout whose quote expires during authorize is not signed', async () => {
    // First reading before authorize, every later one after expiry.
    let reads = 0;
    const clock = () => (reads++ === 0 ? NOW : Date.parse(ctx.expiresAt) + 1);
    const { calls, signStellar, base } = setup([AUTHORIZED], clock);
    await expect(runStellarPayout(base)).rejects.toBeInstanceOf(QuoteExpiredError);
    expect(calls).toHaveLength(1);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout honours the expiry margin before signing', async () => {
    const { signStellar, base } = setup([AUTHORIZED]);
    await expect(runStellarPayout({ ...base, expiryMarginMs: 5 * 60_000 })).rejects.toBeInstanceOf(QuoteExpiredError);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout whose quote expires while signing is never submitted or created', async () => {
    let t = NOW;
    const { calls, signStellar, submit, base } = setup([AUTHORIZED], () => t);
    signStellar.mockImplementation(async () => {
      t = Date.parse(ctx.expiresAt) + 1;
      return SIGNED;
    });
    await expect(runStellarPayout(base)).rejects.toBeInstanceOf(QuoteExpiredError);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('payout refuses to sign outside awaiting_signature', async () => {
    const { signStellar, base } = setup([AUTHORIZED]);
    await expect(runStellarPayout({ ...base, signingContext: { ...ctx, state: 'funded' } })).rejects.toBeInstanceOf(SigningNotAllowedError);
    expect(signStellar).not.toHaveBeenCalled();
  });

  it('payout refuses a signing context for another quote', async () => {
    const { calls, base } = setup([]);
    await expect(runStellarPayout({ ...base, signingContext: { ...ctx, quoteId: 'qu_other' } })).rejects.toThrow(/quoteId/);
    expect(calls).toHaveLength(0);
  });

  it('payout submit failure carries the signed XDR, never creates and never re-signs', async () => {
    const { calls, signStellar, submit, base } = setup([AUTHORIZED]);
    submit.mockRejectedValueOnce(new Error('horizon timeout'));
    const e = (await caught(runStellarPayout(base))) as StellarPayoutIncompleteError;
    expect(e).toBeInstanceOf(StellarPayoutIncompleteError);
    expect(e).toBeInstanceOf(PayoutIncompleteError);
    expect(e).toMatchObject({ stage: 'submit', code: 'payout_not_recorded', signedXdr: SIGNED, txHash: undefined });
    expect(e.message).toMatch(/check the transaction on Stellar/);
    expect(e.pending?.body.signed_transaction).toBe(SIGNED);
    expect(calls).toHaveLength(1);
    expect(signStellar).toHaveBeenCalledTimes(1);
  });

  it('payout submit returning a malformed hash is treated as an unknown outcome', async () => {
    const { calls, base } = setup([AUTHORIZED]);
    const e = await caught(runStellarPayout({ ...base, signedTransactionField: 'tx_hash', submitter: { submit: async () => ({ hash: 'nope' }) } }));
    expect(e).toMatchObject({ stage: 'submit', pending: undefined });
    expect(calls).toHaveLength(1);
  });

  it.each<[SignedTransactionField, string]>([
    ['signed_xdr', SIGNED],
    ['tx_hash', HASH],
  ])('payout create failing after submit (%s) carries hash and signed payload, and a retry reuses body and key', async (field, sent) => {
    const { calls, client, signStellar, submit, base } = setup([
      AUTHORIZED,
      { status: 503, body: { message: 'unavailable' } },
      { status: 409, body: { code: 'idempotency_key_in_flight' }, headers: { 'Retry-After': '2' } },
      { ...CREATED, headers: { 'Idempotency-Replayed': 'true' } },
    ]);
    const e = (await caught(runStellarPayout({ ...base, signedTransactionField: field }))) as StellarPayoutIncompleteError;
    expect(e).toMatchObject({ stage: 'create', txHash: HASH, signedXdr: SIGNED });
    expect(e.pending).toEqual({
      body: { quote_id: QUOTE_ID, signed_transaction: sent, sender_wallet_address: STELLAR_ADDRESS },
      idempotencyKey: KEY, signedXdr: SIGNED, txHash: HASH,
    });
    expect(e.cause).toMatchObject({ status: 503, retryable: true });

    const pending = e.pending!;
    const e2 = (await caught(retryStellarPayoutCreate(client, pending))) as StellarPayoutIncompleteError;
    expect(e2.cause).toMatchObject({ status: 409, retryable: true, retryAfterMs: 2000 });
    const ok = await retryStellarPayoutCreate(client, e2.pending!);
    expect(ok).toMatchObject({ replayed: true, txHash: HASH, payout: { id: 'po_000000000000' } });

    const creates = calls.slice(1);
    expect(creates).toHaveLength(3);
    for (const c of creates) {
      expect(c.headers['Idempotency-Key']).toBe(KEY);
      expect(c.body).toEqual(creates[0]?.body);
    }
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('payout with an authorize response lacking the XDR stops before signing', async () => {
    const { signStellar, base } = setup([{ body: {} }]);
    await expect(runStellarPayout(base)).rejects.toMatchObject({ partnerCode: 'unexpected_response' });
    expect(signStellar).not.toHaveBeenCalled();
  });
});
