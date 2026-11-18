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

  it('removes the instance id without its prefix, and in another letter case', () => {
    const out = redact(`instance FAKE00000000, upper ${INSTANCE.toUpperCase()}, key ${KEY.toLowerCase()}`);
    expect(out).toBe('instance <redacted>, upper <redacted>, key <redacted>');
  });

  it('catches ids followed by _, short ids, dashed and upper-case forms', () => {
    expect(redact('re_abc12345XYZ_ po_Ab12_x bw_1234 pi_aB3d')).toBe('<re_id>_ <po_id>_x <bw_id> <pi_id>');
    expect(redact('RE_ABC12345 Po_Q1w2e3 re-ABC12345 PO-1234 bw-Zz99')).toBe('<re_id> <po_id> <re_id> <po_id> <bw_id>');
  });

  it('catches unknown two- and three-letter prefixes followed by an id-shaped token', () => {
    expect(redact('cus_Q1w2E3r4 xy_1234 abc_AbCd (zz_9a8b7c)')).toBe('<cus_id> <xy_id> <abc_id> (<zz_id>)');
  });

  it('keeps status words, result codes, error codes and prose', () => {
    const kept =
      'on_hold pending_review auth_required tx_bad_seq op_underfunded idempotency_key_in_flight ' +
      'REQUEST_REJECTED VALIDATION_INVALID_REQUEST transaction_xdr_invalid re-quote re-sign in-memory';
    expect(redact(kept)).toBe(kept);
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
