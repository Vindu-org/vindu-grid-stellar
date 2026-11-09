/**
 * The signer port.
 *
 * Signing keys never enter this library. The library hands an unsigned Stellar
 * transaction (XDR) to a {@link Signer} the application provides, and gets the
 * signed XDR back. The signer is the key holder: a partner, a custodian, the
 * client's own device, or a throwaway key in tests.
 *
 * A signer must check what it signs. Before signing, it decodes the XDR and
 * confirms that the amount, the asset, the destination and the source account
 * match `context.expected`, and that the transfer is in `awaiting_signature`
 * with an unexpired quote. {@link assertSigningAllowed} covers the state and
 * expiry part; decoding the XDR is the signer's job, since this package has
 * no Stellar SDK.
 */
import { SigningNotAllowedError } from './errors';
import type { Money } from './money';
import type { AccountRef } from './ports';
import type { TransferState } from './transfer-states';

/**
 * Who holds the key.
 * - `partner`: a partner key holder signs for a partner-custodied account.
 * - `custodian`: a third-party custodian signs.
 * - `client`: the client signs on their own device; the transfer waits in
 *   `awaiting_signature` until the signed XDR comes back.
 * - `test_key`: a local key for tests and testnet demos only.
 */
export type Custody = 'partner' | 'custodian' | 'client' | 'test_key';

/** What the engine expects the transaction to do. The signer verifies the XDR against it. */
export interface SigningContext {
  readonly transferId: string;
  /** Current transfer state. Signing is only allowed in `awaiting_signature`. */
  readonly state: TransferState;
  /** Payout quote the transaction belongs to. */
  readonly quoteId: string;
  /** ISO-8601 instant the quote expires. An expired quote needs a fresh quote and a new XDR. */
  readonly expiresAt: string;
  readonly expected: {
    /** Amount and asset the transaction must move. */
    readonly amount: Money;
    /** Account the transaction must pay. */
    readonly destination: string;
  };
}

export interface Signer {
  readonly custody: Custody;
  /**
   * Signs `unsignedXdr` for `account` and returns the signed XDR envelope.
   * Must refuse (throw) when the XDR does not match `context.expected` or the
   * transfer is not in a signable state.
   */
  signStellar(account: AccountRef, unsignedXdr: string, context: SigningContext): Promise<string>;
}

/**
 * Throws {@link SigningNotAllowedError} unless the transfer is in
 * `awaiting_signature` and the quote has not expired at `now`.
 */
export function assertSigningAllowed(context: SigningContext, now: Date = new Date()): void {
  if (context.state !== 'awaiting_signature') {
    throw new SigningNotAllowedError(
      `Transfer ${context.transferId} is in ${context.state}, not awaiting_signature`,
    );
  }
  const expiresAt = Date.parse(context.expiresAt);
  if (Number.isNaN(expiresAt)) {
    throw new SigningNotAllowedError(`Quote ${context.quoteId} has an invalid expiry`);
  }
  if (now.getTime() >= expiresAt) {
    throw new SigningNotAllowedError(
      `Quote ${context.quoteId} expired: get a fresh quote and a new transaction`,
    );
  }
}
