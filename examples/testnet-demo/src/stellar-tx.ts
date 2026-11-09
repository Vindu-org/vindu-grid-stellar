/**
 * Builds and reads real Stellar payment transactions, locally.
 *
 * Nothing here touches the network: an envelope is just bytes, built on the
 * testnet passphrase so it would be valid on testnet as is.
 */
import { type Asset as CoreAsset, type Money, money } from '@vindu/grid-core';

import { Account, Asset, BASE_FEE, Memo, Operation, Transaction, TransactionBuilder } from './sdk';

export interface PaymentTxInput {
  readonly source: string;
  /** Current sequence number of the source account. The transaction uses the next one. */
  readonly sequence: string;
  readonly destination: string;
  readonly amount: Money;
  /** Unix seconds after which the transaction can never land. */
  readonly maxTime: number;
  readonly memo?: string;
  readonly networkPassphrase: string;
}

/** One unsigned payment transaction, as base64 XDR. */
export function buildPaymentXdr(input: PaymentTxInput): string {
  const { asset } = input.amount;
  if (asset.issuer === undefined) throw new TypeError('A Stellar payment needs an issued asset');
  const builder = new TransactionBuilder(new Account(input.source, input.sequence), {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
    timebounds: { minTime: 0, maxTime: input.maxTime },
  }).addOperation(
    Operation.payment({
      destination: input.destination,
      asset: new Asset(asset.code, asset.issuer),
      amount: input.amount.amount,
    }),
  );
  if (input.memo !== undefined) builder.addMemo(Memo.text(input.memo));
  return builder.build().toXDR();
}

/** What a single-payment transaction does, decoded from its XDR. */
export interface DecodedPayment {
  readonly hash: string;
  readonly source: string;
  readonly sequence: string;
  readonly destination: string;
  readonly amount: Money;
  readonly maxTime: number | undefined;
  readonly memo: string | undefined;
  readonly signatureCount: number;
}

/**
 * Decodes `xdr` and returns its one payment operation.
 * @throws {Error} when the envelope is a fee bump, has more than one
 *   operation, or the operation is not a payment of an issued asset.
 */
export function decodePayment(xdr: string, networkPassphrase: string): DecodedPayment {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error('Fee bump envelopes are not expected here');
  if (tx.operations.length !== 1) throw new Error(`Expected one operation, got ${tx.operations.length}`);
  const op = tx.operations[0];
  if (op === undefined || op.type !== 'payment') throw new Error('Expected a payment operation');
  const issuer = op.asset.getIssuer();
  if (op.asset.isNative() || issuer === undefined) throw new Error('Expected an issued asset, not lumens');
  const asset: CoreAsset = { code: op.asset.getCode(), issuer };
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  return {
    hash: Buffer.from(tx.hash()).toString('hex'),
    source: tx.source,
    sequence: tx.sequence,
    destination: op.destination,
    amount: money(op.amount, asset),
    maxTime: maxTime > 0 ? maxTime : undefined,
    memo: tx.memo.type === 'text' ? String(tx.memo.value) : undefined,
    signatureCount: tx.signatures.length,
  };
}
