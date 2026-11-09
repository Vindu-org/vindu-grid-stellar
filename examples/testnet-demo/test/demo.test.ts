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
    expect(output).toContain('signer refused (XDR that pays another account)');
    expect(output).toContain('checking the hash (timeout)');
    expect(output).toContain('1 submission(s), 1 hash lookup(s)');
    expect(output).toMatch(/matched demo-transfer-1\/payout on .*tx_hash, reference/);
  });

  it('completes without the simulated Horizon timeout too', async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (line) => lines.push(line), simulateHorizonTimeout: false });

    expect(result.finalState).toBe('completed');
    expect(lines.join('\n')).toContain('1 submission(s), 0 hash lookup(s)');
  });
});
