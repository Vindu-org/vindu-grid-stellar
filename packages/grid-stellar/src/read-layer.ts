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
 * The cursor only ever moves to a record's own paging token, and only when
 * that is decimal digits: a record without one never resets it or clears
 * it.
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
 * again for the same record (by `reconcile`, or after a crash before the
 * position was stored). Never log the whole record: it carries addresses
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
  /** Records skipped: other operation types, failed transactions, or not touching the account. */
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
    visit: (item: Item, record: HorizonPaymentRecord) => Promise<void>,
    pageDone: () => Promise<void> = async () => undefined,
  ): Promise<{ cursor: string | undefined; hasMore: boolean }> {
    let position = cursor;
    for (let page = 0; page < pages; page += 1) {
      const records = await gateway.paymentsForAccount(account, {
        ...(position === undefined ? {} : { cursor: position }),
        limit: pageSize,
        order: 'asc',
      });
      for (const record of records) {
        await visit(read(record, account), record);
        position = recordPosition(record) ?? position;
      }
      await pageDone();
      if (records.length < pageSize) return { cursor: position, hasMore: false };
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
          async (item, record) => {
            if (item.kind === 'skipped') {
              skipped += 1;
              unsaved = recordPosition(record) ?? unsaved;
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
              unsaved = recordPosition(record) ?? unsaved;
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
            await save(payment.pagingToken);
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
      const end = await scan(account, sinceCursor, reconcileOptions.maxPages ?? maxPages, async (item, record) => {
        if (item.kind === 'skipped') {
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

/** The record's paging token when it is decimal digits, else `undefined`: the position then stays where it was. */
function recordPosition(record: HorizonPaymentRecord): string | undefined {
  const token = stringField(record, 'paging_token');
  return token !== undefined && PAGING_TOKEN.test(token) ? token : undefined;
}

function stringField(record: unknown, key: 'id' | 'paging_token' | 'transaction_hash'): string | undefined {
  const value = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}
