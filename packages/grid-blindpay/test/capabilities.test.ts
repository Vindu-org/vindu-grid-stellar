import { accountModelFor, supportsCorridor } from '@vindu/grid-core';

import { BLINDPAY_CAPABILITIES } from '../src/capabilities';

describe('capabilities', () => {
  it('settles on Stellar with external accounts only', () => {
    expect(accountModelFor(BLINDPAY_CAPABILITIES, 'stellar')).toBe('external');
    expect(accountModelFor(BLINDPAY_CAPABILITIES, 'other-chain')).toBeUndefined();
  });

  it.each([
    ['USD', 'wire', true],
    ['USD', 'ach', true],
    ['USD', 'rtp', true],
    ['USD', 'swift', true],
    ['EUR', 'sepa', true],
    ['MXN', 'spei', true],
    ['USD', 'sepa', false],
    ['BRL', 'pix', false],
  ])('BRL by PIX to %s by %s: %p', (targetCurrency, payoutRail, expected) => {
    const corridor = { sourceCurrency: 'BRL', fundingRail: 'pix', targetCurrency, payoutRail };
    expect(supportsCorridor(BLINDPAY_CAPABILITIES, 'stellar', corridor)).toBe(expected);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(BLINDPAY_CAPABILITIES.offRamp)).toBe(true);
  });
});
