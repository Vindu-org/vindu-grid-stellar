/**
 * Submitting a signed transaction without ever paying twice.
 *
 * The hash is computed locally from the signed envelope before anything is
 * sent, so the transaction can always be looked up. When the submission
 * times out or the network fails, the hash is checked on Horizon before
 * anything else. Resubmitting the same signed envelope is safe (Stellar
 * applies a transaction once); asking for a new signature is never done here.
 *
 * **Do not sign a replacement unless the status is `expired_not_landed`**
 * (the transaction's maxTime has passed and it is not on the ledger, so it
 * can never land) or `failed` (it is in a ledger as failed: its sequence
 * number is spent and nothing moved). Every other status means the first
 * transaction could still land.
 */
import { type Logger, noopLogger } from '@vindu/grid-core';
import type { HorizonGateway, HorizonSubmitResponse, HorizonTransactionLookup } from './horizon';
import { type SubmitError, mapResultCodes } from './result-codes';
import { FeeBumpTransaction, TransactionBuilder } from './sdk';

export type SubmitResult =
  /** In a ledger and successful. */
  | { readonly status: 'success'; readonly hash: string; readonly ledger?: number }
  /** In a ledger but failed: the fee and sequence number are spent and nothing moved. */
  | { readonly status: 'failed'; readonly hash: string; readonly ledger?: number; readonly error?: SubmitError }
  /** Horizon refused it and it is not on the ledger yet. It may still land until its maxTime: do not re-sign. */
  | { readonly status: 'rejected'; readonly hash: string; readonly error: SubmitError }
  /** Not found, and it could still land (maxTime not passed, or no maxTime). Check again later; do not re-sign. */
  | { readonly status: 'unknown'; readonly hash: string; readonly lastError?: SubmitError }
  /** maxTime has passed and it is not on the ledger. It can never land: a replacement may be signed. */
  | { readonly status: 'expired_not_landed'; readonly hash: string; readonly maxTime: number };

export type SubmitStatus = SubmitResult['status'];

export interface SubmitOptions {
  readonly gateway: HorizonGateway;
  /** Signed transaction envelope, base64 XDR. */
  readonly signedXdr: string;
  /** Network passphrase the envelope was signed for. The hash depends on it. */
  readonly networkPassphrase: string;
  /** Longest wait for one submission before treating it as timed out. Default 30 s. */
  readonly timeoutMs?: number;
  /** Pause between hash checks after a timeout. Default 5 s. */
  readonly pollIntervalMs?: number;
  /** Longest total wait after a timeout before returning `unknown`. Default 2 min. */
  readonly maxWaitMs?: number;
  /**
   * Margin after maxTime before `expired_not_landed`, covering clock skew and
   * Horizon ingestion lag. Default 30 s.
   */
  readonly expiryGraceMs?: number;
  /** Resubmit the same signed envelope while waiting. Default true. */
  readonly resubmit?: boolean;
  readonly logger?: Logger;
  /** Clock in ms since epoch. Default `Date.now`. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SignedTransactionInfo {
  /** Hex hash of the envelope (of the outer transaction for a fee bump). */
  readonly hash: string;
  /** maxTime in unix seconds, or `undefined` when the transaction has no upper time bound. */
  readonly maxTime: number | undefined;
}

/** Hash and maxTime of a signed envelope, computed locally. Throws on an invalid envelope. */
export function inspectSignedTransaction(signedXdr: string, networkPassphrase: string): SignedTransactionInfo {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const raw = inner.timeBounds?.maxTime;
  const maxTime = raw === undefined ? 0 : Number(raw);
  return { hash: Buffer.from(tx.hash()).toString('hex'), maxTime: maxTime > 0 ? maxTime : undefined };
}

const TIMED_OUT = Symbol('timed out');

/**
 * Submits `signedXdr` and returns what is known about it. Never throws for
 * network or Horizon errors; throws only for invalid options or an envelope
 * that cannot be decoded.
 */
export async function submitSignedTransaction(options: SubmitOptions): Promise<SubmitResult> {
  const { gateway, signedXdr } = options;
  const timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs');
  const pollIntervalMs = positive(options.pollIntervalMs ?? 5_000, 'pollIntervalMs');
  const maxWaitMs = nonNegative(options.maxWaitMs ?? 120_000, 'maxWaitMs');
  const expiryGraceMs = nonNegative(options.expiryGraceMs ?? 30_000, 'expiryGraceMs');
  const resubmit = options.resubmit ?? true;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const { hash, maxTime } = inspectSignedTransaction(signedXdr, options.networkPassphrase);
  const expired = (): boolean => maxTime !== undefined && now() > maxTime * 1000 + expiryGraceMs;
  const done = (result: SubmitResult): SubmitResult => {
    logger.info('stellar submission settled', { hash, status: result.status });
    return result;
  };

  async function attempt(): Promise<HorizonSubmitResponse> {
    let timer: NodeJS.Timeout | undefined;
    const pending = gateway.submitTransaction(signedXdr);
    pending.catch(() => undefined); // a late rejection after the timeout is not an error here
    try {
      const raced = await Promise.race([
        pending,
        new Promise<typeof TIMED_OUT>((r) => {
          timer = setTimeout(() => r(TIMED_OUT), timeoutMs);
        }),
      ]);
      return raced === TIMED_OUT ? { kind: 'timeout' } : raced;
    } catch (e) {
      logger.warn('stellar submission threw', { hash, error: e instanceof Error ? e.name : typeof e });
      return { kind: 'unavailable', status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookup(): Promise<HorizonTransactionLookup | null> {
    try {
      return await gateway.transaction(hash);
    } catch (e) {
      logger.warn('transaction lookup failed', { hash, error: e instanceof Error ? e.name : typeof e });
      return null;
    }
  }

  const fromLookup = (found: Extract<HorizonTransactionLookup, { found: true }>, error?: SubmitError): SubmitResult => {
    const ledger = found.ledger === undefined ? {} : { ledger: found.ledger };
    if (found.successful) return { status: 'success', hash, ...ledger };
    return { status: 'failed', hash, ...ledger, ...(error === undefined ? {} : { error }) };
  };

  const first = await attempt();
  if (first.kind === 'accepted') {
    if (first.hash !== hash) logger.warn('Horizon returned a different hash', { hash, returned: first.hash });
    const ledger = first.ledger === undefined ? {} : { ledger: first.ledger };
    return done(first.successful ? { status: 'success', hash, ...ledger } : { status: 'failed', hash, ...ledger });
  }
  if (first.kind === 'rejected') {
    const error = mapResultCodes(first.transactionCode, first.operationCodes);
    // A rejection of an envelope that already landed (e.g. tx_bad_seq on a
    // retry) must not hide the landing: check the hash first.
    const found = await lookup();
    if (found?.found === true) return done(fromLookup(found, error));
    if (found !== null && maxTime !== undefined && expired()) return done({ status: 'expired_not_landed', hash, maxTime });
    logger.warn('stellar submission rejected', { hash, code: error.code });
    return done({ status: 'rejected', hash, error });
  }

  // Timed out or no answer: the transaction may be on its way. Check the hash
  // before anything else, and keep checking.
  logger.warn('stellar submission without answer; checking the hash', { hash, kind: first.kind });
  const deadline = now() + maxWaitMs;
  let lastError: SubmitError | undefined;
  for (;;) {
    const found = await lookup();
    if (found?.found === true) return done(fromLookup(found, lastError));
    if (found !== null && maxTime !== undefined && expired()) {
      return done({ status: 'expired_not_landed', hash, maxTime });
    }
    if (now() >= deadline) {
      return done({ status: 'unknown', hash, ...(lastError === undefined ? {} : { lastError }) });
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    if (resubmit && !expired()) {
      const again = await attempt();
      if (again.kind === 'accepted') {
        const ledger = again.ledger === undefined ? {} : { ledger: again.ledger };
        return done(again.successful ? { status: 'success', hash, ...ledger } : { status: 'failed', hash, ...ledger });
      }
      if (again.kind === 'rejected') lastError = mapResultCodes(again.transactionCode, again.operationCodes);
    }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be zero or more`);
  return value;
}
