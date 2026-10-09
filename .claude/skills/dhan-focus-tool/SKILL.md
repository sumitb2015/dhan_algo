---
name: dhan-focus-tool
description: Use when touching the Focus Tool (/focus-tool, "Ultimate Scalper Terminal — Straddles & Strangles") — rs_dashboard/components/FocusTool.tsx (Pro / Table / Cards row views), lib/focusToolRules.ts, focusToolRows.ts, focusToolUnderlyings.ts, useFocusMarketData.ts, useFocusToolWS.ts, scripts/tools/focus_tool_ws.py and app/api/focus-tool/*. A map of the page plus the conventions that cost a bug each time they were missed: where each underlying's live prices come from (CRUDEOILM is not on the focus WS), SL entered as a percentage but stored as a multiplier, the per-row strike step (MCX "100s only"), per-leg lots, the one-entry latch behind "Enter now" / per-leg "Re-enter", and the icon-button / aligned-levels UI rules. Real-money endpoint; read dhan-terminal-position-ownership (Invariant 11) first.
---

# Focus Tool — anatomy and conventions

A scheduled straddle/strangle terminal. Each **row** sells CE/PE at resolved strikes, with leg SL/target, pair stop,
re-entry, lazy legs, overall SL/target/trail. Rows + the fill ledger live in `debug/focus_tool_rows.json`
(`app/api/focus-tool/rows`). It executes **only in the open browser tab that is the leader**; a second tab shows the
banner "Focus Tool is open in another tab…" and fires nothing (manual buttons still work). Rows are SIM or REAL per row;
REAL also needs the daily LIVE · REAL MONEY arm. Ownership/safety rules: `dhan-terminal-position-ownership`
(Invariant 11) — ledger-owned legs, unconfirmed orders held, down-only reconcile. Do not re-derive them here.

## Files
| File | Owns |
|---|---|
| `components/FocusTool.tsx` (~9k lines) | The page, the scheduler, `placeLeg`, `autoEnterRow`, `armRow`, exits, re-entry, all three row views |
| `lib/focusToolRules.ts` (+`.test.ts`, `focusToolRules.cases.json`) | Pure rules: `evaluateEntry`, stop/target levels, `legLots`/`multipliedLots`, re-entry, trail. Parity with `tests/test_focus_tool_parity.py` |
| `lib/focusToolRows.ts` | `FocusRow` type (add new row fields here), fill ledger shape |
| `lib/focusToolUnderlyings.ts` | Per-underlying meta: `strikeStep`, `segment`, `unitsPerLot`, session windows, `FEED_BRIDGE_UNDERLYINGS`, `toInternalQty`/`orderQuantity` |
| `lib/useFocusMarketData.ts` | REST polling: expiries, lot sizes, lookups, **chains** (3 s client poll of `/api/options/chain`, itself 30 s cached) |
| `lib/useFocusToolWS.ts` + `scripts/tools/focus_tool_ws.py` (port 8965, via `market_data_hub`) | Tick feed for NIFTY / BANKNIFTY / SENSEX **only** |

Three row views — **Pro** (`FocusProRowImpl`, the legs grid), **Table** (`FocusTableRowImpl`), **Cards**. `FocusRowViewProps`
is derived from the Table impl's props; Cards declares its own prop type. A new row action therefore needs: the prop in
the Table type (`onX?`), the Cards type (else TS fails at the call site), the three `onX={…}` call sites, and the UI in
each view you care about. Polish so far is Pro-first; say which views you changed.

## Where live prices come from (the lag bug, 2026-10-09)
| Underlying | Option LTP / P&L source |
|---|---|
| NIFTY / BANKNIFTY / SENSEX | `focus_tool_ws.py` ticks → `focusWsQuotes[u]` |
| **CRUDEOILM** | **Not on the focus WS.** The shared `live_options_ws.py` bridge (one process per underlying, the Advanced Scalper's) via `useLiveOptionsWS(expiry,'dhan',['dhan'],'CRUDEOILM')`, adapted into `focusWsQuotes.CRUDEOILM` (`books[expiry]`, same shape as the others). |
| Fallback (any) | `chains` — REST chain: server-cached 30 s, `last_price` is a lagging snapshot (measured 4.7 % behind on MCX). Fine for strike lists, **wrong for stops and P&L**. |

Rules: the CRUDEOILM feed is **one expiry** (nearest unless every row sits on a later one) — rows on another expiry fall
back to the chain, with its lag. The page `POST`s `/api/options/live {action:'start'}` when the expiry is known and
**never stops it** on unmount (the Advanced Scalper shares it); a 60 s keep-alive restarts it **only if status is not
RUNNING/STARTING** (a start for a different expiry restarts the bridge, so two pages disagreeing would flap it). Quotes
older than `WS_STALE_MS` (8 s) are dropped so consumers fall back to the chain; a 1 s clock state re-evaluates that.
Check the feed: `debug/live_options_quotes_dhan_crudeoilm.json` `updated_at`, status file, and the bridge log
(`WS clients=N` shows the page connected). Prices that stop moving while the file is fresh = the page, not the bridge.

## SL and target units — one convention
- **Everything is typed as a percentage**: SL 20 = stop at 20 % above entry; Tgt 40 = exit 40 % below entry (unit chips:
  `% / pts / idx pts / idx % / Δ`). Overall SL (Total Premium %) already worked this way.
- **Storage is unchanged**: `ceSlMultiplier` / `peSlMultiplier` / `slMultiplier` stay multipliers (`'1.2'`), because the
  rules, the Python worker and the parity cases read them. Conversion is display-only: `slMultToPct` / `slPctToMult` and
  the `SlPctInput` wrapper over `RuleNumInput` (commit-on-blur — `dhan-commit-on-blur`). Never hand-write `1 + n/100`.
- A stored value is **never shown blank** (`'1'` shows `0`); a blank box means "off". Do not add a new SL input as a raw
  `RuleNumInput` on a multiplier field — the same field would then mean 20 in one view and 1.2 in another.
- Tooltips/labels say `SL %`, `Pair %`. The `×` wording survives only in internal comments and stored field names.
- A typed `1.4` in **Tgt %** is 1.4 %, i.e. ~2 premium points: it fires on noise, and with RE ASAP ×2 it re-sells and
  re-exits within seconds (seen live on CRUDEOILM). When a user reports "exits instantly", read the event log
  (`debug/focus_tool_events.jsonl`: `auto_exit_leg` `rule`/`reason` states the exact level) before touching code.

## Strike step is per row, not per underlying
`STRIKE_STEP[u]` is the exchange default (CRUDEOILM 50). **`rowStep(row)`** is the row's effective step: an MCX row with
`strike100` ("100s only" checkbox beside Link legs) uses 100. Use `rowStep(row)` for ATM rounding, shift, re-entry rolls,
lazy legs, range-open strike, and the payoff model. For premium/delta/criteria picks, `rowLive` also filters the chain to
`strike % 100 === 0` (otherwise the step is honoured by ATM mode only). The index group bar's ATM uses the first row's
step. Adding another per-row strike rule = extend `rowStep` and the `rowLive` chain filter, not a new constant.

## Lots and quantity
Per-leg lots: `row.ceLots` / `row.peLots` (undefined = both legs use `row.lots`); read through `legLots(row, leg)` and
`multipliedLots(row, …)` — never `row.lots` directly. The Pro/Table `RowLotsControl` has the "Per leg" switch. MCX: the page
works in **barrels** internally (`toInternalQty`), orders go out in **lots** (`orderQuantity`); `LegOpenBadge` takes the
row's `lotSize` and shows **lots only** ("S 5 LOTS @ 169.61", barrels in the tooltip; falls back to raw qty when the
quantity is not a whole number of lots). Pass `lotSize` to every new `LegOpenBadge`.

## Manual entry: "Enter now" and per-leg "Re-enter"
- The scheduler enters a row once: `autoEnteringRef` is a **one-entry latch** set in `autoEnterRow` and cleared only on a
  failed entry or by `armRow` (which also clears `fill`, the overall re-entry counters and `overallReMode`). A row can
  therefore read ARMED and flat yet never enter — Disarm→Arm was the only escape.
- **Enter now** (row header, only when the row is flat): refuses if `busyRows`/`autoExitingRef` hold the row or an entry
  started <15 s ago (`lastAutoEntryAtRef`), confirms for REAL rows, calls `armRow`, then **polls `schedulerRef` until the
  row is `armed` with no fill** (≤3 s) before `autoEnterRow` — a fixed timer both double-entered (latch wiped mid-entry) and
  silently skipped (state not landed).
- **Re-enter** (per flat leg, icon button replacing Exit): `placeLeg(row, leg, {reduce:false, lots: multipliedLots(row,
  legLots(row, leg))})` through `runRowAction`; **first clears that leg's `cePending`/`pePending`** (a waiting momentum /
  range / cost re-entry would sell it again → doubled short). Confirm for REAL.
- Both go through `placeLeg`'s own SIM / LIVE · REAL MONEY guard. Never bypass it.
- `armRow` also toasts when the row's overall trail is invalid (`overallTrailInvalid`: "by" > "every" is ignored by
  `evaluateOverallExit`) so a silently disabled trail is not discovered mid-trade.

## UI conventions (see `dhan-terminal-polish`, `dhan-a11y-controls`)
- Row-level and per-leg **Exit all / Exit / Re-enter are icon-only** (`ShieldOff`, `LogOut`, `RefreshCw`) with `aria-label`
  and a `title` that says what it does and why it is disabled (`tradeBlockedWhy`). Part-exit is one **`%` dropdown**
  (Exit 25/50/75 %, items disabled when the % rounds to zero lots), not three chips.
- `LegSlLevels` with `inline` (Pro table cell) is a fixed-min-width right-aligned column so stop/target levels line up row
  to row; the non-inline form (cards) stays centred/left. Keep new level spans as one line each.
- Header chips and cells use the zinc/emerald/rose tokens only (`dhan-theme-tokens`).

## Testing and verifying
- `cd rs_dashboard && npx tsc --noEmit -p . && node --test lib/focusToolRules.test.ts lib/focusToolUnderlyings.test.ts lib/focusToolLegLots.test.ts lib/focusToolSimulated*.test.ts lib/focusToolPnl.test.ts` (`focusToolRules` + `focusToolUnderlyings` alone: 138 pass at 2026-10-09), plus `python -m pytest tests/test_focus_tool_parity.py` when a rule changed.
- In the browser the dev data may contain a **real REAL-money row with an open position** and another tab may be the leader.
  Look, scroll, open menus; **do not click Exit / Enter now / Re-enter / + on a REAL row**. Prove behaviour on a SIM row.
- A hot-reloaded page keeps old state: reload after changing prop wiring. Phantom 404s: see CLAUDE.md (stale Turbopack cache).

## Change checklist
- New `FocusRow` field → `lib/focusToolRows.ts`, its default in the create/reset paths (three "reset rules" literals in
  `FocusTool.tsx`), the server merge if it is list-like, and a test.
- New order path → `placeLeg` only; sequential legs; a BOTH row that fills one leg is naked (the retry/toast in `autoEnterRow`).
- New price consumer → read `focusWsQuotes` first and the chain second (`pick(ws, chain)`); never the chain alone for a stop.
- Past review findings worth remembering: latch + timer races, stale pending re-entries, blank-looking stored values, a
  per-row rule applied to ATM but not to the chain filter, fixed-delay "wait for state".
