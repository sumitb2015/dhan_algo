---
name: dhan-broker-cache
description: Use when an API route fetches a broker's raw positions or funds/margins (Dhan `/positions` `/fundlimit`, Zerodha `/portfolio/positions` `/user/margins`, Kotak positions/`kotakLimits()`) for anything other than sizing a real order — display, aggregation, ranking, a header chip. Covers `lib/brokerPositionsCache.ts`: when to route a raw broker call through it, when NOT to (order-gating reads must stay live), and how to invalidate it from a new order-placing route.
---

# Dhan Broker Positions/Funds Cache

## Overview
Several pages independently poll the same broker's positions and funds on their own
timers — Dashboard, Margin Allocator, Scalper, Advanced Scalper, and Multi-Leg Focus
can all be open at once, each hitting Dhan/Zerodha/Kotak on its own interval for data
that describes the exact same account. `lib/brokerPositionsCache.ts` is a single
process-wide, 2s-TTL, dedupe+invalidate-on-fill cache that lets them share one fetch
per broker instead of multiplying calls into Dhan's account-wide rate limit (see
`dhan-polling-guards` Guard 6). It wraps only the raw network call — every caller's
own shaping (`dedupePositions()`, `shapeKotakFunds()`, `scaleBrokerPnl()`,
`classifyBroker()`, whatever) still runs per-caller exactly as before.

It shipped 2026-09-07 for `dashboard/portfolio` + `margin-allocator`, then was
extended 2026-09-09 to `scalper/funds`, `scalper/zerodha/funds`, `scalper/kotak/funds`
once it was clear Scalper's own funds chip and Multi-Leg Focus's margin-sufficiency
check were independently polling the identical uncached endpoint.

## When to Use
- Writing or auditing any API route that calls `dhanGet('/positions')`,
  `dhanGet('/fundlimit')`, `kiteGet('/portfolio/positions')`,
  `kiteGet('/user/margins')`, `kotakGet(KOTAK_PATHS.positions)`, or `kotakLimits()`
  directly.
- The response feeds a **display, ranking, or aggregation** — a funds chip, a
  portfolio summary, a capital-allocation plan, a margin-sufficiency warning banner.
- Adding a new order-placing or order-cancelling route (must call
  `invalidateBrokerCache()` on fill — see below).
- A route memoizes its **whole assembled response** (not just the inner broker
  fetch) — it needs `brokerCacheGeneration()` too, or invalidation is invisible to it
  (see Guard 3 below; this is what `margin-allocator/route.ts` does).

## When NOT to Use — the one hard rule
**Never cache a read that gates a real-money decision made off this exact
response.** The existing exclusions, and why each one is excluded:

| Route | Why it stays raw |
|---|---|
| `scalper/positions`, `scalper/kotak/positions` | The per-row **Close button** awaits this route, then sizes its exit order off the response — comment in the route says so verbatim |
| `scalper/poll`, `scalper/zerodha/poll`, `scalper/kotak/poll` | Drive ProfitLock's live SL/target auto-detection and the terminals' fill/status display on every tick |
| `scalper/zerodha/exit-all`, `scalper/kotak/exit-all` (positions read inside) | Sizes the exit-all order itself |
| `scalper/all` (`positions`/`orders`/`trades` portion) | Same tab data the Close button and ProfitLock read; only its bundled `funds` field is display-only and would be a safe partial migration |
| `MultiLegFocus.tsx`'s `poll()` → `scalper/{broker}/poll` | Feeds `resolve_exit_qty`-style exit sizing and fill/auto-adopt detection for basket legs — same category as Scalper's own reads |

If you're not sure which category a new read falls into, ask: **"if this response
were up to 2 seconds stale, could a real order be sized wrong?"** If yes, don't touch
it. This is the same judgment call already documented for Scalper in
`dhan-broker-positions` — this skill is the caching half of that same boundary.

## API

```ts
import { getCachedPositions, getCachedFunds, invalidateBrokerCache, brokerCacheGeneration } from '@/lib/brokerPositionsCache';

// Wrap only the raw fetch — shape/rescale/aggregate the result exactly as before.
const funds = await getCachedFunds('dhan', () => dhanGet('/fundlimit'));
const positions = await getCachedPositions('kotak', () => kotakGet(KOTAK_PATHS.positions));
```

- Broker key is `'dhan' | 'zerodha' | 'kotak'`. Every caller of the same
  `(broker, kind)` pair shares one in-flight promise and one 2s-TTL cache entry —
  **treat what comes back as read-only**; nothing today mutates it in place, and a
  consumer that starts editing rows would silently corrupt what every other route
  sees next.
- Positions and funds share one TTL by design: every current caller fetches both
  together and expects them to describe the same instant. Don't introduce a caller
  that reads only one of the pair on a different cadence than the other without
  re-checking that assumption still holds.
- A failed broker call rejects out of `fetcher()` before `cache.set` runs — a bad
  response is never cached, so you don't need your own success-check around it
  beyond your normal `try/catch`.

### Invalidating on a real fill
Every route that places, exits, or cancels a real order must call
`invalidateBrokerCache(broker)` **after** the broker confirms — see
`scalper/order`, `scalper/kotak/order`, `scalper/zerodha/order`, `exit-all`,
`scalper/kotak/exit-all`, `scalper/zerodha/exit-all`, `scalper/fast-order`,
`options/order`, `options/order/cancel`, `csp-tracked/sell`,
`csp-tracked/shift/{entry,exit}-leg`, `csp-watchlist/{orders,exit}`,
`crudeoil/kotak-order`, `synthetic-futures/order` for the pattern. Forgetting this on
a new order route means Dashboard/Margin Allocator (and now the funds chips) show a
pre-fill snapshot for up to 2s after a real trade — not dangerous, but wrong and
confusing right after the order the user just placed.

```ts
// after the broker confirms the order/exit/cancel:
invalidateBrokerCache(broker); // drops cache entry + in-flight fetch + bumps generation
```

### If your route memoizes its own whole response
`margin-allocator/route.ts` wraps genuinely expensive per-group chain/margin
fetches in its own outer cache. A route like that must stamp its cache entry with
`brokerCacheGeneration(brokersThisRouteReads)` at the start of the request and
discard the entry once the stamp moves — otherwise it returns its own memoized body
before ever re-consulting the shared cache, and an order fill changes nothing it
shows. Scope the generation to the brokers you actually read (see the type
signature) — a global counter makes an unrelated broker's fill invalidate work you
didn't need to redo.

## Known Remaining Candidates
Grep for the raw call patterns above under `app/api/` before assuming a route is
already covered — the migration is incremental, not complete. As of 2026-09-09,
still raw and worth checking on your next pass through that route:
- `scalper/all`'s `funds` field (positions/orders/trades in the same route must stay
  raw — see table above; only the bundled funds fetch is a safe partial extraction)
- `crudeoil-trades/kotak/route.ts` (`kotakGet(KOTAK_PATHS.positions)`) — appears to be
  a read-only trade-reconciliation view; verify nothing downstream sizes an order off
  it before wiring it in
- `scalper/zerodha/all/route.ts`'s `funds` portion, same shape as `scalper/all`

## Before You Ship
- Is this read gating a real order size, or feeding a display/aggregate? Only the
  latter goes through the cache.
- Does every order/exit/cancel route this cache entry could go stale after already
  call `invalidateBrokerCache()`?
- If your route memoizes its own assembled response, did you stamp and check
  `brokerCacheGeneration()` too — not just wrap the inner broker call?
- Are you caching the **raw** fetch (matching the exact call another consumer
  already makes, e.g. `kotakLimits()` not a pre-shaped variant of it) so your read
  actually lands a cache hit against what Dashboard/Margin Allocator populated,
  instead of silently adding a new cache key nothing else shares?
