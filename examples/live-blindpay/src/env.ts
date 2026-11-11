/**
 * The only place this example reads the environment. The packages never do:
 * the values are passed to them as arguments.
 *
 * - `BLINDPAY_API_KEY` and `BLINDPAY_INSTANCE_ID` (required): a key for a
 *   BlindPay **development** instance. The run checks the instance type
 *   before any write and stops on anything else.
 * - `BLINDPAY_BASE_URL` (optional): another API host, e.g. a local mock.
 * - `BLINDPAY_PAYOUT_DESTINATION` (optional): the Stellar account BlindPay
 *   payouts must pay, as BlindPay gave it to you. Without it the run uses
 *   the USDB issuer from BlindPay's trustline XDR, which is what development
 *   instances paid in every run so far, and says so in a FINDING line. That
 *   fallback is for development only, never production: the destination
 *   check is then a FINDING too, because it would be circular.
 * - `BLINDPAY_PAYIN_WAIT_SEC` (optional): how long to wait for a payin to
 *   reach a final status. Default 300.
 */
export interface LiveEnv {
  readonly apiKey: string;
  readonly instanceId: string;
  readonly baseUrl?: string;
  readonly payoutDestination?: string;
  readonly payinWaitMs: number;
}

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

const DEFAULT_PAYIN_WAIT_SEC = 300;

export function readLiveEnv(env: Readonly<Record<string, string | undefined>>): LiveEnv {
  const apiKey = env['BLINDPAY_API_KEY']?.trim() ?? '';
  const instanceId = env['BLINDPAY_INSTANCE_ID']?.trim() ?? '';
  // The messages name the variables, never their values.
  if (apiKey === '') throw new EnvError('BLINDPAY_API_KEY is not set');
  if (instanceId === '') throw new EnvError('BLINDPAY_INSTANCE_ID is not set');
  if (!/^in_[A-Za-z0-9]+$/.test(instanceId)) throw new EnvError('BLINDPAY_INSTANCE_ID does not look like in_...');
  const baseUrl = env['BLINDPAY_BASE_URL']?.trim();
  const destination = env['BLINDPAY_PAYOUT_DESTINATION']?.trim();
  if (destination !== undefined && destination !== '' && !/^G[A-Z2-7]{55}$/.test(destination)) {
    throw new EnvError('BLINDPAY_PAYOUT_DESTINATION must be a Stellar account (G...)');
  }
  const waitRaw = env['BLINDPAY_PAYIN_WAIT_SEC']?.trim();
  const waitSec = waitRaw === undefined || waitRaw === '' ? DEFAULT_PAYIN_WAIT_SEC : Number(waitRaw);
  if (!Number.isSafeInteger(waitSec) || waitSec < 0) throw new EnvError('BLINDPAY_PAYIN_WAIT_SEC must be a whole number of seconds');
  return {
    apiKey,
    instanceId,
    ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
    ...(destination === undefined || destination === '' ? {} : { payoutDestination: destination }),
    payinWaitMs: waitSec * 1000,
  };
}
