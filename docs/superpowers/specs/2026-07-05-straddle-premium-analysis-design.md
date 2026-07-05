# Straddle Premium Analysis Page — Design Spec
*Date: 2026-07-05*

## Context

We have 5.5 years (Dec 2020 – Jun 2026) of NIFTY ATM option 1-minute OHLCV data in `Options Data/nifty_options.db` (7.2 GB SQLite). The dashboard currently has no page that analyses historical straddle premium patterns. Traders selling NIFTY straddles need to understand: what is a typical opening premium by weekday and DTE, how does it decay, and when is the seller's edge highest. This page answers those questions from historical data.

---

## Architecture: Option A — Pre-computed JSON Cache

The SQLite DB is too large to query on every page load. A Python analysis script runs once (or on demand) and writes a structured JSON cache. The Next.js API reads only the cache file — page loads are <100ms.

---

## Data Pipeline

### Python Script: `scripts/analysis/straddle_premium_analysis.py`

**Input**: `Options Data/nifty_options.db`
- Table `option_prices`: columns `expiry, datetime, option_type, strike, strike_relative, open, high, low, close, spot, volume, oi, iv`

**Query logic**:
1. Filter `strike_relative = 0` (ATM) and `option_type IN ('CE', 'PE')`
2. For each `(expiry, date)` pair, pivot CE and PE rows
3. **Opening premium**: `CE_close + PE_close` at `datetime` ending in `09:15:00`
4. **Closing premium**: same at last candle (`15:29:00` or last available)
5. **Day high**: `CE_high + PE_high` per candle, then max across the session — a proxy; CE and PE don't peak simultaneously, so this slightly overstates the true straddle high
6. **Day low**: `CE_low + PE_low` per candle, then min across the session — same caveat, slightly understates true straddle low
7. **DTE**: `(expiry_date − trading_date).days` — capped at 7, grouped as 0/1/2/3/4/5+
8. **Weekday**: `trading_date.weekday()` → 0=Mon … 4=Fri

**Intraday decay**: for each DTE bucket (0/1/2/3+), compute average `CE_close + PE_close` at every minute across all matching days — produces average intraday decay curves.

**Output**: `debug/straddle_premium_analysis.json`

```jsonc
{
  "generated_at": "2026-07-05T10:30:00",
  "date_range": { "from": "2020-12-31", "to": "2026-06-30" },
  "total_days": 1250,          // total (expiry, trading_date) pairs with valid open data
  "total_expiries": 286,

  "summary": {
    "overall_avg": 145.2,
    "overall_median": 138.5,
    "overall_min": 62.0,
    "overall_max": 412.0,
    "avg_daily_decay_pct": 28.4,   // avg (open - close) / open * 100
    "seller_win_pct": 72.3         // % of days where close < open
  },

  "by_weekday": {
    "Monday": { "count": 248, "avg": 152.1, "median": 145.0, "min": 70.0, "max": 390.0, "std": 42.1, "p25": 120.0, "p75": 175.0, "p90": 210.0, "seller_win_pct": 70.1, "avg_decay_pct": 27.0 },
    "Tuesday": { ... },
    "Wednesday": { ... },
    "Thursday": { ... },
    "Friday": { ... }
  },

  "by_dte": {
    "0": { "count": 260, "avg": 98.2, "median": 92.0, "min": 42.0, "max": 260.0, "std": 35.0, "p25": 72.0, "p75": 118.0, "p90": 148.0, "seller_win_pct": 82.0, "avg_decay_pct": 41.2 },
    "1": { ... },
    "2": { ... },
    "3": { ... },
    "4": { ... },
    "5+": { ... }
  },

  "distribution": {
    "bins": [40, 60, 80, ...],    // bin edges
    "counts": [12, 28, 45, ...],  // observation counts per bin
    "mean": 145.2,
    "std": 48.3,
    "median": 138.5,
    "skew": 0.82,
    "kurtosis": 1.1,
    "p10": 88.0, "p25": 112.0, "p75": 172.0, "p90": 210.0,
    "min": 62.0, "max": 412.0
  },

  "decay_dte_curve": [
    { "dte": 5, "avg": 198.0, "p25": 155.0, "p75": 238.0 },
    { "dte": 4, "avg": 182.0, ... },
    { "dte": 3, "avg": 165.0, ... },
    { "dte": 2, "avg": 142.0, ... },
    { "dte": 1, "avg": 118.0, ... },
    { "dte": 0, "avg": 98.2,  ... }
  ],

  "intraday_decay": {
    "0": [{ "time": "09:15", "avg": 98.2, "p25": 72.0, "p75": 118.0 }, ...],
    "1": [...],
    "2": [...],
    "3+": [...]
  },

  "monthly_trend": [
    { "month": "2021-01", "avg": 135.0, "count": 18 },
    ...
  ],

  "range_analysis": {
    "by_dte": {
      "0": { "avg_range": 38.2, "avg_range_pct": 39.0 },
      ...
    },
    "by_weekday": {
      "Monday": { "avg_range": 42.1, "avg_range_pct": 27.7 },
      ...
    }
  },

  "insights": [
    "Thursday 0-DTE has the highest seller win rate at 85%.",
    "Opening premium on expiry day (0 DTE) averages ₹98 — 48% lower than 5-DTE days (₹198).",
    "2022 had the highest average opening premium (₹195), 37% above the overall mean.",
    "Sellers who shorted at open and covered at close won on 72% of all days."
  ]
}
```

### API Route: `rs_dashboard/app/api/straddle-analysis/route.ts`

- **GET**: reads `debug/straddle_premium_analysis.json`, returns it. If file missing, returns `{ error: "not_generated" }`.
- **POST** `{ action: "regenerate" }`: spawns `scripts/analysis/straddle_premium_analysis.py` as a background process; writes progress to `debug/straddle_analysis_status.json` (`{ status: "running"|"done"|"error", pct: 0-100, message: "..." }`). Client polls GET `/api/straddle-analysis/status` (second sub-route) for progress.

---

## Page: `/straddle-analysis`

**File**: `rs_dashboard/app/straddle-analysis/page.tsx`
**Component**: `rs_dashboard/components/StraddleAnalysis.tsx`

### Sticky Header
- Title: "Straddle Premium Analysis"
- `DATA: YYYY-MM-DD` chip (from `generated_at`)
- Date range pill filter: **All / 3Y / 2Y / 1Y** (client-side filter on `monthly_trend` and raw data slices — the JSON always has full history; filters apply to all charts simultaneously)
- "Regenerate" button — triggers POST regenerate, shows inline progress bar while running, disables button

### Section 1 — KPI Row (5 tiles)
| Tile | Value |
|------|-------|
| Total Days Analyzed | `total_days` |
| Avg Opening Premium | `summary.overall_avg` |
| Highest Opening Premium | `summary.overall_max` |
| Lowest Opening Premium | `summary.overall_min` |
| Seller Win Rate | `summary.seller_win_pct %` |

### Section 2 — Weekday Analysis
- **Bar chart**: avg opening premium Mon–Fri, error bars ±1 std (Recharts BarChart)
- **Table**: Weekday | Count | Avg | Min | Max | Median | P25 | P75 | Seller Win%
- Color: each weekday gets its own color from the palette; Monday = first color

### Section 3 — DTE Analysis
- **Line chart**: avg opening premium vs DTE (0→5+) with shaded P25–P75 band (area between two lines)
- **Table**: DTE | Count | Avg | Min | Max | Median | Seller Win% | Avg Decay %

### Section 4 — Distribution Analysis
- **Histogram** (BarChart with bin edges on x-axis): count of days per premium bucket, with normal curve overlay (computed from mean+std)
- Stats row beneath: Mean · Std Dev · Median · Skew · Kurtosis · P10 · P90

### Section 5 — Decay Analysis (two charts, side by side on desktop, stacked on mobile)
- **Left — DTE Decay Curve**: line chart of `decay_dte_curve` (DTE 5→0 on x-axis, avg premium on y). Shaded band P25–P75. Title: "How Premium Shrinks Toward Expiry"
- **Right — Intraday Decay Curves**: four lines (0 DTE / 1 DTE / 2 DTE / 3+ DTE), x-axis = time 9:15→15:30, y-axis = avg straddle premium. Title: "Average Intraday Premium Curve by DTE"

### Section 6 — Premium Trend Over Time
- **Area chart**: monthly avg opening premium (Jan 2021→present) from `monthly_trend`
- Tooltip shows month, avg, count
- Allows spotting high-IV regimes (2022 bear market, election months, etc.)

### Section 7 — Range & Seller Performance
- **Two sub-panels side by side**:
  - Left: Avg intraday straddle range by DTE (bar chart from `range_analysis.by_dte`) — titled "Day Range vs DTE"
  - Right: Avg intraday range by weekday (bar chart from `range_analysis.by_weekday`) — titled "Day Range vs Weekday"
- Below: mini table — DTE | Avg Range | Range/Open % | Seller Win% — gives a quick read on which DTE has highest absolute decay vs relative

### Section 8 — Insights Panel
- Card with auto-generated bullets from `insights[]` array
- Each bullet prefixed with a colored dot (green = seller-positive, amber = neutral, red = risk)
- Title: "Key Observations"

---

## Visual Design

- Dark theme consistent with existing dashboard (zinc-900 background, zinc-800 cards)
- Section headers: `text-xs font-bold text-white` on `bg-zinc-800` — matching existing table header convention
- Chart colors: Recharts with the project's existing color usage pattern (emerald for positive/seller, rose for negative, sky/violet/amber for categorical series)
- All numbers formatted: premiums as `₹XXX.X`, percentages as `XX.X%`, counts with comma separators
- Responsive: KPI tiles wrap on mobile; side-by-side charts stack vertically on `<md`

---

## Verification

1. Run `venv\Scripts\python.exe scripts/analysis/straddle_premium_analysis.py` — should complete in <90s and write `debug/straddle_premium_analysis.json`
2. Verify JSON has all expected keys and plausible values (avg ~130–160, max <500)
3. Start dashboard (`cd rs_dashboard && npm run dev`), navigate to `http://localhost:3000/straddle-analysis`
4. Confirm all 8 sections render with real data
5. Test "Regenerate" button — progress bar should appear, button disables, re-enables on completion
6. Test date range filter — charts should update for All/3Y/2Y/1Y selections
7. Verify `DATA:` chip shows correct date from `generated_at`
8. Check mobile layout (browser devtools) — KPI tiles wrap, charts remain readable

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `scripts/analysis/straddle_premium_analysis.py` | Create |
| `rs_dashboard/app/api/straddle-analysis/route.ts` | Create |
| `rs_dashboard/app/api/straddle-analysis/status/route.ts` | Create |
| `rs_dashboard/app/straddle-analysis/page.tsx` | Create |
| `rs_dashboard/components/StraddleAnalysis.tsx` | Create |

No existing files are modified. The new page is fully additive.
