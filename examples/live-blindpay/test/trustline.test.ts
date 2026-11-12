// Offline: builds transactions locally with throwaway keys, never touches a network.
import { TESTNET_NETWORK_PASSPHRASE } from '@vindu/grid-stellar';

import { Account, Asset, Keypair, Operation, TransactionBuilder } from '../src/sdk';
import { TRUSTLINE_MAX_FEE_STROOPS, TRUSTLINE_MAX_LIFETIME_SEC, checkTrustlineTransaction } from '../src/step-setup';

const NOW = Date.parse('2026-11-11T03:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);
const account = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();

/** Shaped like a development create-asset-trustline answer: one changeTrust, fee 100, maxTime 300 s out. */
function trustline(opts: { fee?: string; minTime?: number; maxTime?: number; code?: string; source?: string; opSource?: string } = {}): string {
  return new TransactionBuilder(new Account(opts.source ?? account, '7'), { fee: opts.fee ?? '100', networkPassphrase: TESTNET_NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset(opts.code ?? 'USDB', issuer), ...(opts.opSource === undefined ? {} : { source: opts.opSource }) }))
    .setTimebounds(opts.minTime ?? 0, opts.maxTime ?? NOW_SEC + 300)
    .build()
    .toXDR();
}

describe('checkTrustlineTransaction', () => {
  it('accepts the development shape and returns the USDB line', () => {
    const checked = checkTrustlineTransaction(trustline(), account, NOW);
    expect(typeof checked).not.toBe('string');
    expect(typeof checked === 'string' ? undefined : checked.line).toMatchObject({ code: 'USDB', issuer });
  });

  it.each([
    ['a fee over the cap', { fee: String(TRUSTLINE_MAX_FEE_STROOPS + 1) }, /above the cap/],
    ['no maxTime', { maxTime: 0 }, /no maxTime/],
    ['a maxTime already past', { maxTime: NOW_SEC }, /outside/],
    ['a maxTime too far ahead', { maxTime: NOW_SEC + TRUSTLINE_MAX_LIFETIME_SEC + 1 }, /outside/],
    ['a minTime later than now', { minTime: NOW_SEC + 1 }, /minTime/],
    ['another asset', { code: 'USDC' }, /not USDB/],
    ['another source', { source: Keypair.random().publicKey() }, /one changeTrust from the test account/],
    ['an operation source of its own', { opSource: Keypair.random().publicKey() }, /one changeTrust from the test account/],
  ])('refuses %s', (_name, opts, reason) => {
    const checked = checkTrustlineTransaction(trustline(opts), account, NOW);
    expect(typeof checked).toBe('string');
    expect(checked).toEqual(expect.stringMatching(reason));
  });

  it('refuses what is not a transaction envelope', () => {
    expect(checkTrustlineTransaction('AAAA', account, NOW)).toBe('not a transaction envelope');
  });
});
