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
| Ports | `PartnerAdapter`: quote and create the funding leg, quote, prepare and execute the payout, read a leg (with the partner's amount), parse a webhook (async). `StellarSubmitter`: submit a signed transaction and report a typed outcome. |
| Signer | `Signer.signStellar(account, unsignedXdr, context)`. Keys never enter this library. `assertSigningAllowed` and `assertMaxTimeWithinQuote` cover the checks that need no Stellar SDK. |
| Payout flow | `runSignedPayout`: prepare, sign once, submit, then create the partner payout only after a confirmed success. `retryPayoutExecute` repeats a failed create unchanged. |
| Capabilities | Chains, account model per chain and rails per currency. The registry is data your application passes in. |
| Routing | `selectRoute`: Stellar route first, best price otherwise. `assertRouteImmutable` keeps the route fixed after the funding leg exists. |
| Tolerance | `checkPayoutTolerance`: a payout quote outside the tolerance moves the transfer to `needs_attention`. |
| Observability | `Logger`, `noopLogger`, and the `PartnerCall` shape for `onCall` hooks. |
| Errors | `GridError` with a stable `code`, and typed subclasses shared by every adapter: `InvalidConfigError`, `InvalidInputError`, `QuoteExpiredError`, `PayoutIncompleteError` and more. |

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

Payouts that need a signature come back from `preparePayout` as an unsigned Stellar transaction. Your signer holds the key, and it must check what it signs, because the partner built the transaction. Before signing, it:

1. calls `assertSigningAllowed(context, now)`: the transfer is in `awaiting_signature`, the quote has not expired, and the clock is sane;
2. decodes the XDR for its network, and refuses anything but a plain transaction (no fee bump) with exactly one payment operation;
3. checks the transaction source against `context.expected.source`, and that the operation has no source of its own or the same one;
4. checks the payment: to `expected.destination`, in `expected.amount.asset` (code and issuer), for exactly `expected.amount.amount`;
5. checks the total fee against its own cap;
6. calls `assertMaxTimeWithinQuote(maxTime, context)`: the transaction has a `maxTime`, no later than the quote expiry.

`TestKeySigner` in `examples/testnet-demo` makes every one of these checks, and its tests cover each refusal. It holds a throwaway key and is for tests and demos only.

## Payout flow

```ts
import { PayoutIncompleteError, canSignReplacement, runSignedPayout } from '@vindu/grid-core';

const result = await runSignedPayout({
  adapter,                       // any PartnerAdapter
  signer,                        // your key holder
  submitter,                     // a StellarSubmitter, e.g. from @vindu/grid-stellar
  submission: 'client_submits',  // or 'partner_submits'
  context: { transferId, state: 'awaiting_signature', quote, account, destination },
  now: Date.now,
  idempotencyKey,                // stored before the call, reused on every retry
  onSigned: (signedXdr) => store(signedXdr), // keep it before it leaves
});
```

The quote must have more than `expiryMarginMs` left (default one minute) before signing and again before submitting. Only a submit outcome of `success` lets the payout be created. Any other outcome throws `PayoutIncompleteError` with `stage: 'submit'` and the outcome: sign a replacement only when `canSignReplacement(outcome)` is true (`failed` or `expired_not_landed`), never while the first transaction could still land (`unknown`, `rejected`). A failed create throws `stage: 'create'` with the exact input and key; pass `error.pending` to `retryPayoutExecute`.

## License

Apache-2.0
