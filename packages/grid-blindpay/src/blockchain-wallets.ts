/**
 * Blockchain wallets (`bw_`) on Stellar. The account must already exist on the
 * network with a trustline for the token. Managed wallets do not support
 * Stellar, so every wallet here is an external account (`is_account_abstraction: true`).
 */
import { InvalidInputError, isStellarAccountId } from '@vindu/grid-core';

import { type BlindPayHttp, type Created, type IdempotencyOptions, create, get, list } from './http';
import { assertId } from './ids';
import type { BlindPayNetwork, BlockchainWallet, ListParams, Page } from './types';

export interface CreateStellarWalletInput {
  readonly name: string;
  readonly network: BlindPayNetwork;
  /** Stellar account id (G...). */
  readonly address: string;
  /**
   * Whether the customer holds the key themselves. Required: BlindPay rejects
   * a wallet without it for Brazilian customers (`400 self_custody_required`),
   * and the answer is saved once and cannot be changed through the API.
   */
  readonly is_self_custody: boolean;
}

export interface BlockchainWalletsApi {
  create(customerId: string, input: CreateStellarWalletInput, opts?: IdempotencyOptions): Promise<Created<BlockchainWallet>>;
  list(customerId: string, params?: ListParams): Promise<Page<BlockchainWallet>>;
  get(customerId: string, walletId: string): Promise<BlockchainWallet>;
  /** Answers `is_self_custody` once, for wallets created without it. A second call fails with `409 self_custody_already_set`. */
  setSelfCustody(customerId: string, walletId: string, isSelfCustody: boolean): Promise<BlockchainWallet>;
}

export function blockchainWalletsApi(http: BlindPayHttp): BlockchainWalletsApi {
  const base = (customerId: string) => `/customers/${assertId(customerId, 're', 'customerId')}/blockchain-wallets`;
  return {
    async create(customerId, input, opts) {
      if (!isStellarAccountId(input.address)) throw new InvalidInputError('address must be a Stellar account id (G...)');
      if (typeof input.is_self_custody !== 'boolean') throw new InvalidInputError('is_self_custody must be answered');
      const body = {
        name: input.name,
        network: input.network,
        is_account_abstraction: true,
        address: input.address,
        is_self_custody: input.is_self_custody,
      };
      return create<BlockchainWallet>(http, base(customerId), body, opts);
    },
    async list(customerId, params) {
      return list<BlockchainWallet>(http, base(customerId), params);
    },
    async get(customerId, walletId) {
      return get<BlockchainWallet>(http, `${base(customerId)}/${assertId(walletId, 'bw', 'walletId')}`);
    },
    async setSelfCustody(customerId, walletId, isSelfCustody) {
      const res = await http.request<BlockchainWallet>({
        method: 'PATCH',
        path: `${base(customerId)}/${assertId(walletId, 'bw', 'walletId')}`,
        body: { is_self_custody: isSelfCustody },
      });
      return res.data;
    },
  };
}
