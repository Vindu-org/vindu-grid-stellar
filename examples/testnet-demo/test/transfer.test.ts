import {
  type SignedPayoutResult,
  type Signer,
  money,
  runSignedPayout,
  stellarAsset,
} from '@vindu/grid-core';

import { Keypair } from '../src/sdk';
import { StateConflictError, Transfer } from '../src/transfer';

const route = { partner: 'p', chain: 'stellar' };

/** A transfer already moved to `payout_quoted` along the table. */
function quotedTransfer(): Transfer {
  const transfer = new Transfer('t-1', route, () => undefined);
  for (const to of ['awaiting_pix', 'funding', 'funded', 'payout_quoted'] as const) transfer.move(to);
  return transfer;
}

describe('Transfer.compareAndMove', () => {
  it('moves when the transfer is in the expected state, and returns the new state', () => {
    const transfer = quotedTransfer();
    expect(transfer.compareAndMove('payout_quoted', 'awaiting_signature', undefined, 'signed_payout_flow')).toBe(
      'awaiting_signature',
    );
    expect(transfer.state).toBe('awaiting_signature');
  });

  it('throws and moves nothing when the transfer is elsewhere', () => {
    const transfer = quotedTransfer();
    transfer.move('awaiting_signature', undefined, 'signed_payout_flow');
    const history = [...transfer.history];
    expect(() => transfer.compareAndMove('payout_quoted', 'awaiting_signature', undefined, 'signed_payout_flow')).toThrow(
      StateConflictError,
    );
    expect(transfer.state).toBe('awaiting_signature');
    expect(transfer.history).toEqual(history);
  });

  // The rule the payout flow documents: with onAuthorized as a compare-and-set,
  // two runs for one transfer cannot both sign.
  it('lets only one of two concurrent payout runs sign', async () => {
    const transfer = quotedTransfer();
    const client = Keypair.random().publicKey();
    const usdc = stellarAsset('USDC', Keypair.random().publicKey());
    const quote = {
      id: 'pq-1',
      partner: 'p',
      kind: 'payout' as const,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      source: money('100', usdc),
      target: money('99.7', { code: 'USD' }),
      fees: [],
    };
    const signStellar = jest.fn(async () => 'AAAASIGNED');
    const signer: Signer = { custody: 'test_key', signStellar };
    const run = () =>
      runSignedPayout({
        adapter: {
          id: 'p',
          preparePayout: async () => ({ kind: 'stellar_xdr', unsignedXdr: 'AAAAUNSIGNED' }),
          executePayout: async () => ({ partner: 'p', kind: 'payout', id: 'po-1' }),
        },
        context: { transferId: transfer.id, state: 'payout_quoted', quote, account: { chain: 'stellar', address: client } },
        funded: money('100', usdc),
        signing: {
          signer,
          submission: 'partner_submits',
          destination: Keypair.random().publicKey(),
          onAuthorized: () => transfer.compareAndMove('payout_quoted', 'awaiting_signature', undefined, 'signed_payout_flow'),
        },
        now: Date.now,
        idempotencyKey: `${transfer.id}:payout`,
      });

    const [first, second] = await Promise.allSettled([run(), run()]);
    const results = [first, second];
    expect(results.filter((r): r is PromiseFulfilledResult<SignedPayoutResult> => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StateConflictError);
    expect(signStellar).toHaveBeenCalledTimes(1);
    expect(transfer.history.filter((s) => s === 'awaiting_signature')).toHaveLength(1);
  });
});
