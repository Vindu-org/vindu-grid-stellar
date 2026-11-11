# live-stellar

Runs `@vindu/grid-stellar` (and the parts of `@vindu/grid-core` it uses) against the **real public Stellar testnet**, not the in-memory fakes. It funds throwaway accounts with friendbot, issues a throwaway test asset, and checks the read layer, matching, submission, fee bumps, the expiry proof and `assertPayoutXdrMatches` on live transactions.

```sh
corepack enable
yarn install
yarn workspace live-stellar start
```

It prints each step, one `PASS` or `FAIL` line per scenario and a summary, and exits 0 only when every scenario passed (1 when any failed, 2 when it refused to start). A run takes about two minutes.

## Safety

- **Testnet only.** It talks to `https://horizon-testnet.stellar.org` and `https://friendbot.stellar.org` with the testnet passphrase, and refuses any other value (`--horizon-url=` and `--network-passphrase=` exist only to show the refusal). Once online it also requires Horizon's root to name the testnet passphrase.
- **Throwaway keys.** Every key is made with `Keypair.random()` for the run and stays in memory. Nothing is written to disk; the output shows statuses, transaction hashes and shortened public addresses only.
- **No configuration.** It reads no environment variables and no files.
- **Never in CI.** `start` is not called by any workflow. `yarn workspace live-stellar test` (part of `yarn test`) runs offline unit tests of the guard and the retry helpers only.
- **Bounded retries.** Friendbot errors, rate limits and a Horizon instance a ledger behind are retried a fixed number of times, in this example only. The packages never retry on their own.

## Setup

Friendbot funds one account, which creates an issuer, a sender, a receiver and a fee payer. The issuer issues `LIVE` (a new issuer every run) to the sender; the sender and the receiver open trustlines, and `checkReceiveReadiness` must accept the receiver.

The public testnet Horizon is load-balanced. The run therefore only believes an account read whose `Latest-Ledger` header includes every ledger the run has landed a transaction in, and waits for reads that are a ledger behind.

## Scenarios

| # | What it checks |
|---|---|
| 1 | Two payments reach the receiver. `createReadLayer` delivers each exactly once, including from a new instance that resumes from the saved cursor (a store that outlives each instance, standing in for a database). Further polls deliver nothing, `reconcile` leaves the cursor alone, and `matchPaymentToLeg` links each payment to its leg (destination, source, asset and issuer, amount, memo) and refuses a lookalike asset with the same code from another issuer. `partnerAndChainAgree` agrees on the exact amount. |
| 2 | `createStellarSubmitter` submits a signed envelope, then the same envelope again: both answers are `success` under the same hash, the sender's sequence number is used once and the receiver is paid once. An underfunded payment lands as `failed` with its own codes (`tx_failed`, `op_underfunded`), also when submitted again, and moves nothing. |
| 3 | A fee bump lands and Horizon finds it by its outer hash and by its inner hash, both reporting the fee bump's hash. Resubmitting the fee bump, the bare inner envelope, and another fee bump around the same inner transaction all report the landing, and the receiver is paid once. The payment record carries the fee bump's hash and matches a leg that holds the reported hash. |
| 4 | An envelope with a `maxTime` five seconds ahead is signed and never sent (the gateway loses every submission). Once a ledger closed after its `maxTime`, `submitSignedTransaction` returns `expired_not_landed` with the checked ledger and the source account's unused sequence number. A late real submission is refused by the network and also proven expired. The converse: an envelope that landed is `success` before and after its `maxTime` (by lookup and by a real resubmit), and `unknown`, never expired, on a Horizon that lost its history. Once another transaction used the never-sent envelope's sequence number, it is `unknown` too. |
| 5 | `assertPayoutXdrMatches` accepts a single-payment transaction built from the sender's live sequence number, and refuses nine tampered variants, each on the expected check: another destination, another amount, the same code from another issuer, a fee over the cap, no `maxTime`, a `maxTime` after the quote, an extra operation, an operation source of its own, and a fee bump. The accepted transaction is then signed and lands. |

## What the real network showed

Differences from the fakes, and what was done:

- **A fee bump looked up by its inner hash.** Horizon answers `GET /transactions/<inner hash>` with the inner hash as the record's `hash` and names the envelope on the ledger in `fee_bump_transaction.hash`; the operations and payments carry the fee bump's hash. The fakes answered with the fee bump's hash. Fixed in the gateway, which now reports `fee_bump_transaction.hash`, with regression tests that replay the testnet record. Before the fix, a payout that landed inside someone else's fee bump was reported under the inner hash, and a leg holding that hash did not match the payment.
- **Resubmitting a landed envelope.** Horizon answers `200` with the landed result instead of refusing it with `tx_bad_seq` as the demo's fake Horizon does. The submitter reports `success` either way; no change.
- **The bare inner envelope of a landed fee bump.** Horizon answers `200` under the inner hash, while the payment record carries the fee bump's hash. The result is `success` (correct), but a leg matched by that hash does not match: match such a payment by destination, asset and amount. Not changed: reporting the fee bump's hash here would need a new field on the submit answer.
- **A second fee bump around a landed inner transaction.** Horizon refuses it with `tx_fee_bump_inner_failed` and `inner_transaction: tx_bad_seq`. The gateway keeps only the outer code, so on its own the refusal maps to the code `failed` rather than `bad_seq`. The submitter then finds the landing by the inner hash and reports `success`, so nothing is wrong in the outcome. Not changed: carrying the inner code would need a new field on `SubmitError`.
- **`Latest-Ledger`.** The public testnet Horizon sends the header on account reads, not on transaction lookups (found or not) nor on the root resource. The fakes report it on lookups too. The expiry proof only uses the account read's header, so nothing depends on it; no change.

## Files

| File | Contents |
|---|---|
| `src/main.ts` | The entry point: the guard, the setup, the five scenarios and the summary. |
| `src/network.ts` | The testnet-only guard. |
| `src/testnet.ts` | The real gateway, friendbot funding, local sequence numbers, and helpers to build, sign and land transactions. |
| `src/world.ts` | The accounts and the test asset of one run. |
| `src/scenarios/` | One file per scenario. |
| `src/retry.ts` | Bounded retries and waits for testnet flakiness. |
| `src/report.ts`, `src/check.ts` | The PASS and FAIL output, and the checks. |
