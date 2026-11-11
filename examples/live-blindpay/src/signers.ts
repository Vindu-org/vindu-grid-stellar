/**
 * Signer wrappers for the live run. Each keeps core's sign-once contract:
 * the wrapped signer is called exactly once per call, and refuses exactly
 * when it would.
 *
 * - {@link observingSigner} records what BlindPay's unsigned transaction
 *   looks like (time bounds, fee, destination) before the real signer
 *   checks and signs it. Observing never changes what gets signed.
 * - {@link feeBumpingSigner} wraps the signed payment in a fee bump paid by
 *   the same test account, to see whether BlindPay takes one. The payment
 *   inside is the one transaction the inner signer checked and signed; a
 *   fee bump cannot make it land twice.
 */
import type { AccountRef, Custody, Signer, SigningContext } from '@vindu/grid-core';

import { type StellarSdk, Transaction, TransactionBuilder } from './sdk';

/** What an unsigned payout transaction asks for. */
export interface UnsignedPayoutFacts {
  readonly operations: number;
  readonly type: string | undefined;
  readonly destination: string | undefined;
  readonly amount: string | undefined;
  readonly assetCode: string | undefined;
  readonly assetIssuer: string | undefined;
  readonly feeStroops: string;
  readonly minTime: number | undefined;
  readonly maxTime: number | undefined;
  readonly memoType: string;
  readonly source: string;
}

/** Decodes an unsigned payout envelope for reporting only. It checks nothing. */
export function describeUnsignedPayout(unsignedXdr: string, networkPassphrase: string): UnsignedPayoutFacts {
  const envelope = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!(envelope instanceof Transaction)) throw new Error('not a plain transaction');
  const op = envelope.operations[0];
  const payment = op?.type === 'payment' ? op : undefined;
  return {
    operations: envelope.operations.length,
    type: op?.type,
    destination: payment?.destination,
    amount: payment?.amount,
    assetCode: payment === undefined ? undefined : payment.asset.isNative() ? 'XLM' : payment.asset.getCode(),
    assetIssuer: payment === undefined || payment.asset.isNative() ? undefined : payment.asset.getIssuer(),
    feeStroops: envelope.fee,
    minTime: envelope.timeBounds === undefined ? undefined : Number(envelope.timeBounds.minTime),
    maxTime: envelope.timeBounds === undefined ? undefined : Number(envelope.timeBounds.maxTime),
    memoType: envelope.memo.type,
    source: envelope.source,
  };
}

export function observingSigner(
  inner: Signer,
  observe: (unsignedXdr: string, context: SigningContext) => void,
): Signer {
  return {
    custody: inner.custody,
    async signStellar(account: AccountRef, unsignedXdr: string, context: SigningContext): Promise<string> {
      try {
        observe(unsignedXdr, context);
      } catch {
        // Observing is for the report only; the inner signer decides.
      }
      return inner.signStellar(account, unsignedXdr, context);
    },
  };
}

export function feeBumpingSigner(
  inner: Signer,
  feeSource: StellarSdk.Keypair,
  networkPassphrase: string,
  /** Fee per operation of the bump, in stroops (inner ops + 1). */
  baseFeeStroops: string,
): Signer {
  const custody: Custody = inner.custody;
  return {
    custody,
    async signStellar(account, unsignedXdr, context) {
      const signed = await inner.signStellar(account, unsignedXdr, context);
      const tx = TransactionBuilder.fromXDR(signed, networkPassphrase);
      if (!(tx instanceof Transaction)) throw new Error('the inner signer returned a fee bump');
      const bump = TransactionBuilder.buildFeeBumpTransaction(feeSource, baseFeeStroops, tx, networkPassphrase);
      bump.sign(feeSource);
      return bump.toXDR();
    },
  };
}
