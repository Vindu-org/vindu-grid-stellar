/**
 * Errors specific to the BlindPay adapter. All extend core's GridError, so
 * callers can branch on `code`. None of them ever carries the API key.
 */
import { GridError, PartnerHttpError, type PartnerHttpErrorInit } from '@vindu/grid-core';

/** The config passed to the client is unusable. The message never echoes the API key. */
export class InvalidConfigError extends GridError {
  constructor(message: string) {
    super('invalid_config', message);
  }
}

/** An argument is malformed, e.g. an id with the wrong prefix or an amount with sub-cent precision. */
export class InvalidInputError extends GridError {
  constructor(message: string) {
    super('invalid_input', message);
  }
}

/** A BlindPay call failed. Adds the Idempotency-Key that was sent, so a retry can reuse it. */
export class BlindPayHttpError extends PartnerHttpError {
  /** The key sent with the request (POST and DELETE). Reuse it, with the same body, on retry. */
  readonly idempotencyKey: string | undefined;

  constructor(init: PartnerHttpErrorInit & { readonly idempotencyKey?: string }) {
    super(init);
    this.idempotencyKey = init.idempotencyKey;
  }
}
