/**
 * Partner capabilities.
 *
 * What each partner can do: which chains it settles on, which account model it
 * uses on each chain, and which rails it offers per currency. The registry is
 * data the application passes in. This package lists no partners itself, and
 * adding a chain or a partner is a code change in the application, never an
 * environment switch.
 */
import type { Chain, FundingRail, OffRampRail, PartnerId } from './ports';

/**
 * How the client's stablecoin account is held. Every model is partner-custodied;
 * none is held by the platform.
 * - `partner_managed`: the partner creates and holds a managed account per client.
 * - `omnibus`: one partner account holds many clients' balances, with a
 *   sub-ledger that attributes each balance to its client.
 * - `external`: an account registered with the partner whose payouts a key
 *   holder signs (the signed payout flow).
 */
export type AccountModel = 'partner_managed' | 'omnibus' | 'external';

export interface PartnerCapabilities {
  readonly chains: readonly Chain[];
  /** Account model per chain. A chain listed in `chains` should have an entry here. */
  readonly accounts: Readonly<Record<Chain, AccountModel>>;
  /** Funding rails per source currency, e.g. `{ BRL: ['pix'] }`. */
  readonly onRamp: Readonly<Record<string, readonly FundingRail[]>>;
  /** Payout rails per target currency, e.g. `{ USD: ['wire', 'ach'] }`. */
  readonly offRamp: Readonly<Record<string, readonly OffRampRail[]>>;
}

/** Capabilities keyed by partner id. Built by the application. */
export type CapabilityRegistry = Readonly<Record<PartnerId, PartnerCapabilities>>;

/** The path a transfer takes: what the client pays with, and how the beneficiary is paid. */
export interface Corridor {
  /** Currency the client pays, e.g. `'BRL'`. */
  readonly sourceCurrency: string;
  readonly fundingRail: FundingRail;
  /** Currency the beneficiary receives, e.g. `'USD'`. */
  readonly targetCurrency: string;
  readonly payoutRail: OffRampRail;
}

/** The account model a partner uses on `chain`, or `undefined` when it does not settle there. */
export function accountModelFor(caps: PartnerCapabilities, chain: Chain): AccountModel | undefined {
  return caps.chains.includes(chain) ? caps.accounts[chain] : undefined;
}

/** True when the partner settles on `chain` and offers both rails of the corridor. */
export function supportsCorridor(caps: PartnerCapabilities, chain: Chain, corridor: Corridor): boolean {
  return (
    accountModelFor(caps, chain) !== undefined &&
    (caps.onRamp[corridor.sourceCurrency] ?? []).includes(corridor.fundingRail) &&
    (caps.offRamp[corridor.targetCurrency] ?? []).includes(corridor.payoutRail)
  );
}
