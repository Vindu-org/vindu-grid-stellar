/** Payins (`pi_`): turn a payin quote into a PIX code. There is no cancel. */
import { type BlindPayHttp, type Created, type IdempotencyOptions, create, get } from './http';
import { assertId } from './ids';
import type { Payin } from './types';

export interface PayinsApi {
  /**
   * Creates the payin for a quote and returns its PIX code. The path is
   * `/payins/evm` for every network, Stellar included: the name is BlindPay's.
   */
  create(input: { readonly payin_quote_id: string }, opts?: IdempotencyOptions): Promise<Created<Payin>>;
  get(payinId: string): Promise<Payin>;
}

export function payinsApi(http: BlindPayHttp): PayinsApi {
  return {
    async create(input, opts) {
      const body = { payin_quote_id: assertId(input.payin_quote_id, 'qu', 'payin_quote_id') };
      return create<Payin>(http, '/payins/evm', body, opts);
    },
    async get(payinId) {
      return get<Payin>(http, `/payins/${assertId(payinId, 'pi', 'payinId')}`);
    },
  };
}
