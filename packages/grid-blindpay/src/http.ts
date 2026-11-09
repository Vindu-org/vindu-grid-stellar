/**
 * The one HTTP function every BlindPay call goes through.
 *
 * - `Authorization: Bearer <apiKey>`, JSON in and out, a timeout per request.
 * - `Idempotency-Key` on every POST and DELETE. When the caller passes none,
 *   one is generated and returned (also on the error), so the caller can store
 *   it and retry with the same key and body.
 * - One `onCall` report per request with metadata only: method, templated path,
 *   status, duration and the ids found in the path. Never the key or a body.
 * - Non-2xx becomes a {@link BlindPayHttpError}. There is no retry loop here:
 *   whether and when to retry is the caller's decision.
 */
import { randomUUID } from 'node:crypto';

import { reportPartnerCall } from '@vindu/grid-core';

import { BLINDPAY_PARTNER_ID, type BlindPayConfig, type ResolvedConfig, resolveConfig } from './config';
import { BlindPayHttpError } from './errors';
import { describePath } from './ids';

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
        partner: BLINDPAY_PARTNER_ID, method: options.method, path: template, status: null,
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
        partner: BLINDPAY_PARTNER_ID, method: options.method, path: template,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...init,
      });
    const report = (status: number | null, error?: string) => {
      const call = {
        partner: BLINDPAY_PARTNER_ID, method: options.method, path: template, status,
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
      });
      text = await response.text();
    } catch (cause) {
      const kind = controller.signal.aborted ? 'timeout' : 'network';
      report(null, kind);
      resolved.logger.warn('blindpay call failed without response', { method: options.method, path: template, error: kind });
      throw fail({ status: null, code: kind, cause });
    } finally {
      clearTimeout(timer);
    }

    report(response.status);
    if (!response.ok) {
      const { code, snippet } = readErrorBody(text);
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
    } catch (cause) {
      // The call may have taken effect: not retryable without checking first.
      throw fail({ status: response.status, code: 'invalid_json', retryable: false, cause });
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

function queryString(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

const CODE_LIKE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;

/**
 * The error body format is UNCONFIRMED. Best effort: a string `code`, then
 * `error` (string or `{ code }`), then a code-shaped `message`. The snippet is
 * the `message` when there is one, else the raw text (core caps its length).
 */
export function readErrorBody(text: string): { code?: string; snippet?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text === '' ? {} : { snippet: text };
  }
  if (typeof parsed !== 'object' || parsed === null) return { snippet: text };
  const o = parsed as Record<string, unknown>;
  const err = o['error'];
  const nested = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const message = str(o['message']) ?? str(nested?.['message']);
  const code =
    str(o['code']) ??
    (typeof err === 'string' && CODE_LIKE_RE.test(err) ? err : undefined) ??
    str(nested?.['code']) ??
    (message !== undefined && CODE_LIKE_RE.test(message) ? message : undefined);
  const snippet = message ?? (typeof err === 'string' ? err : text);
  return { ...(code === undefined ? {} : { code }), snippet };
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
