import type { Logger } from '@vindu/grid-core';
import type { ChainPayment } from '../src/payments';
import { InMemoryCursorStore, createReadLayer } from '../src/read-layer';
import { ACCOUNT, FakeGateway, OTHER, THIRD, USDC_ISSUER, paymentRecord } from './fake-gateway';

function setup(records = [paymentRecord(), paymentRecord(), paymentRecord()], pageSize = 200) {
  const gateway = new FakeGateway();
  gateway.payments.set(ACCOUNT, records);
  const cursorStore = new InMemoryCursorStore();
  const seen: ChainPayment[] = [];
  const onEvent = jest.fn(async (p: ChainPayment) => {
    seen.push(p);
  });
  const layer = createReadLayer({ gateway, cursorStore, onEvent, pageSize });
  return { gateway, cursorStore, seen, onEvent, layer, records };
}

describe('read layer', () => {
  it('reads every payment in ascending order and stores the last paging token', async () => {
    const { layer, seen, cursorStore, records, gateway } = setup();
    const result = await layer.pollAccount(ACCOUNT);
    expect(seen.map((p) => p.id)).toEqual(records.map((r) => r.id));
    expect(result).toEqual({ delivered: 3, skipped: 0, cursor: records[2]!.paging_token, hasMore: false });
    expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
    expect(gateway.paymentQueries[0]!.query.order).toBe('asc');
  });

  it('resumes from the stored cursor', async () => {
    const { layer, seen, cursorStore, records, gateway } = setup();
    await cursorStore.set(ACCOUNT, records[0]!.paging_token);
    await layer.pollAccount(ACCOUNT);
    expect(gateway.paymentQueries[0]!.query.cursor).toBe(records[0]!.paging_token);
    expect(seen.map((p) => p.id)).toEqual([records[1]!.id, records[2]!.id]);
  });

  it('delivers nothing new on a second poll', async () => {
    const { layer, onEvent } = setup();
    await layer.pollAccount(ACCOUNT);
    const again = await layer.pollAccount(ACCOUNT);
    expect(again.delivered).toBe(0);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it('advances the cursor only after onEvent succeeds and redelivers on the next poll', async () => {
    const { layer, cursorStore, records, onEvent } = setup();
    onEvent
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error('storage down');
      });
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('storage down');
    expect(await cursorStore.get(ACCOUNT)).toBe(records[0]!.paging_token);

    const delivered: string[] = [];
    onEvent.mockImplementation(async (p) => {
      delivered.push(p.id);
    });
    await layer.pollAccount(ACCOUNT);
    expect(delivered).toEqual([records[1]!.id, records[2]!.id]);
    expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
  });

  it('leaves the cursor unset when the very first onEvent throws', async () => {
    const { layer, cursorStore, onEvent } = setup();
    onEvent.mockRejectedValueOnce(new Error('nope'));
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('nope');
    expect(await cursorStore.get(ACCOUNT)).toBeUndefined();
  });

  it('pages over multiple pages', async () => {
    const records = Array.from({ length: 5 }, () => paymentRecord());
    const { layer, seen, gateway } = setup(records, 2);
    const result = await layer.pollAccount(ACCOUNT);
    expect(seen).toHaveLength(5);
    expect(gateway.paymentQueries.map((q) => q.query.cursor)).toEqual([
      undefined,
      records[1]!.paging_token,
      records[3]!.paging_token,
    ]);
    expect(result.hasMore).toBe(false);
  });

  it('stops at maxPages and reports hasMore', async () => {
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, Array.from({ length: 5 }, () => paymentRecord()));
    const layer = createReadLayer({ gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined, pageSize: 2, maxPages: 1 });
    const result = await layer.pollAccount(ACCOUNT);
    expect(result).toMatchObject({ delivered: 2, hasMore: true });
  });

  it('normalises asset and amount with 7 decimals', async () => {
    const { layer, seen } = setup([
      paymentRecord({ amount: '1234.5678901', memo: 'ref-1', memo_type: 'text' }),
      paymentRecord({ amount: '10.0000000', from: ACCOUNT, to: OTHER }),
      paymentRecord({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined, amount: '0.0000001' }),
    ]);
    await layer.pollAccount(ACCOUNT);
    expect(seen[0]).toMatchObject({
      type: 'payment',
      direction: 'incoming',
      from: OTHER,
      to: ACCOUNT,
      asset: { code: 'USDC', issuer: USDC_ISSUER },
      amount: '1234.5678901',
      memo: 'ref-1',
      memoType: 'text',
    });
    expect(seen[1]).toMatchObject({ direction: 'outgoing', amount: '10' });
    expect(seen[2]).toMatchObject({ asset: { code: 'XLM' }, amount: '0.0000001' });
    expect(seen[2]!.asset.issuer).toBeUndefined();
  });

  it('normalises path payments with their source asset and amount', async () => {
    const { layer, seen } = setup([
      paymentRecord({
        type: 'path_payment_strict_send',
        amount: '99.5000000',
        source_asset_type: 'native',
        source_amount: '800.0000000',
      }),
      paymentRecord({ type: 'path_payment_strict_receive', amount: '5.0000000' }),
    ]);
    await layer.pollAccount(ACCOUNT);
    expect(seen[0]).toMatchObject({
      type: 'path_payment_strict_send',
      amount: '99.5',
      sourceAsset: { code: 'XLM' },
      sourceAmount: '800',
    });
    expect(seen[1]!.type).toBe('path_payment_strict_receive');
  });

  it('reports account creation as an XLM payment', async () => {
    const { layer, seen } = setup([
      paymentRecord({ type: 'create_account', funder: OTHER, account: ACCOUNT, starting_balance: '2.0000000', from: undefined, to: undefined }),
    ]);
    await layer.pollAccount(ACCOUNT);
    expect(seen[0]).toMatchObject({ type: 'create_account', from: OTHER, to: ACCOUNT, asset: { code: 'XLM' }, amount: '2' });
  });

  it('ignores unrelated operation types, failed transactions and payments between other accounts', async () => {
    const { layer, seen, cursorStore } = setup([
      paymentRecord({ type: 'account_merge' }),
      paymentRecord({ type: 'change_trust' }),
      paymentRecord({ transaction_successful: false }),
      paymentRecord({ from: OTHER, to: THIRD }),
      paymentRecord({ asset_type: 'liquidity_pool_shares' }),
    ]);
    const result = await layer.pollAccount(ACCOUNT);
    expect(seen).toHaveLength(0);
    expect(result.skipped).toBe(5);
    // Skipped records still move the cursor, so they are not read again.
    expect(await cursorStore.get(ACCOUNT)).toBe(result.cursor);
  });

  it('reconcile re-reads a window and does not move the main cursor', async () => {
    const { layer, cursorStore, records, onEvent } = setup();
    await cursorStore.set(ACCOUNT, records[2]!.paging_token);
    const result = await layer.reconcile(ACCOUNT, records[0]!.paging_token);
    expect(result.payments.map((p) => p.id)).toEqual([records[1]!.id, records[2]!.id]);
    expect(result.lastCursor).toBe(records[2]!.paging_token);
    expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reconcile from the start can deliver without touching the cursor', async () => {
    const { layer, cursorStore, onEvent } = setup();
    const result = await layer.reconcile(ACCOUNT, undefined, { deliver: true });
    expect(result.payments).toHaveLength(3);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(await cursorStore.get(ACCOUNT)).toBeUndefined();
  });

  it('rejects a concurrent poll of the same account', async () => {
    const { layer, onEvent } = setup();
    let release: () => void = () => undefined;
    onEvent.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = layer.pollAccount(ACCOUNT);
    await new Promise((r) => setImmediate(r));
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('already running');
    release();
    await expect(first).resolves.toMatchObject({ delivered: 3 });
  });

  it('logs ids and hashes only, never addresses or memos', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (m, f) => lines.push(m + JSON.stringify(f)),
      info: (m, f) => lines.push(m + JSON.stringify(f)),
      warn: (m, f) => lines.push(m + JSON.stringify(f)),
      error: (m, f) => lines.push(m + JSON.stringify(f)),
    };
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, [paymentRecord({ memo: 'client-ref' })]);
    const layer = createReadLayer({ gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined, logger });
    await layer.pollAccount(ACCOUNT);
    const text = lines.join('\n');
    expect(text).toContain('paymentId');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain('client-ref');
  });

  it('validates its options', () => {
    const base = { gateway: new FakeGateway(), cursorStore: new InMemoryCursorStore(), onEvent: () => undefined };
    expect(() => createReadLayer({ ...base, pageSize: 0 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, pageSize: 201 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, maxPages: 0 })).toThrow(RangeError);
  });
});
