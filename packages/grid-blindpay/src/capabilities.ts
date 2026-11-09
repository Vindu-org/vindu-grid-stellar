/**
 * What BlindPay offers through this adapter, as core capability data. Pass it
 * into your `CapabilityRegistry` under the partner id you route with.
 *
 * Stellar only, with external accounts: BlindPay's managed wallets do not
 * support Stellar, so each client registers its own Stellar account and a key
 * holder signs payouts. Rails use core's names: BlindPay's `international_swift`
 * is `swift`, and SPEI runs through BlindPay's `spei_bitso` account type.
 * Availability per customer country is not confirmed by the docs read so far.
 */
import type { PartnerCapabilities } from '@vindu/grid-core';

export const BLINDPAY_CAPABILITIES: PartnerCapabilities = Object.freeze({
  chains: Object.freeze(['stellar']),
  accounts: Object.freeze({ stellar: 'external' as const }),
  onRamp: Object.freeze({ BRL: Object.freeze(['pix']) }),
  offRamp: Object.freeze({
    USD: Object.freeze(['wire', 'ach', 'rtp', 'swift']),
    EUR: Object.freeze(['sepa']),
    MXN: Object.freeze(['spei']),
  }),
});
