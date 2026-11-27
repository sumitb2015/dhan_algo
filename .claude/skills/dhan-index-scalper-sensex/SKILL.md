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
- **Every lots <-> units conversion uses the contract's OWN lot** (`lib/indexScalperLots.ts`: `lotOf(id)` in the
  terminal, `lotSizes` on the chart): the screen expiry's strikes get its lot, Kotak contracts the symbol lookup's
  `lotSize`, any other Dhan contract (a held / working leg in another expiry) the master list via
  `GET /api/index-scalper/lots?segment=BSE_FNO&ids=`. Unknown = refused. Before (review 2026-11-27) the screen's lot was
  used everywhere: a Dec order edited to "4 lots" under a Jan screen sent 100 units (5 Dec lots), "+4" opened 5. Exit /
  Exit All were never affected (they close the broker's own quantity).
- A ticket bound to one expiry keeps that expiry's lot size when the expiry on screen changes (20 vs 25 straddles the Dec/Jan boundary).
- Dhan's position `tradingSymbol` form for BSE options is unobserved: `dhanRowContract` takes an option from the row's
  own `exchangeSegment` (BSE_FNO) + exact root + `drvOptionType` CALL / PUT + `drvStrikePrice` when the symbol does not
  parse, so a SENSEX leg never drops out of Exit All / the MTM guard. Confirm the real form on the first live position.
- Price alerts resolve NSE / MCX contracts only (`lib/pnfContracts.ts`): a SENSEX alert is refused.
- Segment labels for Kotak rows come from `dhanSegmentOfSymbol` (`^SENSEX` -> BSE_FNO); never used to route an order.
- Kotak order route derives exchange from the contract's own `segment`, falling back to `bse_fo`.
- BSE option liquidity is thinner: market orders on a strike outside the bridge's 35-strike window refuse.

## Verify
`node --test lib/indexScalperSensex.test.ts lib/indexScalperInstrument.test.ts lib/indexScalperSession.test.ts`; `e2e/index-scalper-sensex.spec.ts`.
