# @vindu/grid-blindpay

Typed [BlindPay](https://blindpay.com) client for two-leg transfers settled on Stellar, and its `@vindu/grid-core` `PartnerAdapter`. PIX in, USDC on Stellar in between, bank payout out.

> Status: early, not published. Every API here will change before the first release.

## What it covers

Stellar only (`stellar`, `stellar_testnet`; tokens `USDC`, `USDB`). Other networks are out of scope.

| Module | Contents |
|---|---|
| Client | `createBlindPayClient(config)`: Bearer auth, JSON, per-request timeout, typed `BlindPayHttpError`. |
| Customers | Create (individual, business), get, remaining limits. |
| Blockchain wallets | Register a Stellar account (`is_account_abstraction: true`, `is_self_custody` required), list, get, answer self-custody once. |
| Pay-ins | PIX payin quote with `pix_allowed_tax_ids`, payin on `/payins/evm` (BlindPay's path for every network), get. |
| Payouts | Payout quote on `/quotes`, Stellar `authorize` (unsigned XDR) and `create`. |
| Partner fees | Create, list, get, delete. |
| Payout flow | `runStellarPayout`: authorize, check expiry and state, sign once, optionally submit, create. |
| Webhooks | `verifyWebhook` (Svix, raw bytes, timestamp window both ways) and `parseWebhookEvent`. |
| Adapter | `createBlindPayAdapter(config, options)` implements the core port. `BLINDPAY_CAPABILITIES` for routing. |
| Amounts | `toBlindPayAmount` / `fromBlindPayAmount`: exact conversion to 2-decimal minor units. |

## Bring your own keys

```ts
import { createBlindPayAdapter } from '@vindu/grid-blindpay';

const blindpay = createBlindPayAdapter(
  { apiKey, instanceId: 'in_...', onCall: (call) => metrics.record(call) },
  { network: 'stellar_testnet', webhookSecret: 'whsec_...' },
);
```

The library never reads environment variables. The API key goes only into the `Authorization` header: it is never logged, never in an error, never in an `onCall` report. Reports carry the method, a templated path (`/v1/instances/{in_id}/payins/{pi_id}`), the status, the duration and the ids from the path, never a body.

## Idempotency and retries

Every POST and DELETE sends an `Idempotency-Key`. Pass your own and store it; when you do not, one is generated and returned on the result and on the error. BlindPay keeps keys for 24 hours: same key and body replays the result, a different body is `422 idempotency_key_payload_mismatch`, a running original is `409 idempotency_key_in_flight` (marked `retryable`, with `retryAfterMs`). The client never retries on its own.

After a signed payout may be on Stellar, failures throw `StellarPayoutIncompleteError` with the signed XDR, the hash and the exact create body and key. Retry with `retryStellarPayoutCreate`: it never signs or submits again. An expired quote throws `QuoteExpiredError`: get a fresh quote and authorize again.

## Amounts

BlindPay sends every amount as an integer with 2 decimals, stablecoin included: 100 USDC is `10000`. Conversion throws on sub-cent precision instead of rounding.

## Development instances

Customers are approved automatically (legal name `Fail` forces a rejection), payins complete in about 30 seconds with `USDB`, and `pix_code` is the literal `<development>`. The outcome follows the `request_amount`: `66600` ends `failed`, `77700` ends `refunded`, anything else `completed` (`DEV_SENTINEL_AMOUNTS`).

## Unconfirmed

The public docs leave these open. Each one lives in one place so a different answer is a small change.

- **`signed_transaction` content**: signed XDR or Stellar hash. Option `signedTransactionField` (`signed_xdr` default, `tx_hash`).
- **Who submits to Stellar**: option `submission` (`client_submits` default, `partner_submits`).
- **Reading one payout**: `GET /payouts/{po_id}` assumed, in `UNCONFIRMED_GET_PAYOUT_PATH` only.
- **Error body format**: the code is read best-effort from `code`, `error` or `message`; the message is kept as a capped snippet.
- **Fee currency on quotes**: not stated, so `LegQuote.fees` is left empty rather than guessed.
- **Webhook firing rules** conflict between pages: the adapter reads the `status` field, never the event name.

## License

Apache-2.0
