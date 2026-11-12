/**
 * Routing: pick the partner and chain for a transfer, once, at quote time.
 *
 * 1. Keep partners where the client is approved and the corridor is supported.
 * 2. Keep partners with a ready account for the client (on Stellar: account
 *    funded, trustline set, account registered with the partner).
 * 3. If a Stellar route remains, select it. The Stellar route has priority. The
 *    optional price limit is only a safeguard against an abnormal quote: the
 *    Stellar route loses only when its price is worse than the best
 *    alternative by more than `stellarPriceLimitBps`.
 * 4. Without a Stellar route (or with Stellar routing disabled), pick the best price.
 *
 * Prices are compared as cost: source paid per unit of target received. The
 * gap is `(stellarCost - bestCost) / bestCost`, so "1% worse" means the
 * Stellar route needs 1% more source for the same target. The measure is the
 * same whether the partners quoted a fixed source or a fixed target.
 *
 * Only eligible candidates are checked for well-formed prices. A candidate
 * already excluded (e.g. not approved) is reported in `excluded` whatever its
 * price, so one bad quote from an unusable partner never blocks routing.
 *
 * The chosen route is stored on the transfer and never changes after the
 * funding leg is created: the client's money is already committed to that
 * partner, so there is no silent failover. See {@link assertRouteImmutable}.
 */
import type { CapabilityRegistry, Corridor } from './capabilities';
import { supportsCorridor } from './capabilities';
import { InvalidMoneyError, RouteImmutableError, RouteNotFoundError } from './errors';
import { type Money, assertBps, assertSameAsset, toUnits } from './money';
import type { Chain, PartnerId } from './ports';
import type { TransferState } from './transfer-states';

export const STELLAR: Chain = 'stellar';

/** All-in price of a route: what the client pays and what the beneficiary gets, fees included. */
export interface RoutePrice {
  readonly source: Money;
  readonly target: Money;
}

export interface RouteCandidate {
  readonly partner: PartnerId;
  readonly chain: Chain;
  /** The partner has approved this client. */
  readonly customerApproved: boolean;
  /** The client's account on this partner and chain is ready to receive and pay out. */
  readonly accountReady: boolean;
  readonly price: RoutePrice;
}

export interface RouteOptions {
  readonly registry: CapabilityRegistry;
  readonly corridor: Corridor;
  /** When false, Stellar candidates compete on price like any other. */
  readonly stellarRoutingEnabled: boolean;
  /**
   * Safeguard against an abnormal Stellar quote, in integer basis points of
   * cost (source per unit of target). When set, the Stellar route loses only
   * if it costs more than the best alternative by more than this. When
   * undefined, the Stellar route always wins.
   */
  readonly stellarPriceLimitBps?: number;
}

/** What is stored on the transfer. Fixed once the funding leg exists. */
export interface Route {
  readonly partner: PartnerId;
  readonly chain: Chain;
}

export type RouteReason =
  /** A Stellar route was selected by priority. */
  | 'stellar_priority'
  /** A Stellar route existed but its price exceeded the safeguard limit; best alternative selected. */
  | 'stellar_price_limit_exceeded'
  /** No eligible Stellar route; best price selected. */
  | 'best_price'
  /** Stellar routing is disabled; best price selected among all routes. */
  | 'stellar_routing_disabled';

export type ExclusionReason =
  | 'unknown_partner'
  | 'customer_not_approved'
  | 'corridor_unsupported'
  | 'account_not_ready';

export interface CandidateExclusion {
  readonly partner: PartnerId;
  readonly chain: Chain;
  readonly reason: ExclusionReason;
}

export interface RouteDecision {
  readonly route: Route;
  readonly price: RoutePrice;
  readonly reason: RouteReason;
  /**
   * How much more the best Stellar route costs than the best other route
   * (source per unit of target), in basis points rounded up to 0.01; 0 when
   * it costs no more. Present when both exist.
   */
  readonly stellarPriceGapBps?: number;
  readonly excluded: readonly CandidateExclusion[];
}

/**
 * Selects the route for a transfer.
 * @throws {RouteNotFoundError} when no candidate survives the filters.
 * @throws {AssetMismatchError} when candidates quote different assets.
 */
export function selectRoute(
  candidates: readonly RouteCandidate[],
  options: RouteOptions,
): RouteDecision {
  if (options.stellarPriceLimitBps !== undefined) {
    assertBps(options.stellarPriceLimitBps, 'stellarPriceLimitBps');
  }
  assertNoDuplicates(candidates);

  const excluded: CandidateExclusion[] = [];
  const eligible: RouteCandidate[] = [];
  for (const c of candidates) {
    const reason = exclusionReason(c, options);
    if (reason === undefined) eligible.push(c);
    else excluded.push({ partner: c.partner, chain: c.chain, reason });
  }
  assertPricesWellFormed(eligible);

  const ranked = [...eligible].sort(byPriceThenId);
  const best = ranked[0];
  if (best === undefined) throw new RouteNotFoundError(excluded);

  const decide = (c: RouteCandidate, reason: RouteReason, gap?: number): RouteDecision => ({
    route: { partner: c.partner, chain: c.chain },
    price: c.price,
    reason,
    ...(gap === undefined ? {} : { stellarPriceGapBps: gap }),
    excluded,
  });

  if (!options.stellarRoutingEnabled) return decide(best, 'stellar_routing_disabled');

  const stellar = ranked.find((c) => c.chain === STELLAR);
  if (stellar === undefined) return decide(best, 'best_price');

  const alternative = ranked.find((c) => c.chain !== STELLAR);
  if (alternative === undefined) return decide(stellar, 'stellar_priority');

  const gap = priceGapBps(stellar.price, alternative.price);
  const limit = options.stellarPriceLimitBps;
  if (limit !== undefined && worseByMoreThan(stellar.price, alternative.price, limit)) {
    return decide(alternative, 'stellar_price_limit_exceeded', gap);
  }
  return decide(stellar, 'stellar_priority', gap);
}

function exclusionReason(c: RouteCandidate, options: RouteOptions): ExclusionReason | undefined {
  const caps = Object.hasOwn(options.registry, c.partner) ? options.registry[c.partner] : undefined;
  if (caps === undefined) return 'unknown_partner';
  if (!c.customerApproved) return 'customer_not_approved';
  if (!supportsCorridor(caps, c.chain, options.corridor)) return 'corridor_unsupported';
  if (!c.accountReady) return 'account_not_ready';
  return undefined;
}

function assertNoDuplicates(candidates: readonly RouteCandidate[]): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.partner}\u0000${c.chain}`;
    if (seen.has(key)) throw new TypeError(`Duplicate route candidate: ${c.partner} on ${c.chain}`);
    seen.add(key);
  }
}

/** Positive prices in one source asset and one target asset, for the candidates that can win. */
function assertPricesWellFormed(eligible: readonly RouteCandidate[]): void {
  const first = eligible[0];
  for (const c of eligible) {
    if (toUnits(c.price.source) <= 0n || toUnits(c.price.target) <= 0n) {
      throw new InvalidMoneyError(`Route price for ${c.partner} must be positive`);
    }
    if (first !== undefined) {
      assertSameAsset(c.price.source, first.price.source);
      assertSameAsset(c.price.target, first.price.target);
    }
  }
}

/**
 * Better price first: more target per unit of source. Ties break on partner id,
 * then chain, so the result never depends on input order.
 */
function byPriceThenId(a: RouteCandidate, b: RouteCandidate): number {
  // Compare a.target / a.source with b.target / b.source by cross-multiplying.
  const left = toUnits(a.price.target) * toUnits(b.price.source);
  const right = toUnits(b.price.target) * toUnits(a.price.source);
  if (left !== right) return left > right ? -1 : 1;
  return compareStrings(a.partner, b.partner) || compareStrings(a.chain, b.chain);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Numerator and denominator of (cost - altCost) / altCost, exact, where
 * cost = source / target. Cross-multiplied:
 * (source * altTarget - altSource * target) / (altSource * target).
 */
function gapFraction(price: RoutePrice, alternative: RoutePrice): [bigint, bigint] {
  const den = toUnits(alternative.source) * toUnits(price.target);
  const num = toUnits(price.source) * toUnits(alternative.target) - den;
  return [num, den];
}

/** Exact: does `price` cost more than `alternative` by more than `limitBps`? */
function worseByMoreThan(price: RoutePrice, alternative: RoutePrice, limitBps: number): boolean {
  const [num, den] = gapFraction(price, alternative);
  return num * 10_000n > BigInt(limitBps) * den;
}

function priceGapBps(price: RoutePrice, alternative: RoutePrice): number {
  const [num, den] = gapFraction(price, alternative);
  if (num <= 0n) return 0;
  return Number((num * 1_000_000n + den - 1n) / den) / 100;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.partner === b.partner && a.chain === b.chain;
}

/** The route is locked in every state after `quoted`, because the funding leg exists or the transfer ended. */
export function isRouteLocked(state: TransferState): boolean {
  return state !== 'quoted';
}

/**
 * Guard for any code path that might re-route a transfer.
 * @throws {RouteImmutableError} when the route would change after `quoted`.
 */
export function assertRouteImmutable(state: TransferState, stored: Route, proposed: Route): void {
  if (isRouteLocked(state) && !sameRoute(stored, proposed)) {
    throw new RouteImmutableError(
      state,
      `${stored.partner}/${stored.chain}`,
      `${proposed.partner}/${proposed.chain}`,
    );
  }
}
