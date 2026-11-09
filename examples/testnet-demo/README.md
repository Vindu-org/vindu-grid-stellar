# testnet-demo

A full two-leg transfer, from BRL by PIX to USDC on Stellar to USD by wire, run offline. It uses the real code paths from `@vindu/grid-core`, `@vindu/grid-stellar` and `@vindu/grid-blindpay`. Only the outside world is simulated: the partners, the Horizon server and the keys.

It needs no network, no credentials and no environment variables. Every key is a throwaway made with `Keypair.random()` for the run.

## Run it

```sh
corepack enable
yarn install
yarn workspace testnet-demo start
```

The demo runs from the package sources with `tsx`, so it needs no `yarn build` first. It prints one line per transfer state change and exits 0 when the transfer reaches `completed`.

Add `--blindpay-dry-run` to also run the flow through the BlindPay client against a mocked `fetch`. It prints each request BlindPay would receive (method, path and body, never headers):

```sh
yarn workspace testnet-demo start --blindpay-dry-run
```

`yarn workspace testnet-demo test` runs the same demo as a Jest smoke test.

## What it shows

| Step | What runs |
|---|---|
| Account check | `checkReceiveReadiness`: the client's account has a USDC trustline and enough XLM for its reserve. |
| Routing | `selectRoute` over two mock partners. `mock-partner` settles on Stellar with external accounts; `mock-offchain` has no Stellar and a slightly better price. The Stellar route wins with reason `stellar_priority`, and the price gap is printed. |
| States | The transfer moves `quoted -> awaiting_pix -> funding -> funded -> payout_quoted -> awaiting_signature -> payout_submitted -> payout_processing -> completed`, each step through core's `transition`. |
| Funding | The mock partner returns a fake PIX code, then sends USDC from its treasury on the in-memory ledger. The read layer (`createReadLayer` with `InMemoryCursorStore`) sees the payment, `matchPaymentToLeg` matches it, and `partnerAndChainAgree` confirms the partner's figure and the chain agree before `funded`. |
| Tolerance | `checkPayoutTolerance` compares the fresh payout quote with the estimate the client saw before `payout_quoted`. |
| Signing | The mock partner returns a real unsigned testnet transaction. The test-key signer (`custody: 'test_key'`) calls `assertSigningAllowed`, decodes the XDR and refuses anything but exactly one payment operation. It checks the source (and the operation's own source, when set), the destination, the asset and issuer, the exact amount, a fee cap (default 1 000 000 stroops) and, with `assertMaxTimeWithinQuote`, the maxTime. The demo shows it refusing twice: once when asked too early, in `payout_quoted`, and once, after the move to `awaiting_signature`, for a transaction that pays another account. |
| Payout flow | Core's `runSignedPayout` with grid-stellar's `createStellarSubmitter`, from `payout_quoted`: the partner authorizes, `onAuthorized` moves the transfer to `awaiting_signature`, then sign once, submit, and create the partner payout only after a `success` outcome. Horizon is set to time out once after the transaction lands, so the submitter checks the hash, finds it and returns `success` without a second signature. |
| Reconciliation | The partner gets the signed transaction and its hash. The read layer resumes from its cursor and matches the outgoing payment on source, hash and memo. |
| Failure edges | Where the flow can stop, the transfer takes the failure edge from core's table: a failed payout quote (`funded -> needs_attention`), a quote too close to expiry before the partner authorizes (`payout_quoted -> funded`), a partner that refuses to authorize (`payout_quoted -> needs_attention`), a quote too close to expiry after that, before the transaction leaves (`awaiting_signature -> funded`), a submit outcome other than `success` (`awaiting_signature -> needs_attention`), a payout the partner does not take (`payout_submitted -> needs_attention`). Nothing is re-signed, refunded or rerouted automatically. The tests run the refused-authorization and refused-submission cases. |

## Files

| File | Contents |
|---|---|
| `src/demo.ts` | `runDemo`: setup, routing, then the two legs. |
| `src/funding-leg.ts`, `src/payout-leg.ts` | The two legs, step by step. |
| `src/mock-partner.ts` | `MockPartner`, a core `PartnerAdapter`, and both partners' capabilities as data. |
| `src/test-key-signer.ts` | `TestKeySigner`, a core `Signer` with a throwaway key. Read it as a reference for a signer: `assertSigningAllowed`, the key check, then `assertPayoutXdrMatches`. `test/test-key-signer.test.ts` covers each refusal. |
| `src/transfer.ts` | `Transfer`, the stored transfer: every move goes through core's `transition`; `compareAndMove` is the compare-and-set the payout hooks use. |
| `src/fake-horizon.ts` | `FakeHorizon`, an in-memory `HorizonGateway` that checks signatures, sequence numbers and time bounds, and reports its ingested and elder ledgers. |
| `src/chain-watch.ts` | The read layer over the client's account, and leg matching. |
| `src/blindpay-dry-run.ts` | The `--blindpay-dry-run` flow: `runStellarPayout` with the BlindPay adapter and `createStellarSubmitter`. |

## Pointing it at real testnet

This example stays offline on purpose. To run the same flow against real testnet, your application swaps the simulated pieces for real ones and passes every key and URL as an argument:

- **Partner:** `createBlindPayAdapter` with the API key and instance id of a BlindPay development instance, and `{ network: 'stellar_testnet' }`. Development instances settle `USDB` instead of `USDC`; see the `@vindu/grid-blindpay` README.
- **Horizon:** `createHorizonGateway({ horizonUrl, networkPassphrase: TESTNET_NETWORK_PASSPHRASE })` in place of `FakeHorizon`, where `horizonUrl` is one Horizon instance you run or trust, for example a testnet node of your own. Do not use the `STELLAR_TESTNET` preset for real submissions: its URL is the public testnet Horizon, which sits behind a load balancer. The ledger read and the hash lookups can then reach instances at different ledgers, so a landed payout can look missing. The submitter does not call such a payout expired without proof from the instance itself, so it answers `unknown`, and the transfer stops for a person instead of completing. The preset is fine for reading and exploring, not for the submit and lookup path.
- **Accounts:** a funded testnet account with a trustline for the instance's token, registered with BlindPay as the client's wallet.
- **Signer:** a `Signer` your application provides, holding the account's key. The test-key signer here is for demos only.

Your application reads its secrets and passes them in. Nothing in this repository reads environment variables or key files.
