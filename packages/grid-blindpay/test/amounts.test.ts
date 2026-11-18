import { InvalidInputError, fiat, money } from '@vindu/grid-core';

import { DEV_SENTINEL_AMOUNTS, floorToBlindPayAmount, fromBlindPayAmount, toBlindPayAmount } from '../src/amounts';

const usdc = fiat('USDC');
const brl = fiat('BRL');

describe('amounts', () => {
  it('follows the documented convention: 100 USDC is 10000', () => {
    expect(toBlindPayAmount(money('100', usdc))).toBe(10_000);
    expect(fromBlindPayAmount(10_000, usdc)).toEqual(money('100', usdc));
  });

  it.each([
    ['0.01', 1],
    ['0.1', 10],
    ['1.5', 150],
    ['9512.34', 951_234],
    ['666', DEV_SENTINEL_AMOUNTS.failed],
    ['777', DEV_SENTINEL_AMOUNTS.refunded],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('converts %s to %d and back exactly', (amount, minor) => {
    expect(toBlindPayAmount(money(amount, brl))).toBe(minor);
    expect(fromBlindPayAmount(minor, brl)).toEqual(money(amount, brl));
  });

  it.each(['0.001', '1.005', '10.1234567'])('throws on sub-cent precision %s instead of rounding', (amount) => {
    expect(() => toBlindPayAmount(money(amount, usdc))).toThrow(InvalidInputError);
    expect(() => toBlindPayAmount(money(amount, usdc))).toThrow(/sub-cent/);
  });

  it('accepts trailing zeros beyond two decimals', () => {
    expect(toBlindPayAmount(money('1.2300000', usdc))).toBe(123);
  });

  it.each(['0', '-1'])('refuses non-positive %s', (amount) => {
    expect(() => toBlindPayAmount(money(amount, usdc))).toThrow(/positive/);
  });

  it('refuses amounts beyond a safe integer', () => {
    expect(() => toBlindPayAmount(money('90071992547409.92', usdc))).toThrow(/too large/);
  });

  it.each([1.5, Number.NaN, 2 ** 53])('refuses %p minor units from the API', (minor) => {
    expect(() => fromBlindPayAmount(minor, usdc)).toThrow(InvalidInputError);
  });

  it.each([
    ['100.1234567', 10_012],
    ['100.1299999', 10_012],
    ['100.12', 10_012],
    ['0.01', 1],
    ['0.0199999', 1],
    ['90071992547409.919', Number.MAX_SAFE_INTEGER],
  ])('floors %s to %d cents for a payout, never up', (amount, minor) => {
    expect(floorToBlindPayAmount(money(amount, usdc))).toBe(minor);
  });

  it.each(['0.0099999', '0', '-1'])('refuses to floor %s to nothing', (amount) => {
    expect(() => floorToBlindPayAmount(money(amount, usdc))).toThrow(InvalidInputError);
  });

  it('refuses to floor an amount beyond a safe integer', () => {
    expect(() => floorToBlindPayAmount(money('90071992547409.92', usdc))).toThrow(/too large/);
  });
});
