import { createHmac, randomBytes } from 'node:crypto';

import { type AccountRef, InvalidConfigError, InvalidInputError, type LegQuote, fiat, money, stellarAsset } from '@vindu/grid-core';

import { DEV_SENTINEL_AMOUNTS } from '../src/amounts';
import { type BlindPayAdapterOptions, DEFAULT_MAX_QUOTE_TTL_MS, createBlindPayAdapter } from '../src/adapter';
import { BlindPayQuoteError } from '../src/errors';
import { toLegStatus } from '../src/legs';
import { WebhookVerificationError } from '../src/webhooks';
import { BANK_ACCOUNT_ID, CUSTOMER_ID, type Handler, STELLAR_ADDRESS, USDB_ISSUER, USDC_ISSUER, WALLET_ID, caught, config, mockFetch } from './helpers';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const usdb = stellarAsset('USDB', USDB_ISSUER);
const usdc = stellarAsset('USDC', USDC_ISSUER);
const ISSUERS = { USDB: USDB_ISSUER, USDC: USDC_ISSUER } as const;
const brl = fiat('BRL');
const usd = fiat('USD');
const account: AccountRef = { chain: 'stellar', address: STELLAR_ADDRESS, partnerAccountId: WALLET_ID };
const WEBHOOK_KEY = randomBytes(24);
const SECRET = `whsec_${WEBHOOK_KEY.toString('base64')}`;
const HASH = 'cd'.repeat(32);

/**
 * A small stand-in for a BlindPay development instance: the final status of a
 * payin or payout follows the documented sentinel request amounts.
 */
function devInstance(): { handler: Handler; amounts: Map<string, number> } {
  const amounts = new Map<string, number>();
  let n = 0;
  const outcome = (amount: number | undefined) =>
    amount === DEV_SENTINEL_AMOUNTS.failed ? 'failed' : amount === DEV_SENTINEL_AMOUNTS.refunded ? 'refunded' : 'completed';
  const handler: Handler = (call) => {
    const path = call.url.replace(/^.*\/v1\/instances\/in_000000000000/, '');
    const body = (call.body ?? {}) as Record<string, unknown>;
    const id = (p: string) => `${p}_${String(++n).padStart(12, '0')}`;
    if (path === '/payin-quotes' || path === '/quotes') {
      const q = id('qu');
      amounts.set(q, body['request_amount'] as number);
      // Fixed 5.00 rate for the test: BRL in, stablecoin out; stablecoin in, USD out at 1:1.
      const isPayin = path === '/payin-quotes';
      const amount = body['request_amount'] as number;
      return { body: { id: q, expires_at: NOW + 300_000, sender_amount: amount, receiver_amount: isPayin ? amount / 5 : amount } };
    }
    if (path === '/payins/evm') {
      const pi = id('pi');
      amounts.set(pi, amounts.get(body['payin_quote_id'] as string) ?? 0);
      return { body: { id: pi, status: 'processing', pix_code: '<development>', sender_amount: amounts.get(pi) } };
    }
    if (path === '/payouts/stellar/authorize') return { body: { transaction_hash: 'AAAAUNSIGNED' } };
    if (path === '/payouts/stellar') {
      const po = id('po');
      amounts.set(po, amounts.get(body['quote_id'] as string) ?? 0);
      return { body: { id: po, status: 'processing' } };
    }
    const read = /^\/(payins|payouts)\/((pi|po)_\d+)$/.exec(path);
    if (read?.[2] !== undefined) {
      const status = outcome(amounts.get(read[2]));
      return { body: { id: read[2], status, tracking_transaction: { step: 'completed', transaction_hash: HASH } } };
    }
    return { status: 404, body: { code: 'not_found' } };
  };
  return { handler, amounts };
}

function setup(extra: Partial<BlindPayAdapterOptions> = {}) {
  const dev = devInstance();
  const { fetch, calls } = mockFetch(dev.handler);
  const adapter = createBlindPayAdapter(config(fetch, { now: () => NOW }), {
    network: 'stellar_testnet', webhookSecret: SECRET, assetIssuers: ISSUERS, ...extra,
  });
  return { adapter, calls };
}

async function fundAndPayOut(adapter: ReturnType<typeof setup>['adapter'], brlAmount: string, usdbAmount: string) {
  const fq = await adapter.quoteFunding({ customerId: CUSTOMER_ID, account, source: money(brlAmount, brl), targetAsset: usdb, rail: 'pix' });
  const funding = await adapter.createFunding({ quote: fq, customerId: CUSTOMER_ID, account, transferId: 'tr_1', idempotencyKey: 'fund-1' });
  const pq: LegQuote = await adapter.quotePayout({
    customerId: CUSTOMER_ID, account, source: money(usdbAmount, usdb), targetAsset: usd, rail: 'wire', beneficiaryId: BANK_ACCOUNT_ID,
  });
  const auth = await adapter.preparePayout({ quote: pq, account, transferId: 'tr_1' });
  const payout = await adapter.executePayout({ quote: pq, account, transferId: 'tr_1', idempotencyKey: 'pay-1', signedXdr: 'AAAASIGNED' });
  return { fq, funding, pq, auth, payout };
}

describe('adapter', () => {
  it('runs both legs and maps quotes, PIX instructions and refs to core types', async () => {
    const { adapter, calls } = setup();
    const { fq, funding, pq, auth, payout } = await fundAndPayOut(adapter, '500', '100');

    expect(adapter.id).toBe('blindpay');
    expect(fq).toEqual({
      id: 'qu_000000000001', partner: 'blindpay', kind: 'funding', expiresAt: '2030-01-01T00:05:00.000Z',
      source: money('500', brl), target: money('100', usdb), fees: [],
    });
    expect(funding).toEqual({ leg: { partner: 'blindpay', kind: 'funding', id: 'pi_000000000002' }, rail: 'pix', amount: money('500', brl), pixCode: '<development>' });
    expect(pq).toMatchObject({ kind: 'payout', source: money('100', usdb), target: money('100', usd) });
    expect(auth).toEqual({ kind: 'stellar_xdr', unsignedXdr: 'AAAAUNSIGNED' });
    expect(payout).toEqual({ partner: 'blindpay', kind: 'payout', id: 'po_000000000004' });

    const bodies = calls.map((c) => c.body);
    expect(bodies[0]).toEqual({
      blockchain_wallet_id: WALLET_ID, currency_type: 'sender', cover_fees: false, request_amount: 50_000, payment_method: 'pix', token: 'USDB',
    });
    expect(calls[1]?.headers['Idempotency-Key']).toBe('fund-1');
    expect(bodies[2]).toEqual({
      bank_account_id: BANK_ACCOUNT_ID, currency_type: 'sender', cover_fees: false, request_amount: 10_000, network: 'stellar_testnet', token: 'USDB',
    });
    expect(bodies[4]).toEqual({ quote_id: pq.id, signed_transaction: 'AAAASIGNED', sender_wallet_address: STELLAR_ADDRESS });
    expect(calls[4]?.headers['Idempotency-Key']).toBe('pay-1');
  });

  it.each([
    ['500', '100', 'completed', 'completed'],
    ['666', '666', 'failed', 'failed'],
    ['777', '777', 'refunded', 'refunded'],
  ])('maps dev sentinel outcomes: funding %s BRL, payout %s USDB -> %s / %s', async (brlAmount, usdbAmount, fundingStatus, payoutStatus) => {
    const { adapter } = setup();
    const { funding, payout } = await fundAndPayOut(adapter, brlAmount, usdbAmount);
    expect(await adapter.readLeg(funding.leg)).toEqual({ ref: funding.leg, status: fundingStatus, txHash: HASH });
    expect(await adapter.readLeg(payout)).toEqual({ ref: payout, status: payoutStatus, txHash: HASH });
  });

  it('reads a payout through the isolated UNCONFIRMED path', async () => {
    const { adapter, calls } = setup();
    await adapter.readLeg({ partner: 'blindpay', kind: 'payout', id: 'po_000000000009' });
    expect(calls[0]?.url).toMatch(/\/payouts\/po_000000000009$/);
  });

  it.each([
    ['processing', 'processing'],
    ['on_hold', 'on_hold'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['refunded', 'refunded'],
    ['pending_review', 'unknown'],
    [undefined, 'unknown'],
  ])('maps status %p to %p', (status, leg) => {
    expect(toLegStatus(status)).toBe(leg);
  });

  it('sends payer rules and the partner fee for a spread, and refuses a spread without one', async () => {
    const { adapter, calls } = setup({ partnerFeeIdFor: (leg, bps) => (leg === 'funding' && bps === 50 ? 'pf_000000000000' : undefined) });
    const input = { customerId: CUSTOMER_ID, account, source: money('100', brl), targetAsset: usdb, rail: 'pix' } as const;
    await adapter.quoteFunding({ ...input, spreadBps: 50, allowedPayerTaxIds: ['00000000000'] });
    expect(calls[0]?.body).toMatchObject({ partner_fee_id: 'pf_000000000000', payer_rules: { pix_allowed_tax_ids: ['00000000000'] } });
    await expect(adapter.quoteFunding({ ...input, spreadBps: 75 })).rejects.toThrow(/partner fee/);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses spreadBps %p before calling BlindPay', async (spreadBps) => {
    const { adapter, calls } = setup({ partnerFeeIdFor: () => 'pf_000000000000' });
    const input = { customerId: CUSTOMER_ID, account, source: money('100', brl), targetAsset: usdb, rail: 'pix', spreadBps } as const;
    await expect(adapter.quoteFunding(input)).rejects.toThrow(/spreadBps/);
    expect(calls).toHaveLength(0);
  });

  it('refuses unsupported inputs before calling BlindPay', async () => {
    const { adapter, calls } = setup();
    const base = { customerId: CUSTOMER_ID, account, source: money('100', brl), targetAsset: usdb, rail: 'pix' } as const;
    await expect(adapter.quoteFunding({ ...base, rail: 'ted' })).rejects.toThrow(InvalidInputError);
    await expect(adapter.quoteFunding({ ...base, source: money('100.001', brl) })).rejects.toThrow(/sub-cent/);
    await expect(adapter.quoteFunding({ ...base, targetAsset: fiat('EURC') })).rejects.toThrow(/USDC or USDB/);
    await expect(adapter.quoteFunding({ ...base, targetAsset: fiat('USDB') })).rejects.toThrow(/issuer/);
    await expect(adapter.quoteFunding({ ...base, targetAsset: stellarAsset('USDC', STELLAR_ADDRESS) })).rejects.toThrow(/issuer/);
    await expect(adapter.quoteFunding({ ...base, account: { chain: 'stellar', address: STELLAR_ADDRESS } })).rejects.toThrow(/bw_/);
    const payout = { customerId: CUSTOMER_ID, account, source: money('100', usdb), targetAsset: usd, beneficiaryId: BANK_ACCOUNT_ID } as const;
    await expect(adapter.quotePayout({ ...payout, rail: 'sepa' })).rejects.toThrow(/not supported/);
    expect(calls).toHaveLength(0);
  });

  it('executePayout sends the hash when configured for tx_hash', async () => {
    const { adapter, calls } = setup({ signedTransactionField: 'tx_hash' });
    const quote = { id: 'qu_000000000000' } as LegQuote;
    await expect(adapter.executePayout({ quote, account, transferId: 't', idempotencyKey: 'k', signedXdr: 'X' })).rejects.toThrow(/txHash/);
    await adapter.executePayout({ quote, account, transferId: 't', idempotencyKey: 'k', txHash: HASH });
    expect(calls[0]?.body).toMatchObject({ signed_transaction: HASH });
  });
});

describe('adapter payout corridor', () => {
  it.each([
    ['USD', 'wire', true],
    ['USD', 'ach', true],
    ['EUR', 'sepa', true],
    ['MXN', 'spei', true],
    ['USD', 'sepa', false],
    ['BRL', 'pix', false],
    ['constructor', 'wire', false],
  ])('takes the corridor from the input: %s by %s supported %p', async (currency, rail, ok) => {
    const { adapter, calls } = setup();
    const input = { customerId: CUSTOMER_ID, account, source: money('100', usdb), targetAsset: fiat(currency), rail, beneficiaryId: BANK_ACCOUNT_ID };
    const res = adapter.quotePayout(input);
    if (ok) await expect(res).resolves.toMatchObject({ target: { asset: { code: currency } } });
    else await expect(res).rejects.toThrow(/not supported/);
    expect(calls).toHaveLength(ok ? 1 : 0);
  });
});

describe('adapter payout of a funded balance', () => {
  it('floors a sub-cent funded amount to cents and quotes what will move', async () => {
    const { adapter, calls } = setup();
    const quote = await adapter.quotePayout({
      customerId: CUSTOMER_ID, account, source: money('99.9876543', usdb), targetAsset: usd, rail: 'wire', beneficiaryId: BANK_ACCOUNT_ID,
    });
    expect(calls[0]?.body).toMatchObject({ request_amount: 9_998 });
    expect(quote.source).toEqual(money('99.98', usdb));
  });

  it('still refuses a sub-cent funding amount instead of rounding it', async () => {
    const { adapter } = setup();
    await expect(
      adapter.quoteFunding({ customerId: CUSTOMER_ID, account, source: money('10.005', brl), targetAsset: usdb, rail: 'pix' }),
    ).rejects.toThrow(/sub-cent/);
  });
});

describe('adapter quote answers', () => {
  const payoutInput = {
    customerId: CUSTOMER_ID, account, source: money('100', usdb), targetAsset: usd, rail: 'wire', beneficiaryId: BANK_ACCOUNT_ID,
  } as const;
  const fundingInput = { customerId: CUSTOMER_ID, account, source: money('100', brl), targetAsset: usdb, rail: 'pix' } as const;
  const answering = (body: Record<string, unknown>) => {
    const { fetch } = mockFetch([{ body: { id: 'qu_000000000009', expires_at: NOW + 300_000, ...body } }]);
    return createBlindPayAdapter(config(fetch, { now: () => NOW }), { network: 'stellar_testnet', assetIssuers: ISSUERS });
  };

  // Review probe: BlindPay answering a 100.00 sender quote with sender_amount 20000
  // (or -5) gave a quote, and the signer then expected that amount.
  it.each<[string, Record<string, unknown>, string]>([
    ['a sender_amount above the request', { sender_amount: 20_000, receiver_amount: 19_900 }, 'sender_amount'],
    ['a sender_amount below the request', { sender_amount: 9_999, receiver_amount: 9_900 }, 'sender_amount'],
    ['a negative sender_amount', { sender_amount: -5, receiver_amount: 9_900 }, 'sender_amount'],
    ['a zero sender_amount', { sender_amount: 0, receiver_amount: 9_900 }, 'sender_amount'],
    ['a fractional sender_amount', { sender_amount: 10_000.5, receiver_amount: 9_900 }, 'sender_amount'],
    ['a sender_amount as a string', { sender_amount: '10000', receiver_amount: 9_900 }, 'sender_amount'],
    ['a zero receiver_amount', { sender_amount: 10_000, receiver_amount: 0 }, 'receiver_amount'],
    ['a negative receiver_amount', { sender_amount: 10_000, receiver_amount: -1 }, 'receiver_amount'],
    ['an expires_at in epoch seconds', { sender_amount: 10_000, receiver_amount: 9_900, expires_at: 1_893_456_300 }, 'expires_at'],
    ['an expires_at as a string', { sender_amount: 10_000, receiver_amount: 9_900, expires_at: '2030-01-01T00:05:00Z' }, 'expires_at'],
  ])('refuses a payout quote with %s', async (_name, body, field) => {
    const e = await caught(answering(body).quotePayout(payoutInput));
    expect(e).toBeInstanceOf(BlindPayQuoteError);
    expect(e).toMatchObject({ code: 'unexpected_partner_quote', field });
  });

  it('accepts a payout quote for exactly the requested amount', async () => {
    const quote = await answering({ sender_amount: 10_000, receiver_amount: 9_900 }).quotePayout(payoutInput);
    expect(quote).toMatchObject({ source: money('100', usdb), target: money('99', usd), expiresAt: new Date(NOW + 300_000).toISOString() });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a negative receiver_amount', { sender_amount: 10_000, receiver_amount: -2_000 }, 'receiver_amount'],
    ['a fractional sender_amount', { sender_amount: 10_000.1, receiver_amount: 2_000 }, 'sender_amount'],
    ['an expires_at in epoch seconds', { sender_amount: 10_000, receiver_amount: 2_000, expires_at: 1_893_456_300 }, 'expires_at'],
  ])('refuses a funding quote with %s', async (_name, body, field) => {
    await expect(answering(body).quoteFunding(fundingInput)).rejects.toMatchObject({ code: 'unexpected_partner_quote', field });
  });

  // Review probe: a quote without an id was accepted, an expires_at far in the
  // future set no bound, and 9e15 escaped as a raw RangeError.
  const ok = { sender_amount: 10_000, receiver_amount: 9_900 };
  it.each<[string, Record<string, unknown>, string]>([
    ['no id', { ...ok, id: undefined }, 'id'],
    ['an empty id', { ...ok, id: '' }, 'id'],
    ['a numeric id', { ...ok, id: 42 }, 'id'],
    ['an expires_at of 9e15', { ...ok, expires_at: 9e15 }, 'expires_at'],
    ['an expires_at in microseconds', { ...ok, expires_at: NOW * 1000 }, 'expires_at'],
    ['an expires_at in 2200', { ...ok, expires_at: Date.parse('2200-01-01T00:00:00Z') }, 'expires_at'],
    ['an expires_at one ms past an hour', { ...ok, expires_at: NOW + 3_600_001 }, 'expires_at'],
    ['an expires_at now', { ...ok, expires_at: NOW }, 'expires_at'],
    ['an expires_at in the past', { ...ok, expires_at: NOW - 1_000 }, 'expires_at'],
    ['an expires_at of Infinity', { ...ok, expires_at: Number.POSITIVE_INFINITY }, 'expires_at'],
    ['an expires_at of NaN', { ...ok, expires_at: Number.NaN }, 'expires_at'],
    ['a sender_amount above the safe range', { ...ok, sender_amount: 9e15 * 10 }, 'sender_amount'],
  ])('refuses a quote with %s, as BlindPayQuoteError', async (_name, body, field) => {
    for (const quote of [(a: ReturnType<typeof answering>) => a.quotePayout(payoutInput), (a: ReturnType<typeof answering>) => a.quoteFunding(fundingInput)]) {
      const e = await caught(quote(answering(body)));
      expect(e).toBeInstanceOf(BlindPayQuoteError);
      expect(e).toMatchObject({ code: 'unexpected_partner_quote', field });
    }
  });

  it('refuses an answer that is not an object, as BlindPayQuoteError', async () => {
    const { fetch } = mockFetch([{ body: 'qu_1' }]);
    const adapter = createBlindPayAdapter(config(fetch, { now: () => NOW }), { network: 'stellar_testnet', assetIssuers: ISSUERS });
    await expect(adapter.quotePayout(payoutInput)).rejects.toMatchObject({ code: 'unexpected_partner_quote', field: 'id' });
  });

  it('accepts an expires_at of exactly one hour, the default window', async () => {
    const quote = await answering({ ...ok, expires_at: NOW + DEFAULT_MAX_QUOTE_TTL_MS }).quotePayout(payoutInput);
    expect(DEFAULT_MAX_QUOTE_TTL_MS).toBe(3_600_000);
    expect(quote.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it('takes maxQuoteTtlMs and its own now as options', async () => {
    const at = NOW + 1_000_000;
    const build = (body: Record<string, unknown>) =>
      createBlindPayAdapter(config(mockFetch([{ body: { id: 'qu_000000000009', ...ok, ...body } }]).fetch), {
        network: 'stellar_testnet',
        assetIssuers: ISSUERS,
        maxQuoteTtlMs: 60_000,
        now: () => at,
      });
    await expect(build({ expires_at: at + 60_000 }).quotePayout(payoutInput)).resolves.toMatchObject({ id: 'qu_000000000009' });
    await expect(build({ expires_at: at + 60_001 }).quotePayout(payoutInput)).rejects.toMatchObject({ field: 'expires_at' });
    // NOW + 300 s is in the past for this adapter's clock.
    await expect(build({ expires_at: NOW + 300_000 }).quotePayout(payoutInput)).rejects.toMatchObject({ field: 'expires_at' });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000'])('refuses a maxQuoteTtlMs of %p when built', (maxQuoteTtlMs) => {
    expect(() =>
      createBlindPayAdapter(config(mockFetch([]).fetch), {
        network: 'stellar_testnet',
        maxQuoteTtlMs: maxQuoteTtlMs as number,
      }),
    ).toThrow(InvalidConfigError);
  });

  it('refuses to read a quote with a clock that is not finite', async () => {
    const adapter = createBlindPayAdapter(config(mockFetch([{ body: { id: 'qu_1', expires_at: NOW + 1, ...ok } }]).fetch), {
      network: 'stellar_testnet',
      assetIssuers: ISSUERS,
      now: () => Number.NaN,
    });
    await expect(adapter.quotePayout(payoutInput)).rejects.toThrow(InvalidInputError);
  });
});

describe('adapter stablecoins', () => {
  const fundingInput = { customerId: CUSTOMER_ID, account, source: money('100', brl), rail: 'pix' } as const;
  const payoutInput = { customerId: CUSTOMER_ID, account, targetAsset: usd, rail: 'wire', beneficiaryId: BANK_ACCOUNT_ID } as const;

  it('quotes USDC by code and issuer on both networks', async () => {
    for (const network of ['stellar', 'stellar_testnet'] as const) {
      const { adapter, calls } = setup({ network, assetIssuers: network === 'stellar' ? { USDC: USDC_ISSUER } : ISSUERS });
      await adapter.quoteFunding({ ...fundingInput, targetAsset: usdc });
      await adapter.quotePayout({ ...payoutInput, source: money('100', usdc) });
      expect(calls.map((c) => (c.body as { token: string }).token)).toEqual(['USDC', 'USDC']);
    }
  });

  it('refuses USDB on mainnet, in the options and in a quote', async () => {
    expect(() => setup({ network: 'stellar', assetIssuers: ISSUERS })).toThrow(InvalidConfigError);
    const { adapter, calls } = setup({ network: 'stellar', assetIssuers: { USDC: USDC_ISSUER } });
    await expect(adapter.quoteFunding({ ...fundingInput, targetAsset: usdb })).rejects.toThrow(/not supported on stellar/);
    await expect(adapter.quotePayout({ ...payoutInput, source: money('100', usdb) })).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
  });

  it('refuses USDC without the expected issuer, and a token whose issuer is not configured', async () => {
    const { adapter, calls } = setup({ assetIssuers: { USDB: USDB_ISSUER } });
    await expect(adapter.quoteFunding({ ...fundingInput, targetAsset: usdc })).rejects.toThrow(InvalidConfigError);
    const configured = setup().adapter;
    await expect(configured.quoteFunding({ ...fundingInput, targetAsset: fiat('USDC') })).rejects.toThrow(InvalidInputError);
    await expect(configured.quotePayout({ ...payoutInput, source: money('100', stellarAsset('USDC', USDB_ISSUER)) })).rejects.toThrow(/issuer/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an issuer that is not a Stellar account id', () => {
    expect(() => setup({ assetIssuers: { USDC: 'not-an-issuer' } })).toThrow(InvalidConfigError);
  });
});

describe('adapter leg amounts and times', () => {
  function reading(resource: Record<string, unknown>, extra: Partial<BlindPayAdapterOptions> = {}) {
    const { fetch } = mockFetch(() => ({ body: resource }));
    return createBlindPayAdapter(config(fetch, { now: () => NOW }), {
      network: 'stellar_testnet', webhookSecret: SECRET, assetIssuers: ISSUERS, ...extra,
    });
  }
  const payin = { id: 'pi_000000000001', status: 'completed', token: 'USDB', sender_amount: 50_000, receiver_amount: 9_512 };
  const payout = { id: 'po_000000000001', status: 'processing', token: 'USDB', sender_amount: 10_001, receiver_amount: 51_234 };

  it('reports the stablecoin received on a funding leg and taken on a payout leg, exactly', async () => {
    expect((await reading(payin).readLeg({ partner: 'blindpay', kind: 'funding', id: payin.id })).amount).toEqual(money('95.12', usdb));
    expect((await reading(payout).readLeg({ partner: 'blindpay', kind: 'payout', id: payout.id })).amount).toEqual(money('100.01', usdb));
  });

  it('takes USDC on mainnet when BlindPay sends no token, with the configured issuer', async () => {
    const adapter = reading({ ...payin, token: undefined }, { network: 'stellar', assetIssuers: { USDC: USDC_ISSUER } });
    expect((await adapter.readLeg({ partner: 'blindpay', kind: 'funding', id: payin.id })).amount).toEqual(money('95.12', usdc));
  });

  it.each<[string, Record<string, unknown>, Partial<BlindPayAdapterOptions>]>([
    ['no token on testnet', { token: undefined }, {}],
    ['an unknown token', { token: 'EURC' }, {}],
    ['USDB on mainnet', {}, { network: 'stellar', assetIssuers: { USDC: USDC_ISSUER } }],
    ['no issuer configured for the token', {}, { assetIssuers: { USDC: USDC_ISSUER } }],
    ['a fractional amount', { receiver_amount: 95.5 }, {}],
    ['a missing amount', { receiver_amount: undefined }, {}],
    ['an amount as a string', { receiver_amount: '9512' }, {}],
  ])('leaves the amount out for %s', async (_name, change, extra) => {
    const leg = await reading({ ...payin, ...change }, extra).readLeg({ partner: 'blindpay', kind: 'funding', id: payin.id });
    expect(leg.amount).toBeUndefined();
    expect(leg.status).toBe('completed');
  });

  it('takes the change time from the resource, never from the clock', async () => {
    const read = (r: Record<string, unknown>) => reading(r).readLeg({ partner: 'blindpay', kind: 'funding', id: payin.id });
    expect((await read({ ...payin, updated_at: '2029-12-31T23:59:01.5+00:00' })).updatedAt).toBe('2029-12-31T23:59:01.500Z');
    expect((await read({ ...payin, tracking_complete: { step: 'completed', completed_at: '2029-12-31T23:58:00Z' } })).updatedAt).toBe('2029-12-31T23:58:00.000Z');
    expect((await read({ ...payin, status: 'failed', tracking_complete: { completed_at: '2029-12-31T23:58:00Z' } })).updatedAt).toBeUndefined();
    expect((await read({ ...payin, updated_at: 'yesterday' })).updatedAt).toBeUndefined();
    expect((await read(payin)).updatedAt).toBeUndefined();
  });

  it('puts amount and resource time on webhook events, and the Svix time in deliveredAt only', async () => {
    const ts = String(NOW / 1000 - 10);
    const sign = (body: string) => ({
      'svix-id': 'msg_9', 'svix-timestamp': ts,
      'svix-signature': `v1,${createHmac('sha256', WEBHOOK_KEY).update(`msg_9.${ts}.${body}`).digest('base64')}`,
    });
    const adapter = reading({});
    const withTime = JSON.stringify({ webhook_event: 'payout.update', ...payout, updated_at: '2029-12-31T23:50:00Z' });
    await expect(adapter.parseWebhook(withTime, sign(withTime))).resolves.toEqual({
      eventId: 'msg_9', ref: { partner: 'blindpay', kind: 'payout', id: payout.id }, status: 'processing',
      amount: money('100.01', usdb), occurredAt: '2029-12-31T23:50:00.000Z', deliveredAt: '2029-12-31T23:59:50.000Z',
    });
    const noTime = JSON.stringify({ webhook_event: 'payin.complete', ...payin, token: 'USDT' });
    const event = await adapter.parseWebhook(noTime, sign(noTime));
    expect(event).toEqual({
      eventId: 'msg_9', ref: { partner: 'blindpay', kind: 'funding', id: payin.id }, status: 'completed', deliveredAt: '2029-12-31T23:59:50.000Z',
    });
  });
});

describe('adapter partner id', () => {
  it('uses partnerId in quotes, refs, events, errors and onCall reports', async () => {
    const dev = devInstance();
    const reports: unknown[] = [];
    const { fetch } = mockFetch(dev.handler);
    const adapter = createBlindPayAdapter(config(fetch, { now: () => NOW, onCall: (c) => reports.push(c) }), {
      network: 'stellar_testnet', webhookSecret: SECRET, assetIssuers: ISSUERS, partnerId: 'blindpay-br',
    });
    expect(adapter.id).toBe('blindpay-br');
    const { fq, funding, pq, payout } = await fundAndPayOut(adapter, '500', '100');
    expect([fq.partner, pq.partner, funding.leg.partner, payout.partner]).toEqual(Array(4).fill('blindpay-br'));
    expect((await adapter.readLeg(payout)).ref.partner).toBe('blindpay-br');
    await expect(adapter.readLeg({ ...payout, partner: 'blindpay' })).rejects.toThrow(InvalidInputError);
    expect(reports.every((r) => (r as { partner: string }).partner === 'blindpay-br')).toBe(true);
    await expect(adapter.readLeg({ partner: 'blindpay-br', kind: 'payout', id: 'po_missing' })).rejects.toMatchObject({ partner: 'blindpay-br' });

    const body = '{"webhook_event":"payout.update","id":"po_000000000001","status":"failed"}';
    const ts = String(NOW / 1000);
    const headers = {
      'svix-id': 'msg_1', 'svix-timestamp': ts,
      'svix-signature': `v1,${createHmac('sha256', WEBHOOK_KEY).update(`msg_1.${ts}.${body}`).digest('base64')}`,
    };
    expect((await adapter.parseWebhook(body, headers))?.ref.partner).toBe('blindpay-br');
  });

  it('defaults to blindpay, and refuses a malformed id or a client built for another id', () => {
    const { fetch } = mockFetch([]);
    expect(createBlindPayAdapter(config(fetch), { network: 'stellar' }).id).toBe('blindpay');
    expect(() => createBlindPayAdapter(config(fetch), { network: 'stellar', partnerId: '' })).toThrow(InvalidConfigError);
    expect(() => createBlindPayAdapter(config(fetch), { network: 'stellar', partnerId: 'a b' })).toThrow(InvalidConfigError);
    const client = createBlindPayAdapter(config(fetch), { network: 'stellar' }).client;
    expect(() => createBlindPayAdapter(config(fetch), { network: 'stellar', partnerId: 'other', client })).toThrow(/partnerId/);
  });
});

describe('adapter webhook', () => {
  const sign = (body: string, ts: string, id = 'msg_000000000001') => ({
    'svix-id': id, 'svix-timestamp': ts,
    'svix-signature': `v1,${createHmac('sha256', WEBHOOK_KEY).update(`${id}.${ts}.${body}`).digest('base64')}`,
  });
  const ts = String(NOW / 1000);

  it.each([
    ['payin.complete', 'pi_000000000001', 'refunded', 'funding'],
    ['payout.update', 'po_000000000001', 'failed', 'payout'],
    ['payout.complete', 'po_000000000001', 'completed', 'payout'],
  ])('turns %s for %s with status %s into a LegEvent keyed by svix-id', async (event, id, status, kind) => {
    const { adapter } = setup();
    const body = JSON.stringify({ webhook_event: event, id, status, tracking_transaction: { transaction_hash: HASH } });
    // The Svix timestamp is the delivery time; BlindPay sends no change time of its own.
    await expect(adapter.parseWebhook(body, sign(body, ts))).resolves.toEqual({
      eventId: 'msg_000000000001', ref: { partner: 'blindpay', kind, id }, status, deliveredAt: '2030-01-01T00:00:00.000Z', txHash: HASH,
    });
  });

  // Review probe: a webhook with transaction_hash "<script>" passed it on as txHash.
  it.each(['<script>', 'ab'.repeat(31), `${'ab'.repeat(32)}00`, 'zz'.repeat(32), '', 42])(
    'leaves txHash unset for a transaction_hash of %p',
    async (hash) => {
      const { adapter } = setup();
      const body = JSON.stringify({
        webhook_event: 'payout.update', id: 'po_000000000001', status: 'processing', tracking_transaction: { transaction_hash: hash },
      });
      const event = await adapter.parseWebhook(body, sign(body, ts));
      expect(event).not.toBeNull();
      expect(event).not.toHaveProperty('txHash');
    },
  );

  it.each([
    ['an upper-case status', '{"webhook_event":"payout.complete","id":"po_000000000001","status":"COMPLETED"}', { status: 'unknown' }],
    ['an event name in another case', '{"webhook_event":"Payout.Complete","id":"po_000000000001","status":"completed"}', null],
    ['a duplicated status key (the signed bytes decide; JSON keeps the last)', '{"webhook_event":"payout.complete","id":"po_000000000001","status":"failed","status":"completed"}', { status: 'completed' }],
  ])('reads %s conservatively', async (_name, body, expected) => {
    const { adapter } = setup();
    const event = await adapter.parseWebhook(body, sign(body, ts));
    if (expected === null) expect(event).toBeNull();
    else expect(event).toMatchObject(expected);
  });

  it('rejects a numeric resource id and a header given as an array', async () => {
    const { adapter } = setup();
    const numeric = '{"webhook_event":"payin.new","id":5,"status":"processing"}';
    await expect(adapter.parseWebhook(numeric, sign(numeric, ts))).rejects.toMatchObject({ reason: 'malformed_body' });
    const body = '{"webhook_event":"payout.update","id":"po_000000000001","status":"failed"}';
    const headers = { ...sign(body, ts), 'svix-id': ['msg_000000000001', 'x'] } as unknown as Record<string, string>;
    await expect(adapter.parseWebhook(body, headers)).rejects.toMatchObject({ reason: 'missing_headers' });
  });

  it('returns null for events that are not legs', async () => {
    const { adapter } = setup();
    const body = '{"webhook_event":"customer.update","id":"re_000000000000","kyc_status":"approved"}';
    await expect(adapter.parseWebhook(body, sign(body, ts))).resolves.toBeNull();
  });

  it('rejects a bad signature or a stale delivery, and without a secret', async () => {
    const { adapter } = setup();
    const body = '{"webhook_event":"payout.update","id":"po_000000000001","status":"failed"}';
    await expect(adapter.parseWebhook(body.replace('failed', 'completed'), sign(body, ts))).rejects.toThrow(WebhookVerificationError);
    await expect(adapter.parseWebhook(body, sign(body, String(NOW / 1000 - 301)))).rejects.toThrow(/too old/);
    const bare = createBlindPayAdapter(config(mockFetch([]).fetch), { network: 'stellar' });
    await expect(bare.parseWebhook(body, sign(body, ts))).rejects.toThrow(InvalidConfigError);
  });

  it.each(['', 'whsec_', 'not-a-secret', `whsec_${Buffer.from([1, 2, 3]).toString('base64')}`])(
    'refuses webhookSecret %p when built',
    (webhookSecret) => {
      expect(() => setup({ webhookSecret })).toThrow(InvalidConfigError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])('refuses webhookToleranceSec %p when built', (webhookToleranceSec) => {
    expect(() => setup({ webhookToleranceSec })).toThrow(InvalidConfigError);
  });

  it('fails closed when the clock reads NaN', async () => {
    const adapter = createBlindPayAdapter(config(mockFetch([]).fetch, { now: () => Number.NaN }), { network: 'stellar_testnet', webhookSecret: SECRET });
    const body = '{"webhook_event":"payout.update","id":"po_000000000001","status":"failed"}';
    await expect(adapter.parseWebhook(body, sign(body, '1000000000'))).rejects.toThrow(InvalidInputError);
  });
});
