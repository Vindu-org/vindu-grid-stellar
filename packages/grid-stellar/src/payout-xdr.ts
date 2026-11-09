/**
 * Checking an unsigned payout transaction before anyone signs it.
 *
 * The partner builds the transaction; the signer only holds the key. A
 * signer that signs whatever it is handed signs whatever the partner asks.
 * {@link assertPayoutXdrMatches} decodes the unsigned XDR and checks every
 * field that decides where money goes, against the `SigningContext` the
 * payout flow gives the signer. It needs no key: call it in the signer
 * (or before handing the XDR to a custodian) and sign only if it returns.
 *
 * The network is the one thing it cannot check: an unsigned envelope does
 * not name its network, and the same bytes decode under any passphrase. The
 * signature binds the passphrase: the signer signs the hash computed for
 * it, so the signed transaction is valid on that network only. Sign under
 * the passphrase given here.
 */
import {
  type Asset,
  GridError,
  InvalidConfigError,
  type SigningContext,
  assertMaxTimeWithinQuote,
  assetKey,
  equals,
  isValidAmount,
  money,
  sameAsset,
} from '@vindu/grid-core';
import { NATIVE_ASSET_CODE } from './payments';
import { FeeBumpTransaction, Transaction, TransactionBuilder, stellarSdk } from './sdk';

/** Which check refused the transaction. */
export type PayoutXdrCheck =
  | 'decode'
  | 'fee_bump'
  | 'operations'
  | 'operation_type'
  | 'source'
  | 'operation_source'
  | 'destination'
  | 'asset'
  | 'amount'
  | 'fee'
  | 'max_time'
  | 'preconditions';

/**
 * An unsigned payout transaction does not match its signing context. Do not
 * sign it. `check` names the first check that failed; the message never
 * carries the XDR.
 */
export class PayoutXdrMismatchError extends GridError {
  constructor(
    readonly check: PayoutXdrCheck,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('payout_xdr_mismatch', message, options);
  }
}

export interface PayoutXdrOptions {
  /**
   * Passphrase of the network the signer signs for. The XDR is decoded for
   * it; the envelope itself cannot show which network it was built for, so
   * this is not checked against the XDR. A signature made under it is only
   * valid on that network.
   */
  readonly networkPassphrase: string;
  /** Highest total fee, in stroops. Default {@link DEFAULT_MAX_FEE_STROOPS}. A positive safe integer. */
  readonly maxFeeStroops?: number;
}

/** Default fee cap: 1 000 000 stroops (0.1 XLM) for the whole transaction. */
export const DEFAULT_MAX_FEE_STROOPS = 1_000_000;

/**
 * Throws {@link PayoutXdrMismatchError} unless `unsignedXdr` is exactly the
 * payment `context.expected` describes:
 *
 * - `networkPassphrase` is set, and the XDR decodes for it as a plain
 *   transaction (no fee bump). The network itself cannot be checked: an
 *   unsigned envelope does not name it. Sign under this same passphrase,
 *   which binds the signature to that network;
 * - it has exactly one operation, and that is a `payment`;
 * - the transaction source is `expected.source`;
 * - the operation has no source of its own, or one that is (or is a muxed
 *   `M...` address of) `expected.source`;
 * - the destination is `expected.destination`;
 * - the asset (code and issuer) and the exact amount are `expected.amount`;
 * - the total fee is at most `maxFeeStroops`;
 * - it has a `maxTime`, no later than the quote expiry
 *   (`assertMaxTimeWithinQuote`);
 * - it has none of the newer preconditions: minimum account sequence, its
 *   age or ledger gap, extra signers, or ledger bounds (unset or zero only).
 *
 * It holds no key and checks only the transaction; the transfer state and
 * the quote expiry against the clock are `assertSigningAllowed`'s job.
 *
 * @throws {PayoutXdrMismatchError} on any mismatch.
 * @throws {InvalidConfigError} when `networkPassphrase` is empty or `maxFeeStroops` is not a positive safe integer.
 */
export function assertPayoutXdrMatches(unsignedXdr: string, context: SigningContext, options: PayoutXdrOptions): void {
  const { networkPassphrase } = options;
  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0) {
    throw new InvalidConfigError('networkPassphrase is required');
  }
  const cap = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new InvalidConfigError(`maxFeeStroops must be a positive whole number of stroops: ${cap}`);
  }
  const { expected } = context;

  let envelope: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    envelope = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  } catch (cause) {
    throw new PayoutXdrMismatchError('decode', 'The payout XDR is not a transaction envelope', { cause });
  }
  if (envelope instanceof FeeBumpTransaction) {
    throw new PayoutXdrMismatchError('fee_bump', 'The payout XDR is a fee bump: only a plain transaction is signed');
  }
  if (!(envelope instanceof Transaction)) {
    throw new PayoutXdrMismatchError('decode', 'The payout XDR is not a transaction envelope');
  }
  const tx = envelope;

  if (tx.operations.length !== 1) {
    throw new PayoutXdrMismatchError('operations', `Expected exactly one operation, got ${tx.operations.length}`);
  }
  const op = tx.operations[0];
  if (op === undefined || op.type !== 'payment') {
    throw new PayoutXdrMismatchError('operation_type', `Expected a payment operation, got ${op?.type ?? 'none'}`);
  }

  if (tx.source !== expected.source) {
    throw new PayoutXdrMismatchError('source', 'The transaction source is not the expected source account');
  }
  if (op.source !== undefined && baseAccount(op.source) !== expected.source) {
    throw new PayoutXdrMismatchError('operation_source', 'The payment spends from an account other than the expected source');
  }
  if (op.destination !== expected.destination) {
    throw new PayoutXdrMismatchError('destination', 'The payment destination is not the expected destination');
  }

  const issuer = op.asset.isNative() ? undefined : op.asset.getIssuer();
  const asset: Asset =
    issuer === undefined ? { code: op.asset.isNative() ? NATIVE_ASSET_CODE : op.asset.getCode() } : { code: op.asset.getCode(), issuer };
  if (!sameAsset(asset, expected.amount.asset)) {
    throw new PayoutXdrMismatchError(
      'asset',
      `The payment asset ${assetKey(asset)} is not the expected ${assetKey(expected.amount.asset)}`,
    );
  }
  if (!isValidAmount(op.amount) || !equals(money(op.amount, asset), expected.amount)) {
    throw new PayoutXdrMismatchError('amount', `The payment amount ${op.amount} is not the expected ${expected.amount.amount}`);
  }

  if (!/^[0-9]+$/.test(tx.fee) || BigInt(tx.fee) > BigInt(cap)) {
    throw new PayoutXdrMismatchError('fee', `The fee of ${tx.fee} stroops is above the cap of ${cap}`);
  }

  const rawMaxTime = tx.timeBounds?.maxTime;
  const maxTime = rawMaxTime === undefined ? undefined : Number(rawMaxTime);
  try {
    assertMaxTimeWithinQuote(maxTime, context);
  } catch (cause) {
    throw new PayoutXdrMismatchError('max_time', cause instanceof Error ? cause.message : 'The maxTime is not within the quote', {
      cause,
    });
  }

  const precondition = setPrecondition(tx);
  if (precondition !== null) {
    throw new PayoutXdrMismatchError('preconditions', `The transaction sets ${precondition}: not signed`);
  }
}

/** The G... account behind an account or muxed (M...) address. */
function baseAccount(address: string): string {
  if (!address.startsWith('M')) return address;
  try {
    return stellarSdk.extractBaseAddress(address);
  } catch {
    return address;
  }
}

/** The first newer precondition the transaction sets to something other than unset or zero, or `null`. */
function setPrecondition(tx: InstanceType<typeof Transaction>): string | null {
  const minSequence = tx.minAccountSequence;
  if (minSequence !== undefined && minSequence !== '0') return 'a minimum account sequence';
  const age = tx.minAccountSequenceAge;
  if (age !== undefined && BigInt(age) !== 0n) return 'a minimum account sequence age';
  const gap = tx.minAccountSequenceLedgerGap;
  if (gap !== undefined && gap !== 0) return 'a minimum account sequence ledger gap';
  const signers = tx.extraSigners;
  if (signers !== undefined && signers.length > 0) return 'extra signers';
  const bounds = tx.ledgerBounds;
  if (bounds !== undefined && (bounds.minLedger !== 0 || bounds.maxLedger !== 0)) return 'ledger bounds';
  return null;
}
