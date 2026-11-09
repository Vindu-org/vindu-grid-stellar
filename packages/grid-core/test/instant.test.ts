import { parseInstantMs } from '../src/instant';

describe('quote expiry parser', () => {
  it.each([
    ['2030-01-01T00:00:00Z', Date.UTC(2030, 0, 1)],
    ['2030-01-01T00:00Z', Date.UTC(2030, 0, 1)],
    ['2030-01-01T03:00:00.123+03:00', Date.UTC(2030, 0, 1, 0, 0, 0, 123)],
  ])('reads %s', (raw, ms) => {
    expect(parseInstantMs(raw)).toBe(ms);
  });

  // The flow used Date.parse and accepted an HTTP date the signer refused.
  it.each<unknown>([
    'Tue, 01 Jan 2030 00:05:00 GMT',
    '2030-01-01',
    '2030-01-01T00:00:00',
    '2030-13-01T00:00:00Z',
    'soon',
    '',
    1_893_456_000_000,
    undefined,
    null,
  ])('refuses %p', (raw) => {
    expect(parseInstantMs(raw)).toBeUndefined();
  });
});
