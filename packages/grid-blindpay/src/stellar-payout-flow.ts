/**
 * The signed Stellar payout, end to end:
 *
 *   authorize -> check the quote and transfer state -> sign once
 *     -> [client_submits: put the transaction on Stellar] -> create
 *
 * Two BlindPay answers are still open, so both are options rather than code paths
 * to rewrite later:
 * - `submission`: whether we submit to Stellar first (`client_submits`, the
 *   docs' example and the default) or hand the signed XDR to BlindPay (`partner_submits`).
 * - `signedTransactionField`: whether `signed_transaction` carries the signed
 *   XDR (`signed_xdr`, default) or the transaction hash (`tx_hash`). UNCONFIRMED.
 *
 * Safety rules:
 * - The signer is called at most once per run. An expired quote throws
 *   {@link QuoteExpiredError}: get a fresh quote and authorize again. An old
 *   XDR is never signed or submitted.
 * - Once the transaction may be on Stellar, every failure throws
 *   {@link StellarPayoutIncompleteError} with the signed XDR, the hash and the
 *   exact create body and key, so the caller can retry `create` unchanged.
 */
import {
  type AccountRef,
  GridError,
  type Logger,
  type Signer,
  type SigningContext,
  assertSigningAllowed,
  noopLogger,
} from '@vindu/grid-core';

import { InvalidInputError } from './errors';
import type { BlindPayClient } from './client';
import type { CreateStellarPayoutRequest, Payout } from './types';

export type PayoutSubmission = 'client_submits' | 'partner_submits';
export type SignedTransactionField = 'signed_xdr' | 'tx_hash';

/** Puts a signed transaction on Stellar. `@vindu/grid-stellar` provides one; any object of this shape works. */
export interface StellarSubmitter {
  submit(signedXdr: string): Promise<{ readonly hash: string }>;
}

export interface RunStellarPayoutInput {
  readonly client: Pick<BlindPayClient, 'stellarPayouts'>;
  readonly quoteId: string;
  /** The registered wallet's Stellar account (G...). */
  readonly senderAddress: string;
  /** The wallet's BlindPay id (`bw_`), passed to the signer as `partnerAccountId`. */
  readonly walletId?: string;
  readonly signer: Signer;
  /** Must name the same quote. Its `expiresAt` is the quote's expiry. */
  readonly signingContext: SigningContext;
  /** Required for `client_submits`. */
  readonly submitter?: StellarSubmitter;
  readonly submission?: PayoutSubmission;
  readonly signedTransactionField?: SignedTransactionField;
  /** Key for `create`. Store it before calling, and reuse it on every retry of this payout. */
  readonly idempotencyKey: string;
  /** Refuse to sign when less than this is left on the quote. Default 0. */
  readonly expiryMarginMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** Everything needed to repeat `create` unchanged. */
export interface PendingPayoutCreate {
  readonly body: CreateStellarPayoutRequest;
  readonly idempotencyKey: string;
  readonly signedXdr: string;
  readonly txHash?: string;
}

export interface StellarPayoutResult extends PendingPayoutCreate {
  readonly payout: Payout;
  /** True when BlindPay replayed an earlier create with the same key. */
  readonly replayed: boolean;
}

/** The quote expired before the transaction was signed or submitted. Re-quote and re-authorize. */
export class QuoteExpiredError extends GridError {
  constructor(readonly quoteId: string, readonly expiresAt: string) {
    super('quote_expired', `Quote ${quoteId} expired at ${expiresAt}: get a fresh quote and authorize again; do not reuse the old transaction`);
  }
}

/**
 * The transaction may be on Stellar but BlindPay has not recorded the payout.
 * - `stage: 'submit'`: the submit outcome is unknown. Check the hash on Stellar
 *   before anything else, and never sign a replacement while it could still land.
 * - `stage: 'create'`: retry `create` with `pending` (same body, same key) via
 *   {@link retryStellarPayoutCreate}. BlindPay keeps keys for 24 hours.
 */
export class StellarPayoutIncompleteError extends GridError {
  constructor(
    readonly stage: 'submit' | 'create',
    readonly signedXdr: string,
    readonly txHash: string | undefined,
    /** Undefined only when the create body needs a hash that is not known yet. */
    readonly pending: PendingPayoutCreate | undefined,
    options: { cause?: unknown } = {},
  ) {
    super(
      'payout_not_recorded',
      stage === 'submit'
        ? 'Stellar submit outcome unknown: check the transaction on Stellar before anything else; do not sign again'
        : 'Payout create failed after signing: retry create with the same body and Idempotency-Key',
      options,
    );
  }
}

const TX_HASH_RE = /^[0-9a-f]{64}$/i;

export async function runStellarPayout(input: RunStellarPayoutInput): Promise<StellarPayoutResult> {
  const submission = input.submission ?? 'client_submits';
  const field = input.signedTransactionField ?? 'signed_xdr';
  const now = input.now ?? Date.now;
  const logger = input.logger ?? noopLogger;
  checkInput(input, submission, field);

  const ctx = input.signingContext;
  const assertFresh = () => {
    const expiresAt = Date.parse(ctx.expiresAt);
    if (Number.isNaN(expiresAt) || now() + (input.expiryMarginMs ?? 0) >= expiresAt) {
      throw new QuoteExpiredError(input.quoteId, ctx.expiresAt);
    }
  };

  assertFresh();
  const { unsignedXdr } = await input.client.stellarPayouts.authorize({
    quote_id: input.quoteId,
    sender_wallet_address: input.senderAddress,
  });
  logger.info('stellar payout authorized', { quoteId: input.quoteId });

  assertFresh();
  assertSigningAllowed(ctx, new Date(now()));
  const account: AccountRef = {
    chain: 'stellar',
    address: input.senderAddress,
    ...(input.walletId === undefined ? {} : { partnerAccountId: input.walletId }),
  };
  const signedXdr = await input.signer.signStellar(account, unsignedXdr, ctx);
  if (typeof signedXdr !== 'string' || signedXdr === '') {
    throw new InvalidInputError('signer returned an empty transaction');
  }

  // Still unsubmitted: an expired quote here is safe to abandon. The signed XDR is dropped.
  assertFresh();

  let txHash: string | undefined;
  if (submission === 'client_submits') {
    const submitter = input.submitter as StellarSubmitter;
    try {
      txHash = (await submitter.submit(signedXdr)).hash;
    } catch (cause) {
      throw new StellarPayoutIncompleteError('submit', signedXdr, undefined, pendingFor(input, field, signedXdr, undefined), { cause });
    }
    if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) {
      throw new StellarPayoutIncompleteError('submit', signedXdr, undefined, pendingFor(input, field, signedXdr, undefined));
    }
    logger.info('stellar payout submitted', { quoteId: input.quoteId, txHash });
  }

  const pending = pendingFor(input, field, signedXdr, txHash) as PendingPayoutCreate;
  return retryStellarPayoutCreate(input.client, pending);
}

/**
 * Sends `create` with exactly the pending body and key. Use it to retry after
 * {@link StellarPayoutIncompleteError}; it never signs or submits anything.
 */
export async function retryStellarPayoutCreate(
  client: Pick<BlindPayClient, 'stellarPayouts'>,
  pending: PendingPayoutCreate,
): Promise<StellarPayoutResult> {
  try {
    const res = await client.stellarPayouts.create(pending.body, { idempotencyKey: pending.idempotencyKey });
    return { ...pending, payout: res.data, replayed: res.replayed };
  } catch (cause) {
    throw new StellarPayoutIncompleteError('create', pending.signedXdr, pending.txHash, pending, { cause });
  }
}

function pendingFor(
  input: RunStellarPayoutInput,
  field: SignedTransactionField,
  signedXdr: string,
  txHash: string | undefined,
): PendingPayoutCreate | undefined {
  const signed = field === 'signed_xdr' ? signedXdr : txHash;
  if (signed === undefined) return undefined;
  return {
    body: { quote_id: input.quoteId, signed_transaction: signed, sender_wallet_address: input.senderAddress },
    idempotencyKey: input.idempotencyKey,
    signedXdr,
    ...(txHash === undefined ? {} : { txHash }),
  };
}

function checkInput(input: RunStellarPayoutInput, submission: PayoutSubmission, field: SignedTransactionField): void {
  if (submission !== 'client_submits' && submission !== 'partner_submits') {
    throw new InvalidInputError(`Unknown submission mode: ${String(submission)}`);
  }
  if (field !== 'signed_xdr' && field !== 'tx_hash') {
    throw new InvalidInputError(`Unknown signedTransactionField: ${String(field)}`);
  }
  if (submission === 'client_submits' && input.submitter === undefined) {
    throw new InvalidInputError('client_submits needs a submitter');
  }
  if (submission === 'partner_submits' && field === 'tx_hash') {
    throw new InvalidInputError('partner_submits cannot send a tx_hash: nothing was submitted, so there is no hash');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
    throw new InvalidInputError('idempotencyKey is required and must be reused on every retry');
  }
  if (input.signingContext.quoteId !== input.quoteId) {
    throw new InvalidInputError('signingContext.quoteId does not match quoteId');
  }
}
