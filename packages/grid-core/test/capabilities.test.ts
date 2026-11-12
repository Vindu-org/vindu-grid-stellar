import { type CapabilityRegistry, type Corridor, accountModelFor, supportsCorridor } from '../src/capabilities';

const caps = {
  chains: ['stellar'],
  accounts: { stellar: 'external' },
  onRamp: { BRL: ['pix'] },
  offRamp: { USD: ['wire'] },
} as const;

const corridor: Corridor = { sourceCurrency: 'BRL', fundingRail: 'pix', targetCurrency: 'USD', payoutRail: 'wire' };

describe('capabilities', () => {
  it('supports a corridor whose rails and chain are listed', () => {
    expect(supportsCorridor(caps, 'stellar', corridor)).toBe(true);
    expect(accountModelFor(caps, 'stellar')).toBe('external');
  });

  it('does not support an unlisted chain, rail or currency', () => {
    expect(supportsCorridor(caps, 'otherchain', corridor)).toBe(false);
    expect(supportsCorridor(caps, 'stellar', { ...corridor, payoutRail: 'ach' })).toBe(false);
    expect(supportsCorridor(caps, 'stellar', { ...corridor, targetCurrency: 'EUR' })).toBe(false);
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'reads only own keys: %s is neither a currency nor a chain',
    (name) => {
      expect(() => supportsCorridor(caps, 'stellar', { ...corridor, sourceCurrency: name })).not.toThrow();
      expect(supportsCorridor(caps, 'stellar', { ...corridor, sourceCurrency: name })).toBe(false);
      expect(supportsCorridor(caps, 'stellar', { ...corridor, targetCurrency: name })).toBe(false);
      const listed = { ...caps, chains: [name] };
      expect(accountModelFor(listed, name)).toBeUndefined();
      expect(supportsCorridor(listed, name, corridor)).toBe(false);
    },
  );

  it('works with a registry parsed from JSON that has a __proto__ key, without polluting prototypes', () => {
    const registry = JSON.parse(
      '{"__proto__":{"chains":["stellar"],"accounts":{"stellar":"external"},"onRamp":{"BRL":["pix"]},"offRamp":{"USD":["wire"]}}}',
    ) as CapabilityRegistry;
    const own = Object.getOwnPropertyDescriptor(registry, '__proto__')?.value;
    expect(supportsCorridor(own, 'stellar', corridor)).toBe(true);
    expect(({} as Record<string, unknown>)['chains']).toBeUndefined();
  });

  it('treats a non-list rail entry as no rails', () => {
    const odd = { ...caps, onRamp: { BRL: 'pix' as unknown as readonly string[] } };
    expect(supportsCorridor(odd, 'stellar', corridor)).toBe(false);
  });
});
