import * as api from '../src';

describe('package index', () => {
  it('exports exactly the public runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'BLINDPAY_CAPABILITIES',
        'BLINDPAY_DECIMALS',
        'BLINDPAY_PARTNER_ID',
        'BLINDPAY_TERMINAL_STATUSES',
        'BlindPayHttpError',
        'BlindPayQuoteError',
        'DEFAULT_WEBHOOK_TOLERANCE_SEC',
        'DEV_SENTINEL_AMOUNTS',
        'WebhookVerificationError',
        'createBlindPayAdapter',
        'createBlindPayClient',
        'floorToBlindPayAmount',
        'fromBlindPayAmount',
        'parseWebhookEvent',
        'retryStellarPayoutCreate',
        'runStellarPayout',
        'toBlindPayAmount',
        'verifyWebhook',
      ].sort(),
    );
  });

  it.each([
    'resolveConfig',
    'createBlindPayHttp',
    'IDEMPOTENCY_IN_FLIGHT',
    'DEFAULT_TIMEOUT_MS',
    'DEFAULT_BASE_URL',
    'UNCONFIRMED_GET_PAYOUT_PATH',
    'assertId',
    'ID_PREFIXES',
    'toLegStatus',
    'TERMINAL_STATUSES',
    'StellarPayoutIncompleteError',
    'create',
    'get',
    'list',
    'readErrorBody',
    'parseRetryAfter',
  ])('does not export the internal %s', (name) => {
    expect((api as Record<string, unknown>)[name]).toBeUndefined();
  });
});
