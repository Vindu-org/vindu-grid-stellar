/**
 * The Horizon gateway.
 *
 * Everything in this package reads from and writes to Stellar through the
 * small {@link HorizonGateway} interface below. The default implementation
 * wraps `Horizon.Server` from `@stellar/stellar-sdk`; tests and other runtimes
 * pass their own. The gateway returns plain data and never logs.
 */
import { type StellarSdk, Horizon, NotFoundError, TransactionBuilder } from './sdk';

/** One operation from Horizon's payments endpoint, in Horizon's own field names. */
export interface HorizonPaymentRecord {
  readonly id: string;
  readonly paging_token: string;
  /** e.g. `payment`, `path_payment_strict_send`, `create_account`, `account_merge`. */
  readonly type: string;
  readonly transaction_hash: string;
  readonly transaction_successful?: boolean;
  readonly created_at: string;
  readonly source_account?: string;
  readonly from?: string;
  readonly to?: string;
  readonly to_muxed_id?: string;
  readonly asset_type?: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly amount?: string;
  readonly source_asset_type?: string;
  readonly source_asset_code?: string;
  readonly source_asset_issuer?: string;
  readonly source_amount?: string;
  /** `create_account` only. */
  readonly account?: string;
  readonly funder?: string;
  readonly starting_balance?: string;
  /** Memo of the enclosing transaction, when the gateway joins it. */
  readonly memo?: string;
  readonly memo_type?: string;
}

export interface PaymentsQuery {
  /** Paging token to continue after. Absent: from the start (asc) or the end (desc). */
  readonly cursor?: string;
  readonly limit: number;
  readonly order: 'asc' | 'desc';
}

/** A transaction as found on Horizon. Failed transactions are found too. */
export interface HorizonTransactionFound {
  readonly found: true;
  readonly hash: string;
  /** False when the transaction is in a ledger but failed: its fee and sequence are spent, nothing moved. */
  readonly successful: boolean;
  readonly ledger?: number;
  readonly createdAt?: string;
}

export type HorizonTransactionLookup = HorizonTransactionFound | { readonly found: false };

/** Horizon's answer to a transaction submission, reduced to what callers act on. */
export type HorizonSubmitResponse =
  | { readonly kind: 'accepted'; readonly hash: string; readonly ledger?: number; readonly successful: boolean }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      /** Horizon's transaction result code, e.g. `tx_bad_seq`. */
      readonly transactionCode?: string;
      /** Horizon's operation result codes, e.g. `['op_underfunded']`. */
      readonly operationCodes: readonly string[];
    }
  /** Horizon gave up waiting for the ledger (HTTP 504). The transaction may still land. */
  | { readonly kind: 'timeout'; readonly status?: number }
  /** No usable answer: network error or a server error. The transaction may still have reached the network. */
  | { readonly kind: 'unavailable'; readonly status: number | null };

/** One balance line of an account, in Horizon's field names. */
export interface HorizonBalanceLine {
  /** `native`, `credit_alphanum4`, `credit_alphanum12` or `liquidity_pool_shares`. */
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance: string;
  readonly limit?: string;
  readonly buying_liabilities?: string;
  readonly selling_liabilities?: string;
  readonly is_authorized?: boolean;
}

export interface HorizonAccount {
  readonly id: string;
  readonly sequence: string;
  readonly subentry_count: number;
  readonly num_sponsoring?: number;
  readonly num_sponsored?: number;
  readonly balances: readonly HorizonBalanceLine[];
}

export interface HorizonGateway {
  /** Payments (payment, path payment, create account, merge) that touch `account`. Successful transactions only. */
  paymentsForAccount(account: string, query: PaymentsQuery): Promise<readonly HorizonPaymentRecord[]>;
  /** Looks a transaction up by hash. Not found is a result; network errors throw. */
  transaction(hash: string): Promise<HorizonTransactionLookup>;
  /** Submits a signed transaction envelope (base64 XDR) and waits for Horizon's answer. Never throws for HTTP errors. */
  submitTransaction(signedXdr: string): Promise<HorizonSubmitResponse>;
  /** The account, or `null` when it does not exist on the network. */
  account(address: string): Promise<HorizonAccount | null>;
}

export interface HorizonGatewayOptions {
  /** Horizon base URL, e.g. `TESTNET_HORIZON_URL`. */
  readonly horizonUrl: string;
  /** Needed to decode the envelope before submitting it. */
  readonly networkPassphrase: string;
  /** Allow `http://` URLs, for a local Horizon. Default false. */
  readonly allowHttp?: boolean;
  /** Use this server instead of creating one, e.g. with custom headers. */
  readonly server?: StellarSdk.Horizon.Server;
}

/** {@link HorizonGateway} over `@stellar/stellar-sdk`'s `Horizon.Server`. */
export function createHorizonGateway(options: HorizonGatewayOptions): HorizonGateway {
  const server =
    options.server ?? new Horizon.Server(options.horizonUrl, { allowHttp: options.allowHttp ?? false });

  return {
    async paymentsForAccount(account, query) {
      let builder = server.payments().forAccount(account).order(query.order).limit(query.limit).join('transactions');
      if (query.cursor !== undefined) builder = builder.cursor(query.cursor);
      const page = await builder.call();
      return page.records.map((r) => toPaymentRecord(r as unknown as Record<string, unknown>));
    },

    async transaction(hash) {
      try {
        const tx = await server.transactions().transaction(hash).call();
        return {
          found: true,
          hash: tx.hash,
          successful: tx.successful,
          ledger: tx.ledger_attr,
          createdAt: tx.created_at,
        };
      } catch (e) {
        if (e instanceof NotFoundError || httpStatus(e) === 404) return { found: false };
        throw e;
      }
    },

    async submitTransaction(signedXdr) {
      const tx = TransactionBuilder.fromXDR(signedXdr, options.networkPassphrase);
      try {
        // The envelope is already signed: submit it exactly as is, without the
        // extra account lookups of the memo-required check.
        const res = await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
        return { kind: 'accepted', hash: res.hash, ledger: res.ledger, successful: res.successful };
      } catch (e) {
        return toSubmitFailure(e);
      }
    },

    async account(address) {
      try {
        const acc = await server.accounts().accountId(address).call();
        return {
          id: acc.id,
          sequence: acc.sequence,
          subentry_count: acc.subentry_count,
          num_sponsoring: acc.num_sponsoring,
          num_sponsored: acc.num_sponsored,
          balances: acc.balances as readonly HorizonBalanceLine[],
        };
      } catch (e) {
        if (e instanceof NotFoundError || httpStatus(e) === 404) return null;
        throw e;
      }
    },
  };
}

const PAYMENT_FIELDS = [
  'id', 'paging_token', 'type', 'transaction_hash', 'created_at', 'source_account', 'from', 'to',
  'to_muxed_id', 'asset_type', 'asset_code', 'asset_issuer', 'amount', 'source_asset_type',
  'source_asset_code', 'source_asset_issuer', 'source_amount', 'account', 'funder', 'starting_balance',
] as const;

/** Copies the known fields only, so links and unrelated data never travel further. */
function toPaymentRecord(r: Record<string, unknown>): HorizonPaymentRecord {
  const out: Record<string, unknown> = {};
  for (const k of PAYMENT_FIELDS) if (typeof r[k] === 'string') out[k] = r[k];
  if (typeof r['transaction_successful'] === 'boolean') out['transaction_successful'] = r['transaction_successful'];
  // With join=transactions the SDK keeps the embedded transaction under `transaction_attr`.
  const tx = r['transaction_attr'] as Record<string, unknown> | undefined;
  if (tx !== undefined && tx !== null) {
    if (typeof tx['memo'] === 'string') out['memo'] = tx['memo'];
    if (typeof tx['memo_type'] === 'string') out['memo_type'] = tx['memo_type'];
  }
  return out as unknown as HorizonPaymentRecord;
}

function httpStatus(e: unknown): number | null {
  const status = (e as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : null;
}

function toSubmitFailure(e: unknown): HorizonSubmitResponse {
  const status = httpStatus(e);
  const data = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data;
  const codes = data?.extras?.result_codes as { transaction?: unknown; operations?: unknown } | undefined;
  // A 4xx with result codes (or a malformed envelope) is a refusal; 408 and 429 are not.
  if (status !== null && (codes !== undefined || (status >= 400 && status < 500 && status !== 408 && status !== 429))) {
    return {
      kind: 'rejected',
      status,
      ...(typeof codes?.transaction === 'string' ? { transactionCode: codes.transaction } : {}),
      operationCodes: Array.isArray(codes?.operations)
        ? codes.operations.filter((c): c is string => typeof c === 'string')
        : [],
    };
  }
  if (status === 504) return { kind: 'timeout', status };
  if (isClientTimeout(e)) return { kind: 'timeout' };
  return { kind: 'unavailable', status };
}

function isClientTimeout(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || (e instanceof Error && e.name === 'TimeoutError');
}
