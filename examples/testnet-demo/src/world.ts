/**
 * Everything outside the application, built fresh for each run: throwaway
 * testnet keys, an in-memory ledger holding the accounts, and the two mock
 * partners with their capabilities registered as data.
 *
 * No key is read from anywhere. `Keypair.random()` makes new ones each run.
 */
import { type Asset, type CapabilityRegistry, fiat, stellarAsset } from '@vindu/grid-core';
import { TESTNET_NETWORK_PASSPHRASE } from '@vindu/grid-stellar';

import { FakeHorizon } from './fake-horizon';
import { MOCK_OFFCHAIN_CAPABILITIES, MOCK_PARTNER_CAPABILITIES, MockPartner } from './mock-partner';
import { Keypair } from './sdk';
import { TestKeySigner } from './test-key-signer';

export const BRL: Asset = fiat('BRL');
export const USD: Asset = fiat('USD');

export interface DemoWorld {
  readonly networkPassphrase: string;
  readonly ledger: FakeHorizon;
  /** USDC from a throwaway issuer: an asset is its code and its issuer together. */
  readonly usdc: Asset;
  /** Holds the client account's test key. */
  readonly signer: TestKeySigner;
  /** The client's own Stellar account, registered with the partner. */
  readonly clientAddress: string;
  readonly partner: MockPartner;
  readonly offchain: MockPartner;
  readonly registry: CapabilityRegistry;
}

export function createWorld(now: () => number): DemoWorld {
  const networkPassphrase = TESTNET_NETWORK_PASSPHRASE;
  const ledger = new FakeHorizon(networkPassphrase, now);
  const issuer = Keypair.random();
  const treasury = Keypair.random();
  const client = Keypair.random();
  const usdc = stellarAsset('USDC', issuer.publicKey());

  const usdcLine = (balance: string) => ({
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: issuer.publicKey(),
    balance,
    limit: '922337203685.4775807',
    is_authorized: true,
  });
  ledger.addAccount({
    id: client.publicKey(),
    sequence: '4294967296000',
    subentry_count: 1,
    balances: [usdcLine('0.0000000'), { asset_type: 'native', balance: '5.0000000' }],
  });
  ledger.addAccount({
    id: treasury.publicKey(),
    sequence: '4294967297000',
    subentry_count: 1,
    balances: [usdcLine('1000000.0000000'), { asset_type: 'native', balance: '100.0000000' }],
  });

  const partner = new MockPartner({
    id: 'mock-partner',
    chain: 'stellar',
    capabilities: MOCK_PARTNER_CAPABILITIES,
    brlPerUsdc: '5.25',
    usdPerUsdc: '0.9975',
    payoutUsdPerUsdc: '0.9972',
    now,
    stellar: { ledger, networkPassphrase, treasury },
  });
  const offchain = new MockPartner({
    id: 'mock-offchain',
    chain: 'offchain',
    capabilities: MOCK_OFFCHAIN_CAPABILITIES,
    brlPerUsdc: '5.25',
    usdPerUsdc: '0.999',
    now,
  });

  return {
    networkPassphrase,
    ledger,
    usdc,
    signer: new TestKeySigner(client, networkPassphrase, now),
    clientAddress: client.publicKey(),
    partner,
    offchain,
    registry: { [partner.id]: MOCK_PARTNER_CAPABILITIES, [offchain.id]: MOCK_OFFCHAIN_CAPABILITIES },
  };
}
