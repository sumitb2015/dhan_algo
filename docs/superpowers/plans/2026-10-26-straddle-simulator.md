# Straddle Simulator Implementation Plan

> Execute inline (native), TDD per task, one commit per task. **Spec:** `docs/superpowers/specs/2026-10-26-straddle-simulator-design.md`

**Goal:** `/straddle-simulator`: replay past NIFTY straddle sessions through the live page's P&F engine at 1X/50X/100X/200X.

**Global constraints:** signals only; reuse (do not modify) `lib/straddlePnf*.ts`, `components/straddlePnf/*`, `lib/alertSound.ts`; read-only SQLite; dates strictly before today IST; no hardcoded colours; localStorage in try/catch; new e2e must refuse unmocked non-GET.

**Review focus:** a replay must never alert for preload/skipped bars; scrubbing back must not re-alert; a typed ATM with partial strike coverage must not crash; date validation at the boundary (today, From>To, outside range).

### Task 1 — `scripts/tools/straddle_sim_data.py` (+ `tests/test_straddle_sim_data.py`)
Pure helpers `session_rows(...)`, `build_payload(conn, expiry, from, to, atm, preload=True)`; CLI `--mode expiries|load --expiry --from --to --atm`. Output `{ expiry, atm, strikes, bars:{strike:[{t,ce,pe,straddle,vol}]}, spotT, spotV, preloadSession, sessions:[...], coverage:{strike:n} }`. Test with a temp DB.
### Task 2 — `lib/straddleSim.ts` (+test)
`SPEEDS=[1,50,100,200]`, `msPerBar(speed)`, `validateSimParams`, `revealedBars`, `clockLabel`, `stepForward/seek` helpers.
### Task 3 — `app/api/straddle-simulator/route.ts`
Validate with Task 2 helper, spawn Task 1 script, cache, errors. Verify with a minted cookie.
### Task 4 — page, components, sidebar, e2e
Controls + playback + panels + alert log; Playwright spec.
