import type { Logger, PartnerCall } from '@vindu/grid-core';

import type { BlindPayConfig, FetchLike } from '../src/config';

/** Fake values only. */
export const API_KEY = 'bp_test_SECRET_KEY_0123456789abcdef';
export const INSTANCE_ID = 'in_000000000000';
export const CUSTOMER_ID = 're_000000000000';
export const WALLET_ID = 'bw_000000000000';
export const BANK_ACCOUNT_ID = 'ba_000000000000';
export const STELLAR_ADDRESS = `G${'A'.repeat(55)}`;

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface MockReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Raw text instead of JSON. */
  readonly text?: string;
}

export type Handler = (call: RecordedCall, init: RequestInit) => MockReply | Promise<MockReply>;

/** A fetch mock that records each call. Replies come from a queue or a handler. */
export function mockFetch(replies: MockReply[] | Handler): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { url, method: init.method ?? 'GET', headers, body };
    calls.push(call);
    const reply = queue !== undefined ? queue.shift() : await (replies as Handler)(call, init);
    if (reply === undefined) throw new Error(`no mock reply for ${call.method} ${url}`);
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text === '' ? null : text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

/** Logger and onCall that capture everything, to scan for secrets. */
export function captureOutput(): { logger: Logger; onCall: (c: PartnerCall) => void; lines: string[]; calls: PartnerCall[] } {
  const lines: string[] = [];
  const calls: PartnerCall[] = [];
  const log = (level: string) => (msg: string, fields?: unknown) => {
    lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
  };
  return {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    onCall: (c) => {
      calls.push(c);
      lines.push(`call ${JSON.stringify(c)}`);
    },
    lines,
    calls,
  };
}

export function config(fetch: FetchLike, extra: Partial<BlindPayConfig> = {}): BlindPayConfig {
  return { apiKey: API_KEY, instanceId: INSTANCE_ID, fetch, ...extra };
}

/** Everything an error exposes, including its cause chain, as one string. */
export function dumpError(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.message, cur.stack ?? '', JSON.stringify({ ...cur }));
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join('\n');
}

export async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}
