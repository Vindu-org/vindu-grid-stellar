import { createHmac, randomBytes } from 'node:crypto';

import { GridError } from '@vindu/grid-core';

import { WebhookVerificationError, parseWebhookEvent, verifyWebhook } from '../src/webhooks';

// Vector built here with node crypto, following the Svix scheme.
const KEY = randomBytes(24);
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW_MS = 1_800_000_000_000;
const TS = String(NOW_MS / 1000);
const ID = 'msg_000000000000';
const BODY = '{"webhook_event":"payout.update","id":"po_000000000000","status":"failed"}';

function sign(body: string | Buffer, key = KEY, id = ID, ts = TS): string {
  return createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64');
}

function headers(sig = `v1,${sign(BODY)}`, extra: Record<string, string> = {}): Record<string, string> {
  return { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': sig, ...extra };
}

const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
  verifyWebhook({ rawBody: BODY, headers: headers(), secret: SECRET, now: () => NOW_MS, ...over });

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookVerificationError);
    expect(e).toBeInstanceOf(GridError);
    expect((e as GridError).code).toBe('webhook_rejected');
    expect((e as Error).message).not.toContain(KEY.toString('base64'));
    return (e as WebhookVerificationError).reason;
  }
  throw new Error('expected a rejection');
}

describe('webhook verification', () => {
  it('accepts a valid signature and returns svix-id as the dedupe key', () => {
    expect(verify()).toEqual({ eventId: ID, timestamp: Number(TS) });
  });

  it('accepts raw bytes, a Headers object and mixed-case header names', () => {
    expect(verify({ rawBody: new TextEncoder().encode(BODY) }).eventId).toBe(ID);
    expect(verify({ headers: new Headers(headers()) }).eventId).toBe(ID);
    const upper = { 'Svix-Id': ID, 'SVIX-TIMESTAMP': TS, 'Svix-Signature': `v1,${sign(BODY)}` };
    expect(verify({ headers: upper }).eventId).toBe(ID);
  });

  it('rejects a tampered body', () => {
    expect(reason(() => verify({ rawBody: BODY.replace('failed', 'completed') }))).toBe('signature_mismatch');
    // Re-serialised JSON is a different byte string, so it fails too.
    expect(reason(() => verify({ rawBody: JSON.stringify(JSON.parse(BODY), null, 1) }))).toBe('signature_mismatch');
  });

  it('rejects a wrong secret', () => {
    expect(reason(() => verify({ secret: `whsec_${randomBytes(24).toString('base64')}` }))).toBe('signature_mismatch');
  });

  it.each(['', 'whsec_', 'not-a-secret', 'whsec_***'])('rejects a malformed secret %p', (secret) => {
    expect(reason(() => verify({ secret }))).toBe('bad_secret');
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('rejects missing header %s', (name) => {
    const h = headers();
    delete h[name];
    expect(reason(() => verify({ headers: h }))).toBe('missing_headers');
    expect(reason(() => verify({ headers: { ...headers(), [name]: '  ' } }))).toBe('missing_headers');
  });

  it.each(['abc', '1.5', '-1'])('rejects a non-numeric timestamp %p', (ts) => {
    expect(reason(() => verify({ headers: { ...headers(), 'svix-timestamp': ts } }))).toBe('bad_timestamp');
  });

  it('rejects stale and future timestamps beyond the tolerance, in both directions', () => {
    const at = (ts: number) => ({ ...headers(`v1,${sign(BODY, KEY, ID, String(ts))}`), 'svix-timestamp': String(ts) });
    const t = Number(TS);
    expect(verify({ headers: at(t - 300) }).timestamp).toBe(t - 300);
    expect(verify({ headers: at(t + 300) }).timestamp).toBe(t + 300);
    expect(reason(() => verify({ headers: at(t - 301) }))).toBe('stale');
    expect(reason(() => verify({ headers: at(t + 301) }))).toBe('stale');
    expect(reason(() => verify({ headers: at(t - 60), toleranceSec: 30 }))).toBe('stale');
  });

  it('accepts when one of several signatures is valid', () => {
    const wrong = sign(BODY, randomBytes(24));
    expect(verify({ headers: headers(`v1,${wrong} v1,${sign(BODY)}`) }).eventId).toBe(ID);
    expect(verify({ headers: headers(`v1,short v1,${sign(BODY)}`) }).eventId).toBe(ID);
  });

  it('ignores non-v1 versions, even with a correct digest', () => {
    expect(reason(() => verify({ headers: headers(`v2,${sign(BODY)} v1a,${sign(BODY)}`) }))).toBe('signature_mismatch');
    expect(reason(() => verify({ headers: headers(`v2,${sign(BODY)} v1,${sign('x')}`) }))).toBe('signature_mismatch');
  });

  it('rejects a signature of the wrong length without throwing a crypto error', () => {
    expect(reason(() => verify({ headers: headers('v1,AAAA') }))).toBe('signature_mismatch');
  });
});

describe('webhook parsing', () => {
  it('types payin and payout events and keeps status as the outcome', () => {
    const e = parseWebhookEvent(BODY);
    expect(e).toEqual({ kind: 'payout', event: 'payout.update', payout: { id: 'po_000000000000', status: 'failed' } });
    const p = parseWebhookEvent('{"webhook_event":"payin.complete","id":"pi_000000000000","status":"refunded"}');
    expect(p.kind === 'payin' && p.payin.status).toBe('refunded');
  });

  it('types customer and wallet events and passes unknown ones through as other', () => {
    expect(parseWebhookEvent('{"webhook_event":"customer.update","id":"re_000000000000","kyc_status":"approved"}').kind).toBe('customer');
    expect(parseWebhookEvent('{"webhook_event":"blockchainWallet.new","id":"bw_000000000000"}').kind).toBe('blockchain_wallet');
    expect(parseWebhookEvent('{"webhook_event":"virtualAccount.new"}')).toEqual({ kind: 'other', event: 'virtualAccount.new' });
  });

  it.each(['not json', '[]', '{}', '{"webhook_event":"payout.update","id":"po_1"}'])('rejects malformed body %p', (raw) => {
    expect(reason(() => parseWebhookEvent(raw))).toBe('malformed_body');
  });
});
