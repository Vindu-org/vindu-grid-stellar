# @vindu/grid-core

Types, transfer states, routing rules and the partner adapter interface for two-leg transfers settled on Stellar: fiat to USDC, then USDC to fiat.

Pure TypeScript. No network calls, no environment reads, no partner code. Partner clients such as `@vindu/grid-blindpay` implement the interfaces defined here.

## Status

| Aspect | Status |
|---|---|
| Version | 0.1.0, git tag only: not on npm. Install from the tag `v0.1.0` as the [root README](../../README.md#install-from-a-git-tag) shows. |
| Node | 22 or later. |
| Format | CommonJS with type declarations. One entry point: import from `@vindu/grid-core` only; files under `dist/` are internal. |
| Stability | 0.x: a breaking change bumps the minor version, a patch never breaks. See the [stability policy](../../README.md#stability). |
| Planned | The adapter conformance suite, in the tranche 3 integration kit. Corridor names such as `awaiting_pix` and `pixCode` stay while every partner uses PIX; renaming them later is a breaking change. |

## What is inside

| Module | Contents |
|---|---|
| Money | `Money = { amount: string; asset: Asset }`. Exact decimal arithmetic on bigint units of 10^-7, so `0.1 + 0.2` is exactly `0.3`. Minor-unit conversion that refuses to round. |
| Assets | `{ code, issuer? }`. Fiat has no issuer; a Stellar asset is its code plus issuer. |
| Transfer states | Twelve states, the transition table with a reason code and label per rule (failure edges included), `canTransition` and `transition(from, to, reason?)` (throws `InvalidTransitionError`). |
| Ports | `PartnerAdapter`: quote and create the funding leg, quote, prepare and execute the payout, read a leg (with the partner's amount), parse a webhook (async). `StellarSubmitter`: submit a signed transaction, report a typed outcome as plain data (`status`, `hash`, optional `detail`) and its longest submit time (`maxDurationMs`, required). |
| Signer | `Signer.signStellar(account, unsignedXdr, context)`. Keys never enter this library. `assertSigningAllowed` and `assertMaxTimeWithinQuote` cover the checks that need no Stellar SDK. |
| Instants | `parseInstantMs`: the one strict ISO-8601 parser. It needs an explicit `Z` or `+hh:mm` offset and refuses impossible dates, so a time without an offset is never read in the host's time zone. Quote expiries and Horizon ledger close times go through it. |
| Payout flow | `runSignedPayout`: from `payout_quoted`, check the quote against the funded amount, authorize, then either create the payout (no signature needed) or let you store `awaiting_signature`, sign once, submit, let you store `payout_submitted`, and create the partner payout only after that. Each error names the transition to take. `retryPayoutExecute` repeats a failed create unchanged. |
| Capabilities | Chains, account model per chain and rails per currency. The registry is data your application passes in. |
| Routing | `selectRoute`: Stellar route first, best price otherwise. `assertRouteImmutable` keeps the route fixed after the funding leg exists. |
| Tolerance | `checkPayoutTolerance`: a payout quote outside the tolerance moves the transfer to `needs_attention`. |
| Observability | `Logger`, `noopLogger`, and the `PartnerCall` shape for `onCall` hooks. |
| Errors | `GridError` with a stable `code`, and typed subclasses shared by every adapter: `InvalidConfigError`, `InvalidInputError`, `PartnerHttpError` (with the `idempotencyKey` sent), `WebhookRejectedError`, `QuoteExpiredError`, `PayoutAuthorizationError`, `SignerRefusedError`, `PayoutIncompleteError`, `PayoutInterruptedError` and more. `causeCodeOf` is the one rule for the cause codes errors keep. |

## Routing

Routing runs once, at quote time:

1. Keep partners where the client is approved and the corridor is supported.
2. Keep partners with a ready account for the client.
3. If a Stellar route remains, select it. `stellarPriceLimitBps` is only a safeguard against an abnormal quote: the Stellar route loses only when it costs more than the best alternative by more than that limit.
4. Without a Stellar route, pick the best price.

Prices are compared as cost, source paid per unit of target: a 100 bps gap means the Stellar route needs 1% more source for the same target, whether the partners quoted a fixed source or a fixed target. Only eligible candidates are checked for well-formed prices; the others are reported in `decision.excluded`.

```ts
import { selectRoute } from '@vindu/grid-core';

const decision = selectRoute(candidates, {
  registry,            // your partner capabilities
  corridor: { sourceCurrency: 'BRL', fundingRail: 'pix', targetCurrency: 'USD', payoutRail: 'wire' },
  stellarRoutingEnabled: true,
  stellarPriceLimitBps: 100,
});
// decision.route, decision.reason, decision.excluded
```

Store `decision.route` on the transfer. It never changes after the funding leg is created, because the client's money is already committed to that partner.

## Signing

Payouts that need a signature come back from `preparePayout` as an unsigned Stellar transaction. Your signer holds the key, and it must check what it signs, because the partner built the transaction. It refuses (throws) unless:

1. `assertSigningAllowed(context, now)` passes: the transfer is in `awaiting_signature`, the quote has not expired, and the clock is sane;
2. it signs for its own network passphrase, never one the partner names. The network cannot be checked from an unsigned envelope: the signature binds it, so a transaction signed for another network is invalid on this one;
3. the envelope is a plain transaction, not a fee bump;
4. it has exactly one operation, a payment;
5. the transaction source is `context.expected.source`;
6. the operation has no source of its own or that same account, a muxed (M...) source included;
7. the payment pays `expected.destination`;
8. in `expected.amount.asset`, code and issuer;
9. for exactly `expected.amount.amount`;
10. the total fee is within the signer's own cap;
11. `assertMaxTimeWithinQuote(maxTime, context)` passes: the transaction has a `maxTime`, no later than the quote expiry; and its `minTime`, if any, is no later than the signing time;
12. it has no v2 preconditions: no minimum account sequence, sequence age or ledger gap, no extra signers, no ledger bounds.

`@vindu/grid-stellar` exports `assertPayoutXdrMatches`, a key-free check of the transaction rules (3 to 12, the `minTime` against its `now` option); a signer calls it before signing, and signs with its own network passphrase (2). Whatever a signer throws, the payout run reports `SignerRefusedError` with only a cause code that `causeCodeOf` accepts, so refusal messages never leak into the run's error.

## Payout flow

```ts
import { PayoutIncompleteError, canSignReplacement, runSignedPayout } from '@vindu/grid-core';

const result = await runSignedPayout({
  adapter,                       // any PartnerAdapter; its id must be quote.partner
  context: { transferId, state: 'payout_quoted', quote, account },
  funded,                        // the amount confirmed in the account; quote.source must not exceed it
  now: Date.now,
  idempotencyKey,                // stored before the call, reused on every retry
  // Only for partners that may return a transaction to sign:
  signing: {
    signer,                        // your key holder
    submission: 'client_submits',  // or 'partner_submits'
    submitter,                     // a StellarSubmitter, e.g. from @vindu/grid-stellar
    destination,                   // the partner's account the payment must reach
    // The partner authorized. Compare-and-set: payout_quoted -> awaiting_signature.
    onAuthorized: async () => (await moveIf('payout_quoted', 'awaiting_signature', 'signed_payout_flow')).state,
    onSigned: (signedXdr) => store(signedXdr),                     // keep it before it leaves
    // Required with client_submits: the money moved, store it before the partner is told.
    onSubmitted: (outcome) => moveIf('awaiting_signature', 'payout_submitted', 'signed_and_on_chain', outcome.hash),
  },
});
```

A partner that moves the funds itself (`preparePayout` returns `none`) needs no `signing` group: the run creates the payout and returns `authorization: 'none'`. If such a run gets a transaction to sign, it stops with `PayoutAuthorizationError` while the transfer is still in `payout_quoted`.

Before any call, the run checks the input: the quote is a payout quote from `adapter.id`, and `quote.source` is a positive amount of the funded asset (code and issuer), no more than `funded`. The signer's expected amount is `quote.source` only after that. A transaction to sign must be for a Stellar account.

`onAuthorized` must be a compare-and-set: store `awaiting_signature` only if the transfer is still in `payout_quoted`, and throw when it is not, so two concurrent runs for one transfer can never both sign. The signer receives the state `onAuthorized` returns, and any state but `awaiting_signature` stops the run with `SigningNotAllowedError` before signing.

Each error says which transition to take. Every row's edge is a rule of the transition table with exactly that reason, starting from the state in the "Transfer is in" column:

| Error | Where it stopped | Transfer is in | Take |
|---|---|---|---|
| `QuoteExpiredError`, `stage: 'authorization'` | before the authorization was handed over, or, with no signature needed, before the create | `payout_quoted` | `payout_quoted -> funded` (`quote_expired_before_authorization`), then get a fresh quote |
| `PayoutAuthorizationError` (keeps the cause's `code`, not its text) | the authorize step threw, or returned something the run cannot use | `payout_quoted` | `payout_quoted -> needs_attention` (`authorization_failed`) |
| `PayoutIncompleteError`, `stage: 'create'`, no `signedXdr` | no signature needed, the create failed; nothing was signed | `payout_quoted` | retry with `retryPayoutExecute`; if it never succeeds, `payout_quoted -> needs_attention` (`payout_create_failed`) |
| `QuoteExpiredError`, `stage: 'signing'` | after `onAuthorized`, before the transaction left | `awaiting_signature` | `awaiting_signature -> funded` (`quote_expired_before_signing`), then get a fresh quote |
| `SignerRefusedError` | the signer threw, rejected or returned no transaction | `awaiting_signature` | `awaiting_signature -> needs_attention` (`signer_refused`) |
| `PayoutInterruptedError` (keeps the cause's `code`, not its text) | after `onAuthorized`, with no edge of its own: `onSigned` threw, the clock broke, or something unexpected | `awaiting_signature` | `awaiting_signature -> needs_attention` (`run_interrupted`); nothing was submitted, never sign again for this quote |
| `PayoutIncompleteError`, `stage: 'submit'` | `client_submits`: the submit was not a confirmed success | `awaiting_signature` | `awaiting_signature -> needs_attention` (`submission_rejected_or_unknown`) |
| `PayoutIncompleteError`, `stage: 'record'` | `client_submits` only: on the ledger, but `onSubmitted` threw | `awaiting_signature` | `awaiting_signature -> payout_submitted` (`signed_and_on_chain`), then `retryPayoutExecute`: the money moved, never re-quote. Found already in `payout_submitted`? The store is done: go straight to the retry |
| `PayoutIncompleteError`, `stage: 'create'`, with `txHash` | `client_submits`, after `onSubmitted` stored the move | `payout_submitted` | retry with `retryPayoutExecute`; if it never succeeds, `payout_submitted -> needs_attention` (`partner_refused_or_unknown`) |
| `PayoutIncompleteError`, `stage: 'create'`, `signedXdr` but no `txHash` | `partner_submits`, the partner did not confirm | `awaiting_signature` | retry with `retryPayoutExecute`; if it never succeeds, `awaiting_signature -> needs_attention` (`partner_submission_unknown`) |

On success: with no signature, take `payout_quoted -> payout_processing` (`partner_custodied_account`). With `client_submits`, `onSubmitted` already stored `awaiting_signature -> payout_submitted` (`signed_and_on_chain`). With `partner_submits`, take `awaiting_signature -> payout_submitted` (`sent_to_partner`): the partner holds the signed XDR, and nobody has seen it on chain yet. Both signed paths then take `payout_submitted -> payout_processing` once the partner accepts.

These have no edge, because the run did not move the transfer:

- `InvalidInputError`: unusable input, before any call, or a clock that throws or breaks before `onAuthorized`. The transfer is in `payout_quoted`. After `onAuthorized`, a broken clock is `PayoutInterruptedError`.
- `SigningNotAllowedError`: `onAuthorized` returned another state, for example because a concurrent run moved the transfer. Nothing was signed.
- Whatever `onAuthorized` throws, unchanged. Read the stored state: in `payout_quoted` nothing moved; in `awaiting_signature` the hook committed and then threw, so take `awaiting_signature -> needs_attention` (`run_interrupted`).

The run works on a frozen copy of `context` and `funded`, read once at the start: the adapter, the hooks and the signer receive frozen copies, so nothing can change the quote the signer checks during the run. A logger that throws never stops the run. Cause codes are kept only when they are lowercase snake or kebab codes of at most 48 characters (`causeCodeOf`); a system constant such as `ETIMEDOUT` or `UND_ERR_SOCKET` is kept lowercased, and one without an underscore only up to 12 characters (`ECONNREFUSED`). A code of that shape that reads as data is dropped as well: a segment of 8 or more characters holding a digit (`sk_live_abc123def456`, `maria_silva_12345678901`), 6 or more digits in total (`cpf-123-456-789-00`, `token_0123456`), a run of 16 or more hex characters, or a UUID. Anything else that is not code-shaped, such as `Jane Doe` placed in `code`, is dropped. The filter is best-effort: it keeps code-shaped values only and cannot tell a letter-only secret or name (`janedoe`) from a code, so never put client data or secrets in a `code`. `causeCodeOf` never throws: a `code` getter that throws or a Proxy gives no code, and the run still reports its typed error.

The quote must have more than `expiryMarginMs` left (default one minute) before authorizing, and again before the create when the partner needs no signature. With `client_submits` it must also outlive the submit: more than `expiryMarginMs + submitter.maxDurationMs` before `onAuthorized`, before signing and again before submitting. `maxDurationMs` is required on the submitter: a `client_submits` run refuses a submitter without a finite `maxDurationMs` >= 0 with `InvalidInputError`, before any call. Only a submit outcome of `success` lets the payout be created. The run reads the outcome's `status`, `hash` and `detail` once each (a class instance with getters works) and keeps a frozen copy of only those; a field whose read throws is left out, so a success without a readable hash is not confirmed. Any other outcome throws `PayoutIncompleteError` with `stage: 'submit'` and the outcome: sign a replacement only when `canSignReplacement(outcome)` is true (`failed` or `expired_not_landed`), never while the first transaction could still land (`unknown`, `rejected`). A failed create throws `stage: 'create'` with the exact input and key; pass `error.pending` to `retryPayoutExecute(adapter, pending)`, which checks it (including that the quote's `partner` is `adapter.id`) and never signs or submits.

## License

Apache-2.0
