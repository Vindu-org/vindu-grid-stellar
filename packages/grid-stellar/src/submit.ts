/**
 * Submitting a signed transaction without ever paying twice.
 *
 * The hash is computed locally from the signed envelope before anything is
 * sent, so the transaction can always be looked up. For a fee bump both the
 * outer hash and the inner transaction's hash are computed: anyone can wrap
 * a signed transaction in a fee bump of their own, and the payment it
 * carries lands under that envelope's hash. Lookups use every hash. When the
 * submission times out or the network fails, the hashes are checked on
 * Horizon before anything else. Resubmitting the same signed envelope is
 * safe (Stellar applies a transaction once); asking for a new signature is
 * never done here.
 *
 * Whether a transaction expired is decided by the network, never by the
 * local clock. `expired_not_landed` needs every one of these:
 * - the transaction has a maxTime;
 * - the latest ledger Horizon had ingested (read before the lookups) closed
 *   after that maxTime, so no later ledger can include it;
 * - every lookup that found nothing reports, in Horizon's `Latest-Ledger`
 *   header, an ingested ledger at least as recent as that checked ledger;
 * - the checked instance keeps history back to a ledger no later than the
 *   one read before the first submission (`history_elder_ledger`).
 *
 * A failed or timed-out ledger read or lookup, a missing header, or any
 * other doubt never counts: the result is then `unknown`. Point the gateway
 * at one Horizon instance you operate or trust: behind a load balancer the
 * ledger read and the lookups may hit instances at different ledgers.
 *
 * Horizon's answer to the submission is checked too: an accepted submission
 * whose hash is not the locally computed envelope hash is `rejected` with
 * reason `hash_mismatch`, never `success`.
 *
 * Everything runs within `timeoutMs + maxWaitMs` from the start: every
 * Horizon read is aborted at `requestTimeoutMs` or at that deadline,
 * whichever comes first.
 *
 * **Do not sign a replacement unless the status is `expired_not_landed`**
 * (the transaction's maxTime has passed and it is not on the ledger, so it
 * can never land) or `failed` (it is in a ledger as failed: its sequence
 * number is spent and nothing moved). Every other status means the first
 * transaction could still land.
 */
import {
  InvalidConfigError,
  InvalidInputError,
  type Logger,
  type StellarSubmitter,
  type SubmitOutcomeStatus,
  noopLogger,
} from '@vindu/grid-core';
import type { HorizonGateway, HorizonLedger, HorizonSubmitResponse, HorizonTransactionFound } from './horizon';
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
  /** Not known to be on the ledger, and not proven unable to land. Check again later; do not re-sign. */
  | { readonly status: 'unknown'; readonly hash: string; readonly innerHash?: string; readonly lastError?: SubmitError }
  /**
   * Horizon proved it can never land: see the module documentation for the
   * rule. A replacement may be signed.
   */
  | {
      readonly status: 'expired_not_landed';
      readonly hash: string;
      readonly innerHash?: string;
      /** The transaction's maxTime, unix seconds. */
      readonly maxTime: number;
      /** The ingested ledger that closed after maxTime, and the oldest ledger that instance keeps. */
      readonly checkedLedger: { readonly sequence: number; readonly closedAt: string; readonly elderLedger: number };
      /** The latest ingested ledger read before the first submission. */
      readonly ledgerBeforeSubmission: number;
    };

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
  /**
   * Longest extra wait, after `timeoutMs`, before returning `unknown`.
   * Default 2 min. With 0, no ledger is read before submitting, so the
   * result is never `expired_not_landed`.
   */
  readonly maxWaitMs?: number;
  /**
   * Longest wait for one Horizon read (a ledger read or a lookup). A read
   * that takes longer is abandoned and counts as an error, never as "not
   * found". Default 10 s.
   */
  readonly requestTimeoutMs?: number;
  /** Resubmit the same signed envelope while waiting. Default true. */
  readonly resubmit?: boolean;
  readonly logger?: Logger;
  /**
   * Clock in ms since epoch, for the time budget only. Never decides whether
   * the transaction expired. Read once before sending to fix the deadline;
   * a later reading that is not a finite number ends the run with
   * `unknown`. Default `Date.now`.
   */
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

/** Result of looking the transaction up by every local hash. */
type Lookup =
  | { readonly kind: 'found'; readonly record: HorizonTransactionFound; readonly by: FoundBy }
  /** Every lookup answered "not found"; the ingested ledger each reported, when it did. */
  | { readonly kind: 'not_found'; readonly latestLedgers: ReadonlyArray<number | undefined> }
  /** A lookup failed or timed out, and none found it: proves nothing. */
  | { readonly kind: 'error' };

/**
 * Submits `signedXdr` and returns what is known about it. Never throws for
 * network or Horizon errors. Throws, before anything is sent, only for
 * invalid options or an envelope that cannot be decoded.
 *
 * @throws {InvalidConfigError} when the gateway's network passphrase is not
 * `networkPassphrase`: the locally computed hash would never be found.
 * @throws {InvalidInputError} when a duration is not a finite number in
 * range, the clock does not return a finite number before sending, or the
 * envelope cannot be decoded.
 */
export async function submitSignedTransaction(options: SubmitOptions): Promise<SubmitResult> {
  const { gateway, signedXdr } = options;
  assertSameNetwork(gateway, options.networkPassphrase);
  const { timeoutMs, pollIntervalMs, maxWaitMs, requestTimeoutMs } = durations(options);
  const resubmit = options.resubmit ?? true;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readClock = (): number => {
    try {
      const t = now();
      return typeof t === 'number' ? t : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  // The deadline is fixed once, before anything is sent.
  const deadline = readClock() + timeoutMs + maxWaitMs;
  if (!Number.isFinite(deadline)) throw new InvalidInputError('now() must return a finite number of milliseconds');

  const { hash, innerHash, maxTime } = inspectSignedTransaction(signedXdr, options.networkPassphrase);
  const inner = innerHash === undefined ? {} : { innerHash };
  // Every hash the transaction can be found by, the envelope's first.
  const lookups: ReadonlyArray<readonly [string, FoundBy]> =
    innerHash === undefined ? [[hash, 'hash']] : [[hash, 'hash'], [innerHash, 'inner_hash']];
  const done = (result: SubmitResult): SubmitResult => {
    logger.info('stellar submission settled', { hash, status: result.status });
    return result;
  };
  const unknown = (lastError: SubmitError | undefined): SubmitResult =>
    done({ status: 'unknown', hash, ...inner, ...(lastError === undefined ? {} : { lastError }) });

  /**
   * Runs `call` for at most `limitMs`, and never past the deadline unless
   * `ignoreDeadline`. On time out the signal aborts and the result is
   * `TIMED_OUT`. A broken clock leaves no time. Rejects when `call` does.
   */
  async function bounded<T>(
    limitMs: number,
    call: (signal: AbortSignal) => Promise<T>,
    ignoreDeadline = false,
  ): Promise<T | typeof TIMED_OUT> {
    const ms = ignoreDeadline ? limitMs : Math.min(limitMs, deadline - readClock());
    if (!(ms > 0)) return TIMED_OUT;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const pending = Promise.resolve().then(() => call(controller.signal));
    pending.catch(() => undefined); // a late rejection after the timeout is not an error here
    try {
      return await Promise.race([
        pending,
        new Promise<typeof TIMED_OUT>((r) => {
          timer = setTimeout(() => {
            controller.abort();
            r(TIMED_OUT);
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One submission. The first always gets the full `timeoutMs`; resubmissions only what is left. */
  async function attempt(first: boolean): Promise<HorizonSubmitResponse> {
    try {
      const raced = await bounded(timeoutMs, () => gateway.submitTransaction(signedXdr), first);
      return raced === TIMED_OUT ? { kind: 'timeout' } : raced;
    } catch (e) {
      logger.warn('stellar submission threw', { hash, error: errorName(e) });
      return { kind: 'unavailable', status: null };
    }
  }

  /** Looks the transaction up by every local hash. A failed or timed-out lookup never counts as not found. */
  async function lookup(): Promise<Lookup> {
    let failed = false;
    const latestLedgers: Array<number | undefined> = [];
    for (const [h, by] of lookups) {
      try {
        const result = await bounded(requestTimeoutMs, (signal) => gateway.transaction(h, { signal }));
        if (result === TIMED_OUT) {
          failed = true;
          logger.warn('transaction lookup timed out', { hash: h });
          continue;
        }
        if (!result.found) {
          latestLedgers.push(result.latestLedger);
          continue;
        }
        if (!HASH.test(result.hash)) throw new Error('Horizon returned a transaction with an invalid hash');
        return { kind: 'found', record: result, by };
      } catch (e) {
        failed = true;
        logger.warn('transaction lookup failed', { hash: h, error: errorName(e) });
      }
    }
    return failed ? { kind: 'error' } : { kind: 'not_found', latestLedgers };
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

  /** Horizon's latest ingested ledger, or `null` when it cannot be read in time or makes no sense. */
  async function latestLedger(limitMs: number): Promise<HorizonLedger | null> {
    try {
      const ledger = await bounded(limitMs, (signal) => gateway.latestLedger({ signal }));
      if (ledger === TIMED_OUT) {
        logger.warn('latest ledger read timed out', { hash });
        return null;
      }
      const closedAt = ledger.closedAt instanceof Date ? ledger.closedAt.getTime() : Number.NaN;
      if (isLedgerNumber(ledger.sequence) && Number.isFinite(closedAt)) return ledger;
      logger.warn('latest ledger unusable', { hash });
    } catch (e) {
      logger.warn('latest ledger read failed', { hash, error: errorName(e) });
    }
    return null;
  }

  /**
   * Why the evidence does not prove that the transaction can never land, or
   * `null` when it does.
   */
  function expiryDoubt(
    before: HorizonLedger | null,
    checked: HorizonLedger,
    latestLedgers: ReadonlyArray<number | undefined>,
  ): string | null {
    if (maxTime === undefined || !(Math.floor(checked.closedAt.getTime() / 1000) > maxTime)) return 'not_past_max_time';
    if (before === null) return 'no_ledger_before_submission';
    if (latestLedgers.length !== lookups.length) return 'lookup_missing';
    if (!latestLedgers.every((l) => isLedgerNumber(l) && l >= checked.sequence)) return 'lookup_behind_checked_ledger';
    if (!isLedgerNumber(checked.elderLedger) || checked.elderLedger > before.sequence) {
      return 'history_does_not_cover_submission';
    }
    return null;
  }

  /**
   * Reads the ledger first (only when there is a maxTime), then looks the
   * transaction up, so the lookups are made after that ledger was ingested.
   * Settles on a landing or on proven expiry.
   * `null`: not settled.
   */
  async function probe(before: HorizonLedger | null, error?: SubmitError): Promise<SubmitResult | null> {
    const checked = maxTime === undefined ? null : await latestLedger(requestTimeoutMs);
    const look = await lookup();
    if (look.kind === 'found') return fromLookup(look.record, look.by, error);
    if (look.kind === 'error' || checked === null || maxTime === undefined) return null;
    const doubt = expiryDoubt(before, checked, look.latestLedgers);
    if (doubt !== null) {
      if (doubt !== 'not_past_max_time') logger.warn('expiry not proven', { hash, reason: doubt });
      return null;
    }
    return {
      status: 'expired_not_landed',
      hash,
      ...inner,
      maxTime,
      checkedLedger: {
        sequence: checked.sequence,
        closedAt: checked.closedAt.toISOString(),
        elderLedger: checked.elderLedger as number,
      },
      ledgerBeforeSubmission: (before as HorizonLedger).sequence,
    };
  }

  // The ledger before the first submission bounds where the transaction can
  // be: Horizon's history must reach back to it for "not found" to mean
  // anything. It comes out of the wait budget, so the first submission
  // still gets its full timeoutMs.
  const before = maxTime === undefined || maxWaitMs === 0 ? null : await latestLedger(Math.min(requestTimeoutMs, maxWaitMs));

  const first = await attempt(true);
  if (first.kind === 'accepted') return done(fromAccepted(first));
  if (first.kind === 'rejected') {
    const error = mapResultCodes(first.transactionCode, first.operationCodes);
    // A rejection of an envelope that already landed (e.g. tx_bad_seq on a
    // retry, or another fee bump around the same transaction) must not hide
    // the landing: check the hashes first.
    const settled = await probe(before, error);
    if (settled !== null) return done(settled);
    logger.warn('stellar submission rejected', { hash, code: error.code });
    return done({ status: 'rejected', reason: 'refused', hash, ...inner, error });
  }

  // Timed out or no answer: the transaction may be on its way. Check the
  // hashes before anything else, and keep checking. The number of rounds is
  // bounded too, so a clock that stops moving cannot keep the loop alive.
  logger.warn('stellar submission without answer; checking the hash', { hash, kind: first.kind });
  const rounds = Math.floor(maxWaitMs / pollIntervalMs) + 1;
  let lastError: SubmitError | undefined;
  for (let round = 1; ; round += 1) {
    const settled = await probe(before, lastError);
    if (settled !== null) return done(settled);
    const t = readClock();
    if (!Number.isFinite(t) || round >= rounds || t + pollIntervalMs >= deadline) return unknown(lastError);
    await sleep(pollIntervalMs);
    // Resubmitting after maxTime is harmless: the network refuses it as too late.
    if (resubmit) {
      const again = await attempt(false);
      if (again.kind === 'accepted') return done(fromAccepted(again));
      if (again.kind === 'rejected') lastError = mapResultCodes(again.transactionCode, again.operationCodes);
    }
  }
}

const HASH = /^[0-9a-f]{64}$/i;

function isLedgerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

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

function durations(options: Omit<SubmitOptions, 'signedXdr'>) {
  return {
    timeoutMs: duration(options.timeoutMs ?? 30_000, 'timeoutMs', 1),
    pollIntervalMs: duration(options.pollIntervalMs ?? 5_000, 'pollIntervalMs', 1),
    maxWaitMs: duration(options.maxWaitMs ?? 120_000, 'maxWaitMs', 0),
    requestTimeoutMs: duration(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs', 1),
  };
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

/** Everything a {@link SubmitResult} says besides its status and hash. Never the signed XDR. */
export type StellarSubmitDetail = {
  readonly innerHash?: string;
  readonly ledger?: number;
  readonly foundBy?: FoundBy;
  readonly submittedHash?: string;
  /** `rejected` only: `refused` by Horizon, or `hash_mismatch`. */
  readonly reason?: 'refused' | 'hash_mismatch';
  readonly returnedHash?: string;
  readonly error?: SubmitError;
  readonly lastError?: SubmitError;
  readonly maxTime?: number;
  readonly checkedLedger?: { readonly sequence: number; readonly closedAt: string; readonly elderLedger: number };
  readonly ledgerBeforeSubmission?: number;
};

/** Core's `SubmitOutcome` with the full {@link StellarSubmitDetail}, on every status. */
export type StellarSubmitOutcome =
  | { readonly status: 'success'; readonly hash: string; readonly detail: StellarSubmitDetail }
  | {
      readonly status: Exclude<SubmitOutcomeStatus, 'success'>;
      readonly hash: string;
      readonly detail: StellarSubmitDetail;
    };

/** A core `StellarSubmitter` whose outcomes also carry the full detail. */
export interface DetailedStellarSubmitter extends StellarSubmitter {
  submit(signedXdr: string): Promise<StellarSubmitOutcome>;
}

export type StellarSubmitterOptions = Omit<SubmitOptions, 'signedXdr'>;

/**
 * Core's `SubmitOutcome` for a {@link SubmitResult}. The status is the same
 * word with the same meaning (only `success` lets a payout be created; only
 * `failed` and `expired_not_landed` allow a replacement). Every other field
 * moves to `detail` unchanged, so nothing is lost: for a hash mismatch
 * `detail.reason` is `'hash_mismatch'`.
 */
export function toSubmitOutcome(result: SubmitResult): StellarSubmitOutcome {
  const { status, hash, ...detail } = result;
  return { status, hash, detail } as StellarSubmitOutcome;
}

/**
 * Core's `StellarSubmitter` over {@link submitSignedTransaction}, for the
 * signed payout flow. Each `submit` runs `submitSignedTransaction` with these
 * options and returns {@link toSubmitOutcome} of its result.
 *
 * The options are checked here, once, before any transaction exists.
 *
 * @throws {InvalidConfigError} when the gateway's network passphrase is not `networkPassphrase`.
 * @throws {InvalidInputError} when a duration is not a finite number in range.
 */
export function createStellarSubmitter(options: StellarSubmitterOptions): DetailedStellarSubmitter {
  assertSameNetwork(options.gateway, options.networkPassphrase);
  durations(options);
  return {
    async submit(signedXdr) {
      return toSubmitOutcome(await submitSignedTransaction({ ...options, signedXdr }));
    },
  };
}
