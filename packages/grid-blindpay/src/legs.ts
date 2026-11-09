/**
 * What a BlindPay payin or payout says about its leg, in core's terms:
 * status, amount, the resource's own change time and the Stellar hash.
 *
 * Amounts follow core's port: the stablecoin the leg moved on Stellar.
 * - Funding (payin): `receiver_amount`, the stablecoin delivered to the account.
 * - Payout: `sender_amount`, the stablecoin taken from the account.
 * The fiat sides (`sender_amount` of a payin, `receiver_amount` of a payout)
 * stay on the raw resource, through `adapter.client`.
 *
 * The amount is left out, never guessed, when the stablecoin is not known
 * exactly: BlindPay's `token` names it (UNCONFIRMED field; when absent on
 * `stellar`, the only token there is USDC), and its issuer must be in the
 * adapter's `assetIssuers`. A missing or non-integer amount is left out too.
 */
import { type LegKind, type LegStatusValue, type Money, fromMinorUnits } from '@vindu/grid-core';

import { BLINDPAY_DECIMALS } from './amounts';
import type { Stablecoins } from './tokens';
import type { BlindPayNetwork, Payin, Payout } from './types';

/** BlindPay payin or payout status to core's leg status. Anything unexpected is `unknown`. */
export function toLegStatus(status: unknown): LegStatusValue {
  switch (status) {
    case 'processing':
    case 'on_hold':
    case 'completed':
    case 'failed':
    case 'refunded':
      return status;
    default:
      return 'unknown';
  }
}

/** The stablecoin amount the leg moved, or `undefined` when it is not known exactly. */
export function legAmount(
  kind: LegKind,
  resource: Payin | Payout,
  network: BlindPayNetwork,
  coins: Stablecoins,
): Money | undefined {
  const minor = kind === 'funding' ? resource.receiver_amount : resource.sender_amount;
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0) return undefined;
  const token = resource.token ?? (network === 'stellar' ? 'USDC' : undefined);
  const asset = coins.assetFor(token);
  return asset === undefined ? undefined : fromMinorUnits(minor, BLINDPAY_DECIMALS, asset);
}

/**
 * The resource's own change time, as an ISO-8601 instant: `updated_at` when
 * BlindPay sends one (UNCONFIRMED field), else, for a completed leg,
 * `tracking_complete.completed_at`. `undefined` otherwise: the Svix delivery
 * time is never used here.
 */
export function legChangedAt(resource: Payin | Payout): string | undefined {
  return (
    instant(resource.updated_at) ??
    (resource.status === 'completed' ? instant(resource.tracking_complete?.completed_at) : undefined)
  );
}

/** The Stellar transaction hash BlindPay reports for the leg. */
export function legTxHash(resource: Payin | Payout): string | undefined {
  const h = resource.tracking_transaction?.transaction_hash;
  return typeof h === 'string' && h !== '' ? h : undefined;
}

/** ISO-8601 date and time with an explicit offset. Anything looser is dropped rather than guessed. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
