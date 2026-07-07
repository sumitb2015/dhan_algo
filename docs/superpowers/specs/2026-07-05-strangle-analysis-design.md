# Strangle Premium Analysis — Design Spec

_Date: 2026-07-05_

## Context

The dashboard already has a Straddle Premium Analysis page (`/straddle-analysis`) that shows comprehensive metrics for NIFTY ATM straddles — opening premiums, weekday/DTE breakdowns, distribution, decay curves, monthly trend, and intraday range. Traders also sell strangles (OTM CE + OTM PE) and need the same statistical view but with a configurable offset (how many strikes OTM each leg is). This page replicates the straddle analysis for strangles, letting the user choose which offset to examine.

## Data Source

Same SQLite DB: `Options Data/nifty_options.db`, table `option_prices`.

For a strangle with offset N:
- CE leg: `strike_relative = 'ATM+N'`
- PE leg: `strike_relative = 'ATM-N'`
- Combined premium: `close_CE + close_PE` (same formula as straddle)

Available offsets: 1–10 (ATM±1 through ATM±10, all present in DB).
Strangle is always **symmetric** — same offset for both legs.

## Architecture

### 1. Python script — `scripts/analysis/strangle_premium_analysis.py`

Mirrors `straddle_premium_analysis.py` with these differences:
- Outer loop over offsets 1–10; inner logic identical to straddle script per offset.
- Query: `WHERE strike_relative IN ('ATM+N', 'ATM-N')` per offset iteration.
- Pivot/join CE and PE on `(expiry, datetime)` and compute `straddle_close = close_CE + close_PE`.
- Regime split at `2025-09-01` (pre = Thu weekly, post = Tue weekly), same as straddle.
- `compute_regime_stats()` runs for all three regime views per offset.
- Output: `debug/strangle_premium_analysis.json`

```json
{
  "offset_1": { "regimes": { "all": {...}, "pre_sep2025": {...}, "post_sep2025": {...} } },
  "offset_2": { ... },
  ...
  "offset_10": { ... }
}
```

Each regime object is **structurally identical** to the straddle output — same keys, same metric sections — so the frontend component can reuse the same rendering logic.

Progress written to `debug/strangle_analysis_status.json` (same `{status, pct, message}` shape as straddle).

### 2. API routes — `app/api/strangle-analysis/`

- `route.ts`: GET reads `debug/strangle_premium_analysis.json`; POST spawns the Python script (same 409-guard against double-run).
- `status/route.ts`: GET reads `debug/strangle_analysis_status.json`.

Copied from straddle routes with path strings changed.

### 3. Component — `components/StrangleAnalysis.tsx`

Close clone of `StraddleAnalysis.tsx`. All 8 metric sections are identical in structure.

**Additions to the header bar:**
- Offset button group: `[1][2][3][4][5][6][7][8][9][10]` — default **2**.
- Switching offset reads `data[`offset_${n}`]` from the already-loaded JSON — no API call.

**Label changes:**
- Page title / section headers say `ATM+N / ATM-N Strangle` reflecting the selected offset (e.g. "ATM+2 / ATM-2 Strangle Premium Analysis").

**Header layout (sticky bar):**
```
[All] [Pre Sep'25] [Post Sep'25]    Offset: [1]...[10]    [All][3Y][2Y][1Y]    [Regenerate]
```

### 4. Page — `app/strangle-analysis/page.tsx`

Thin wrapper identical to `app/straddle-analysis/page.tsx`, renders `<StrangleAnalysis />`.

### 5. Navigation

Add "Strangle Analysis" link in the sidebar/nav alongside the existing "Straddle Analysis" entry.

## Metric Sections (identical to straddle)

1. KPI row: Trading Days, Expiries, Date Range, Avg/Median/High/Low Opening Premium, Seller Win Rate, Avg Daily Decay %
2. Opening Premium by Weekday — bar chart + stats table
3. Opening Premium by DTE — composed chart (avg/median/P25/P75) + stats table
4. Premium Distribution — histogram + normal curve + mini stats
5. Decay Analysis — DTE curve + intraday decay by DTE bucket
6. Premium Trend Over Time — monthly avg area chart (filtered by date range selector)
7. Intraday Range Analysis — range by DTE and by weekday
8. Key Observations — auto-generated bullet insights

## Verification

1. Run `venv\Scripts\python.exe scripts/analysis/strangle_premium_analysis.py` — confirm `debug/strangle_premium_analysis.json` is created with keys `offset_1` through `offset_10`, each containing three regime objects.
2. `cd rs_dashboard && npm run dev` — navigate to `/strangle-analysis`.
3. Confirm all 8 metric sections render for default offset 2.
4. Toggle through several offsets — verify metrics update without page reload or API call.
5. Toggle regimes — verify regime switch works same as straddle page.
6. Click Regenerate — verify progress bar appears, script runs, data reloads on completion.
7. Confirm nav link is present and routes correctly.
