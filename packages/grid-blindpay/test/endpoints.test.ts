import { createBlindPayClient } from '../src/client';
import { InvalidInputError } from '../src/errors';
import { UNCONFIRMED_GET_PAYOUT_PATH } from '../src/stellar-payouts';
import { BANK_ACCOUNT_ID, CUSTOMER_ID, type MockReply, STELLAR_ADDRESS, WALLET_ID, config, mockFetch } from './helpers';

function setup(replies: MockReply[]) {
  const { fetch, calls } = mockFetch(replies);
  const client = createBlindPayClient(config(fetch));
  const route = (i: number) => `${calls[i]?.method} ${calls[i]?.url.replace(/^.*\/in_000000000000/, '')}`;
  return { client, calls, route };
}

const common = {
  tos_id: 'to_000000000000', kyc_type: 'standard', email: 'test@example.org', tax_id: '00000000000',
  address_line_1: 'Rua Teste 1', city: 'Cidade', state_province_region: 'SP', country: 'BR', postal_code: '00000-000',
} as const;

describe('client endpoints', () => {
  it('customers: create flattens individual extra fields, get and limits use the right paths', async () => {
    const { client, calls, route } = setup([{ body: { id: CUSTOMER_ID, kyc_status: 'verifying' } }, { body: {} }, { body: {} }]);
    const res = await client.customers.create({ ...common, type: 'individual', extra_fields: { first_name: 'Test', email: 'ignored' } });
    expect(res.data.id).toBe(CUSTOMER_ID);
    expect(calls[0]?.body).toEqual({ ...common, type: 'individual', first_name: 'Test' });
    await client.customers.get(CUSTOMER_ID);
    await client.customers.getLimits(CUSTOMER_ID);
    expect([route(0), route(1), route(2)]).toEqual([
      'POST /customers', `GET /customers/${CUSTOMER_ID}`, `GET /limits/customers/${CUSTOMER_ID}`,
    ]);
  });

  it('blockchain wallets: create forces account abstraction and requires the self-custody answer', async () => {
    const { client, calls, route } = setup([{ body: { id: WALLET_ID } }, { body: [{ id: WALLET_ID }] }, { body: { data: [], pagination: { has_more: false } } }, { body: {} }, { body: {} }]);
    await client.blockchainWallets.create(CUSTOMER_ID, { name: 'main', network: 'stellar_testnet', address: STELLAR_ADDRESS, is_self_custody: false }, { idempotencyKey: 'w-1' });
    expect(calls[0]?.body).toEqual({ name: 'main', network: 'stellar_testnet', is_account_abstraction: true, address: STELLAR_ADDRESS, is_self_custody: false });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('w-1');
    expect(await client.blockchainWallets.list(CUSTOMER_ID)).toEqual({ data: [{ id: WALLET_ID }] });
    expect(await client.blockchainWallets.list(CUSTOMER_ID, { limit: 10 })).toEqual({ data: [], pagination: { has_more: false } });
    await client.blockchainWallets.get(CUSTOMER_ID, WALLET_ID);
    await client.blockchainWallets.setSelfCustody(CUSTOMER_ID, WALLET_ID, true);
    expect(route(2)).toBe(`GET /customers/${CUSTOMER_ID}/blockchain-wallets?limit=10`);
    expect(route(4)).toBe(`PATCH /customers/${CUSTOMER_ID}/blockchain-wallets/${WALLET_ID}`);
    expect(calls[4]?.body).toEqual({ is_self_custody: true });

    const bad = { name: 'x', network: 'stellar', address: 'not-an-account', is_self_custody: true } as const;
    await expect(client.blockchainWallets.create(CUSTOMER_ID, bad)).rejects.toThrow(InvalidInputError);
    const unanswered = { ...bad, address: STELLAR_ADDRESS } as unknown as typeof bad;
    delete (unanswered as { is_self_custody?: boolean }).is_self_custody;
    await expect(client.blockchainWallets.create(CUSTOMER_ID, unanswered)).rejects.toThrow(/is_self_custody/);
  });

  it('payin quote, payin on /payins/evm, payout quote on /quotes', async () => {
    const { client, route } = setup([{ body: { id: 'qu_1' } }, { body: { id: 'pi_1', status: 'processing' } }, { body: {} }, { body: { id: 'qu_2' } }]);
    await client.payinQuotes.create({ blockchain_wallet_id: WALLET_ID, currency_type: 'sender', cover_fees: false, request_amount: 10_000, payment_method: 'pix', token: 'USDB' });
    await client.payins.create({ payin_quote_id: 'qu_1' });
    await client.payins.get('pi_1');
    await client.payoutQuotes.create({ bank_account_id: BANK_ACCOUNT_ID, currency_type: 'sender', cover_fees: false, request_amount: 10_000, network: 'stellar_testnet', token: 'USDB' });
    expect([0, 1, 2, 3].map(route)).toEqual(['POST /payin-quotes', 'POST /payins/evm', 'GET /payins/pi_1', 'POST /quotes']);
  });

  it('partner fees: create, list, get and delete with an Idempotency-Key', async () => {
    const { client, calls, route } = setup([{ body: { id: 'pf_1' } }, { body: [] }, { body: {} }, {}]);
    const fee = { name: 'spread', payin_percentage_fee: 50, payin_flat_fee: 0, payout_percentage_fee: 0, payout_flat_fee: 0 };
    await client.partnerFees.create(fee);
    await client.partnerFees.list();
    await client.partnerFees.get('pf_1');
    const del = await client.partnerFees.delete('pf_1');
    expect([0, 1, 2, 3].map(route)).toEqual(['POST /partner-fees', 'GET /partner-fees', 'GET /partner-fees/pf_1', 'DELETE /partner-fees/pf_1']);
    expect(calls[3]?.headers['Idempotency-Key']).toBe(del.idempotencyKey);
  });

  it('stellar payouts: create requires an Idempotency-Key; the read path is isolated', async () => {
    const { client, calls } = setup([]);
    const body = { quote_id: 'qu_1', signed_transaction: 'AAAA', sender_wallet_address: STELLAR_ADDRESS };
    await expect(client.stellarPayouts.create(body, { idempotencyKey: '' })).rejects.toThrow(/idempotencyKey/);
    await expect(client.stellarPayouts.create({ ...body, signed_transaction: '' }, { idempotencyKey: 'k' })).rejects.toThrow(/signed_transaction/);
    expect(calls).toHaveLength(0);
    expect(UNCONFIRMED_GET_PAYOUT_PATH('po_1')).toBe('/payouts/po_1');
  });

  it.each([
    ['customers.get', (c: ReturnType<typeof createBlindPayClient>) => c.customers.get('../admin')],
    ['customers.get wrong prefix', (c: ReturnType<typeof createBlindPayClient>) => c.customers.get(WALLET_ID)],
    ['payins.get', (c: ReturnType<typeof createBlindPayClient>) => c.payins.get('pi_1/../x')],
    ['payouts.get', (c: ReturnType<typeof createBlindPayClient>) => c.stellarPayouts.getPayout('po_1?x=1')],
    ['payin quote amount', (c: ReturnType<typeof createBlindPayClient>) =>
      c.payinQuotes.create({ blockchain_wallet_id: WALLET_ID, currency_type: 'sender', cover_fees: false, request_amount: 10.5, payment_method: 'pix', token: 'USDB' })],
  ])('rejects a malformed %s before any request', async (_name, call) => {
    const { client, calls } = setup([]);
    await expect(call(client)).rejects.toThrow(InvalidInputError);
    expect(calls).toHaveLength(0);
  });
});
