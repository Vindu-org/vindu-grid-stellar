import { fiat, stellarAsset } from '../src/assets';
import { AssetMismatchError, InvalidMoneyError } from '../src/errors';
import { add, money } from '../src/money';
import { checkPayoutTolerance } from '../src/tolerance';
import { transition } from '../src/transfer-states';

const USD = fiat('USD');
const usd = (a: string) => money(a, USD);

describe('tolerance', () => {
  it('passes a quote within the tolerance', () => {
    expect(checkPayoutTolerance(usd('9500'), usd('9480'), 30)).toEqual({ ok: true, deviationBps: 21.06 });
  });

  it('passes a quote exactly at the boundary, both directions', () => {
    // 0.30% of 10000 = 30.
    expect(checkPayoutTolerance(usd('10000'), usd('9970'), 30)).toEqual({ ok: true, deviationBps: 30 });
    expect(checkPayoutTolerance(usd('10000'), usd('10030'), 30)).toEqual({ ok: true, deviationBps: 30 });
  });

  it('sends a quote just outside the boundary to needs_attention', () => {
    const r = checkPayoutTolerance(usd('10000'), usd('9969.9999999'), 30);
    expect(r).toEqual({ ok: false, deviationBps: 30.01, nextState: 'needs_attention', reason: 'quote_outside_tolerance' });
  });

  it('sends a quote far outside to needs_attention, above or below', () => {
    expect(checkPayoutTolerance(usd('10000'), usd('9800'), 30)).toMatchObject({ ok: false, deviationBps: 200 });
    expect(checkPayoutTolerance(usd('10000'), usd('10200'), 30)).toMatchObject({
      ok: false,
      nextState: 'needs_attention',
    });
  });

  it('has no float error: 0.1 + 0.2 equals 0.3 exactly at zero tolerance', () => {
    // In floats, 0.1 + 0.2 = 0.30000000000000004 and would fail a zero tolerance.
    const quoted = add(usd('0.1'), usd('0.2'));
    expect(checkPayoutTolerance(usd('0.3'), quoted, 0)).toEqual({ ok: true, deviationBps: 0 });
  });

  it('detects the smallest deviation at 7 decimals', () => {
    expect(checkPayoutTolerance(usd('0.3'), usd('0.3000001'), 0).ok).toBe(false);
    expect(checkPayoutTolerance(usd('1000000'), usd('1000000.0000001'), 0).ok).toBe(false);
  });

  it('rejects different assets', () => {
    expect(() => checkPayoutTolerance(usd('100'), money('100', fiat('BRL')), 30)).toThrow(AssetMismatchError);
    const usdc1 = stellarAsset('USDC', `G${'A'.repeat(55)}`);
    const usdc2 = stellarAsset('USDC', `G${'B'.repeat(55)}`);
    expect(() => checkPayoutTolerance(money('1', usdc1), money('1', usdc2), 30)).toThrow(AssetMismatchError);
  });

  it('never accepts a zero or negative quote, even with a huge tolerance', () => {
    expect(checkPayoutTolerance(usd('1'), usd('0'), 30)).toMatchObject({ ok: false, nextState: 'needs_attention' });
    expect(checkPayoutTolerance(usd('1'), usd('-1'), 30_000)).toMatchObject({ ok: false, deviationBps: 20000 });
    expect(checkPayoutTolerance(usd('1'), usd('0'), 1_000_000)).toMatchObject({ ok: false });
  });

  it('rejects a non-positive estimate and a bad tolerance', () => {
    expect(() => checkPayoutTolerance(usd('0'), usd('1'), 30)).toThrow(InvalidMoneyError);
    expect(() => checkPayoutTolerance(usd('1'), usd('1'), -1)).toThrow(RangeError);
    expect(() => checkPayoutTolerance(usd('1'), usd('1'), 0.3)).toThrow(RangeError);
  });
});

describe('tolerance and the transition table', () => {
  it('names a reason the table accepts for its next state', () => {
    const r = checkPayoutTolerance(usd('10000'), usd('9000'), 30);
    if (r.ok) throw new Error('expected a miss');
    expect(transition('funded', r.nextState, r.reason)).toMatchObject({ label: 'quote outside tolerance' });
  });
});
