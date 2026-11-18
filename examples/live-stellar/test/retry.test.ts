import { waitFor, withRetry } from '../src/retry';

const noSleep = jest.fn(async (_ms: number) => undefined);

describe('withRetry', () => {
  it('returns the first success', async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { attempts: 5, delayMs: 100, sleep: noSleep },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('gives up after the bounded number of attempts with the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`failure ${calls}`);
        },
        { attempts: 3, delayMs: 10, maxDelayMs: 15, sleep: noSleep },
      ),
    ).rejects.toThrow('failure 3');
    expect(calls).toBe(3);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([10, 15]);
  });

  it('does not retry an error that is not retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('fatal');
        },
        { attempts: 5, delayMs: 10, sleep: noSleep, retryable: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('refuses fewer than one attempt', async () => {
    await expect(withRetry(async () => 1, { attempts: 0, delayMs: 1, sleep: noSleep })).rejects.toThrow(RangeError);
  });
});

describe('waitFor', () => {
  it('returns the first defined value', async () => {
    const value = await waitFor(async (attempt) => (attempt === 2 ? attempt : undefined), {
      attempts: 4,
      intervalMs: 50,
      sleep: noSleep,
    });
    expect(value).toBe(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
  });

  it('returns undefined after the bounded number of checks', async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        calls += 1;
        return undefined;
      },
      { attempts: 3, intervalMs: 50, sleep: noSleep },
    );
    expect(value).toBeUndefined();
    expect(calls).toBe(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });
});
