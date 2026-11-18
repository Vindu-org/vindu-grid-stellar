/** Partner fees (`pf_`): percentage in basis points plus a flat fee in minor units. No update. */
import { type BlindPayHttp, type Created, type IdempotencyOptions, create, get, list } from './http';
import { assertId } from './ids';
import type { CreatePartnerFeeRequest, ListParams, Page, PartnerFee } from './types';

export interface PartnerFeesApi {
  /**
   * Pass your own `idempotencyKey` and store it, so a retry after a timeout
   * replays the first create instead of making a second fee. Generated (and
   * returned) when absent.
   */
  create(input: CreatePartnerFeeRequest, opts?: IdempotencyOptions): Promise<Created<PartnerFee>>;
  list(params?: ListParams): Promise<Page<PartnerFee>>;
  get(partnerFeeId: string): Promise<PartnerFee>;
  /** Returns the Idempotency-Key used. */
  delete(partnerFeeId: string, opts?: IdempotencyOptions): Promise<{ readonly idempotencyKey: string }>;
}

export function partnerFeesApi(http: BlindPayHttp): PartnerFeesApi {
  return {
    async create(input, opts) {
      return create<PartnerFee>(http, '/partner-fees', input, opts);
    },
    async list(params) {
      return list<PartnerFee>(http, '/partner-fees', params);
    },
    async get(partnerFeeId) {
      return get<PartnerFee>(http, `/partner-fees/${assertId(partnerFeeId, 'pf', 'partnerFeeId')}`);
    },
    async delete(partnerFeeId, opts) {
      const res = await http.request<unknown>({
        method: 'DELETE',
        path: `/partner-fees/${assertId(partnerFeeId, 'pf', 'partnerFeeId')}`,
        ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
      });
      return { idempotencyKey: res.idempotencyKey as string };
    },
  };
}
