# Straddle Simulator page — design

Date: 2026-10-26. Status: approved by the user's instruction to build it ("build the simulator"); derived from the user's screenshots of the video's simulator prompt and UI. Builds on `2026-10-25-straddle-pnf-design.md` (the live page) and reuses its engine.

## Purpose
`/straddle-simulator` (Scalping group): replay past sessions of the three NIFTY straddles (ATM-200 / ATM / ATM+200) as if live — same P&F charts, VWAP/SMA10, double-top-buy / double-bottom-sell bars, alerts and 30-entry log — so the user can practise and judge the signals without live money. Signals only; no orders.

## From the brief (user's screenshots)
- Inputs: index (nifty/sensex), start date, end date, expiry; the dates must be older than today (enforced). Load button.
- Speeds 1X, 50X, 100X, 200X; Play/Pause, Reset; a progress slider and a clock ("Mon 12 Oct 09:15 · minute N of M") and the replayed spot.
- The chart starts with one day already loaded: the session just before the FROM day, so VWAP is accurate (VWAP is continuous across the loaded range, as on the live page; it does NOT reset each morning).
- "Without touching any of the existing files": the page, components, route, script and libs are new; the only edit to an existing file is one Sidebar link. Existing modules (engine, PnfPanel, AlertLog, alertSound) are imported, not modified.

## Decisions
- **NIFTY only.** `Options Data/nifty_options.db` holds NIFTY options only (no SENSEX, no BANKNIFTY): the index selector shows SENSEX disabled with the reason. Strikes are ATM±10 relative, so fixed absolute strikes ATM-200/ATM/ATM+200 are served as long as spot stays within the stored window (coverage is reported per strike).
- **Expiry first.** The data is stored per expiry (about 6 sessions each, newest 2026-10-19). The user picks an expiry (newest first), then From/To inside that expiry's data range and strictly before today (IST); at most 6 replayed sessions. A day before From inside the same expiry is preloaded when it exists.
- **ATM** = "Auto" (the ATM at the first bar of the From day) or a typed strike (multiple of 50); fixed for the whole replay.
- **Replay clock.** One step = one 1-min bar closing. ms per bar = 60000 / speed (1X = a bar a minute, 200X = 0.3 s). Alerts fire only for replayed bars; the preload and any bars skipped by scrubbing never alert. Scrubbing back re-derives the charts from the bars up to the cursor.
- **Alerts** use the same engine, bar-time watermark, toast, panel flash, chime (mute stored under its own localStorage key) and log (last 30).
- DATA chip = the session date of the bar being replayed (from the payload).

## Components
1. `scripts/tools/straddle_sim_data.py` — modes `expiries` (list with first/last session) and `load` (bars for three strikes + spot series), read-only SQLite (`mode=ro`).
2. `rs_dashboard/lib/straddleSim.ts` — pure: param validation, speeds / ms per bar, session math, replay cursor helpers, clock label.
3. `rs_dashboard/app/api/straddle-simulator/route.ts` — GET `?mode=expiries` and `?expiry&from&to&atm`.
4. `rs_dashboard/app/straddle-simulator/page.tsx` + `components/StraddleSimulatorPage.tsx` — controls, playback, three `PnfPanel`s, `AlertLog`.
5. Sidebar link.

## Errors / edge cases
No data for the range → clear message. A strike with partial coverage → per-panel note. From/To today or later, From > To, outside the expiry's range, > 6 sessions, SENSEX → 400 with the reason. The DB missing → error JSON (it is gitignored).

## Testing
Python: temp SQLite fixture (merge, preload day, ATM auto, coverage). TS: `straddleSim` unit tests. Playwright with mocked `/api/*`: load, play at 200X reveals bars and fires exactly one alert for a replayed double bottom, history/preload never alerts, pause/reset/scrub, validation message for a date ≥ today.

## Out of scope
SENSEX data (does not exist), algo / paper / live trading, tick-level (sub-minute) interpolation, Python/DB writes.
