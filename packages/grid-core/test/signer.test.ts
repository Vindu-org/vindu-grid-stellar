import { fiat } from '../src/assets';
import { SigningNotAllowedError } from '../src/errors';
import { money } from '../src/money';
import { type SigningContext, assertMaxTimeWithinQuote, assertSigningAllowed } from '../src/signer';

const base: SigningContext = {
  transferId: 'tr_test',
  state: 'awaiting_signature',
  quoteId: 'q_test',
  expiresAt: '2030-01-01T00:00:00Z',
  expected: {
    source: `G${'A'.repeat(55)}`,
    destination: `G${'C'.repeat(55)}`,
    amount: money('100', fiat('USDC')),
  },
};
const now = new Date('2029-12-31T23:59:00Z');
const expirySec = Date.parse(base.expiresAt) / 1000;

describe('signer guard', () => {
  it('allows signing in awaiting_signature before expiry', () => {
    expect(() => assertSigningAllowed(base, now)).not.toThrow();
  });

  it.each(['funded', 'payout_quoted', 'payout_submitted', 'needs_attention'] as const)(
    'refuses in %s',
    (state) => {
      expect(() => assertSigningAllowed({ ...base, state }, now)).toThrow(SigningNotAllowedError);
    },
  );

  it('refuses at and after expiry', () => {
    expect(() => assertSigningAllowed(base, new Date(base.expiresAt))).toThrow(SigningNotAllowedError);
    expect(() => assertSigningAllowed(base, new Date('2030-01-02T00:00:00Z'))).toThrow(/fresh quote/);
  });

  it.each(['soon', '1', '2030-01-01', '2030-01-01T00:00:00', ''])('refuses the expiry %p', (expiresAt) => {
    expect(() => assertSigningAllowed({ ...base, expiresAt }, new Date('2000-01-01T00:00:00Z'))).toThrow(
      /invalid expiry/,
    );
  });

  it('accepts an expiry with an offset or fractional seconds', () => {
    expect(() => assertSigningAllowed({ ...base, expiresAt: '2030-01-01T03:00:00.123+03:00' }, now)).not.toThrow();
  });

  // A broken clock must never let an expired quote through.
  it.each([new Date(Number.NaN), new Date(Number.POSITIVE_INFINITY), 'not a date' as unknown as Date])(
    'fails closed on an invalid now (%p)',
    (bad) => {
      const expired = { ...base, expiresAt: '2001-01-01T00:00:00Z' };
      expect(() => assertSigningAllowed(expired, bad)).toThrow(/invalid time/);
      expect(() => assertSigningAllowed(base, bad)).toThrow(SigningNotAllowedError);
    },
  );
});

describe('maxTime against the quote expiry', () => {
  it('allows a maxTime at or before the quote expiry', () => {
    expect(() => assertMaxTimeWithinQuote(expirySec, base)).not.toThrow();
    expect(() => assertMaxTimeWithinQuote(expirySec - 60, base)).not.toThrow();
  });

  it('refuses a maxTime after the quote expiry', () => {
    expect(() => assertMaxTimeWithinQuote(expirySec + 1, base)).toThrow(/after quote q_test expires/);
  });

  it.each([undefined, 0])('refuses a transaction without an upper bound (%p)', (maxTime) => {
    expect(() => assertMaxTimeWithinQuote(maxTime, base)).toThrow(/no maxTime/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('refuses an invalid maxTime %p', (maxTime) => {
    expect(() => assertMaxTimeWithinQuote(maxTime, base)).toThrow(SigningNotAllowedError);
  });

  it('refuses when the quote expiry is unusable', () => {
    expect(() => assertMaxTimeWithinQuote(expirySec, { ...base, expiresAt: 'later' })).toThrow(/invalid expiry/);
  });
});
