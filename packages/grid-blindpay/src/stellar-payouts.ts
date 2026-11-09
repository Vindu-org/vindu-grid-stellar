/**
 * Stellar payouts (`po_`), the three calls kept separate:
 *
 * 1. `authorize`: BlindPay builds the unsigned Stellar transaction for a quote.
 *    It does not consume the quote.
 * 2. The key holder signs it (outside this module).
 * 3. `create`: hands BlindPay the signed transaction (or its hash, see
 *    `stellar-payout-flow.ts`) with an Idempotency-Key. BlindPay re-validates it
 *    against the quote.
 *
 * `runStellarPayout` in `stellar-payout-flow.ts` chains them safely.
 */
import { InvalidInputError, isStellarAccountId } from '@vindu/grid-core';

import { BLINDPAY_PARTNER_ID } from './config';
import { BlindPayHttpError } from './errors';
import { type BlindPayHttp, type Created, type IdempotencyOptions, create, get } from './http';
import { assertId } from './ids';
import type { AuthorizeStellarPayoutRequest, CreateStellarPayoutRequest, Payout } from './types';

export interface StellarAuthorization {
  /** The unsigned transaction envelope (base64 XDR) to sign. */
  readonly unsignedXdr: string;
}

export interface StellarPayoutsApi {
  authorize(input: AuthorizeStellarPayoutRequest, opts?: IdempotencyOptions): Promise<StellarAuthorization>;
  /** The Idempotency-Key is required: USDC may already be on its way, so every retry must reuse it. */
  create(input: CreateStellarPayoutRequest, opts: { readonly idempotencyKey: string }): Promise<Created<Payout>>;
  /** UNCONFIRMED path, see {@link UNCONFIRMED_GET_PAYOUT_PATH}. */
  getPayout(payoutId: string): Promise<Payout>;
}

/**
 * UNCONFIRMED: the docs read so far do not show the path to read one payout.
 * `GET /payouts/{po_id}` is the likely one. It lives here only, so a different
 * answer from BlindPay is a one-line change.
 */
export const UNCONFIRMED_GET_PAYOUT_PATH = (payoutId: string): string => `/payouts/${payoutId}`;

export function stellarPayoutsApi(http: BlindPayHttp): StellarPayoutsApi {
  return {
    async authorize(input, opts) {
      const body = checkBody(input);
      const res = await create<{ transaction_hash?: unknown }>(http, '/payouts/stellar/authorize', body, opts);
      // The field is named `transaction_hash` but holds the unsigned XDR envelope.
      const xdr = res.data?.transaction_hash;
      if (typeof xdr !== 'string' || xdr === '') {
        throw new BlindPayHttpError({
          partner: BLINDPAY_PARTNER_ID,
          method: 'POST',
          path: '/v1/instances/{in_id}/payouts/stellar/authorize',
          status: 200,
          code: 'unexpected_response',
          retryable: false,
          idempotencyKey: res.idempotencyKey,
        });
      }
      return { unsignedXdr: xdr };
    },
    async create(input, opts) {
      if (typeof opts?.idempotencyKey !== 'string' || opts.idempotencyKey === '') {
        throw new InvalidInputError('create needs an idempotencyKey, reused on every retry');
      }
      if (typeof input.signed_transaction !== 'string' || input.signed_transaction === '') {
        throw new InvalidInputError('signed_transaction must be a non-empty string');
      }
      const body = { ...checkBody(input), signed_transaction: input.signed_transaction };
      return create<Payout>(http, '/payouts/stellar', body, opts);
    },
    async getPayout(payoutId) {
      return get<Payout>(http, UNCONFIRMED_GET_PAYOUT_PATH(assertId(payoutId, 'po', 'payoutId')));
    },
  };
}

function checkBody(input: AuthorizeStellarPayoutRequest): AuthorizeStellarPayoutRequest {
  if (!isStellarAccountId(input.sender_wallet_address)) {
    throw new InvalidInputError('sender_wallet_address must be a Stellar account id (G...)');
  }
  return { quote_id: assertId(input.quote_id, 'qu', 'quote_id'), sender_wallet_address: input.sender_wallet_address };
}
