---
name: dhan-auto-strategy-terminal
description: Use when building a new dashboard page that runs an automated (auto-entry/auto-exit) intraday trading strategy in the browser together with its own backtest tab, porting a strategy idea into a "live terminal + backtest" page like /breakdown-scalper, adding a backtest to an existing auto-trading page, or debugging one - an engine that double-enters or stalls, a stop that never fires, an exit sent twice, two tabs both trading, a backtest whose P&L does not match live behaviour, a backtest that looks too good (look-ahead, cold indicators), or a runner that spawns twice or cannot be stopped. Reference implementation is the Breakdown Auto-Scalper. Not for Python strategies under strategies/ (dhan-new-strategy) or manual order tickets (dhan-order-tickets).
---

# Automated strategy terminal + backtest (dashboard)

A page that **trades by itself from an open browser tab** (Live tab) and **replays its own rules over history**
(Backtest tab). The whole design rests on one idea: **the rules exist once, as pure functions, and both the live
engine and the backtest simulator call them.** Everything else is plumbing that keeps the live side safe with real
money and the backtest side honest.

Reference implementation: `/breakdown-scalper?tab=backtest` — copy its structure, not its strategy.

## Start here for a NEW strategy: Algo Lab (`/algo-lab`)

The invariants below are already implemented generically in **Algo Lab** — a new automated strategy is one module
there, not a new page. Read `strategies/algo_lab/README.md`, then:

1. spec `strategies/algo_lab/<key>.md`;
2. `rs_dashboard/lib/algoLab/strategies/<camelKey>.ts` exporting a `StrategyDefinition` (`lib/algoLab/types.ts`):
   `schema`/`defaults` (drives the rules drawer, server validation and the backtest rules stamp), `warmupBars`,
   `gate`, `scan`, `onEntry`, `manage`, `columns.scanner` — copy `vwapMomentumBuyer.ts`;
3. register it in `lib/algoLab/registry.ts`; tests beside it (`npm test` includes `lib/algoLab/**`).

What the strategy may NOT do (the framework owns it): read a forming bar (ctx has closed bars only), loosen a stop
(`stepPosition` clamps), skip the stop check, size orders, touch caps / locks / EOD / loss limits, or read the index
high/low (`ctx.spotBars1m` is close-only in both modes). Live and backtest share `stepPosition`
(`lib/algoLab/engineStep.ts`), so a change to exit logic is a change to both. v1 is single-leg (`legs[]` length 1),
NIFTY-only in the backtest. Build a separate page only when a strategy needs what the framework does not have
(multi-leg, another underlying's data, multi-day) — then extend the framework rather than fork it where possible.

## Files of the reference implementation

| Layer | File | Owns |
|---|---|---|
| Rules (pure) | `rs_dashboard/lib/breakdownScalper.ts` (+`.test.ts`) | `evaluateOptionBreakdown` (signal on closed bars), `evaluateUnderlyingTrend` (gate), `rankBreakdownSignals` (pick), `evaluatePositionRisk` (SL/trail/target/recovery) |
| Ledger (pure) | `lib/breakdownLedger.ts` (+`.test.ts`) | Position/config/log types, `DEFAULT_CONFIG`, `sanitizeConfigPatch`, `normalizeConfig`, `applyOp` (op-based mutations, down-only ratchet, duplicate-contract 409) |
| Ledger route | `app/api/breakdown-scalper/state/route.ts` | GET file; POST one op, serialised by a promise chain, atomic tmp+rename write to `debug/<key>_state.json` |
| Live engine | `components/BreakdownScalper.tsx` | Feeds, bars, 1 s engine tick, entries/exits, halts, tab lock, exit marks, tabs (`?tab=`) |
| Live UI | `components/breakdownScalper/*` | `MarketBiasStrip`, `ScannerGrid`, `PositionsTable`, `RulesConfigDrawer` + `RuleNumInput` (commit-on-blur), `AuditLogPanel`, `BreakdownDocModal` |
| Simulator (pure) | `lib/breakdownBacktest.ts` (+`.test.ts`) | `simulateDay`, `exitOf`, `orderCost`/`DHAN_OPTION_COSTS`, `backtestConfigKey`, `sessionsToHold`, `summarize`, `auditResults` |
| Runner | `rs_dashboard/scripts/breakdown-backtest.ts` | Detached Node process: run.lock (O_EXCL, pid), status.json, stop.trigger, per-day atomic append to `results.json`, audit at the end |
| Data | `scripts/tools/breakdown_backtest_data.py` | One session of 1-min bars (+ previous session for warm-up) from Dhan-only sources; last stdout line is JSON |
| Backtest route | `app/api/breakdown-scalper/backtest/route.ts` | GET results+status+missing+`rulesChanged` (`?known=` skips resending days); POST catchup / rerun / stop |
| Backtest UI | `components/breakdownScalper/BacktestPanel.tsx`, `BacktestAuditReport.tsx` | KPIs, equity curve, day-wise trade log, weekday filter, CSV, audit card |
| Spec | `strategies/breakdown_scalper/strategy.md` | Rules, parameters, live-order behaviour, backtest fill model and known biases |

## Architecture

```
            ┌──────────────── lib/<name>.ts  (PURE RULES, unit-tested) ────────────────┐
            │ gate(underlying) · signal(bars, closed only) · rank(candidates) · risk(pos)│
            └───────────────┬──────────────────────────────────────┬──────────────────┘
       Live tab (browser)   │                                      │  Backtest (detached Node)
  feeds → bars → 1 s tick ──┘                                      └── simulateDay(bars, config)
  leader tab only │                                                         │
  orders → /api/scalper/fast-order | kotak/order          runner → results.json (+audit)
  ledger ops → /api/<name>/state  (debug/<name>_state.json) ← config read by → runner
```

The **ledger file's `config` is the single rules source**: the live engine reads it, the backtest runner reads it,
and `backtestConfigKey(config)` stamps every result set with the rules it used.

## Build order

1. **Spec first**: `strategies/<name>/strategy.md` — rules, parameter table with defaults/ranges, execution modes.
2. **Pure rules module + tests.** No `Date.now()`, no fetch, no React; time is passed in (`nowIstMs`). Signals use
   **closed bars only**; freshness (prev bar did not qualify) and a max signal age are part of the rule.
3. **Ledger module + route + tests** (op-based, see invariants L1-L5).
4. **Live page**: feeds → bar merge → scanner display → engine tick → orders. SIM mode works end to end first.
5. **REAL mode**: order routing per broker, outcome classification, exit marks, halts (invariants E1-E12).
6. **Simulator + tests** calling the *same* rule functions; then data script, runner, route, panel.
7. **Audit** (`auditResults`) and the spec's "backtest" section listing every known live/backtest difference.
8. Register: Sidebar link, `lib/releaseNotes.ts` aliases, fast-order `SOURCE_QTY_CAPS` / Kotak `SOURCE_LOT_CAPS`
   entry for the page's `source` code (rejected, never clamped).

## Ledger invariants (server)

- **L1** One route, one file, mutations as **ops** (`open`, `close`, `updateLowsAndSl`, `setConfig`, `setMode`,
  `addLog`, `resetSim`) applied by a pure `applyOp`. Never let the browser PUT a whole file.
- **L2** Writes serialised in-process (promise chain) and atomic (tmp + rename). Every op bumps `rev`.
- **L3** Client accepts only a **newer `rev`** from polls (`j.rev > prev.rev`) so a slow GET cannot roll back a
  mutation's reply.
- **L4** Server enforces the safety properties itself: duplicate open contract → 409; stops and low-water marks are
  **down-only** (`Math.min` with stored) whatever the client sends; config patches are sanitised and bounded
  (`MAX_LOTS_PER_TRADE`, HH:MM, `entryStart < entryEnd < eodExit` checked only when a time key is in the patch, so an
  engine-halt write is never refused for an unrelated reason).
- **L5** SIM and REAL rows share the file but are separated by `mode`; P&L, caps and the loss limit count **today
  (IST) and the active mode only**.

## Live engine invariants (browser)

- **E1 One stable interval.** The tick function is rebuilt every render and called through a ref
  (`engineRef.current = runEngine` in an effect without deps; `setInterval(() => engineRef.current(), 1000)` once).
  An effect with the engine's dependencies restarts on every quote (20-40 Hz) and never fires.
- **E2 Leader tab.** `localStorage` lock `{id: viewerId, at}` refreshed each tick, TTL ~5 s, released on unmount.
  Non-leaders compute the scanner for display and return before stops/entries. Storage blocked ⇒ single-tab assumption.
- **E3 Chain scoping.** Quotes, bars, candidates and lot/security-id lookups are tagged with `underlying|expiry`
  (and broker); anything from another selection is dropped. Reset caches on selection change.
- **E4 Chain pin.** While today's positions are open the underlying/expiry selectors lock, and a reload jumps to
  their chain (stops are only evaluated on the chain on screen). Show off-chain open rows as **unwatched**.
- **E5 No fake prices.** Missing quote ⇒ the stop is not evaluated (log once); never substitute the entry price.
  The **EOD cutoff exits even without a quote** (MARKET order, books last seen price).
- **E6 Staleness gates entries, never exits.** Feed age > 10 s, trend age > 45 s, lot size not resolved for *this*
  selection ⇒ no entry, with a visible reason (`engineNote`).
- **E7 Pick = best-ranked candidate passing every rule** (side cap, re-entry lock, cooldown). Mark locked contracts
  ineligible in the scanner — trying only the top-ranked one stalled entries for 5 minutes.
- **E8 Order outcome is tri-state** (`ok` / `failed` / `unknown`): network error or 504 is `unknown`, never `failed`.
  Idempotency key `entry_<posId>` / `exit_<posId>`.
- **E9 Exit marks in `localStorage`** per position (`inflight` with TTL > fast-order worst case, `exited` = order
  accepted but ledger close pending → retry the ledger only, `unknown` = never resend automatically; the user resolves
  it from the order book with Close). Plus a same-tab in-flight set.
- **E10 Halts.** Unknown entry, order placed but ledger `open` refused, N consecutive rejects, daily loss limit ⇒
  `haltEngine()`: sets an in-tab suppress ref **and** writes `engineActive:false` (entries stop even if the write
  fails); cleared only by the user toggling the engine.
- **E11 Daily loss limit** = today's realized (active mode) + open P&L of every open row of that mode; a row that
  cannot be priced pauses entries rather than trading on a partial total.
- **E12 Ledger rows from an earlier IST day** are flagged once and left for a manual close (INTRADAY is squared off
  by the broker).
- **REAL mode**: Dhan by security id + segment per underlying (`BSE_FNO` for SENSEX); Kotak by trading symbol via its
  own route; brokers outside the allow-list are SIM-only. Page broker via `usePageBroker`; wait for `brokerLoaded`.
- Ledger stores the **decision LTP**, not the broker fill — state this in the spec; for fill-accurate P&L see
  `dhan-fill-price-pnl`.

## Backtest invariants

- **B1 Same functions as live.** `simulateDay` imports the rule functions; never re-implement a rule in the simulator.
  Constants the live page holds (re-entry lock, max signal age, buildup thresholds) are mirrored with a comment naming
  their live source.
- **B2 Fill model** (state it in the spec and test each branch): signal from bars closed **before** minute m; entry
  at bar m's **open** (− slippage); inside each bar walk O → H → L → C (adverse first for a short; entry bar starts at
  H); every fill lies on the segment between the previous and current price point (level crossed ⇒ fill at level,
  ratcheted stop below price ⇒ fill at price, gap at open ⇒ fill at open); EOD at the cutoff bar's open. With several
  exits triggered at one point, the one the price crosses first wins (`exitOf`), not the risk function's fixed order.
- **B3 Slots at the bar open.** A position closed *inside* bar m still holds its slot and counts in the loss limit
  for entries at bar m's open; it frees from m+1. Reusing it at m's own open was a look-ahead that inflated a 6-month
  run from ₹1.83 L to ₹2.49 L.
- **B4 Warm-up parity.** Live loads the previous session's bars; the backtest must too. Record per trade how many
  warm-up bars its contract had (`warmupBars`) and report **cold entries** (< indicator period × timeframe) — in the
  reference run they were 22% of trades and ~90% of the net. Offer a warm-only switch (`btWarmOnly`).
- **B5 Costs** per order from a cost table (`orderCost`), brokerage from the rules (Kotak ₹0 vs Dhan ₹20),
  slippage in points from the rules. Gross, costs and net stored per trade.
- **B6 Rules stamp.** `backtestConfigKey(config)` covers every field that changes a result (not `engineActive`/mode);
  add new optional keys only when set so old stores still match. When the ledger's key differs from the store's,
  the route reports `rulesChanged`, catch-up is refused and only Re-run is offered — one result set, one rule set.
- **B7 Data is Dhan-only** (`dhan-backtest-data`, `dhan-expired-options-data`): one Python script per session, cached
  under `debug/<name>_backtest/data/`, emitting `{"ok":…}` as its **last stdout line**; account-wide DH-904 means
  expired-API calls run one at a time. Prefer the local options DB (offline, seconds per session).
- **B8 Runner lifecycle** (`dhan-polling-guards`, `dhan-cross-platform`): route takes an O_EXCL `start.lock`
  (stale after ~20 s) and spawns `process.execPath scripts/<name>-backtest.ts` **detached** with a log fd; the runner
  takes its own O_EXCL `run.lock` with its pid (stolen only from a dead pid), writes `status.json` after every step,
  appends each day atomically, and polls `stop.trigger`. Stop also kills the process group (`kill -9 -pid` /
  `taskkill /T /F`). A `running` status with no live pid is reported as `interrupted`.
- **B9 Audit is computed, never typed.** `auditResults` re-checks stored trades against the rules and bar files
  (P&L maths, costs, chronology, SL/target sizing, entry/exit fills inside the bar, slot and side caps at the bar
  open, re-entry lock, warm-up by weekday, cold entries) and the panel renders only that object.
- **B10 Panel polling**: `?known=<updatedAt>` so polls return status only while results are unchanged; 4 s while
  running, 60 s idle; auto catch-up only after 15:35 IST (`EOD_READY_HHMM`) and only when rules are unchanged.

## Tests to write (`npm test` runs `node --test lib/*.test.ts`)

- Rules: closed-bar only, freshness, max age, gate per trend mode, ranking order, trail ratchet never loosens.
- Ledger: duplicate 409, down-only ratchet, config sanitising, time-order refusal only on time patches, rev bump.
- Simulator: one hand-built day per fill branch (level cross, gap at open, ratchet below price, EOD, same-bar stop
  after entry), slot held inside the closing bar, loss-limit halt, re-entry lock, costs.
- Audit: a correct day passes every check; a tampered trade fails exactly the matching check.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Engine never fires / fires erratically | Interval effect depends on quote-driven values | E1 ref-called tick |
| Two tabs both enter | No leader lock | E2 |
| Second BUY after an exit timed out | Unknown outcome treated as failure and resent | E8, E9 |
| Stop evaluated on stale or wrong chain | Quotes not scoped; selector free while positions open | E3, E4 |
| Entries stop for minutes with candidates on screen | Only the top-ranked contract tried | E7 |
| Halt ignored | Halt only written to ledger; write failed | E10 suppress ref |
| Loss limit trips on yesterday / SIM losses | Not filtered by IST day and mode | L5, E11 |
| Backtest far better than live | Slot reuse inside the closing bar, cold indicators, fills at bar close | B3, B4, B2 |
| Backtest P&L mixes rule sets | Catch-up appended after a rules change | B6 |
| Run spawns twice / Stop leaves it running | No start lock, or only the parent killed | B8 |
| Audit card shows numbers that never change | Text written by hand | B9 |
| Numeric rule input fires mid-typing | Not commit-on-blur | `RuleNumInput`, `dhan-commit-on-blur` |

## Related skills

`dhan-new-strategy` (Python strategies, spec template) · `dhan-terminal-position-ownership` (ledger-owned legs,
unconfirmed orders) · `dhan-broker-positions` / `dhan-order-tickets` (routes, caps, broker payloads) ·
`dhan-fill-price-pnl` · `dhan-polling-guards` · `dhan-backtest-data` · `dhan-indicators` (closed-candle rules,
Supertrend copies) · `dhan-page-theme` / `dhan-terminal-polish` (header, DATA chip, density) · `dhan-alert-sound`.
