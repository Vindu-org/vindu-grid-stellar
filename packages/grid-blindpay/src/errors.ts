/**
 * Errors specific to the BlindPay adapter. All extend core's GridError, so
 * callers can branch on `code`. None of them ever carries the API key.
 * Config, input and quote-expiry errors are core's own.
 */
import { GridError, PartnerHttpError, type PartnerHttpErrorInit } from '@vindu/grid-core';

/**
 * A BlindPay call failed. The Idempotency-Key that was sent is core's
 * `PartnerHttpError.idempotencyKey`, so a retry can reuse it with any adapter.
 *
 * It carries no free text from BlindPay or from the network layer: no response
 * body (unless the client was built with `includeErrorBodies: true`), and no
 * `cause`, because a fetch error message can quote request headers or bodies.
 * `causeCode` keeps the system error code, lowercased (`econnrefused`), when
 * core's `causeCodeOf` accepts it; anything else is dropped.
 *
 * A body over `maxResponseBytes` gives code `response_too_large`. After a
 * 2xx it is not retryable: the call may have taken effect, so look the
 * resource up or replay a create with the same idempotency key and body.
 */
export class BlindPayHttpError extends PartnerHttpError {
  /** Code of the underlying network failure, lowercased: `econnrefused`, `und_err_connect_timeout`. */
  readonly causeCode: string | undefined;

  constructor(init: Omit<PartnerHttpErrorInit, 'cause'> & { readonly causeCode?: string }) {
    super(init);
    this.causeCode = init.causeCode;
  }
}

/** The quote field BlindPay answered with an unusable value. */
export type BlindPayQuoteField = 'id' | 'expires_at' | 'sender_amount' | 'receiver_amount';

/**
 * BlindPay answered with a quote this adapter will not use: no `id`, an
 * `expires_at` that is not epoch milliseconds or falls outside the accepted
 * window (after now, at most `maxQuoteTtlMs` ahead), an amount that is not a
 * positive integer in minor units, or (for a `sender` quote) a
 * `sender_amount` other than the `request_amount` sent. Nothing was created
 * at BlindPay; ask for a new quote.
 */
export class BlindPayQuoteError extends GridError {
  constructor(
    readonly field: BlindPayQuoteField,
    message: string,
  ) {
    super('unexpected_partner_quote', message);
  }
}
