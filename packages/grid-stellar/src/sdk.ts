/**
 * The one place that loads `@stellar/stellar-sdk`.
 *
 * The SDK ships CommonJS code but only ES module type declarations, so a
 * CommonJS package like this one cannot `import` it under `node16` module
 * resolution. The types are imported as ES module types and the code is
 * loaded with `require`, which resolves to the SDK's CommonJS build.
 */
import type * as StellarSdk from '@stellar/stellar-sdk' with { 'resolution-mode': 'import' };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- see the comment above
const sdk = require('@stellar/stellar-sdk') as typeof StellarSdk;

export type { StellarSdk };
/** The whole SDK, for tests and internal use. Not re-exported from the package index. */
export const stellarSdk = sdk;
export const { Horizon, NotFoundError, TransactionBuilder, Transaction, FeeBumpTransaction } = sdk;
