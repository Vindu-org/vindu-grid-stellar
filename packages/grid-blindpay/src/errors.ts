/**
 * Errors specific to the BlindPay adapter. All extend core's GridError, so
 * callers can branch on `code`. None of them ever carries the API key.
 * Config, input and quote-expiry errors are core's own.
 */
import { PartnerHttpError, type PartnerHttpErrorInit } from '@vindu/grid-core';

/**
 * A BlindPay call failed. Adds the Idempotency-Key that was sent, so a retry
 * can reuse it.
 *
 * It carries no free text from BlindPay or from the network layer: no response
 * body (unless the client was built with `includeErrorBodies: true`), and no
 * `cause`, because a fetch error message can quote request headers or bodies.
 * `causeCode` keeps the system error code (e.g. `ECONNREFUSED`) when there is one.
 */
export class BlindPayHttpError extends PartnerHttpError {
  /** The key sent with the request (POST and DELETE). Reuse it, with the same body, on retry. */
  readonly idempotencyKey: string | undefined;
  /** Code of the underlying network failure, such as `ECONNREFUSED` or `UND_ERR_CONNECT_TIMEOUT`. */
  readonly causeCode: string | undefined;

  constructor(init: Omit<PartnerHttpErrorInit, 'cause'> & { readonly idempotencyKey?: string; readonly causeCode?: string }) {
    super(init);
    this.idempotencyKey = init.idempotencyKey;
    this.causeCode = init.causeCode;
  }
}
