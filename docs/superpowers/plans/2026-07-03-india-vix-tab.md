# India VIX Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "India VIX" tab to the Options Charts page showing a 1-min intraday VIX line chart + 5-min ROC histogram, auto-refreshing every 60 seconds.

**Architecture:** A Python script fetches intraday VIX candles from Dhan's API (security ID 21, NSE_IDX), computes 5-min ROC, and prints JSON to stdout. A Next.js API route calls the script via `spawnSync` with a 55s server-side cache. A self-contained React component polls the route every 60s and renders a two-panel chart using Recharts.

**Tech Stack:** Python 3 + DhanHelper, Next.js App Router, TypeScript, Recharts, Tailwind CSS.

## Global Constraints

- Python script must print exactly one JSON line to stdout (all logs → stderr)
- Python script located at `scripts/tools/india_vix_candles.py`; run from project root with `venv\Scripts\python.exe`
- Next.js API route at `rs_dashboard/app/api/options/vix-candles/route.ts`
- Component at `rs_dashboard/components/OptionsVixTab.tsx`
- No new npm packages — Recharts, React, and Tailwind are already installed
- No `text-white/70` or slash-opacity on text — use solid zinc scale (e.g. `text-zinc-400`)
- Table/header style: `text-xs font-bold text-white bg-zinc-800` (not relevant here but a global rule)
- `PROJECT_ROOT` in API routes = `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`)
- Python interpreter = `path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe')`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/tools/india_vix_candles.py` | **Create** | Fetch 1-min VIX candles, compute ROC, print JSON |
| `rs_dashboard/app/api/options/vix-candles/route.ts` | **Create** | Spawn Python script, cache 55s, return JSON |
| `rs_dashboard/components/OptionsVixTab.tsx` | **Create** | Self-contained VIX chart + ROC histogram component |
| `rs_dashboard/components/OptionsCharts.tsx` | **Edit** | Add 'vix' tab key, import, render branch |

---

### Task 1: Python script — `india_vix_candles.py`

**Files:**
- Create: `scripts/tools/india_vix_candles.py`

**Interfaces:**
- Produces: stdout JSON matching shape below (consumed by Task 2's API route)

```json
{
  "candles": [{"time": "09:15", "open": 13.60, "high": 13.75, "low": 13.58, "close": 13.70, "roc5": null}],
  "spot": 13.70,
  "day_open": 13.60,
  "day_high": 13.85,
  "day_low": 13.52,
  "prev_close": 13.24,
  "data_date": "2026-07-03",
  "is_today": true
}
```

- [ ] **Step 1: Create the script**

Create `scripts/tools/india_vix_candles.py` with the following content:

```python
"""
Fetch today's 1-min intraday candles for India VIX and print JSON to stdout.

Prints a single JSON line. All logs go to stderr.
Security ID 21 = India VIX on Dhan NSE_IDX segment.
"""
import sys
import os
import json
from datetime import date, timedelta, datetime, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

VIX_SECURITY_ID = "21"
VIX_CSV = os.path.join(ROOT, "Historical Data", "Indices", "INDIA_VIX.csv")


def _prev_close_from_csv() -> float:
    """Return second-to-last close from daily INDIA_VIX.csv as prev close."""
    try:
        with open(VIX_CSV, encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        if len(lines) < 3:  # header + at least 2 rows
            return 0.0
        last_row = lines[-1].split(",")
        return float(last_row[4])  # close is index 4
    except Exception:
        return 0.0


def _to_hhmm(raw) -> str:
    """Convert Dhan timestamp (unix seconds, unix ms, or ISO string) to HH:MM IST."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:  # milliseconds
            val /= 1000
        dt = datetime.fromtimestamp(val, tz=_IST)
        return dt.strftime("%H:%M")
    except (ValueError, TypeError, OSError):
        pass
    s = str(raw).replace("T", " ")
    return s[11:16] if len(s) > 10 else s


def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return df.columns[0]


def main():
    today = date.today()
    today_str = today.strftime("%Y-%m-%d")
    lookback_str = (today - timedelta(days=5)).strftime("%Y-%m-%d")

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return

    helper = DhanHelper(dhan)

    df = helper.get_intraday_minute_data(
        security_id=VIX_SECURITY_ID,
        exchange_segment="NSE_IDX",
        instrument_type="INDEX",
        interval="1",
        from_date=lookback_str,
        to_date=today_str,
    )

    if df is None or df.empty:
        print(json.dumps({"error": "No intraday data returned for India VIX — check auth token"}))
        return

    # Keep only most recent trading day
    ts_col = _col(df, "start_Time", "timestamp", "time", "date")
    col = df[ts_col]
    if col.dtype in ("int64", "float64"):
        import pandas as pd
        dates = pd.to_datetime(col, unit="s").dt.date
    else:
        import pandas as pd
        dates = pd.to_datetime(col, errors="coerce").dt.date
    last_day = dates.max()
    df = df[dates == last_day].copy()
    data_date = str(last_day)
    is_today = data_date == today_str

    open_col  = _col(df, "open",  "Open",  "o")
    high_col  = _col(df, "high",  "High",  "h")
    low_col   = _col(df, "low",   "Low",   "l")
    close_col = _col(df, "close", "Close", "c")

    closes = df[close_col].astype(float).tolist()
    opens  = df[open_col].astype(float).tolist()
    highs  = df[high_col].astype(float).tolist()
    lows   = df[low_col].astype(float).tolist()
    times  = [_to_hhmm(row[ts_col]) for _, row in df.iterrows()]

    # 5-min ROC: roc5[i] = (close[i] - close[i-5]) / close[i-5] * 100
    roc5 = [None] * 5
    for i in range(5, len(closes)):
        base = closes[i - 5]
        roc5.append(round((closes[i] - base) / base * 100, 4) if base != 0 else None)

    candles = []
    for i, t in enumerate(times):
        candles.append({
            "time":  t,
            "open":  round(opens[i],  2),
            "high":  round(highs[i],  2),
            "low":   round(lows[i],   2),
            "close": round(closes[i], 2),
            "roc5":  roc5[i],
        })

    spot      = round(closes[-1], 2) if closes else 0.0
    day_open  = round(opens[0],   2) if opens  else 0.0
    day_high  = round(max(highs),  2) if highs  else 0.0
    day_low   = round(min(lows),   2) if lows   else 0.0
    prev_close = _prev_close_from_csv()

    print(json.dumps({
        "candles":    candles,
        "spot":       spot,
        "day_open":   day_open,
        "day_high":   day_high,
        "day_low":    day_low,
        "prev_close": prev_close,
        "data_date":  data_date,
        "is_today":   is_today,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
```

- [ ] **Step 2: Smoke-test the script**

Run from project root (after-hours is fine — it will use the last trading day's data):

```powershell
venv\Scripts\python.exe scripts/tools/india_vix_candles.py
```

Expected: a single JSON line starting with `{"candles": [` with 200–375 objects (full session) or a smaller count if run after market close for the last trading day. The `data_date` field should be the most recent trading day. If you see `{"error": ...}`, check `access_token.json` exists and run `venv\Scripts\python.exe login.py` first.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/india_vix_candles.py
git commit -m "feat(vix): add india_vix_candles.py — intraday 1-min VIX candles + 5m ROC"
```

---

### Task 2: API route — `/api/options/vix-candles`

**Files:**
- Create: `rs_dashboard/app/api/options/vix-candles/route.ts`

**Interfaces:**
- Consumes: `india_vix_candles.py` stdout JSON from Task 1
- Produces: `GET /api/options/vix-candles` → `{ success: true, candles: VixCandle[], spot, day_open, day_high, day_low, prev_close, data_date, is_today }` (consumed by Task 3's component)

- [ ] **Step 1: Create the route**

Create `rs_dashboard/app/api/options/vix-candles/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const VIX_SCRIPT     = path.join(PROJECT_ROOT, 'scripts', 'tools', 'india_vix_candles.py');

export interface VixCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  roc5: number | null;
}

interface VixPayload {
  candles: VixCandle[];
  spot: number;
  day_open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  data_date: string;
  is_today: boolean;
}

interface CacheEntry { data: VixPayload; ts: number }
let cache: CacheEntry | null = null;
const CACHE_TTL = 55_000; // 55 s — ensures 60s client polls always get a fresh candle

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, ...cache.data });
  }

  const result = spawnSync(
    PYTHON_EXE,
    [VIX_SCRIPT],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/vix-candles] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as VixPayload & { error?: string };

    if (parsed.error) {
      console.error('[/api/options/vix-candles]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    cache = { data: parsed, ts: Date.now() };
    return NextResponse.json({ success: true, ...parsed });
  } catch (err) {
    console.error('[/api/options/vix-candles] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: Test the route**

Start the dashboard if not already running:

```powershell
cd rs_dashboard
npm run dev
```

In a browser or curl:

```
http://localhost:3000/api/options/vix-candles
```

Expected response shape:
```json
{
  "success": true,
  "candles": [{"time":"09:15","open":13.60,"high":13.75,"low":13.58,"close":13.70,"roc5":null}, ...],
  "spot": 13.70,
  "day_open": 13.60,
  "day_high": 13.85,
  "day_low": 13.52,
  "prev_close": 13.24,
  "data_date": "2026-07-03",
  "is_today": false
}
```

Call it a second time within 55s — it should return instantly (cache hit; no 3s Python spawn delay).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/options/vix-candles/route.ts
git commit -m "feat(vix): add /api/options/vix-candles route with 55s cache"
```

---

### Task 3: React component — `OptionsVixTab.tsx`

**Files:**
- Create: `rs_dashboard/components/OptionsVixTab.tsx`

**Interfaces:**
- Consumes: `GET /api/options/vix-candles` from Task 2
- Produces: `export default function OptionsVixTab(): JSX.Element` (no props — self-contained)
- Consumed by: `OptionsCharts.tsx` in Task 4

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/OptionsVixTab.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import type { VixCandle } from '@/app/api/options/vix-candles/route';

// ─── Types ────────────────────────────────────────────────────────

interface VixData {
  candles: VixCandle[];
  spot: number;
  day_open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  data_date: string;
  is_today: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const POLL_MS    = 60_000;
const COUNTDOWN  = 60;

// ─── Helpers ──────────────────────────────────────────────────────

function regimeLabel(vix: number): { label: string; color: string; pill: string } {
  if (vix < 13)  return { label: 'CALM',     color: 'text-emerald-400', pill: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
  if (vix < 16)  return { label: 'NORMAL',   color: 'text-yellow-400',  pill: 'bg-yellow-500/15  text-yellow-400  border-yellow-500/30'  };
  if (vix < 20)  return { label: 'ELEVATED', color: 'text-orange-400',  pill: 'bg-orange-500/15  text-orange-400  border-orange-500/30'  };
  return           { label: 'FEARFUL',  color: 'text-red-400',    pill: 'bg-red-500/15     text-red-400     border-red-500/30'     };
}

function fmtTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtVix(n: number): string {
  return n.toFixed(2);
}

// Show every 30th 1-min candle label on X axis (≈ every 30 min)
function xTickFormatter(value: string, index: number): string {
  return index % 30 === 0 ? value : '';
}

// ─── Tooltips ─────────────────────────────────────────────────────

const VixTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: VixCandle }>)[0]?.payload;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[140px] backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold">{String(label)}</p>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-indigo-400 font-semibold">VIX</span>
        <span className="text-white font-bold tabular-nums">{fmtVix(row?.close ?? 0)}</span>
      </div>
      {row?.roc5 != null && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400 font-semibold">ROC 5m</span>
          <span className={`font-bold tabular-nums ${row.roc5 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {row.roc5 >= 0 ? '+' : ''}{row.roc5.toFixed(3)}%
          </span>
        </div>
      )}
    </div>
  );
};

const RocTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const val = (payload as Array<{ value: number }>)[0]?.value ?? 0;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3 py-2 text-xs shadow-2xl backdrop-blur">
      <p className="text-zinc-400 mb-1 font-semibold">{String(label)}</p>
      <span className={`font-bold tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        ROC 5m: {val >= 0 ? '+' : ''}{val.toFixed(3)}%
      </span>
    </div>
  );
};

// ─── Stat Tile ────────────────────────────────────────────────────

function StatTile({ label, value, valueClass = 'text-zinc-100' }: {
  label: string; value: string; valueClass?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsVixTab() {
  const [data, setData]           = useState<VixData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/options/vix-candles');
      const json = await res.json() as { success: boolean } & Partial<VixData> & { error?: string };
      if (!json.success) {
        setError(json.error ?? 'Unknown error');
      } else {
        setData(json as VixData);
        setError('');
        setLastUpdated(new Date());
        setCountdown(COUNTDOWN);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const pollId = setInterval(() => void fetchData(), POLL_MS);
    const tickId = setInterval(() => setCountdown(c => (c > 0 ? c - 1 : 0)), 1_000);
    return () => { clearInterval(pollId); clearInterval(tickId); };
  }, [fetchData]);

  // ROC chart data: filter out null roc5 values
  const rocData = data?.candles.filter(c => c.roc5 != null) ?? [];

  const regime = data ? regimeLabel(data.spot) : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="grid grid-cols-5 gap-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-zinc-800 rounded-xl h-16" />
          ))}
        </div>
        <div className="bg-zinc-800 rounded-xl h-64" />
        <div className="bg-zinc-800 rounded-xl h-32" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <div className="px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400 max-w-lg text-center">
          {error}
        </div>
        <button
          onClick={() => { setLoading(true); void fetchData(); }}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-200 font-semibold transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Stat row */}
      <div className="flex items-stretch gap-3">
        {/* VIX current — wider tile with regime badge */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex flex-col gap-1 min-w-0 flex-shrink-0">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">VIX</span>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold tabular-nums ${regime?.color ?? 'text-zinc-100'}`}>
              {data ? fmtVix(data.spot) : '—'}
            </span>
            {regime && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${regime.pill}`}>
                {regime.label}
              </span>
            )}
          </div>
        </div>

        <StatTile label="Open"       value={data ? fmtVix(data.day_open)   : '—'} valueClass="text-zinc-100" />
        <StatTile label="High"       value={data ? fmtVix(data.day_high)   : '—'} valueClass="text-emerald-400" />
        <StatTile label="Low"        value={data ? fmtVix(data.day_low)    : '—'} valueClass="text-red-400" />
        <StatTile label="Prev Close" value={data ? fmtVix(data.prev_close) : '—'} valueClass="text-zinc-400" />
      </div>

      {/* Main VIX line chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs font-semibold text-zinc-400 mb-3">India VIX — 1 min</p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data?.candles ?? []} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={xTickFormatter}
              interval={0}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={v => (v as number).toFixed(2)}
              domain={([min, max]: [number, number]) => [
                parseFloat((min * 0.95).toFixed(2)),
                parseFloat((max * 1.05).toFixed(2)),
              ]}
              width={44}
            />
            <Tooltip content={<VixTooltip />} />
            {data && (
              <ReferenceLine
                y={data.prev_close}
                stroke="#52525b"
                strokeDasharray="4 3"
                label={{ value: 'PDC', fill: '#71717a', fontSize: 9, position: 'insideTopRight' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="close"
              stroke="#818cf8"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: '#818cf8' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ROC histogram */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs font-semibold text-zinc-400 mb-3">VIX Velocity — 5-min ROC %</p>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={rocData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={xTickFormatter}
              interval={0}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={v => `${(v as number).toFixed(2)}%`}
              width={52}
              label={{ value: 'ROC 5m %', angle: -90, position: 'insideLeft', fill: '#52525b', fontSize: 9, dx: -4 }}
            />
            <Tooltip content={<RocTooltip />} />
            <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
            <Bar dataKey="roc5" maxBarSize={6} radius={[1, 1, 0, 0]}>
              {rocData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={(entry.roc5 ?? 0) >= 0 ? '#10b981' : '#ef4444'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {data && (
          <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono text-[10px]">
            DATA: {data.data_date}
          </span>
        )}
        {lastUpdated && (
          <span>Last updated: {fmtTime(lastUpdated)}</span>
        )}
        <span className={`ml-auto font-semibold ${countdown <= 10 ? 'text-amber-400 animate-pulse' : 'text-zinc-500'}`}>
          Refresh in {countdown}s
        </span>
      </div>

    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors. If you see "Module not found" for `@/app/api/options/vix-candles/route`, that's because `VixCandle` is imported from the route file — confirm `rs_dashboard/app/api/options/vix-candles/route.ts` exists (Task 2). If the `export interface VixCandle` is not resolved, move the interface to a shared lib file `rs_dashboard/lib/vixTypes.ts` and import from there in both files.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/OptionsVixTab.tsx
git commit -m "feat(vix): add OptionsVixTab component — 1-min chart + ROC histogram"
```

---

### Task 4: Wire tab into `OptionsCharts.tsx`

**Files:**
- Modify: `rs_dashboard/components/OptionsCharts.tsx`

**Interfaces:**
- Consumes: `OptionsVixTab` default export from Task 3

- [ ] **Step 1: Add import**

At the top of `rs_dashboard/components/OptionsCharts.tsx`, after the existing tab imports (around line 14):

```tsx
// Before:
import OptionsIntelligenceTab from './OptionsIntelligenceTab';

// After:
import OptionsIntelligenceTab from './OptionsIntelligenceTab';
import OptionsVixTab from './OptionsVixTab';
```

- [ ] **Step 2: Extend the activeTab union type**

Find line 166:
```tsx
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence'>('premium');
```

Replace with:
```tsx
const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative' | 'chain' | 'intelligence' | 'vix'>('premium');
```

- [ ] **Step 3: Add tab entry to the tab bar array**

Find the tab array (around line 575–582):
```tsx
{ key: 'intelligence', label: 'Intelligence'  },
] as const).map(({ key, label }) => (
```

Change to:
```tsx
{ key: 'intelligence', label: 'Intelligence'  },
{ key: 'vix',         label: 'India VIX'     },
] as const).map(({ key, label }) => (
```

- [ ] **Step 4: Add render branch**

Find line 601:
```tsx
{activeTab === 'intelligence' && <OptionsIntelligenceTab expiry={expiry} />}
```

Add after it:
```tsx
{activeTab === 'vix'          && <OptionsVixTab />}
```

- [ ] **Step 5: Hide expiry selector when on VIX tab**

The expiry `<select>` is always visible in the header. Find the expiry selector block (around line 500–512) which currently starts with:

```tsx
<div className="flex items-center gap-1.5">
  <span className="text-xs text-zinc-300 font-medium">Expiry</span>
  <select
```

Wrap the entire expiry div in a conditional:

```tsx
{activeTab !== 'vix' && (
  <div className="flex items-center gap-1.5">
    <span className="text-xs text-zinc-300 font-medium">Expiry</span>
    <select
      value={expiry}
      onChange={e => setExpiry(e.target.value)}
      disabled={expiriesLoading || isLive}
      className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                 disabled:opacity-50"
    >
      {expiries.map(e => <option key={e} value={e}>{e}</option>)}
    </select>
  </div>
)}
```

- [ ] **Step 6: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Open the browser and verify**

Navigate to `http://localhost:3000/options`. Click "India VIX" in the tab bar.

Verify:
1. Stat row shows VIX, Open, High, Low, Prev Close with correct values
2. Regime badge appears (CALM / NORMAL / ELEVATED / FEARFUL)
3. Line chart shows the intraday VIX close line with a dashed PDC reference line
4. ROC histogram below shows green/red bars
5. Footer shows DATA date chip, last updated time, and countdown
6. Expiry selector is hidden on this tab
7. Wait 60s — chart auto-refreshes (countdown resets to 60)

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/components/OptionsCharts.tsx
git commit -m "feat(vix): wire India VIX tab into OptionsCharts — tab bar + render branch"
```

---

## Self-Review

**Spec coverage:**
- ✅ Python script: `india_vix_candles.py` — Task 1
- ✅ Security ID 21, NSE_IDX, INDEX — Task 1 Step 1
- ✅ 5-min ROC formula — Task 1 Step 1
- ✅ CSV fallback for prev_close — Task 1 Step 1
- ✅ API route `/api/options/vix-candles` with 55s cache — Task 2
- ✅ Tab key `'vix'`, label `'India VIX'` — Task 4
- ✅ Stat row: VIX, Open, High, Low, Prev Close — Task 3
- ✅ Regime badge (CALM/NORMAL/ELEVATED/FEARFUL with thresholds) — Task 3
- ✅ Line chart with PDC reference line, no dots — Task 3
- ✅ ROC histogram green/red bars, null-filtered — Task 3
- ✅ 60s auto-poll + countdown — Task 3
- ✅ Footer: DATA chip + last updated + countdown — Task 3
- ✅ Expiry selector hidden on VIX tab — Task 4
- ✅ Error state + retry button — Task 3
- ✅ Loading skeleton — Task 3

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks are complete.

**Type consistency:** `VixCandle` defined in `route.ts` and imported in `OptionsVixTab.tsx`. `activeTab` union extended consistently in the `useState` declaration. `OptionsVixTab` takes no props — confirmed in both Task 3 (definition) and Task 4 (usage `<OptionsVixTab />`).
