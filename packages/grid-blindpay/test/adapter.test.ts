import { createHmac, randomBytes } from 'node:crypto';

import { type AccountRef, InvalidConfigError, InvalidInputError, type LegQuote, fiat, money } from '@vindu/grid-core';

import { DEV_SENTINEL_AMOUNTS } from '../src/amounts';
import { type BlindPayAdapterOptions, createBlindPayAdapter, toLegStatus } from '../src/adapter';
import { WebhookVerificationError } from '../src/webhooks';
import { BANK_ACCOUNT_ID, CUSTOMER_ID, type Handler, STELLAR_ADDRESS, WALLET_ID, config, mockFetch } from './helpers';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const usdb = fiat('USDB');
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
    network: 'stellar_testnet', webhookSecret: SECRET, ...extra,
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

  it('refuses unsupported inputs before calling BlindPay', async () => {
    const { adapter, calls } = setup();
    const base = { customerId: CUSTOMER_ID, account, source: money('100', brl), targetAsset: usdb, rail: 'pix' } as const;
    await expect(adapter.quoteFunding({ ...base, rail: 'ted' })).rejects.toThrow(InvalidInputError);
    await expect(adapter.quoteFunding({ ...base, source: money('100.001', brl) })).rejects.toThrow(/sub-cent/);
    await expect(adapter.quoteFunding({ ...base, targetAsset: fiat('EURC') })).rejects.toThrow(/USDC or USDB/);
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
  ])('turns %s for %s with status %s into a LegEvent keyed by svix-id', (event, id, status, kind) => {
    const { adapter } = setup();
    const body = JSON.stringify({ webhook_event: event, id, status, tracking_transaction: { transaction_hash: HASH } });
    expect(adapter.parseWebhook(body, sign(body, ts))).toEqual({
      eventId: 'msg_000000000001', ref: { partner: 'blindpay', kind, id }, status, occurredAt: '2030-01-01T00:00:00.000Z', txHash: HASH,
    });
  });

  it('returns null for events that are not legs', () => {
    const { adapter } = setup();
    const body = '{"webhook_event":"customer.update","id":"re_000000000000","kyc_status":"approved"}';
    expect(adapter.parseWebhook(body, sign(body, ts))).toBeNull();
  });

  it('throws on a bad signature or a stale delivery, and without a secret', () => {
    const { adapter } = setup();
    const body = '{"webhook_event":"payout.update","id":"po_000000000001","status":"failed"}';
    expect(() => adapter.parseWebhook(body.replace('failed', 'completed'), sign(body, ts))).toThrow(WebhookVerificationError);
    expect(() => adapter.parseWebhook(body, sign(body, String(NOW / 1000 - 301)))).toThrow(/too old/);
    const bare = createBlindPayAdapter(config(mockFetch([]).fetch), { network: 'stellar' });
    expect(() => bare.parseWebhook(body, sign(body, ts))).toThrow(InvalidConfigError);
  });
});
