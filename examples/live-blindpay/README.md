# live-blindpay

Runs `@vindu/grid-blindpay`, `@vindu/grid-stellar` and `@vindu/grid-core` against **your own BlindPay development instance** and the public Stellar testnet, and prints one line per check:

- `PASS`: the instance did what the library expects;
- `FAIL`: something the run needs did not happen (the run exits 1);
- `FINDING`: a fact about the real instance worth writing down, such as a difference from the docs.

What it found on 2026-11-11 is in [FINDINGS.md](FINDINGS.md).

It is never run in CI. `yarn test` runs only its offline unit tests, with `fetch` disabled.

## What it does

0. Reads the instance and stops unless its `type` is `development`, before any write.
1. Picks an approved customer, funds a throwaway testnet account with friendbot, adds the USDB trustline BlindPay builds (`create-asset-trustline`), authorizes it with a 1 USDB test mint (`mint-usdb-stellar`), and registers the account as the customer's `stellar_testnet` blockchain wallet.
2. Quotes and creates a 100.00 BRL PIX payin to that wallet through the adapter, waits for it to end, and checks the USDB delivery on testnet with the read layer, `matchPaymentToLeg` and `partnerAndChainAgree`.
3. Payins with the sentinel amounts 66600 and 77700, which the docs say end `failed` and `refunded`: a payin still `processing` when the wait ends is a FINDING (no Stellar payin completed on development), one that ended otherwise, or whose raw status readLeg disagrees with, is a FAIL. The same amounts as payouts must end `failed` and `refunded`.
4. Payouts through `runStellarPayout`, each on its own quote and signed once by a test-key signer that runs `assertPayoutXdrMatches` first: `partner_submits`, `client_submits` (submitted by grid-stellar first), a fee-bumped envelope, and an attempt to sign after the transaction's `maxTime`, which the signer must refuse (check `max_time`) so nothing reaches BlindPay. It checks the chain, `readLeg`, and the authorize transaction's fee, time bounds and destination. The receiver is a clearly fake ACH bank account; development instances skip the bank submission.
5. Webhooks: skipped, there is no public URL to deliver to.

Each run makes a new throwaway account and wallet and mints about 1500 test USDB. It sends about 100 BlindPay requests (most of them polling the payins) over about 8 minutes, paced under the development limit of 40 a minute.

## Run it

You need a BlindPay development instance with at least one approved customer, and an API key for it.

```sh
export BLINDPAY_API_KEY=...        # never commit it
export BLINDPAY_INSTANCE_ID=in_...
yarn workspace live-blindpay start
```

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `BLINDPAY_BASE_URL` | `https://api.blindpay.com` | Another API host, such as a local mock. |
| `BLINDPAY_PAYOUT_DESTINATION` | the USDB issuer (development only) | The Stellar account payouts must pay, as BlindPay gave it to you. Without it the run uses the USDB issuer named in BlindPay's trustline XDR, which every development payout paid, and says so; the destination check is then a FINDING, not a PASS, because the expected account came from BlindPay itself. Never take a payout account from a partner's answer in production. |
| `BLINDPAY_PAYIN_WAIT_SEC` | `300` | How long to wait for the payins to end. |

Everything printed (report lines, the client's logger and failed-call lines, and error descriptions, which never include an error's message) goes through the redactor in `src/redact.ts`. It removes the key and the instance id in any letter case, and the instance id without its `in_` too; ids that start a word with a BlindPay prefix (`in`, `re`, `bw`, `qu`, `pi`, `po`, `pf`, `ba`, `bl`, `to`, `va`, `tr`, `pa`, `wh`, either case, then `_` and 4 or more letters or digits, or `-` and 4 or more with a digit or capital), or with any other two- or three-letter lowercase prefix, `_` and 4 or more letters or digits with a digit or capital; emails, secret seeds and base64 blobs of 80 characters or more. Stellar accounts and 64-hex hashes are cut to their last four characters. Anything else it does not recognise is printed as is: an id with another shape, a name or a free-text message would get through, so read the output before you paste it anywhere.
