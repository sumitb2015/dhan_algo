# Gearbox Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/gearbox` dashboard page that shows the Gearbox cluster live on the CRUDEOIL / CRUDEOILM future and lets the user click to trade options on it, SIM or REAL (Dhan, 1 lot).

**Architecture:** Pure maths (`lib/gearbox.ts`) runs in the browser on closed bars from `usePnfFeed`. A server module (`lib/gearboxServer.ts`) is the only writer of `debug/gearbox_state.json`, picks the strike from its own WebSocket price, and sends orders through the existing PnF order layer (`placePnfMarket`, tag `gbx`). A server loop squares off at the MCX auto-exit.

**Tech Stack:** Next.js 16 App Router, TypeScript, `node --test` unit tests, Playwright e2e, canvas for the scene.

**Spec:** `docs/superpowers/specs/2026-11-20-gearbox-drive-design.md` (read §5–§10 before any task).

## Global Constraints

- REAL: Dhan only; **1 lot** per order and per position, both CRUDEOIL and CRUDEOILM. SIM: up to **10 lots**.
- Source tag `gbx`. Server rejects over-cap, never clamps.
- The browser names only the action; contract, strike, quantity and exit size come from the server.
- Strike picked on the server from a WebSocket future price no older than **10 s**; else refused.
- Option expiry "Nearest" = first option expiry **after** today (never one expiring today). Future = `spotInstrument(underlying, optionExpiry, true)`.
- Exits send only this ledger's units (`exitOwn`), capped by the broker row.
- An `unknown` outcome is never resent.
- Product INTRADAY only. Square-off at `mcxSession(today).autoExit` (HHMM number, e.g. `2315`).
- Read the skills `dhan-crudeoil-trading`, `dhan-terminal-position-ownership`, `dhan-order-tickets`, `dhan-polling-guards`, `dhan-page-theme`, `dhan-commit-on-blur` before the tasks that touch their areas.
- Theme: no hex / rgb in components; zinc ramp + tokens; canvas colours read from CSS variables; table headers `text-xs font-bold text-white` on `bg-zinc-800`; `DATA: YYYY-MM-DD` chip. Desktop only.
- Never add an e2e case that places a real order. Tests run with `cd rs_dashboard && node --test lib/<file>.test.ts`.
- Commits go straight to `master`, one per task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Click while warming up or on a stale future price** → the order is refused with a message saying why; nothing is sent. (Task 4 test `refuses open on stale price`, Task 6 e2e `disabled while warming up`.)
2. **Double-click or a held key** → exactly one order. (Task 4 test `second open while sending is refused`; Task 6 hotkey ignores `e.repeat`, e2e `key repeat sends once`.)
3. **Page reload with a REAL row open** → the page shows the held leg from the ledger; Exit still works; underlying / broker pickers locked. (Task 6 e2e `reload restores held leg`.)
4. **Square-off with the tab closed and no fresh price** → REAL exit still sent; SIM closed at the last good price and logged. (Task 5 tests.)
5. **Options expiring today** → "Nearest" picks the next expiry; an open row from an earlier day is closed only by hand or square-off, never re-priced onto a new contract. (Task 4 test `nearest skips today's expiry`.)

---

### Task 1: Gearbox maths

**Files:**
- Create: `rs_dashboard/lib/gearbox.ts`, `rs_dashboard/lib/gearbox.test.ts`, `rs_dashboard/lib/gearbox.fixture.json`

**Interfaces:**
- Produces:
  ```ts
  export interface GbBar { t: number; o?: number; h?: number; l?: number; c: number; v: number } // t = bar open, unix s
  export type Mode = 1 | -1 | 0;
  export interface GbState { c: number; gear: 0|1|2|3|4|5; mode: Mode; armed: boolean; signal: boolean; vwOK: boolean; stOK: boolean;
    sd: 1 | -1; sl: number; sp: number; acc: number; rpm: number; alt: number; t: number; sessionBar: number }
  export interface GhostTrade { side: 1 | -1; ei: number; xi: number; ep: number; xp: number; why: 'stop hit'|'mode flipped'|'gear collapsed'|'session close' }
  export interface GbSession { openMin: number; autoExitMin: number }   // IST minutes of day
  export const WARM_BARS = 200;
  export function computeGearbox(bars: GbBar[], session: (t: number) => GbSession): GbState[];
  export function ghostTrades(bars: GbBar[], states: GbState[], session: (t: number) => GbSession): GhostTrade[];
  export function ghostScore(trades: GhostTrade[], states: GbState[], i: number): { points: number; closed: number; wins: number; open: 1 | -1 | 0 };
  export const ENTRY_AFTER_OPEN_MIN = 15, ENTRY_BEFORE_EXIT_MIN = 40;
  ```

- [ ] **Step 1: Generate the parity fixture.** Port the artifact's `gen()` + `build()` (artifact at https://claude.ai/artifact/N422Ph3ycSVibQJnjeN5Q2, saved copy in the spec's source link) into a throwaway script under the scratchpad, seed `20261120`, and write `gearbox.fixture.json` = `{ bars: [...first 600 bars as GbBar], states: [{gear, mode, armed, signal}...] }`. Use the artifact's session (bar index 0 = open, 75 bars/day) by mapping `t` so `session()` returns that.
- [ ] **Step 2: Write failing tests** in `gearbox.test.ts`:
  - `parity with the artifact`: `computeGearbox(fixture.bars, artifactSession)` matches every `{gear, mode, armed}` in the fixture; `signal` matches except where the entry window differs (assert with the artifact's 3/66-bar window passed through `session`).
  - `closed bars only`: appending a bar changes only the last state.
  - `vwap resets at session open`: VWAP of the first bar of a session equals its hlc3.
  - `missing high/low falls back to close`: a bar with no `h`/`l` gives `rpm` finite and ATR > 0.
  - `ghost stop checks the bar low`: long open, a bar with `l < stop` and `c > stop` exits with `'stop hit'` at the stop price.
  - `fog does not exit the ghost`: long open, mode goes 0 for 3 bars, trade still open.
  - `no ghost entry outside window`: a signal 10 min after open produces no trade.
- [ ] **Step 3: Run** `cd rs_dashboard && node --test lib/gearbox.test.ts` → FAIL (module missing).
- [ ] **Step 4: Implement `lib/gearbox.ts`.** Rules exactly as spec §5; EMA seeded with the first close (as the artifact); ATR Wilder 14; Supertrend factor 3 on ATR 14 with the artifact's band carry rule; `sessionBar` = bars since that session's open. Reuse `lib/indicators.ts` EMA/ATR only if its output equals the artifact's on the fixture; otherwise keep local helpers and say why in a comment. Ghost exit at the stop price for a stop hit, at the close otherwise.
- [ ] **Step 5: Run** the same command → PASS.
- [ ] **Step 6: Commit** `feat(gearbox): pure gearbox maths with artifact parity tests`.

### Task 2: Ledger and reservation

**Files:**
- Create: `rs_dashboard/lib/gearboxLedger.ts`, `rs_dashboard/lib/gearboxLedger.test.ts`, `rs_dashboard/lib/gearboxFile.ts`

**Interfaces:**
- Consumes: `Target`, `targetKey` (`lib/pnfTarget.ts`).
- Produces:
  ```ts
  export type GbMode = 'SIM' | 'REAL'; export type GbUnderlying = 'CRUDEOIL' | 'CRUDEOILM'; export type Dir = 'LONG' | 'SHORT';
  export interface DirLeg { action: 'BUY' | 'SELL'; opt: 'CE' | 'PE'; offset: number /* -3..3 */; expiry: 'nearest' | string }
  export interface GbConfig { underlying: GbUnderlying; broker: 'dhan'; lots: number; tf: 1 | 3 | 5;
    map: Record<Dir, DirLeg>; slPts: number | null; tgtPts: number | null; maxLoss: number | null; maxTrades: number | null }
  export type GbStatus = 'sending' | 'open' | 'closing' | 'closed' | 'failed' | 'unknown';
  export interface GbRow { id: string; mode: GbMode; broker: 'dhan'; underlying: GbUnderlying; dir: Dir; leg: DirLeg; target: Target;
    lots: number; units: number; unitsPerLot: number; entry: number; entryDecision: number; entryAt: number; entryOrderId?: string;
    exit?: number; exitDecision?: number; exitAt?: number; exitOrderId?: string; reason?: string; day: string; status: GbStatus; note?: string;
    lastLtp?: number /* last good option price, kept fresh by gbState(); the square-off's SIM fallback */ }
  export interface GbLog { at: number; level: 'info'|'warn'|'error'|'trade'; msg: string }
  export interface GbLedger { rev: number; updatedAt: number; mode: GbMode; config: GbConfig; rows: GbRow[]; log: GbLog[]; lastSquareOffDay: string | null }
  export const MAX_REAL_LOTS = 1, MAX_SIM_LOTS = 10, MAX_ROWS = 200, MAX_LOG = 300;
  export const DEFAULT_CONFIG: GbConfig; // CRUDEOILM, dhan, 1 lot, tf 5, LONG = BUY CE 0 nearest, SHORT = BUY PE 0 nearest, limits null
  export function emptyLedger(): GbLedger; export function normalizeLedger(v: unknown): GbLedger;
  export type ClientOp = { op: 'setConfig'; patch: Partial<GbConfig> } | { op: 'setMode'; mode: GbMode } | { op: 'resolve'; id: string; as: 'open' | 'closed' | 'failed'; price?: number };
  export function applyClientOp(l: GbLedger, raw: unknown, now: number): { ok: true; ledger: GbLedger } | { ok: false; status: number; error: string };
  export const isLive: (r: GbRow) => boolean;  // sending | open | closing | unknown
  export function liveRow(l: GbLedger, u: GbUnderlying): GbRow | null;
  export function rowPnl(r: GbRow, ltp: number | null): number | null;  // (exit|ltp − entry) × units, sign by leg.action
  export function realisedToday(l: GbLedger, mode: GbMode, day: string): number; export function tradesToday(l: GbLedger, mode: GbMode, day: string): number;
  export function entryBlock(l: GbLedger, day: string): string | null; // daily-limit message or null
  ```
  `gearboxFile.ts`: `export const GB_STATE_FILE: string` (`debug/gearbox_state.json`), `readGbLedger(): GbLedger`, `reservedByGearbox(broker: string, tKey: string, product: 'INTRADAY'|'MARGIN', ledger?: GbLedger): number` (signed units of live REAL rows, + for BUY, − for SELL; 0 for MARGIN).

- [ ] **Step 1: Failing tests** — `normalizeLedger` of junk gives `emptyLedger()`; `setConfig` refuses `lots: 2` in REAL and `lots: 11` in SIM (status 400), refuses any change of `underlying`/`map`/`broker` while a live row exists for that underlying (409), refuses `broker` other than `'dhan'`, refuses `offset` outside −3..3; `setMode` to REAL clamps nothing and refuses while a live row exists; `resolve` moves an `unknown` row to the given state only; `rowPnl` for BUY CE 1 lot CRUDEOILM (units 10) 100 → 110 = +100, for SELL = −100; `entryBlock` returns a message once `realisedToday ≤ −maxLoss` or `tradesToday ≥ maxTrades`; `reservedByGearbox` sums only live REAL rows of that key.
- [ ] **Step 2: Run** `node --test lib/gearboxLedger.test.ts` → FAIL.
- [ ] **Step 3: Implement** both files; `readGbLedger` uses `readJsonFile` + `normalizeLedger`. Config inputs with `slPts`/`tgtPts`/limits accept `null` or a positive number.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gearbox): ledger, client ops and reservation`.

### Task 3: Order-layer hooks (cap, tag, hold-back)

**Files:**
- Modify: `rs_dashboard/lib/dhanPlaceOrder.ts` (`SOURCE_QTY_CAPS_MCX`), `rs_dashboard/lib/pnfAutoOrders.ts:50` (tag type) and its `keep()` in the `close` branch
- Test: existing `lib/dhanPlaceOrder.test.ts`, `lib/pnfAutoOrders.test.ts` (create the cases there; if a file is missing, add the case to the nearest existing test of that module)

**Interfaces:**
- Consumes: `reservedByGearbox` (Task 2).
- Produces: `placePnfMarket(order, scope, tagOverride?: 'orba' | 'gbx')`.

- [ ] **Step 1: Failing tests** — `gbx MCX cap is 1`: `placeDhanOrder({source:'gbx', exchangeSegment:'MCX_COMM', quantity: 2, …})` → `{status:'invalid'}` naming the cap; quantity 1 passes validation (stub the network the way the existing cap tests do). `a P&F close keeps Gearbox's units`: with a live REAL Gearbox row BUY 1 lot on the same option target, a `close` order plans the broker row minus 1 lot.
- [ ] **Step 2: Run** the two test files → FAIL.
- [ ] **Step 3: Implement** — add `gbx: 1` with a comment (`'gbx' = Gearbox Drive (CRUDEOIL / CRUDEOILM options): MAX_REAL_LOTS 1 until it has run live`); widen the tag type; in `keep()` add `reservedByGearbox(broker, k, p)` per option leg key inside `fromIndex` (option legs) and extend the `whose` note with `"Gearbox Drive"`.
- [ ] **Step 4: Run** → PASS, then `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(gearbox): gbx source cap and close hold-back in the PnF order layer`.

### Task 4: Server and routes

**Files:**
- Create: `rs_dashboard/lib/gearboxServer.ts`, `rs_dashboard/lib/gearboxServer.test.ts`, `rs_dashboard/app/api/gearbox/state/route.ts`, `rs_dashboard/app/api/gearbox/trade/route.ts`

**Interfaces:**
- Consumes: Task 2 ledger; `placePnfMarket` (Task 3); `parsePnfOrder`; `expiriesFor`, `strikesFor`, `atmStrike`, `resolveOption` (`lib/pnfContracts.ts`); `spotInstrument`, `wsWant`, `wsSync`, `wsPrice` (`lib/freshMoneyWs.ts`); `readBrokerOrder` (`lib/brokerOrderStatus.ts`); `globalOnce`, `writeJsonAtomic`, `istDateIso`, `MCX_LOT_MULTIPLIER`.
- Produces:
  ```ts
  export interface GbDeps { now(): number; price(u: GbUnderlying, optExpiry: string): { ltp: number; ageMs: number } | null;
    optionPrice(t: Target): { ltp: number; ageMs: number } | null; place: typeof placePnfMarket;
    readOrder(id: string): Promise<{ orderStatus: string; filledQty: number; averageTradedPrice: number } | null>; sleep(ms: number): Promise<void> }
  export const realDeps: GbDeps;
  export type TradeReq = { action: 'open' | 'exit' | 'reverse'; dir?: Dir; underlying: GbUnderlying; decisionPrice: number; reason: string };
  export function parseTrade(b: unknown): TradeReq | string;
  export function pickTarget(u: GbUnderlying, leg: DirLeg, futLtp: number, today: string): Target | string;
  export function gbState(): { status: number; body: Record<string, unknown> }; // ledger, contracts for both dirs at current price, prices, caps, today, session
  export function gbClientOp(op: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  export function gbTrade(req: TradeReq, deps?: GbDeps): Promise<{ status: number; body: Record<string, unknown> }>;
  export function closeRowNow(l: GbLedger, row: GbRow, reason: string, deps: GbDeps): Promise<{ ok: boolean; unknown?: boolean; error?: string; ledger: GbLedger }>; // used by Task 5
  ```
  Routes: `GET /api/gearbox/state` → `gbState()`; `POST /api/gearbox/state` body = `ClientOp` → `gbClientOp`; `POST /api/gearbox/trade` → `parseTrade` then `gbTrade`. Same JSON error shape as `app/api/signal-orb/trade/route.ts`.

- [ ] **Step 1: Failing tests** (deps stubbed; no network):
  - `refuses open on stale price`: `price()` age 11 000 ms → 409, no `place` call.
  - `nearest skips today's expiry`: `pickTarget` with expiries `[today, next]` uses `next`; strike = `atmStrike` of `strikesFor` + offset (`+N` OTM: CE up, PE down).
  - `SIM open books the option LTP`: row `open`, `entry` = `optionPrice().ltp`, `entryDecision` = request price, no `place` call.
  - `REAL open writes sending row before placing`: the ledger file read inside the stubbed `place` has the row `sending`.
  - `REAL open sends 1 lot with tag gbx and INTRADAY`; on `placed` row → `open`, `entry` = `averageTradedPrice` from `readOrder` (polled ≤ 10 × 1 s), falling back to the option LTP with a log line.
  - `second open while sending is refused`: two concurrent `gbTrade` opens → exactly one `place` call; the other 409.
  - `unknown outcome is never resent`: `place` returns 504 → row `unknown`; a following `exit` returns 409 "resolve it first"; no second `place`.
  - `exit sends exitOwn with the row's units`.
  - `reverse waits for the exit fill`: `readOrder` → `TRADED` then open sends; `REJECTED` → no open, row back `open`; never `TRADED` within 10 polls → row `unknown`, no open.
  - `daily limit blocks entries, not exits`.
  - `same direction while held is refused` (409 "already LONG").
  - `REAL with broker other than dhan is refused`.
- [ ] **Step 2: Run** `node --test lib/gearboxServer.test.ts` → FAIL.
- [ ] **Step 3: Implement** following `lib/signalOrbServer.ts` (serial chain via `globalOnce('gearbox.chain', …)`, `save()` with `rev + 1`), with these differences: target from `pickTarget` at the click on server price; `realDeps.price` = `wsPrice(wsWant(spotInstrument(...)))` after `wsSync()`, `ageMs = now − (changedMs ?? sinceMs)`; `realDeps.optionPrice` the same on the option's `MCX_COMM` security id; `units = lots × MCX_LOT_MULTIPLIER[underlying]` for P&L only (Dhan quantity is lots via the layer); `gbState` keeps `wsWant` alive for the future and every live row's option, and writes each live row's `lastLtp` (through the serial chain) when its option price is fresh.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(gearbox): server ledger writer and trade/state routes`.

### Task 5: Square-off watcher

**Files:**
- Create: `rs_dashboard/lib/gearboxSquareOff.ts`, `rs_dashboard/lib/gearboxSquareOff.test.ts`
- Modify: `rs_dashboard/instrumentation.node.ts` (start beside `freshMoneyExitServer`, honour `DASHBOARD_NO_BACKGROUND`)

**Interfaces:**
- Consumes: `closeRowNow`, `GbDeps`, `realDeps` (Task 4), `mcxSession`, `istMinuteOfDay`.
- Produces: `export function squareOffDue(nowMs: number, ledger: GbLedger): GbRow[]`; `export function gearboxSquareOffTick(deps?: GbDeps): Promise<void>`; `export function startGearboxSquareOffLoop(): void` (5 s interval, `globalOnce`, idle with no live row).

- [ ] **Step 1: Failing tests** — `squareOffDue` returns live `open` rows when IST minute ≥ `autoExit` (HHMM → minutes), none before; rows from an earlier `day` are due at any time in session; a tick closes a SIM row at `optionPrice` and, with no price, at the row's `lastLtp`, logging `"square-off at last price"`; a REAL row with no price still calls `place` with `exitOwn`; a tick after `lastSquareOffDay === today` with nothing live does nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gearbox): server square-off at the MCX auto-exit`.

### Task 6: Page, engine hook and e2e

**Files:**
- Create: `rs_dashboard/app/gearbox/page.tsx`, `rs_dashboard/components/gearbox/GearboxPage.tsx`, `useGearboxEngine.ts`, `RoadScene.tsx`, `Cluster.tsx` (speed/RPM gauges, shifter, meters, lamps), `TradeStrip.tsx`, `DirectionMap.tsx`, `Scoreboard.tsx`, `TripLog.tsx`, `TradesTable.tsx`, `RulesPanel.tsx`
- Create: `rs_dashboard/e2e/gearbox.spec.ts`
- Modify: `rs_dashboard/components/Sidebar.tsx` (link beside Signal Orb, line ~117)

**Interfaces:**
- Consumes: `computeGearbox`, `ghostTrades`, `ghostScore`, `WARM_BARS` (Task 1); `GbLedger`, `rowPnl`, `liveRow` (Task 2); routes (Task 4); `usePnfFeed` (futures target from `gbState().body.future`), `mcxSession`, `lib/alertSound.ts`.
- Produces: `useGearboxEngine(): { ledger, states, ghost, feedFresh: boolean, warming: boolean, held: GbRow | null, heldLtp: number | null, contracts: Record<Dir, Target | null>, realArmed: boolean, armReal(): void, disarm(): void, open(dir: Dir): Promise<void>, exit(): Promise<void>, setConfig(p: Partial<GbConfig>): Promise<void>, busy: boolean, error: string | null }`.

- [ ] **Step 1: Write the e2e spec first** (all `/api/*` mocked via `e2e/support.ts`; unhandled non-GET → 599): `disabled while warming up` (feed with 100 bars → Long/Short disabled, "Warming up" shown); `SIM open and exit` (click Long → POST `/api/gearbox/trade` `{action:'open',dir:'LONG'}`; held leg shows); `REAL needs arming` (REAL selected, not armed → buttons disabled; arm → confirm dialog → enabled; reload → disarmed); `key repeat sends once` (ArrowUp with `repeat: true` after the first → one POST); `reload restores held leg` (state mock with an open REAL row → held leg, Exit enabled, underlying picker disabled); `stale feed disables REAL`.
- [ ] **Step 2: Run** `cd rs_dashboard && E2E_PORT=3000 npx playwright test e2e/gearbox.spec.ts` (only reuse :3000 if the dashboard runs there; never start a second `next dev` beside it) → FAIL.
- [ ] **Step 3: Implement** — engine polls `GET /api/gearbox/state` every 2 s (one in flight, out-of-order guard per `dhan-polling-guards`); computes `computeGearbox` only when the closed-bar key changes (Signal Orb's `closedKey` pattern) on bars resampled to `config.tf`; REAL arm in component state only, keyed to `underlying + broker`, cleared on change; hotkeys ↑/↓/X ignore `e.repeat` and focused inputs; REAL clicks confirm (`window.confirm` style matching existing REAL confirms). SL/target in premium points and daily limits are commit-on-blur inputs; SL/target fire `exit()` from the leader tab only and the panel says "browser-only — closes nothing if this tab is closed". Shift-up chime via `lib/alertSound.ts`, muted by default. Scene redraws on price change throttled to 10 fps and pauses when the tab is hidden; colours from CSS variables (add `--gb-*` tokens in `app/globals.css` with dark, light and beige blocks). Header per `dhan-page-theme` with DATA chip, session clock, time to square-off. Ghost score labelled "rules unvalidated · futures points".
- [ ] **Step 4: Run** the e2e spec → PASS; run `cd rs_dashboard && python3 ../.claude/skills/dhan-page-theme/scripts/audit_pages.py` → no flags for `/gearbox`.
- [ ] **Step 5: Commit** `feat(gearbox): /gearbox page, engine hook and e2e`.

### Task 7: Docs

**Files:**
- Create: `docs/GEARBOX_GUIDE.md`
- Modify: `CLAUDE.md` (route entry under non-obvious route behaviors; guide in the docs list)

- [ ] **Step 1: Write the guide** — what each gauge means (spec §5 table), buttons and hotkeys, direction map, SIM vs REAL (Dhan, 1 lot), what runs with the tab closed (square-off only), browser-only SL/target, daily limits, what other pages can and cannot close (Price Ladder / scalper exits not covered), ghost = unvalidated.
- [ ] **Step 2: CLAUDE.md entry**, two to four lines, naming `lib/gearboxServer.ts`, `debug/gearbox_state.json`, tag `gbx`, "Real-money endpoint".
- [ ] **Step 3: Commit** `docs(gearbox): user guide and CLAUDE.md entry`.
