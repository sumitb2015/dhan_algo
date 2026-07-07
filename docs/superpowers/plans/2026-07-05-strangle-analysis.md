# Strangle Premium Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/strangle-analysis` page that mirrors the straddle premium analysis page but for OTM strangles, with a user-selectable offset (1–10) that controls how many strikes OTM each leg is.

**Architecture:** A Python script pre-computes all 10 offsets in one run, writing a single JSON file keyed by `offset_N`. Two Next.js API routes serve that file and spawn the script. A new `StrangleAnalysis.tsx` component clones `StraddleAnalysis.tsx` with a symmetric offset selector added to the sticky header, switching offsets entirely client-side.

**Tech Stack:** Python 3, pandas, numpy, scipy, sqlite3; Next.js App Router, React, Recharts, TypeScript.

## Global Constraints

- All Python must run from project root via `venv\Scripts\python.exe` (Windows venv).
- DB path: `Options Data/nifty_options.db`, table `option_prices`.
- Script output: `debug/strangle_premium_analysis.json`.
- Status file: `debug/strangle_analysis_status.json` with shape `{ status, pct, message }`.
- Never use Tailwind text-color opacity modifiers (e.g. `text-white/70`); use solid zinc colors.
- Table headers: `text-xs font-bold text-white bg-zinc-800`.
- `PROJECT_ROOT` in API routes: `path.resolve(process.cwd(), '..')`.

---

## File Map

| Action | Path |
|--------|------|
| Create | `scripts/analysis/strangle_premium_analysis.py` |
| Create | `rs_dashboard/app/api/strangle-analysis/route.ts` |
| Create | `rs_dashboard/app/api/strangle-analysis/status/route.ts` |
| Create | `rs_dashboard/components/StrangleAnalysis.tsx` |
| Create | `rs_dashboard/app/strangle-analysis/page.tsx` |
| Modify | `rs_dashboard/components/NavBar.tsx` |

---

## Task 1: Python analysis script

**Files:**
- Create: `scripts/analysis/strangle_premium_analysis.py`

**Interfaces:**
- Produces: `debug/strangle_premium_analysis.json` with shape:
  ```json
  {
    "generated_at": "ISO string",
    "regime_cutoff": "2025-09-01",
    "offset_1": { "regimes": { "all": <AnalysisData>, "pre_sep2025": <AnalysisData>, "post_sep2025": <AnalysisData> } },
    "offset_2": { ... },
    ...
    "offset_10": { ... }
  }
  ```
  where `<AnalysisData>` is identical in structure to the straddle script's regime output.

- [ ] **Step 1: Create the script**

```python
#!/usr/bin/env python3
"""
Strangle Premium Analysis
Queries nifty_options.db for OTM CE+PE pairs at offsets 1-10 from ATM.
For each offset N, joins ATM+N (CE) with ATM-N (PE) and computes the same
statistics as the straddle analysis across three regime views.
Writes debug/strangle_premium_analysis.json.
"""

import json
import sqlite3
import sys
from datetime import datetime, date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

PROJECT_ROOT  = Path(__file__).resolve().parents[2]
DB_PATH       = PROJECT_ROOT / "Options Data" / "nifty_options.db"
OUTPUT_PATH   = PROJECT_ROOT / "debug" / "strangle_premium_analysis.json"
STATUS_PATH   = PROJECT_ROOT / "debug" / "strangle_analysis_status.json"

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
REGIME_CUTOFF = date(2025, 9, 1)
OFFSETS       = list(range(1, 11))


def write_status(status: str, pct: int, message: str) -> None:
    try:
        STATUS_PATH.write_text(
            json.dumps({"status": status, "pct": pct, "message": message}),
            encoding="utf-8",
        )
    except Exception:
        pass


def npct(arr: np.ndarray, p: float) -> float:
    return float(np.percentile(arr, p)) if len(arr) > 0 else 0.0


def agg_stats(series: pd.Series) -> dict:
    arr = series.dropna().values
    if len(arr) == 0:
        return {"count": 0}
    return {
        "count":  int(len(arr)),
        "avg":    round(float(np.mean(arr)), 2),
        "median": round(float(np.median(arr)), 2),
        "std":    round(float(np.std(arr)), 2),
        "min":    round(float(np.min(arr)), 2),
        "max":    round(float(np.max(arr)), 2),
        "p10":    round(npct(arr, 10), 2),
        "p25":    round(npct(arr, 25), 2),
        "p75":    round(npct(arr, 75), 2),
        "p90":    round(npct(arr, 90), 2),
    }


def compute_regime_stats(daily: pd.DataFrame, merged: pd.DataFrame) -> dict:
    """Return all aggregated statistics for a given (already filtered) daily/merged pair."""
    if len(daily) == 0:
        return {
            "date_range": {"from": "", "to": ""},
            "total_days": 0, "total_expiries": 0,
            "summary": {}, "by_weekday": {}, "by_dte": {},
            "distribution": {}, "decay_dte_curve": [],
            "intraday_decay": {}, "monthly_trend": [],
            "range_analysis": {"by_dte": {}, "by_weekday": {}},
            "insights": ["No data available for this regime."],
        }

    # ── by_weekday ─────────────────────────────────────────────────────────────
    by_weekday: dict = {}
    for day in WEEKDAY_NAMES:
        sub = daily[daily["weekday"] == day]
        if len(sub) == 0:
            continue
        s = agg_stats(sub["open_premium"])
        s["seller_win_pct"] = round(float(sub["seller_win"].mean() * 100), 1)
        s["avg_decay_pct"]  = round(float(sub["decay_pct"].mean()), 1)
        s["avg_range"]      = round(float(sub["day_range"].mean()), 1)
        s["avg_range_pct"]  = round(float(sub["range_pct"].mean()), 1)
        by_weekday[day] = s

    # ── by_dte ─────────────────────────────────────────────────────────────────
    by_dte: dict = {}
    for label in ["0", "1", "2", "3", "4", "5+"]:
        sub = daily[daily["dte"] >= 5] if label == "5+" else daily[daily["dte"] == int(label)]
        if len(sub) == 0:
            continue
        s = agg_stats(sub["open_premium"])
        s["seller_win_pct"] = round(float(sub["seller_win"].mean() * 100), 1)
        s["avg_decay_pct"]  = round(float(sub["decay_pct"].mean()), 1)
        s["avg_range"]      = round(float(sub["day_range"].mean()), 1)
        s["avg_range_pct"]  = round(float(sub["range_pct"].mean()), 1)
        by_dte[label] = s

    # ── distribution ───────────────────────────────────────────────────────────
    premiums = daily["open_premium"].dropna().values
    hist_counts, hist_edges = np.histogram(premiums, bins=25)
    distribution = {
        "bins":     [round(float(e), 1) for e in hist_edges.tolist()],
        "counts":   hist_counts.tolist(),
        "mean":     round(float(np.mean(premiums)), 2),
        "std":      round(float(np.std(premiums)), 2),
        "median":   round(float(np.median(premiums)), 2),
        "skew":     round(float(scipy_stats.skew(premiums)), 3),
        "kurtosis": round(float(scipy_stats.kurtosis(premiums)), 3),
        "min":      round(float(np.min(premiums)), 2),
        "max":      round(float(np.max(premiums)), 2),
        "p10":      round(npct(premiums, 10), 2),
        "p25":      round(npct(premiums, 25), 2),
        "p75":      round(npct(premiums, 75), 2),
        "p90":      round(npct(premiums, 90), 2),
    }

    # ── decay_dte_curve ────────────────────────────────────────────────────────
    decay_dte_curve = []
    for dte_val in range(6):
        sub = daily[daily["dte"] == dte_val]["open_premium"].dropna()
        if len(sub) > 0:
            decay_dte_curve.append({
                "dte": dte_val, "label": str(dte_val),
                "avg": round(float(sub.mean()), 2),
                "p25": round(float(sub.quantile(0.25)), 2),
                "p75": round(float(sub.quantile(0.75)), 2),
                "count": int(len(sub)),
            })
    sub5 = daily[daily["dte"] >= 5]["open_premium"].dropna()
    if len(sub5) > 0:
        decay_dte_curve.insert(0, {
            "dte": "5+", "label": "5+",
            "avg": round(float(sub5.mean()), 2),
            "p25": round(float(sub5.quantile(0.25)), 2),
            "p75": round(float(sub5.quantile(0.75)), 2),
            "count": int(len(sub5)),
        })

    # ── intraday_decay ─────────────────────────────────────────────────────────
    bucket_map = daily[["expiry", "trade_date", "dte"]].copy()
    bucket_map["dte_bucket"] = bucket_map["dte"].apply(
        lambda x: str(x) if x <= 2 else "3+"
    )
    full = merged.merge(
        bucket_map[["expiry", "trade_date", "dte_bucket"]],
        on=["expiry", "trade_date"],
        how="inner",
    )
    intraday_decay: dict = {}
    for bucket in ["0", "1", "2", "3+"]:
        sub = full[(full["dte_bucket"] == bucket) &
                   (full["time_str"] >= "09:15") &
                   (full["time_str"] <= "15:30")]
        if len(sub) == 0:
            continue
        agg_df = (
            sub.groupby("time_str")["straddle_close"]
            .agg(avg="mean",
                 p25=lambda x: x.quantile(0.25),
                 p75=lambda x: x.quantile(0.75))
            .reset_index()
            .sort_values("time_str")
        )
        intraday_decay[bucket] = [
            {"time": row["time_str"],
             "avg":  round(float(row["avg"]), 2),
             "p25":  round(float(row["p25"]), 2),
             "p75":  round(float(row["p75"]), 2)}
            for _, row in agg_df.iterrows()
        ]

    # ── monthly_trend ──────────────────────────────────────────────────────────
    monthly = (
        daily.groupby("month")["open_premium"]
        .agg(avg="mean", count="count")
        .reset_index()
        .sort_values("month")
    )
    monthly_trend = [
        {"month": row["month"], "avg": round(float(row["avg"]), 2), "count": int(row["count"])}
        for _, row in monthly.iterrows()
    ]

    # ── range_analysis ─────────────────────────────────────────────────────────
    range_by_dte: dict = {}
    for label in ["0", "1", "2", "3", "4", "5+"]:
        sub = daily[daily["dte"] >= 5] if label == "5+" else daily[daily["dte"] == int(label)]
        if len(sub) == 0:
            continue
        range_by_dte[label] = {
            "avg_range":      round(float(sub["day_range"].mean()), 2),
            "avg_range_pct":  round(float(sub["range_pct"].mean()), 1),
            "seller_win_pct": round(float(sub["seller_win"].mean() * 100), 1),
        }

    range_by_weekday: dict = {}
    for day in WEEKDAY_NAMES:
        sub = daily[daily["weekday"] == day]
        if len(sub) == 0:
            continue
        range_by_weekday[day] = {
            "avg_range":     round(float(sub["day_range"].mean()), 2),
            "avg_range_pct": round(float(sub["range_pct"].mean()), 1),
        }

    # ── insights ───────────────────────────────────────────────────────────────
    insights = []
    overall_win = round(float(daily["seller_win"].mean() * 100), 1)
    avg_decay   = round(float(daily["decay_pct"].mean()), 1)
    insights.append(
        f"Sellers who shorted at open and covered at close won on {overall_win}% of all trading days."
    )
    if by_dte:
        best_dte = max(by_dte.items(), key=lambda x: x[1].get("seller_win_pct", 0))
        insights.append(
            f"DTE {best_dte[0]} has the highest seller win rate at {best_dte[1]['seller_win_pct']}%"
            f" (avg opening premium Rs.{best_dte[1]['avg']:.0f})."
        )
    if by_weekday:
        best_wd = max(by_weekday.items(), key=lambda x: x[1].get("avg", 0))
        low_wd  = min(by_weekday.items(), key=lambda x: x[1].get("avg", 9999))
        insights.append(
            f"{best_wd[0]} has the highest average opening premium (Rs.{best_wd[1]['avg']:.0f});"
            f" {low_wd[0]} the lowest (Rs.{low_wd[1]['avg']:.0f})."
        )
    if "0" in by_dte and "5+" in by_dte:
        pct_diff = round((1 - by_dte["0"]["avg"] / by_dte["5+"]["avg"]) * 100, 1)
        insights.append(
            f"Opening premium on expiry day (0 DTE) averages Rs.{by_dte['0']['avg']:.0f}"
            f" -- {pct_diff}% lower than 5+ DTE days (Rs.{by_dte['5+']['avg']:.0f})."
        )
    yearly = daily.groupby("year")["open_premium"].mean()
    if len(yearly) > 0:
        best_yr  = int(yearly.idxmax())
        worst_yr = int(yearly.idxmin())
        insights.append(
            f"{best_yr} had the highest average opening premium (Rs.{yearly[best_yr]:.0f});"
            f" {worst_yr} had the lowest (Rs.{yearly[worst_yr]:.0f})."
        )
    insights.append(
        f"On average, {avg_decay}% of the opening premium decays by end of day"
        f" across all DTE and weekdays."
    )

    return {
        "date_range": {
            "from": str(daily["trade_date"].min()),
            "to":   str(daily["trade_date"].max()),
        },
        "total_days":     int(len(daily)),
        "total_expiries": int(daily["expiry"].nunique()),
        "summary": {
            "overall_avg":         round(float(daily["open_premium"].mean()), 2),
            "overall_median":      round(float(daily["open_premium"].median()), 2),
            "overall_min":         round(float(daily["open_premium"].min()), 2),
            "overall_max":         round(float(daily["open_premium"].max()), 2),
            "avg_daily_decay_pct": round(float(daily["decay_pct"].mean()), 1),
            "seller_win_pct":      round(float(daily["seller_win"].mean() * 100), 1),
        },
        "by_weekday":    by_weekday,
        "by_dte":        by_dte,
        "distribution":  distribution,
        "decay_dte_curve": decay_dte_curve,
        "intraday_decay":  intraday_decay,
        "monthly_trend":   monthly_trend,
        "range_analysis": {
            "by_dte":     range_by_dte,
            "by_weekday": range_by_weekday,
        },
        "insights": insights,
    }


def build_offset(conn: sqlite3.Connection, offset: int) -> dict:
    """Load ATM+N CE and ATM-N PE rows, build daily metrics, return three regime dicts."""
    ce_label = f"ATM+{offset}"
    pe_label = f"ATM-{offset}"

    df = pd.read_sql(
        f"""
        SELECT expiry, datetime, option_type, open, high, low, close, spot
        FROM option_prices
        WHERE strike_relative IN ('{ce_label}', '{pe_label}')
        ORDER BY expiry, datetime, option_type
        """,
        conn,
        parse_dates=["datetime"],
    )

    if df.empty:
        empty = compute_regime_stats(pd.DataFrame(), pd.DataFrame())
        return {"regimes": {"all": empty, "pre_sep2025": empty, "post_sep2025": empty}}

    df["expiry_date"] = pd.to_datetime(df["expiry"]).dt.date
    df["trade_date"]  = df["datetime"].dt.date
    df["time_str"]    = df["datetime"].dt.strftime("%H:%M")

    # CE rows are option_type == 'CE'; PE rows are option_type == 'PE'
    idx = ["expiry", "datetime", "trade_date", "expiry_date", "time_str", "spot"]
    ce = df[df["option_type"] == "CE"].set_index(idx)[["open", "high", "low", "close"]]
    pe = df[df["option_type"] == "PE"].set_index(idx)[["open", "high", "low", "close"]]
    merged = ce.join(pe, lsuffix="_ce", rsuffix="_pe", how="inner").reset_index()

    merged["straddle_close"] = merged["close_ce"] + merged["close_pe"]
    merged["straddle_high"]  = merged["high_ce"]  + merged["high_pe"]
    merged["straddle_low"]   = merged["low_ce"]   + merged["low_pe"]

    open_rows = merged[merged["time_str"] == "09:15"][
        ["expiry", "trade_date", "expiry_date", "straddle_close"]
    ].rename(columns={"straddle_close": "open_premium"})

    close_rows = (
        merged.sort_values("datetime")
        .groupby(["expiry", "trade_date"])
        .last()
        .reset_index()[["expiry", "trade_date", "straddle_close"]]
        .rename(columns={"straddle_close": "close_premium"})
    )

    extremes = (
        merged.groupby(["expiry", "trade_date"])
        .agg(day_high=("straddle_high", "max"), day_low=("straddle_low", "min"))
        .reset_index()
    )

    daily = (
        open_rows
        .merge(close_rows, on=["expiry", "trade_date"], how="left")
        .merge(extremes,   on=["expiry", "trade_date"], how="left")
    )
    daily = daily[(daily["open_premium"] > 0) & (daily["close_premium"] > 0)].copy()

    daily["_trade_dow"] = pd.to_datetime(daily["trade_date"]).dt.weekday
    daily = daily[daily["_trade_dow"] < 5].drop(columns=["_trade_dow"])

    daily["expiry_date"]   = pd.to_datetime(daily["expiry_date"])
    daily["trade_date_dt"] = pd.to_datetime(daily["trade_date"])
    daily["dte"] = [
        int(np.busday_count(str(td), str(ex)))
        for td, ex in zip(daily["trade_date"], daily["expiry_date"].dt.date)
    ]
    daily["dte_label"]  = daily["dte"].apply(lambda x: str(x) if x < 5 else "5+")
    daily["weekday"]    = daily["trade_date_dt"].dt.weekday.map(
                              {i: n for i, n in enumerate(WEEKDAY_NAMES)}
                          )
    daily["decay_pct"]  = (daily["open_premium"] - daily["close_premium"]) / daily["open_premium"] * 100
    daily["seller_win"] = (daily["close_premium"] < daily["open_premium"]).astype(int)
    daily["day_range"]  = daily["day_high"] - daily["day_low"]
    daily["range_pct"]  = daily["day_range"] / daily["open_premium"] * 100
    daily["month"]      = daily["trade_date_dt"].dt.to_period("M").astype(str)
    daily["year"]       = daily["trade_date_dt"].dt.year

    daily_pre   = daily[daily["trade_date"] < REGIME_CUTOFF].copy()
    daily_post  = daily[daily["trade_date"] >= REGIME_CUTOFF].copy()
    merged_pre  = merged[merged["trade_date"] < REGIME_CUTOFF].copy()
    merged_post = merged[merged["trade_date"] >= REGIME_CUTOFF].copy()

    return {
        "regimes": {
            "all":          compute_regime_stats(daily, merged),
            "pre_sep2025":  compute_regime_stats(daily_pre, merged_pre),
            "post_sep2025": compute_regime_stats(daily_post, merged_post),
        }
    }


def main() -> None:
    write_status("running", 0, "Connecting to database...")

    if not DB_PATH.exists():
        write_status("error", 0, f"Database not found: {DB_PATH}")
        print(f"ERROR: {DB_PATH} not found", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    output: dict = {
        "generated_at":  datetime.now().isoformat(),
        "regime_cutoff": str(REGIME_CUTOFF),
    }

    for i, offset in enumerate(OFFSETS):
        pct_start = 5 + i * 9
        write_status("running", pct_start, f"Processing ATM+{offset}/ATM-{offset} strangle ({i+1}/10)...")
        output[f"offset_{offset}"] = build_offset(conn, offset)
        write_status("running", pct_start + 8, f"Offset {offset} done.")

    conn.close()
    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
    write_status("done", 100, "Strangle analysis complete for all 10 offsets.")
    print(f"Done. -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test the script**

```powershell
venv\Scripts\python.exe scripts/analysis/strangle_premium_analysis.py
```

Expected: prints `Done. -> ...\debug\strangle_premium_analysis.json`. Verify the file exists and has `offset_1` through `offset_10` keys:

```powershell
venv\Scripts\python.exe -c "
import json
d = json.load(open('debug/strangle_premium_analysis.json'))
print(list(d.keys()))
print('offset_2 regimes:', list(d['offset_2']['regimes'].keys()))
print('offset_2 all total_days:', d['offset_2']['regimes']['all']['total_days'])
"
```

Expected output (numbers will vary):
```
['generated_at', 'regime_cutoff', 'offset_1', 'offset_2', ..., 'offset_10']
offset_2 regimes: ['all', 'pre_sep2025', 'post_sep2025']
offset_2 all total_days: <some positive integer>
```

- [ ] **Step 3: Commit**

```bash
git add scripts/analysis/strangle_premium_analysis.py
git commit -m "feat(analysis): add strangle_premium_analysis.py for offsets 1-10"
```

---

## Task 2: API routes

**Files:**
- Create: `rs_dashboard/app/api/strangle-analysis/route.ts`
- Create: `rs_dashboard/app/api/strangle-analysis/status/route.ts`

**Interfaces:**
- `GET /api/strangle-analysis` → returns the full JSON from `debug/strangle_premium_analysis.json` or `{ error: 'not_generated' }` (404)
- `POST /api/strangle-analysis` with `{ action: 'regenerate' }` → spawns the Python script, returns `{ status: 'started', pid: number }` or `{ error: 'already_running' }` (409)
- `GET /api/strangle-analysis/status` → returns `{ status, pct, message }` from `debug/strangle_analysis_status.json`

- [ ] **Step 1: Create `rs_dashboard/app/api/strangle-analysis/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH  = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'strangle_premium_analysis.py');
const DATA_FILE    = path.join(DEBUG_DIR, 'strangle_premium_analysis.json');
const STATUS_FILE  = path.join(DEBUG_DIR, 'strangle_analysis_status.json');

export async function GET() {
  if (!fs.existsSync(DATA_FILE)) {
    return NextResponse.json({ error: 'not_generated' }, { status: 404 });
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let action = 'regenerate';
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action) action = body.action;
  } catch { /* no body */ }

  if (action !== 'regenerate') {
    return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
  }

  if (fs.existsSync(STATUS_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
      if (s.status === 'running') {
        return NextResponse.json({ error: 'already_running' }, { status: 409 });
      }
    } catch { /* ignore */ }
  }

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    status: 'running', pct: 0, message: 'Starting…',
  }));

  const child = spawn(PYTHON_EXE, [SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();

  return NextResponse.json({ status: 'started', pid: child.pid });
}
```

- [ ] **Step 2: Create `rs_dashboard/app/api/strangle-analysis/status/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const STATUS_FILE = path.join(
  path.resolve(process.cwd(), '..'), 'debug', 'strangle_analysis_status.json'
);

export async function GET() {
  if (!fs.existsSync(STATUS_FILE)) {
    return NextResponse.json({ status: 'idle', pct: 0, message: '' });
  }
  try {
    return NextResponse.json(JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')));
  } catch {
    return NextResponse.json({ status: 'idle', pct: 0, message: '' });
  }
}
```

- [ ] **Step 3: Verify routes respond**

With `npm run dev` running in `rs_dashboard/`, run:

```powershell
# GET — should return JSON (or 404 if script hasn't run yet, which is fine)
curl http://localhost:3000/api/strangle-analysis

# GET status
curl http://localhost:3000/api/strangle-analysis/status
# Expected: {"status":"idle","pct":0,"message":""}  (or "done" if script ran)
```

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/app/api/strangle-analysis/
git commit -m "feat(api): add strangle-analysis GET/POST and status routes"
```

---

## Task 3: StrangleAnalysis component and page

**Files:**
- Create: `rs_dashboard/components/StrangleAnalysis.tsx`
- Create: `rs_dashboard/app/strangle-analysis/page.tsx`

**Interfaces:**
- Consumes: `GET /api/strangle-analysis` → `StrangleFullData`
- Consumes: `GET /api/strangle-analysis/status` → `{ status, pct, message }`
- Consumes: `POST /api/strangle-analysis` → starts regeneration
- `StrangleFullData`:
  ```ts
  interface StrangleFullData {
    generated_at: string;
    regime_cutoff: string;
    [key: string]: OffsetData | string; // offset_1 ... offset_10
  }
  interface OffsetData {
    regimes: { all: AnalysisData; pre_sep2025: AnalysisData; post_sep2025: AnalysisData; };
  }
  ```

- [ ] **Step 1: Create `rs_dashboard/components/StrangleAnalysis.tsx`**

This is a full component. Copy `StraddleAnalysis.tsx` as the base and apply the following changes:

**a) Change FullData type** — replace the `FullData` interface and add `OffsetData`:

```typescript
interface OffsetData {
  regimes: { all: AnalysisData; pre_sep2025: AnalysisData; post_sep2025: AnalysisData; };
}

interface StrangleFullData {
  generated_at: string;
  regime_cutoff: string;
  [key: string]: OffsetData | string;
}
```

**b) Add offset state** — in the component function, add after the existing `regime` state:

```typescript
const [selectedOffset, setSelectedOffset] = useState<number>(2);
```

**c) Change data state type** — replace `FullData | null` with `StrangleFullData | null`:

```typescript
const [data, setData] = useState<StrangleFullData | null>(null);
```

**d) Update `currentData` derivation** — the straddle component has a line like:
```typescript
const currentData = data?.regimes?.[regime] ?? null;
```
Replace with:
```typescript
const offsetData = data?.[`offset_${selectedOffset}`] as OffsetData | undefined;
const currentData = offsetData?.regimes?.[regime] ?? null;
```

**e) Update page title / section heading** — the straddle component renders a heading like "ATM Straddle Premium Analysis". Change it to use the offset dynamically:

```typescript
// In the sticky header where the title appears:
<h1 className="text-base font-bold text-white">
  ATM+{selectedOffset} / ATM-{selectedOffset} Strangle Premium Analysis
</h1>
```

**f) Add offset button group** — in the sticky header bar, right after the regime toggle buttons and before the date filter buttons, add:

```typescript
{/* Offset selector */}
<div className="flex items-center gap-1.5">
  <span className="text-xs text-zinc-400 font-medium">Offset:</span>
  <div className="flex gap-0.5">
    {[1,2,3,4,5,6,7,8,9,10].map((n) => (
      <button
        key={n}
        onClick={() => setSelectedOffset(n)}
        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
          selectedOffset === n
            ? 'bg-emerald-600 text-white'
            : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
        }`}
      >
        {n}
      </button>
    ))}
  </div>
</div>
```

**g) Change API endpoints** — replace all occurrences of `/api/straddle-analysis` with `/api/strangle-analysis` (there are typically 3: fetch data, start regeneration, poll status).

**h) Update `generated_at` display** — the straddle component shows "Generated: ..." from `data.generated_at`. Keep this as-is; it already works with `StrangleFullData`.

**i) Update "not generated" message** — change any text like "Straddle analysis not generated" to "Strangle analysis not generated. Click Regenerate to run the script for all offsets (1–10).".

- [ ] **Step 2: Create `rs_dashboard/app/strangle-analysis/page.tsx`**

```typescript
import StrangleAnalysis from '@/components/StrangleAnalysis';

export const metadata = { title: 'Strangle Premium Analysis | Dhan Algo' };

export default function StrangleAnalysisPage() {
  return <StrangleAnalysis />;
}
```

- [ ] **Step 3: Verify in browser**

Start dev server (`cd rs_dashboard && npm run dev`), navigate to `http://localhost:3000/strangle-analysis`.

Verify:
1. "Not generated" state shows with Regenerate button (if no JSON exists yet).
2. If JSON exists: offset buttons 1–10 appear; default is 2.
3. Clicking different offset numbers changes the metrics displayed (check "Avg Opening Premium" KPI tile — it should differ between offset 1 and offset 5).
4. Regime toggle (All / Pre Sep'25 / Post Sep'25) works without page reload.
5. Date filter works on the Monthly Trend chart.
6. Click Regenerate → progress bar appears, polls status, reloads on completion.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/components/StrangleAnalysis.tsx rs_dashboard/app/strangle-analysis/
git commit -m "feat(dashboard): add StrangleAnalysis component and page"
```

---

## Task 4: Navigation link

**Files:**
- Modify: `rs_dashboard/components/NavBar.tsx`

**Interfaces:**
- Consumes: existing `NAV_GROUPS` array structure in NavBar.tsx
- The Derivatives group currently has `straddle-analysis` as the last entry; add `strangle-analysis` right after it.

- [ ] **Step 1: Add nav link**

In `rs_dashboard/components/NavBar.tsx`, find the Derivatives group links array. It currently ends with:

```typescript
{ href: '/straddle-analysis', label: 'Straddle Analysis', desc: 'ATM straddle premium patterns by weekday, DTE & regime' },
```

Add the strangle entry immediately after it:

```typescript
{ href: '/straddle-analysis', label: 'Straddle Analysis', desc: 'ATM straddle premium patterns by weekday, DTE & regime' },
{ href: '/strangle-analysis', label: 'Strangle Analysis', desc: 'OTM strangle premium patterns by offset, weekday, DTE & regime' },
```

- [ ] **Step 2: Verify nav**

In the browser, confirm "Strangle Analysis" appears in the Derivatives dropdown, and clicking it routes to `/strangle-analysis`.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/NavBar.tsx
git commit -m "feat(nav): add Strangle Analysis link to Derivatives menu"
```

---

## Verification Checklist

- [ ] `venv\Scripts\python.exe scripts/analysis/strangle_premium_analysis.py` completes without errors and produces `debug/strangle_premium_analysis.json` with 10 offset keys.
- [ ] `GET /api/strangle-analysis` returns 200 with the JSON.
- [ ] `GET /api/strangle-analysis/status` returns `{ status: 'done', pct: 100 }`.
- [ ] `/strangle-analysis` page loads, showing all 8 metric sections for offset 2.
- [ ] Switching offset 1 vs offset 10 shows visibly different KPI values (offset 1 has the lowest premium since it's closest to ATM; offset 10 the lowest of all).
- [ ] Regime toggle and date filter work independently of offset selection.
- [ ] "Strangle Analysis" nav link appears in the Derivatives menu.
