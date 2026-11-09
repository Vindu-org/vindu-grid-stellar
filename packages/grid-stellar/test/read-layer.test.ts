import { InvalidInputError, type Logger } from '@vindu/grid-core';
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
    expect(result).toEqual({ delivered: 3, skipped: 0, malformed: 0, cursor: records[2]!.paging_token, hasMore: false });
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

  it('passes over a record it cannot read, reports it, and keeps going', async () => {
    // Review probe: an amount like "1e3" made normalisePayment throw on every
    // poll, so the cursor never moved past it.
    const records = [paymentRecord(), paymentRecord({ amount: '1e3' }), paymentRecord()];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const seen: string[] = [];
    const bad: Array<[string, string]> = [];
    const layer = createReadLayer({
      gateway,
      cursorStore,
      onEvent: (p) => {
        seen.push(p.id);
      },
      onMalformed: (record, error) => {
        bad.push([record.id, error instanceof Error ? error.name : String(error)]);
      },
    });
    const result = await layer.pollAccount(ACCOUNT);
    expect(seen).toEqual([records[0]!.id, records[2]!.id]);
    expect(bad).toEqual([[records[1]!.id, 'InvalidMoneyError']]);
    expect(result).toMatchObject({ delivered: 2, skipped: 0, malformed: 1, cursor: records[2]!.paging_token });
    expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
    // Not read again.
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 0, malformed: 0 });
    expect(bad).toHaveLength(1);
  });

  it('a malformed record as the last one still moves the cursor past it', async () => {
    const records = [paymentRecord(), paymentRecord({ amount: 'not-a-number' })];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const layer = createReadLayer({ gateway, cursorStore, onEvent: () => undefined, onMalformed: () => undefined });
    await layer.pollAccount(ACCOUNT);
    expect(await cursorStore.get(ACCOUNT)).toBe(records[1]!.paging_token);
  });

  it('by default logs a malformed record with its ids only', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m, f) => lines.push(m + JSON.stringify(f)),
      error: () => undefined,
    };
    const record = paymentRecord({ amount: '1e3', memo: 'client-ref' });
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, [record]);
    const layer = createReadLayer({ gateway, cursorStore: new InMemoryCursorStore(), onEvent: () => undefined, logger });
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ malformed: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(record.id);
    expect(lines[0]).toContain(record.transaction_hash);
    expect(lines[0]).toContain('InvalidMoneyError');
    for (const secret of [ACCOUNT, OTHER, 'client-ref', '1e3']) expect(lines[0]).not.toContain(secret);
  });

  it('a record without a paging token is malformed and never resets the cursor to the start', async () => {
    // Review probe: a record without paging_token set the position to
    // undefined, so the next page was read from the start and the stored
    // cursor was cleared.
    const records = [paymentRecord(), paymentRecord({ paging_token: undefined, amount: 'bad' }), paymentRecord()];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const stored: Array<string | undefined> = [];
    const set = cursorStore.set.bind(cursorStore);
    cursorStore.set = async (account, cursor) => {
      stored.push(cursor);
      return set(account, cursor);
    };
    const seen: string[] = [];
    const bad: unknown[] = [];
    const layer = createReadLayer({
      gateway,
      cursorStore,
      pageSize: 2,
      maxPages: 5,
      onEvent: (p) => {
        seen.push(p.id);
      },
      onMalformed: (_record, error) => {
        bad.push(error);
      },
    });
    const result = await layer.pollAccount(ACCOUNT);
    expect(seen).toEqual([records[0]!.id, records[2]!.id]);
    expect(bad.length).toBeGreaterThanOrEqual(1);
    expect(bad[0]).toBeInstanceOf(InvalidInputError);
    expect(result).toMatchObject({ delivered: 2, cursor: records[2]!.paging_token, hasMore: false });
    expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
    expect(stored.every((c) => typeof c === 'string')).toBe(true);
    // After the first page, every page continues from a real paging token.
    expect(gateway.paymentQueries.slice(1).every((q) => typeof q.query.cursor === 'string')).toBe(true);
  });

  it.each(['id', 'paging_token', 'transaction_hash'] as const)(
    'a record without a string %s goes to onMalformed, whatever its type',
    async (field) => {
      for (const overrides of [{ [field]: undefined }, { [field]: 42 as unknown as string }]) {
        for (const type of ['payment', 'change_trust']) {
          const records = [paymentRecord(), paymentRecord({ type, ...overrides }), paymentRecord()];
          const gateway = new FakeGateway();
          gateway.payments.set(ACCOUNT, records);
          const cursorStore = new InMemoryCursorStore();
          const bad: unknown[] = [];
          const layer = createReadLayer({
            gateway,
            cursorStore,
            onEvent: () => undefined,
            onMalformed: (_record, error) => {
              bad.push(error);
            },
          });
          expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 2, malformed: 1 });
          expect(bad).toEqual([expect.any(InvalidInputError)]);
          expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
        }
      }
    },
  );

  it('a tokenless record alone leaves the stored cursor as it was', async () => {
    const first = paymentRecord();
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, [first]);
    const cursorStore = new InMemoryCursorStore();
    const layer = createReadLayer({ gateway, cursorStore, onEvent: () => undefined, onMalformed: () => undefined });
    await layer.pollAccount(ACCOUNT);
    gateway.payments.get(ACCOUNT)!.push(paymentRecord({ paging_token: undefined }));
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ malformed: 1, cursor: first.paging_token });
    expect(await cursorStore.get(ACCOUNT)).toBe(first.paging_token);
  });

  it('reconcile reports a tokenless record as malformed and keeps its last cursor', async () => {
    const records = [paymentRecord(), paymentRecord({ paging_token: undefined })];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const layer = createReadLayer({
      gateway,
      cursorStore: new InMemoryCursorStore(),
      onEvent: () => undefined,
      onMalformed: () => undefined,
    });
    expect(await layer.reconcile(ACCOUNT)).toMatchObject({ malformed: 1, lastCursor: records[0]!.paging_token });
  });

  it('an onMalformed that throws stops the poll with the cursor before that record', async () => {
    const records = [paymentRecord({ type: 'change_trust' }), paymentRecord({ amount: '1e3' }), paymentRecord()];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const layer = createReadLayer({
      gateway,
      cursorStore,
      onEvent: () => undefined,
      onMalformed: () => {
        throw new Error('halt');
      },
    });
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('halt');
    expect(await cursorStore.get(ACCOUNT)).toBe(records[0]!.paging_token);
  });

  it('stores the position past skipped records once per page, not once per record', async () => {
    const records = [
      ...Array.from({ length: 4 }, () => paymentRecord({ type: 'change_trust' })),
      paymentRecord({ amount: '1e3' }),
      paymentRecord(),
      ...Array.from({ length: 3 }, () => paymentRecord({ from: OTHER, to: THIRD })),
    ];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const set = jest.spyOn(cursorStore, 'set');
    const layer = createReadLayer({ gateway, cursorStore, onEvent: () => undefined, onMalformed: () => undefined, pageSize: 5 });
    const result = await layer.pollAccount(ACCOUNT);
    expect(result).toMatchObject({ delivered: 1, skipped: 7, malformed: 1, cursor: records[8]!.paging_token });
    // End of page 1 (after 4 skipped and 1 malformed), the delivered payment, end of page 2.
    expect(set.mock.calls.map((c) => c[1])).toEqual([
      records[4]!.paging_token,
      records[5]!.paging_token,
      records[8]!.paging_token,
    ]);
  });

  it('keeps the position past skipped records when onEvent fails after them', async () => {
    const records = [paymentRecord({ type: 'change_trust' }), paymentRecord({ type: 'change_trust' }), paymentRecord()];
    const { layer, cursorStore, onEvent, gateway } = setup(records);
    gateway.payments.set(ACCOUNT, records);
    onEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('db down');
    expect(await cursorStore.get(ACCOUNT)).toBe(records[1]!.paging_token);
  });

  it('reconcile reports malformed records too and never moves the cursor', async () => {
    const records = [paymentRecord(), paymentRecord({ amount: '1e3' })];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const onMalformed = jest.fn();
    const layer = createReadLayer({ gateway, cursorStore, onEvent: () => undefined, onMalformed });
    const result = await layer.reconcile(ACCOUNT);
    expect(result).toMatchObject({ skipped: 0, malformed: 1, lastCursor: records[1]!.paging_token });
    expect(result.payments).toHaveLength(1);
    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(await cursorStore.get(ACCOUNT)).toBeUndefined();
  });

  it.each(['', '   ', 'pt-7', '-1', '1.5', '1e3', ' 12', '12\n'])(
    'a paging_token of %j is malformed and never becomes the cursor',
    async (token) => {
      // Review probe: an empty paging_token was stored as the cursor, and
      // the next poll read the account from the start again.
      const records = [paymentRecord(), paymentRecord({ paging_token: token }), paymentRecord()];
      const gateway = new FakeGateway();
      gateway.payments.set(ACCOUNT, records);
      const cursorStore = new InMemoryCursorStore();
      const stored: string[] = [];
      const set = cursorStore.set.bind(cursorStore);
      cursorStore.set = async (account, cursor) => {
        stored.push(cursor);
        return set(account, cursor);
      };
      const seen: string[] = [];
      const bad: unknown[] = [];
      const layer = createReadLayer({
        gateway,
        cursorStore,
        onEvent: (p) => {
          seen.push(p.id);
        },
        onMalformed: (_record, error) => {
          bad.push(error);
        },
      });
      expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 2, malformed: 1 });
      expect(bad).toEqual([expect.any(InvalidInputError)]);
      expect(stored).not.toContain(token);
      expect(await cursorStore.get(ACCOUNT)).toBe(records[2]!.paging_token);
      // Nothing is delivered twice.
      expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 0, malformed: 0 });
      expect(seen).toEqual([records[0]!.id, records[2]!.id]);
    },
  );

  it('validates its options', () => {
    const base = { gateway: new FakeGateway(), cursorStore: new InMemoryCursorStore(), onEvent: () => undefined };
    expect(() => createReadLayer({ ...base, pageSize: 0 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, pageSize: 201 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, maxPages: 0 })).toThrow(RangeError);
  });
});
