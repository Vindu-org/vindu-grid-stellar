# @vindu/grid-stellar

The Stellar layer for two-leg transfers: follow registered accounts on Horizon, match on-chain payments to transfer legs, check that an account can receive USDC, and decode, submit and look up signed transactions without ever paying twice. It does not build transactions: the partner builds them and your signer signs them.

No environment reads, no keys, no signing. Your signer signs; the network passphrase and the Horizon URL are arguments. `TESTNET_*` and `MAINNET_*` constants hold the public values for convenience.

> **Do not submit or look up payouts through the public Horizon URLs.** `TESTNET_HORIZON_URL`, `MAINNET_HORIZON_URL` and the URLs in `STELLAR_TESTNET` and `STELLAR_MAINNET` sit behind load balancers: two requests can reach instances that have ingested different ledgers, so a landed transaction can look missing and the submitter can prove nothing (`unknown`). For the submit and lookup path, point the gateway at one Horizon instance you operate or trust to be consistent. The public URLs are fine for exploring and demos.

## Status

| Aspect | Status |
|---|---|
| Version | 0.1.0, git tag only: not on npm. Install from the tag `v0.1.0` as the [root README](../../README.md#install-from-a-git-tag) shows. |
| Node | 22.12 or later: the Stellar SDK needs `require()` of ES modules. |
| Format | CommonJS with type declarations. One entry point: import from `@vindu/grid-stellar` only; files under `dist/` are internal. |
| Stability | 0.x: a breaking change bumps the minor version, a patch never breaks. See the [stability policy](../../README.md#stability). |
| Planned | A shared fake Horizon for application tests, in the tranche 3 integration kit. |

## What is inside

| Module | Contents |
|---|---|
| Horizon gateway | `HorizonGateway`: its network passphrase, the latest ingested ledger, payments for an account, transaction by hash and account (each with the answering instance's ingested ledger), submit. `createHorizonGateway({ horizonUrl, networkPassphrase })` reads with `fetch` (pass `fetch` to replace it) and submits through `@stellar/stellar-sdk` (pass `server` for any object with a `submitTransaction` like the SDK's `Horizon.Server`). Every read times out after `requestTimeoutMs` (default 10 s), takes an `AbortSignal`, and reads its body as a stream capped at `maxResponseBytes` (below). Tests pass a fake. |
| Read layer | `createReadLayer({ gateway, cursorStore, onEvent, onMalformed? })`: `pollAccount` resumes from the stored cursor; `reconcile` re-reads a window without moving it. |
| Payments | `ChainPayment`: payments, path payments and account creation, with core assets and canonical 7-decimal amounts. |
| Matching | `matchPaymentToLeg` by destination, asset and issuer, exact amount, and source, hash or reference when known. `{ requireSource: true }` refuses legs without a source. `partnerAndChainAgree` for the funded check. |
| Accounts | `assessReceiveReadiness`: account exists, trustline for the asset and issuer, optional XLM reserve (1 XLM plus 0.5 per trustline). |
| Submit | `submitSignedTransaction`: hashes computed locally first (outer and inner for a fee bump), hashes checked before any retry, expiry proven by the source account's sequence number as of a ledger past maxTime, typed result codes, a fixed time budget. `inspectSignedTransaction` gives the hashes, maxTime, source account and sequence number of an envelope. `createStellarSubmitter` adapts it to core's `StellarSubmitter` and reports `maxDurationMs`. |
| Payout check | `assertPayoutXdrMatches(unsignedXdr, context, { networkPassphrase, maxFeeStroops?, now? })`: a key-free check, for signers, that the partner's unsigned transaction is exactly the expected payment. |

## Horizon gateway: what it refuses

- **URL.** `horizonUrl` must be https (or http with `allowHttp`, for a local Horizon) and carry no credentials, query or fragment. The raw string may not contain `?` or `#` at all: `https://h/?` parses to an empty query, and the paths the gateway appends would land after it.
- **Body size.** Each GET reads its response body as a stream and gives up once it grows past `maxResponseBytes` (default 1 MiB, `DEFAULT_HORIZON_MAX_RESPONSE_BYTES`), or at once when `Content-Length` says it will. A body over the cap is an error, never "not found". A custom `fetch` must return the body as a `ReadableStream` (the standard `Response.body`). The cap covers the reads; the submission's answer goes through the SDK server.
- **Accounts.** `account()` checks Horizon's answer before returning it: the `id` is the account asked for, the `sequence` a decimal string, the counts whole numbers, and each balance line well formed (decimal amounts, code and issuer for issued assets). Anything else throws. Only known fields are copied, plus `latestLedger` from the `Latest-Ledger` header.
- **Redirects** are refused, and a non-2xx status other than 404 throws with the status only, never the body.

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

A record the layer cannot read (for example an amount that is not a valid decimal, no string `id` or `transaction_hash`, or a `paging_token` that is not decimal digits, such as an empty one) never blocks the cursor. It goes to `onMalformed(record, error)` and the poll moves on; by default that logs a warning with the operation id and transaction hash only. Throw from `onMalformed` to stop instead, with the cursor left before that record. Positions past skipped records are stored once per page, not once per record.

The cursor only ever moves to a record's own position: its paging token when that is decimal digits, or else, for a malformed record, its operation id when that is (Horizon uses the same number for both). So a page made only of malformed records still moves the cursor past them, and a record with neither never clears the cursor or sends the next page back to the start. A full page that does not move the position at all cannot be passed: `pollAccount` and `reconcile` then throw instead of reading the same page again with `hasMore` set.

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
| `rejected`, reason `refused` | Refused by Horizon, and not found on the ledger (not looked up with `maxWaitMs: 0`); may still land until maxTime | No |
| `rejected`, reason `hash_mismatch` | Horizon accepted it but answered with another hash. Never a success: the payment may have moved | No: settle it by hand |
| `unknown` | Not found and not proven unable to land: it may still land, it may have landed on history this Horizon no longer keeps, or a read failed. With reason `unexpected_lookup_hash`, a lookup returned a transaction that is not ours | No: check again later, or settle it by hand |
| `expired_not_landed` | Proven never to land: an ingested ledger closed after maxTime, the source account's sequence number is unused as of that ledger, and no lookup found it (below) | Yes |

Only `failed` and `expired_not_landed` allow a replacement (core's `canSignReplacement`).

**Expiry is proven by the source account's sequence number, never by the local clock or a missing record.** `expired_not_landed` needs every one of these, and anything missing or doubtful gives `unknown`:

1. the transaction has a maxTime (greater than 0);
2. the latest ledger Horizon had ingested closed strictly after that maxTime (the checked ledger), so no later ledger can include the transaction;
3. a read of the source account (for a fee bump, the inner transaction's source, never the fee source) answered with a `Latest-Ledger` response header at least the checked ledger, and shows an account sequence number lower than the transaction's (compared as integers, not JavaScript numbers);
4. the lookup by every hash succeeded and found nothing.

A transaction that lands, successful or failed, uses its sequence number, and the account's sequence never drops back below it (an account can only be merged while its sequence is below the current ledger's starting sequence, and a re-created account starts at that ledger's). So an unused sequence after the checked ledger means the transaction never landed and never will. This holds when you run the same envelope again later and on a Horizon instance that no longer keeps old history: there a used sequence with no record found gives `unknown`, never `expired_not_landed`. A missing account, a failed or timed-out read or lookup, or an account read without the header never counts. The local clock only bounds how long to wait.

The default gateway reads the root resource for (2) and the account resource with its header for (3). A custom gateway that leaves `latestLedger` out of `account()` never proves expiry. The result carries the evidence: `checkedLedger`, `transactionSequence` and `sourceAccount` (`id`, `sequence`, `latestLedger`). Nothing is read before the first submission.

**`maxWaitMs: 0` means no hash lookup.** The submission's own answer is the result: an accepted envelope is `success` or `failed`, a refusal is `rejected` (without checking whether the transaction had already landed), and no answer is `unknown`. Nothing is read, so the result is never `expired_not_landed`.

**A lookup must return our transaction.** A record is accepted only when its hash is the hash looked up, our envelope hash or our inner hash, or its inner transaction's hash is our inner (or plain) hash. Anything else ends the run as `unknown` with reason `unexpected_lookup_hash` and the returned hashes, never as a success.

**A landed failure keeps its own codes.** When the transaction is found in a ledger as failed, `error` holds that transaction's own result codes (read from its result), never the refusal a resubmission got (for example `tx_bad_seq`, which a resubmission of a landed transaction always gets).

**Time budget.** One run takes at most `timeoutMs + maxWaitMs` (defaults 30 s + 2 min). The first submission always gets its full `timeoutMs`. Every Horizon read is aborted at `requestTimeoutMs` (default 10 s) or at the deadline, whichever comes first, and a timed-out lookup is an error, never "not found". The deadline is fixed once from the clock; a later clock reading that is not finite ends the run with `unknown`, and the number of polls is capped at `maxWaitMs / pollIntervalMs` plus one, so a broken or stuck clock cannot keep it looping.

**Fee bumps.** Anyone can wrap a signed transaction in a fee bump of their own. For a fee bump both the outer hash and the inner transaction hash are looked up; either found means landed. The result says which (`foundBy`), carries `innerHash`, and `submittedHash` when what landed is another envelope.

Resubmitting the same signed envelope is always safe: Stellar applies a transaction once. This package does not build transactions: the partner does, and your signer refuses one without a maxTime (`assertPayoutXdrMatches` below). Without a maxTime a lost transaction would stay `unknown` forever.

### With the core payout flow

```ts
// gateway: one Horizon instance you operate or trust, never a public load-balanced URL.
const submitter = createStellarSubmitter({ gateway, networkPassphrase });
submitter.maxDurationMs; // timeoutMs + maxWaitMs: 150 000 with the defaults

await runSignedPayout({
  ...payout,                 // adapter, context, funded, now, idempotencyKey
  signing: {
    signer, destination, submitter, submission: 'client_submits',
    onAuthorized,            // compare-and-set: payout_quoted -> awaiting_signature
    onSubmitted,             // stores awaiting_signature -> payout_submitted before the partner is told
  },
});
```

Only `{ status: 'success' }` goes on to `onSubmitted` and then the partner's create. Each outcome keeps the status and hash; every other field of the result is in `detail` (for a mismatch, `detail.reason` is `'hash_mismatch'`). `maxDurationMs` is the longest one `submit` can take: core refuses to sign unless the quote has more than `expiryMarginMs + maxDurationMs` left.

## Check the payout transaction before signing

The partner builds the transaction, so a signer that signs whatever it is handed signs whatever the partner asks. `assertPayoutXdrMatches` holds no key; call it in your signer, or before handing the XDR to a custodian, and sign only if it returns:

```ts
import { assertPayoutXdrMatches } from '@vindu/grid-stellar';

async signStellar(account, unsignedXdr, context) {
  assertSigningAllowed(context);   // core: state, quote expiry, clock
  assertPayoutXdrMatches(unsignedXdr, context, { networkPassphrase, maxFeeStroops: 1_000_000, now });
  return sign(unsignedXdr);        // under the same networkPassphrase
}
```

It throws `PayoutXdrMismatchError` (code `payout_xdr_mismatch`, with `check` naming the failed check) unless all of these hold:

- the XDR decodes for `networkPassphrase` as a plain transaction, not a fee bump;
- exactly one operation, a `payment`;
- the transaction source is `context.expected.source`;
- the operation has no source, or the same account, including a muxed `M...` form of it;
- the destination is `expected.destination`;
- the asset code and issuer, and the exact amount, are `expected.amount`;
- the total fee is at most `maxFeeStroops` (default 1 000 000 stroops);
- a `maxTime` greater than 0 and no later than the quote expiry (core's `assertMaxTimeWithinQuote`);
- a `minTime` of zero (or none), or no later than now (check `min_time`): a transaction that cannot land yet would hold the payout back while the quote runs out. `now` defaults to `Date.now` and is read only when there is a `minTime`; a clock that is not a finite number throws `InvalidConfigError`;
- none of the newer preconditions: minimum account sequence, its age or ledger gap, extra signers, ledger bounds (unset or zero only).

**The network cannot be checked from an unsigned envelope.** An envelope does not name its network: the same bytes decode under any passphrase, so a transaction built for another network passes these checks. What binds it to one network is the signature: the signer signs the hash computed for the passphrase it signs under, and that signature is valid on that network only. Sign under the same `networkPassphrase` you pass here.

## Testing

`yarn workspace @vindu/grid-stellar test`. Tests use an in-memory gateway and real envelopes signed with throwaway testnet keys; nothing touches the network. Type checking and tests resolve `@vindu/grid-core` to its sources, so no build is needed first.
