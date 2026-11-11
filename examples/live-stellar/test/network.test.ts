import { MAINNET_HORIZON_URL, MAINNET_NETWORK_PASSPHRASE, TESTNET_NETWORK_PASSPHRASE } from '@vindu/grid-stellar';

import { LIVE_TESTNET, NotTestnetError, assertHorizonRootIsTestnet, assertTestnet, networkFromArgs } from '../src/network';
import { packageLogger } from '../src/report';
import { Testnet } from '../src/testnet';

describe('the testnet guard', () => {
  it('accepts the public testnet settings', () => {
    expect(() => assertTestnet(LIVE_TESTNET)).not.toThrow();
    expect(() => assertTestnet({ ...LIVE_TESTNET, horizonUrl: `${LIVE_TESTNET.horizonUrl}/` })).not.toThrow();
  });

  it('refuses the mainnet passphrase', () => {
    expect(() => assertTestnet({ ...LIVE_TESTNET, networkPassphrase: MAINNET_NETWORK_PASSPHRASE })).toThrow(NotTestnetError);
  });

  it('refuses the mainnet Horizon and any other URL', () => {
    expect(() => assertTestnet({ ...LIVE_TESTNET, horizonUrl: MAINNET_HORIZON_URL })).toThrow(NotTestnetError);
    expect(() => assertTestnet({ ...LIVE_TESTNET, horizonUrl: 'https://horizon.example.org' })).toThrow(NotTestnetError);
  });

  it('refuses another friendbot', () => {
    expect(() => assertTestnet({ ...LIVE_TESTNET, friendbotUrl: 'https://friendbot.example.org' })).toThrow(NotTestnetError);
  });

  it('stops the live run before anything is built for another network', () => {
    const logger = packageLogger(() => undefined);
    expect(() => new Testnet({ ...LIVE_TESTNET, horizonUrl: MAINNET_HORIZON_URL }, logger)).toThrow(NotTestnetError);
    expect(() => new Testnet({ ...LIVE_TESTNET, networkPassphrase: MAINNET_NETWORK_PASSPHRASE }, logger)).toThrow(NotTestnetError);
  });

  it('refuses a Horizon whose root names another passphrase, or none', () => {
    expect(() => assertHorizonRootIsTestnet({ network_passphrase: TESTNET_NETWORK_PASSPHRASE })).not.toThrow();
    expect(() => assertHorizonRootIsTestnet({ network_passphrase: MAINNET_NETWORK_PASSPHRASE })).toThrow(NotTestnetError);
    expect(() => assertHorizonRootIsTestnet({})).toThrow(NotTestnetError);
    expect(() => assertHorizonRootIsTestnet(null)).toThrow(NotTestnetError);
  });
});

describe('networkFromArgs', () => {
  it('defaults to the public testnet', () => {
    expect(networkFromArgs([])).toEqual(LIVE_TESTNET);
    expect(networkFromArgs(['--'])).toEqual(LIVE_TESTNET);
  });

  it('reads the overrides, which the guard then refuses', () => {
    const network = networkFromArgs([`--horizon-url=${MAINNET_HORIZON_URL}`, `--network-passphrase=${MAINNET_NETWORK_PASSPHRASE}`]);
    expect(network.horizonUrl).toBe(MAINNET_HORIZON_URL);
    expect(network.networkPassphrase).toBe(MAINNET_NETWORK_PASSPHRASE);
    expect(() => assertTestnet(network)).toThrow(NotTestnetError);
  });

  it('refuses an unknown argument', () => {
    expect(() => networkFromArgs(['--mainnet'])).toThrow(/Unknown argument/);
  });
});

describe('offline guard', () => {
  it('disables fetch in unit tests', () => {
    expect(() => fetch('https://horizon-testnet.stellar.org')).toThrow(/offline/);
  });
});
