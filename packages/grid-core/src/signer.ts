/**
 * The signer port.
 *
 * Signing keys never enter this library. The library hands an unsigned Stellar
 * transaction (XDR) to a {@link Signer} the application provides, and gets the
 * signed XDR back. The signer is the key holder: a partner, a custodian, the
 * client's own device, or a throwaway key in tests.
 *
 * A signer must check what it signs. The partner built the transaction, so a
 * signer that trusts it blindly signs whatever the partner asks. Before
 * signing, every signer must refuse (throw) unless all of these hold:
 *
 * 1. State and time: {@link assertSigningAllowed} passes: the transfer is in
 *    `awaiting_signature`, the quote has not expired, and the clock is sane.
 * 2. Network: the XDR decodes for the network passphrase the signer is
 *    configured for, and no other.
 * 3. Envelope: a plain transaction, not a fee bump (whose inner transaction
 *    and fee payer the signer did not choose).
 * 4. Operations: exactly one operation, and it is a payment.
 * 5. Source: the transaction source is `context.expected.source`, the
 *    account it was asked to sign for.
 * 6. Operation source: the payment has no source of its own, or exactly
 *    `expected.source`. A muxed source (M...) counts by its underlying G
 *    account, and must still be that account.
 * 7. Destination: the payment pays `expected.destination`.
 * 8. Asset: `expected.amount.asset`, code and issuer both.
 * 9. Amount: exactly `expected.amount.amount`.
 * 10. Fee: no more than the signer's own cap, in stroops.
 * 11. Time bounds: {@link assertMaxTimeWithinQuote} passes: the transaction
 *     has a `maxTime`, no later than the quote expiry, so it can never land
 *     after the quote is gone.
 * 12. No v2 preconditions: no minimum account sequence, no minimum sequence
 *     age or ledger gap, no extra signers and no ledger bounds. Each lets
 *     the transaction wait or land in ways the time bounds do not limit.
 *
 * This package has no Stellar SDK, so decoding is the signer's job; steps 1
 * and 11 are helpers here. `@vindu/grid-stellar` exports
 * `assertPayoutXdrMatches`, a key-free check that implements this whole list
 * with the Stellar SDK; a signer can call it before it signs.
 *
 * Whatever a signer throws, the payout run turns into `SignerRefusedError`
 * (keeping only a code-shaped `code`), so a refusal message may be specific:
 * it never reaches the run's error.
 */
import { SigningNotAllowedError } from './errors';
import { parseInstantMs } from './instant';
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

/** What the transaction must do. The signer decodes the XDR and compares. */
export interface ExpectedPayment {
  /** Account the transaction must spend from (G...). Also the transaction source. */
  readonly source: string;
  /** Account the transaction must pay (G...). */
  readonly destination: string;
  /** Exact amount, and the asset (code and issuer), the transaction must move. */
  readonly amount: Money;
}

/** Everything a signer needs to decide whether to sign. */
export interface SigningContext {
  readonly transferId: string;
  /** Current transfer state. Signing is only allowed in `awaiting_signature`. */
  readonly state: TransferState;
  /** Payout quote the transaction belongs to. */
  readonly quoteId: string;
  /**
   * ISO-8601 instant the quote expires. An expired quote needs a fresh quote
   * and a new XDR, and the transaction's `maxTime` must not be later than this.
   */
  readonly expiresAt: string;
  readonly expected: ExpectedPayment;
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
 * `awaiting_signature` and the quote has not expired at `now`. Fails closed:
 * an invalid `now` (a broken clock) or an unparseable expiry also throws.
 */
export function assertSigningAllowed(context: SigningContext, now: Date = new Date()): void {
  if (context.state !== 'awaiting_signature') {
    throw new SigningNotAllowedError(
      `Transfer ${context.transferId} is in ${context.state}, not awaiting_signature`,
    );
  }
  const expiresAt = quoteExpiryMs(context);
  const at = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(at)) {
    throw new SigningNotAllowedError('The clock gave an invalid time: refusing to sign');
  }
  if (at >= expiresAt) {
    throw new SigningNotAllowedError(
      `Quote ${context.quoteId} expired: get a fresh quote and a new transaction`,
    );
  }
}

/**
 * Throws {@link SigningNotAllowedError} unless the transaction has an upper
 * time bound no later than the quote expiry. `maxTime` is the decoded
 * transaction's `timeBounds.maxTime` in unix seconds; pass `undefined` (or 0,
 * Stellar's "no bound") when it has none, which is refused: a transaction
 * without a bound could land at any time.
 */
export function assertMaxTimeWithinQuote(maxTime: number | undefined, context: SigningContext): void {
  if (maxTime === undefined || maxTime === 0) {
    throw new SigningNotAllowedError('The transaction has no maxTime: it could land at any time');
  }
  if (!Number.isSafeInteger(maxTime) || maxTime < 0) {
    throw new SigningNotAllowedError(`The transaction has an invalid maxTime: ${maxTime}`);
  }
  if (maxTime * 1000 > quoteExpiryMs(context)) {
    throw new SigningNotAllowedError(
      `The transaction may land after quote ${context.quoteId} expires (maxTime ${new Date(maxTime * 1000).toISOString()})`,
    );
  }
}

function quoteExpiryMs(context: SigningContext): number {
  const expiresAt = parseInstantMs(context.expiresAt);
  if (expiresAt === undefined) {
    throw new SigningNotAllowedError(`Quote ${context.quoteId} has an invalid expiry`);
  }
  return expiresAt;
}
