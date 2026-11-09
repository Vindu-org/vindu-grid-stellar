# @vindu/grid-stellar

The Stellar layer for two-leg transfers: follow registered accounts on Horizon, match on-chain payments to transfer legs, check that an account can receive USDC, and submit signed transactions without ever paying twice.

No environment reads, no keys, no signing. Your signer signs; the network passphrase and the Horizon URL are arguments. `TESTNET_*` and `MAINNET_*` constants hold the public values for convenience.

> Status: early, not published. Every API here will change before the first release.

## What is inside

| Module | Contents |
|---|---|
| Horizon gateway | `HorizonGateway`: payments for an account, transaction by hash, submit, account. `createHorizonGateway({ horizonUrl, networkPassphrase })` wraps `@stellar/stellar-sdk`; tests pass a fake. |
| Read layer | `createReadLayer({ gateway, cursorStore, onEvent })`: `pollAccount` resumes from the stored cursor; `reconcile` re-reads a window without moving it. |
| Payments | `ChainPayment`: payments, path payments and account creation, with core assets and canonical 7-decimal amounts. |
| Matching | `matchPaymentToLeg` by destination, asset and issuer, exact amount, and hash or reference when known. `partnerAndChainAgree` for the funded check. |
| Accounts | `assessReceiveReadiness`: account exists, trustline for the asset and issuer, optional XLM reserve (1 XLM plus 0.5 per trustline). |
| Submit | `submitSignedTransaction`: hash computed locally first, hash checked before any retry, typed result codes. |

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

Follow the accounts you registered for your clients, not a partner's shared treasury address. Transactions a partner builds for you may not carry a memo, so the registered account is what ties a payment to a client.

## Submit: never sign a replacement while the first could land

```ts
const result = await submitSignedTransaction({ gateway, signedXdr, networkPassphrase });
```

| Status | Meaning | May you sign a replacement? |
|---|---|---|
| `success` | In a ledger, successful | No need |
| `failed` | In a ledger, failed: fee and sequence spent, nothing moved | Yes, after fixing the cause |
| `rejected` | Refused by Horizon, not on the ledger; may still land until maxTime | No |
| `unknown` | Not found yet and could still land | No: check again later |
| `expired_not_landed` | maxTime (plus a grace period) has passed and it is not on the ledger | Yes |

Resubmitting the same signed envelope is always safe. Build transactions with a maxTime: without one a lost transaction stays `unknown` forever.

## Testing

`yarn workspace @vindu/grid-stellar test`. Tests use an in-memory gateway and real envelopes signed with throwaway testnet keys; nothing touches the network. Type checking and tests resolve `@vindu/grid-core` to its sources, so no build is needed first.
