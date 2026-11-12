import { EnvError, readLiveEnv } from '../src/env';
import { pacedFetch, retryAfterMs } from '../src/pacer';

/** A fake clock whose sleep moves time forward. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('pacedFetch', () => {
  it('starts at most maxPerMinute requests in any 60 s window', async () => {
    const c = clock();
    const seen: number[] = [];
    const fetch = pacedFetch(async () => {
      seen.push(c.now());
      return new Response('{}', { status: 200 });
    }, { maxPerMinute: 2, now: c.now, sleep: c.sleep });
    await Promise.all([fetch('u', {}), fetch('u', {}), fetch('u', {})]);
    expect(seen).toEqual([1_000_000, 1_000_000, 1_060_000]);
    expect(fetch.requests()).toBe(3);
  });

  it('retries a 429 with the very same request after Retry-After', async () => {
    const c = clock();
    const inits: RequestInit[] = [];
    const replies = [new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('{"ok":true}', { status: 200 })];
    const fetch = pacedFetch(async (_url, init) => {
      inits.push(init);
      return replies.shift() as Response;
    }, { maxPerMinute: 30, now: c.now, sleep: c.sleep });
    const init = { method: 'POST', headers: { 'Idempotency-Key': 'k-1' }, body: '{"a":1}' };
    const res = await fetch('u', init);
    expect(res.status).toBe(200);
    expect(c.waits).toEqual([7000]);
    expect(inits).toEqual([init, init]);
  });

  it('gives the 429 back after maxRetries', async () => {
    const c = clock();
    const fetch = pacedFetch(async () => new Response('', { status: 429 }), { maxPerMinute: 30, maxRetries: 1, now: c.now, sleep: c.sleep });
    expect((await fetch('u', {})).status).toBe(429);
    expect(c.waits).toEqual([10_000]);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});

describe('readLiveEnv', () => {
  const base = { BLINDPAY_API_KEY: 'bp_fake_key', BLINDPAY_INSTANCE_ID: 'in_FAKE0000' };

  it('reads the required values and the defaults', () => {
    expect(readLiveEnv(base)).toEqual({ apiKey: 'bp_fake_key', instanceId: 'in_FAKE0000', payinWaitMs: 300_000 });
    expect(readLiveEnv({ ...base, BLINDPAY_PAYIN_WAIT_SEC: '5', BLINDPAY_BASE_URL: 'http://localhost:1' })).toMatchObject({
      payinWaitMs: 5000, baseUrl: 'http://localhost:1',
    });
  });

  it('names a missing or malformed variable without echoing values', () => {
    expect(() => readLiveEnv({})).toThrow(EnvError);
    expect(() => readLiveEnv({ BLINDPAY_API_KEY: 'k' })).toThrow('BLINDPAY_INSTANCE_ID is not set');
    let message = '';
    try {
      readLiveEnv({ ...base, BLINDPAY_INSTANCE_ID: 'secret-looking-value' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('BLINDPAY_INSTANCE_ID');
    expect(message).not.toContain('secret-looking-value');
    expect(() => readLiveEnv({ ...base, BLINDPAY_PAYOUT_DESTINATION: 'not-an-account' })).toThrow(EnvError);
    expect(() => readLiveEnv({ ...base, BLINDPAY_PAYIN_WAIT_SEC: '-1' })).toThrow(EnvError);
  });
});
