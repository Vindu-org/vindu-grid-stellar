import { InvalidInputError, type Logger } from '@vindu/grid-core';
import type { HorizonPaymentRecord } from '../src/horizon';
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

  it('a full page of malformed records without paging tokens still advances, by operation id', async () => {
    // Review probe: a full page of records without paging_token never moved
    // the cursor, so every poll read the same page maxPages times and
    // reported hasMore forever.
    const records = [
      paymentRecord({ id: '40960', paging_token: undefined }),
      paymentRecord({ id: '45056', paging_token: '' }),
      paymentRecord(),
    ];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const onMalformed = jest.fn();
    const seen: string[] = [];
    const layer = createReadLayer({
      gateway,
      cursorStore,
      pageSize: 2,
      maxPages: 5,
      onMalformed,
      onEvent: (p) => {
        seen.push(p.id);
      },
    });
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({
      delivered: 1,
      malformed: 2,
      cursor: records[2]!.paging_token,
      hasMore: false,
    });
    expect(onMalformed).toHaveBeenCalledTimes(2);
    expect(gateway.paymentQueries.map((q) => q.query.cursor)).toEqual([undefined, '45056']);
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 0, malformed: 0, hasMore: false });
    expect(onMalformed).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([records[2]!.id]);
  });

  it('a full page with no position at all throws instead of reading the same page again', async () => {
    const page = [paymentRecord({ paging_token: undefined }), paymentRecord({ paging_token: 'x' })];
    const gateway = new FakeGateway();
    let calls = 0;
    gateway.paymentsForAccount = async () => {
      calls += 1;
      return page;
    };
    const cursorStore = new InMemoryCursorStore();
    const onMalformed = jest.fn();
    const layer = createReadLayer({ gateway, cursorStore, pageSize: 2, maxPages: 50, onEvent: () => undefined, onMalformed });
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('no position past the cursor');
    expect(calls).toBe(1);
    expect(onMalformed).toHaveBeenCalledTimes(2);
    expect(await cursorStore.get(ACCOUNT)).toBeUndefined();
    await expect(layer.reconcile(ACCOUNT)).rejects.toThrow('no position past the cursor');
  });

  it('a page that repeats itself past its last position throws, never hasMore forever', async () => {
    // A Horizon that ignores the cursor: the position reached is never passed.
    const page = [paymentRecord({ id: '10', paging_token: undefined }), paymentRecord({ id: '11', paging_token: undefined })];
    const gateway = new FakeGateway();
    let calls = 0;
    gateway.paymentsForAccount = async () => {
      calls += 1;
      return page;
    };
    const cursorStore = new InMemoryCursorStore();
    const layer = createReadLayer({
      gateway,
      cursorStore,
      pageSize: 2,
      maxPages: 50,
      onEvent: () => undefined,
      onMalformed: () => undefined,
    });
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('no position past the cursor');
    expect(calls).toBe(2);
    expect(await cursorStore.get(ACCOUNT)).toBe('11');
  });

  it('validates its options', () => {
    const base = { gateway: new FakeGateway(), cursorStore: new InMemoryCursorStore(), onEvent: () => undefined };
    expect(() => createReadLayer({ ...base, pageSize: 0 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, pageSize: 201 })).toThrow(RangeError);
    expect(() => createReadLayer({ ...base, maxPages: 0 })).toThrow(RangeError);
  });
});

/** A payment record at position `n`, with an optional paging token and id. */
function at(n: number | bigint, overrides: { paging_token?: string; id?: string; amount?: string } = {}): HorizonPaymentRecord {
  return paymentRecord({ id: String(n), paging_token: String(n), ...overrides });
}

/** A layer over the fake Horizon, recording the cursors asked for and stored. */
function orderedLayer(records: readonly HorizonPaymentRecord[], pageSize: number, start?: string, numeric = false) {
  const gateway = new FakeGateway();
  gateway.payments.set(ACCOUNT, [...records]);
  const queries = gateway.paymentQueries;
  if (numeric) {
    // Pages by position as a number (paging token, else id) instead of list
    // place, as the review probe's Horizon did.
    const order = (r: HorizonPaymentRecord): bigint =>
      /^[0-9]+$/.test(r.paging_token) ? BigInt(r.paging_token) : /^[0-9]+$/.test(r.id) ? BigInt(r.id) : -1n;
    gateway.paymentsForAccount = async (account, query) => {
      queries.push({ account, query });
      const after = query.cursor === undefined ? -1n : BigInt(query.cursor);
      return records.filter((r) => order(r) > after).slice(0, query.limit);
    };
  }
  const cursorStore = new InMemoryCursorStore();
  const stored: string[] = [];
  const set = cursorStore.set.bind(cursorStore);
  cursorStore.set = async (account, cursor) => {
    stored.push(cursor);
    return set(account, cursor);
  };
  const delivered: string[] = [];
  const malformed: string[] = [];
  const layer = createReadLayer({
    gateway,
    cursorStore,
    pageSize,
    maxPages: 10,
    onEvent: (p) => {
      delivered.push(p.id);
    },
    onMalformed: (record) => {
      malformed.push(record.id);
    },
  });
  const poll = async () => {
    if (start !== undefined) await set(ACCOUNT, start);
    return layer.pollAccount(ACCOUNT);
  };
  return { layer, poll, queries: () => queries.map((q) => q.query.cursor), stored, delivered, malformed, cursorStore };
}

/** Whether every stored cursor is greater than the one before, as integers. */
function onlyForward(stored: readonly string[]): boolean {
  return stored.every((c, i) => i === 0 || BigInt(c) > BigInt(stored[i - 1]!));
}

describe('read layer: positions only move forward', () => {
  // Review probe: a malformed record with a huge operation id moved the
  // cursor past every payment after it, so they were never delivered.
  it('a malformed record with a huge id before valid payments does not skip them', async () => {
    const records = [at(1), at(2), at(3, { paging_token: 'bad', id: '999999999999' }), at(4), at(5)];
    const t = orderedLayer(records, 200);
    expect(await t.poll()).toMatchObject({ delivered: 4, malformed: 1, skipped: 0, cursor: '5', hasMore: false });
    expect(t.delivered).toEqual(['1', '2', '4', '5']);
    expect(t.malformed).toEqual(['999999999999']);
    expect(t.stored).not.toContain('999999999999');
    expect(onlyForward(t.stored)).toBe(true);
    expect(await t.cursorStore.get(ACCOUNT)).toBe('5');
  });

  // The review probe's exact case: the malformed record is the last one on
  // its page, so the next payment is on the next page.
  it('a malformed record with a huge id last on its page does not skip the next page', async () => {
    const records = [at(1), at(2), at(3, { paging_token: 'bad', id: '999999' }), at(4), at(5)];
    const t = orderedLayer(records, 3, undefined, true);
    await t.poll();
    expect(t.delivered).toEqual(['1', '2', '4', '5']);
    // Read from the last payment, not from the huge id.
    expect(t.queries()).toEqual([undefined, '2', '5']);
    expect(t.stored.indexOf('5')).toBeGreaterThanOrEqual(0);
    expect(t.stored.slice(0, t.stored.indexOf('5'))).not.toContain('999999');
  });

  it('a malformed record with a huge id ahead of a page boundary does not skip the next page', async () => {
    // The bound is the next readable record on the same page.
    const records = [at(1), at(2, { paging_token: 'bad', id: '999999999999' }), at(3), at(4), at(5)];
    const t = orderedLayer(records, 3);
    await t.poll();
    expect(t.delivered).toEqual(['1', '3', '4', '5']);
    expect(t.queries()).toEqual([undefined, '3']);
  });

  it('a malformed record whose fallback id is below the next payment still moves the cursor to it', async () => {
    const records = [at(10), at(20, { paging_token: '', amount: 'bad' }), at(30)];
    const t = orderedLayer(records, 200);
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const cursorStore = new InMemoryCursorStore();
    const layer = createReadLayer({
      gateway,
      cursorStore,
      onMalformed: () => undefined,
      onEvent: (p) => {
        if (p.id === '30') throw new Error('db down');
      },
    });
    // Stopped at the payment after it: the position kept is the malformed record's id.
    await expect(layer.pollAccount(ACCOUNT)).rejects.toThrow('db down');
    expect(await cursorStore.get(ACCOUNT)).toBe('20');
    // And with nothing failing, the poll passes both.
    await t.poll();
    expect(t.delivered).toEqual(['10', '30']);
    expect(t.malformed).toEqual(['20']);
  });

  it('a malformed record without a readable record after it on a page that moves waits for the next page', async () => {
    // Its id cannot be bounded yet: the next page, read from the last payment, bounds it.
    const records = [at(10), at(20, { paging_token: '', amount: 'bad' }), at(30), at(40)];
    const t = orderedLayer(records, 2);
    await t.poll();
    expect(t.delivered).toEqual(['10', '30', '40']);
    expect(t.queries()).toEqual([undefined, '10', '30']);
    expect(t.malformed).toEqual(['20', '20']);
    expect(onlyForward(t.stored)).toBe(true);
  });

  it('a malformed record whose fallback id equals the next payment\'s token does not move the cursor', async () => {
    const records = [at(10), at(20, { paging_token: 'x', id: '30' }), at(30)];
    const t = orderedLayer(records, 200);
    await t.poll();
    expect(t.delivered).toEqual(['10', '30']);
    expect(t.stored).toEqual(['10', '30']);
  });

  it('a malformed record at or behind the cursor goes to onMalformed and never moves it back', async () => {
    const records = [at(5, { amount: '1e3' }), at(10), at(7, { paging_token: '', amount: 'bad' }), at(10, { amount: '1e3' }), at(12)];
    const gateway = new FakeGateway();
    gateway.payments.set(ACCOUNT, records);
    const malformed: string[] = [];
    const delivered: string[] = [];
    const cursorStore = new InMemoryCursorStore();
    await cursorStore.set(ACCOUNT, '6');
    const layer = createReadLayer({
      gateway,
      cursorStore,
      onEvent: (p) => {
        delivered.push(p.id);
      },
      onMalformed: (record) => {
        malformed.push(record.id);
      },
    });
    // A Horizon that answers with records it should not have: every one of them is read.
    gateway.paymentsForAccount = async () => records;
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 2, malformed: 3, cursor: '12' });
    expect(malformed).toEqual(['5', '7', '10']);
    expect(delivered).toEqual(['10', '12']);
    expect(await cursorStore.get(ACCOUNT)).toBe('12');
  });

  // Review probe: a payment whose paging token went backwards moved the
  // cursor back, so the next page read payments already delivered again.
  it('a readable payment behind the cursor is skipped and never moves it back', async () => {
    const records = [at(10), at(11), at(5), at(12), at(13)];
    const t = orderedLayer(records, 3);
    // The fake pages by list position, so the out-of-order record comes back
    // at the head of the second page too, and is passed over again.
    expect(await t.poll()).toMatchObject({ delivered: 4, skipped: 2, malformed: 0, cursor: '13', hasMore: false });
    expect(t.delivered).toEqual(['10', '11', '12', '13']);
    expect(t.queries()).toEqual([undefined, '11', '13']);
    expect(t.stored).not.toContain('5');
    expect(onlyForward(t.stored)).toBe(true);
  });

  it('a payment with the same position as the cursor is skipped, not delivered twice', async () => {
    const gateway = new FakeGateway();
    gateway.paymentsForAccount = async () => [at(20), at(20), at(21)];
    const delivered: string[] = [];
    const layer = createReadLayer({
      gateway,
      cursorStore: new InMemoryCursorStore(),
      onEvent: (p) => {
        delivered.push(p.id);
      },
    });
    expect(await layer.pollAccount(ACCOUNT)).toMatchObject({ delivered: 2, skipped: 1, cursor: '21' });
    expect(delivered).toEqual(['20', '21']);
  });

  it('compares positions as integers, not as strings or floating point numbers', async () => {
    const short = orderedLayer([at(999), at(1000), at(1001)], 200, '999');
    await short.poll();
    expect(short.delivered).toEqual(['1000', '1001']);

    const big = 9007199254740992n; // 2^53: the next integer is not a distinct JavaScript number.
    const huge = orderedLayer([at(big), at(big + 1n), at(big + 2n)], 200, String(big));
    await huge.poll();
    expect(huge.delivered).toEqual([String(big + 1n), String(big + 2n)]);
    expect(await huge.cursorStore.get(ACCOUNT)).toBe(String(big + 2n));
  });

  it('reconcile passes over a payment behind its window position too', async () => {
    const records = [at(10), at(11), at(5), at(12)];
    const t = orderedLayer(records, 200);
    const result = await t.layer.reconcile(ACCOUNT);
    expect(result.payments.map((p) => p.id)).toEqual(['10', '11', '12']);
    expect(result).toMatchObject({ skipped: 1, lastCursor: '12' });
  });
});
