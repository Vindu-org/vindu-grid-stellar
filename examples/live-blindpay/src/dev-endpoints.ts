/**
 * BlindPay calls `@vindu/grid-blindpay` does not wrap (yet). Each goes
 * through the client's own HTTP layer (`client.http.request`), so it still
 * gets the bearer key, an Idempotency-Key on every write, the timeout, the
 * body cap and the redaction rules. Each one is reported as a FINDING line:
 * a gap in the package, not something to call with raw `fetch`.
 */
import type { BlindPayClient } from '@vindu/grid-blindpay';

/** `GET /v1/instances/{id}`: the instance itself. Not wrapped by the package. */
export async function getInstanceType(client: BlindPayClient): Promise<string | undefined> {
  const res = await client.http.request<{ type?: unknown }>({ method: 'GET', path: '' });
  return typeof res.data?.type === 'string' ? res.data.type : undefined;
}

export interface CustomerSummary {
  readonly id: string;
  readonly kyc_status?: string;
  readonly country?: string;
  readonly type?: string;
}

/** `GET /customers`: the package has `get` but no `list`. */
export async function listCustomers(client: BlindPayClient): Promise<readonly CustomerSummary[]> {
  const res = await client.http.request<unknown>({ method: 'GET', path: '/customers' });
  return arrayOf<CustomerSummary>(res.data);
}

/**
 * `POST /create-asset-trustline` (development only): an unsigned
 * `changeTrust` envelope for USDB, in the `xdr` field.
 */
export async function createAssetTrustline(client: BlindPayClient, address: string): Promise<string> {
  const res = await client.http.request<{ xdr?: unknown }>({
    method: 'POST', path: '/create-asset-trustline', body: { address },
  });
  const xdr = res.data?.xdr;
  if (typeof xdr !== 'string' || xdr === '') throw new Error('create-asset-trustline answered without an xdr field');
  return xdr;
}

/**
 * `POST /mint-usdb-stellar` (development only). Also authorizes the
 * account's USDB trustline: the issuer requires authorization, and a
 * trustline from `create-asset-trustline` alone stays unauthorized.
 */
export async function mintUsdb(client: BlindPayClient, address: string, amount: string): Promise<void> {
  await client.http.request({ method: 'POST', path: '/mint-usdb-stellar', body: { address, amount } });
}

export interface BankAccountSummary {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly status?: string;
}

/** `GET /customers/{re_id}/bank-accounts`. Not wrapped by the package. */
export async function listBankAccounts(client: BlindPayClient, customerId: string): Promise<readonly BankAccountSummary[]> {
  const res = await client.http.request<unknown>({ method: 'GET', path: `/customers/${customerId}/bank-accounts` });
  return arrayOf<BankAccountSummary>(res.data);
}

/** `POST /customers/{re_id}/bank-accounts`. Not wrapped by the package. */
export async function createBankAccount(
  client: BlindPayClient,
  customerId: string,
  body: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
): Promise<BankAccountSummary> {
  const res = await client.http.request<BankAccountSummary>({
    method: 'POST', path: `/customers/${customerId}/bank-accounts`, body, idempotencyKey,
  });
  return res.data;
}

/** `DELETE /customers/{re_id}/blockchain-wallets/{bw_id}` (soft delete). Not wrapped by the package. */
export async function deleteWallet(client: BlindPayClient, customerId: string, walletId: string): Promise<void> {
  await client.http.request({ method: 'DELETE', path: `/customers/${customerId}/blockchain-wallets/${walletId}` });
}

function arrayOf<T>(data: unknown): readonly T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown } | null)?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}
