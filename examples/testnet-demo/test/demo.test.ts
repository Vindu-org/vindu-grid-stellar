import { runBlindPayDryRun } from '../src/blindpay-dry-run';
import { runDemo } from '../src/demo';

const FULL_PATH = [
  'quoted',
  'awaiting_pix',
  'funding',
  'funded',
  'payout_quoted',
  'awaiting_signature',
  'payout_submitted',
  'payout_processing',
  'completed',
];

describe('testnet demo', () => {
  it('runs the whole two-leg transfer offline and reaches completed', async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (line) => lines.push(line) });

    expect(result.finalState).toBe('completed');
    expect(result.history).toEqual(FULL_PATH);
    expect(result.route.route).toEqual({ partner: 'mock-partner', chain: 'stellar' });
    expect(result.route.reason).toBe('stellar_priority');
    expect(result.payoutTxHash).toMatch(/^[0-9a-f]{64}$/);

    const output = lines.join('\n');
    expect(output).toContain('signer refused (asked to sign before awaiting_signature)');
    expect(output).toContain('signer refused (XDR that pays another account): The payment destination is not the expected destination');
    expect(output).toContain('then signed once');
    expect(output).toContain('checking the hash (timeout)');
    expect(output).toContain('submit: success');
    expect(output).toContain('1 submission(s), 1 hash lookup(s), no second signature');
    expect(output).toContain('awaiting_signature -> payout_submitted (signed and on chain)');
    expect(output).toMatch(/matched demo-transfer-1\/payout on .*tx_hash, reference/);
  });

  it('completes without the simulated Horizon timeout too', async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (line) => lines.push(line), simulateHorizonTimeout: false });

    expect(result.finalState).toBe('completed');
    expect(lines.join('\n')).toContain('1 submission(s), 0 hash lookup(s)');
  });

  it('stops in needs_attention, without creating the payout, when Horizon refuses the submission', async () => {
    const lines: string[] = [];
    const result = await runDemo({
      log: (line) => lines.push(line),
      simulateHorizonTimeout: false,
      simulateSubmitRejection: true,
    });

    expect(result.finalState).toBe('needs_attention');
    expect(result.history).toEqual([...FULL_PATH.slice(0, FULL_PATH.indexOf('awaiting_signature') + 1), 'needs_attention']);
    expect(result.payoutTxHash).toBeUndefined();
    const output = lines.join('\n');
    expect(output).toContain('submit: rejected');
    expect(output).toContain('awaiting_signature -> needs_attention (submission rejected or outcome unknown)');
    expect(output).toContain('do not sign again');
    expect(output).not.toContain('accepted payout');
  });

  it('stops in needs_attention from payout_quoted, with nothing signed, when the partner refuses to authorize', async () => {
    const lines: string[] = [];
    const result = await runDemo({
      log: (line) => lines.push(line),
      simulateHorizonTimeout: false,
      simulateAuthorizationFailure: true,
    });

    expect(result.finalState).toBe('needs_attention');
    expect(result.history).toEqual([...FULL_PATH.slice(0, FULL_PATH.indexOf('payout_quoted') + 1), 'needs_attention']);
    expect(result.history).not.toContain('awaiting_signature');
    expect(result.payoutTxHash).toBeUndefined();
    const output = lines.join('\n');
    expect(output).toContain(
      "payout_quoted -> needs_attention (authorization failed): The partner's payout authorization failed " +
        '(authorization_refused): nothing was signed',
    );
    expect(output).not.toContain('submission rejected or outcome unknown');
    expect(output).not.toContain('then signed once');
    expect(output).not.toContain('submit:');
    expect(output).not.toContain('accepted payout');
  });
});

describe('BlindPay dry run', () => {
  it('runs the BlindPay client against a mocked fetch, with no network', async () => {
    const lines: string[] = [];
    const result = await runBlindPayDryRun((line) => lines.push(line));

    expect(result.requests).toEqual([
      'POST /payin-quotes',
      'POST /payins/evm',
      'POST /quotes',
      'POST /payouts/stellar/authorize',
      'POST /payouts/stellar',
    ]);
    expect(result.payoutId).toBe('po_demo1');
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    const output = lines.join('\n');
    expect(output).toContain('payout_quoted -> awaiting_signature (signed payout flow): BlindPay authorized, stored before signing');
    expect(output).toContain('payout po_demo1 created after a confirmed submit');
    expect(output).not.toContain('dry-run-placeholder');
  });
});
