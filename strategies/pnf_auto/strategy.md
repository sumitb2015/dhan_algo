# P&F AUTO — double-bottom SELL / double-top BUY, exit on the first column reversal

> [!warning] UNVALIDATED
> There is no backtest or replay of these rules yet. Run it in PAPER first. REAL is armed per page load with a second,
> explicit click, and every REAL order is reserved in the ledger before it is sent.

Where: `/straddle-pnf`, one AUTO switch per chart (`components/straddlePnf/AutoControls.tsx`). Each chart trades the
instrument it shows (future, single option, or a CE + PE straddle), with that chart's own box size and reversal.

## Rules (`rs_dashboard/lib/pnfAuto.ts`, unit-tested)
Evaluated every second on the chart's **closed-bar** model only (the forming minute is never read, so nothing repaints).

| Rule | Behaviour |
|---|---|
| Entry SELL | A `DOUBLE_BOTTOM_SELL` signal (an O column breaks below the previous O column) on the **newest closed bar**, while flat |
| Entry BUY | A `DOUBLE_TOP_BUY` signal (an X column breaks above the previous X column) on the newest closed bar, while flat |
| Freshness | Never a signal at or before the watermark (set to the last closed bar when AUTO is armed, then to each handled signal), never one older than 180 s |
| Exit | Short: the first X column that starts after the entry bar. Long: the first O column. Reason `reversal` |
| After an exit | A later opposite signal may open the other side (never on the same tick as the exit) |
| Sessions | NSE: entries 09:15-15:00, flat at 15:15, NSE holidays from `lib/nseHolidays`. MCX: entries until close − 30 min, flat at close − 10 min (`lib/mcxSession`) |
| Index charts | No AUTO (an index is not tradable) |
| Size | Lots per chart, default **1**, 1-20; product INTRADAY (MIS) |

## Orders (`app/api/straddle-pnf/order`)
- Entry: the same server-resolved order as the trade bar (`source: 'auto'` → Dhan correlation tag `pnfa`, Kotak per-source
  lot cap `pnfa: 20`). A straddle sends CE then PE; if PE is refused, CE is reversed.
- Exit: `exitOwn` — per leg the units AUTO owns (from the ledger), capped by the broker's INTRADAY / MIS row in the
  direction being closed. Other products and other quantities on the same contract (a manual trade, the other chart) are
  never touched. A leg already flat at the broker is booked closed without an order.
- The exit always goes to the broker the position was opened on.

## Ledger (`lib/pnfAutoLedger.ts`, `debug/pnf_auto_state.json`)
One live row per chart. REAL: `entering` → `open` | voided; `open` → `exiting` → `closed` | back to `open` (cleanly refused).
An unknown outcome (no reply, 504, partial straddle) becomes `unknownEntry` / `unknownExit`, halts the chart and is **never
resent**; the user checks the broker and clicks *Is open* / *Is flat*. A reservation older than 60 s (the tab died with
the order out) is offered for the same resolution.

## Engine (`components/straddlePnf/usePnfAuto.ts`)
- Runs in the open page, leader tab only, 1 s tick. Closing the page stops it (exits included) — it is not a server worker.
- AUTO is never remembered across a reload; open rows are, and their exits keep running while AUTO is off.
- Entries pause on a stale feed, a missing price, an unresolved contract; 3 refused entries in a row halt the chart.
- Switching the page between PAPER and REAL disarms both charts. While a chart is armed or holds an AUTO position its
  instrument and box settings are locked, and chart 2 cannot be hidden.

## Known gaps
- No backtest / replay; P&L is at **decision prices** (the chart price at the decision), not broker fills.
- Two charts on the same contract net at the broker; each exits only its own units, capped by what the broker still shows.
- The whole-position SQUARE OFF in the trade bar closes AUTO's units too; AUTO then finds the leg flat and books it closed.
