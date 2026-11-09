import * as api from '../src';

describe('package index', () => {
  it.each([
    'createBlindPayClient',
    'createBlindPayAdapter',
    'createBlindPayHttp',
    'runStellarPayout',
    'retryStellarPayoutCreate',
    'verifyWebhook',
    'parseWebhookEvent',
    'toBlindPayAmount',
    'fromBlindPayAmount',
    'toLegStatus',
    'BLINDPAY_CAPABILITIES',
    'BLINDPAY_PARTNER_ID',
    'DEV_SENTINEL_AMOUNTS',
    'UNCONFIRMED_GET_PAYOUT_PATH',
    'QuoteExpiredError',
    'StellarPayoutIncompleteError',
    'WebhookVerificationError',
    'BlindPayHttpError',
    'InvalidConfigError',
    'InvalidInputError',
  ])('exports %s', (name) => {
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });

  it('does not export the generic request helpers', () => {
    expect((api as Record<string, unknown>)['create']).toBeUndefined();
    expect((api as Record<string, unknown>)['get']).toBeUndefined();
  });
});
