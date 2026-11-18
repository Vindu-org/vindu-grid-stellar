/**
 * Follows the client's registered Stellar account with the read layer from
 * `@vindu/grid-stellar`, and matches each payment to its leg.
 *
 * The read layer delivers at least once, so payments are kept by id and a
 * repeat delivery is dropped. `InMemoryCursorStore` loses its position on
 * restart; an application keeps the cursor in its own storage.
 */
import {
  type ChainPayment,
  type ExpectedLeg,
  type HorizonGateway,
  InMemoryCursorStore,
  type MatchResult,
  createReadLayer,
  matchPaymentToLeg,
} from '@vindu/grid-stellar';

export interface PollSummary {
  /** Payments seen for the first time in this poll. */
  readonly fresh: readonly ChainPayment[];
  /** Cursor before the poll; `undefined` on the first poll. */
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface ChainWatch {
  poll(): Promise<PollSummary>;
}

/**
 * Matches one payment against the open legs and says why when it does not
 * match. A real application passes the open legs of every transfer here.
 */
export function describeMatch(payment: ChainPayment, legs: readonly ExpectedLeg[]): { matched: boolean; text: string } {
  const result: MatchResult = matchPaymentToLeg(payment, legs);
  switch (result.status) {
    case 'matched':
      return { matched: true, text: `matched ${result.leg.legId} on ${result.matchedOn.join(', ')}` };
    case 'ambiguous':
      return { matched: false, text: `ambiguous: fits ${result.candidates.map((l) => l.legId).join(', ')}` };
    case 'unmatched':
      return {
        matched: false,
        text: `unmatched: ${result.mismatches.map((m) => `${m.legId} failed ${m.failed.join(', ')}`).join('; ')}`,
      };
  }
}

export function watchAccount(gateway: HorizonGateway, account: string): ChainWatch {
  const cursorStore = new InMemoryCursorStore();
  const seen = new Map<string, ChainPayment>();
  let fresh: ChainPayment[] = [];
  const layer = createReadLayer({
    gateway,
    cursorStore,
    onEvent: (payment) => {
      if (seen.has(payment.id)) return; // duplicate delivery
      seen.set(payment.id, payment);
      fresh.push(payment);
    },
  });

  return {
    async poll() {
      fresh = [];
      const from = await cursorStore.get(account);
      const result = await layer.pollAccount(account);
      return { fresh, from, to: result.cursor };
    },
  };
}

