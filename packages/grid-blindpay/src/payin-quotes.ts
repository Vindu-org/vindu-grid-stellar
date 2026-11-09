/** Payin quotes (`qu_`): PIX in, stablecoin out to a Stellar wallet. Quotes last about 5 minutes. */
import { InvalidInputError } from '@vindu/grid-core';
import { type BlindPayHttp, type Created, type IdempotencyOptions, create } from './http';
import { assertId } from './ids';
import type { CreatePayinQuoteRequest, PayinQuote } from './types';

export interface PayinQuotesApi {
  create(input: CreatePayinQuoteRequest, opts?: IdempotencyOptions): Promise<Created<PayinQuote>>;
}

export function payinQuotesApi(http: BlindPayHttp): PayinQuotesApi {
  return {
    async create(input, opts) {
      assertId(input.blockchain_wallet_id, 'bw', 'blockchain_wallet_id');
      if (input.partner_fee_id !== undefined) assertId(input.partner_fee_id, 'pf', 'partner_fee_id');
      assertRequestAmount(input.request_amount);
      return create<PayinQuote>(http, '/payin-quotes', input, opts);
    },
  };
}

/** `request_amount` is a positive integer in minor units. */
export function assertRequestAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidInputError('request_amount must be a positive integer in minor units');
  }
}
