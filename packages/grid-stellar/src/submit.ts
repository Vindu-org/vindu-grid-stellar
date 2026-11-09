/**
 * Submitting a signed transaction without ever paying twice.
 *
 * The hash is computed locally from the signed envelope before anything is
 * sent, so the transaction can always be looked up. For a fee bump both the
 * outer hash and the inner transaction's hash are computed: anyone can wrap
 * a signed transaction in a fee bump of their own, and the payment it
 * carries lands under that envelope's hash. Lookups use every hash; any one
 * found means the transaction landed. When the submission times out or the
 * network fails, the hashes are checked on Horizon before anything else. Resubmitting the same signed envelope is safe (Stellar
 * applies a transaction once); asking for a new signature is never done here.
 *
 * Horizon's answer is checked too: an accepted submission whose hash is not
 * the locally computed envelope hash is `rejected` with reason
 * `hash_mismatch`, never `success`.
 *
 * **Do not sign a replacement unless the status is `expired_not_landed`**
 * (the transaction's maxTime has passed and it is not on the ledger, so it
 * can never land) or `failed` (it is in a ledger as failed: its sequence
 * number is spent and nothing moved). Every other status means the first
 * transaction could still land.
 */
import { InvalidConfigError, InvalidInputError, type Logger, noopLogger } from '@vindu/grid-core';
import type { HorizonGateway, HorizonSubmitResponse, HorizonTransactionFound } from './horizon';
import { type SubmitError, mapResultCodes } from './result-codes';
import { FeeBumpTransaction, TransactionBuilder } from './sdk';

/** Which locally computed hash found the transaction on Horizon. */
export type FoundBy = 'hash' | 'inner_hash';

/** Facts about a transaction found on the ledger. */
interface Landed {
  /**
   * Hex hash of the transaction as it is on the ledger. Usually the
   * submitted envelope's hash; it differs when the transaction landed
   * inside another envelope (someone else's fee bump).
   */
  readonly hash: string;
  /** Hex hash of the inner transaction, for a fee bump. */
  readonly innerHash?: string;
  readonly ledger?: number;
  /** Present when the result came from a lookup: which local hash found it. */
  readonly foundBy?: FoundBy;
  /** Hex hash of the submitted envelope, present only when it differs from `hash`. */
  readonly submittedHash?: string;
}

export type SubmitResult =
  /** In a ledger and successful. */
  | ({ readonly status: 'success' } & Landed)
  /** In a ledger but failed: the fee and sequence number are spent and nothing moved. */
  | ({ readonly status: 'failed'; readonly error?: SubmitError } & Landed)
  /** Horizon refused it and it is not on the ledger yet. It may still land until its maxTime: do not re-sign. */
  | {
      readonly status: 'rejected';
      readonly reason: 'refused';
      readonly hash: string;
      readonly innerHash?: string;
      readonly error: SubmitError;
    }
  /**
   * Horizon accepted the envelope but answered with a hash that is not the
   * locally computed one. Something is misconfigured (another network) or
   * the answer cannot be trusted. Never a success: the payment may or may
   * not have moved. Do not re-sign; settle it by hand.
   */
  | {
      readonly status: 'rejected';
      readonly reason: 'hash_mismatch';
      readonly hash: string;
      readonly innerHash?: string;
      /** The hash Horizon answered with. */
      readonly returnedHash: string;
    }
  /** Not found, and it could still land (maxTime not passed, or no maxTime). Check again later; do not re-sign. */
  | { readonly status: 'unknown'; readonly hash: string; readonly innerHash?: string; readonly lastError?: SubmitError }
  /** maxTime has passed and it is not on the ledger. It can never land: a replacement may be signed. */
  | { readonly status: 'expired_not_landed'; readonly hash: string; readonly innerHash?: string; readonly maxTime: number };

export type SubmitStatus = SubmitResult['status'];

export interface SubmitOptions {
  readonly gateway: HorizonGateway;
  /** Signed transaction envelope, base64 XDR. */
  readonly signedXdr: string;
  /**
   * Network passphrase the envelope was signed for. The hash depends on it,
   * so it must equal the gateway's `networkPassphrase`.
   */
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
  /** Hex hash of the inner transaction, present only for a fee bump. */
  readonly innerHash?: string;
  /** maxTime in unix seconds, or `undefined` when the transaction has no upper time bound. */
  readonly maxTime: number | undefined;
}

/**
 * Hashes and maxTime of a signed envelope, computed locally. For a fee bump,
 * maxTime is the inner transaction's.
 *
 * @throws {InvalidInputError} when the envelope cannot be decoded.
 */
export function inspectSignedTransaction(signedXdr: string, networkPassphrase: string): SignedTransactionInfo {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new InvalidInputError('signedXdr is not a transaction envelope');
  }
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const raw = inner.timeBounds?.maxTime;
  const maxTime = raw === undefined ? 0 : Number(raw);
  return {
    hash: hex(tx.hash()),
    ...(inner === tx ? {} : { innerHash: hex(inner.hash()) }),
    maxTime: maxTime > 0 ? maxTime : undefined,
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const TIMED_OUT = Symbol('timed out');

/**
 * Submits `signedXdr` and returns what is known about it. Never throws for
 * network or Horizon errors. Throws, before anything is sent, only for
 * invalid options or an envelope that cannot be decoded.
 *
 * @throws {InvalidConfigError} when the gateway's network passphrase is not
 * `networkPassphrase`: the locally computed hash would never be found.
 * @throws {InvalidInputError} when a duration is not a finite number in
 * range, the clock does not return a finite number, or the envelope cannot
 * be decoded.
 */
export async function submitSignedTransaction(options: SubmitOptions): Promise<SubmitResult> {
  const { gateway, signedXdr } = options;
  assertSameNetwork(gateway, options.networkPassphrase);
  const timeoutMs = duration(options.timeoutMs ?? 30_000, 'timeoutMs', 1);
  const pollIntervalMs = duration(options.pollIntervalMs ?? 5_000, 'pollIntervalMs', 1);
  const maxWaitMs = duration(options.maxWaitMs ?? 120_000, 'maxWaitMs', 0);
  const expiryGraceMs = duration(options.expiryGraceMs ?? 30_000, 'expiryGraceMs', 0);
  const resubmit = options.resubmit ?? true;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!Number.isFinite(now())) throw new InvalidInputError('now() must return a finite number of milliseconds');

  const { hash, innerHash, maxTime } = inspectSignedTransaction(signedXdr, options.networkPassphrase);
  const inner = innerHash === undefined ? {} : { innerHash };
  // Every hash the transaction can be found by, the envelope's first.
  const lookups: ReadonlyArray<readonly [string, FoundBy]> =
    innerHash === undefined ? [[hash, 'hash']] : [[hash, 'hash'], [innerHash, 'inner_hash']];
  const expired = (): boolean => maxTime !== undefined && now() > maxTime * 1000 + expiryGraceMs;
  const done = (result: SubmitResult): SubmitResult => {
    logger.info('stellar submission settled', { hash, status: result.status });
    return result;
  };

  async function attempt(): Promise<HorizonSubmitResponse> {
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.resolve().then(() => gateway.submitTransaction(signedXdr));
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

  /**
   * Looks the transaction up by every local hash. `null` when a lookup failed
   * and none found it: a failed lookup never counts as not found.
   */
  async function lookup(): Promise<{ found: HorizonTransactionFound; by: FoundBy } | { found: false } | null> {
    let failed = false;
    for (const [h, by] of lookups) {
      try {
        const result = await gateway.transaction(h);
        if (!result.found) continue;
        if (!HASH.test(result.hash)) throw new Error('Horizon returned a transaction with an invalid hash');
        return { found: result, by };
      } catch (e) {
        failed = true;
        logger.warn('transaction lookup failed', { hash: h, error: e instanceof Error ? e.name : typeof e });
      }
    }
    return failed ? null : { found: false };
  }

  const fromLookup = (found: HorizonTransactionFound, by: FoundBy, error?: SubmitError): SubmitResult => {
    const landedHash = found.hash.toLowerCase();
    const landed = {
      hash: landedHash,
      ...inner,
      ...(found.ledger === undefined ? {} : { ledger: found.ledger }),
      foundBy: by,
      ...(landedHash === hash ? {} : { submittedHash: hash }),
    };
    if (found.successful) return { status: 'success', ...landed };
    return { status: 'failed', ...landed, ...(error === undefined ? {} : { error }) };
  };

  const fromAccepted = (accepted: Extract<HorizonSubmitResponse, { kind: 'accepted' }>): SubmitResult => {
    // Horizon answers with the hash of the envelope it applied, which for a
    // fee bump is the outer hash. Anything else is an error, never a success.
    if (typeof accepted.hash !== 'string' || accepted.hash.toLowerCase() !== hash) {
      const returnedHash = String(accepted.hash);
      logger.error('Horizon returned a different hash', { hash, returned: returnedHash });
      return { status: 'rejected', reason: 'hash_mismatch', hash, ...inner, returnedHash };
    }
    const ledger = accepted.ledger === undefined ? {} : { ledger: accepted.ledger };
    return { status: accepted.successful ? 'success' : 'failed', hash, ...inner, ...ledger };
  };

  const first = await attempt();
  if (first.kind === 'accepted') return done(fromAccepted(first));
  if (first.kind === 'rejected') {
    const error = mapResultCodes(first.transactionCode, first.operationCodes);
    // A rejection of an envelope that already landed (e.g. tx_bad_seq on a
    // retry, or another fee bump around the same transaction) must not hide
    // the landing: check the hashes first.
    const look = await lookup();
    if (look?.found) return done(fromLookup(look.found, look.by, error));
    if (look !== null && maxTime !== undefined && expired()) {
      return done({ status: 'expired_not_landed', hash, ...inner, maxTime });
    }
    logger.warn('stellar submission rejected', { hash, code: error.code });
    return done({ status: 'rejected', reason: 'refused', hash, ...inner, error });
  }

  // Timed out or no answer: the transaction may be on its way. Check the
  // hashes before anything else, and keep checking.
  logger.warn('stellar submission without answer; checking the hash', { hash, kind: first.kind });
  const deadline = now() + maxWaitMs;
  let lastError: SubmitError | undefined;
  for (;;) {
    const look = await lookup();
    if (look?.found) return done(fromLookup(look.found, look.by, lastError));
    if (look !== null && maxTime !== undefined && expired()) {
      return done({ status: 'expired_not_landed', hash, ...inner, maxTime });
    }
    const t = now();
    // A clock that stops returning numbers ends the wait instead of looping forever.
    if (!Number.isFinite(t) || t >= deadline) {
      return done({ status: 'unknown', hash, ...inner, ...(lastError === undefined ? {} : { lastError }) });
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - t)));
    if (resubmit && !expired()) {
      const again = await attempt();
      if (again.kind === 'accepted') return done(fromAccepted(again));
      if (again.kind === 'rejected') lastError = mapResultCodes(again.transactionCode, again.operationCodes);
    }
  }
}

const HASH = /^[0-9a-f]{64}$/i;

/**
 * Throws unless the gateway talks to the network the envelope is signed for.
 * With different passphrases the local hash is not the network's hash, so a
 * landed transaction would look missing.
 */
function assertSameNetwork(gateway: HorizonGateway, networkPassphrase: string): void {
  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0) {
    throw new InvalidConfigError('networkPassphrase is required');
  }
  if (gateway.networkPassphrase !== networkPassphrase) {
    throw new InvalidConfigError("The gateway's network passphrase differs from the submit networkPassphrase");
  }
}

/** Longest delay `setTimeout` honours; anything longer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Fails closed: NaN, Infinity, a non-number or a value out of range throws. */
function duration(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > MAX_TIMER_MS) {
    throw new InvalidInputError(`${name} must be a finite number of milliseconds from ${min} to ${MAX_TIMER_MS}`);
  }
  return value;
}
