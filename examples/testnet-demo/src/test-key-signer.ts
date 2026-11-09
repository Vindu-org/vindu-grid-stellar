/**
 * A core `Signer` with a throwaway key, for tests and demos only
 * (`custody: 'test_key'`).
 *
 * It does what the README asks of every signer: before signing, it checks
 * the transfer state and the quote expiry with `assertSigningAllowed`, then
 * decodes the XDR and refuses unless the source, the destination, the asset
 * and the exact amount match the signing context.
 */
import {
  type AccountRef,
  type Custody,
  type Signer,
  type SigningContext,
  SigningNotAllowedError,
  assetKey,
  assertSigningAllowed,
  equals,
  sameAsset,
} from '@vindu/grid-core';

import { short } from './format';
import { type StellarSdk, Transaction, TransactionBuilder } from './sdk';
import { decodePayment } from './stellar-tx';

export class TestKeySigner implements Signer {
  readonly custody: Custody = 'test_key';

  constructor(
    private readonly keypair: StellarSdk.Keypair,
    private readonly networkPassphrase: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The account this signer can sign for. */
  get address(): string {
    return this.keypair.publicKey();
  }

  async signStellar(account: AccountRef, unsignedXdr: string, context: SigningContext): Promise<string> {
    assertSigningAllowed(context, new Date(this.now()));
    if (account.chain !== 'stellar' || account.address !== this.address) {
      throw new SigningNotAllowedError(`This signer holds no key for ${short(account.address)}`);
    }

    let tx;
    try {
      tx = decodePayment(unsignedXdr, this.networkPassphrase);
    } catch (e) {
      throw new SigningNotAllowedError(`Not a single payment: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { expected } = context;
    if (tx.source !== account.address) throw new SigningNotAllowedError('Source account does not match');
    if (tx.destination !== expected.destination) {
      throw new SigningNotAllowedError(`Destination ${short(tx.destination)} is not the expected ${short(expected.destination)}`);
    }
    if (!sameAsset(tx.amount.asset, expected.amount.asset)) {
      throw new SigningNotAllowedError(`Asset ${assetKey(tx.amount.asset)} is not the expected asset`);
    }
    if (!equals(tx.amount, expected.amount)) {
      throw new SigningNotAllowedError(`Amount ${tx.amount.amount} is not the expected ${expected.amount.amount}`);
    }
    if (tx.maxTime === undefined || tx.maxTime * 1000 > Date.parse(context.expiresAt)) {
      throw new SigningNotAllowedError('The transaction may land after the quote expires');
    }

    const envelope = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    if (!(envelope instanceof Transaction)) throw new SigningNotAllowedError('Fee bump envelopes are not signed here');
    envelope.sign(this.keypair);
    return envelope.toXDR();
  }
}
