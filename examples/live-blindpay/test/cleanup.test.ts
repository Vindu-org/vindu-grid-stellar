// Offline: the client is a fake that records the request, never a network call.
import type { BlindPayClient } from '@vindu/grid-blindpay';

import { createRedactor } from '../src/redact';
import { createReporter } from '../src/report';
import { cleanUpWallet } from '../src/step-setup';
import type { Found } from '../src/world';

function setup(request: (options: { method: string; path: string }) => Promise<unknown>, found: Found) {
  const calls: Array<{ method: string; path: string }> = [];
  const client = {
    http: {
      request: async (options: { method: string; path: string }) => {
        calls.push(options);
        return request(options);
      },
    },
  } as unknown as BlindPayClient;
  const report = createReporter(createRedactor([]), () => undefined);
  return { w: { client, report, found }, calls, report };
}

const ACCOUNT = `G${'A'.repeat(55)}`;
const registered: Found = { customerId: 're_000000000001', account: { chain: 'stellar', address: ACCOUNT, partnerAccountId: 'bw_000000000001' } };

describe('cleanUpWallet', () => {
  it('deletes the wallet the run registered', async () => {
    const { w, calls, report } = setup(async () => ({ data: {} }), registered);
    await cleanUpWallet(w);
    expect(calls).toEqual([{ method: 'DELETE', path: '/customers/re_000000000001/blockchain-wallets/bw_000000000001' }]);
    expect(report.summary()).toEqual({ PASS: 1, FAIL: 0, FINDING: 0 });
  });

  it('reports a failed delete as a FINDING and never throws', async () => {
    const { w, report } = setup(async () => {
      throw new Error('HTTP 500');
    }, registered);
    await expect(cleanUpWallet(w)).resolves.toBeUndefined();
    expect(report.summary()).toEqual({ PASS: 0, FAIL: 0, FINDING: 1 });
  });

  it('does nothing when no wallet was registered', async () => {
    const { w, calls, report } = setup(async () => ({ data: {} }), { customerId: 're_000000000001' });
    await cleanUpWallet(w);
    expect(calls).toEqual([]);
    expect(report.lines).toEqual([]);
  });
});
