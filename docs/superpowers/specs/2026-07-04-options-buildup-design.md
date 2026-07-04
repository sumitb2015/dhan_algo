# Options Buildup Tab — Design Spec

**Date:** 2026-07-04  
**Status:** Approved

## Problem / Goal

The options page (`/options`) needs a dedicated **Buildup** tab that shows the standard Indian F&O buildup classification per strike and key seller-centric metrics. Traders use this to identify institutional positioning and determine where support/resistance lies.

## Classification Logic

Applied independently to the CE and PE side of each strike:

| OI Change | Price Change | Label |
|---|---|---|
| ↑ (OI added) | ↑ | **Long Buildup** — fresh longs added |
| ↑ (OI added) | ↓ | **Short Buildup** — fresh shorts added |
| ↓ (OI removed) | ↑ | **Short Covering** — shorts closing |
| ↓ (OI removed) | ↓ | **Long Unwinding** — longs closing |
| 0 | any | **Neutral** |

OI change = `current_oi − previous_oi`  
Price change = `last_price − previous_close_price`

Both `previous_oi` and `previous_close_price` are already returned by the DhanHQ broker chain API and passed through unchanged by `/api/options/chain`.

## Data Source

- **Single API**: `/api/options/chain?underlying=NIFTY&expiry=<date>` — polled every 30 s
- **No new API routes required**
- Previous-day reference fields already in response: `previous_oi`, `previous_close_price`

## Layout (top → bottom)

### 1. Seller Metrics Row (6 stat tiles)

| Tile | Computation |
|---|---|
| Max Pain | Strike minimising total option payout: `Σ max(0,K−S)·ce_oi[K] + Σ max(0,S−K)·pe_oi[K]` |
| PCR | `Σ pe.oi / Σ ce.oi` across all strikes |
| ATM Straddle | `ce.last_price + pe.last_price` at ATM strike |
| Expected Move ± | `±straddle` as ₹ and `(straddle/spot*100).toFixed(1)%` |
| Breakeven Range | `spot − straddle` to `spot + straddle` |
| DTE | `Math.ceil((new Date(expiry) − today) / 86400000)` |

### 2. OI Walls (two-column grid)

- **Left — PE Walls (Support):** Top 5 strikes by PE OI descending
- **Right — CE Walls (Resistance):** Top 5 strikes by CE OI descending
- Per row: Rank | Strike | OI (formatted) | OI Chg% vs prev day | Buildup badge
- #1 strike gets a subtle highlight border

### 3. Buildup Table (ATM±10, 21 rows)

ATM row highlighted with `bg-amber-500/10`. Symmetric layout:

```
CE Buildup | CE LTP Chg | CE OI Chg% | CE OI  ||  STRIKE  ||  PE OI | PE OI Chg% | PE LTP Chg | PE Buildup
```

#### Badge color scheme (Tailwind)

| Label | Classes |
|---|---|
| Long Buildup | `text-emerald-400 bg-emerald-500/10 border border-emerald-500/20` |
| Short Buildup | `text-red-400 bg-red-500/10 border border-red-500/20` |
| Short Covering | `text-sky-400 bg-sky-500/10 border border-sky-500/20` |
| Long Unwinding | `text-amber-400 bg-amber-500/10 border border-amber-500/20` |
| Neutral | `text-zinc-500` (no background) |

## Files Changed

| File | Change |
|---|---|
| `rs_dashboard/components/OptionsBuildupTab.tsx` | New component |
| `rs_dashboard/components/OptionsCharts.tsx` | Add `buildup` tab entry + render |

## Design Decisions

- **Previous day as reference** — industry-standard approach (same as NSE option chain "Chng in OI"), not intraday change
- **ATM±10 strikes** — 21 rows balances depth vs readability
- **No new API route** — existing chain endpoint already passes `previous_oi` through
- **Theta excluded** from seller tiles — user preferred simpler 6-tile row
- **Separate tab** (not embedded in Intelligence tab) — clearer navigation, single focus per tab
