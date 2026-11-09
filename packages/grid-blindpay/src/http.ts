/**
 * The one HTTP function every BlindPay call goes through.
 *
 * - `Authorization: Bearer <apiKey>`, JSON in and out, a timeout per request.
 * - `Idempotency-Key` on every POST and DELETE. When the caller passes none,
 *   one is generated and returned (also on the error), so the caller can store
 *   it and retry with the same key and body.
 * - One `onCall` report per request with metadata only: method, templated path,
 *   status, duration and the ids found in the path. Never the key or a body.
 * - Redirects are never followed (`redirect: 'error'`): a redirect would send
 *   the body again to a URL BlindPay did not choose for us.
 * - Non-2xx becomes a {@link BlindPayHttpError}. There is no retry loop here:
 *   whether and when to retry is the caller's decision.
 */
import { randomUUID } from 'node:crypto';

import { reportPartnerCall } from '@vindu/grid-core';

import { type BlindPayConfig, type ResolvedConfig, resolveConfig } from './config';
import { BlindPayHttpError } from './errors';
import { describePath } from './ids';
import type { ListParams, Page } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly method: HttpMethod;
  /** Path below the instance, e.g. `/customers/re_123`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** For POST and DELETE. Generated when absent. */
  readonly idempotencyKey?: string;
}

export interface HttpResult<T> {
  readonly data: T;
  readonly status: number;
  /** The key sent, for POST and DELETE. */
  readonly idempotencyKey: string | undefined;
  /** True when BlindPay answered `Idempotency-Replayed: true`: the original result was returned. */
  readonly replayed: boolean;
}

export interface BlindPayHttp {
  readonly config: ResolvedConfig;
  request<T>(options: RequestOptions): Promise<HttpResult<T>>;
}

/** Result of a create call: the resource plus the Idempotency-Key that was used. */
export interface Created<T> {
  readonly data: T;
  readonly idempotencyKey: string;
  readonly replayed: boolean;
}

/** Per-call option for every create call. */
export interface IdempotencyOptions {
  /** Reuse the same key, with the same body, when retrying. Generated when absent. */
  readonly idempotencyKey?: string;
}

const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'DELETE']);
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
/** 409 code BlindPay sends while the original request with the same key is still running. */
export const IDEMPOTENCY_IN_FLIGHT = 'idempotency_key_in_flight';

export function createBlindPayHttp(config: BlindPayConfig): BlindPayHttp {
  const { resolved, apiKey } = resolveConfig(config);
  const prefix = `/v1/instances/${resolved.instanceId}`;

  async function request<T>(options: RequestOptions): Promise<HttpResult<T>> {
    const fullPath = `${prefix}${options.path}`;
    const { template, ids } = describePath(fullPath);
    const idempotencyKey = IDEMPOTENT_METHODS.has(options.method)
      ? (options.idempotencyKey ?? randomUUID())
      : undefined;
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new BlindPayHttpError({
        partner: resolved.partnerId, method: options.method, path: template, status: null,
        code: 'invalid_idempotency_key', retryable: false,
      });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;

    const fail = (init: Omit<ConstructorParameters<typeof BlindPayHttpError>[0], 'partner' | 'method' | 'path'>) =>
      new BlindPayHttpError({
        partner: resolved.partnerId, method: options.method, path: template,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...init,
      });
    const report = (status: number | null, error?: string) => {
      const call = {
        partner: resolved.partnerId, method: options.method, path: template, status,
        durationMs: Math.max(0, resolved.now() - started),
        ...(Object.keys(ids).length > 0 ? { ids } : {}),
        ...(error === undefined ? {} : { error }),
      };
      reportPartnerCall(resolved.onCall, call, resolved.logger);
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
    const started = resolved.now();
    let response: Response;
    let text: string;
    try {
      response = await resolved.fetch(`${resolved.baseUrl}${fullPath}${queryString(options.query)}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        // A redirect would re-send the body (and maybe the key) to another URL.
        redirect: 'error',
      });
      text = await response.text();
    } catch (cause) {
      const kind = controller.signal.aborted ? 'timeout' : 'network';
      report(null, kind);
      resolved.logger.warn('blindpay call failed without response', { method: options.method, path: template, error: kind });
      // The raw cause is dropped: a fetch error message can quote headers or the body.
      const causeCode = systemCodeOf(cause);
      throw fail({ status: null, code: kind, ...(causeCode === undefined ? {} : { causeCode }) });
    } finally {
      clearTimeout(timer);
    }

    report(response.status);
    if (!response.ok) {
      const { code, message } = readErrorBody(text);
      const snippet = resolved.includeErrorBodies ? (message ?? (text === '' ? undefined : text)) : undefined;
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), resolved.now());
      resolved.logger.warn('blindpay call failed', {
        method: options.method, path: template, status: response.status, ...(code === undefined ? {} : { partnerCode: code }),
      });
      throw fail({
        status: response.status,
        ...(code === undefined ? {} : { code }),
        ...(snippet === undefined ? {} : { bodySnippet: snippet }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(response.status === 409 ? { retryable: code === IDEMPOTENCY_IN_FLIGHT } : {}),
      });
    }

    let data: T;
    try {
      data = (text === '' ? undefined : JSON.parse(text)) as T;
    } catch {
      // The call may have taken effect, so retry it with the same key and body:
      // BlindPay then replays the original result instead of acting twice.
      // No cause: JSON.parse quotes the start of the body in its message.
      throw fail({ status: response.status, code: 'invalid_json', retryable: true });
    }
    return {
      data,
      status: response.status,
      idempotencyKey,
      replayed: response.headers.get('idempotency-replayed') === 'true',
    };
  }

  return { config: resolved, request };
}

/** Runs a create call and returns the resource with the key that was used. */
export async function create<T>(http: BlindPayHttp, path: string, body: unknown, opts?: IdempotencyOptions): Promise<Created<T>> {
  const res = await http.request<T>({
    method: 'POST', path, body,
    ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
  });
  // Always set for POST.
  return { data: res.data, idempotencyKey: res.idempotencyKey as string, replayed: res.replayed };
}

export async function get<T>(http: BlindPayHttp, path: string, query?: RequestOptions['query']): Promise<T> {
  return (await http.request<T>({ method: 'GET', path, ...(query === undefined ? {} : { query }) })).data;
}

/** GET a list and normalise it: BlindPay returns a bare array unless a pagination param is sent. */
export async function list<T>(http: BlindPayHttp, path: string, params?: ListParams): Promise<Page<T>> {
  const query = params === undefined ? undefined : { ...params };
  const data = await get<readonly T[] | Page<T>>(http, path, query);
  return Array.isArray(data) ? { data } : (data as Page<T>);
}

function queryString(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const CODE_LIKE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;

/**
 * The error body format is UNCONFIRMED. Best effort: a code-shaped `code`,
 * then `error` (string or `{ code }`), then a code-shaped `message`. Only a
 * code-shaped string ever becomes `code`, so free text (which may echo client
 * data) never does. `message` is the free text, used only with `includeErrorBodies`.
 */
export function readErrorBody(text: string): { code?: string; message?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const o = parsed as Record<string, unknown>;
  const err = o['error'];
  const nested = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const message = str(o['message']) ?? str(nested?.['message']) ?? str(err);
  const code = [o['code'], err, nested?.['code'], o['message']].find(
    (v): v is string => typeof v === 'string' && CODE_LIKE_RE.test(v),
  );
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}

const SYSTEM_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** `ECONNREFUSED`-style code from an error or its cause, never a message. */
function systemCodeOf(error: unknown): string | undefined {
  for (let cur = error, depth = 0; typeof cur === 'object' && cur !== null && depth < 3; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && SYSTEM_CODE_RE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds from now. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
