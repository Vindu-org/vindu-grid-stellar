/**
 * A core `Signer` with a throwaway key, for tests and demos only
 * (`custody: 'test_key'`).
 *
 * It does what core's signer contract asks of every signer, and is meant to
 * be read as a reference for one. Before signing it:
 *
 * 1. checks the transfer state and the quote expiry with
 *    `assertSigningAllowed` (throws `SigningNotAllowedError`);
 * 2. refuses a key it does not hold, or an account other than the expected
 *    source (`SigningNotAllowedError`);
 * 3. checks the transaction itself with grid-stellar's
 *    `assertPayoutXdrMatches` (throws `PayoutXdrMismatchError`): the network,
 *    a plain envelope with exactly one payment, the source and the
 *    operation's source, the destination, the asset and issuer, the exact
 *    amount, a fee cap (`maxFeeStroops`), a `maxTime` within the quote, and
 *    no newer preconditions.
 *
 * In `runSignedPayout`, whatever it throws becomes `SignerRefusedError`,
 * keeping the cause's code (`signing_not_allowed` or `payout_xdr_mismatch`).
 */
import {
  type AccountRef,
  type Custody,
  InvalidConfigError,
  type Signer,
  type SigningContext,
  SigningNotAllowedError,
  assertSigningAllowed,
} from '@vindu/grid-core';
import { DEFAULT_MAX_FEE_STROOPS, assertPayoutXdrMatches } from '@vindu/grid-stellar';

import { short } from './format';
import { type StellarSdk, Transaction, TransactionBuilder } from './sdk';

export interface TestKeySignerOptions {
  /** Clock in ms since epoch. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Highest total fee it signs, in stroops. Default
   * `DEFAULT_MAX_FEE_STROOPS` from `@vindu/grid-stellar`. A positive safe integer.
   */
  readonly maxFeeStroops?: number;
}

export class TestKeySigner implements Signer {
  readonly custody: Custody = 'test_key';
  private readonly now: () => number;
  private readonly maxFeeStroops: number;

  constructor(
    private readonly keypair: StellarSdk.Keypair,
    private readonly networkPassphrase: string,
    options: TestKeySignerOptions = {},
  ) {
    const cap = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;
    if (!Number.isSafeInteger(cap) || cap <= 0) {
      throw new InvalidConfigError(`maxFeeStroops must be a positive whole number of stroops: ${cap}`);
    }
    this.now = options.now ?? Date.now;
    this.maxFeeStroops = cap;
  }

  /** The account this signer can sign for. */
  get address(): string {
    return this.keypair.publicKey();
  }

  async signStellar(account: AccountRef, unsignedXdr: string, context: SigningContext): Promise<string> {
    assertSigningAllowed(context, new Date(this.now()));
    if (account.chain !== 'stellar' || account.address !== this.address) {
      throw new SigningNotAllowedError(`This signer holds no key for ${short(account.address)}`);
    }
    if (account.address !== context.expected.source) {
      throw new SigningNotAllowedError(`Account ${short(account.address)} is not the expected source`);
    }
    assertPayoutXdrMatches(unsignedXdr, context, {
      networkPassphrase: this.networkPassphrase,
      maxFeeStroops: this.maxFeeStroops,
      now: this.now,
    });

    // Checked above: a plain transaction for this network. The guard only narrows the type.
    const envelope = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    if (!(envelope instanceof Transaction)) throw new SigningNotAllowedError('Only a plain transaction is signed here');
    envelope.sign(this.keypair);
    return envelope.toXDR();
  }
}
