// Offline: the world's fetch is a fake, and test/offline.cjs disables the global one.
import { GridError } from '@vindu/grid-core';

import { createRedactor } from '../src/redact';
import { createReporter } from '../src/report';
import { describeError } from '../src/step-payout';
import { createWorld } from '../src/world';

// Fake values only, shaped like the real ones.
const KEY = 'bp_test_FAKEKEY0123456789abcdefABCDEF';
const INSTANCE = 'in_FAKE0000WXYZ';
const PAYIN = 'pi_Q1w2E3r4T5y6';
const EMAIL = 'someone@example.com';

/** A world whose BlindPay always answers 500 with a body full of instance values. */
function world() {
  const printed: string[] = [];
  const redact = createRedactor([KEY, INSTANCE]);
  const print = (line: string) => printed.push(redact(line));
  const report = createReporter(redact, print);
  const body = JSON.stringify({ message: `customer ${EMAIL} wallet bw_Zz99Yy88 instance ${INSTANCE}` });
  const fetch = (async () => new Response(body, { status: 500, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
  const w = createWorld({
    env: { apiKey: KEY, instanceId: INSTANCE, payinWaitMs: 0 },
    report,
    redact,
    fetch,
    print,
    now: () => Date.parse('2026-11-11T03:00:00Z'),
    sleep: async () => undefined,
  });
  return { w, printed, report };
}

/** Every instance value that must never be printed. */
const LEAKS = [KEY, INSTANCE, INSTANCE.slice(3), INSTANCE.toUpperCase(), PAYIN, EMAIL, 'bw_Zz99Yy88'];

function expectNoLeak(text: string): void {
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

describe('createWorld output paths', () => {
  it('redacts what the logger prints', () => {
    const { w, printed } = world();
    w.logger.warn(`failed for ${PAYIN}`, { instance: INSTANCE, bare: INSTANCE.slice(3), email: EMAIL, wallet: 'bw_Zz99Yy88_x' });
    w.logger.error('again', { upper: INSTANCE.toUpperCase(), key: KEY });
    expect(printed).toHaveLength(2);
    expectNoLeak(printed.join('\n'));
    expect(printed[0]).toContain('<pi_id>');
  });

  it("redacts the client's own logger and onCall lines for a failed call", async () => {
    const { w, printed } = world();
    await expect(w.client.payins.get(PAYIN)).rejects.toThrow();
    expect(printed.some((l) => l.includes('call GET'))).toBe(true);
    expect(printed.some((l) => l.includes('warn'))).toBe(true);
    expectNoLeak(printed.join('\n'));
  });
});

describe('describeError', () => {
  class FakePartnerError extends GridError {
    readonly stage = `create ${PAYIN}`;
    readonly causeCode = INSTANCE;
    readonly status = 500;
    readonly partnerCode = 'po_Ab12Cd34';
    constructor() {
      super('partner_http_error', `message with ${EMAIL} and ${INSTANCE}`);
    }
  }

  it('never carries the message, and what it carries is redacted when printed', () => {
    const described = describeError(new FakePartnerError());
    expect(described).not.toContain(EMAIL);
    const { report, printed } = world();
    report.fail('run', `Stopped with ${described}`);
    expectNoLeak(printed.join('\n'));
    expect(printed[0]).toContain('HTTP 500');
    expect(printed[0]).toContain('<po_id>');
  });

  it('gives only the class name of an error that is not a GridError', () => {
    const plain = new Error(`boom ${EMAIL} ${INSTANCE}`);
    expect(describeError(plain)).toBe('Error');
    expect(describeError('raw string')).toBe('string');
  });
});
