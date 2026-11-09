import {
  GridError,
  type GridErrorCode,
  InvalidConfigError,
  InvalidInputError,
  PARTNER_ERROR_SNIPPET_MAX,
  PartnerHttpError,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  QuoteExpiredError,
} from '../src/errors';

const base = { partner: 'p', method: 'POST', path: '/v1/x' } as const;

describe('partner http error', () => {
  it.each([
    [null, true],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [409, false],
    [422, false],
  ])('status %p is retryable: %p', (status, expected) => {
    expect(new PartnerHttpError({ ...base, status }).retryable).toBe(expected);
  });

  it('an explicit retryable overrides the status default', () => {
    expect(new PartnerHttpError({ ...base, status: 409, retryable: true }).retryable).toBe(true);
    expect(new PartnerHttpError({ ...base, status: 503, retryable: false }).retryable).toBe(false);
  });

  it('keeps Retry-After as information and caps the snippet', () => {
    const e = new PartnerHttpError({
      ...base,
      status: 429,
      retryAfterMs: 2000,
      bodySnippet: 'x'.repeat(PARTNER_ERROR_SNIPPET_MAX + 10),
    });
    expect(e.retryAfterMs).toBe(2000);
    expect(e.bodySnippet).toHaveLength(PARTNER_ERROR_SNIPPET_MAX + 3);
    expect(e).toBeInstanceOf(GridError);
    expect(e.code).toBe('partner_http');
    expect(e.message).toBe('p POST /v1/x failed: HTTP 429');
  });
});

describe('shared errors', () => {
  it('config, input and quote expiry errors carry core codes', () => {
    expect(new InvalidConfigError('bad')).toMatchObject({ code: 'invalid_config', name: 'InvalidConfigError' });
    expect(new InvalidInputError('bad')).toMatchObject({ code: 'invalid_input', name: 'InvalidInputError' });
    const expired = new QuoteExpiredError('q_1', '2030-01-01T00:00:00Z', 'signing');
    expect(expired).toMatchObject({
      code: 'quote_expired',
      quoteId: 'q_1',
      expiresAt: '2030-01-01T00:00:00Z',
      stage: 'signing',
    });
    expect(expired.message).toMatch(/before signing: get a fresh quote/);
    for (const e of [new InvalidConfigError('x'), new InvalidInputError('x'), expired]) {
      expect(e).toBeInstanceOf(GridError);
    }
  });

  it('an adapter may add its own code', () => {
    const code: GridErrorCode = 'partner_specific_refusal';
    expect(new GridError(code, 'refused').code).toBe('partner_specific_refusal');
  });

  it('an incomplete submit carries the outcome and says not to sign again', () => {
    const outcome = { status: 'unknown', hash: 'ab'.repeat(32) } as const;
    const e = new PayoutIncompleteError({ stage: 'submit', signedXdr: 'XDR', txHash: outcome.hash, outcome });
    expect(e).toMatchObject({ code: 'payout_not_recorded', stage: 'submit', outcome, signedXdr: 'XDR', pending: undefined });
    expect(e.message).toMatch(/ended unknown/);
    expect(e.message).toMatch(/do not sign again/);
  });

  it('an incomplete create keeps the pending body and key, and the cause', () => {
    const cause = new Error('503');
    const pending = { body: { quote: 'q_1' }, idempotencyKey: 'k1' };
    const e = new PayoutIncompleteError({ stage: 'create', pending, cause });
    expect(e).toMatchObject({ stage: 'create', pending, txHash: undefined, outcome: undefined });
    expect(e.cause).toBe(cause);
    expect(e.message).toMatch(/same body and idempotency key/);
  });

  it('an authorization failure keeps the cause code, never its message or the error', () => {
    const cause = new PartnerHttpError({ ...base, status: 400, bodySnippet: 'customer Jane Doe 123' });
    const e = new PayoutAuthorizationError('threw', cause);
    expect(e).toBeInstanceOf(GridError);
    expect(e).toMatchObject({
      code: 'payout_authorization_failed',
      name: 'PayoutAuthorizationError',
      failure: 'threw',
      causeCode: 'partner_http',
    });
    expect(e.cause).toBeUndefined();
    expect(e.message).toBe("The partner's payout authorization failed (partner_http): nothing was signed");
    expect(JSON.stringify({ ...e, message: e.message })).not.toMatch(/Jane|POST|v1/);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('secret detail')],
    ['a string', 'secret detail'],
    ['a code with spaces', { code: 'not a code' }],
    ['a code that is too long', { code: 'x'.repeat(65) }],
    ['a numeric code', { code: 42 }],
  ])('an authorization failure from %s has no cause code', (_name, cause) => {
    const e = new PayoutAuthorizationError('threw', cause);
    expect(e.causeCode).toBeUndefined();
    expect(e.message).toMatch(/\(no code\)/);
    expect(e.message).not.toMatch(/secret/);
  });

  it('an unknown authorization says so', () => {
    const e = new PayoutAuthorizationError('invalid_authorization');
    expect(e).toMatchObject({ failure: 'invalid_authorization', causeCode: undefined });
    expect(e.message).toMatch(/does not know: nothing was signed/);
  });
});
