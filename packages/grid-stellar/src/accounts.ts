/**
 * Is an account ready to receive an issued asset such as USDC?
 *
 * The protocol requires the account to exist and to hold a trustline for the
 * asset (code and issuer) before it can receive it. Each account also locks
 * a minimum balance in lumens: two base reserves (1 XLM) plus one base
 * reserve (0.5 XLM) per subentry such as a trustline, so an account with one
 * USDC trustline locks 1.5 XLM.
 *
 * These are pure checks over gateway data. Funding the account or adding the
 * trustline is a transaction for the account's key holder to sign.
 */
import { type Asset, type Money, formatAmount, fromUnits, parseAmount, sameAsset } from '@vindu/grid-core';
import type { HorizonAccount, HorizonBalanceLine, HorizonGateway } from './horizon';
import { NATIVE_ASSET_CODE, assetFromHorizon } from './payments';

/** Base reserve on the public networks, in XLM. */
export const BASE_RESERVE_XLM = '0.5';
/** Minimum balance of an account with no subentries: two base reserves. */
export const ACCOUNT_MINIMUM_BALANCE_XLM = '1';
/** Extra minimum balance per trustline: one base reserve. */
export const TRUSTLINE_RESERVE_XLM = '0.5';

const XLM: Asset = { code: NATIVE_ASSET_CODE };

export interface ReserveInput {
  readonly subentryCount: number;
  /** Entries this account sponsors for others: each adds a base reserve. */
  readonly numSponsoring?: number;
  /** Entries others sponsor for this account: each removes a base reserve. */
  readonly numSponsored?: number;
}

/**
 * Minimum XLM balance: (2 + subentries + sponsoring - sponsored) × base reserve.
 * `baseReserveXlm` defaults to {@link BASE_RESERVE_XLM}.
 */
export function minimumBalance(input: ReserveInput, baseReserveXlm: string = BASE_RESERVE_XLM): Money {
  const entries = 2 + input.subentryCount + (input.numSponsoring ?? 0) - (input.numSponsored ?? 0);
  if (!Number.isSafeInteger(entries) || entries < 0) throw new RangeError('Invalid entry counts');
  return fromUnits(BigInt(entries) * parseAmount(baseReserveXlm), XLM);
}

export type ReadinessIssue =
  | 'account_missing'
  | 'no_trustline'
  /** The issuer has not authorised the trustline. */
  | 'trustline_not_authorized'
  /** The trustline limit leaves no room for `amount`. */
  | 'trustline_limit_too_low'
  /** Native balance below the minimum balance (counting the trustline, if it is still to be added). */
  | 'reserve_too_low';

export interface ReceiveReadiness {
  readonly ready: boolean;
  readonly issues: readonly ReadinessIssue[];
  readonly exists: boolean;
  readonly trustline?: {
    readonly balance: string;
    readonly limit: string;
    readonly authorized: boolean;
  };
  /** Present when `checkReserve` is set and the account exists. Amounts in XLM. */
  readonly reserve?: {
    readonly required: string;
    readonly available: string;
    /** XLM to add to reach the minimum, "0" when sufficient. */
    readonly shortfall: string;
  };
}

export interface ReadinessOptions {
  /** Also check the XLM minimum balance. Default false. */
  readonly checkReserve?: boolean;
  /** Amount about to arrive: the trustline must have room for it. */
  readonly amount?: string;
  /** Base reserve in XLM. Default {@link BASE_RESERVE_XLM}. */
  readonly baseReserveXlm?: string;
}

/**
 * Checks `account` (as the gateway returned it, or `null` when it does not
 * exist) for receiving `asset`.
 *
 * @throws {TypeError} when `asset` has no issuer.
 */
export function assessReceiveReadiness(
  account: HorizonAccount | null,
  asset: Asset,
  options: ReadinessOptions = {},
): ReceiveReadiness {
  if (asset.issuer === undefined) throw new TypeError('The asset needs an issuer');
  if (account === null) return { ready: false, issues: ['account_missing'], exists: false };

  const issues: ReadinessIssue[] = [];
  const line = account.balances.find((b) => {
    const a = assetFromHorizon(b.asset_type, b.asset_code, b.asset_issuer);
    return a !== null && sameAsset(a, asset);
  });

  let trustline: ReceiveReadiness['trustline'];
  if (line === undefined) {
    issues.push('no_trustline');
  } else {
    const authorized = line.is_authorized !== false;
    trustline = { balance: canonical(line.balance), limit: canonical(line.limit ?? '0'), authorized };
    if (!authorized) issues.push('trustline_not_authorized');
    if (options.amount !== undefined && !hasRoom(line, options.amount)) issues.push('trustline_limit_too_low');
  }

  let reserve: ReceiveReadiness['reserve'];
  if (options.checkReserve === true) {
    const required = minimumBalance(
      {
        // A missing trustline will add one subentry once it is created.
        subentryCount: account.subentry_count + (line === undefined ? 1 : 0),
        ...(account.num_sponsoring === undefined ? {} : { numSponsoring: account.num_sponsoring }),
        ...(account.num_sponsored === undefined ? {} : { numSponsored: account.num_sponsored }),
      },
      options.baseReserveXlm,
    );
    const native = account.balances.find((b) => b.asset_type === 'native');
    const available = native === undefined ? 0n : parseAmount(native.balance) - parseAmount(native.selling_liabilities ?? '0');
    const missing = parseAmount(required.amount) - available;
    reserve = {
      required: required.amount,
      available: formatAmount(available),
      shortfall: formatAmount(missing > 0n ? missing : 0n),
    };
    if (missing > 0n) issues.push('reserve_too_low');
  }

  return {
    ready: issues.length === 0,
    issues,
    exists: true,
    ...(trustline === undefined ? {} : { trustline }),
    ...(reserve === undefined ? {} : { reserve }),
  };
}

/** Loads `address` through the gateway and runs {@link assessReceiveReadiness}. */
export async function checkReceiveReadiness(
  gateway: HorizonGateway,
  address: string,
  asset: Asset,
  options: ReadinessOptions = {},
): Promise<ReceiveReadiness> {
  return assessReceiveReadiness(await gateway.account(address), asset, options);
}

function hasRoom(line: HorizonBalanceLine, amount: string): boolean {
  const incoming = parseAmount(amount);
  const used = parseAmount(line.balance) + parseAmount(line.buying_liabilities ?? '0');
  return parseAmount(line.limit ?? '0') - used >= incoming;
}

function canonical(amount: string): string {
  return formatAmount(parseAmount(amount));
}
