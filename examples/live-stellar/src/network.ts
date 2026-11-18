/**
 * Which network the live run talks to, and the guard that keeps it on testnet.
 *
 * The run spends nothing real, but it does submit transactions. It refuses
 * to start unless the Horizon URL, the friendbot URL and the network
 * passphrase are the public testnet ones, and, once online, unless Horizon
 * itself says it serves the testnet passphrase.
 */
import { TESTNET_HORIZON_URL, TESTNET_NETWORK_PASSPHRASE } from '@vindu/grid-stellar';

export const FRIENDBOT_URL = 'https://friendbot.stellar.org';

export interface LiveNetwork {
  readonly horizonUrl: string;
  readonly networkPassphrase: string;
  readonly friendbotUrl: string;
}

export const LIVE_TESTNET: LiveNetwork = Object.freeze({
  horizonUrl: TESTNET_HORIZON_URL,
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  friendbotUrl: FRIENDBOT_URL,
});

/** The network is not the public testnet. */
export class NotTestnetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotTestnetError';
  }
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Throws {@link NotTestnetError} unless every setting is the public testnet's. */
export function assertTestnet(network: LiveNetwork): void {
  if (network.networkPassphrase !== TESTNET_NETWORK_PASSPHRASE) {
    throw new NotTestnetError('The network passphrase is not the testnet passphrase: refusing to run');
  }
  if (withoutTrailingSlash(network.horizonUrl) !== TESTNET_HORIZON_URL) {
    throw new NotTestnetError(`The Horizon URL is not ${TESTNET_HORIZON_URL}: refusing to run`);
  }
  if (withoutTrailingSlash(network.friendbotUrl) !== FRIENDBOT_URL) {
    throw new NotTestnetError(`The friendbot URL is not ${FRIENDBOT_URL}: refusing to run`);
  }
}

/**
 * Throws {@link NotTestnetError} unless Horizon's root resource names the
 * testnet passphrase. `root` is the parsed JSON of `GET /`.
 */
export function assertHorizonRootIsTestnet(root: unknown): void {
  const passphrase =
    typeof root === 'object' && root !== null ? (root as Record<string, unknown>)['network_passphrase'] : undefined;
  if (passphrase !== TESTNET_NETWORK_PASSPHRASE) {
    throw new NotTestnetError('Horizon does not serve the testnet passphrase: refusing to run');
  }
}

/**
 * The network from the command line. Accepts `--horizon-url=<url>` and
 * `--network-passphrase=<passphrase>` only so the guard can be seen to work:
 * anything but the testnet values is refused by {@link assertTestnet}.
 */
export function networkFromArgs(argv: readonly string[]): LiveNetwork {
  let horizonUrl = LIVE_TESTNET.horizonUrl;
  let networkPassphrase = LIVE_TESTNET.networkPassphrase;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--horizon-url=')) horizonUrl = arg.slice('--horizon-url='.length);
    else if (arg.startsWith('--network-passphrase=')) networkPassphrase = arg.slice('--network-passphrase='.length);
    else throw new Error(`Unknown argument: ${arg}. Options: --horizon-url=<url>, --network-passphrase=<passphrase>`);
  }
  return { horizonUrl, networkPassphrase, friendbotUrl: LIVE_TESTNET.friendbotUrl };
}
