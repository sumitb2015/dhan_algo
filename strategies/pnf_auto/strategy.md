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
| Sessions | NSE: entries 09:15-15:00, flat at 15:15 (a stock with derivatives from 2026-08-03, NSE's Closing Auction Session: flat at 15:10, before continuous trading stops at 15:15), NSE holidays from `lib/nseHolidays`. MCX: entries until close − 30 min, flat at close − 10 min (`lib/mcxSession`) |
| Index charts | No AUTO (an index is not tradable) |
| Size | Lots per chart, default **1**, 1-20; product INTRADAY (MIS) |
| Prices | Every entry and exit is tied to a **confirmed box**: the entry to the deepest box the signal bar drew (the O column's lowest box at the break for a SELL, the X column's highest for a BUY), the exit to the box the reversal column reached on its first bar (`boxPriceAt`). PAPER books those box prices; REAL books the live price at the decision (a market fill) and keeps the boxes for its markers. An EOD exit has no box event: it books the live price |

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
- No backtest / replay. PAPER P&L is box-to-box; REAL P&L is at **decision prices** (the chart price at the decision), not
  broker fills, so on a small box REAL can differ from PAPER by the boxes the price moved before the order.
- Two charts on the same contract net at the broker; each exits only its own units, capped by what the broker still shows.
- The whole-position SQUARE OFF in the trade bar closes AUTO's units too; AUTO then finds the leg flat and books it closed.

## Renko "Two-back" rule (`/renko`, per-chart rule picker next to AUTO)
Source: Definedge's Renko pattern library (Two Back Bullish / Bearish: >=3 trend bricks, a correction of exactly two opposite
bricks, then >=3 bricks in the trend direction). The stop-loss is from the strategy text supplied with the request; Definedge's
page gives no stop or target. UNVALIDATED, same as the other AUTO rules.

| Rule | Behaviour |
|---|---|
| Pattern (`twoBackSignals`, `lib/renko.ts`) | BUY: run of >=3 up bricks, then exactly 2 down bricks, then up bricks again; signal on the resumed brick that is the 3rd of the run **and** closes above the trend's last brick top (the swing high). SELL mirrors it |
| Stop | BUY: one brick below the pullback's low. SELL: one brick above the pullback's high. Stored on the signal and the ledger row (`stop`) |
| Exit | Live price touches the stop (PAPER books the stop level), or EOD. **No** first-opposite-brick exit and **no target**: a stop-based position rides the trend until stopped or flat at the cutoff |
| Everything else | Same entry freshness, watermark, sessions, sizing, REAL arming and ledger rules as above |

The rule is chosen per chart and locked while AUTO is armed or holds a position; it is not remembered across a reload.
Two-back signals are computed on every Renko chart (`model.twoBack`) but are not drawn as chart markers; trades appear as AUTO markers.

## Renko "One-back" rule (same picker)
Source: Definedge Renko library (One Back Bullish / Bearish, from Prashant Shah's Renko book): >=2 bricks in the trend, not more
than one opposite brick, then two bricks in the trend direction that trigger a swing breakout. Definedge gives no stop or target;
the stop and exit are the Two-back ones. UNVALIDATED.

| Rule | Behaviour |
|---|---|
| Pattern (`oneBackSignals`, `lib/renko.ts`) | BUY: run of >=2 up bricks, exactly 1 down brick, then up bricks; signal on the 2nd resumed brick **if it closes above the swing high** (the trend's last brick top). If the 2nd brick does not break it, the first resumed brick that does (still a run of >=2) signals. SELL mirrors |
| Stop / exit | As Two-back: one brick beyond the 1-brick pullback; exit on the stop touch or EOD, no target |

`twoBackSignals` and `oneBackSignals` share one detector (`backSignals`) parameterised by trend / pullback / resume lengths.

## Renko "N-brick (trend)" rule (same picker)
A state-based variant of N-brick: no reversal is needed first. `trendSignals` (`lib/renko.ts`) signals on EVERY brick that is the latest
of `Confirm` (N) consecutive same-colour bricks, so with N = 1 the next brick in a run you are already in is an entry. Same entry
freshness as every rule (the brick must have formed on the newest closed bar; one that formed earlier is never chased), same exit as
N-brick (first opposite brick, no stop, no target). After that exit the reversal brick itself satisfies the entry for the other side
(N = 1), so the chart flips straight into the new direction; with N >= 2 it waits for the Nth brick. Arming does not require a fresh
reversal, so the first brick after arming mid-run enters. UNVALIDATED. `model.trend`, not drawn as chart markers.
