---
name: dhan-index-scalper-sensex
description: Use when a change or bug on /index-scalper is specific to SENSEX (BSE index options, BSE_FNO, three-way security id split, per-expiry lot size 20/25, strike step 100, Kotak bse_fo). Instrument-specific facts only; the terminal is dhan-index-scalper, the chart is dhan-trading-chart.
---

# Index Scalper: SENSEX (BSE)

Read `dhan-index-scalper` first; this file is only what is SENSEX-specific. Spec: `INSTRUMENTS.SENSEX` in `rs_dashboard/lib/indexScalperInstrument.ts`. Tests: `lib/indexScalperSensex.test.ts`, `e2e/index-scalper-sensex.spec.ts`.

## The id split (silent failures, `docs/API_GOTCHAS.md` "SENSEX splits three ways")
| Use | Id / segment |
|---|---|
| Spot + candles | `51` under **`IDX_I`** (`BSE_IDX` -> DH-905 / empty quotes / LTP 0.0) |
| Option chain + expiry list | `1` under **`BSE_FNO`** |
| Option contracts in master | `find_option(..., exchange="BSE")`; the NSE default matches nothing |
Always pass numeric ids, never the bare symbol "SENSEX" (resolves to 51, whose chain is empty). The candles route passes the id explicitly and never takes one from the browser.

## Facts
| | |
|---|---|
| Exchange / segment | BSE, `BSE_FNO` (Kotak `bse_fo`); Dhan symbol `SENSEX-Dec2026-85000-CE`, Kotak `SENSEX26DEC85000CE` |
| Strike step / ticks | 100 / 0.05 |
| **Lot size varies by expiry** | 20 up to Dec 2026, 25 from the Jan 2027 series. `scalper_api.py` takes THIS expiry's own contracts' `LOT_SIZE` and **refuses** if they disagree or are missing; never `get_lot_size()` (returns the first master row, any expiry) and never a literal |
| Order qty | Dhan and Kotak = lots x that expiry's lot size |
| P&L multiplier | 1 |
| Cap / tag | 20 lots, `isx` |
| Session | Same clock as NIFTY: index 09:15-15:30, BSE F&O to 15:40; holidays follow `nseHolidays.json` |
| FUT pane | Chart-only SENSEX future on `BSE_FNO` (FUTIDX); not traded, not a Kotak leg |
| Display fallback | Unknown lot -> `displayLotUnits` = 1 (counts units rather than a guessed lot count) |

## Traps
- A ticket bound to one expiry must keep that expiry's lot size when the expiry on screen changes (20 vs 25 straddles the Dec/Jan boundary).
- Segment labels for Kotak rows come from `dhanSegmentOfSymbol` (`^SENSEX` -> BSE_FNO); never used to route an order.
- Kotak order route derives exchange from the contract's own `segment`, falling back to `bse_fo`.
- BSE option liquidity is thinner: market orders on a strike outside the bridge's 35-strike window refuse.

## Verify
`node --test lib/indexScalperSensex.test.ts lib/indexScalperInstrument.test.ts lib/indexScalperSession.test.ts`; `e2e/index-scalper-sensex.spec.ts`.
