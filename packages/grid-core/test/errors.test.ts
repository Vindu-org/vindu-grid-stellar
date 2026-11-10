import {
  causeCodeOf,
  GridError,
  type GridErrorCode,
  InvalidConfigError,
  InvalidInputError,
  PARTNER_ERROR_SNIPPET_MAX,
  PartnerHttpError,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  PayoutInterruptedError,
  QuoteExpiredError,
  SignerRefusedError,
  SigningNotAllowedError,
  WebhookRejectedError,
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

  it('keeps the idempotency key that was sent, for a retry with the same key', () => {
    expect(new PartnerHttpError({ ...base, status: 503, idempotencyKey: 'k1' }).idempotencyKey).toBe('k1');
    expect(new PartnerHttpError({ ...base, status: 503 }).idempotencyKey).toBeUndefined();
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

  it('a rejected webhook carries its reason under the core code', () => {
    const e = new WebhookRejectedError('stale', 'svix-timestamp is too old');
    expect(e).toBeInstanceOf(GridError);
    expect(e).toMatchObject({ code: 'webhook_rejected', name: 'WebhookRejectedError', reason: 'stale' });
  });

  it('an adapter may add its own code', () => {
    const code: GridErrorCode = 'partner_specific_refusal';
    expect(new GridError(code, 'refused').code).toBe('partner_specific_refusal');
  });

  it('an incomplete submit carries the outcome and says not to sign again', () => {
    const outcome = { status: 'unknown', hash: 'ab'.repeat(32) } as const;
    const e = new PayoutIncompleteError({ stage: 'submit', signedXdr: 'XDR', txHash: outcome.hash, outcome });
    expect(e).toMatchObject({ code: 'payout_incomplete', stage: 'submit', outcome, signedXdr: 'XDR', pending: undefined });
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

  it('an unrecorded success says the money moved and carries the hash and pending create', () => {
    const pending = { body: { quote: 'q_1' }, idempotencyKey: 'k1' };
    const hash = 'ab'.repeat(32);
    const e = new PayoutIncompleteError({ stage: 'record', signedXdr: 'XDR', txHash: hash, pending });
    expect(e).toMatchObject({ code: 'payout_incomplete', stage: 'record', txHash: hash, pending });
    expect(e.message).toMatch(/money has moved/);
    expect(e.message).toMatch(/never re-quote/);
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

  it('a signer refusal keeps a plain cause code, never the message or the error', () => {
    const refused = new SignerRefusedError('threw', new SigningNotAllowedError('pays GXYZ of Jane Doe'));
    expect(refused).toBeInstanceOf(GridError);
    expect(refused).toMatchObject({
      code: 'signer_refused',
      name: 'SignerRefusedError',
      failure: 'threw',
      causeCode: 'signing_not_allowed',
    });
    expect(refused.cause).toBeUndefined();
    expect(JSON.stringify({ ...refused, message: refused.message })).not.toMatch(/Jane|GXYZ/);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('custodian timeout for Jane')],
    ['a rejected string', 'Jane'],
    ['a code with free text', { code: 'Jane Doe 123' }],
    ['nothing', undefined],
  ])('a signer refusal from %s has no cause code', (_name, cause) => {
    const e = new SignerRefusedError('threw', cause);
    expect(e.causeCode).toBeUndefined();
    expect(e.message).toBe('The signer refused or failed (no code): nothing was submitted');
  });

  it('a signer that returned no transaction says so', () => {
    const e = new SignerRefusedError('invalid_result');
    expect(e).toMatchObject({ failure: 'invalid_result', causeCode: undefined });
    expect(e.message).toMatch(/no signed transaction/);
  });

  describe('causeCodeOf', () => {
    it.each<[string, string]>([
      ['partner_http', 'partner_http'],
      ['payout-xdr-mismatch', 'payout-xdr-mismatch'],
      ['signing_not_allowed', 'signing_not_allowed'],
      ['x'.repeat(48), 'x'.repeat(48)],
      ['x1', 'x1'],
      ['payout_xdr_mismatch', 'payout_xdr_mismatch'],
      ['signer_refused', 'signer_refused'],
      ['etimedout', 'etimedout'],
      ['econnrefused', 'econnrefused'],
      ['und_err_socket', 'und_err_socket'],
      ['err_http2_stream_error', 'err_http2_stream_error'],
      // A system constant is kept, lowercased.
      ['ETIMEDOUT', 'etimedout'],
      ['ECONNREFUSED', 'econnrefused'],
      ['UND_ERR_SOCKET', 'und_err_socket'],
      ['UND_ERR_CONNECT_TIMEOUT', 'und_err_connect_timeout'],
    ])('keeps %p as %p', (code, kept) => {
      expect(causeCodeOf({ code })).toBe(kept);
    });

    // Review probe: a signer error whose code was an API key reached the
    // run's error and the logs as its cause code.
    it.each<unknown>([
      'sk_live_SECRET123',
      'Partner_HTTP',
      'a'.repeat(49),
      'has space',
      'jane.doe',
      'a:b',
      '_leading',
      'trailing_',
      'double__underscore',
      '1starts_with_digit',
      'E2BIG',
      '',
      42,
      null,
    ])('drops %p', (code) => {
      expect(causeCodeOf({ code })).toBeUndefined();
    });

    it.each<unknown>([undefined, null, 'partner_http', 42])('reads nothing from %p', (cause) => {
      expect(causeCodeOf(cause)).toBeUndefined();
    });

    // Review probe: codes of the right shape that are really tokens, hashes,
    // ids or client data.
    it.each<[string, string]>([
      ['an API key', 'sk_live_abc123def456'],
      ['a 40-character hex hash', 'deadbeefcafebabe0123456789abcdef01234567'],
      ['a hex run made of letters only', 'abcdefabcdefabcd'],
      ['a UUID', 'a3f2504e-4f89-11d3-9a0c-0305e82c3301'],
      ['a UUID without long mixed segments', 'abcdefab-abcd-abcd-abcd-abcdefabcdef'],
      ['a name with a document number', 'maria_silva_12345678901'],
      ['a token of capitals', 'SECRETTOKENABCDEF'],
      ['a 13-letter capital constant', 'ABCDEFGHIJKLM'],
      ['a token with a long mixed segment', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ])('drops %s', (_label, code) => {
      expect(causeCodeOf({ code })).toBeUndefined();
    });

    // Review probe: a code getter that throws escaped every error built from the cause.
    it.each<[string, () => unknown]>([
      [
        'a code getter that throws',
        () => ({
          get code(): string {
            throw new Error('partner error text: Jane Doe');
          },
        }),
      ],
      [
        'a Proxy whose every trap throws',
        () =>
          new Proxy(
            {},
            {
              get() {
                throw new Error('trap');
              },
              has() {
                throw new Error('trap');
              },
              getOwnPropertyDescriptor() {
                throw new Error('trap');
              },
              getPrototypeOf() {
                throw new Error('trap');
              },
            },
          ),
      ],
      [
        'a revoked Proxy',
        () => {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          return proxy;
        },
      ],
      ['null', () => null],
    ])('never throws on %s', (_label, make) => {
      const cause = make();
      expect(() => causeCodeOf(cause)).not.toThrow();
      expect(causeCodeOf(cause)).toBeUndefined();
      expect(new PayoutAuthorizationError('threw', cause).causeCode).toBeUndefined();
      expect(new SignerRefusedError('threw', cause).causeCode).toBeUndefined();
      expect(new PayoutInterruptedError({ stage: 'run', cause }).causeCode).toBeUndefined();
    });

    it('applies to every error that keeps a cause code', () => {
      const secret = Object.assign(new Error('x'), { code: 'sk_live_SECRET123' });
      expect(new PayoutAuthorizationError('threw', secret).causeCode).toBeUndefined();
      expect(new SignerRefusedError('threw', secret).causeCode).toBeUndefined();
      expect(new SignerRefusedError('threw', secret).message).not.toMatch(/SECRET/);
    });
  });

  describe('PayoutInterruptedError', () => {
    it('names the stage and the edge, keeps the cause code and never the cause', () => {
      const cause = Object.assign(new Error('db down for Jane Doe'), { code: 'store_unavailable' });
      const e = new PayoutInterruptedError({ stage: 'on_signed', signedXdr: 'XDR', cause });
      expect(e).toBeInstanceOf(GridError);
      expect(e).toMatchObject({
        code: 'payout_interrupted',
        name: 'PayoutInterruptedError',
        stage: 'on_signed',
        signedXdr: 'XDR',
        causeCode: 'store_unavailable',
      });
      expect(e.cause).toBeUndefined();
      expect(e.message).toMatch(/awaiting_signature -> needs_attention/);
      expect(e.message).toMatch(/nothing was submitted/);
      expect(JSON.stringify({ ...e, message: e.message })).not.toMatch(/Jane/);
    });

    it.each<[string, unknown]>([
      ['a plain Error', new Error('clock')],
      ['a secret-shaped code', { code: 'sk_live_SECRET123' }],
      ['nothing', undefined],
    ])('has no cause code from %s', (_name, cause) => {
      const e = new PayoutInterruptedError({ stage: 'clock', cause });
      expect(e).toMatchObject({ stage: 'clock', causeCode: undefined, signedXdr: undefined });
      expect(e.message).toMatch(/\(clock, no code\)/);
      expect(e.message).not.toMatch(/SECRET/);
    });
  });
});
