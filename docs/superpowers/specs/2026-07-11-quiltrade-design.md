# QuilTrade — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Problem / Goal

Add a new sub-page under Options, **QuilTrade**, that shows NIFTY options ATM±10 strikes grouped visually into the four standard OI-buildup quadrants (Long Buildup, Short Buildup, Short Covering, Long Unwinding), with live prices per strike. Below the quadrants: Positions, Orders, and Tradebook tabs. The page header shows live account P&L.

## Route / Nav

- New page: `rs_dashboard/app/options/quiltrade/page.tsx` (thin wrapper around a new client component).
- Add `{ href: '/options/quiltrade', label: 'QuilTrade', desc: 'OI buildup quadrants, live positions & P&L' }` to the `Derivatives` group in `rs_dashboard/components/NavBar.tsx`, alongside `/options/delta` and `/options/crudeoil`.

## Classification Logic (reused, unchanged)

Same as `OptionsBuildupTab.tsx`, applied independently to the CE and PE side of each strike:

| OI Change | Price Change | Label |
|---|---|---|
| ↑ (OI added) | ↑ | **Long Buildup** |
| ↑ (OI added) | ↓ | **Short Buildup** |
| ↓ (OI removed) | ↑ | **Short Covering** |
| ↓ (OI removed) | ↓ | **Long Unwinding** |
| 0 or no `previous_oi` | any | **Neutral** — omitted from the grid entirely |

OI change = `current_oi − previous_oi`; price change = `last_price − previous_close_price`. Both fields already come through `/api/options/chain`.

## Data Sources

| Data | Source | Poll interval |
|---|---|---|
| Quadrant grid (chain, ATM±10) | `GET /api/options/chain?underlying=NIFTY&expiry=<date>` (existing, 10s server cache) | 30s |
| Positions / Orders / Tradebook | **New** `GET /api/quiltrade/poll` → wraps `scripts/tools/scalper_api.py poll`, filtered to NIFTY-symbol rows | 5s |
| Header P&L | `GET /api/portfolio` (existing, wraps `get_portfolio_pnl.py`) | 5s |

No new WebSocket bridge and no changes to `scalper_api.py` — the new route filters its `poll` output server-side by trading symbol (`startsWith('NIFTY')`, excluding `BANKNIFTY`/other prefixes that also start with "NIFTY" if any collide — use an exact underlying-token match on the parsed symbol, not a raw substring).

## New API Route

`rs_dashboard/app/api/quiltrade/poll/route.ts` — same `execFile` + PROJECT_ROOT pattern as `app/api/scalper/positions/route.ts`:

```ts
const { stdout } = await execFileAsync(PYTHON_EXE, [SCALPER_SCRIPT, 'poll'], { cwd: PROJECT_ROOT, timeout: 20_000, windowsHide: true });
// parse last JSON line -> { success, positions, orders, trades }
// filter each array to rows whose symbol/tradingSymbol identifies NIFTY options
// return NextResponse.json({ success, positions, orders, trades })
```

## Components

- `rs_dashboard/components/QuilTradeTab.tsx` (new) — page body: sticky header, quadrant grid, tab strip.
- **Header bar**: `DATA: YYYY-MM-DD` chip, expiry selector (same pattern as `OptionsCharts.tsx`), live P&L readout — green if `total_pnl >= 0` else red, sourced from `/api/portfolio`.
- **Quadrant grid**: 2×2 CSS grid, one panel per label:

  | Panel | Color |
  |---|---|
  | Long Buildup | `emerald` (`text-emerald-400 bg-emerald-500/10 border-emerald-500/20`) |
  | Short Buildup | `red` (`text-red-400 bg-red-500/10 border-red-500/20`) |
  | Short Covering | `sky` (`text-sky-400 bg-sky-500/10 border-sky-500/20`) |
  | Long Unwinding | `amber` (`text-amber-400 bg-amber-500/10 border-amber-500/20`) |

  Same palette already used by `BuildupBadge` in `OptionsBuildupTab.tsx`, kept consistent across the app.

  Each panel is a wrapped flex of small rectangle tiles. A tile is rendered per CE **or** PE leg landing in that quadrant (so one strike can produce 0, 1, or 2 tiles, potentially in different panels). Tile content: `STRIKE CE/PE` badge, LTP, price-change %, OI-change %. Strikes scoped to ATM±10 (step 50), ATM computed from chain response `spot` the same way `OptionsBuildupTab.tsx` does.

- **Tab strip** (Positions / Orders / Tradebook): plain tables under the grid, driven by `/api/quiltrade/poll`. Table styling follows dashboard convention: `text-xs font-bold text-white` headers on solid `bg-zinc-800`, no text-color opacity modifiers.

## Error Handling

- Each of the three pollers (chain, quiltrade/poll, portfolio) fails independently; on fetch error the affected panel keeps showing last-known data with a small inline "stale" indicator rather than blanking.
- Neutral legs (no `previous_oi` or zero OI change) are simply omitted from the grid — not shown in any quadrant, not treated as an error.

## Files Changed / Added

| File | Change |
|---|---|
| `rs_dashboard/app/options/quiltrade/page.tsx` | New — thin page wrapper |
| `rs_dashboard/components/QuilTradeTab.tsx` | New — header, quadrant grid, tab strip |
| `rs_dashboard/app/api/quiltrade/poll/route.ts` | New — positions/orders/trades filtered to NIFTY |
| `rs_dashboard/components/NavBar.tsx` | Add QuilTrade link to Derivatives group |

## Design Decisions

- **Reuse existing chain endpoint and classification logic** rather than a new live WS feed — OI doesn't move fast enough intraday to justify a 2s feed, and this avoids duplicating/verifying the WS payload's OI schema.
- **Separate CE/PE tiles per quadrant** rather than one net-signal tile per strike — matches the classifier, which already operates per-leg, and avoids inventing a new combined-signal formula.
- **New `/api/quiltrade/poll` route wrapping `scalper_api.py poll`** rather than modifying the shared script — keeps the scalper page's script untouched, filtering happens at the route layer.
- **NIFTY only, no underlying selector** — matches current scope of `OptionsBuildupTab.tsx`; can be extended later.
- **Sub-route under `/options`** (not top-level nav group) — page is a derivative view of the options chain, consistent with `/options/delta` and `/options/crudeoil`.
