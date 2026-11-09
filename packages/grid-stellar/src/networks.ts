/**
 * Public Stellar network settings, as convenience defaults.
 *
 * Every function in this package takes the network passphrase and the Horizon
 * URL as arguments. These constants are only there so a caller does not have
 * to retype the public values; nothing here picks a network on its own.
 */

/** Passphrase of the public Stellar test network. */
export const TESTNET_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Passphrase of the public Stellar main network. */
export const MAINNET_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** Public Horizon instance for testnet, run by the Stellar Development Foundation. */
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Public Horizon instance for mainnet, run by the Stellar Development Foundation. */
export const MAINNET_HORIZON_URL = 'https://horizon.stellar.org';

export interface StellarNetwork {
  readonly networkPassphrase: string;
  readonly horizonUrl: string;
}

export const STELLAR_TESTNET: StellarNetwork = Object.freeze({
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  horizonUrl: TESTNET_HORIZON_URL,
});

export const STELLAR_MAINNET: StellarNetwork = Object.freeze({
  networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
  horizonUrl: MAINNET_HORIZON_URL,
});
