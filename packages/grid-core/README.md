# @vindu/grid-core

Types, transfer states, routing rules and the partner adapter interface for two-leg transfers settled on Stellar: fiat to USDC, then USDC to fiat.

Pure TypeScript. No network calls, no environment reads, no partner code. Partner clients such as `@vindu/grid-blindpay` implement the interfaces defined here.

## Status

| Aspect | Status |
|---|---|
| Version | 0.1.0, git tag only: not on npm. Install from the tag `v0.1.0` as the [root README](../../README.md#install-from-a-git-tag) shows. |
| Node | 22 or later. |
| Format | CommonJS with type declarations. One entry point: import from `@vindu/grid-core` only; files under `dist/` are internal. |
| Stability | Early. Every API here may change before the first release. |
| Planned | The adapter conformance suite, in the tranche 3 integration kit. Corridor names such as `awaiting_pix` and `pixCode` stay while every partner uses PIX; renaming them later is a breaking change. |

## What is inside

| Module | Contents |
|---|---|
| Money | `Money = { amount: string; asset: Asset }`. Exact decimal arithmetic on bigint units of 10^-7, so `0.1 + 0.2` is exactly `0.3`. Minor-unit conversion that refuses to round. |
| Assets | `{ code, issuer? }`. Fiat has no issuer; a Stellar asset is its code plus issuer. |
| Transfer states | Twelve states, the transition table with a reason code and label per rule (failure edges included), `canTransition` and `transition(from, to, reason?)` (throws `InvalidTransitionError`). |
| Ports | `PartnerAdapter`: quote and create the funding leg, quote, prepare and execute the payout, read a leg (with the partner's amount), parse a webhook (async). `StellarSubmitter`: submit a signed transaction, report a typed outcome and, optionally, its longest submit time (`maxDurationMs`). |
| Signer | `Signer.signStellar(account, unsignedXdr, context)`. Keys never enter this library. `assertSigningAllowed` and `assertMaxTimeWithinQuote` cover the checks that need no Stellar SDK. |
| Payout flow | `runSignedPayout`: from `payout_quoted`, check the quote against the funded amount, authorize, then either create the payout (no signature needed) or let you store `awaiting_signature`, sign once, submit, let you store `payout_submitted`, and create the partner payout only after that. Each error names the transition to take. `retryPayoutExecute` repeats a failed create unchanged. |
| Capabilities | Chains, account model per chain and rails per currency. The registry is data your application passes in. |
| Routing | `selectRoute`: Stellar route first, best price otherwise. `assertRouteImmutable` keeps the route fixed after the funding leg exists. |
| Tolerance | `checkPayoutTolerance`: a payout quote outside the tolerance moves the transfer to `needs_attention`. |
| Observability | `Logger`, `noopLogger`, and the `PartnerCall` shape for `onCall` hooks. |
| Errors | `GridError` with a stable `code`, and typed subclasses shared by every adapter: `InvalidConfigError`, `InvalidInputError`, `PartnerHttpError` (with the `idempotencyKey` sent), `WebhookRejectedError`, `QuoteExpiredError`, `PayoutAuthorizationError`, `SignerRefusedError`, `PayoutIncompleteError` and more. |

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
2. the XDR decodes for the signer's own network;
3. the envelope is a plain transaction, not a fee bump;
4. it has exactly one operation, a payment;
5. the transaction source is `context.expected.source`;
6. the operation has no source of its own or that same account, a muxed (M...) source included;
7. the payment pays `expected.destination`;
8. in `expected.amount.asset`, code and issuer;
9. for exactly `expected.amount.amount`;
10. the total fee is within the signer's own cap;
11. `assertMaxTimeWithinQuote(maxTime, context)` passes: the transaction has a `maxTime`, no later than the quote expiry;
12. it has no v2 preconditions: no minimum account sequence, sequence age or ledger gap, no extra signers, no ledger bounds.

`@vindu/grid-stellar` exports `assertPayoutXdrMatches`, a key-free check of this whole list; a signer calls it before signing. Whatever a signer throws, the payout run reports `SignerRefusedError` with only a code-shaped cause code, so refusal messages never leak into the run's error.

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

Each error says which transition to take. Every row is a rule of the transition table:

| Error | Where it stopped | Transfer is in | Take |
|---|---|---|---|
| `QuoteExpiredError`, `stage: 'authorization'` | before the authorization was handed over | `payout_quoted` | `payout_quoted -> funded` (`quote_expired_before_authorization`), then get a fresh quote |
| `PayoutAuthorizationError` (keeps the cause's `code`, not its text) | the authorize step threw, or returned something the run cannot use | `payout_quoted` | `payout_quoted -> needs_attention` (`authorization_failed`) |
| `PayoutIncompleteError`, `stage: 'create'`, no `signedXdr` | no signature needed, the create failed | `payout_quoted` | retry with `retryPayoutExecute`; if it never succeeds, `payout_quoted -> needs_attention` (`payout_create_failed`) |
| `QuoteExpiredError`, `stage: 'signing'` | after `onAuthorized`, before the transaction left | `awaiting_signature` | `awaiting_signature -> funded` (`quote_expired_before_signing`), then get a fresh quote |
| `SignerRefusedError` | the signer threw, rejected or returned no transaction | `awaiting_signature` | `awaiting_signature -> needs_attention` (`signer_refused`) |
| `PayoutIncompleteError`, `stage: 'submit'` | the submit was not a confirmed success | `awaiting_signature` | `awaiting_signature -> needs_attention` (`submission_rejected_or_unknown`) |
| `PayoutIncompleteError`, `stage: 'record'` | on the ledger, but `onSubmitted` threw | `awaiting_signature` | `awaiting_signature -> payout_submitted` (`signed_and_on_chain`): the money moved; store it, then `retryPayoutExecute`; never re-quote |
| `PayoutIncompleteError`, `stage: 'create'`, with `txHash` | `client_submits`, after `onSubmitted` stored the move | `payout_submitted` | retry with `retryPayoutExecute`; if it never succeeds, `payout_submitted -> needs_attention` (`partner_refused_or_unknown`) |
| `PayoutIncompleteError`, `stage: 'create'`, `signedXdr` but no `txHash` | `partner_submits`, the partner did not confirm | `awaiting_signature` | retry with `retryPayoutExecute`; if it never succeeds, `awaiting_signature -> needs_attention` (`partner_submission_unknown`) |

`InvalidInputError` (unusable input, before any call; or a clock that breaks), `SigningNotAllowedError` (`onAuthorized` returned another state) and whatever your hooks throw have no edge: nothing was signed or submitted by the run, and the transfer waits for an operator.

The quote must have more than `expiryMarginMs` left (default one minute) before authorizing. With `client_submits` it must also outlive the submit: more than `expiryMarginMs + submitter.maxDurationMs` before `onAuthorized`, before signing and again before submitting. Only a submit outcome of `success` lets the payout be created. Any other outcome throws `PayoutIncompleteError` with `stage: 'submit'` and the outcome: sign a replacement only when `canSignReplacement(outcome)` is true (`failed` or `expired_not_landed`), never while the first transaction could still land (`unknown`, `rejected`). A failed create throws `stage: 'create'` with the exact input and key; pass `error.pending` to `retryPayoutExecute`, which checks it and never signs or submits.

## License

Apache-2.0
