/**
 * Loads `@stellar/stellar-sdk`, the same way `@vindu/grid-stellar` does.
 *
 * The SDK ships CommonJS code but only ES module type declarations, so this
 * CommonJS example imports the types as ES module types and loads the code
 * with `require`.
 */
import type * as StellarSdk from '@stellar/stellar-sdk' with { 'resolution-mode': 'import' };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- see the comment above
const sdk = require('@stellar/stellar-sdk') as typeof StellarSdk;

export type { StellarSdk };
export const { Account, Asset, BASE_FEE, Keypair, Memo, Operation, Transaction, TransactionBuilder } = sdk;
