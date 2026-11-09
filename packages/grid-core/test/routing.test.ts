import { fiat } from '../src/assets';
import type { CapabilityRegistry, Corridor } from '../src/capabilities';
import { AssetMismatchError, RouteImmutableError, RouteNotFoundError } from '../src/errors';
import { money } from '../src/money';
import {
  type RouteCandidate,
  type RouteOptions,
  assertRouteImmutable,
  isRouteLocked,
  selectRoute,
} from '../src/routing';

const BRL = fiat('BRL');
const USD = fiat('USD');

// Made-up partners for tests. Core ships no partner list.
const registry: CapabilityRegistry = {
  'stellar-a': {
    chains: ['stellar'],
    accounts: { stellar: 'external' },
    onRamp: { BRL: ['pix'] },
    offRamp: { USD: ['wire', 'ach'] },
  },
  'stellar-b': {
    chains: ['stellar'],
    accounts: { stellar: 'omnibus' },
    onRamp: { BRL: ['pix'] },
    offRamp: { USD: ['wire'] },
  },
  'other-a': {
    chains: ['otherchain'],
    accounts: { otherchain: 'partner_managed' },
    onRamp: { BRL: ['pix'] },
    offRamp: { USD: ['wire', 'swift'] },
  },
  'other-b': {
    chains: ['otherchain'],
    accounts: { otherchain: 'partner_managed' },
    onRamp: { BRL: ['pix'] },
    offRamp: { USD: ['wire'] },
  },
};

const corridor: Corridor = {
  sourceCurrency: 'BRL',
  fundingRail: 'pix',
  targetCurrency: 'USD',
  payoutRail: 'wire',
};

function candidate(
  partner: string,
  chain: string,
  target: string,
  overrides: Partial<RouteCandidate> = {},
): RouteCandidate {
  return {
    partner,
    chain,
    customerApproved: true,
    accountReady: true,
    price: { source: money('50000', BRL), target: money(target, USD) },
    ...overrides,
  };
}

const opts = (o: Partial<RouteOptions> = {}): RouteOptions => ({
  registry,
  corridor,
  stellarRoutingEnabled: true,
  ...o,
});

describe('routing', () => {
  it('selects the Stellar route when it is also the best price', () => {
    const d = selectRoute(
      [candidate('other-a', 'otherchain', '9550'), candidate('stellar-a', 'stellar', '9600')],
      opts({ stellarPriceLimitBps: 50 }),
    );
    expect(d.route).toEqual({ partner: 'stellar-a', chain: 'stellar' });
    expect(d.reason).toBe('stellar_priority');
    expect(d.stellarPriceGapBps).toBe(0);
  });

  it('Stellar beats a cheaper non-Stellar route within the limit', () => {
    // Stellar is (9550 - 9500) / 9550 = 52.36 bps worse.
    const d = selectRoute(
      [candidate('other-a', 'otherchain', '9550'), candidate('stellar-a', 'stellar', '9500')],
      opts({ stellarPriceLimitBps: 100 }),
    );
    expect(d.route.partner).toBe('stellar-a');
    expect(d.reason).toBe('stellar_priority');
    expect(d.stellarPriceGapBps).toBe(52.36);
  });

  it('Stellar loses only when its price is beyond the limit', () => {
    const d = selectRoute(
      [candidate('stellar-a', 'stellar', '9500'), candidate('other-a', 'otherchain', '9550')],
      opts({ stellarPriceLimitBps: 50 }),
    );
    expect(d.route).toEqual({ partner: 'other-a', chain: 'otherchain' });
    expect(d.reason).toBe('stellar_price_limit_exceeded');
    expect(d.stellarPriceGapBps).toBe(52.36);
  });

  it('Stellar exactly at the limit still wins', () => {
    // (10000 - 9970) / 10000 = 30 bps exactly.
    const cands = [candidate('other-a', 'otherchain', '10000'), candidate('stellar-a', 'stellar', '9970')];
    expect(selectRoute(cands, opts({ stellarPriceLimitBps: 30 })).route.partner).toBe('stellar-a');
    expect(selectRoute(cands, opts({ stellarPriceLimitBps: 29 })).route.partner).toBe('other-a');
  });

  it('without a limit the Stellar route always wins', () => {
    const d = selectRoute(
      [candidate('other-a', 'otherchain', '9550'), candidate('stellar-a', 'stellar', '5000')],
      opts(),
    );
    expect(d.route.partner).toBe('stellar-a');
    expect(d.reason).toBe('stellar_priority');
  });

  it('compares by effective rate when source amounts differ', () => {
    // Fixed-target quotes: the Stellar route needs more BRL for the same USD.
    const stellar = candidate('stellar-a', 'stellar', '10000', {
      price: { source: money('50300', BRL), target: money('10000', USD) },
    });
    const other = candidate('other-a', 'otherchain', '10000');
    // Gap = 1 - 50000/50300 = 59.65 bps (rounded up).
    const within = selectRoute([stellar, other], opts({ stellarPriceLimitBps: 60 }));
    expect(within.route.partner).toBe('stellar-a');
    expect(within.stellarPriceGapBps).toBe(59.65);
    expect(selectRoute([stellar, other], opts({ stellarPriceLimitBps: 59 })).route.partner).toBe('other-a');
  });

  it('with Stellar routing disabled, picks the best price', () => {
    const cheaperOther = [candidate('stellar-a', 'stellar', '9500'), candidate('other-a', 'otherchain', '9550')];
    const d = selectRoute(cheaperOther, opts({ stellarRoutingEnabled: false }));
    expect(d.route.partner).toBe('other-a');
    expect(d.reason).toBe('stellar_routing_disabled');

    const cheaperStellar = [candidate('stellar-a', 'stellar', '9600'), candidate('other-a', 'otherchain', '9550')];
    expect(selectRoute(cheaperStellar, opts({ stellarRoutingEnabled: false })).route.partner).toBe('stellar-a');
  });

  it('skips a Stellar route without a ready account', () => {
    const d = selectRoute(
      [candidate('stellar-a', 'stellar', '9600', { accountReady: false }), candidate('other-a', 'otherchain', '9550')],
      opts(),
    );
    expect(d.route.partner).toBe('other-a');
    expect(d.reason).toBe('best_price');
    expect(d.excluded).toEqual([{ partner: 'stellar-a', chain: 'stellar', reason: 'account_not_ready' }]);
  });

  it('skips partners that do not support the corridor', () => {
    const swift: Corridor = { ...corridor, payoutRail: 'swift' };
    const d = selectRoute(
      [candidate('stellar-a', 'stellar', '9600'), candidate('other-a', 'otherchain', '9550')],
      opts({ corridor: swift }),
    );
    expect(d.route.partner).toBe('other-a');
    expect(d.excluded).toEqual([{ partner: 'stellar-a', chain: 'stellar', reason: 'corridor_unsupported' }]);
  });

  it('skips a chain the partner does not settle on', () => {
    const d = selectRoute(
      [candidate('stellar-a', 'otherchain', '9999'), candidate('other-a', 'otherchain', '9550')],
      opts(),
    );
    expect(d.route.partner).toBe('other-a');
    expect(d.excluded[0]?.reason).toBe('corridor_unsupported');
  });

  it('skips partners where the customer is not approved', () => {
    const d = selectRoute(
      [candidate('stellar-a', 'stellar', '9600', { customerApproved: false }), candidate('other-a', 'otherchain', '9550')],
      opts(),
    );
    expect(d.route.partner).toBe('other-a');
    expect(d.excluded).toEqual([{ partner: 'stellar-a', chain: 'stellar', reason: 'customer_not_approved' }]);
  });

  it('skips partners missing from the registry', () => {
    const d = selectRoute(
      [candidate('constructor', 'stellar', '9999'), candidate('other-a', 'otherchain', '9550')],
      opts(),
    );
    expect(d.route.partner).toBe('other-a');
    expect(d.excluded).toEqual([{ partner: 'constructor', chain: 'stellar', reason: 'unknown_partner' }]);
  });

  it('no candidates throws RouteNotFoundError', () => {
    expect(() => selectRoute([], opts())).toThrow(RouteNotFoundError);
  });

  it('all candidates excluded throws RouteNotFoundError listing why', () => {
    try {
      selectRoute([candidate('stellar-a', 'stellar', '9600', { accountReady: false })], opts());
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteNotFoundError);
      expect((e as RouteNotFoundError).excluded).toEqual([
        { partner: 'stellar-a', chain: 'stellar', reason: 'account_not_ready' },
      ]);
    }
  });

  it('tie-break is deterministic: partner id, whatever the input order', () => {
    const a = candidate('other-a', 'otherchain', '9550');
    const b = candidate('other-b', 'otherchain', '9550');
    expect(selectRoute([a, b], opts()).route.partner).toBe('other-a');
    expect(selectRoute([b, a], opts()).route.partner).toBe('other-a');

    const sa = candidate('stellar-a', 'stellar', '9500');
    const sb = candidate('stellar-b', 'stellar', '9500');
    expect(selectRoute([sb, sa, b], opts()).route.partner).toBe('stellar-a');
  });

  it('picks the best-priced Stellar route among several', () => {
    const d = selectRoute(
      [candidate('stellar-a', 'stellar', '9500'), candidate('stellar-b', 'stellar', '9510')],
      opts(),
    );
    expect(d.route.partner).toBe('stellar-b');
    expect(d.stellarPriceGapBps).toBeUndefined();
  });

  it('rejects malformed input', () => {
    const eur = candidate('other-a', 'otherchain', '1', {
      price: { source: money('1', BRL), target: money('1', fiat('EUR')) },
    });
    expect(() => selectRoute([candidate('stellar-a', 'stellar', '1'), eur], opts())).toThrow(AssetMismatchError);
    const dup = candidate('stellar-a', 'stellar', '1');
    expect(() => selectRoute([dup, dup], opts())).toThrow(TypeError);
    expect(() => selectRoute([dup], opts({ stellarPriceLimitBps: -1 }))).toThrow(RangeError);
    expect(() => selectRoute([candidate('stellar-a', 'stellar', '0')], opts())).toThrow(/positive/);
  });

  describe('route immutability', () => {
    const stored = { partner: 'stellar-a', chain: 'stellar' };
    const other = { partner: 'other-a', chain: 'otherchain' };

    it('allows re-routing only while quoted', () => {
      expect(isRouteLocked('quoted')).toBe(false);
      expect(() => assertRouteImmutable('quoted', stored, other)).not.toThrow();
    });

    it.each(['awaiting_pix', 'funding', 'funded', 'needs_attention', 'cancelled'] as const)(
      'refuses to change the route in %s',
      (state) => {
        expect(() => assertRouteImmutable(state, stored, other)).toThrow(RouteImmutableError);
        expect(() => assertRouteImmutable(state, stored, { ...stored })).not.toThrow();
      },
    );
  });
});
