/**
 * The read layer: follows payments on registered Stellar accounts.
 *
 * For each account it keeps a cursor (Horizon's paging token), pages through
 * new payments in ascending order, normalises each one and hands it to
 * `onEvent`. The cursor moves past a payment only after `onEvent` resolves,
 * so delivery is at least once: after a crash or a failed `onEvent` the same
 * payment is delivered again. **The consumer must drop duplicates by
 * `payment.id`.**
 *
 * A record that cannot be normalised (for example an amount that is not a
 * valid decimal, no string `id` or `transaction_hash`, or a `paging_token`
 * that is not decimal digits) never blocks the cursor: `onMalformed` is
 * called with it and the error, then the layer moves on. By default that
 * logs a warning with the operation id and transaction hash only. Throw
 * from `onMalformed` to stop instead; the cursor then stays before that
 * record.
 *
 * The cursor only ever moves forward, to a record's own position, compared
 * as integers: its paging token when that is decimal digits, otherwise (for
 * a malformed record) its operation id when that is, since Horizon uses the
 * same number for both. A record whose position is not greater than the
 * current one is passed over without moving the cursor: a payment there is
 * skipped (not delivered), a malformed record still goes to `onMalformed`.
 * A malformed record's position (its paging token or its fallback operation
 * id alike) is used only when it is also lower than the paging token of the
 * next readable record on the same page, so a huge number on a broken record
 * cannot jump the cursor past the payments after it. With no readable record
 * after it on the page, the position is used only when nothing else on the
 * page moves the cursor; otherwise the record is passed over and seen again
 * at the head of the next page, where the payment after it bounds it. A record with no position never resets or
 * clears the cursor. A full page that does not move the position at all
 * cannot be passed: the call then throws rather than read the same page
 * again.
 *
 * Positions past skipped and malformed records are stored once per page
 * (or before stopping), not once per record.
 *
 * Follow the accounts you registered, not a partner's shared treasury
 * address: every client's traffic touches the treasury, so it says nothing
 * about one transfer. A reconciling poll ({@link ReadLayer.reconcile})
 * re-reads a window without moving the main cursor.
 *
 * Logs carry operation ids, transaction hashes and counts only.
 */
import { type Logger, noopLogger } from '@vindu/grid-core';
import type { HorizonGateway, HorizonPaymentRecord } from './horizon';
import { type ChainPayment, PAGING_TOKEN, normalisePayment } from './payments';

/** Where the read layer keeps its position per account. Persist it in your own storage. */
export interface CursorStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, cursor: string): Promise<void>;
}

/** {@link CursorStore} in memory. For demos and tests: positions are lost on restart. */
export class InMemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.cursors.get(account);
  }

  async set(account: string, cursor: string): Promise<void> {
    this.cursors.set(account, cursor);
  }
}

/** Receives each payment. Throw (or reject) to stop the poll; the payment is delivered again next time. */
export type OnChainPayment = (payment: ChainPayment) => Promise<void> | void;

/**
 * Receives a record that could not be normalised, and why. Resolve to skip
 * it; throw to stop the poll with the cursor before it. It may be called
 * again for the same record (by `reconcile`, after a crash before the
 * position was stored, or when it was passed over at the end of a page and
 * comes back at the head of the next). Never log the whole record: it carries addresses
 * and memos.
 */
export type OnMalformedPayment = (record: HorizonPaymentRecord, error: unknown) => Promise<void> | void;

export interface ReadLayerOptions {
  readonly gateway: HorizonGateway;
  readonly cursorStore: CursorStore;
  readonly onEvent: OnChainPayment;
  /** Default: a warning with the operation id, the transaction hash and the error name. */
  readonly onMalformed?: OnMalformedPayment;
  readonly logger?: Logger;
  /** Records per Horizon page, 1 to 200. Default 200. */
  readonly pageSize?: number;
  /** Most pages one call reads before returning with `hasMore: true`. Default 50. */
  readonly maxPages?: number;
}

export interface PollResult {
  /** Payments handed to `onEvent`. */
  readonly delivered: number;
  /**
   * Records skipped: other operation types, failed transactions, not
   * touching the account, or not past the cursor.
   */
  readonly skipped: number;
  /** Records that could not be normalised, handed to `onMalformed` and passed over. */
  readonly malformed: number;
  /** Cursor after the poll, or `undefined` when nothing was ever read. */
  readonly cursor: string | undefined;
  /** True when `maxPages` was reached before the end of the history. */
  readonly hasMore: boolean;
}

export interface ReconcileResult {
  /** Normalised payments in the window, oldest first. */
  readonly payments: readonly ChainPayment[];
  readonly skipped: number;
  /** Records handed to `onMalformed`. */
  readonly malformed: number;
  /** Paging token of the last record read; pass it as `sinceCursor` to continue. */
  readonly lastCursor: string | undefined;
  readonly hasMore: boolean;
}

export interface ReconcileOptions {
  /** Most pages to read. Default: the layer's `maxPages`. */
  readonly maxPages?: number;
  /** Also hand each payment to `onEvent`. Default false. The main cursor never moves either way. */
  readonly deliver?: boolean;
}

export interface ReadLayer {
  /**
   * Reads new payments for `account` from its stored cursor and delivers them
   * in order. Rejects with `onEvent`'s error when it fails; the cursor then
   * stays before that payment. One poll per account at a time: a second
   * concurrent call for the same account rejects.
   */
  pollAccount(account: string): Promise<PollResult>;
  /**
   * Re-reads payments for `account` after `sinceCursor` (from the start when
   * absent), with the same normalisation. Never moves the stored cursor.
   */
  reconcile(account: string, sinceCursor?: string, options?: ReconcileOptions): Promise<ReconcileResult>;
}

const MAX_PAGE_SIZE = 200;

/** One record, read: a payment, a record this layer does not report, or one it could not read. */
type Item =
  | { readonly kind: 'payment'; readonly payment: ChainPayment }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'malformed'; readonly error: unknown };

/**
 * Where a record moves the cursor: `position` when it moves it forward,
 * `undefined` when it does not. `behind` is true for a readable record whose
 * position is not past the current one; it is passed over.
 */
interface Step {
  readonly position: string | undefined;
  readonly behind: boolean;
}

export function createReadLayer(options: ReadLayerOptions): ReadLayer {
  const { gateway, cursorStore, onEvent } = options;
  const logger = options.logger ?? noopLogger;
  const onMalformed: OnMalformedPayment =
    options.onMalformed ??
    ((record, error) => {
      logger.warn('payment record could not be read; skipped', {
        paymentId: stringField(record, 'id'),
        txHash: stringField(record, 'transaction_hash'),
        error: error instanceof Error ? error.name : typeof error,
      });
    });
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  const maxPages = options.maxPages ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');

  const inFlight = new Set<string>();

  function read(record: HorizonPaymentRecord, account: string): Item {
    try {
      const payment = normalisePayment(record, account);
      return payment === null ? { kind: 'skipped' } : { kind: 'payment', payment };
    } catch (error) {
      return { kind: 'malformed', error };
    }
  }

  /**
   * Pages forward from `cursor`. `visit` runs for each record in order;
   * when it resolves the record counts as done. `pageDone` runs after each
   * page with the position reached.
   */
  async function scan(
    account: string,
    cursor: string | undefined,
    pages: number,
    visit: (item: Item, record: HorizonPaymentRecord, step: Step) => Promise<void>,
    pageDone: () => Promise<void> = async () => undefined,
  ): Promise<{ cursor: string | undefined; hasMore: boolean }> {
    let position = cursor;
    for (let page = 0; page < pages; page += 1) {
      const records = await gateway.paymentsForAccount(account, {
        ...(position === undefined ? {} : { cursor: position }),
        limit: pageSize,
        order: 'asc',
      });
      const before = position;
      const items = records.map((record) => read(record, account));
      const steps = planPage(records, items, position);
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i]!;
        const item = items[i]!;
        const step = steps[i]!;
        if (step.behind) {
          logger.warn('payment record not past the cursor; passed over', {
            paymentId: stringField(record, 'id'),
            txHash: stringField(record, 'transaction_hash'),
          });
        }
        await visit(item, record, step);
        position = step.position ?? position;
      }
      await pageDone();
      if (records.length < pageSize) return { cursor: position, hasMore: false };
      if (position === before) {
        // Reading on would ask for this same page again, forever.
        logger.error('payments page does not move the cursor', { records: records.length });
        throw new Error('Horizon returned a full payments page with no position past the cursor');
      }
    }
    return { cursor: position, hasMore: true };
  }

  return {
    async pollAccount(account) {
      if (inFlight.has(account)) throw new Error('A poll for this account is already running');
      inFlight.add(account);
      try {
        const start = await cursorStore.get(account);
        let delivered = 0;
        let skipped = 0;
        let malformed = 0;
        // Position past skipped or malformed records, not stored yet.
        let unsaved: string | undefined;
        const save = async (cursor: string): Promise<void> => {
          await cursorStore.set(account, cursor);
          unsaved = undefined;
        };
        // Before stopping, keep what was passed over, so it is not read again.
        const saveBeforeStopping = async (): Promise<void> => {
          if (unsaved === undefined) return;
          try {
            await save(unsaved);
          } catch {
            // The original error matters more; the records are re-read next time.
          }
        };

        const end = await scan(
          account,
          start,
          maxPages,
          async (item, record, step) => {
            if (item.kind === 'skipped' || step.behind) {
              skipped += 1;
              unsaved = step.position ?? unsaved;
              return;
            }
            if (item.kind === 'malformed') {
              try {
                await onMalformed(record, item.error);
              } catch (e) {
                await saveBeforeStopping();
                throw e;
              }
              malformed += 1;
              unsaved = step.position ?? unsaved;
              return;
            }
            const { payment } = item;
            try {
              await onEvent(payment);
            } catch (e) {
              logger.warn('onEvent failed; payment will be delivered again', {
                paymentId: payment.id,
                txHash: payment.txHash,
                error: e instanceof Error ? e.name : typeof e,
              });
              await saveBeforeStopping();
              throw e;
            }
            delivered += 1;
            logger.debug('payment delivered', { paymentId: payment.id, txHash: payment.txHash });
            await save(step.position ?? payment.pagingToken);
          },
          async () => {
            if (unsaved !== undefined) await save(unsaved);
          },
        );
        logger.info('poll finished', { delivered, skipped, malformed, cursor: end.cursor, hasMore: end.hasMore });
        return { delivered, skipped, malformed, cursor: end.cursor, hasMore: end.hasMore };
      } finally {
        inFlight.delete(account);
      }
    },

    async reconcile(account, sinceCursor, reconcileOptions = {}) {
      const payments: ChainPayment[] = [];
      let skipped = 0;
      let malformed = 0;
      const end = await scan(account, sinceCursor, reconcileOptions.maxPages ?? maxPages, async (item, record, step) => {
        if (item.kind === 'skipped' || step.behind) {
          skipped += 1;
          return;
        }
        if (item.kind === 'malformed') {
          await onMalformed(record, item.error);
          malformed += 1;
          return;
        }
        payments.push(item.payment);
        if (reconcileOptions.deliver === true) await onEvent(item.payment);
      });
      logger.info('reconcile finished', { payments: payments.length, skipped, malformed, lastCursor: end.cursor });
      return { payments, skipped, malformed, lastCursor: end.cursor, hasMore: end.hasMore };
    },
  };
}

/**
 * How each record of a page moves the cursor from `start`. Positions only
 * move forward, compared as integers:
 * - a readable record moves it to its paging token when that is past the
 *   position reached, and is `behind` otherwise;
 * - a malformed record's position is its paging token when that is decimal
 *   digits, else its operation id when that is. Either one is used only when
 *   it is past the position reached and lower than the paging token of the
 *   next readable record on the page: a broken record's numbers are not
 *   trusted beyond the readable records around it. With no readable record
 *   after it, the position is used only when nothing else on the page moves
 *   the cursor (a full page would otherwise be read again forever); else the
 *   record is passed over and the next page, read from the position reached,
 *   bounds it.
 */
function planPage(
  records: readonly HorizonPaymentRecord[],
  items: readonly Item[],
  start: string | undefined,
): Step[] {
  // The paging token of the next readable record after each index.
  const bounds = new Array<bigint | undefined>(records.length);
  let next: bigint | undefined;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    bounds[i] = next;
    // normalisePayment only reads a record whose paging_token is decimal digits.
    if (items[i]!.kind !== 'malformed') next = BigInt(records[i]!.paging_token);
  }
  const plan = (unbounded: boolean): { steps: Step[]; end: string | undefined } => {
    let position = start;
    const steps = records.map((record, i): Step => {
      const step = stepFor(items[i]!, record, position, bounds[i], unbounded);
      position = step.position ?? position;
      return step;
    });
    return { steps, end: position };
  };
  const bounded = plan(false);
  return bounded.end === start ? plan(true).steps : bounded.steps;
}

/** One record's {@link Step}; see {@link planPage}. */
function stepFor(
  item: Item,
  record: HorizonPaymentRecord,
  current: string | undefined,
  bound: bigint | undefined,
  unbounded: boolean,
): Step {
  if (item.kind !== 'malformed') {
    const token = record.paging_token;
    return isPast(token, current) ? { position: token, behind: false } : { position: undefined, behind: true };
  }
  const position = recordPosition(record);
  const usable =
    position !== undefined && isPast(position, current) && (bound === undefined ? unbounded : BigInt(position) < bound);
  return { position: usable ? position : undefined, behind: false };
}

/**
 * Whether decimal `position` is greater than `current`, compared as integers.
 * Any position is past the start (`undefined`), and past a stored cursor that
 * is not decimal digits, which cannot be compared.
 */
function isPast(position: string, current: string | undefined): boolean {
  if (current === undefined || !PAGING_TOKEN.test(current)) return true;
  return BigInt(position) > BigInt(current);
}

/**
 * Where the record sits: its paging token when that is decimal digits, else
 * its operation id when that is (Horizon gives both the same number), else
 * `undefined`, and the position stays where it was.
 */
function recordPosition(record: HorizonPaymentRecord): string | undefined {
  for (const key of ['paging_token', 'id'] as const) {
    const value = stringField(record, key);
    if (value !== undefined && PAGING_TOKEN.test(value)) return value;
  }
  return undefined;
}

function stringField(record: unknown, key: 'id' | 'paging_token' | 'transaction_hash'): string | undefined {
  const value = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}
