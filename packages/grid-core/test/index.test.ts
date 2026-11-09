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
    'assertMaxTimeWithinQuote',
    'runSignedPayout',
    'retryPayoutExecute',
    'signingContextFor',
    'canSignReplacement',
    'transitionRules',
    'noopLogger',
    'reportPartnerCall',
    'GridError',
    'InvalidTransitionError',
    'RouteNotFoundError',
    'PartnerHttpError',
    'InvalidConfigError',
    'InvalidInputError',
    'QuoteExpiredError',
    'PayoutIncompleteError',
  ])('exports %s', (name) => {
    expect(core).toHaveProperty(name);
  });
});
