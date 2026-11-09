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
 * Follow the accounts you registered, not a partner's shared treasury
 * address: every client's traffic touches the treasury, so it says nothing
 * about one transfer. A reconciling poll ({@link ReadLayer.reconcile})
 * re-reads a window without moving the main cursor.
 *
 * Logs carry operation ids, transaction hashes and counts only.
 */
import { type Logger, noopLogger } from '@vindu/grid-core';
import type { HorizonGateway } from './horizon';
import { type ChainPayment, normalisePayment } from './payments';

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

export interface ReadLayerOptions {
  readonly gateway: HorizonGateway;
  readonly cursorStore: CursorStore;
  readonly onEvent: OnChainPayment;
  readonly logger?: Logger;
  /** Records per Horizon page, 1 to 200. Default 200. */
  readonly pageSize?: number;
  /** Most pages one call reads before returning with `hasMore: true`. Default 50. */
  readonly maxPages?: number;
}

export interface PollResult {
  /** Payments handed to `onEvent`. */
  readonly delivered: number;
  /** Records skipped: other operation types, or not touching the account. */
  readonly skipped: number;
  /** Cursor after the poll, or `undefined` when nothing was ever read. */
  readonly cursor: string | undefined;
  /** True when `maxPages` was reached before the end of the history. */
  readonly hasMore: boolean;
}

export interface ReconcileResult {
  /** Normalised payments in the window, oldest first. */
  readonly payments: readonly ChainPayment[];
  readonly skipped: number;
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

export function createReadLayer(options: ReadLayerOptions): ReadLayer {
  const { gateway, cursorStore, onEvent } = options;
  const logger = options.logger ?? noopLogger;
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  const maxPages = options.maxPages ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');

  const inFlight = new Set<string>();

  /**
   * Pages forward from `cursor`. `visit` runs for each record in order with
   * its normalised payment (or `null` when skipped); when it resolves the
   * record counts as done.
   */
  async function scan(
    account: string,
    cursor: string | undefined,
    pages: number,
    visit: (payment: ChainPayment | null, pagingToken: string) => Promise<void>,
  ): Promise<{ cursor: string | undefined; hasMore: boolean }> {
    let position = cursor;
    for (let page = 0; page < pages; page += 1) {
      const records = await gateway.paymentsForAccount(account, {
        ...(position === undefined ? {} : { cursor: position }),
        limit: pageSize,
        order: 'asc',
      });
      for (const record of records) {
        await visit(normalisePayment(record, account), record.paging_token);
        position = record.paging_token;
      }
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
        const end = await scan(account, start, maxPages, async (payment, pagingToken) => {
          if (payment === null) {
            skipped += 1;
          } else {
            try {
              await onEvent(payment);
            } catch (e) {
              logger.warn('onEvent failed; payment will be delivered again', {
                paymentId: payment.id,
                txHash: payment.txHash,
                error: e instanceof Error ? e.name : typeof e,
              });
              throw e;
            }
            delivered += 1;
            logger.debug('payment delivered', { paymentId: payment.id, txHash: payment.txHash });
          }
          await cursorStore.set(account, pagingToken);
        });
        logger.info('poll finished', { delivered, skipped, cursor: end.cursor, hasMore: end.hasMore });
        return { delivered, skipped, cursor: end.cursor, hasMore: end.hasMore };
      } finally {
        inFlight.delete(account);
      }
    },

    async reconcile(account, sinceCursor, reconcileOptions = {}) {
      const payments: ChainPayment[] = [];
      let skipped = 0;
      const end = await scan(account, sinceCursor, reconcileOptions.maxPages ?? maxPages, async (payment) => {
        if (payment === null) {
          skipped += 1;
          return;
        }
        payments.push(payment);
        if (reconcileOptions.deliver === true) await onEvent(payment);
      });
      logger.info('reconcile finished', { payments: payments.length, skipped, lastCursor: end.cursor });
      return { payments, skipped, lastCursor: end.cursor, hasMore: end.hasMore };
    },
  };
}
