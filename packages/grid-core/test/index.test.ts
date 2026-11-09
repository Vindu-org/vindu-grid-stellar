import * as core from '../src';

describe('index exports', () => {
  it.each([
    'money',
    'add',
    'fiat',
    'stellarAsset',
    'TRANSFER_STATES',
    'transition',
    'canTransition',
    'selectRoute',
    'assertRouteImmutable',
    'supportsCorridor',
    'checkPayoutTolerance',
    'assertSigningAllowed',
    'noopLogger',
    'reportPartnerCall',
    'GridError',
    'InvalidTransitionError',
    'RouteNotFoundError',
    'PartnerHttpError',
  ])('exports %s', (name) => {
    expect(core).toHaveProperty(name);
  });
});
