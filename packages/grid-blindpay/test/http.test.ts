import { type AddressInfo } from 'node:net';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { InvalidConfigError, PartnerHttpError } from '@vindu/grid-core';

import { resolveConfig } from '../src/config';
import type { BlindPayHttpError } from '../src/errors';
import { createBlindPayHttp, parseRetryAfter, readErrorBody } from '../src/http';
import { API_KEY, INSTANCE_ID, captureOutput, caught, config, dumpError, mockFetch } from './helpers';

describe('client http', () => {
  it('sends Bearer auth and JSON to the instance path', async () => {
    const { fetch, calls } = mockFetch([{ body: { id: 're_1' } }]);
    const http = createBlindPayHttp(config(fetch));
    const res = await http.request<{ id: string }>({ method: 'GET', path: '/customers/re_1', query: { limit: 5, x: undefined } });
    expect(res.data).toEqual({ id: 're_1' });
    expect(calls[0]?.url).toBe(`https://api.blindpay.com/v1/instances/${INSTANCE_ID}/customers/re_1?limit=5`);
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers['Idempotency-Key']).toBeUndefined();
  });

  it('sends the caller Idempotency-Key on POST and reports replays', async () => {
    const { fetch, calls } = mockFetch([{ body: { id: 'pi_1' }, headers: { 'Idempotency-Replayed': 'true' } }]);
    const http = createBlindPayHttp(config(fetch));
    const res = await http.request({ method: 'POST', path: '/payins/evm', body: { a: 1 }, idempotencyKey: 'key-1' });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ a: 1 });
    expect(res).toMatchObject({ idempotencyKey: 'key-1', replayed: true });
  });

  it('generates and returns an Idempotency-Key on every POST and DELETE without one', async () => {
    const { fetch, calls } = mockFetch([{ body: {} }, { body: {} }, { status: 500 }]);
    const http = createBlindPayHttp(config(fetch));
    const a = await http.request({ method: 'POST', path: '/quotes', body: {} });
    const b = await http.request({ method: 'DELETE', path: '/partner-fees/pf_1' });
    const err = await caught(http.request({ method: 'POST', path: '/quotes', body: {} }));
    expect(a.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.headers['Idempotency-Key']).toBe(a.idempotencyKey);
    expect(calls[1]?.headers['Idempotency-Key']).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    // On failure the generated key comes back on the error, so a retry can reuse it.
    expect((err as BlindPayHttpError).idempotencyKey).toBe(calls[2]?.headers['Idempotency-Key']);
  });

  it('reports each call with a templated path and ids, never a body', async () => {
    const out = captureOutput();
    const { fetch } = mockFetch([{ body: { secret: 'resp' } }]);
    let t = 1000;
    const http = createBlindPayHttp(config(fetch, { onCall: out.onCall, now: () => (t += 5) }));
    await http.request({ method: 'POST', path: '/customers/re_9/blockchain-wallets', body: { address: 'G' } });
    expect(out.calls).toEqual([
      {
        partner: 'blindpay',
        method: 'POST',
        path: '/v1/instances/{in_id}/customers/{re_id}/blockchain-wallets',
        status: 200,
        durationMs: 5,
        ids: { instance: INSTANCE_ID, customer: 're_9' },
      },
    ]);
  });

  it.each([
    [409, { code: 'idempotency_key_in_flight' }, 'idempotency_key_in_flight', true],
    [409, { code: 'self_custody_already_set' }, 'self_custody_already_set', false],
    [422, { error: 'idempotency_key_payload_mismatch' }, 'idempotency_key_payload_mismatch', false],
    [400, { message: 'self_custody_required' }, 'self_custody_required', false],
    [404, { error: { code: 'customer_not_found', message: 'Customer not found' } }, 'customer_not_found', false],
    [429, { code: 'development_instance_rate_limit_exceeded' }, 'development_instance_rate_limit_exceeded', true],
    [503, undefined, undefined, true],
  ])('maps HTTP %p %j to a typed error', async (status, body, code, retryable) => {
    const { fetch } = mockFetch([{ status, ...(body === undefined ? {} : { body }), headers: { 'Retry-After': '3' } }]);
    const http = createBlindPayHttp(config(fetch));
    const e = (await caught(http.request({ method: 'POST', path: '/payouts/stellar', body: {}, idempotencyKey: 'k' }))) as BlindPayHttpError;
    expect(e).toBeInstanceOf(PartnerHttpError);
    expect(e).toMatchObject({ partner: 'blindpay', status, partnerCode: code, retryable, retryAfterMs: 3000, idempotencyKey: 'k' });
    expect(e.path).toBe('/v1/instances/{in_id}/payouts/stellar');
  });

  it('keeps a non-JSON error body as a capped snippet', async () => {
    const { fetch } = mockFetch([{ status: 502, text: 'x'.repeat(1000) }]);
    const e = (await caught(createBlindPayHttp(config(fetch)).request({ method: 'GET', path: '/x' }))) as BlindPayHttpError;
    expect(e.bodySnippet?.length).toBeLessThanOrEqual(259);
    expect(e.partnerCode).toBeUndefined();
  });

  it('times out with a retryable error and no status', async () => {
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const out = captureOutput();
    const http = createBlindPayHttp(config(fetch, { timeoutMs: 20, onCall: out.onCall }));
    const e = (await caught(http.request({ method: 'POST', path: '/payouts/stellar', body: {} }))) as BlindPayHttpError;
    expect(e).toMatchObject({ status: null, partnerCode: 'timeout', retryable: true });
    expect(e.idempotencyKey).toBeDefined();
    expect(out.calls[0]).toMatchObject({ status: null, error: 'timeout' });
  });

  it('maps a network failure to a retryable error', async () => {
    const fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const e = (await caught(createBlindPayHttp(config(fetch)).request({ method: 'GET', path: '/x' }))) as BlindPayHttpError;
    expect(e).toMatchObject({ status: null, partnerCode: 'network', retryable: true });
  });

  it('refuses a 2xx body that is not JSON, without marking it retryable', async () => {
    const { fetch } = mockFetch([{ text: '<html>' }]);
    const e = (await caught(createBlindPayHttp(config(fetch)).request({ method: 'POST', path: '/x', body: {} }))) as BlindPayHttpError;
    expect(e).toMatchObject({ status: 200, partnerCode: 'invalid_json', retryable: false });
  });

  it('never exposes the API key in errors, logs or onCall payloads', async () => {
    const out = captureOutput();
    const { fetch } = mockFetch([
      { status: 401, body: { message: 'unauthorized' } },
      { status: 500, text: 'boom' },
      { status: 409, body: { code: 'idempotency_key_in_flight' } },
      { body: { ok: true } },
    ]);
    const http = createBlindPayHttp(config(fetch, { logger: out.logger, onCall: out.onCall }));
    const errors = [
      await caught(http.request({ method: 'GET', path: '/customers/re_1' })),
      await caught(http.request({ method: 'POST', path: '/quotes', body: { a: 1 } })),
      await caught(http.request({ method: 'POST', path: '/quotes', body: { a: 1 } })),
    ];
    await http.request({ method: 'GET', path: '/x' });
    const configErrors = [
      (() => { try { resolveConfig({ apiKey: API_KEY, instanceId: API_KEY }); } catch (e) { return e; } })(),
      (() => { try { resolveConfig({ apiKey: `${API_KEY} x`, instanceId: INSTANCE_ID }); } catch (e) { return e; } })(),
    ];
    const everything = [...errors, ...configErrors].map(dumpError).join('\n') + out.lines.join('\n') + JSON.stringify(http);
    expect(out.lines.length).toBeGreaterThan(0);
    expect(configErrors.every((e) => e instanceof InvalidConfigError)).toBe(true);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain('SECRET_KEY');
  });
});

describe('client redirects', () => {
  const servers: Server[] = [];
  const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
    new Promise<number>((resolve) => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('does not follow a 307, so the body is never sent to the new location', async () => {
    const stolen: string[] = [];
    const evilPort = await listen((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        stolen.push(`${req.method} ${String(req.headers.authorization)} ${body}`);
        res.end('{"id":"re_1"}');
      });
    });
    const apiPort = await listen((req, res) => {
      req.resume();
      res.writeHead(307, { location: `http://127.0.0.1:${evilPort}/steal` });
      res.end();
    });
    const sent: RequestInit[] = [];
    const fetchSpy = (url: string, init: RequestInit) => {
      sent.push(init);
      return fetch(url, init);
    };
    const http = createBlindPayHttp({ apiKey: API_KEY, instanceId: INSTANCE_ID, baseUrl: `http://127.0.0.1:${apiPort}`, fetch: fetchSpy });
    const e = await caught(http.request({ method: 'POST', path: '/customers', body: { tax_id: '000.000.000-00' }, idempotencyKey: 'k' }));
    expect(e).toBeInstanceOf(PartnerHttpError);
    expect(sent[0]?.redirect).toBe('error');
    expect(stolen).toEqual([]);
  });

  it('treats a 3xx from a fetch that ignores the redirect option as a failure', async () => {
    const { fetch } = mockFetch([{ status: 307, headers: { location: 'https://elsewhere.example/x' } }]);
    const e = await caught(createBlindPayHttp(config(fetch)).request({ method: 'GET', path: '/x' }));
    expect(e).toMatchObject({ status: 307 });
  });
});

describe('client config', () => {
  it.each([
    [{ instanceId: 'bad' }, /instanceId/],
    [{ apiKey: '' }, /apiKey/],
    [{ baseUrl: 'ftp://x' }, /https/],
    [{ baseUrl: 'https://x?y=1' }, /query/],
    [{ timeoutMs: 0 }, /timeoutMs/],
  ])('rejects %j', (override, msg) => {
    expect(() => resolveConfig({ apiKey: API_KEY, instanceId: INSTANCE_ID, ...override })).toThrow(msg);
  });

  it.each([
    'http://attacker.example',
    'http://127.0.0.1.attacker.example',
    'http://localhost.attacker.example',
    'http://10.0.0.1',
    'http://[::ffff:7f00:1]',
  ])('refuses plain http to the non-loopback host %s', (baseUrl) => {
    expect(() => resolveConfig({ apiKey: API_KEY, instanceId: INSTANCE_ID, baseUrl })).toThrow(InvalidConfigError);
  });

  it.each(['http://localhost:4010', 'http://LOCALHOST', 'http://127.0.0.1:8080', 'http://127.9.8.7', 'http://[::1]:4010', 'https://api.example.org'])(
    'accepts %s',
    (baseUrl) => {
      expect(resolveConfig({ apiKey: API_KEY, instanceId: INSTANCE_ID, baseUrl }).resolved.baseUrl).toBe(baseUrl.toLowerCase());
    },
  );

  it('uses a custom base URL without a trailing slash', async () => {
    const { fetch, calls } = mockFetch([{ body: [] }]);
    await createBlindPayHttp(config(fetch, { baseUrl: 'http://localhost:4010/' })).request({ method: 'GET', path: '/x' });
    expect(calls[0]?.url).toBe(`http://localhost:4010/v1/instances/${INSTANCE_ID}/x`);
  });
});

describe('client error body parsing', () => {
  it('reads code, error and message fields best-effort', () => {
    expect(readErrorBody('{"code":"a_b","message":"Nice text"}')).toEqual({ code: 'a_b', snippet: 'Nice text' });
    expect(readErrorBody('{"message":"Not a code: spaces"}')).toEqual({ snippet: 'Not a code: spaces' });
    expect(readErrorBody('[1]')).toEqual({ snippet: '[1]' });
    expect(readErrorBody('')).toEqual({});
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7', 0)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
