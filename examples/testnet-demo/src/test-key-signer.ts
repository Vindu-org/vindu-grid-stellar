/**
 * A core `Signer` with a throwaway key, for tests and demos only
 * (`custody: 'test_key'`).
 *
 * It does what core's signer contract asks of every signer, and is meant to
 * be read as a reference for one. Before signing it:
 *
 * 1. checks the transfer state and the quote expiry with `assertSigningAllowed`;
 * 2. refuses a key it does not hold;
 * 3. decodes the XDR and refuses anything other than a plain transaction
 *    (no fee bump) with exactly one payment operation;
 * 4. refuses unless the transaction source is the expected source, and the
 *    operation has no source of its own or the same one;
 * 5. refuses unless the destination, the asset (code and issuer) and the
 *    exact amount match the signing context;
 * 6. refuses a total fee above its cap (`maxFeeStroops`);
 * 7. refuses a transaction whose maxTime is missing or later than the quote
 *    expiry, with `assertMaxTimeWithinQuote`.
 */
import {
  type AccountRef,
  type Custody,
  InvalidConfigError,
  type Signer,
  type SigningContext,
  SigningNotAllowedError,
  assertMaxTimeWithinQuote,
  assetKey,
  assertSigningAllowed,
  equals,
  sameAsset,
} from '@vindu/grid-core';

import { short } from './format';
import { type StellarSdk, Transaction, TransactionBuilder } from './sdk';
import { type DecodedPayment, decodePayment } from './stellar-tx';

/** Default fee cap: 1 000 000 stroops (0.1 XLM) for the whole transaction. */
export const DEFAULT_MAX_FEE_STROOPS = 1_000_000;

export interface TestKeySignerOptions {
  /** Clock in ms since epoch. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Highest total fee it signs, in stroops. Default
   * {@link DEFAULT_MAX_FEE_STROOPS}. A positive safe integer.
   */
  readonly maxFeeStroops?: number;
}

export class TestKeySigner implements Signer {
  readonly custody: Custody = 'test_key';
  private readonly now: () => number;
  private readonly maxFeeStroops: bigint;

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
    this.maxFeeStroops = BigInt(cap);
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

    let tx: DecodedPayment;
    try {
      tx = decodePayment(unsignedXdr, this.networkPassphrase);
    } catch (e) {
      throw new SigningNotAllowedError(
        `Not exactly one payment operation: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const { expected } = context;
    if (tx.source !== account.address || tx.source !== expected.source) {
      throw new SigningNotAllowedError('Source account does not match');
    }
    if (tx.operationSource !== undefined && tx.operationSource !== expected.source) {
      throw new SigningNotAllowedError(
        `The payment spends from ${short(tx.operationSource)}, not the expected source`,
      );
    }
    if (tx.destination !== expected.destination) {
      throw new SigningNotAllowedError(`Destination ${short(tx.destination)} is not the expected ${short(expected.destination)}`);
    }
    if (!sameAsset(tx.amount.asset, expected.amount.asset)) {
      throw new SigningNotAllowedError(`Asset ${assetKey(tx.amount.asset)} is not the expected asset`);
    }
    if (!equals(tx.amount, expected.amount)) {
      throw new SigningNotAllowedError(`Amount ${tx.amount.amount} is not the expected ${expected.amount.amount}`);
    }
    if (BigInt(tx.fee) > this.maxFeeStroops) {
      throw new SigningNotAllowedError(`Fee ${tx.fee} stroops is above the cap of ${this.maxFeeStroops}`);
    }
    assertMaxTimeWithinQuote(tx.maxTime, context);

    const envelope = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    if (!(envelope instanceof Transaction)) throw new SigningNotAllowedError('Fee bump envelopes are not signed here');
    envelope.sign(this.keypair);
    return envelope.toXDR();
  }
}
