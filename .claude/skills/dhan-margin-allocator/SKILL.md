---
name: dhan-margin-allocator
description: Use when touching the Margin Allocator page (rs_dashboard/components/MarginAllocator.tsx, app/api/margin-allocator/route.ts and route.ts's trend/ subroute) — the capital-deployment desk that classifies live option positions into structures, reads VIX percentile + per-underlying trend, and ranks/sizes new credit strategies against a risk budget. Not for the payoff math itself (dhan-payoff-diagrams) or the live order-ticket P&L math (dhan-broker-positions) — this is capital allocation and strategy ranking, one level up from either.
---

# Dhan Margin Allocator

## Overview
Built in one day across four commits (`cd31772`, `6f1022e`, `3726cbe`, `d4c4b39`):
a capital-deployment desk that (1) classifies every live option position across
Dhan and Kotak into a structure (straddle/strangle/spread/condor/naked) and shows
what margin is idle vs. blocked, (2) reads India VIX percentile + per-underlying
trend to bias sizing, and (3) ranks every Baskets credit-strategy template against
a risk budget and proposes an allocation plan. It touches three source-of-truth
files that don't otherwise interact: `positionLegs.ts` (position → leg shape),
`ultimateScannerEngine.ts` (DTE/trend helpers shared with the RS scanner), and its
own `trend/route.ts` (VIX percentile, EMA20+Supertrend per underlying). Read
`MarginAllocator.tsx`'s own header comment and `route.ts`'s header comment first —
both explain scope decisions (why Zerodha isn't wired in, why Kotak margin is a
cross-priced estimate) in more depth than this skill repeats.

## When to Use
- Adding a new broker to the position-classification side (`route.ts`).
- Adding a new credit-strategy template to the ranking/allocation side
  (`MarginAllocator.tsx`'s candidate-building section).
- Changing how VIX percentile or trend feeds into sizing.
- Debugging why a structure was misclassified, why Kotak's margin figure looks
  like a live Dhan number, or why the allocation plan concentrated in one
  underlying/strategy type despite the caps.

## How Position Classification Works

`route.ts`'s `MARGIN_BROKERS = ['dhan', 'kotak']` is the current broker list.
**Zerodha is deliberately absent** — its trading-symbol shape doesn't match what
`parseTradingSymbol()` (from `positionLegs.ts`) recognizes, and it had no active
session when this was built. Adding Zerodha means teaching `parseTradingSymbol`
its symbol format, not just adding a broker key to the array.

Dhan is the only broker with its own netted margin calculator. Kotak's
`marginBlocked` is **never a live Kotak number** — it's priced by looking up the
equivalent NSE contract in Dhan's calculator (`marginSource: 'live-cross-broker'`),
falling back to the same flat estimate `/api/multi-leg-focus/margin` uses for every
non-Dhan broker (`marginSource: 'estimate'`) when that lookup fails. Never let a
new code path label a Kotak figure `marginSource: 'live'` — that's reserved for
Dhan's own calculator and callers key UI treatment (e.g. a "live" vs "estimated"
badge) off this field.

## How VIX/Trend Sizing Works (`trend/route.ts`)

Two **independent** levers, both driven by India VIX Percentile (trailing 252
sessions from `Historical Data/Indices/INDIA_VIX.csv`, not the scan API's
absolute-level regime bucket — percentile answers "high relative to its own
recent range," which is what should drive sizing, not an absolute threshold that
means different things in a calm year vs. a turbulent one):

1. **`vixPercentileToNakedTilt`** — re-splits an *already-fixed* risk-preset
   budget between naked and defined-risk structures. Doesn't change how much
   total capital deploys.
2. **`vixPercentileToDeployMultiplier`** — throttles the **total** deployable
   budget above the 85th percentile. Separate lever, separate anchor table
   (`VIX_DEPLOY_ANCHORS`) — the reasoning in `MarginAllocator.tsx`'s comment
   above it: opening fresh option-selling positions while VIX is still actively
   spiking is when parameter/repricing uncertainty is highest, so a Kelly-style
   cut applies even if the naked/defined split hasn't shifted.

Both anchor tables are piecewise-interpolated (`interpolatePiecewise`), not
step functions — when adding a new anchor point, keep it monotonic or the
interpolation produces a non-monotonic sizing curve.

SENSEX's own trend falls back to NIFTY's when `Historical Data/Indices/SENSEX.csv`
is missing or too short (freshly deployed, not yet backfilled) — this is a
disclosed, deliberate simplification (NSE/BSE benchmarks move together on all but
the rarest sessions), not a bug to "fix" by blocking on the file existing.

## How Allocation Ranking Works (`buildAllocationPlan`)

Greedy two-pass fit, not an optimizer: pass one diversifies (one unit of every
candidate the budget can fit, highest `score` first), pass two spends leftover
budget scaling already-selected winners. Two **independent** concentration caps
apply together, and both matter:

- `maxPerUnderlyingFraction` (default 0.6) caps one **correlation group**
  (`correlationGroup()` — NIFTY+SENSEX combined, since both react to the same
  index-level moves; everything else individually) from eating the whole budget.
- `maxPerTypeFraction` (default 0.35) additionally caps one **strategy type**
  within one correlation group. Without this second cap, a scan that returns ten
  strike variants of the same Bear Call Spread on NIFTY alone satisfies the
  underlying-group cap while still being pure concentration dressed as
  diversification — that's the exact failure mode the second cap exists to block.

`directionalScoreMultiplier` biases each candidate's score by how well its
directional stance (`DIRECTIONAL_BIAS`) agrees with the underlying's own trend
read — a Bear Call Spread against a bullish trend still shows up in the ranked
list (nothing vanishes silently), it just scores lower and is less likely to win
a budget slot.

## Common Mistakes
- Adding a broker to `MARGIN_BROKERS` without also teaching `parseTradingSymbol`
  that broker's trading-symbol shape — the array alone will silently classify
  zero positions for it.
- Labeling any non-Dhan margin figure `marginSource: 'live'` — reserve that for
  Dhan's own netted calculator.
- Adding a new credit-strategy template to the ranking list without adding a
  `DIRECTIONAL_BIAS` entry — the multiplier function falls through to a neutral
  bias silently rather than erroring, which can mask a missing entry.
- Changing `maxPerUnderlyingFraction`/`maxPerTypeFraction` without re-checking
  both caps together — tightening one without the other can leave the loosened
  cap doing all the concentration control.
- Treating `vixPercentileToNakedTilt` and `vixPercentileToDeployMultiplier` as
  one lever — they answer different questions (mix vs. total size) and both need
  updating if the VIX-response philosophy changes.
