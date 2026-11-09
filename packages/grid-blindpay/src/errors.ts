/**
 * Errors specific to the BlindPay adapter. All extend core's GridError, so
 * callers can branch on `code`. None of them ever carries the API key.
 * Config, input and quote-expiry errors are core's own.
 */
import { PartnerHttpError, type PartnerHttpErrorInit } from '@vindu/grid-core';

/** A BlindPay call failed. Adds the Idempotency-Key that was sent, so a retry can reuse it. */
export class BlindPayHttpError extends PartnerHttpError {
  /** The key sent with the request (POST and DELETE). Reuse it, with the same body, on retry. */
  readonly idempotencyKey: string | undefined;

  constructor(init: PartnerHttpErrorInit & { readonly idempotencyKey?: string }) {
    super(init);
    this.idempotencyKey = init.idempotencyKey;
  }
}
