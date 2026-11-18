/** One object with every BlindPay API this package covers, sharing one HTTP setup. */
import { type BlockchainWalletsApi, blockchainWalletsApi } from './blockchain-wallets';
import type { BlindPayConfig } from './config';
import { type CustomersApi, customersApi } from './customers';
import { type BlindPayHttp, createBlindPayHttp } from './http';
import { type PartnerFeesApi, partnerFeesApi } from './partner-fees';
import { type PayinQuotesApi, payinQuotesApi } from './payin-quotes';
import { type PayinsApi, payinsApi } from './payins';
import { type PayoutQuotesApi, payoutQuotesApi } from './payout-quotes';
import { type StellarPayoutsApi, stellarPayoutsApi } from './stellar-payouts';

export interface BlindPayClient {
  readonly http: BlindPayHttp;
  readonly customers: CustomersApi;
  readonly blockchainWallets: BlockchainWalletsApi;
  readonly payinQuotes: PayinQuotesApi;
  readonly payins: PayinsApi;
  readonly payoutQuotes: PayoutQuotesApi;
  readonly stellarPayouts: StellarPayoutsApi;
  readonly partnerFees: PartnerFeesApi;
}

export function createBlindPayClient(config: BlindPayConfig): BlindPayClient {
  const http = createBlindPayHttp(config);
  return {
    http,
    customers: customersApi(http),
    blockchainWallets: blockchainWalletsApi(http),
    payinQuotes: payinQuotesApi(http),
    payins: payinsApi(http),
    payoutQuotes: payoutQuotesApi(http),
    stellarPayouts: stellarPayoutsApi(http),
    partnerFees: partnerFeesApi(http),
  };
}
