# P&F AUTO — double-bottom SELL / double-top BUY, exit on the first column reversal

> User-facing guide for the Renko page (rules, guard, server watcher, limits): [docs/RENKO_AUTO_GUIDE.md](../../docs/RENKO_AUTO_GUIDE.md).

> [!warning] UNVALIDATED
> There is no backtest or replay of these rules yet. Run it in PAPER first. REAL is armed with a second, explicit click
> (a saved REAL arming resumes after a reload only once the page is switched to REAL), and every REAL order is reserved in the ledger before it is sent.

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
| Sessions | Entry cutoff (changed 2026-11-03; it was 15:00 NSE / close − 30 min MCX): NSE 10 minutes before the end-of-day exit; MCX **10 minutes before the market close**, the same minute as its exit. NSE: entries 09:15-15:05, flat at 15:15 (a stock with derivatives from 2026-08-03, NSE's Closing Auction Session: flat at 15:10, entries until 15:00, before continuous trading stops at 15:15), NSE holidays from `lib/nseHolidays`. MCX: flat at close − 10 min and entries until close − 10 min (23:45 / 23:45 on a 23:55 close; `lib/mcxSession`) |
| Index charts | No AUTO (an index is not tradable) |
| Size | Lots per chart, default **1**, 1-20; product MIS (INTRADAY, default) or NRML (MARGIN), per chart, saved on the arm and the row. NRML: NSE flat at **15:35**, entries until 15:25 (5 min before an earlier close if the market has one); MCX unchanged; a stock is MIS only (added 2026-11-05) |
| Prices | Every entry and exit is tied to a **confirmed box**: the entry to the deepest box the signal bar drew (the O column's lowest box at the break for a SELL, the X column's highest for a BUY), the exit to the box the reversal column reached on its first bar (`boxPriceAt`). PAPER books those box prices; REAL books the live price at the decision (a market fill) and keeps the boxes for its markers. An EOD exit has no box event: it books the live price |

## Orders (`app/api/straddle-pnf/order`)
- Entry: the same server-resolved order as the trade bar (`source: 'auto'` → Dhan correlation tag `pnfa`, Kotak per-source
  lot cap `pnfa: 20`). A straddle sends CE then PE; if PE is refused, CE is reversed.
- Exit: `exitOwn` — per leg the units AUTO owns (from the ledger), capped by the broker's row of the row's own product (MIS, or NRML for an NRML row) in the
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
- The AUTO switch is saved in the ledger (`arms`, op `setArm`) and resumed after a reload / rebuild / in another tab by
  `lib/pnfAutoArm.ts` `resumeArm`: same IST day, contract, broker and page mode (the page loads in PAPER, so a REAL arming waits for the
  switch to REAL), never after a server-guard exit; the watermark is the newer of the arming's and the chart's last AUTO entry bar. Every
  switch-off is a `setArm null` with its reason in the log, and every tab follows it. Open rows keep exiting while AUTO is off; such a row
  shows *AUTO OFF · exit only* and its exit logs "no re-entry" (a silent reload-disarm caused missed flips on 2026-11-04).
- Entries pause on a stale feed, a missing price, an unresolved contract; 3 refused entries in a row halt the chart.
- Switching the page between PAPER and REAL disarms both charts. While a chart is armed or holds an AUTO position its
  instrument and box settings are locked, and chart 2 cannot be hidden.

## Known gaps
- No backtest / replay. PAPER P&L is box-to-box; REAL rows start at **decision prices** (the chart price at the decision) and are then re-priced to the broker's
  average traded price once their orders are final (`fillPrice` op, 2026-11-04); until then, or if an order never reports final, the decision price stands.
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

## Server-side exit watcher (added 2026-11-04)
The tab runs AUTO, so a closed or sleeping tab used to leave an open REAL position with no stop. `lib/autoServerWatcher.ts` (started from
`instrumentation.node.ts`, idle until a guard is synced) now enforces the page's MTM guard levels - target, **stop-loss**, trailing, protect
profit, in rupees or boxes - on every open REAL AUTO row from the dashboard SERVER, with the tab closed. It places **no entries** and runs no
strategy rules (the opposite-brick exit stays in the tab): exits and the guard only.
- The page syncs each chart's guard (`POST /api/straddle-pnf/server-guard`, file `debug/auto_server_guards.json`: levels, broker, mode, box size).
  A page reload adopts a guard the server still holds, so the card shows what is enforced.
- A row is measured from its OWN entry price (`lib/autoServerGuard.ts`, tested); only rows of the synced broker and mode, REAL and `open`.
- Prices: the same bridge as the page (`lib/pnfLiveBridge.ts`); no live price for a leg = the watcher pauses on that row and logs it.
- A trip is a normal ledger exit: `beginExit` under the ledger lock (first taker owns the exit, so a page and the server cannot both send),
  then the `exitOwn` order (`lib/pnfOrderExec.ts`, shared with the order route), then `close` / `markUnknown` / `abortExit`. An unknown outcome is
  never resent. A closed row's reason is `server guard: <rule>`; an open tab disarms AUTO when it sees one.
- Measured like the page's guard: from the entry price when the guard was on first, from the row's P&L at the moment it was switched on
  otherwise. A row from an earlier day is reported, never exited. At the market's end-of-day time the watcher squares a guarded row off
  too, and (since 2026-11-04) squares off every open REAL row at the end-of-day time even with the guard off; with no live price (every leg must have ticked within 10 min) a guard pauses and logs, an end-of-day exit goes ahead at the entry price.
- A rejected exit is retried every 10 s, and after 5 failures the watcher stands down for a minute and says so. A ledger write that fails after
  an order went out is queued and retried, never dropped. A page that switches its guard off stops an exit already queued.
- A mode / broker switch removes a chart's server guard only when that chart holds no AUTO position; a server guard held for another broker or mode
  than the page opened in is announced with a "Switch it off" button, never left enforcing unseen.
- NOT covered: a tab-less re-entry never happens (no entries), the rule exit (opposite brick / Two-back stop) still needs the tab, and the
  watcher only protects what the guard's levels describe - with the guard OFF there is no server stop.

## Renko pyramid: `+1L/brick` (added 2026-11-05)
Opt-in per chart on `/renko` (not P&F, not Replay). User guide: `docs/RENKO_AUTO_GUIDE.md` §4 "Adding lots on new best bricks".
- Rule `decideAdd` (`lib/pnfAuto.ts`, tested): one lot when the newest closed bar has a favourable brick closing beyond the best favourable
  close since entry (starting from `entryBox`). One add per bar, never for an older bar, inside the entry window, up to `min(row.pyramidMax, page Max, 20)`.
  Evaluated only when `decideAuto` says holding (an exit always wins), only while armed in the row's mode with the switch on.
- Ledger: one row per position. `entryPrice` is the AVERAGE and `lots` / `unitsPerPoint` / `legs[].units` are TOTALS (`withTranches`), so every
  P&L reader and every exit (`exitOwn` units) is unchanged. `base` = the first tranche and `adds[]` = the tranches. REAL: `beginAdd` (open →
  `adding`) → `confirmAdd` (must match the reserved units exactly) | `voidAdd` | `markUnknown` (→ `unknownAdd`) → `resolve added|notAdded|flat`.
  PAPER: `addPaper`. `beginExit` needs `open`, so an exit waits for an add on the wire. `fillPrice which:'add'` re-prices one tranche, and the entry fill re-prices `base`.
- Decision 2026-11-05 (user): new-best-brick only (no re-adding after a pullback), user-set Max, at most one lot per bar.
- Review fixes (2026-11-05): the server's `exitRow` sizes from the row re-read after `beginExit` (never the tick snapshot); `reservedByAuto`
  counts a pending add's units; a stuck add (> 60 s) is exited by the server with `beginExit withPendingAdd` (confirmed + pending units capped
  by the broker, `close.pendingAdded` settles it; `abortExit` restores the add state), except when a sibling live REAL row holds the same
  contract at that broker. Adds need `complete` history and the page broker, run the entry's contract checks, and retry a not-sent failure up to 3 times per bar.

