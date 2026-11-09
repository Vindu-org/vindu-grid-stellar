import { GridError, PARTNER_ERROR_SNIPPET_MAX, PartnerHttpError } from '../src/errors';

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
