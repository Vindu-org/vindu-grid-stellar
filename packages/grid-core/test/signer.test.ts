import { fiat } from '../src/assets';
import { SigningNotAllowedError } from '../src/errors';
import { money } from '../src/money';
import { type SigningContext, assertSigningAllowed } from '../src/signer';

const base: SigningContext = {
  transferId: 'tr_test',
  state: 'awaiting_signature',
  quoteId: 'q_test',
  expiresAt: '2030-01-01T00:00:00Z',
  expected: { amount: money('100', fiat('USDC')), destination: `G${'C'.repeat(55)}` },
};
const now = new Date('2029-12-31T23:59:00Z');

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

  it('refuses an unparseable expiry', () => {
    expect(() => assertSigningAllowed({ ...base, expiresAt: 'soon' }, now)).toThrow(SigningNotAllowedError);
  });
});
