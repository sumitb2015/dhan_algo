---
name: dhan-index-scalper-nifty
description: Use when a change or bug on /index-scalper is specific to NIFTY (NSE index options, the NIFTY future FUT pane, lot size 65, 15:40 F&O close, NIFTY e2e). Instrument-specific facts only; the terminal is dhan-index-scalper, the chart is dhan-trading-chart.
---

# Index Scalper: NIFTY

Read `dhan-index-scalper` first (terminal rules); this file is only what is NIFTY-specific. Spec: `INSTRUMENTS.NIFTY` in `rs_dashboard/lib/indexScalperInstrument.ts`.

## Facts
| | |
|---|---|
| Exchange / segment | NSE, `NSE_FNO` (Kotak `nse_fo`); index candles `IDX_I` / `INDEX` |
| Index security id | `13` (spot, candles, expiry list). Option **chain underlying id is `26000`**, not 13 (CLAUDE.md) |
| Strike step / ticks | 50 / option and future tick 0.05 |
| Lot size | Never literal. `helper.get_lot_size("NIFTY")` via `scalper_api.py` (65 today; was 75). Unknown -> order refused (`dhanOrderQty` returns 0). `displayLotUnits` falls back to 65 for DISPLAY only |
| Order qty | Dhan = lots x lotSize units; Kotak = lots x lotSize units (same) |
| P&L multiplier | 1 on every broker (netQty is in units) |
| Cap / tag | 20 lots per order, tag `isx` (`SOURCE_QTY_CAPS.isx`, Kotak `SOURCE_LOT_CAPS` 20) |
| Product | MIS or NRML as chosen (crude-only NRML rule does not apply) |

## Session
- Index / spot candles: 09:15-15:30 IST. **Orders and option premium candles run to 15:40** (`inOrderSession`, SEBI close auction). Don't gate an order on `inMarketSession`.
- NSE holiday calendar = `nseHolidays.json` (one source).
- Bars anchored to 09:15 (`barAnchorSec`); 30 m / 60 m come from 15 m bars.

## FUT pane
The NIFTY future is a **chart-only** pane (volume bars; the index has none). It is never traded here and its Kotak row is not a leg (`legsFromKotakPositions` skips it; the MTM guard excludes it). Future id comes from `scalper_api.py` (`_find_nearest_future`, FUTIDX, on/after the option expiry).

## Traps
- Using 13 for the chain or 26000 for spot/candles: empty chain / wrong prices.
- Hardcoding lot 65 into sizing: breaks on the next exchange revision.
- Treating the 15:30 index stop as the order cutoff: orders are valid to 15:40.
- Weekly expiry day: NIFTY expiry clock is 15:40 (`optionsPricing.ts`); don't use 15:30 for time-to-expiry.

## Verify
`node --test lib/indexScalper*.test.ts` and `e2e/index-scalper.spec.ts` (NIFTY default; mocks only, non-GET unmocked = 599).
