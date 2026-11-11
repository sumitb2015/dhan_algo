# Fresh Money Target / Stop-Loss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-position target and stop-loss on the Fresh Money board (header defaults in % or points, stamped at entry,
editable per position), exited automatically by a dashboard-server watcher through the page's existing close path.

**Architecture:** Pure level maths and decisions in `lib/freshMoneyExits.ts`; a dependency-injected tick
(`lib/freshMoneyExitTick.ts`) that the server loop (`lib/freshMoneyExitServer.ts`, started from
`instrumentation.node.ts`) wires to the real ledger, prices and close. The trade route's ledger / send / close code
moves to `lib/freshMoneyTradeServer.ts` so the × button and the watcher share one close. Levels live in the existing
ledger file under `exits`.

**Tech Stack:** Next.js 16 (App Router, `rs_dashboard/`), TypeScript, `node --test` for unit tests, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-11-fresh-money-target-sl-design.md`

## Global Constraints

- REAL MONEY. No step may send a real order: unit tests use fakes; e2e mocks every `/api/fresh-money*` call in the
  browser and fails on any unmocked non-GET. Never run `tests/test_*.py` broadly.
- Run all commands from `rs_dashboard/` unless stated. Unit tests: `node --test lib/<file>.test.ts`; full: `npm test`.
- Type check: `npx tsc --noEmit -p .` must show no new errors in touched files; `npx eslint <touched files>` clean.
- e2e against the running dashboard only: `E2E_PORT=3000 PW_CHROMIUM_PATH=/usr/bin/google-chrome npx playwright test e2e/fresh-money-exits.spec.ts` — never start a second `next dev`.
- Theme: zinc ramp / tokens only, no hex/rgb, no slash-opacity on neutral text; table headers `text-xs font-bold text-white` on `bg-zinc-800`.
- Free-typed inputs commit on blur / Enter only, Escape reverts (dhan-commit-on-blur).
- Validation bounds (spec §2): value finite and `> 0`; `pct` ≤ 1000; `pts` ≤ 100000. Level `<= 0` resolves to null (off).
- Watcher constants (spec §4): tick 2000 ms; confirm on 2 consecutive breaching ticks; retry a refused exit no sooner
  than 5000 ms; heartbeat alive = written within 10000 ms.
- Commits go on `master` (no branches), only once the user has approved running the plan.

## Review Focus

1. A restart between `firing` and the close's outcome leaves a record stuck in `firing` → after 60 s it must read as `unknown` (never resent), shown "exit UNKNOWN — check the broker". Test in Task 2.
2. Two breaching ticks far apart (watcher stalled, tab-independent GC pause) must not count as "consecutive" → a streak older than 6000 ms restarts at 1. Test in Task 2.
3. The user presses × after one breaching tick → the next tick sees the contract settling/flat and must not fire a second close. Test in Task 5.
4. Header input of `0`, `-5`, `abc`, `1e9` → refused with a message, blank → off; the order with invalid defaults is refused with nothing sent. Tests in Tasks 1 and 4.
5. Editing a position to a level the price has already crossed → the editor warns "already past — exits within ~4 s" before Save. Pinned by Task 1's `breached` tests, shown in Task 6.

---

### Task 1: Level maths

**Files:**
- Create: `rs_dashboard/lib/freshMoneyExits.ts`
- Test: `rs_dashboard/lib/freshMoneyExits.test.ts`

**Interfaces:**
- Produces:
  - `type ExitUnit = 'pct' | 'pts'`; `interface ExitSpec { value: number; unit: ExitUnit }`
  - `type ExitDir = 'long' | 'short'`; `interface ExitLevels { targetPx: number | null; slPx: number | null }`
  - `validateExitSpec(raw: unknown): ExitSpec | null | { error: string }` — `null`/`undefined`/blank value = off.
  - `levelsFor(basis: number, dir: ExitDir, target: ExitSpec | null, sl: ExitSpec | null): ExitLevels`
  - `breached(ltp: number, dir: ExitDir, lv: ExitLevels): 'target' | 'sl' | null` (SL wins a tie)
  - `fmtExitSpec(s: ExitSpec | null): string` → `'30%'`, `'20 pts'`, `'off'`

- [ ] **Step 1: Write the failing tests** (`freshMoneyExits.test.ts`)

```ts
test('long levels in % and points', () => {
  assert.deepEqual(levelsFor(100, 'long', { value: 30, unit: 'pct' }, { value: 20, unit: 'pct' }), { targetPx: 130, slPx: 80 });
  assert.deepEqual(levelsFor(100, 'long', { value: 25, unit: 'pts' }, { value: 15, unit: 'pts' }), { targetPx: 125, slPx: 85 });
});
test('short levels mirror; a 100% short SL is premium doubling', () => {
  assert.deepEqual(levelsFor(100, 'short', { value: 30, unit: 'pct' }, { value: 100, unit: 'pct' }), { targetPx: 70, slPx: 200 });
});
test('a level at or below zero is off', () => {
  assert.equal(levelsFor(100, 'long', null, { value: 100, unit: 'pct' }).slPx, null);
  assert.equal(levelsFor(100, 'long', null, { value: 120, unit: 'pts' }).slPx, null);
  assert.equal(levelsFor(100, 'short', { value: 150, unit: 'pts' }, null).targetPx, null);
});
test('breach directions; SL wins a tie', () => {
  const L = { targetPx: 130, slPx: 80 };
  assert.equal(breached(130, 'long', L), 'target'); assert.equal(breached(80, 'long', L), 'sl'); assert.equal(breached(100, 'long', L), null);
  const S = { targetPx: 70, slPx: 200 };
  assert.equal(breached(70, 'short', S), 'target'); assert.equal(breached(200, 'short', S), 'sl');
  assert.equal(breached(100, 'long', { targetPx: 90, slPx: 110 }), 'sl');
  assert.equal(breached(100, 'long', { targetPx: null, slPx: null }), null);
});
test('validation bounds', () => {
  assert.equal(validateExitSpec(null), null);
  assert.equal(validateExitSpec({ value: null, unit: 'pct' }), null);
  assert.deepEqual(validateExitSpec({ value: 30, unit: 'pct' }), { value: 30, unit: 'pct' });
  for (const bad of [{ value: 0, unit: 'pct' }, { value: -5, unit: 'pts' }, { value: 'abc', unit: 'pct' },
    { value: 1001, unit: 'pct' }, { value: 1e9, unit: 'pts' }, { value: 5, unit: 'rupees' }]) {
    assert.ok('error' in (validateExitSpec(bad) as object), JSON.stringify(bad));
  }
});
test('format', () => {
  assert.equal(fmtExitSpec({ value: 30, unit: 'pct' }), '30%'); assert.equal(fmtExitSpec({ value: 20, unit: 'pts' }), '20 pts'); assert.equal(fmtExitSpec(null), 'off');
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test lib/freshMoneyExits.test.ts` → cannot find module.
- [ ] **Step 3: Implement** the Produces list in `lib/freshMoneyExits.ts` (pure, no imports). Round computed prices to 2 dp.
- [ ] **Step 4: Run, expect PASS** — same command, 6 tests pass.
- [ ] **Step 5: Commit** — `git add lib/freshMoneyExits*.ts && git commit -m "feat(fresh-money): target/SL level maths"`

---

### Task 2: Exit record and per-tick decision

**Files:**
- Modify: `rs_dashboard/lib/freshMoneyExits.ts`, `rs_dashboard/lib/freshMoneyTrades.ts` (`FmLedger` gains `exits?: Record<string, FmExit>`, type-only import)
- Test: `rs_dashboard/lib/freshMoneyExits.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `type ExitState = 'waiting-fill' | 'watching' | 'firing' | 'sent' | 'unknown' | 'incomplete'`
  - `interface FmExit { key: string; openedAt: number; dir: ExitDir; target: ExitSpec | null; sl: ExitSpec | null; basis: number | null; targetPx: number | null; slPx: number | null; state: ExitState; firedBy?: 'target' | 'sl'; firedAt?: number; retryAt?: number; note?: string }`
  - `interface Streak { level: 'target' | 'sl'; count: number; at: number }`
  - `type CloseResult = { kind: 'placed'; orderId: string; note?: string } | { kind: 'refused'; error: string; http: number } | { kind: 'unknown'; error: string; partial: boolean } | { kind: 'partial'; error: string }`
  - `type ExitAction = { kind: 'none' } | { kind: 'drop' } | { kind: 'resolve'; basis: number; levels: ExitLevels } | { kind: 'streak'; streak: Streak | null } | { kind: 'fire'; level: 'target' | 'sl' } | { kind: 'settle'; to: 'drop' | 'incomplete' } | { kind: 'mark-unknown'; note: string }`
  - `nextExitAction(x: FmExit, pos: { netQty: number; avgPrice: number | null } | null, settling: boolean, ltp: number | null, streak: Streak | null, now: number): ExitAction`
  - `exitAfterClose(r: CloseResult, level: 'target' | 'sl', now: number): Partial<FmExit>`
  - constants `CONFIRM_TICKS = 2`, `STREAK_MAX_GAP_MS = 6000`, `FIRING_STALE_MS = 60000`, `REFUSED_RETRY_MS = 5000`

Decision order inside `nextExitAction` (the one part the signature does not fix):
1. `firing` older than `FIRING_STALE_MS` (by `firedAt`) → `mark-unknown`; otherwise `firing` → `none`.
2. position null/flat, or its sign disagrees with `dir` → `drop` if `!settling`, else `none`. For `sent` the same check returns `settle: 'drop'`; `sent` with the position still open and `!settling` → `settle: 'incomplete'`.
3. `waiting-fill` with an open position and `avgPrice` known → `resolve` from `levelsFor(avgPrice, …)`.
4. `watching`, `now < retryAt` or `ltp === null` → `streak: null` (reset).
5. `watching`: `b = breached(ltp…)`; null → `streak: null`; else count = previous same-level streak within `STREAK_MAX_GAP_MS` + 1 (else 1); count ≥ `CONFIRM_TICKS` → `fire`, else `streak`.
6. `unknown` / `incomplete` → `none`.

`exitAfterClose`: placed → `{state:'sent', firedBy, firedAt}`; refused → `{state:'watching', note: error, retryAt: now+5000}`; unknown/partial → `{state:'unknown', note: 'exit UNKNOWN — check the broker: ' + error}`.

- [ ] **Step 1: Write the failing tests** — one test each, with `const X = (p: Partial<FmExit>): FmExit => ({ key:'dhan|1', openedAt:0, dir:'long', target:{value:30,unit:'pct'}, sl:{value:20,unit:'pct'}, basis:100, targetPx:130, slPx:80, state:'watching', ...p })`:
  - `resolve`: `nextExitAction(X({state:'waiting-fill', basis:null, targetPx:null, slPx:null}), {netQty:65, avgPrice:100}, false, 120, null, 0)` → `{kind:'resolve', basis:100, levels:{targetPx:130, slPx:80}}`; with `avgPrice:null` → `none`.
  - drop: flat position not settling → `drop`; settling → `none`; short position (`netQty:-65`) for a long record → `drop`.
  - confirm: `ltp 131, streak null` → `{kind:'streak', streak:{level:'target', count:1, at:t}}`; then with that streak at `t+2000` → `fire target`.
  - **Review Focus 2:** streak at `t`, next breach at `t+7000` → `streak` count 1, not `fire`.
  - reset: `ltp null` → `streak: null`; `now < retryAt` → `streak: null`; non-breaching ltp → `streak: null`.
  - **Review Focus 1:** `X({state:'firing', firedAt:0})` at `now 60001` → `mark-unknown`; at `now 1000` → `none`.
  - sent: flat & not settling → `settle drop`; open & not settling → `settle incomplete`; settling → `none`.
  - `exitAfterClose` for each `CloseResult` kind returns the mapping above.
- [ ] **Step 2: Run, expect FAIL** — `node --test lib/freshMoneyExits.test.ts`.
- [ ] **Step 3: Implement** per the Produces list and decision order.
- [ ] **Step 4: Run, expect PASS**; also `node --test lib/freshMoneyTrades.test.ts` still passes.
- [ ] **Step 5: Commit** — `feat(fresh-money): exit record and per-tick decision`

---

### Task 3: Move ledger / send / close into a shared server module

**Files:**
- Create: `rs_dashboard/lib/freshMoneyTradeServer.ts`
- Modify: `rs_dashboard/app/api/fresh-money/trade/route.ts` (keeps `GET`, `POST`, idempotency, `reply`, `FreshMoneyTradeState`)

**Interfaces:**
- Consumes: `CloseResult` (Task 2).
- Produces (all moved verbatim from the route, then adjusted as noted):
  - `loadLedger(): FmLedger`, `mutateLedger<T>(fn: (l: FmLedger) => T): Promise<T>` (was `mutate`)
  - `ltpsFor(items: { id: string; segment: FmSegment }[]): Promise<{ ltps: Record<string, number>; source: Record<string, 'ws' | 'rest'> }>`
  - `gateNow(u: string): SessionGate`, `TRADABLE: ReadonlySet<string>`, `todaysBoard(u)`, `buildState(): Promise<FreshMoneyTradeState>` (the type moves here; the route re-exports it so the page imports are unchanged)
  - `placeOrderCore(b: OrderBody): Promise<CloseResult & { http?: number }>` — same checks, returns a result instead of a `NextResponse`
  - `closePositionCore(key: string, reason?: string): Promise<CloseResult>` — the old `closePosition` body; `reason` is written into each close order record. Mapping: nothing sent → `refused`; some slices placed then refusal → `partial`; any UNKNOWN → `unknown` with `partial: placedQty > 0`.
- The route maps `CloseResult` to the exact replies it returns today (status codes, `unknown`, `partial`, `note`).

- [ ] **Step 1: Move the code** — no behaviour change; the route's `closePosition(b)` becomes `closePositionCore(b.key ?? \`dhan|${b.securityId}\`)` + mapping.
- [ ] **Step 2: Verify** — `node --test lib/freshMoneyTrades.test.ts lib/freshMoneyExits.test.ts` pass; `npx tsc --noEmit -p . 2>&1 | grep -i fresh` empty; `npx eslint app/api/fresh-money lib/freshMoneyTradeServer.ts` clean.
- [ ] **Step 3: Verify the live route is unchanged (GET only)** — with a minted session cookie, `curl -s -b "$C" localhost:3000/api/fresh-money/trade` returns the same keys as before (`date, tradable, maxLots, maxPositionLots, sessions, boardExpiry, ltpSource, brokers, positions, orders`). Do not POST.
- [ ] **Step 4: Commit** — `refactor(fresh-money): shared trade server module for the route and the exit watcher`

---

### Task 4: Stamp on entry, edit per position, watcher status in the state

**Files:**
- Modify: `rs_dashboard/lib/freshMoneyExits.ts`, `rs_dashboard/lib/freshMoneyTradeServer.ts`, `rs_dashboard/app/api/fresh-money/trade/route.ts`
- Test: `rs_dashboard/lib/freshMoneyExits.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `buildPositions`, `unconfirmedQty`, `orderKey` from `freshMoneyTrades.ts`.
- Produces:
  - `parseExitDefaults(raw: unknown): { target: ExitSpec | null; sl: ExitSpec | null } | { error: string }` (absent `raw` = both off)
  - `stampExit(orders: FmOrder[], key: string, side: TxnSide, now: number, d: { target: ExitSpec | null; sl: ExitSpec | null }): FmExit | null` — a record only when the contract is flat with nothing unconfirmed and at least one level is set; `dir` from `side`; `state: 'waiting-fill'`.
  - `editExit(x: FmExit | undefined, pos: FmPosition, target: ExitSpec | null, sl: ExitSpec | null, now: number): FmExit | null | { error: string }` — error when `x?.state === 'firing'` or the position is flat; `null` when both levels are null (remove); otherwise `watching` with levels from `pos.avgPrice` (or `waiting-fill` if unknown).
  - Ledger: `sendOne` takes optional `stamp` and writes `l.exits[key] = stampExit(...)` inside the same lock as the precheck/record, only when the order is recorded.
  - Order body: `exitDefaults?: { target?: {value, unit} | null; sl?: … }`. Invalid → reply `{success:false, error}` 400, nothing sent. Success reply `note`: `T 30% · SL 20 pts` when a record was stamped.
  - `POST {action:'setExit', key, target, sl}` → `{success:true}` or `{success:false, error}` 409/400; validated with `validateExitSpec`; done inside `mutateLedger`.
  - `FreshMoneyTradeState` gains `exits: Record<string, FmExit>` and `exitWatcher: { alive: boolean; at: number | null }` (read `debug/fresh_money_exit_watcher.json`, alive when `Date.now() - at <= 10000`).

- [ ] **Step 1: Write the failing tests**
  - `stampExit` on an empty order list with `{target:30%, sl:null}` → record `{state:'waiting-fill', dir:'long'}`; with an open filled position on the key → `null`; with a `pending` order on the key → `null`; both levels null → `null`.
  - **Review Focus 4:** `parseExitDefaults({target:{value:0,unit:'pct'}})` → error; `{target:{value:'abc',unit:'pct'}}` → error; `{target:{value:1e9,unit:'pts'}}` → error; `undefined` → both null.
  - `editExit` on a `firing` record → error; flat position → error; both null → `null`; `pos.avgPrice 100`, target 30% → `watching`, `targetPx 130`.
- [ ] **Step 2: Run, expect FAIL**; **Step 3: Implement**; **Step 4: Run, expect PASS** (`node --test lib/freshMoneyExits.test.ts lib/freshMoneyTrades.test.ts`), tsc and eslint clean.
- [ ] **Step 5: Commit** — `feat(fresh-money): stamp target/SL on entry, per-position edit, watcher status`

---

### Task 5: The watcher

**Files:**
- Create: `rs_dashboard/lib/freshMoneyExitTick.ts` (deps injected, testable), `rs_dashboard/lib/freshMoneyExitServer.ts` (wiring + loop + heartbeat)
- Modify: `rs_dashboard/instrumentation.node.ts` (start beside the Price Ladder, inside the `DASHBOARD_NO_BACKGROUND` guard)
- Test: `rs_dashboard/lib/freshMoneyExitTick.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 (`nextExitAction`, `exitAfterClose`, `buildPositions`, `contractSettling`, `closePositionCore`, `ltpsFor`, `gateNow`, `brokerSessionOk`).
- Produces:
  - `interface ExitTickDeps { now(): number; readLedger(): FmLedger; mutate<T>(fn: (l: FmLedger) => T): Promise<T>; prices(items: { id: string; segment: FmSegment }[]): Promise<Record<string, number>>; canExit(p: FmPosition): boolean; close(key: string, reason: string): Promise<CloseResult>; log(msg: string): void }`
  - `runExitTick(deps: ExitTickDeps, streaks: Map<string, Streak>): Promise<void>` — reads the ledger; no `prices` call when no record is `watching`; applies `resolve` / `drop` / `settle` / `mark-unknown` in one `mutate`; for `fire`: inside `mutate` re-check `state === 'watching'`, set `{state:'firing', firedBy, firedAt}`, then outside the lock `close(key, 'Target hit …' | 'Stop-loss hit …')`, then `mutate` with `exitAfterClose`. `canExit` false → treated like `ltp === null` (streak reset, no fire).
  - `startFreshMoneyExitLoop(): void` — `globalThis` single loop, 2000 ms interval with a busy flag (Price Ladder's `startPriceLadderLoop` pattern), writes `debug/fresh_money_exit_watcher.json` `{pid, at}` every tick, `canExit` = gate `open`/`close-only` and `brokerSessionOk(p.broker)`, log tag `[fm-exit]`.

- [ ] **Step 1: Write the failing tests** with an in-memory fake ledger and a `close` spy:
  - two ticks 2 s apart with LTP above target → `close` called once with the key and a reason starting `Target hit`; record `sent`.
  - a third tick after `sent` does not call `close` again.
  - `close` returns `refused` → record back to `watching` with `retryAt`; a tick before `retryAt` does not call `close`; one after it (and two breaches) does.
  - `close` returns `unknown` → record `unknown`; later ticks never call `close`.
  - no `watching` records → `prices` never called.
  - **Review Focus 3:** one breaching tick, then the fake ledger gains a filled close order on the key (position flat, contract settling) → next tick does not call `close`; after `RECONCILE_GRACE_MS` the record is dropped.
  - `canExit` false → no `close` even after 3 breaching ticks.
- [ ] **Step 2: Run, expect FAIL** — `node --test lib/freshMoneyExitTick.test.ts`.
- [ ] **Step 3: Implement** `freshMoneyExitTick.ts`, then `freshMoneyExitServer.ts` and the `instrumentation.node.ts` import (comment: "Fresh Money: fires per-position target / stop-loss exits with every tab closed. Idle while no position has levels.").
- [ ] **Step 4: Verify** — tests pass; `npm test` passes; tsc/eslint clean; the dashboard log shows `[fm-exit] watcher started` after the next restart and `debug/fresh_money_exit_watcher.json` updates every ~2 s (`stat -c %y` twice, 3 s apart).
- [ ] **Step 5: Commit** — `feat(fresh-money): server watcher for target / stop-loss exits`

---

### Task 6: Page UI

**Files:**
- Modify: `rs_dashboard/components/freshMoney/trading.tsx` (header inputs + watcher chip, order body + toast note, chip hover/marker), `rs_dashboard/components/freshMoney/PositionsOrders.tsx` (Target / SL column + editor), `rs_dashboard/components/FreshMoneyBoard.tsx` (state, pref `freshMoney.exitDefaults`, wiring)
- Create: `rs_dashboard/components/freshMoney/ExitInputs.tsx` — `ExitSpecInput({ label, value, onCommit })`: number box + `% | pts` segmented switch, commit-on-blur/Enter, Escape reverts, invalid → inline amber message and keeps the last good value (uses `validateExitSpec`).

**Interfaces:**
- Consumes: Tasks 1, 4 (`exits`, `exitWatcher` in the state; `setExit`; `exitDefaults` in the order body; `note`).
- Produces: `TradeApi.order` gains `exitDefaults`; `TradeApi.setExit(key: string, target: ExitSpec | null, sl: ExitSpec | null): Promise<boolean>`.

Copy fixed by the spec: header `Target` / `SL`; chip `Exits: watching` / `Exits watcher STOPPED — levels are not being watched` (red, only when `!exitWatcher.alive` and any record exists); badges `waiting fill`, `watching`, `exit sent`, `exit UNKNOWN`, `exit incomplete`; board chip hover `T 130.00 · SL 80.00` or `levels waiting for the fill price`; marker `T/SL`, amber `EXIT?` for `unknown`/`incomplete`. **Review Focus 5:** the editor preview runs `breached(pos.ltp, dir, levels)` and shows `already past — exits within ~4 s` when non-null.

- [ ] **Step 1: Implement** the components; pencil/editor only when armed; Save calls `setExit` and toasts the server error on failure.
- [ ] **Step 2: Verify** — tsc/eslint clean; open `/options/fresh-money` on :3000 (read-only look, disarmed): header inputs render in dark, light and beige; values survive a reload; no console errors.
- [ ] **Step 3: Commit** — `feat(fresh-money): target / SL inputs, watcher chip and per-position editor`

---

### Task 7: Browser test (mocked, no real orders)

**Files:**
- Create: `rs_dashboard/e2e/fresh-money-exits.spec.ts`

**Interfaces:** Consumes Task 6's UI; mocks `/api/fresh-money` (a CRUDEOIL board, `isToday: true`), `/api/fresh-money/live`, `/api/fresh-money/trade` (GET state with one long position + its exit record; POST recorded and answered `{success:true}`), `/api/crudeoil-oi-collector`; any other non-GET → 599 and fail (same rule as `e2e/support.ts`). Signs in with `signIn(context)` from `e2e/support.ts`.

- [ ] **Step 1: Write the tests**
  - typing `30` in Target and tabbing away commits; typing `3` then Escape reverts to the last value.
  - arm, click B on a row → the recorded POST body has `exitDefaults: { target: { value: 30, unit: 'pct' }, sl: … }`; the toast shows the mocked `note`.
  - Positions editor: change SL to `15 pts`, Save → POST `{action:'setExit', key, target, sl:{value:15, unit:'pts'}}`.
  - state with `exitWatcher.alive: false` and one record → the STOPPED chip is visible; `alive: true` → `Exits: watching`.
- [ ] **Step 2: Run** — `E2E_PORT=3000 PW_CHROMIUM_PATH=/usr/bin/google-chrome npx playwright test e2e/fresh-money-exits.spec.ts` → all pass.
- [ ] **Step 3: Commit** — `test(fresh-money): mocked browser test for target / SL`
