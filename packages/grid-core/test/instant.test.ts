import { parseInstantMs } from '../src/instant';

describe('quote expiry parser', () => {
  it.each([
    ['2030-01-01T00:00:00Z', Date.UTC(2030, 0, 1)],
    ['2030-01-01T00:00Z', Date.UTC(2030, 0, 1)],
    ['2030-01-01T03:00:00.123+03:00', Date.UTC(2030, 0, 1, 0, 0, 0, 123)],
    ['2029-12-31T21:30:00-02:30', Date.UTC(2030, 0, 1)],
    ['2030-01-01T00:00:00.123456789Z', Date.UTC(2030, 0, 1, 0, 0, 0, 123)],
    ['2030-01-01T00:00:00.5Z', Date.UTC(2030, 0, 1, 0, 0, 0, 500)],
    ['2028-02-29T00:00:00Z', Date.UTC(2028, 1, 29)],
    ['2000-02-29T00:00:00Z', Date.UTC(2000, 1, 29)],
    ['2030-12-31T23:59:59Z', Date.UTC(2030, 11, 31, 23, 59, 59)],
  ])('reads %s', (raw, ms) => {
    expect(parseInstantMs(raw)).toBe(ms);
  });

  it('agrees with Date.parse on every valid instant', () => {
    for (const raw of ['2030-01-01T03:00:00.123+03:00', '2028-02-29T12:34:56-05:00', '2030-06-30T23:59:59Z']) {
      expect(parseInstantMs(raw)).toBe(Date.parse(raw));
    }
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

  // Review probe: Date.parse rolls impossible dates and 24:00 over to a valid
  // instant, so a malformed expiry was read as a real one.
  it.each([
    '2030-02-31T00:00:00Z',
    '2030-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2030-04-31T00:00:00Z',
    '2030-00-10T00:00:00Z',
    '2030-01-00T00:00:00Z',
    '2030-01-32T00:00:00Z',
    '2030-01-01T24:00:00Z',
    '2030-01-01T24:00Z',
    '2030-01-01T23:60:00Z',
    '2030-01-01T23:59:60Z',
    '2030-01-01T00:00:00+24:00',
    '2030-01-01T00:00:00+05:60',
  ])('refuses the impossible instant %s', (raw) => {
    expect(parseInstantMs(raw)).toBeUndefined();
  });
});
