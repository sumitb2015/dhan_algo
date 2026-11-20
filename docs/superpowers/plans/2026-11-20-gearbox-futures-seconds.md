# Gearbox Futures + Seconds Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add FUT legs and 5/10/20/30-second bars to `/gearbox`.

**Architecture:** FUT is a third `DirLeg.opt`; the server resolves it to the signal future and orders it through `placePnfMarket`
(tag `gbx`). Seconds bars come from `usePnfFeed(target, 0, now, tickSec)`; a server job keeps the crude future in the bridge's tick log.

**Tech Stack:** Next.js 16, TypeScript, `node --test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-20-gearbox-futures-seconds-design.md` (and the original `2026-11-20-gearbox-drive-design.md`).

## Global Constraints
- REAL Dhan only, 1 lot per order and position; SIM ≤ 10 lots; tag `gbx` stays capped at 1 (`dhanSourceCaps.ts`, `kotakOrderRules.ts`).
- Server future price ≤ 10 s old for any open; unknown never resent; exits own units only.
- Never touch the user's Signal Orb changes ('orba' uncapped). Stage files by explicit path only — the user commits on master in parallel.
- Theme tokens only; no hex. Never start `next dev`; :3000 runs `next start`. e2e only on an isolated copy (`next build` + `next start -p 3101`, `DASHBOARD_NO_BACKGROUND=1`), then delete it.
- Commits on master, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. FUT leg with a stale or missing future price → refused, nothing sent (Task A test).
2. A `/renko` / P&F close on the same future keeps Gearbox's FUT units (Task A test of the helper / reader list).
3. Switching from 1 min to 10 s with no tick log yet → "warming up", no gear, buttons off (Task C e2e).
4. A saved config from before this change (`opt` CE/PE only, `tf` 1/3/5) still loads unchanged (Task A test).
5. Square-off of a FUT row with the tab closed → exitOwn on the future (Task A test).

---

### Task A: FUT legs in ledger, server, square-off and hold-back
**Files:** Modify `lib/gearboxLedger.ts`, `lib/gearboxCore.ts`, `lib/gearboxSquareOffCore.ts` (only if FUT needs it), `lib/pnfAutoOrders.ts` (`fromOther`), tests in `lib/gearboxLedger.test.ts`, `lib/gearboxServer.test.ts`, `lib/gearboxSquareOff.test.ts`, `lib/gearboxOrderHooks.test.ts`.
**Interfaces — Produces:** `DirLeg.opt: 'CE' | 'PE' | 'FUT'`; `GbConfig.tf: 1 | 3 | 5 | '5s' | '10s' | '20s' | '30s'` (stored as given; Task C consumes); `pickTarget` returns the signal future `Target` (kind `'futures'`) for FUT; `gbState().body.contracts` shows the future for a FUT direction.
- [ ] Tests first: sanitize accepts FUT (offset forced 0) and the new tf values, rejects others; old stored config loads unchanged; FUT SIM open books the future price as entry; FUT REAL open sends 1 lot BUY/SELL on the future with tag gbx and INTRADAY; stale future price refuses FUT; FUT exit uses exitOwn on the future; square-off closes a FUT row (SIM at future price / lastLtp); reverse LONG BUY FUT → SHORT BUY PE works; `rowPnl` for FUT SELL 1 lot CRUDEOIL 6000→5990 = +1000; the close hold-back keeps Gearbox FUT units (via the existing pure helper or a new one for `fromOther`).
- [ ] Implement. For FUT rows, `lastLtp` and SIM prices come from the future's price (`deps.price`), not `optionPrice`.
- [ ] `node --test` focused files, `npx tsc --noEmit -p .`, `npm test` (known nseHolidays failure). Commit `feat(gearbox): trade the crude future (FUT legs)`.

### Task B: seconds bars and crude always-recorded
**Files:** Create `lib/gearboxAlwaysRecord.ts` (+ `lib/gearboxAlwaysRecordCore.ts` and test if logic is non-trivial), modify `instrumentation.node.ts`, `components/gearbox/useGearboxEngine.ts`, `lib/gearboxBars.ts` (+ test).
**Interfaces — Consumes:** `GbConfig.tf` from Task A; `askBridge`, `ensureBridge` (`lib/pnfLiveBridge.ts`); `mcxSession`; the signal future id (`futureTarget` / `resolveFuture`).
- [ ] Always-record: every 1 s while `mcxSession(today)` is open (open ≤ IST minute < close), ask the bridge for the configured underlying's signal future and every live FUT row's future (asker `gearbox-record:<seg>:<id>`), as `lib/pnfAlwaysRecord.ts` does for NIFTY; start from `instrumentation.node.ts` inside the `DASHBOARD_NO_BACKGROUND` guard. Test the pure "which pairs, is the window open" function.
- [ ] Engine: for a seconds tf, call `usePnfFeed(future, 0, now, seconds)` and use its bars as-is (already N-second, closed except the last); keep 1/3/5-min path unchanged. Closed-bar key must change once per N seconds, not per tick. Test any new pure bucketing helper.
- [ ] Verify as Task A. Commit `feat(gearbox): 5-30 second bars from the WebSocket tick log`.

### Task C: page controls, e2e and guide
**Files:** `components/gearbox/DirectionMap.tsx`, the bar-size picker component, `e2e/gearbox.spec.ts`, `docs/GEARBOX_GUIDE.md`, CLAUDE.md line for gearbox (one clause).
- [ ] DirectionMap: FUT choice; offset and expiry hidden for FUT; SELL FUT shows "margin, unlimited risk"; ⚠ rule per spec; summary reads e.g. "↑ BUY FUT CRUDEOILM DEC".
- [ ] Bar-size picker: 5s/10s/20s/30s plus 1/3/5 min; seconds shows "more trades and whipsaws"; locked while a row is live (as today).
- [ ] e2e (mocked, isolated build): FUT map round trip (open posts dir only, held FUT leg shown); 10 s warming state; SELL FUT note. No real-order case.
- [ ] Guide: FUT section, seconds bars section (0.5 s sampling, always-recorded only during MCX session, warm-up), updated "what other pages can close". Commit `feat(gearbox): FUT and seconds bars on the page, e2e, guide`.
