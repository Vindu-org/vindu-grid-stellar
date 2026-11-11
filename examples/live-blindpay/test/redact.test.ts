import { createRedactor } from '../src/redact';
import { createReporter } from '../src/report';

// Fake values only, shaped like the real ones.
const KEY = 'bp_test_FAKEKEY0123456789abcdefABCDEF';
const INSTANCE = 'in_FAKE00000000';
const ACCOUNT = `G${'A'.repeat(51)}WXYZ`;
const SEED = `S${'B'.repeat(55)}`;
const HASH = `${'ab'.repeat(30)}1234`;

describe('createRedactor', () => {
  const redact = createRedactor([KEY, INSTANCE, '']);

  it('removes the secrets it was given, wherever they are', () => {
    const out = redact(`Bearer ${KEY} for /v1/instances/${INSTANCE}/payouts and again ${KEY}x`);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(INSTANCE);
    expect(out).toContain('<redacted>');
  });

  it('replaces BlindPay ids with their kind, but keeps status words like on_hold', () => {
    expect(redact('re_abc12345XYZ bw_QWERTY12345 po_00000000aaaa on_hold pending_review auth_required')).toBe(
      '<re_id> <bw_id> <po_id> on_hold pending_review auth_required',
    );
  });

  it('shortens Stellar accounts and hashes, and drops seeds, emails and XDR blobs', () => {
    const blob = 'AAAAAgAAAA'.repeat(20);
    const out = redact(`${ACCOUNT} ${HASH} ${SEED} someone@example.com ${blob}`);
    expect(out).toBe('G...WXYZ #...1234 <secret seed> <email> <blob 200 chars>');
  });
});

describe('createReporter', () => {
  it('redacts every line, counts verdicts and exits 1 on any FAIL', () => {
    const printed: string[] = [];
    const report = createReporter(createRedactor([KEY]), (l) => printed.push(l));
    report.pass('s', `ok ${KEY}`);
    report.finding('s', 'found re_abc12345XYZ');
    expect(report.exitCode()).toBe(0);
    expect(report.check('s', false, 'broke')).toBe(false);
    expect(report.summary()).toEqual({ PASS: 1, FAIL: 1, FINDING: 1 });
    expect(report.exitCode()).toBe(1);
    expect(printed.join('\n')).not.toContain(KEY);
    expect(printed[1]).toBe('FINDING [s] found <re_id>');
  });

  it('exits 1 when nothing passed', () => {
    const report = createReporter(createRedactor([]), () => undefined);
    report.finding('s', 'only a finding');
    expect(report.exitCode()).toBe(1);
  });
});

describe('offline guard', () => {
  it('disables fetch in unit tests', () => {
    expect(() => fetch('https://api.blindpay.com')).toThrow(/offline/);
  });
});
