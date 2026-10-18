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

## UI Template & Design Architecture (Breakdown Scalper & Algo Lab Standard)

All automated strategy terminals must adhere to the standardized visual design system established in the **Breakdown Auto-Scalper** (`/breakdown-scalper`) and **Algo Lab** (`/algo-lab`). This institutional-grade template couples real-time operational telemetry with deep quantitative backtesting analytics.

Every component must follow repo theming rules: use zinc ramp tokens (`bg-zinc-950`, `bg-zinc-900`, `border-zinc-800`), solid text colors without slash opacity (`text-zinc-100` through `text-zinc-500`), `text-oncolor`/`bg-oncolor` for saturated accents, `bg-oncolor-dark/70` for modal/drawer backdrops, and commit-on-blur inputs (`dhan-commit-on-blur`).

---

### 1. Sticky Header & Strategy Mode Architecture

The sticky page header anchors navigation, strategy selection, live data status, and mode switching in a single high-contrast bar:

```tsx
<div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
  {/* Left: Identity & Strategy Selector */}
  <div className="flex items-center gap-3">
    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-violet-400">
      <Bot className="h-4 w-4" />
    </div>
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">ALGO LAB · AUTOMATED SCALPER</p>
      {/* Strategy selector dropdown when multi-strategy, or h1 title */}
      <select value={strategyKey} onChange={...} className="h-7 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-100 focus:outline-none">
        {strategies.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </div>
  </div>

  {/* Center: Segmented View Mode Tabs */}
  <div className="inline-flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/90 p-1 shadow-inner">
    <button className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all', tab === 'live' ? 'bg-violet-600 text-oncolor shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
      <Zap className="h-3.5 w-3.5" />
      <span>Live Trading</span>
      {openCount > 0 && <span className="rounded-full bg-violet-800 px-1.5 py-0.2 font-mono text-[10px] text-oncolor">{openCount}</span>}
    </button>
    <button className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-all', tab === 'backtest' ? 'bg-violet-600 text-oncolor shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
      <FlaskConical className="h-3.5 w-3.5" />
      <span>Backtest</span>
    </button>
  </div>

  {/* Right: Contract Scope, Broker, Live Feeds, Data Currency & Actions */}
  <div className="flex items-center gap-2">
    <select value={expiry} ... className="h-7 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs font-mono font-bold text-zinc-200" />
    <BrokerPicker />
    {/* Live WebSocket Status Pill with animated ping indicator */}
    <span className="flex items-center gap-1.5 rounded px-2 py-0.5 border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-[11px] font-mono font-bold">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
      <span>LIVE · WS</span>
    </span>
    {/* India VIX Live Chip */}
    <span className="flex items-center gap-1.5 rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800 text-xs font-mono">
      <span className="text-zinc-400">INDIA VIX:</span>
      <strong className="text-zinc-100">{vixLtp.toFixed(2)}</strong>
      <span className="text-[11px] font-bold text-amber-400">▲ +1.20%</span>
    </span>
    {/* DATA Date Currency Chip */}
    <span className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-400">
      DATA: {dataDate}
    </span>
    {/* Strategy & Risk Rules Button */}
    <button onClick={onOpenRules} className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-bold text-zinc-300 hover:bg-zinc-800">
      <Settings className="h-3.5 w-3.5 text-amber-400" />
      <span>RULES</span>
    </button>
    <NavBar />
  </div>
</div>
```

---

### 2. Market Direction & Risk Strip (`MarketBiasStrip` / `LivePanels`)

Mounted at the top of the Live workspace, this 2-row panel provides instant situational awareness and emergency execution controls:

#### Row 1: Telemetry & Primary Engine Controls
- **Spot Ticker & Indicators**: `{underlying} SPOT: {spot.toFixed(1)}` in bold mono font.
- **Trend Filter Pills**:
  - `EMA 9`: `{val}` · `EMA 20`: `{val}` · `Spread`: `+12.4` (green for positive spread, red for negative).
  - `ST (7, 3)`: `▲ {val}` (green arrow for uptrend, red arrow for downtrend).
- **India VIX Chip**: Live LTP, intraday change %, and yesterday close in tooltip.
- **Live WebSocket Pill**: Active transport badge (`LIVE · WS`) with glowing/ping dot.
- **Auto-Trader Master Toggle**:
  - Active: `bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30` with ping animation dot, `Pause` icon, and text `AUTO-TRADER ACTIVE`.
  - Paused: `bg-zinc-800/90 text-zinc-300 border border-zinc-700 hover:bg-zinc-700` with `Play` icon and text `AUTO-TRADER PAUSED`.
  - Hard Lock: Disabled automatically with `cursor-not-allowed opacity-50` when daily loss limit is breached.
- **Emergency Square-Off**: `EXIT ALL ({openCount})` in red styling (`border-red-500/40 bg-red-500/10 text-red-400`). Closes all active legs instantly.
- **Rules & Playbook Triggers**: Quick triggers for the Settings drawer (`Settings`) and strategy documentation (`BookOpen` / `PLAYBOOK`).

#### Row 2: The 5-Card Trend & Risk Dashboard Matrix
A responsive `grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3` layout:

1. **Market Direction Filter**:
   - Eyebrow: `MARKET DIRECTION FILTER` in `text-[10px] font-semibold uppercase tracking-wider text-zinc-500`.
   - Direction Tag: `BULLISH` (`TrendingUp`, `text-emerald-400`), `BEARISH` (`TrendingDown`, `text-red-400`), or `SIDEWAYS` (`Minus`, `text-amber-400`).
   - Mode Subtext: `Auto Bias Active` or `Bypass Filter`.
2. **Eligible Trading Side**:
   - Eyebrow: `ELIGIBLE SELLING SIDE` (or `ELIGIBLE BUYING SIDE`).
   - Badge: `PUTS (PE) ONLY` (emerald), `CALLS (CE) ONLY` (red), `BOTH CE & PE` (sky), or `BLOCKED: SIDEWAYS` (amber).
   - Subtext: Live headline / reason from the trend gate, with offline/error states highlighted in red.
3. **India VIX · Volatility Regime**:
   - Eyebrow: `INDIA VIX · VOLATILITY`.
   - Value: `Activity` icon + live LTP + change % badge.
   - Regime Badge: `< 13` Low Vol (emerald), `13 - 18` Normal Vol (sky), `> 18` Elevated (amber) + yesterday close reference.
4. **Concurrent Positions & Mode**:
   - Eyebrow: `CONCURRENT POSITIONS`.
   - Capacity: `{openCount} / {config.maxConcurrent} MAX` with subtext `(max {config.maxSameSide}/side)`.
   - Mode Pill: `REAL MODE` (`bg-red-500/20 text-red-400 border border-red-500/30`) vs `SIM MODE` (`bg-emerald-500/20 text-emerald-400 border border-emerald-500/30`).
5. **Daily P&L & Loss Limit Circuit Breaker**:
   - Eyebrow: `DAILY P&L / LOSS LIMIT`.
   - Real-time Total P&L: `+₹12,450` (emerald) or `-₹3,200` (red).
   - Remaining Budget Bar: Progress bar defaulting to emerald, shifting to amber at `< 30%` remaining, and red on breach.
   - Circuit Breaker Banner: When breached, displays `<ShieldAlert className="h-3 w-3" /> HARD DAILY LOSS LIMIT REACHED — LOCKED OUT` and locks the engine.

---

### 3. Strategy & Risk Rules Drawer Template (`RulesDrawer` / `RulesConfigDrawer`)

All strategy rules and risk parameters are rendered inside a standardized slide-over drawer (`w-full max-w-lg border-l border-zinc-800 bg-zinc-950 p-6 text-white shadow-2xl`).

#### Key Sub-components
- **Backdrop Scrim**: MUST use `bg-oncolor-dark/70 backdrop-blur-sm` (never `bg-black/70` which fades in white mode).
- **`SectionCard`**: Modular card wrapper with `rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3`. Bold title in `text-zinc-200` and description in `text-[11px] text-zinc-400`.
- **`FieldRow`**: Row layout with `flex items-center justify-between`, label in `font-medium text-zinc-300`, sublabel in `text-[10px] text-zinc-500`, and right-aligned controls.
- **`RuleNumInput`**: Commit-on-blur numeric stepper with `[ - ]` and `[ + ]` buttons. Listens to blur and Enter keys to ensure mid-typing values do not fire live rules (`dhan-commit-on-blur`).
- **`TimeInput`**: Commit-on-blur `HH:MM` input validating time format before applying, protecting against premature EOD square-offs.

#### The 8 Standard Card Sections
1. **Execution Mode**:
   - Status Banner: `REAL MONEY ARMED` (red border/badge) vs `SIMULATED PAPER TRADING` (emerald border/badge).
   - Mode Selector: Segmented pill buttons for `SIM (Paper)` and `REAL (Live Money)`.
   - Reset Action: `Reset SIM Paper Trades` button (`RefreshCcw`) to wipe simulated test runs.
2. **Market Direction Filter**:
   - Filter Mode Cards: Selectable cards for `AUTO Trend Filter` (uses index indicators) vs `BYPASS Filter` (trades both sides).
   - Index EMA Cross: Checkbox toggle + Fast/Slow period steppers (`trendEmaFast`, `trendEmaSlow`).
   - Index Supertrend: Checkbox toggle + Period/Multiplier steppers (`trendStPeriod`, `trendStMultiplier`).
3. **Scanner & Timeframe Parameters**:
   - Timeframe: Segmented pill buttons `[1m, 3m, 5m]`.
   - Strike Window: `±N strikes around ATM` stepper.
   - Lots Per Trade: Order sizing stepper.
   - Premium Thresholds: `Min Premium (₹)` and `Max Premium (₹)` steppers.
   - Max Signal Age: Bar expiry threshold stepper.
4. **Option Chart Indicators**:
   - Option Supertrend: Toggle + Period and Multiplier steppers.
   - Session VWAP: Toggle for intraday VWAP cross/breakdown filter.
   - Option EMA: Toggle + Period stepper.
5. **Portfolio & Risk Limits**:
   - Max Concurrent Positions: Portfolio slot limit stepper.
   - Max Same-Side Positions: CE/PE concentration limit stepper.
   - Daily Loss Limit: Account protection cap in ₹.
   - Hard Circuit Breaker: Toggle enforcing hard engine lockout upon limit breach.
6. **Brokerage & Execution Fees**:
   - Brokerage per Order: Sizing stepper with one-click presets for Dhan (`₹20`) and Kotak (`₹0`).
   - Backtest Data Source: Selector (`dhan` vs `offline_db`).
   - Backtest Slippage: Adverse execution drag in points per fill (`slippagePts`).
   - Skip Cold Contracts: Checkbox (`btWarmOnly`) to filter trades lacking multi-session warm-up.
7. **Stop-Loss & Profit Exits**:
   - Initial Stop-Loss %: Baseline risk threshold stepper.
   - Lock & Trail Trigger %: Profit threshold to activate trailing stop.
   - Trail Step & Trail By: Points-based trailing ratchet steppers (`trailStepPts`, `trailByPts`).
   - Target Profit %: Hard profit target stepper.
   - Indicator Recovery Exit: Toggle to exit if price crosses back over trigger levels.
8. **Trading Hours (IST)**:
   - Entry Window Start (default `09:20`) via `TimeInput`.
   - Entry Window End (default `14:45`) via `TimeInput`.
   - Mandatory EOD Exit Cutoff (default `15:15`) via `TimeInput`.
- **Drawer Footer**: Full-width Emerald `Done` button (`bg-emerald-600 hover:bg-emerald-500 text-oncolor font-bold`) to close the panel.

---

### 4. Live Dual-Pane Worksurface: Scanner & Positions Ledger

The Live tab renders two side-by-side or stacked panels:
1. **Candidate Scanner Grid (`ScannerGrid`)**:
   - Evaluates closed option bars against active rules.
   - Shows Strike, Type (CE/PE), LTP, Distance to Breakdown/Entry, Status (`TRIGGERED` pulsing emerald, `ARMED` sky, `LOCKED` amber, `INELIGIBLE` zinc).
2. **Positions Ledger & Broker Integration (`PositionsTable`)**:
   - Segmented Navigation: `Positions` (with open count badge), `Order Book` (with pending count badge), `Trade Book`.
   - Sub-filters: `Strategy Open`, `Strategy Closed`, and `Broker Net Positions`.
   - Columns: Strike & Expiry, Side, Entry Price, Live LTP, P&L (₹ & %), Low Water Mark, Current Trailing Stop, Exit Reason, Emergency Close button.
   - Inline Pending Order Editor: Allows editing price/quantity or cancelling pending limit orders directly from the terminal.

---

### 5. Quant Backtest Analytics Panel & Audit Standard

The Backtest tab replays the strategy's pure rule functions over historical data (`nifty_options.db`) and renders institutional analytics:

- **Top Control Strip**:
  - Window Picker: `Latest 4 weeks` (`db4`), `1 week`, `1 month`, `3 months`, `6 months`, `1 year`, `All Data (2021–2026)`, and `Custom Range…`.
  - Action Buttons: `Re-run` (rebuilds dataset), `Run Missing` (incremental catch-up), `CSV` export, `Audit` verification modal (`ShieldCheck`), and `Rules` drawer trigger.
  - Progress Gauge: Displays session completion progress bar and timestamp during background runs.
- **Weekday Filter Strip**:
  - Monday–Friday pill buttons with session counts and cold-start indicator badges (`⚠`). Enables isolating single-day effects (e.g. 0-DTE Tuesday vs Thursday).
- **Primary KPI Grid (8 tiles)**:
  - Net P&L (after costs), Gross / Costs, Sessions / with trades, Trades / Win rate, Avg per day / trade, Avg win / loss, Max drawdown, Profit factor.
- **Advanced Quant Metrics Grid (8 tiles)**:
  - Expectancy / Expectancy Ratio, Annualized Daily Sharpe, Annualized Daily Sortino, Calmar Ratio, Max Consecutive Streaks (W / L), Avg Hold Times (Win vs Loss), CE Sells Net, PE Sells Net.
- **DTE Performance Badges**:
  - Breakdown badges displaying Net P&L, trade counts, and win rates by Days-to-Expiry (0-DTE, 1-DTE, 2-DTE, etc.).
- **Slippage Sensitivity Stress Matrix**:
  - Live stress testing showing net P&L modeled under adverse fills: `@0.0pt`, `@0.5pt`, `@1.0pt`, and `@1.5pt` drag per order.
- **Interactive Equity & Daily Net Composed Chart**:
  - Recharts `ComposedChart`: Emerald/red bars for daily net P&L + violet line for cumulative equity curve, with zero reference line.
- **Computed Verification Audit Report (`BacktestAuditReport` / `AuditReport`)**:
  - 100% computed verification of trade chronology, bar boundaries, fill realism, slot concurrency, and cost modeling. Zero hardcoded text.

---

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
