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
| Submit | `submitSignedTransaction`: hashes computed locally first (outer and inner for a fee bump), hashes checked before any retry, expiry proven by Horizon's ingested ledgers, typed result codes, a fixed time budget. `createStellarSubmitter` adapts it to core's `StellarSubmitter` and reports `maxDurationMs`. |
| Payout check | `assertPayoutXdrMatches(unsignedXdr, context, { networkPassphrase, maxFeeStroops? })`: a key-free check, for signers, that the partner's unsigned transaction is exactly the expected payment. |

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
| `unknown` | Not found yet and could still land, or expiry could not be proven. With reason `unexpected_lookup_hash`, a lookup returned a transaction that is not ours | No: check again later |
| `expired_not_landed` | Horizon proved it can never land (below) | Yes |

Only `failed` and `expired_not_landed` allow a replacement (core's `canSignReplacement`).

**Expiry is proven by Horizon, never by the local clock.** Before the first submission the submitter reads Horizon's latest ingested ledger once. `expired_not_landed` then needs every one of these, and anything missing or doubtful gives `unknown`:

1. the transaction has a maxTime (greater than 0);
2. the latest ledger Horizon had ingested, read before the lookups, closed after that maxTime;
3. every lookup that found nothing reports, in Horizon's `Latest-Ledger` response header, an ingested ledger at least as recent as that checked ledger;
4. the checked instance keeps history from a ledger no later than the one read before the first submission (`history_elder_ledger`).

A failed or timed-out ledger read or lookup never counts. The local clock only bounds how long to wait. The default gateway reads the root resource for (2) and (4) and the response header for (3); a custom gateway that leaves `latestLedger` or `elderLedger` out never proves expiry. With `maxWaitMs: 0` nothing is read before submitting, so the result is never `expired_not_landed`.

**A lookup must return our transaction.** A record is accepted only when its hash is the hash looked up, our envelope hash or our inner hash, or its inner transaction's hash is our inner (or plain) hash. Anything else ends the run as `unknown` with reason `unexpected_lookup_hash` and the returned hashes, never as a success.

**A landed failure keeps its own codes.** When the transaction is found in a ledger as failed, `error` holds that transaction's own result codes (read from its result), never the refusal a resubmission got (for example `tx_bad_seq`, which a resubmission of a landed transaction always gets).

**Time budget.** One run takes at most `timeoutMs + maxWaitMs` (defaults 30 s + 2 min). The first submission always gets its full `timeoutMs`; the ledger read before it comes out of `maxWaitMs`. Every Horizon read is aborted at `requestTimeoutMs` (default 10 s) or at the deadline, whichever comes first, and a timed-out lookup is an error, never "not found". The deadline is fixed once from the clock; a later clock reading that is not finite ends the run with `unknown`, and the number of polls is capped at `maxWaitMs / pollIntervalMs` plus one, so a broken or stuck clock cannot keep it looping.

**Fee bumps.** Anyone can wrap a signed transaction in a fee bump of their own. For a fee bump both the outer hash and the inner transaction hash are looked up; either found means landed. The result says which (`foundBy`), carries `innerHash`, and `submittedHash` when what landed is another envelope.

Resubmitting the same signed envelope is always safe. This package does not build transactions: the partner does, and your signer refuses one without a maxTime (`assertPayoutXdrMatches` below). Without a maxTime a lost transaction would stay `unknown` forever.

### With the core payout flow

```ts
const submitter = createStellarSubmitter({ gateway, networkPassphrase });
submitter.maxDurationMs; // timeoutMs + maxWaitMs: 150 000 with the defaults
// runSignedPayout({ ..., submitter }): only { status: 'success' } creates the payout.
```

Each outcome keeps the status and hash; every other field of the result is in `detail` (for a mismatch, `detail.reason` is `'hash_mismatch'`). `maxDurationMs` is the longest one `submit` can take: keep at least that much quote time, plus a margin, before signing.

## Check the payout transaction before signing

The partner builds the transaction, so a signer that signs whatever it is handed signs whatever the partner asks. `assertPayoutXdrMatches` holds no key; call it in your signer, or before handing the XDR to a custodian, and sign only if it returns:

```ts
import { assertPayoutXdrMatches } from '@vindu/grid-stellar';

async signStellar(account, unsignedXdr, context) {
  assertSigningAllowed(context);   // core: state, quote expiry, clock
  assertPayoutXdrMatches(unsignedXdr, context, { networkPassphrase, maxFeeStroops: 1_000_000 });
  return sign(unsignedXdr);        // under the same networkPassphrase
}
```

It throws `PayoutXdrMismatchError` (code `payout_xdr_mismatch`, with `check` naming the failed check) unless all of these hold:

- the XDR decodes for `networkPassphrase` as a plain transaction, not a fee bump (an envelope does not name its network: sign under the same passphrase, which binds the signature to it);
- exactly one operation, a `payment`;
- the transaction source is `context.expected.source`;
- the operation has no source, or the same account, including a muxed `M...` form of it;
- the destination is `expected.destination`;
- the asset code and issuer, and the exact amount, are `expected.amount`;
- the total fee is at most `maxFeeStroops` (default 1 000 000 stroops);
- a `maxTime` greater than 0 and no later than the quote expiry (core's `assertMaxTimeWithinQuote`);
- none of the newer preconditions: minimum account sequence, its age or ledger gap, extra signers, ledger bounds (unset or zero only).

## Testing

`yarn workspace @vindu/grid-stellar test`. Tests use an in-memory gateway and real envelopes signed with throwaway testnet keys; nothing touches the network. Type checking and tests resolve `@vindu/grid-core` to its sources, so no build is needed first.
