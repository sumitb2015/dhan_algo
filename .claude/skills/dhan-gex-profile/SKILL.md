---
name: dhan-gex-profile
description: Use when touching the GEX pages — /options/gex (v1, "GEX OI Chart") and /options/gex-v2 ("GEX Profile v2") — rs_dashboard/lib/gex.ts, gexV2.ts, gexModel.ts (+ tests), components/GexOiPage.tsx, GexProfilePage.tsx, GexLevelsChart.tsx, GexCalcTable.tsx, UpdateIntervalSlider.tsx, or docs/GEX_OI_GUIDE.md. Covers the v1 (Dhan chain gamma, video method) vs v2 (Black-76, spot-side walls, dynamic flip, expected move) split, the units traps (OI already in units, "22800.000000" strike keys), flip noise floor, wall-breach states, update-interval/in-flight guards and the chain route's allowStale fallback. Display only — no orders. Not for OI buildup/PCR/max pain (dhan-oi-analytics) or position Greeks (dhan-position-greeks).
---

# GEX pages (v1 and v2)

Display-only pages for Nifty gamma-weighted OI: call/put/net GEX per strike, call wall, put wall, gamma flip,
regime. Sources: [video 1 "Trade the Influence, Not Contracts"] for v1, [video 2 Flow Zone "Gamma Exposure
Explained"] for v2 (both in the vault: `oi-vs-gex-video`, `gamma-exposure-explained-flow-zone-video`). User
guide: `docs/GEX_OI_GUIDE.md` (shown in-page via the Guide panel). The dealer sign convention is an **assumption**
(calls positive, puts negative; dealers long calls / short puts) — Indian index options have no public dealer book.

## Two pages, two modules, one rule: v1 never imports the model
| | v1 `/options/gex` | v2 `/options/gex-v2` |
|---|---|---|
| Maths | `lib/gex.ts` — **no pricing maths** | `lib/gexV2.ts` + `lib/gexModel.ts` |
| Gamma | Dhan chain `greeks.gamma`, as given | Dhan gamma by default; Gamma switch offers Black-76 recompute |
| GEX | gamma × OI_units × spot × 0.01 (index units per 1% move) | same, `power` 1/2 option |
| Walls | global max call / min put GEX (`gexLevels`) | **spot-side**: call wall ≥ spot, put wall ≤ spot; top-3; breach badge |
| Flip | negative→positive midpoint between strikes (`gammaFlip`) | zero-gamma flip re-priced at 61 spots over ±20 % (`dynamicFlip`) beside the strike-profile flip |
| Extras | checklist, calc table | expected-move bands (ATM straddle), confluence, regime note, nearest-N-expiries aggregate (`mergeGexRows`) |

`gexModel.ts` says "GEX OI Chart (v1) must never import it" — keep it true. The v1-vs-v2 choice is still open
(vault: `gex-oi-chart-page`).

## Traps already hit
- **OI is already in units.** Every live Dhan chain OI was a multiple of the lot (checked 2026-10-06). Multiplying by
  the lot again inflated GEX 65×. There is deliberately **no auto-detect** (a lot revision leaves old series in
  multiples of the previous lot and a divisibility test would misread them as lots). A source really in lots passes
  `oiUnit: 'lots'` explicitly.
- **Strike keys are `"22800.000000"`.** A lookup by `String(strike)` finds nothing (v2 expected move shipped broken
  once). Parse with `Number(key)` or normalise before comparing.
- **Same-day expired expiry** produced a clamped-time 0DTE artefact and a noise flip. Default expiry skips expired
  contracts. `GEX_MIN_T` is a 10-minute floor (`gexTimeYears`); the shared pricing clock floors at 6 h and froze
  expiry-day gamma from ~09:40 — GEX-only, do not leak it into prices/payoffs.
- **Flip noise floor:** crossings between strikes whose larger |net| is under 1 % of the chain's peak |net| are
  ignored (`18695a24`); several crossings → the one nearest spot.
- **Wall breach** (`wallStatuses`, v2): `intact | breached | breached-amplifying` (breached while regime negative),
  with a `WALL_TOL = 0.1 %` band so it does not flicker; shows the next wall on spot's side.
- **Spot-0 / missing future price:** the rolled forward falls back to `forwardFromSpot`; that fallback must be
  flagged in the UI, not silent. Stale VIX must not keep the tile green.
- **Dhan call and put gamma can disagree at one strike** (unexplained; vault `call-wall-article-vs-our-gex-implementation`).
  The calc table exists so this is visible.

## Refresh model
- `UpdateIntervalSlider` (5 s – 3 min, saved per browser) drives chain, spot and level-chart refresh. Every poll has an
  **in-flight guard** and the stale threshold has a floor, so a slow chain never stacks requests (`dhan-polling-guards`).
- `/api/options/chain?allowStale=1` serves the last good chain when Dhan fails (rate limit/empty), with a 10 s failure
  cooldown; the pages opt in, show an amber "last good chain from HH:MM:SS" note and keep retrying (3× / 6 s). Other
  callers must not pass `allowStale` — a stale chain is wrong for anything that trades.
- Spot is polled separately (~20 s); the `DATA:` chip is the fetch date, not a session date.

## Before you ship
`cd rs_dashboard && node --test lib/gex.test.ts lib/gexV2.test.ts lib/gexModel.test.ts`. If you change a wall or flip
rule, update `gexChecklist`/`wallClarity`, the in-page Guide and `docs/GEX_OI_GUIDE.md` together. Verify against a live
chain in market hours — everything so far was checked after hours.
