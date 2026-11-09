import { InvalidConfigError, InvalidInputError } from '@vindu/grid-core';
import {
  type HorizonFetch,
  type HorizonFetchInit,
  type HorizonServer,
  createHorizonGateway,
} from '../src/horizon';
import { TESTNET_HORIZON_URL, TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { stellarSdk } from '../src/sdk';

const { Account, Horizon, Keypair, Networks, Operation, TransactionBuilder, xdr } = stellarSdk;

function signedXdr(): string {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
    .setTimeout(60)
    .build();
  tx.sign(source);
  return tx.toXDR();
}

const HASH = 'ab'.repeat(32);

/** One canned answer of the fake Horizon. */
interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A fetch that answers from `routes` by path, and records what it was asked. No network. */
function fakeFetch(routes: Record<string, Answer | (() => Promise<Answer>)>) {
  const calls: Array<{ url: string; init: HorizonFetchInit }> = [];
  const fetch: HorizonFetch = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    const answer: Answer = route === undefined ? { status: 404, body: {} } : typeof route === 'function' ? await route() : route;
    const headers = new Map(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: answer.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: new Response(JSON.stringify(answer.body ?? null)).body,
    };
  };
  return { fetch, calls };
}

function gatewayWith(
  routes: Parameters<typeof fakeFetch>[0],
  extra: { submit?: () => Promise<unknown>; requestTimeoutMs?: number } = {},
) {
  const { fetch, calls } = fakeFetch(routes);
  const server: HorizonServer = { submitTransaction: extra.submit ?? (async () => ({})) };
  return {
    gateway: createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      server,
      ...(extra.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: extra.requestTimeoutMs }),
    }),
    calls,
  };
}

const httpError = (status: number, data?: unknown) => Object.assign(new Error('http'), { response: { status, data } });

/** A real `result_xdr`: a failed transaction whose one payment was underfunded. */
const UNDERFUNDED_RESULT = 'AAAAAAAAAGT/////AAAAAQAAAAAAAAAB/////gAAAAA=';

describe('horizon gateway', () => {
  it("accepts the SDK's Horizon.Server for submission and the global fetch for reads", () => {
    // Compile-time checks: the structural types fit the SDK's server and the global fetch.
    const server: HorizonServer = new Horizon.Server(TESTNET_HORIZON_URL);
    const fetch: HorizonFetch = globalThis.fetch;
    expect(typeof server.submitTransaction).toBe('function');
    expect(typeof fetch).toBe('function');
  });

  it('exposes its network passphrase', () => {
    expect(gatewayWith({}).gateway.networkPassphrase).toBe(TESTNET_NETWORK_PASSPHRASE);
  });

  it('refuses http without allowHttp, a non-URL, and a URL with a query, a fragment or credentials', () => {
    const base = { networkPassphrase: TESTNET_NETWORK_PASSPHRASE, fetch: fakeFetch({}).fetch };
    for (const horizonUrl of [
      'http://horizon.example',
      'not a url',
      'https://h.example/?a=1',
      'https://u:p@h.example',
      // An empty query or fragment parses away; the raw characters are refused.
      'https://h.example/?',
      'https://h.example/#',
      'https://h.example/x?#',
    ]) {
      expect(() => createHorizonGateway({ ...base, horizonUrl })).toThrow(InvalidConfigError);
    }
    expect(() => createHorizonGateway({ ...base, horizonUrl: 'http://127.0.0.1:8000', allowHttp: true })).not.toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])('refuses requestTimeoutMs = %p', (requestTimeoutMs) => {
    expect(() =>
      createHorizonGateway({
        horizonUrl: TESTNET_HORIZON_URL,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
        fetch: fakeFetch({}).fetch,
        requestTimeoutMs,
      }),
    ).toThrow(InvalidConfigError);
  });

  it('reads the latest ingested ledger from the root resource', async () => {
    const { gateway, calls } = gatewayWith({
      '/': {
        body: {
          history_latest_ledger: 51,
          history_latest_ledger_closed_at: '2026-11-09T12:00:05Z',
          history_elder_ledger: 2,
          network_passphrase: TESTNET_NETWORK_PASSPHRASE,
        },
      },
    });
    expect(await gateway.latestLedger()).toEqual({ sequence: 51, closedAt: new Date('2026-11-09T12:00:05Z') });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TESTNET_HORIZON_URL}/`);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('fails latestLedger when Horizon returns no usable ledger', async () => {
    for (const body of [
      {},
      { history_latest_ledger: 51 },
      { history_latest_ledger: '51', history_latest_ledger_closed_at: '2026-11-09T12:00:05Z' },
      { history_latest_ledger: 51, history_latest_ledger_closed_at: 'soon' },
      { history_latest_ledger: 1.5, history_latest_ledger_closed_at: '2026-11-09T12:00:05Z' },
    ]) {
      await expect(gatewayWith({ '/': { body } }).gateway.latestLedger()).rejects.toThrow('no usable latest ledger');
    }
  });

  it('a not-found lookup carries the answering instance\'s Latest-Ledger header', async () => {
    const { gateway, calls } = gatewayWith({ [`/transactions/${HASH}`]: { status: 404, headers: { 'Latest-Ledger': '812' } } });
    expect(await gateway.transaction(HASH)).toEqual({ found: false, latestLedger: 812 });
    expect(calls[0]?.url).toBe(`${TESTNET_HORIZON_URL}/transactions/${HASH}`);
  });

  it('a not-found lookup without a usable Latest-Ledger header carries none', async () => {
    for (const headers of [{}, { 'Latest-Ledger': 'soon' }, { 'Latest-Ledger': '-3' }, { 'Latest-Ledger': '0' }]) {
      const { gateway } = gatewayWith({ [`/transactions/${HASH}`]: { status: 404, headers } });
      expect(await gateway.transaction(HASH)).toEqual({ found: false });
    }
  });

  it('a found transaction carries its fields, its inner hash, its result codes and the Latest-Ledger header', async () => {
    const inner = 'cd'.repeat(32);
    const { gateway } = gatewayWith({
      [`/transactions/${HASH}`]: {
        headers: { 'Latest-Ledger': '900' },
        body: {
          hash: HASH,
          successful: false,
          ledger: 899,
          created_at: '2026-11-09T12:00:05Z',
          inner_transaction: { hash: inner },
          result_xdr: UNDERFUNDED_RESULT,
          envelope_xdr: 'AAAA',
        },
      },
    });
    expect(await gateway.transaction(HASH)).toEqual({
      found: true,
      hash: HASH,
      innerHash: inner,
      successful: false,
      ledger: 899,
      createdAt: '2026-11-09T12:00:05Z',
      resultCodes: { transaction: 'tx_failed', operations: ['op_underfunded'] },
      latestLedger: 900,
    });
  });

  it("reads a failed fee bump's codes from its inner transaction", async () => {
    // A real fee-bump result, laid out byte by byte: the inner result has
    // the same layout as a plain transaction result.
    const outer = Buffer.concat([
      Buffer.from('00000000000000c8', 'hex'), // fee charged: 200
      Buffer.from('fffffff3', 'hex'), // txFeeBumpInnerFailed
      Buffer.from(HASH, 'hex'), // inner transaction hash
      Buffer.from(UNDERFUNDED_RESULT, 'base64'), // inner result
      Buffer.from('00000000', 'hex'), // ext
    ]).toString('base64');
    expect(xdr.TransactionResult.fromXDR(outer, 'base64')).toBeDefined();
    const { gateway } = gatewayWith({
      [`/transactions/${HASH}`]: { body: { hash: HASH, successful: false, result_xdr: outer } },
    });
    expect(await gateway.transaction(HASH)).toMatchObject({
      resultCodes: { transaction: 'tx_fee_bump_inner_failed', operations: ['op_underfunded'] },
    });
  });

  it('leaves result codes out when the result XDR cannot be read', async () => {
    const { gateway } = gatewayWith({ [`/transactions/${HASH}`]: { body: { hash: HASH, successful: false, result_xdr: '%%%' } } });
    expect(await gateway.transaction(HASH)).toEqual({ found: true, hash: HASH, successful: false });
  });

  it('fails a lookup whose answer has no hash or result', async () => {
    const { gateway } = gatewayWith({ [`/transactions/${HASH}`]: { body: { ledger: 3 } } });
    await expect(gateway.transaction(HASH)).rejects.toThrow('without a hash');
  });

  it('refuses to look up anything that is not a transaction hash', async () => {
    const { gateway, calls } = gatewayWith({});
    for (const hash of ['ab', '../accounts', `${HASH}?x=1`]) {
      await expect(gateway.transaction(hash)).rejects.toThrow(InvalidInputError);
    }
    expect(calls).toEqual([]);
  });

  it('rethrows other lookup errors with the status only', async () => {
    const { gateway } = gatewayWith({ [`/transactions/${HASH}`]: { status: 500, body: { detail: 'secret' } } });
    const error = await gateway.transaction(HASH).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'HorizonRequestError', status: 500 });
    expect(String(error)).not.toContain('secret');
  });

  it('aborts a GET that takes longer than requestTimeoutMs, and the lookup throws', async () => {
    let aborted = false;
    const fetch: HorizonFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal.reason);
        });
      });
    const gateway = createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      requestTimeoutMs: 20,
    });
    await expect(gateway.transaction(HASH)).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("aborts a GET when the caller's signal aborts", async () => {
    const fetch: HorizonFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const gateway = createHorizonGateway({ horizonUrl: TESTNET_HORIZON_URL, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, fetch });
    const controller = new AbortController();
    const pending = gateway.latestLedger({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('refuses a maxResponseBytes that is not a positive whole number', () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createHorizonGateway({
          horizonUrl: TESTNET_HORIZON_URL,
          networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
          fetch: fakeFetch({}).fetch,
          maxResponseBytes,
        }),
      ).toThrow(InvalidConfigError);
    }
  });

  /** A fetch whose 200 body streams `chunks` one by one, and reports what was pulled and cancelled. */
  function streamingFetch(chunks: readonly Uint8Array[], headers: Record<string, string> = {}) {
    const seen = { pulled: 0, cancelled: false };
    const fetch: HorizonFetch = async () => {
      let i = 0;
      const source = {
        pull(controller: ReadableStreamDefaultController<Uint8Array>) {
          const chunk = chunks[i++];
          seen.pulled += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          seen.cancelled = true;
        },
      };
      // No read ahead: a chunk is pulled only when the gateway asks for it.
      const body = new ReadableStream<Uint8Array>(source, { highWaterMark: 0 });
      return { status: 200, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, body };
    };
    return { fetch, seen };
  }

  it('reads a body in chunks and stops, as an error, once it grows past maxResponseBytes', async () => {
    const chunk = new Uint8Array(400).fill(0x20);
    const { fetch, seen } = streamingFetch(Array.from({ length: 1000 }, () => chunk));
    const gateway = createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      maxResponseBytes: 1_000,
    });
    const error = await gateway.transaction(HASH).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'HorizonResponseTooLargeError', maxResponseBytes: 1_000 });
    // The third chunk passes the cap: the rest is never pulled.
    expect(seen.pulled).toBe(3);
    expect(seen.cancelled).toBe(true);
  });

  it('refuses a body whose Content-Length is over the cap without reading it', async () => {
    const { fetch, seen } = streamingFetch([new TextEncoder().encode('{}')], { 'content-length': '2000000' });
    const gateway = createHorizonGateway({ horizonUrl: TESTNET_HORIZON_URL, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, fetch });
    await expect(gateway.latestLedger()).rejects.toMatchObject({ name: 'HorizonResponseTooLargeError' });
    expect(seen.pulled).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  it('a body over the cap on a lookup is an error, never "not found"', async () => {
    const big = new TextEncoder().encode(JSON.stringify({ hash: HASH, successful: true, pad: 'x'.repeat(2_000) }));
    const { fetch } = streamingFetch([big]);
    const gateway = createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      maxResponseBytes: 1_024,
    });
    await expect(gateway.transaction(HASH)).rejects.toThrow('over 1024 bytes');
  });

  it('reads a body that arrives in several chunks, up to the cap', async () => {
    const text = JSON.stringify({ history_latest_ledger: 9, history_latest_ledger_closed_at: '2026-11-09T12:00:05Z' });
    const bytes = new TextEncoder().encode(text);
    const { fetch } = streamingFetch([bytes.subarray(0, 10), bytes.subarray(10)]);
    const gateway = createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      maxResponseBytes: bytes.byteLength,
    });
    expect(await gateway.latestLedger()).toMatchObject({ sequence: 9 });
  });

  it('stops reading a body that trickles in past requestTimeoutMs', async () => {
    let timer: NodeJS.Timeout | undefined;
    const fetch: HorizonFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hash":"'));
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode('a')), 5);
        },
        cancel() {
          clearInterval(timer);
        },
      }),
    });
    const gateway = createHorizonGateway({
      horizonUrl: TESTNET_HORIZON_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      fetch,
      requestTimeoutMs: 30,
    });
    const started = Date.now();
    await expect(gateway.transaction(HASH)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    clearInterval(timer);
  });

  it('treats a missing account as not found', async () => {
    const { gateway } = gatewayWith({});
    expect(await gateway.account(Keypair.random().publicKey())).toBeNull();
  });

  it('reads an account, its known fields only, with the Latest-Ledger header', async () => {
    const id = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const { gateway } = gatewayWith({
      [`/accounts/${id}`]: {
        headers: { 'Latest-Ledger': '812' },
        body: {
          id,
          sequence: '9223372036854775807',
          subentry_count: 1,
          num_sponsoring: 0,
          balances: [
            { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer, balance: '5.0000000', limit: '922337203685.4775807', is_authorized: true, sponsor: 'x' },
            { asset_type: 'native', balance: '2.5000000', buying_liabilities: '0.0000000' },
          ],
          _links: {},
          signers: [],
        },
      },
    });
    expect(await gateway.account(id)).toEqual({
      id,
      sequence: '9223372036854775807',
      subentry_count: 1,
      num_sponsoring: 0,
      balances: [
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer, balance: '5.0000000', limit: '922337203685.4775807', is_authorized: true },
        { asset_type: 'native', balance: '2.5000000', buying_liabilities: '0.0000000' },
      ],
      latestLedger: 812,
    });
  });

  it('leaves latestLedger out of an account read without a usable Latest-Ledger header', async () => {
    const id = Keypair.random().publicKey();
    const { gateway } = gatewayWith({
      [`/accounts/${id}`]: { headers: { 'Latest-Ledger': 'soon' }, body: { id, sequence: '7', subentry_count: 0, balances: [] } },
    });
    expect(await gateway.account(id)).toEqual({ id, sequence: '7', subentry_count: 0, balances: [] });
  });

  it('refuses an account answer for another account or with fields that are not well formed', async () => {
    const id = Keypair.random().publicKey();
    const good = { id, sequence: '7', subentry_count: 0, balances: [{ asset_type: 'native', balance: '1.0000000' }] };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...good, id: Keypair.random().publicKey() }, 'id'],
      [{ ...good, id: undefined }, 'id'],
      [{ ...good, sequence: 7 }, 'sequence'],
      [{ ...good, sequence: '' }, 'sequence'],
      [{ ...good, sequence: '-1' }, 'sequence'],
      [{ ...good, sequence: '1e3' }, 'sequence'],
      [{ ...good, sequence: '12345678901234567890' }, 'sequence'],
      [{ ...good, subentry_count: -1 }, 'subentry_count'],
      [{ ...good, subentry_count: '1' }, 'subentry_count'],
      [{ ...good, num_sponsored: 1.5 }, 'num_sponsored'],
      [{ ...good, balances: {} }, 'balances'],
      [{ ...good, balances: [null] }, 'balance'],
      [{ ...good, balances: [{ asset_type: 'native', balance: 'lots' }] }, 'balance'],
      [{ ...good, balances: [{ asset_type: 'native', balance: '1.00000001' }] }, 'balance'],
      [{ ...good, balances: [{ asset_type: 'credit_alphanum4', balance: '1', asset_code: 'USDC' }] }, 'balance'],
      [{ ...good, balances: [{ asset_type: 'native', balance: '1', limit: 5 }] }, 'balance'],
      [{ ...good, balances: [{ asset_type: 'native', balance: '1', is_authorized: 'yes' }] }, 'balance'],
    ];
    for (const [body, field] of cases) {
      const { gateway } = gatewayWith({ [`/accounts/${id}`]: { headers: { 'Latest-Ledger': '9' }, body } });
      await expect(gateway.account(id)).rejects.toThrow(`unusable ${field}`);
    }
  });

  it('keeps known payment fields and the joined memo only, and passes the query', async () => {
    const account = Keypair.random().publicKey();
    const { gateway, calls } = gatewayWith({
      [`/accounts/${account}/payments`]: {
        body: {
          _embedded: {
            records: [
              {
                id: '1',
                paging_token: 'p1',
                type: 'payment',
                amount: '1.0000000',
                _links: {},
                transaction: { memo: 'm', memo_type: 'text', envelope_xdr: 'x' },
              },
            ],
          },
        },
      },
    });
    const records = await gateway.paymentsForAccount(account, { cursor: 'p0', limit: 10, order: 'asc' });
    expect(records).toEqual([{ id: '1', paging_token: 'p1', type: 'payment', amount: '1.0000000', memo: 'm', memo_type: 'text' }]);
    const query = new URL(calls[0]?.url ?? '').searchParams;
    expect(Object.fromEntries(query)).toEqual({ order: 'asc', limit: '10', join: 'transactions', cursor: 'p0' });
  });

  it('fails a payments page without records', async () => {
    const account = Keypair.random().publicKey();
    const { gateway } = gatewayWith({ [`/accounts/${account}/payments`]: { body: { _embedded: {} } } });
    await expect(gateway.paymentsForAccount(account, { limit: 10, order: 'asc' })).rejects.toThrow('without records');
  });

  it('treats a submit answer without a hash or result as unavailable', async () => {
    const { gateway } = gatewayWith({}, { submit: async () => ({ ledger: 4 }) });
    expect(await gateway.submitTransaction(signedXdr())).toEqual({ kind: 'unavailable', status: null });
  });

  it('maps a 400 with result codes to a rejection with codes only', async () => {
    const { gateway } = gatewayWith(
      {},
      {
        submit: async () => {
          throw httpError(400, { extras: { result_codes: { transaction: 'tx_bad_seq' }, envelope_xdr: 'AAAA' } });
        },
      },
    );
    expect(await gateway.submitTransaction(signedXdr())).toEqual({
      kind: 'rejected',
      status: 400,
      transactionCode: 'tx_bad_seq',
      operationCodes: [],
    });
  });

  it('maps a 504 to a timeout, a missing response to unavailable and 429 to unavailable', async () => {
    const cases: Array<[unknown, unknown]> = [
      [httpError(504), { kind: 'timeout', status: 504 }],
      [new Error('socket hang up'), { kind: 'unavailable', status: null }],
      [httpError(429), { kind: 'unavailable', status: 429 }],
      [Object.assign(new Error('t'), { code: 'ECONNABORTED' }), { kind: 'timeout' }],
    ];
    for (const [thrown, expected] of cases) {
      const { gateway } = gatewayWith({}, { submit: async () => Promise.reject(thrown) });
      expect(await gateway.submitTransaction(signedXdr())).toEqual(expected);
    }
  });

  it('returns accepted submissions', async () => {
    const { gateway } = gatewayWith({}, { submit: async () => ({ hash: 'h', ledger: 4, successful: true }) });
    expect(await gateway.submitTransaction(signedXdr())).toEqual({ kind: 'accepted', hash: 'h', ledger: 4, successful: true });
  });
});
