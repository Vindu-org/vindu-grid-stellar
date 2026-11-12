/**
 * BlindPay ids carry a type prefix: `in_` instance, `re_` customer, `bw_`
 * blockchain wallet, `qu_` quote, `pi_` payin, `po_` payout, `pf_` partner fee,
 * `ba_` bank account. Ids are checked before they go into a URL path, and
 * reports use a templated path so metrics do not explode by id.
 */
import { InvalidInputError } from '@vindu/grid-core';

export const ID_PREFIXES = {
  in: 'instance',
  re: 'customer',
  bw: 'wallet',
  qu: 'quote',
  pi: 'payin',
  po: 'payout',
  pf: 'partnerFee',
  ba: 'bankAccount',
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

const ID_RE = /^([a-z]{2})_[A-Za-z0-9]+$/;

/** Throws unless `value` is an id with `prefix`, e.g. `assertId('re_123', 're', 'customerId')`. */
export function assertId(value: unknown, prefix: IdPrefix, name: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new InvalidInputError(`${name} must be a BlindPay id starting with ${prefix}_`);
  }
  return value;
}

/**
 * Replaces each id segment with `{prefix_id}` and collects the ids by kind.
 * `/v1/instances/in_1/payins/pi_2` becomes `/v1/instances/{in_id}/payins/{pi_id}`
 * with `{ instance: 'in_1', payin: 'pi_2' }`.
 */
export function describePath(path: string): { template: string; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const template = path
    .split('/')
    .map((segment) => {
      const m = ID_RE.exec(segment);
      const prefix = m?.[1];
      if (prefix === undefined || !(prefix in ID_PREFIXES)) return segment;
      ids[ID_PREFIXES[prefix as IdPrefix]] = segment;
      return `{${prefix}_id}`;
    })
    .join('/');
  return { template, ids };
}
