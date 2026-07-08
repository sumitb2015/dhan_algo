# Live 1-Min Normalized Chart (NIFTY / BANKNIFTY / CRUDEOILM) — Design

**Date:** 2026-07-08
**Scope:** `rs_dashboard/` — new tab on `/live`, plus one new Python data-fetch script and one new API route.
**Goal:** Let the user compare intraday 1-minute normalized performance of NIFTY, BANKNIFTY, and CRUDEOILM on a single chart, fed by real 1-min OHLC candles (not tick data).

---

## Context

The `/live` page (`rs_dashboard/components/LiveDashboard.tsx`) currently has two tabs:

- **Market** — Nifty 50 equity quotes, backed by `live_equity_ws.py`
- **Normalized** — % change from session open for ~26 NSE indices, backed by `live_indices_ws.py` (a persistent WebSocket bridge that records raw ticks, not OHLC candles), streamed to the frontend via SSE (`/api/live-indices/stream`)

The user wants a **third tab** that plots normalized intraday performance for exactly three instruments — **NIFTY, BANKNIFTY, CRUDEOILM** — using **real 1-minute candle data** fetched from DhanHQ's historical/intraday API, not raw WebSocket ticks. This is a materially different data path from the existing Normalized tab: it needs a commodity future (MCX, `FUTCOM`) alongside two NSE indices, and candles instead of ticks.

Given the "fetch 1-min candles" framing and to avoid managing another long-running background process, this feature uses **polling against a stateless script invocation** — the same pattern already used successfully by `/api/options/candles/route.ts` + `scripts/tools/options_straddle_candles.py` (spawn Python synchronously per request, cache the result briefly, let the frontend poll).

---

## Data Flow

```
Frontend (NormalizedIntradayTab.tsx)
     ↓ fetch() every 45s
/api/live-normalized-1min  (Next.js route)
     ↓ spawnSync (cache hit within 45–60s TTL short-circuits this)
scripts/tools/normalized_1min_candles.py
     ↓ DhanHelper.find_index("NIFTY"/"BANKNIFTY") + find_future("CRUDEOILM")
     ↓ DhanHelper.get_historical_data(interval="1", from_date=today, to_date=today)
DhanHQ intraday_minute_data API
```

No persistent process, no trigger files, no PID tracking — this tab has no start/stop lifecycle, unlike the Market/Normalized tabs.

---

## Changes

### 1. New script — `scripts/tools/normalized_1min_candles.py`

Standalone script (same invocation style as `scripts/tools/options_straddle_candles.py`): instantiate `DhanHelper` once, fetch today's 1-min candles for all three instruments, normalize, print one JSON line to stdout.

**Symbol resolution:**

| Symbol | Resolution call | Segment | Instrument |
|---|---|---|---|
| `NIFTY` | `helper.find_index("NIFTY", exchange="IDX_I")` | `IDX_I` | `INDEX` |
| `BANKNIFTY` | `helper.find_index("BANKNIFTY", exchange="IDX_I")` | `IDX_I` | `INDEX` |
| `CRUDEOILM` | `helper.find_future("CRUDEOILM", exchange="MCX", instrument="FUTCOM")` | `MCX_COMM` | `FUTCOM` |

**Candle fetch:** `helper.get_historical_data(security_id, exchange_segment, instrument_type, from_date=today, to_date=today, interval="1")` for each resolved instrument (today's date in IST, `YYYY-MM-DD`).

**Normalization:** for each series, `pct = (close - first_candle_open) / first_candle_open * 100`, computed independently per instrument (so each starts at 0% at its own session open — relevant because MCX crude opens earlier/later and trades later than NSE).

**Output shape:**
```json
{
  "success": true,
  "data_date": "2026-07-08",
  "series": {
    "NIFTY":     [{ "time": "09:15", "close": 24850.1, "pct": 0.0 }, ...],
    "BANKNIFTY": [{ "time": "09:15", "close": 55210.4, "pct": 0.0 }, ...],
    "CRUDEOILM": [{ "time": "09:00", "close": 5834.0,  "pct": 0.0 }, ...]
  },
  "errors": { "CRUDEOILM": "reason if that one instrument failed" }
}
```
A per-instrument fetch failure does not fail the whole response — partial data (2 of 3 series) is still returned, with the failing symbol reported in `errors`.

### 2. New API route — `rs_dashboard/app/api/live-normalized-1min/route.ts`

- `GET` handler, no query params
- In-memory cache (module-level `Map`/object), 45s TTL — mirrors `/api/options/candles`'s cache pattern
- On cache miss: `spawnSync(PYTHON_EXE, [SCRIPT_PATH], { timeout: 45_000 })`, parse last stdout line as JSON
- Returns `{ success, data_date, series, errors }` (same shape as the script emits)
- Errors (spawn failure, parse failure) return `{ success: false, error }` with status 500, consistent with existing routes

### 3. New frontend tab — `rs_dashboard/components/NormalizedIntradayTab.tsx`

- Polls `/api/live-normalized-1min` every 45s via `setInterval` + `fetch` (plain polling, no SSE/EventSource)
- Recharts `LineChart`, X-axis = `time` (HH:MM, merged/aligned across the three series by time label), Y-axis = `pct`
- Three `<Line>`s: NIFTY, BANKNIFTY, CRUDEOILM, distinct colors consistent with the palette already used in `LiveNormalizedTab.tsx`
- Legend with last known `pct` value per series as a colored badge (e.g. "NIFTY +0.42%")
- `DATA: <data_date>` chip in the tab header, per the dashboard-wide convention for data-currency display
- Handles instruments trading on different schedules: NSE lines (NIFTY/BANKNIFTY) stop extending at 15:30 while CRUDEOILM continues until ~23:30 — chart simply renders however many points each series currently has; no artificial truncation/padding
- If `errors` contains an entry for a symbol, show a small inline warning badge next to that legend entry instead of failing the whole tab

### 4. Wiring — `rs_dashboard/components/LiveDashboard.tsx`

- Add a third tab button "1-Min Normalized" alongside "Market" and "Normalized"
- Renders `<NormalizedIntradayTab />` when selected
- No changes to existing Market/Normalized tab logic, no changes to `live_equity_ws.py` or `live_indices_ws.py`

---

## Error Handling

- Script: wraps each instrument's fetch in its own try/except so one bad symbol doesn't blank the whole response; logs to stderr for debugging via existing `spawnSync` stderr capture pattern
- Route: cache prevents hammering the Python process/DhanHQ API if the frontend's poll and TTL drift; a slow/hanging script is bounded by the 45s `spawnSync` timeout
- Frontend: if `success: false` or all three series are empty, show a single "No data" state instead of an empty chart

## Testing

- Manual: run the script directly (`venv\Scripts\python.exe scripts/tools/normalized_1min_candles.py`) during market hours and verify JSON output shape and normalization math for a couple of hand-checked candles
- Manual: hit `/api/live-normalized-1min` directly and confirm caching (second request within 45s returns identical `data_date`/timestamps without re-invoking Python — verify via a log line or process timing)
- Manual (browser): open `/live`, switch to the new tab, confirm all three lines render and update after the poll interval; verify after NSE close (15:30–23:30) that CRUDEOILM keeps updating while NIFTY/BANKNIFTY lines are static

---

## Files Changed

| File | Action |
|---|---|
| `scripts/tools/normalized_1min_candles.py` | **New** — fetches + normalizes 1-min candles for NIFTY/BANKNIFTY/CRUDEOILM |
| `rs_dashboard/app/api/live-normalized-1min/route.ts` | **New** — cached GET route, spawns the script |
| `rs_dashboard/components/NormalizedIntradayTab.tsx` | **New** — polling frontend tab, Recharts line chart |
| `rs_dashboard/components/LiveDashboard.tsx` | **Edit** — add third tab button + render new component |

## Out of Scope

- Changes to `live_equity_ws.py`, `live_indices_ws.py`, or the existing Market/Normalized tabs
- Start/stop lifecycle, PID tracking, or trigger files (this tab is stateless polling, not a managed bridge process)
- Historical/backtest views of this data — intraday-only, today's session
- Additional instruments beyond NIFTY/BANKNIFTY/CRUDEOILM
