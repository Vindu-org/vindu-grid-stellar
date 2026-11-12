/**
 * Public Stellar network settings, as convenience defaults.
 *
 * Every function in this package takes the network passphrase and the Horizon
 * URL as arguments. These constants are only there so a caller does not have
 * to retype the public values; nothing here picks a network on its own.
 *
 * **The public Horizon URLs are not for submitting payouts.** They sit
 * behind load balancers: a ledger read and a transaction lookup can be
 * served by instances that have ingested different ledgers, so a landed
 * transaction can look missing. The submitter refuses to call such a
 * transaction expired unless every lookup proves its instance had ingested
 * the checked ledger, so the usual result is `unknown`, not a false expiry,
 * but a payout then stops for a person to settle. For submission and
 * lookups, point the gateway at one Horizon instance you operate or trust
 * to be consistent. The public URLs are fine for exploring and for demos.
 */

/** Passphrase of the public Stellar test network. */
export const TESTNET_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Passphrase of the public Stellar main network. */
export const MAINNET_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * Public Horizon for testnet, run by the Stellar Development Foundation.
 * Load-balanced: do not use it to submit and look up payouts (see above).
 */
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Public Horizon for mainnet, run by the Stellar Development Foundation.
 * Load-balanced: do not use it to submit and look up payouts (see above).
 * Use one Horizon instance you operate or trust to be consistent.
 */
export const MAINNET_HORIZON_URL = 'https://horizon.stellar.org';

export interface StellarNetwork {
  readonly networkPassphrase: string;
  readonly horizonUrl: string;
}

/** Testnet passphrase and the public testnet Horizon. Its URL is load-balanced: not for submit and lookup. */
export const STELLAR_TESTNET: StellarNetwork = Object.freeze({
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  horizonUrl: TESTNET_HORIZON_URL,
});

/**
 * Mainnet passphrase and the public mainnet Horizon. Its URL is
 * load-balanced: for submit and lookup, keep the passphrase and replace the
 * URL with one Horizon instance you operate or trust.
 */
export const STELLAR_MAINNET: StellarNetwork = Object.freeze({
  networkPassphrase: MAINNET_NETWORK_PASSPHRASE,
  horizonUrl: MAINNET_HORIZON_URL,
});
