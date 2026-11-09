# @vindu/grid-stellar

The Stellar layer for two-leg transfers: follow registered accounts on Horizon, match on-chain payments to transfer legs, check that an account can receive USDC, and decode, submit and look up signed transactions without ever paying twice. It does not build transactions: the partner builds them and your signer signs them.

No environment reads, no keys, no signing. Your signer signs; the network passphrase and the Horizon URL are arguments. `TESTNET_*` and `MAINNET_*` constants hold the public values for convenience.

> **Do not submit or look up payouts through the public Horizon URLs.** `TESTNET_HORIZON_URL`, `MAINNET_HORIZON_URL` and the URLs in `STELLAR_TESTNET` and `STELLAR_MAINNET` sit behind load balancers: two requests can reach instances that have ingested different ledgers, so a landed transaction can look missing. For the submit and lookup path, point the gateway at one Horizon instance you operate or trust to be consistent. The public URLs are fine for exploring and demos.

## Status

| Aspect | Status |
|---|---|
| Version | 0.1.0, git tag only: not on npm. Install from the tag `v0.1.0` as the [root README](../../README.md#install-from-a-git-tag) shows. |
| Node | 22.12 or later: the Stellar SDK needs `require()` of ES modules. |
| Format | CommonJS with type declarations. One entry point: import from `@vindu/grid-stellar` only; files under `dist/` are internal. |
| Stability | Early. Every API here may change before the first release. |
| Planned | A shared fake Horizon for application tests, in the tranche 3 integration kit. |

## What is inside

| Module | Contents |
|---|---|
| Horizon gateway | `HorizonGateway`: its network passphrase, the latest ingested ledger (with the oldest one the instance keeps), payments for an account, transaction by hash (with the answering instance's ingested ledger), submit, account. `createHorizonGateway({ horizonUrl, networkPassphrase })` reads with `fetch` (pass `fetch` to replace it) and submits through `@stellar/stellar-sdk` (pass `server` for any object with a `submitTransaction` like the SDK's `Horizon.Server`). Every read times out after `requestTimeoutMs` (default 10 s) and takes an `AbortSignal`. Tests pass a fake. |
| Read layer | `createReadLayer({ gateway, cursorStore, onEvent, onMalformed? })`: `pollAccount` resumes from the stored cursor; `reconcile` re-reads a window without moving it. |
| Payments | `ChainPayment`: payments, path payments and account creation, with core assets and canonical 7-decimal amounts. |
| Matching | `matchPaymentToLeg` by destination, asset and issuer, exact amount, and source, hash or reference when known. `{ requireSource: true }` refuses legs without a source. `partnerAndChainAgree` for the funded check. |
| Accounts | `assessReceiveReadiness`: account exists, trustline for the asset and issuer, optional XLM reserve (1 XLM plus 0.5 per trustline). |
| Submit | `submitSignedTransaction`: hashes computed locally first (outer and inner for a fee bump), hashes checked before any retry, expiry decided by Horizon's ingested ledger, typed result codes. `createStellarSubmitter` adapts it to core's `StellarSubmitter`. |

## Read layer: at least once

The cursor moves past a payment only after `onEvent` resolves. If `onEvent` throws, or the process stops, the payment is delivered again on the next poll. **Drop duplicates by `payment.id`.**

```ts
import { createHorizonGateway, createReadLayer, STELLAR_TESTNET } from '@vindu/grid-stellar';

const gateway = createHorizonGateway(STELLAR_TESTNET);
const layer = createReadLayer({
  gateway,
  cursorStore,                       // your storage: get/set per account
  onEvent: async (payment) => {
    await saveChainEvent(payment);   // unique on payment.id
  },
});
await layer.pollAccount(registeredAccount);
```

A record the layer cannot read (for example an amount that is not a valid decimal, or no string `id`, `paging_token` or `transaction_hash`) never blocks the cursor. It goes to `onMalformed(record, error)` and the poll moves on; by default that logs a warning with the operation id and transaction hash only. Throw from `onMalformed` to stop instead, with the cursor left before that record. Positions past skipped records are stored once per page, not once per record. The cursor only ever moves to a record's own paging token: a record without one never clears it or sends the next page back to the start.

Follow the accounts you registered for your clients, not a partner's shared treasury address. Transactions a partner builds for you may not carry a memo, so the registered account is what ties a payment to a client.

## Matching: say who may pay

`matchPaymentToLeg(payment, legs)` compares destination, asset with issuer and the exact amount, plus `source`, `txHash` and `reference` when the leg has them. **A leg without `source` accepts a payment from any sender**: anyone who sends the right amount to the destination matches it. Set `source` when you know the payer, and pass `{ requireSource: true }` to make legs without one fail on `source`.

## Submit: never sign a replacement while the first could land

```ts
const result = await submitSignedTransaction({ gateway, signedXdr, networkPassphrase });
```

`networkPassphrase` must equal `gateway.networkPassphrase`; otherwise `InvalidConfigError` is thrown before anything is sent, because the local hash would never be found. Durations that are not finite (`NaN`, `Infinity`) or out of range, and a clock that is not finite when the run starts, throw `InvalidInputError`, also before anything is sent.

| Status | Meaning | May you sign a replacement? |
|---|---|---|
| `success` | In a ledger, successful. `hash` is the hash that landed. | No: the payment moved |
| `failed` | In a ledger, failed: fee and sequence spent, nothing moved | Yes, after fixing the cause |
| `rejected`, reason `refused` | Refused by Horizon, not found on the ledger; may still land until maxTime | No |
| `rejected`, reason `hash_mismatch` | Horizon accepted it but answered with another hash. Never a success: the payment may have moved | No: settle it by hand |
| `unknown` | Not found yet and could still land | No: check again later |
| `expired_not_landed` | Horizon's ingested ledger closed after maxTime and a later lookup found nothing | Yes |

Only `failed` and `expired_not_landed` allow a replacement (core's `canSignReplacement`).

**Expiry is decided by the ingested ledger, not the local clock.** `expired_not_landed` needs all three: the transaction has a maxTime; Horizon's latest ingested ledger (`gateway.latestLedger()`) closed after that maxTime; and a successful lookup made after reading that ledger finds nothing by any hash. Horizon ingests ledgers in order, so every ledger that could hold the transaction is already searchable. A failed ledger read or lookup never counts as expired. Point the gateway at a single Horizon instance: behind a load balancer the ledger read and the lookup may reach instances at different ledgers. The local clock only bounds how long to wait (`maxWaitMs`).

**Fee bumps.** Anyone can wrap a signed transaction in a fee bump of their own. For a fee bump both the outer hash and the inner transaction hash are looked up; either found means landed. The result says which (`foundBy`), carries `innerHash`, and `submittedHash` when what landed is another envelope.

Resubmitting the same signed envelope is always safe. This package does not build transactions: the partner does, and your signer refuses one without a maxTime (core's `assertMaxTimeWithinQuote`). Without a maxTime a lost transaction would stay `unknown` forever.

### With the core payout flow

```ts
const submitter = createStellarSubmitter({ gateway, networkPassphrase });
// runSignedPayout({ ..., submitter }): only { status: 'success' } creates the payout.
```

Each outcome keeps the status and hash; every other field of the result is in `detail` (for a mismatch, `detail.reason` is `'hash_mismatch'`).

## Testing

`yarn workspace @vindu/grid-stellar test`. Tests use an in-memory gateway and real envelopes signed with throwaway testnet keys; nothing touches the network. Type checking and tests resolve `@vindu/grid-core` to its sources, so no build is needed first.
