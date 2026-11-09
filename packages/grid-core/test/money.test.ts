import { fiat, stellarAsset } from '../src/assets';
import { AssetMismatchError, InvalidMoneyError } from '../src/errors';
import {
  add,
  compare,
  equals,
  exceedsBps,
  fromMinorUnits,
  isValidAmount,
  money,
  parseAmount,
  relativeDifferenceBps,
  sub,
  toMinorUnits,
} from '../src/money';

const BRL = fiat('BRL');
const USD = fiat('USD');
const ISSUER_A = `G${'A'.repeat(55)}`;
const ISSUER_B = `G${'B'.repeat(55)}`;

describe('money', () => {
  describe('parsing', () => {
    it.each(['0', '1', '10.5', '0.0000001', '-3.25', '123456789.1234567'])('accepts %s', (a) => {
      expect(isValidAmount(a)).toBe(true);
      expect(() => parseAmount(a)).not.toThrow();
    });

    it.each([
      '', '.5', '1.', '+1', '01', '1e5', ' 1', '1 ', '1,5', '0.12345678', 'NaN', '--1', '1.2.3',
      // From a review probe: other digit systems, separators, hex and trailing newlines.
      '\u0661\u0662\u0663', '00.5', '1_000', '1\n', '0x10', 'Infinity', '-Infinity', '0.00000001',
    ])(
      'rejects %p',
      (a) => {
        expect(isValidAmount(a)).toBe(false);
        expect(() => parseAmount(a)).toThrow(InvalidMoneyError);
      },
    );

    it('rejects absurdly large amounts', () => {
      expect(() => parseAmount('1'.repeat(31))).toThrow(InvalidMoneyError);
    });

    it('rejects non-string input at runtime', () => {
      expect(() => parseAmount(0.3 as unknown as string)).toThrow(InvalidMoneyError);
    });

    it('canonicalises amounts', () => {
      expect(money('10.50', USD).amount).toBe('10.5');
      expect(money('7.0000000', USD).amount).toBe('7');
      expect(money('-0', USD).amount).toBe('0');
      expect(money('-0.10', USD).amount).toBe('-0.1');
    });
  });

  describe('arithmetic', () => {
    it('adds 0.1 + 0.2 to exactly 0.3', () => {
      expect(add(money('0.1', USD), money('0.2', USD)).amount).toBe('0.3');
    });

    it('subtracts without float error', () => {
      expect(sub(money('1', USD), money('0.9', USD)).amount).toBe('0.1');
      expect(sub(money('0.1', USD), money('0.3', USD)).amount).toBe('-0.2');
    });

    it('keeps 7-decimal precision on large amounts', () => {
      expect(add(money('99999999999.9999999', USD), money('0.0000001', USD)).amount).toBe('100000000000');
    });

    it('compares', () => {
      expect(compare(money('1.5', BRL), money('1.50', BRL))).toBe(0);
      expect(compare(money('1.4', BRL), money('1.5', BRL))).toBe(-1);
      expect(compare(money('2', BRL), money('1.9999999', BRL))).toBe(1);
      expect(equals(money('3', BRL), money('3.0', BRL))).toBe(true);
    });

    it('rejects mixed assets', () => {
      expect(() => add(money('1', USD), money('1', BRL))).toThrow(AssetMismatchError);
      const a = stellarAsset('USDC', ISSUER_A);
      const b = stellarAsset('USDC', ISSUER_B);
      expect(() => compare(money('1', a), money('1', b))).toThrow(AssetMismatchError);
    });
  });

  describe('minor units', () => {
    it('converts to and from cents', () => {
      expect(toMinorUnits(money('10.5', USD), 2)).toBe(1050n);
      expect(fromMinorUnits(1050, 2, USD).amount).toBe('10.5');
      expect(fromMinorUnits(1n, 7, USD).amount).toBe('0.0000001');
    });

    it('refuses to round silently', () => {
      expect(() => toMinorUnits(money('10.505', USD), 2)).toThrow(InvalidMoneyError);
    });

    it('rejects bad decimals and unsafe numbers', () => {
      expect(() => toMinorUnits(money('1', USD), 8)).toThrow(InvalidMoneyError);
      expect(() => fromMinorUnits(1.5, 2, USD)).toThrow(InvalidMoneyError);
    });
  });

  describe('relative difference', () => {
    it('measures basis points exactly', () => {
      expect(relativeDifferenceBps(money('100.3', USD), money('100', USD))).toBe(30);
      expect(relativeDifferenceBps(money('99.7', USD), money('100', USD))).toBe(30);
    });

    it('rounds the reported figure up, never down', () => {
      // 1/3 bps
      expect(relativeDifferenceBps(money('30000.1', USD), money('30000', USD))).toBe(0.04);
    });

    it('decides on the boundary exactly', () => {
      expect(exceedsBps(money('100.3', USD), money('100', USD), 30)).toBe(false);
      expect(exceedsBps(money('100.3000001', USD), money('100', USD), 30)).toBe(true);
    });

    it('rejects a zero reference and fractional limits', () => {
      expect(() => exceedsBps(money('1', USD), money('0', USD), 30)).toThrow(InvalidMoneyError);
      expect(() => exceedsBps(money('1', USD), money('1', USD), 0.5)).toThrow(RangeError);
    });
  });
});
