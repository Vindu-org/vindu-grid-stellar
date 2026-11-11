/**
 * The Horizon gateway.
 *
 * Everything in this package reads from and writes to Stellar through the
 * small {@link HorizonGateway} interface below. The default implementation,
 * {@link createHorizonGateway}, reads with `fetch` (the SDK hides response
 * headers, and the lookups need Horizon's `Latest-Ledger` header) and submits
 * through `Horizon.Server` from `@stellar/stellar-sdk`. Tests and other
 * runtimes pass their own gateway. The gateway returns plain data and never
 * logs.
 *
 * Point the gateway at one Horizon instance you operate or trust to be
 * consistent, not at a public load-balanced URL: see `TESTNET_HORIZON_URL`.
 */
import { InvalidConfigError, InvalidInputError, parseInstantMs } from '@vindu/grid-core';
import { Horizon, TransactionBuilder, stellarSdk } from './sdk';

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

/** Lets the caller abandon a request. A gateway should stop the request and reject when `signal` aborts. */
export interface HorizonRequestOptions {
  readonly signal?: AbortSignal;
}

/** A transaction's result codes as Horizon names them, e.g. `tx_failed` and `['op_underfunded']`. */
export interface HorizonResultCodes {
  readonly transaction?: string;
  readonly operations: readonly string[];
}

/** A transaction as found on Horizon. Failed transactions are found too. */
export interface HorizonTransactionFound {
  readonly found: true;
  /**
   * Hash of the envelope on the ledger: for a fee bump, the fee bump's own
   * hash (Horizon's `fee_bump_transaction.hash`), also when it was looked up
   * by its inner hash. Its operations and payments carry this hash.
   */
  readonly hash: string;
  /** Hash of the inner transaction, when the record is a fee bump (Horizon's `inner_transaction.hash`). */
  readonly innerHash?: string;
  /** False when the transaction is in a ledger but failed: its fee and sequence are spent, nothing moved. */
  readonly successful: boolean;
  readonly ledger?: number;
  readonly createdAt?: string;
  /** The transaction's own result codes, read from its result on the ledger, when available. */
  readonly resultCodes?: HorizonResultCodes;
  /** Latest ledger the answering Horizon instance had ingested (its `Latest-Ledger` header). */
  readonly latestLedger?: number;
}

/**
 * Not on the ledger, as far as the answering instance knows. An instance
 * that no longer keeps old history answers this for a transaction that did
 * land, so a "not found" alone never proves anything.
 */
export interface HorizonTransactionNotFound {
  readonly found: false;
  /** Latest ledger the answering Horizon instance had ingested (its `Latest-Ledger` header). */
  readonly latestLedger?: number;
}

export type HorizonTransactionLookup = HorizonTransactionFound | HorizonTransactionNotFound;

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
  /** The account asked for. */
  readonly id: string;
  /** The account's sequence number, a decimal string (it can exceed 2^53). */
  readonly sequence: string;
  readonly subentry_count: number;
  readonly num_sponsoring?: number;
  readonly num_sponsored?: number;
  readonly balances: readonly HorizonBalanceLine[];
  /**
   * Latest ledger the answering Horizon instance had ingested (its
   * `Latest-Ledger` header): the account is shown as of that ledger. Without
   * it the read proves nothing about any ledger, so it never counts towards
   * `expired_not_landed`.
   */
  readonly latestLedger?: number;
}

/** A ledger as Horizon has ingested it. */
export interface HorizonLedger {
  readonly sequence: number;
  /** Close time of the ledger, as the network recorded it (whole seconds). */
  readonly closedAt: Date;
}

export interface HorizonGateway {
  /**
   * Passphrase of the network this gateway talks to. Submission refuses to
   * run when it differs from the passphrase the envelope was signed for.
   */
  readonly networkPassphrase: string;
  /** The latest ledger Horizon has ingested, with its close time. Network errors throw. */
  latestLedger(options?: HorizonRequestOptions): Promise<HorizonLedger>;
  /** Payments (payment, path payment, create account, merge) that touch `account`. Successful transactions only. */
  paymentsForAccount(
    account: string,
    query: PaymentsQuery,
    options?: HorizonRequestOptions,
  ): Promise<readonly HorizonPaymentRecord[]>;
  /**
   * Looks a transaction up by hash. Not found is a result; network errors and
   * timeouts throw. Found or not, the answer carries the answering
   * instance's latest ingested ledger when Horizon reports it.
   */
  transaction(hash: string, options?: HorizonRequestOptions): Promise<HorizonTransactionLookup>;
  /** Submits a signed transaction envelope (base64 XDR) and waits for Horizon's answer. Never throws for HTTP errors. */
  submitTransaction(signedXdr: string): Promise<HorizonSubmitResponse>;
  /**
   * The account, or `null` when it does not exist on the network. Carries
   * the answering instance's latest ingested ledger when Horizon reports it.
   * An answer for another account, or with fields that are not well formed,
   * throws.
   */
  account(address: string, options?: HorizonRequestOptions): Promise<HorizonAccount | null>;
}

/** What {@link createHorizonGateway} passes to `fetch`. A subset of the standard `RequestInit`. */
export interface HorizonFetchInit {
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}

/**
 * What {@link createHorizonGateway} reads from a `fetch` response. The
 * standard `Response` has this shape. The body is read as a stream, so a
 * body over `maxResponseBytes` is abandoned without being held in memory.
 */
export interface HorizonFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/** A `fetch` for Horizon GETs. The global `fetch` fits. */
export type HorizonFetch = (url: string, init: HorizonFetchInit) => Promise<HorizonFetchResponse>;

export interface HorizonGatewayOptions {
  /**
   * Horizon base URL. Use one instance you operate or trust to be
   * consistent, not a public load-balanced URL such as `TESTNET_HORIZON_URL`:
   * reads served by instances at different ledgers can make a landed
   * transaction look missing.
   */
  readonly horizonUrl: string;
  /**
   * Passphrase of the network behind `horizonUrl`. Needed to decode the
   * envelope before submitting it, and checked against the passphrase given
   * to `submitSignedTransaction`.
   */
  readonly networkPassphrase: string;
  /** Allow `http://` URLs, for a local Horizon. Default false. */
  readonly allowHttp?: boolean;
  /**
   * Longest wait for one Horizon GET (ledger, lookup, payments, account),
   * in ms. A GET that takes longer is aborted and throws. Default 10 s.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Largest response body one Horizon GET may return, in bytes. The body is
   * read as it arrives and the request is abandoned once it grows past this:
   * the read throws, never reports "not found". Default 1 MiB.
   */
  readonly maxResponseBytes?: number;
  /** `fetch` for the GETs. Default the global `fetch`. */
  readonly fetch?: HorizonFetch;
  /**
   * Submit through this server instead of creating one, e.g. a
   * `Horizon.Server` from `@stellar/stellar-sdk` with custom headers. Only
   * its `submitTransaction` is used; reads always go through `fetch`.
   */
  readonly server?: HorizonServer;
}

/**
 * The call {@link createHorizonGateway} makes on a Horizon server to submit.
 * A `Horizon.Server` from `@stellar/stellar-sdk` has this shape; the type is
 * structural so this package's public types do not depend on the SDK's.
 * Answers are typed `unknown` and checked before use.
 */
export interface HorizonServer {
  /** Receives the decoded envelope (an SDK `Transaction` or `FeeBumpTransaction`). */
  submitTransaction(transaction: { toXDR(): string }, options: { skipMemoRequiredCheck: boolean }): Promise<unknown>;
}

/** Default longest wait for one Horizon GET. */
export const DEFAULT_HORIZON_REQUEST_TIMEOUT_MS = 10_000;

/** Default largest response body of one Horizon GET: 1 MiB. */
export const DEFAULT_HORIZON_MAX_RESPONSE_BYTES = 1_048_576;

/** Longest delay `setTimeout` honours; anything longer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

const HASH = /^[0-9a-f]{64}$/i;
const LEDGER_HEADER = /^[1-9][0-9]{0,9}$/;

/**
 * {@link HorizonGateway} over Horizon's REST API: GETs with `fetch`, each
 * with a timeout, and submission through `Horizon.Server` (or `server`).
 *
 * @throws {InvalidConfigError} when the URL is not https (unless `allowHttp`
 * and http) or carries a query, fragment or credentials, `requestTimeoutMs`
 * or `maxResponseBytes` is out of range, or no `fetch` is available.
 */
export function createHorizonGateway(options: HorizonGatewayOptions): HorizonGateway {
  const base = baseUrl(options.horizonUrl, options.allowHttp ?? false);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HORIZON_REQUEST_TIMEOUT_MS;
  if (
    typeof requestTimeoutMs !== 'number' ||
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_TIMER_MS
  ) {
    throw new InvalidConfigError(`requestTimeoutMs must be a finite number of milliseconds from 1 to ${MAX_TIMER_MS}`);
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new InvalidConfigError('maxResponseBytes must be a positive whole number of bytes');
  }
  const fetchFn: HorizonFetch | undefined = options.fetch ?? (globalThis.fetch as HorizonFetch | undefined);
  if (typeof fetchFn !== 'function') throw new InvalidConfigError('No fetch available: pass the fetch option');
  let server = options.server;
  const submitServer = (): HorizonServer =>
    (server ??= new Horizon.Server(options.horizonUrl, { allowHttp: options.allowHttp ?? false }));

  /**
   * GETs `path`. 404 gives `null` body; any other non-2xx, a network error,
   * a timeout or a body over `maxResponseBytes` throws.
   */
  async function get(path: string, signal: AbortSignal | undefined): Promise<{ body: unknown; latestLedger?: number }> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const res = await (fetchFn as HorizonFetch)(`${base}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/hal+json, application/json' },
      signal: combined,
      redirect: 'error',
    });
    const header = res.headers.get('latest-ledger')?.trim();
    const latestLedger = header !== undefined && LEDGER_HEADER.test(header) ? Number(header) : undefined;
    const withLedger = latestLedger === undefined ? {} : { latestLedger };
    if (res.status < 200 || res.status > 299) {
      discard(res);
      if (res.status === 404) return { body: null, ...withLedger };
      throw new HorizonRequestError(res.status);
    }
    return { body: await readJson(res, maxResponseBytes, combined), ...withLedger };
  }

  return {
    networkPassphrase: options.networkPassphrase,

    async latestLedger(request) {
      // The root resource describes what one instance has ingested.
      const { body } = await get('/', request?.signal);
      const root = asObject(body);
      const sequence = root['history_latest_ledger'];
      // Strict: a close time without `Z` or an offset would be read in the
      // host's time zone, so it makes the ledger unusable instead.
      const closedMs = parseInstantMs(root['history_latest_ledger_closed_at']);
      if (!isLedgerNumber(sequence) || closedMs === undefined) {
        throw new Error('Horizon returned no usable latest ledger');
      }
      return { sequence, closedAt: new Date(closedMs) };
    },

    async paymentsForAccount(account, query, request) {
      const params = new URLSearchParams({ order: query.order, limit: String(query.limit), join: 'transactions' });
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      const { body } = await get(`/accounts/${encodeURIComponent(account)}/payments?${params.toString()}`, request?.signal);
      if (body === null) throw new HorizonRequestError(404);
      const records = asObject(asObject(body)['_embedded'])['records'];
      if (!Array.isArray(records)) throw new Error('Horizon returned a payments page without records');
      return records.map((r) => toPaymentRecord(asObject(r)));
    },

    async transaction(hash, request) {
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new InvalidInputError('A transaction hash is 64 hex characters');
      const { body, latestLedger } = await get(`/transactions/${hash.toLowerCase()}`, request?.signal);
      const ingested = latestLedger === undefined ? {} : { latestLedger };
      if (body === null) return { found: false, ...ingested };
      const tx = asObject(body);
      // An answer without these fields is not an answer: fail the lookup
      // rather than report something about the transaction.
      if (typeof tx['hash'] !== 'string' || typeof tx['successful'] !== 'boolean') {
        throw new Error('Horizon returned a transaction without a hash or a result');
      }
      const innerHash = asObject(tx['inner_transaction'])['hash'];
      // Looked up by its inner hash, a fee bump comes back with the inner
      // hash as its own `hash`; the envelope on the ledger, whose hash its
      // operations and payments carry, is `fee_bump_transaction`.
      const feeBumpHash = asObject(tx['fee_bump_transaction'])['hash'];
      const resultCodes = typeof tx['result_xdr'] === 'string' ? resultCodesFromXdr(tx['result_xdr']) : undefined;
      return {
        found: true,
        hash: typeof feeBumpHash === 'string' && HASH.test(feeBumpHash) ? feeBumpHash : tx['hash'],
        successful: tx['successful'],
        ...(typeof innerHash === 'string' ? { innerHash } : {}),
        ...(typeof tx['ledger'] === 'number' ? { ledger: tx['ledger'] } : {}),
        ...(typeof tx['created_at'] === 'string' ? { createdAt: tx['created_at'] } : {}),
        ...(resultCodes === undefined ? {} : { resultCodes }),
        ...ingested,
      };
    },

    async submitTransaction(signedXdr) {
      const tx = TransactionBuilder.fromXDR(signedXdr, options.networkPassphrase);
      let res: Record<string, unknown>;
      try {
        // The envelope is already signed: submit it exactly as is, without the
        // extra account lookups of the memo-required check.
        res = asObject(await submitServer().submitTransaction(tx, { skipMemoRequiredCheck: true }));
      } catch (e) {
        return toSubmitFailure(e);
      }
      // Without a hash and a result the answer says nothing usable: the
      // caller checks the hash itself.
      if (typeof res['hash'] !== 'string' || typeof res['successful'] !== 'boolean') {
        return { kind: 'unavailable', status: null };
      }
      return {
        kind: 'accepted',
        hash: res['hash'],
        successful: res['successful'],
        ...(typeof res['ledger'] === 'number' ? { ledger: res['ledger'] } : {}),
      };
    },

    async account(address, request) {
      const { body, latestLedger } = await get(`/accounts/${encodeURIComponent(address)}`, request?.signal);
      if (body === null) return null;
      return { ...toAccount(asObject(body), address), ...(latestLedger === undefined ? {} : { latestLedger }) };
    },
  };
}

/** A Horizon answer whose body is larger than `maxResponseBytes`. Never a "not found". */
class HorizonResponseTooLargeError extends Error {
  constructor(readonly maxResponseBytes: number) {
    super(`Horizon answered with a body over ${maxResponseBytes} bytes`);
    this.name = 'HorizonResponseTooLargeError';
  }
}

/** Lets go of a body that will not be read. */
function discard(res: HorizonFetchResponse): void {
  try {
    res.body?.getReader().cancel().catch(() => undefined);
  } catch {
    // Already read or locked: nothing to release.
  }
}

/**
 * Reads the body as it arrives and parses it as JSON. Stops, and cancels the
 * stream, once more than `maxBytes` arrived (or `Content-Length` says it
 * will) and when `signal` aborts.
 */
async function readJson(res: HorizonFetchResponse, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = res.headers.get('content-length')?.trim();
  if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    discard(res);
    throw new HorizonResponseTooLargeError(maxBytes);
  }
  if (res.body === null || typeof res.body?.getReader !== 'function') throw new Error('Horizon answered without a body');
  const reader = res.body.getReader();
  const stop = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!ArrayBuffer.isView(value)) throw new Error('Horizon answered with a body that is not bytes');
      size += value.byteLength;
      if (size > maxBytes) {
        stop();
        throw new HorizonResponseTooLargeError(maxBytes);
      }
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** A Horizon GET answered with a status other than 2xx or 404. Carries the status only, never the body. */
class HorizonRequestError extends Error {
  constructor(readonly status: number) {
    super(`Horizon answered HTTP ${status}`);
    this.name = 'HorizonRequestError';
  }
}

function baseUrl(raw: string, allowHttp: boolean): string {
  if (typeof raw !== 'string') throw new InvalidConfigError('horizonUrl is not a URL');
  // `new URL` drops an empty query or fragment (`https://h/?`), and the
  // paths appended later would then land after it: refuse the characters.
  if (raw.includes('?') || raw.includes('#')) {
    throw new InvalidConfigError('horizonUrl must have no query, fragment or credentials');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidConfigError('horizonUrl is not a URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new InvalidConfigError('horizonUrl must use https (set allowHttp for a local http Horizon)');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new InvalidConfigError('horizonUrl must have no query, fragment or credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

function isLedgerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const SEQUENCE = /^[0-9]{1,19}$/;
const DECIMAL = /^[0-9]{1,19}(\.[0-9]{1,7})?$/;

/** An account answer that is not usable. Names the field, never its value. */
function unusableAccount(field: string): Error {
  return new Error(`Horizon returned an account with an unusable ${field}`);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The account from Horizon's answer, known fields only, each checked: the
 * id is the one asked for, the sequence a decimal string, the counts whole
 * numbers and every balance line well formed. Anything else throws.
 */
function toAccount(acc: Record<string, unknown>, address: string): HorizonAccount {
  if (acc['id'] !== address) throw unusableAccount('id');
  const sequence = acc['sequence'];
  if (typeof sequence !== 'string' || !SEQUENCE.test(sequence)) throw unusableAccount('sequence');
  const subentries = acc['subentry_count'];
  if (!isCount(subentries)) throw unusableAccount('subentry_count');
  const counts: { num_sponsoring?: number; num_sponsored?: number } = {};
  for (const key of ['num_sponsoring', 'num_sponsored'] as const) {
    const value = acc[key];
    if (value === undefined) continue;
    if (!isCount(value)) throw unusableAccount(key);
    counts[key] = value;
  }
  const balances = acc['balances'];
  if (!Array.isArray(balances)) throw unusableAccount('balances');
  return { id: address, sequence, subentry_count: subentries, ...counts, balances: balances.map(toBalanceLine) };
}

const ISSUED_TYPES = new Set(['credit_alphanum4', 'credit_alphanum12']);

function toBalanceLine(value: unknown): HorizonBalanceLine {
  const line = asObject(value);
  const type = line['asset_type'];
  const balance = line['balance'];
  if (typeof type !== 'string' || typeof balance !== 'string' || !DECIMAL.test(balance)) throw unusableAccount('balance');
  const out: Record<string, unknown> = { asset_type: type, balance };
  if (ISSUED_TYPES.has(type)) {
    if (typeof line['asset_code'] !== 'string' || typeof line['asset_issuer'] !== 'string') throw unusableAccount('balance');
    out['asset_code'] = line['asset_code'];
    out['asset_issuer'] = line['asset_issuer'];
  }
  for (const key of ['limit', 'buying_liabilities', 'selling_liabilities'] as const) {
    const amount = line[key];
    if (amount === undefined) continue;
    if (typeof amount !== 'string' || !DECIMAL.test(amount)) throw unusableAccount('balance');
    out[key] = amount;
  }
  const authorized = line['is_authorized'];
  if (authorized !== undefined) {
    if (typeof authorized !== 'boolean') throw unusableAccount('balance');
    out['is_authorized'] = authorized;
  }
  return out as unknown as HorizonBalanceLine;
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
  // With join=transactions Horizon embeds the transaction under `transaction`.
  const tx = asObject(r['transaction']);
  if (typeof tx['memo'] === 'string') out['memo'] = tx['memo'];
  if (typeof tx['memo_type'] === 'string') out['memo_type'] = tx['memo_type'];
  return out as unknown as HorizonPaymentRecord;
}

/** Codes Horizon spells differently from the XDR names. */
const CODE_ALIASES: Readonly<Record<string, string>> = { tx_no_account: 'tx_no_source_account' };

/**
 * Result codes of a transaction from its `result_xdr`, named as Horizon
 * names them (`txFailed` becomes `tx_failed`, `paymentUnderfunded` becomes
 * `op_underfunded`). For a fee bump the inner transaction's operations
 * decide. `undefined` when the XDR cannot be read.
 */
function resultCodesFromXdr(resultXdr: string): HorizonResultCodes | undefined {
  try {
    const decoded = asObject(stellarSdk.xdr.TransactionResult.fromXDR(resultXdr, 'base64'));
    let result = asObject(decoded['result']);
    const transaction = xdrCode('tx', result['type']);
    if (transaction === undefined) return undefined;
    const pair = asObject(result['innerResultPair']);
    if (pair['result'] !== undefined) result = asObject(asObject(pair['result'])['result']);
    const ops = Array.isArray(result['results']) ? (result['results'] as unknown[]) : [];
    const operations: string[] = [];
    for (const op of ops) {
      const code = operationCode(asObject(op));
      if (code !== undefined) operations.push(code);
    }
    return { transaction, operations };
  } catch {
    return undefined;
  }
}

function operationCode(op: Record<string, unknown>): string | undefined {
  if (op['type'] !== 'opInner') return xdrCode('op', op['type']);
  const tr = asObject(op['tr']);
  const opType = tr['type'];
  if (typeof opType !== 'string') return undefined;
  for (const [key, value] of Object.entries(tr)) {
    if (key === 'type') continue;
    const name = asObject(value)['type'];
    if (typeof name === 'string' && name.startsWith(opType)) return `op_${snake(name.slice(opType.length))}`;
  }
  return undefined;
}

/** `txFailed` -> `tx_failed`; `opBadAuth` -> `op_bad_auth`. */
function xdrCode(prefix: 'tx' | 'op', name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.startsWith(prefix)) return undefined;
  const code = `${prefix}_${snake(name.slice(prefix.length))}`;
  return CODE_ALIASES[code] ?? code;
}

function snake(camel: string): string {
  return camel
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_/, '')
    .toLowerCase();
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
