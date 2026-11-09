# @vindu/grid-blindpay

Typed [BlindPay](https://blindpay.com) client for two-leg transfers settled on Stellar, and its `@vindu/grid-core` `PartnerAdapter`. PIX in, USDC on Stellar in between, bank payout out.

## Status

| Aspect | Status |
|---|---|
| Version | 0.1.0, git tag only: not on npm. Install from the tag `v0.1.0` as the [root README](../../README.md#install-from-a-git-tag) shows. |
| Node | 22 or later. |
| Format | CommonJS with type declarations. One entry point: import from `@vindu/grid-blindpay` only; files under `dist/` are internal. |
| Stability | Early. Every API here may change before the first release. |
| Planned | BlindPay's answers to the points under [Unconfirmed](#unconfirmed). Passing the shared adapter conformance suite once it exists (tranche 3). |

## What it covers

Stellar only (`stellar`, `stellar_testnet`; tokens `USDC`, and `USDB` on testnet only). Other networks are out of scope.

| Module | Contents |
|---|---|
| Client | `createBlindPayClient(config)`: Bearer auth, JSON, per-request timeout, no redirects, typed `BlindPayHttpError`. |
| Customers | Create (individual, business), get, remaining limits. |
| Blockchain wallets | Register a Stellar account (`is_account_abstraction: true`, `is_self_custody` required), list, get, answer self-custody once. |
| Pay-ins | PIX payin quote with `pix_allowed_tax_ids`, payin on `/payins/evm` (BlindPay's path for every network), get. |
| Payouts | Payout quote on `/quotes`, Stellar `authorize` (unsigned XDR) and `create`. |
| Partner fees | Create (with your own idempotency key), list, get, delete. |
| Payout flow | `runStellarPayout`: core's `runSignedPayout` with this adapter. From `payout_quoted`, authorize, let you store `awaiting_signature`, check expiry and state, sign once, submit, create only after a confirmed success. |
| Webhooks | `verifyWebhook` (Svix, raw bytes, timestamp window both ways, fails closed) and `parseWebhookEvent`. |
| Adapter | `createBlindPayAdapter(config, options)` implements the core port. `BLINDPAY_CAPABILITIES` for routing. |
| Amounts | `toBlindPayAmount` / `fromBlindPayAmount`: exact conversion to 2-decimal minor units. `floorToBlindPayAmount` for paying out a funded balance. |

## Bring your own keys

```ts
import { BLINDPAY_CAPABILITIES, createBlindPayAdapter } from '@vindu/grid-blindpay';

const blindpay = createBlindPayAdapter(
  { apiKey, instanceId: 'in_...', onCall: (call) => metrics.record(call) },
  {
    network: 'stellar',
    assetIssuers: { USDC: usdcIssuer },  // G...: the USDC issuer you accept
    webhookSecret: 'whsec_...',
    partnerId: 'blindpay',               // default
  },
);
const registry = { [blindpay.id]: BLINDPAY_CAPABILITIES };
```

The library never reads environment variables. The API key goes only into the `Authorization` header: it is never logged, never in an error, never in an `onCall` report. Reports carry the method, a templated path (`/v1/instances/{in_id}/payins/{pi_id}`), the status, the duration and the ids from the path, never a body.

`partnerId` is the adapter's id: it is `adapter.id`, `LegQuote.partner`, the `partner` of every leg ref and event, and the partner in errors and reports. `BLINDPAY_CAPABILITIES` is not keyed by id: register it under the same id, as above.

## Stablecoins: code and issuer

A Stellar asset is its code plus its issuer. The adapter takes each token's issuer in `assetIssuers` and refuses, before any call:

- `USDB` on `stellar` (mainnet): it is BlindPay's development token;
- `USDC` (or `USDB`) whose issuer is not the configured one, or has none;
- a token with no issuer configured (`InvalidConfigError`).

## HTTP

- `baseUrl` must be `https`. Plain `http` is allowed only for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`), for a local mock.
- Redirects are never followed (`redirect: 'error'`): a followed redirect would send the body again to another URL. A 3xx from a custom fetch is an error too.
- Errors keep the status, BlindPay's error code (only when it is code-shaped, like `idempotency_key_in_flight`), the idempotency key, the `retryable` flag and `retryAfterMs`. They keep no free text: no response body and no raw `cause`, because BlindPay may echo client data and a fetch error message can quote headers or the body. A network failure keeps only its system code in `causeCode` (e.g. `ECONNREFUSED`).
- `includeErrorBodies: true` (debug only) adds a capped excerpt of BlindPay's error response in `bodySnippet`. It can hold client data such as names, tax ids or bank details: never turn it on where errors reach logs or error trackers.

## Idempotency and retries

Every POST and DELETE sends an `Idempotency-Key`. Pass your own and store it; when you do not, one is generated and returned on the result and on the error. BlindPay keeps keys for 24 hours: same key and body replays the result, a different body is `422 idempotency_key_payload_mismatch`, a running original is `409 idempotency_key_in_flight` (marked `retryable`, with `retryAfterMs`). A 2xx whose body is not JSON is `invalid_json`, also `retryable`: the call may have taken effect, so repeat it with the same key and body and BlindPay replays the original. The client never retries on its own.

## Payout flow

```ts
import { runStellarPayout, retryStellarPayoutCreate } from '@vindu/grid-blindpay';
import { PayoutIncompleteError } from '@vindu/grid-core';
import { createStellarSubmitter } from '@vindu/grid-stellar';

const result = await runStellarPayout({
  adapter: blindpay,
  signer,                                // your key holder; checks the XDR
  submitter: createStellarSubmitter(...), // core's StellarSubmitter
  context: { transferId, state: 'payout_quoted', quote, account, destination: blindpayAccount },
  idempotencyKey,                         // stored before the call, reused on retries
  onAuthorized: async () => (await moveTransfer('awaiting_signature', 'signed_payout_flow')).state,
  onSigned: (xdr) => store(xdr),
});
```

It is core's `runSignedPayout`, so core's rules, and its table of which transition each error takes, apply:

- The transfer moves to `awaiting_signature` only in `onAuthorized`, after BlindPay's `authorize` answered with the XDR. A failed `authorize`, or an answer without the XDR, throws `PayoutAuthorizationError` while the transfer is still in `payout_quoted` (take `payout_quoted -> needs_attention`).
- The signer is called once, after `onAuthorized` returned `awaiting_signature`. A quote with a minute or less left (`expiryMarginMs`, core's `DEFAULT_EXPIRY_MARGIN_MS`) throws `QuoteExpiredError`: with `stage: 'authorization'` before authorizing (take `payout_quoted -> funded`), with `stage: 'signing'` before signing or submitting (take `awaiting_signature -> funded`). Get a fresh quote and authorize again.
- Only `{ status: 'success' }` from the submitter, with a valid hash, creates the payout. `rejected`, `unknown`, `expired_not_landed`, `failed`, a malformed outcome or a throw stop with `PayoutIncompleteError` (`stage: 'submit'`) carrying the outcome, and BlindPay is never told. Check the transaction on Stellar before anything else; never sign a replacement unless `canSignReplacement(outcome)` is true.
- A failed create throws `PayoutIncompleteError` (`stage: 'create'`) with `pending`: the exact input and key. Retry with `retryStellarPayoutCreate(adapter, pending)` (core's `retryPayoutExecute`); with the same adapter options, BlindPay receives the same body and key. It never signs or submits again.
- A clock or margin that is not a finite number throws.
- `partner_submits` with an adapter set to `signedTransactionField: 'tx_hash'` is refused before any call: without a submit there is no hash. A quote from another partner id, or a non-Stellar account, is refused too.

## Amounts

BlindPay sends every amount as an integer with 2 decimals, stablecoin included: 100 USDC is `10000`. Conversion throws on sub-cent precision instead of rounding.

The one exception is the payout quote. A funded balance can carry Stellar's 7 decimals, so `quotePayout` rounds the amount **down** to the cent (`floorToBlindPayAmount`): `99.9876543` USDC is quoted as `99.98`, and the `0.0076543` rest stays in the account. The quote's `source` is what the transaction moves. Funding amounts still throw on sub-cent precision.

## Leg status and events

`readLeg` and `parseWebhook` report:

- `status` from BlindPay's `status` field, never from the event name (the docs disagree on which event fires for which outcome). Anything unexpected is `unknown`.
- `amount`: the stablecoin the leg moved on Stellar, as core's port defines it. Funding: `receiver_amount`, the stablecoin delivered to the account. Payout: `sender_amount`, the stablecoin taken from it. It is left out, never guessed, unless the token is known (BlindPay's `token` field, or USDC on `stellar`, the only token there) and its issuer is in `assetIssuers`, and the amount is a whole number of cents. The fiat side (a payout's `receiver_amount`, the fiat delivered) is on the raw resource: `adapter.client.stellarPayouts.getPayout(id)` or the parsed webhook.
- `occurredAt` (events) and `updatedAt` (reads): the resource's own change time, from `updated_at`, or for a completed leg `tracking_complete.completed_at`. Left out when BlindPay sends neither.
- `deliveredAt` (events): the Svix timestamp. It is the delivery time; retries change it, so never order events by it.

## Webhooks

`verifyWebhook` checks the Svix signature over the exact raw bytes (strict base64, any of several `v1` signatures) and the timestamp window both ways. It fails closed on a broken setup: a `toleranceSec` that is not a finite number above zero throws `InvalidConfigError`, a clock reading that is not finite throws `InvalidInputError`, and a secret shorter than 16 bytes is refused. The adapter checks `webhookToleranceSec` when it is built.

## Development instances

Customers are approved automatically (legal name `Fail` forces a rejection), payins complete in about 30 seconds with `USDB`, and `pix_code` is the literal `<development>`. The outcome follows the `request_amount`: `66600` ends `failed`, `77700` ends `refunded`, anything else `completed`. `DEV_SENTINEL_AMOUNTS` holds these values as a test aid; production ignores them.

## Unconfirmed

The public docs leave these open. Each one lives in one place so a different answer is a small change.

- **`signed_transaction` content**: signed XDR or Stellar hash. Adapter option `signedTransactionField` (`signed_xdr` default, `tx_hash`).
- **Who submits to Stellar**: `runStellarPayout` option `submission` (`client_submits` default, `partner_submits`).
- **Reading one payout**: `GET /payouts/{po_id}` assumed, in one constant in `stellar-payouts.ts`.
- **Error body format**: the code is read best-effort from `code`, `error` or `message`, and kept only when it is code-shaped.
- **Leg fields**: `token`, `updated_at` and a payout's `sender_amount` are used when present, never required.
- **Fee currency on quotes**: not stated, so `LegQuote.fees` is left empty rather than guessed.
- **Webhook firing rules** conflict between pages: the adapter reads the `status` field, never the event name.

## License

Apache-2.0
