/** Customers (`re_`): create, read and remaining limits. */
import { type BlindPayHttp, type Created, type IdempotencyOptions, create, get } from './http';
import { assertId } from './ids';
import type { CreateCustomerRequest, Customer, CustomerLimits } from './types';

export interface CustomersApi {
  /**
   * Creates an individual or business customer. On development instances
   * customers are approved automatically; the legal name `Fail` forces a rejection.
   */
  create(input: CreateCustomerRequest, opts?: IdempotencyOptions): Promise<Created<Customer>>;
  get(customerId: string): Promise<Customer>;
  /** Remaining payin and payout limits, in USD cents. */
  getLimits(customerId: string): Promise<CustomerLimits>;
}

export function customersApi(http: BlindPayHttp): CustomersApi {
  return {
    async create(input, opts) {
      const body = input.type === 'individual' ? flattenIndividual(input) : input;
      return create<Customer>(http, '/customers', body, opts);
    },
    async get(customerId) {
      return get<Customer>(http, `/customers/${assertId(customerId, 're', 'customerId')}`);
    },
    async getLimits(customerId) {
      return get<CustomerLimits>(http, `/limits/customers/${assertId(customerId, 're', 'customerId')}`);
    },
  };
}

function flattenIndividual(input: Extract<CreateCustomerRequest, { type: 'individual' }>): Record<string, unknown> {
  const { extra_fields: extra, ...documented } = input;
  // Documented fields win over pass-through ones with the same name.
  return { ...(extra ?? {}), ...documented };
}
