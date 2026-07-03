# India VIX Tab — Options Page

**Date:** 2026-07-03  
**Feature:** New "India VIX" subpage within the Options Charts page, providing intraday VIX visualization for scalpers.

---

## Goal

Give scalpers a dedicated 1-min India VIX chart with a 5-min rate-of-change histogram so they can read volatility regime and velocity at a glance — informing stop-width decisions, option-selling vs. buying bias, and scalp entry timing.

---

## Data Pipeline

### Python script: `scripts/tools/india_vix_candles.py`

- Calls `dhan.intraday_minute_data(security_id="21", exchange_segment="NSE_IDX", instrument_type="INDEX", interval="1", from_date=today, to_date=today)`
- Security ID 21 = India VIX on Dhan (same ID used in `download_indices.py`)
- Computes 5-min rolling ROC on the close: `roc5[i] = (close[i] - close[i-5]) / close[i-5] * 100`  
  - First 5 candles → `roc5 = null`
- Derives day stats from the candle array: `day_open`, `day_high`, `day_low`
- Falls back to `Historical Data/Indices/INDIA_VIX.csv` last two rows for `prev_close` if auth is missing
- Prints a single JSON line to stdout:

```json
{
  "candles": [
    { "time": "09:15", "open": 13.60, "high": 13.75, "low": 13.58, "close": 13.70, "roc5": null },
    { "time": "09:20", "open": 13.70, "high": 13.80, "low": 13.65, "close": 13.78, "roc5": 0.42 }
  ],
  "spot": 13.78,
  "day_open": 13.60,
  "day_high": 13.85,
  "day_low": 13.52,
  "prev_close": 13.24,
  "data_date": "2026-07-03",
  "is_today": true
}
```

- Uses `access_token.json` for auth (same pattern as `options_straddle_candles.py`)
- Exits with a JSON error line if auth or API fails: `{"error": "..."}`

### API route: `rs_dashboard/app/api/options/vix-candles/route.ts`

- `GET` handler only
- Calls `spawnSync(PYTHON_EXE, [VIX_CANDLES_SCRIPT], { encoding: 'utf8', timeout: 45_000 })`
- Parses last line of stdout as JSON
- Server-side cache TTL: **55 seconds** (ensures 60s client polls always get a fresh result)
- Cache key: `"vix-candles"` (no params — always today's data)
- On script error or parse failure: returns `{ success: false, error: "..." }` with HTTP 500
- On success: returns `{ success: true, ...parsed }`

---

## UI

### Tab registration (`OptionsCharts.tsx`)

Add `{ key: 'vix', label: 'India VIX' }` to the tab bar array (after `intelligence`).

Extend the `activeTab` union type: `'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence' | 'vix'`

Add render branch: `{activeTab === 'vix' && <OptionsVixTab />}`

The VIX tab is **independent** — it does not use `expiry`, `bridgeStatus`, or any other shared state from `OptionsCharts`. The expiry selector, start/stop button, and status badge are hidden when this tab is active (same conditional pattern as `activeTab === 'premium'` guards).

### Component: `rs_dashboard/components/OptionsVixTab.tsx`

**State:**
- `data`: parsed API response (candles + stats) or null
- `loading`: boolean
- `error`: string
- `lastUpdated`: Date | null
- `countdown`: number (60 → 0, drives the refresh indicator)

**Polling:** `useEffect` on mount — fetch immediately, then `setInterval(fetch, 60_000)`. A separate `setInterval` counts down the `countdown` every second (reset to 60 on each fetch). Both intervals cleared on unmount.

**Layout (top to bottom):**

1. **Stat row** — 5 tiles in a flex row:
   - `VIX` — current spot, large font, colored by regime (green / yellow / orange / red)
   - `OPEN` — day_open
   - `HIGH` — day_high (emerald)
   - `LOW` — day_low (red)
   - `PREV CLOSE` — prev_close (zinc)

2. **Regime badge** — inline pill next to current VIX:
   - `< 13` → `CALM` (emerald)
   - `13–16` → `NORMAL` (yellow)
   - `16–20` → `ELEVATED` (orange)
   - `> 20` → `FEARFUL` (red)

3. **Main chart (65% of chart area)** — Recharts `LineChart`:
   - Single `Line` for VIX close (`dataKey="close"`, stroke indigo/blue)
   - `ReferenceLine` at `prev_close` — dashed zinc, labelled "PDC"
   - X-axis: time strings, tick every 30 min
   - Y-axis: auto-domain with 5% padding, 2 decimal places
   - Custom tooltip: time + VIX level + ROC (if non-null)
   - No dots on line (performance — up to ~375 candles in a session)

4. **ROC histogram (35% of chart area)** — Recharts `BarChart`:
   - `dataKey="roc5"`, bars colored: positive → `#10b981` (emerald-500), negative → `#ef4444` (red-500)
   - `ReferenceLine` at y=0 (zinc dashed)
   - Y-axis label: "ROC 5m %"
   - Candles where `roc5 === null` are filtered out before rendering
   - Tooltip: "ROC 5m: +0.42%"

5. **Footer bar:**
   - `DATA: YYYY-MM-DD` chip (zinc-700 bg, zinc-300 text)
   - `Last updated: HH:MM:SS` (zinc-500)
   - Countdown chip: `Refresh in Xs` (pulses amber when ≤ 10s)

**Error state:** Full-width error card with message + manual retry button.  
**Loading state:** Skeleton shimmer on stat tiles + chart area (or spinner on first load).

---

## File Checklist

| File | Action |
|------|--------|
| `scripts/tools/india_vix_candles.py` | Create |
| `rs_dashboard/app/api/options/vix-candles/route.ts` | Create |
| `rs_dashboard/components/OptionsVixTab.tsx` | Create |
| `rs_dashboard/components/OptionsCharts.tsx` | Edit — add tab + render branch |

---

## Out of Scope

- Historical VIX (multi-day) — daily CSV exists but not shown here
- VIX futures or term structure
- Alert/notification on VIX spike threshold
- Correlation with straddle premium (requires options bridge running)
