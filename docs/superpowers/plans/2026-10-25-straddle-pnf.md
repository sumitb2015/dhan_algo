# Straddle Point & Figure Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/straddle-pnf` Scalping page showing three live NIFTY straddle Point & Figure charts (ATM-200, ATM, ATM+200) with VWAP/SMA10, double-top-buy / double-bottom-sell markers, audio + visual alerts and a 30-entry alert log.

**Architecture:** A pure TypeScript engine (`lib/straddlePnf*.ts`) builds P&F columns, overlays and signals from 1-min straddle bars. A new Python fetcher returns multi-session CE/PE bars; a thin API route serves them. The page folds live ticks from the existing `useLiveOptionsWS` hook into the open minute. Signals-only: no order code.

**Tech Stack:** Next.js (App Router, read `node_modules/next/dist/docs/` first — breaking changes), React, TypeScript, `node --test` for `lib/*.test.ts`, Playwright (mocked `/api/*`), Python 3 + `DhanHelper`.

**Spec:** `docs/superpowers/specs/2026-10-25-straddle-pnf-design.md`

## Global Constraints

- Box = 0.5% of the straddle price at the start of the loaded history, fixed thereafter; reversal = 3 boxes; X green (up), O red (down).
- Straddle = CE close + PE close per 1-min bar; signals evaluate on closed bars only; one alert per `(strike, column index, kind)`.
- Strikes fixed at page load (ATM from spot, offsets -200/0/+200 for NIFTY, step 50); a Re-center button reloads. No auto-roll.
- Expiry dropdown: max 4 (upcoming weekly, next weekly, this monthly, next monthly), deduplicated.
- History = last 3 sessions of 1-min bars for the same contract; dotted date dividers.
- Signals only — no order route, no `--live` anything.
- No hardcoded colours: zinc ramp / tokens; modal/backdrop `bg-oncolor-dark/NN`; no slash-opacity on neutral text; table-free page, but headers follow `dhan-page-theme` (header icon tile, `DataChip` fed by the payload's own session date).
- Sound via `lib/alertSound.ts` only (`installAlertSoundUnlock`, `playEntryChime` / `playExitChime`); leader tab only.
- Never start a second `next dev`; e2e runs with `E2E_PORT=3000` while the dashboard is up.
- localStorage reads/writes wrapped in try/catch.

## Review Focus

- Flat/zero straddle bars (missing leg = 0) must not create columns or a divide-by-zero box → test in Task 1.
- A price gap larger than several boxes in one bar must fill every box and still reverse correctly → Task 1.
- Page reload mid-session must not re-alert for already-closed bars → Task 4 (`newSignalsSince`).
- Expiry list with fewer than 4 qualifying dates, or a weekly that is also the monthly → Task 3.
- Market closed / no live ticks: last session renders with a STALE chip and raises no alerts → Task 5 e2e.

---

### Task 1: P&F engine

**Files:**
- Create: `rs_dashboard/lib/straddlePnf.ts`
- Test: `rs_dashboard/lib/straddlePnf.test.ts`

**Interfaces:**
- Produces:
  - `type Bar = { t: number; ce: number; pe: number; straddle: number; vol: number }` (`t` = epoch seconds, `vol` = CE vol + PE vol, 0 if absent)
  - `type PnfColumn = { dir: 'X' | 'O'; low: number; high: number; boxes: number; startBar: number; endBar: number; session: string }` (`low`/`high` are box edges in price; `boxes` = glyph count; `session` = IST `YYYY-MM-DD` of the bar that opened the column)
  - `type PnfSignal = { id: string; kind: 'DOUBLE_TOP_BUY' | 'DOUBLE_BOTTOM_SELL'; col: number; bar: number; t: number; price: number; belowVwap: boolean }`
  - `buildPnf(bars: Bar[], boxPct = 0.005, reversal = 3): { box: number; columns: PnfColumn[] }`
  - `detectSignals(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): PnfSignal[]` — `id = \`${kind}:${col}\``
  - `vwap(bars: Bar[]): (number | null)[]` — cumulative Σ(straddle·vol)/Σvol across the loaded range; falls back to cumulative mean of straddle when Σvol = 0; `null` until first usable bar
  - `sma(values: number[], n = 10): (number | null)[]`
  - `exitTags(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): { col: number; bar: number }[]` — a green X column whose closing bar's straddle is above VWAP
  - `sessionOf(t: number): string` — IST date

- [ ] **Step 1: Write failing tests** (`straddlePnf.test.ts`, `node:test`): `box = 0.5% of bars[0].straddle`; a rise of 1 box prints one X; a fall of exactly 2 boxes after an X column does NOT reverse, a fall of 3 boxes does and starts an O column one box below the X top; price path `100,101,102,101,100,99,98,99,98,97` produces the expected column list and exactly one `DOUBLE_BOTTOM_SELL` on the second O column breaking the first's low (spec values: box 0.5, reversal 3); mirror path gives `DOUBLE_TOP_BUY`; signal `id` stable across re-runs on a longer bar array (no duplicate id for already-closed columns); `belowVwap` true only when `price < vwap` at that bar; `exitTags` fires for a green X closing above VWAP; `vwap` volume-weighted and cumulative-mean fallback; `sma` first 9 values null. Review-Focus tests: bars with `straddle = 0` are skipped (no column, no NaN box); a single bar jumping 5 boxes fills 5 boxes in one column.
- [ ] **Step 2: Run** `cd rs_dashboard && node --test lib/straddlePnf.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the signatures above in `lib/straddlePnf.ts`. Close-only construction: box edges are multiples of `box` anchored at `bars[0].straddle`; round toward the direction of travel. Skip bars with `straddle <= 0`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `git add rs_dashboard/lib/straddlePnf.ts rs_dashboard/lib/straddlePnf.test.ts && git commit -m "feat(straddle-pnf): point & figure engine with VWAP/SMA and double top/bottom signals"` (end message with the attribution line from the session reminder).

---

### Task 2: Multi-session straddle bar fetcher

**Files:**
- Create: `scripts/tools/straddle_pnf_candles.py`
- Test: `tests/test_straddle_pnf_candles.py`

**Interfaces:**
- Consumes: `_fetch_leg` and `_ts_col` from `scripts/tools/options_straddle_candles.py` (import it as a module; do not modify it); `DhanHelper.find_option`, `get_dhan_client` exactly as that script uses them.
- Produces: CLI `--underlying NIFTY --expiry YYYY-MM-DD --strikes 24000,24200,24400 --sessions 3`; one stdout JSON line `{ "expiry", "bars": { "<strike>": [{t, ce, pe, straddle, vol}] }, "errors": { "<strike>": "msg" } }` or `{ "error": "..." }`. `t` = epoch seconds. Pure helper `merge_legs(ce_df, pe_df, sessions) -> list[dict]` (inner-joins on timestamp, keeps the last `sessions` distinct IST dates, drops rows where either close ≤ 0).

- [ ] **Step 1: Write failing test** — stub DataFrames (epoch-second `start_Time`, `close`, `volume`) across 4 IST dates; assert `merge_legs(..., 3)` returns only the last 3 dates, `straddle == ce + pe`, `vol == ce_vol + pe_vol`, rows with a zero leg dropped, `t` ascending.
- [ ] **Step 2: Run** `venv/bin/python tests/test_straddle_pnf_candles.py` (project venv on this box) → FAIL.
- [ ] **Step 3: Implement** `merge_legs` and `main()`: resolve CE/PE per strike, one `_fetch_leg` per leg over `today - (sessions*3 + 4)` days (covers weekends/holidays), strikes fetched sequentially with a short sleep (rate limit), a failing strike goes in `errors` rather than aborting.
- [ ] **Step 4: Run** the test → PASS. Read-only: do not run `main()` against the live account as part of the test.
- [ ] **Step 5: Commit** `feat(straddle-pnf): multi-session straddle bar fetcher`.

---

### Task 3: API route + expiry picker

**Files:**
- Create: `rs_dashboard/lib/straddlePnfExpiries.ts`, `rs_dashboard/lib/straddlePnfExpiries.test.ts`, `rs_dashboard/app/api/straddle-pnf/route.ts`

**Interfaces:**
- Consumes: `runPythonJson`, `dedupe`, `PROJECT_ROOT` from `@/lib/pyExec`; the script from Task 2; existing `GET /api/options/expiries?underlying=NIFTY` (`{ success, data: string[] }`, ISO dates).
- Produces:
  - `pickExpiries(all: string[], today: string): { value: string; label: string; kind: 'weekly1' | 'weekly2' | 'monthly1' | 'monthly2' }[]` — weeklies = the two nearest ≥ today; monthly = the last expiry in a calendar month; this monthly = that of today's month if ≥ today, next monthly = following month; drop duplicates (a weekly that is also a monthly keeps the weekly slot and the next distinct monthly fills in); max 4; label `"22 Oct · Thu"`.
  - `GET /api/straddle-pnf?underlying=NIFTY&expiry=YYYY-MM-DD&atm=<number|auto>` → `{ success, atm, strikes: number[], bars: Record<string, Bar[]>, errors, dataDate }`. `atm=auto` derives ATM from the latest spot (use the same spot source as `app/api/options/spot/route.ts`) rounded to 50. `strikes = [atm-200, atm, atm+200]`. Rejects non-NIFTY with 400 (this cycle). `dataDate` = IST date of the last bar. Response cached 20 s per key; `dedupe`d.

- [ ] **Step 1: Write failing tests** for `pickExpiries`: normal week (2 weeklies + 2 monthlies); the nearest weekly is also the month's last expiry (no duplicate, still ≤ 4, next monthly appears); fewer than 4 qualifying dates returns what exists; `today` after this month's monthly rolls "this monthly" to next month (Review Focus).
- [ ] **Step 2: Run** `node --test lib/straddlePnfExpiries.test.ts` → FAIL.
- [ ] **Step 3: Implement** `pickExpiries`, then the route (validate `expiry` as `YYYY-MM-DD`, `atm` as number or `auto`, return 400 otherwise; run the script with `--strikes`, 60 s timeout).
- [ ] **Step 4: Run** the unit test → PASS. Then with the dashboard up on :3000, mint a session cookie (the auth proxy returns 401 without one) and `curl` the route once with `atm=auto`; expect `success:true` and three strike keys, or a clear error JSON when the market data is unreachable.
- [ ] **Step 5: Commit** `feat(straddle-pnf): expiry picker and /api/straddle-pnf`.

---

### Task 4: Live-tick folding and new-signal detection

**Files:**
- Create: `rs_dashboard/lib/straddlePnfLive.ts`, `rs_dashboard/lib/straddlePnfLive.test.ts`

**Interfaces:**
- Consumes: `Bar`, `PnfSignal` from Task 1.
- Produces:
  - `foldTick(bars: Bar[], tick: { t: number; ce: number; pe: number }): { bars: Bar[]; closedIndex: number | null }` — within the same IST minute updates the last bar's close; on a new minute appends a bar and reports the index of the bar that just closed; ticks with `ce <= 0 || pe <= 0` are ignored.
  - `newSignalsSince(signals: PnfSignal[], seen: Set<string>, firstLiveBarT: number): PnfSignal[]` — signals whose `id` is not in `seen` AND whose bar time ≥ `firstLiveBarT` (history never alerts).
  - `capLog<T>(log: T[], entry: T, max = 30): T[]` — newest first.

- [ ] **Step 1: Write failing tests**: tick in the same minute mutates only the last bar's close/straddle; next minute appends and returns the closed index; zero-leg tick ignored; `newSignalsSince` excludes seen ids and any signal older than `firstLiveBarT` (the reload-no-realert case); `capLog` keeps exactly 30, newest first.
- [ ] **Step 2: Run** `node --test lib/straddlePnfLive.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three functions (pure, no clocks — time arrives in the arguments).
- [ ] **Step 4: Run** → PASS; also run `npm test` once to confirm the whole lib suite is still green.
- [ ] **Step 5: Commit** `feat(straddle-pnf): live tick folding and alert de-duplication`.

---

### Task 5: Page, panels, alerts, sidebar, e2e

**Files:**
- Create: `rs_dashboard/app/straddle-pnf/page.tsx` (metadata title "Straddle P&F"), `rs_dashboard/components/StraddlePnfPage.tsx`, `rs_dashboard/components/straddlePnf/PnfPanel.tsx`, `rs_dashboard/components/straddlePnf/AlertLog.tsx`, `rs_dashboard/e2e/straddle-pnf.spec.ts`
- Modify: `rs_dashboard/components/Sidebar.tsx` (add a link in the `Scalping` group: `/straddle-pnf`, label "Straddle P&F", desc)

**Interfaces:**
- Consumes: Tasks 1, 3, 4; `useLiveOptionsWS(expiry, 'dhan', ['dhan'], 'NIFTY')` from `@/lib/useLiveOptionsWS` (`liveQuotes.spot`, `liveQuotes.future?.ltp`, `liveQuotes.strikes[<strike>]` CE/PE LTP); `DataChip` (`@/components/DataChip`); `installAlertSoundUnlock`, `playEntryChime`, `playExitChime`; `e2e/support.ts` mocks.
- Produces: `PnfPanel` props `{ title: string; strike: number; bars: Bar[]; overlay: 'vwap' | 'sma'; stale: boolean; flashId: string | null }`; `AlertLog` props `{ entries: LogEntry[] }` with `LogEntry = { id, t, strike, kind, price }`.

- [ ] **Step 1: Write the failing e2e spec** `e2e/straddle-pnf.spec.ts` with browser-side mocks for `/api/straddle-pnf`, `/api/options/expiries` and `/api/options/live` (copy the mocking pattern from an existing spec such as `e2e/algo-lab.spec.ts`; any non-GET not mocked must fail): asserts three panels visible side by side (equal-ish widths in one row), expiry dropdown has ≤ 4 options, VWAP↔SMA toggle changes the overlay legend, a mocked history that ends in a double bottom shows a red marker but **no** log entry (history never alerts), a live tick that closes a bar creating a double bottom adds exactly one log entry, and the DATA chip shows the mocked session date.
- [ ] **Step 2: Run** `cd rs_dashboard && E2E_PORT=3000 npm run test:e2e -- straddle-pnf` → FAIL (route missing).
- [ ] **Step 3: Implement** the page. Behaviour to wire: sticky header (icon tile, title, `DataChip`, index spot + future price, expiry select, VWAP/SMA toggle, Re-center, mute, log button); on mount and on expiry/Re-center fetch `/api/straddle-pnf`, build `buildPnf` per strike, overlay series from `vwap`/`sma`; fold ticks with `foldTick` into per-strike bars and recompute on `closedIndex`; compute `exitTags`; alert on `newSignalsSince(...)` using a `seen` ref and `firstLiveBarT` = first bar closed after load; sound only on the leader tab (use the BroadcastChannel/leader helper other pages use — find it with `grep -rn "leader" rs_dashboard/lib | head`); persist the log (last 30) and mute flag in `localStorage` (try/catch); `stale` when `dataDate` ≠ today IST or ticks older than 60 s. Panels are SVG, X/O glyphs sized to the box grid, date dividers where `session` changes, VWAP line yellow, SMA light neutral via a token, signal bars above the last 2 columns (green = buy, red = sell), a stronger outline on belowVwap double bottoms, an "EXIT" tag from `exitTags`, right-axis current-value tag. Add the sidebar link.
- [ ] **Step 4: Run** the same e2e command → PASS; run `npm test` and `npx tsc --noEmit` → clean.
- [ ] **Step 5: Verify in a browser** against the running dashboard on :3000 with a real session (read-only page): three panels render with history, expiry dropdown works, toggling VWAP/SMA works, header shows spot and future. Report any gap honestly; market-closed shows the STALE chip.
- [ ] **Step 6: Commit** `feat(straddle-pnf): live Straddle P&F page with alerts` (adds the page, components, sidebar link, e2e).
