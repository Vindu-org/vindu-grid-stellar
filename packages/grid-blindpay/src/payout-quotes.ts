/**
 * Payout quotes (`qu_`), path `/quotes`: stablecoin from a Stellar wallet to a
 * bank account. Minimum 10 USD (`LIMITS_AMOUNT_OUT_OF_RANGE`); SWIFT minimum 100 USD.
 * A quote backs a single payout.
 */
import { type BlindPayHttp, type Created, type IdempotencyOptions, create } from './http';
import { assertId } from './ids';
import { assertRequestAmount } from './payin-quotes';
import type { CreatePayoutQuoteRequest, PayoutQuote } from './types';

export interface PayoutQuotesApi {
  create(input: CreatePayoutQuoteRequest, opts?: IdempotencyOptions): Promise<Created<PayoutQuote>>;
}

export function payoutQuotesApi(http: BlindPayHttp): PayoutQuotesApi {
  return {
    async create(input, opts) {
      assertId(input.bank_account_id, 'ba', 'bank_account_id');
      if (input.partner_fee_id !== undefined) assertId(input.partner_fee_id, 'pf', 'partner_fee_id');
      assertRequestAmount(input.request_amount);
      return create<PayoutQuote>(http, '/quotes', input, opts);
    },
  };
}
