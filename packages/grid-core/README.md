# @vindu/grid-core

Types, transfer states, routing rules and the partner adapter interface for two-leg transfers settled on Stellar: fiat to USDC, then USDC to fiat.

Pure TypeScript. No network calls, no environment reads, no partner code. Partner clients such as `@vindu/grid-blindpay` implement the interfaces defined here.

> Status: early, not published. Every API here will change before the first release.

## What is inside

| Module | Contents |
|---|---|
| Money | `Money = { amount: string; asset: Asset }`. Exact decimal arithmetic on bigint units of 10^-7, so `0.1 + 0.2` is exactly `0.3`. Minor-unit conversion that refuses to round. |
| Assets | `{ code, issuer? }`. Fiat has no issuer; a Stellar asset is its code plus issuer. |
| Transfer states | Twelve states, the transition table with labelled reasons, `canTransition` and `transition` (throws `InvalidTransitionError`). |
| Ports | `PartnerAdapter`: quote and create the funding leg, quote, prepare and execute the payout, read a leg, parse a webhook. |
| Signer | `Signer.signStellar(account, unsignedXdr, context)`. Keys never enter this library. |
| Capabilities | Chains, account model per chain and rails per currency. The registry is data your application passes in. |
| Routing | `selectRoute`: Stellar route first, best price otherwise. `assertRouteImmutable` keeps the route fixed after the funding leg exists. |
| Tolerance | `checkPayoutTolerance`: a payout quote outside the tolerance moves the transfer to `needs_attention`. |
| Observability | `Logger`, `noopLogger`, and the `PartnerCall` shape for `onCall` hooks. |
| Errors | `GridError` with a stable `code`, and typed subclasses. |

## Routing

Routing runs once, at quote time:

1. Keep partners where the client is approved and the corridor is supported.
2. Keep partners with a ready account for the client.
3. If a Stellar route remains, select it. `stellarPriceLimitBps` is only a safeguard against an abnormal quote: the Stellar route loses only when its price is worse than the best alternative by more than that limit.
4. Without a Stellar route, pick the best price.

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

Payouts that need a signature come back from `preparePayout` as an unsigned Stellar transaction. Your signer holds the key. Before it signs, it should decode the transaction and check the amount, the asset, the destination and the transfer state against the `SigningContext` it receives. `assertSigningAllowed` covers the state and quote expiry.

## License

Apache-2.0
