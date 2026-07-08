# Live 1-Min Normalized Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third tab to the `/live` dashboard page that plots normalized (% from session open) 1-minute intraday candles for NIFTY, BANKNIFTY, and CRUDEOILM on one chart.

**Architecture:** A stateless Python script fetches today's 1-min OHLC candles for the three instruments via `DhanHelper`, normalizes each to % change from its own first candle's open, and prints JSON. A Next.js API route spawns that script synchronously per request with a short in-memory cache. A new React tab polls that route every 45s and renders a Recharts multi-line chart. No persistent background process, no PID/trigger-file lifecycle — this is pure request/response, unlike the existing WebSocket-bridge tabs.

**Tech Stack:** Python (`lib/dhan_helper.py` — `DhanHelper.find_index`, `find_future`, `get_intraday_minute_data`), Next.js App Router API route (`spawnSync`), React + Recharts (`rs_dashboard`).

## Global Constraints

- All Python commands run from the project root (`c:\dhan_algo\dhan_algo`) using `venv\Scripts\python.exe` (or `pythonw.exe` for subprocess spawns, per existing route convention).
- `rs_dashboard/AGENTS.md`: this Next.js version has breaking API changes — do not assume training-data defaults; follow the exact patterns already present in sibling files (`app/api/options/candles/route.ts`).
- NIFTY/BANKNIFTY are indices: resolve via `DhanHelper.find_index(symbol, exchange="IDX_I")`, segment `IDX_I`, instrument `INDEX`. Use `"NIFTY"` / `"BANKNIFTY"`, not `"NIFTY 50"`.
- CRUDEOILM is an MCX future: resolve via `DhanHelper.find_future("CRUDEOILM", exchange="MCX", instrument="FUTCOM")`, segment `MCX_COMM`.
- No text-color opacity modifiers in Tailwind classes (e.g. no `text-white/70`) — use solid `zinc-*` shades, per dashboard-wide convention.
- Table/legend text conventions aside, this feature introduces no `<thead>`/table headers, so the `text-xs font-bold text-white` header rule does not apply here.
- Out of scope (do not touch): `live_equity_ws.py`, `live_indices_ws.py`, the existing Market/Normalized tabs' internals.

---

### Task 1: Python candle-fetch + normalize script

**Files:**
- Create: `scripts/tools/normalized_1min_candles.py`
- Create: `tests/test_normalized_1min_candles.py`

**Interfaces:**
- Produces (consumed by Task 2): running `venv\Scripts\pythonw.exe scripts/tools/normalized_1min_candles.py` with no args prints one JSON line to stdout shaped:
  ```json
  {
    "success": true,
    "data_date": "2026-07-08",
    "is_today": true,
    "series": {
      "NIFTY":     [{"time": "09:15", "close": 24850.1, "pct": 0.0}, "..."],
      "BANKNIFTY": [{"time": "09:15", "close": 55210.4, "pct": 0.0}, "..."],
      "CRUDEOILM": [{"time": "09:00", "close": 5834.0,  "pct": 0.0}, "..."]
    },
    "errors": {"CRUDEOILM": "reason if that one instrument failed"}
  }
  ```
  On total failure: `{"success": false, "error": "..."}`. The `errors` key is present only when at least one (but not all) instruments failed.
- Consumes: `DhanHelper.find_index`, `DhanHelper.find_future`, `DhanHelper.get_intraday_minute_data` (all in `lib/dhan_helper.py`, unchanged), `login.get_dhan_client`.

- [ ] **Step 1: Write the script with a pure, testable normalize function**

Create `scripts/tools/normalized_1min_candles.py`:

```python
"""
Fetch today's 1-min intraday candles for NIFTY, BANKNIFTY, and CRUDEOILM and
print normalized (% change from each instrument's own session-open) series
as a single JSON line to stdout.

Usage:
    venv\\Scripts\\python.exe scripts/tools/normalized_1min_candles.py

Logs go to stderr; only the JSON result goes to stdout.
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

INSTRUMENTS = {
    'NIFTY':     'index',
    'BANKNIFTY': 'index',
    'CRUDEOILM': 'future',
}

LOOKBACK_DAYS = 5
INTERVAL = '1'


def _resolve(helper, symbol: str, kind: str):
    """Resolve a symbol to {security_id, exchange_segment, instrument_type}, or None."""
    if kind == 'index':
        sec = helper.find_index(symbol, exchange='IDX_I')
        if not sec:
            return None
        return {
            'security_id': str(int(sec['SECURITY_ID'])),
            'exchange_segment': 'IDX_I',
            'instrument_type': 'INDEX',
        }
    sec = helper.find_future(symbol, exchange='MCX', instrument='FUTCOM')
    if not sec:
        return None
    return {
        'security_id': str(int(sec['SECURITY_ID'])),
        'exchange_segment': 'MCX_COMM',
        'instrument_type': 'FUTCOM',
    }


def _to_hhmm(raw) -> str:
    """Convert a Dhan timestamp (unix seconds, unix ms, or ISO string) to HH:MM IST."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:  # milliseconds
            val /= 1000
        dt = datetime.fromtimestamp(val, tz=_IST)
        return dt.strftime('%H:%M')
    except (ValueError, TypeError, OSError):
        pass
    s = str(raw).replace('T', ' ')
    return s[11:16] if len(s) > 10 else s


def _pick_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _filter_last_day(df):
    """Given a multi-day DataFrame, return (filtered_df, date_str) for the most recent day."""
    import pandas as pd

    if df.empty:
        return df, None

    tc = _pick_col(df, ('start_Time', 'timestamp', 'time', 'date')) or df.columns[0]
    col = df[tc]

    if col.dtype in ('int64', 'float64'):
        dates = pd.to_datetime(col, unit='s').dt.date
    else:
        dates = pd.to_datetime(col, errors='coerce').dt.date

    last_day = dates.max()
    mask = dates == last_day
    return df[mask].copy(), str(last_day)


def _fetch_symbol_candles(helper, symbol: str, kind: str):
    """Returns (filtered_df, data_date, error_message). Exactly one of (df, error) is set."""
    resolved = _resolve(helper, symbol, kind)
    if not resolved:
        return None, None, f'Could not resolve {symbol}'

    today = date.today()
    from_date = (today - timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%d')
    to_date = today.strftime('%Y-%m-%d')

    df = helper.get_intraday_minute_data(
        security_id=resolved['security_id'],
        exchange_segment=resolved['exchange_segment'],
        instrument_type=resolved['instrument_type'],
        interval=INTERVAL,
        from_date=from_date,
        to_date=to_date,
    )
    if df.empty:
        return None, None, f'No intraday data for {symbol} in last {LOOKBACK_DAYS} days'

    filtered, data_date = _filter_last_day(df)
    if filtered.empty:
        return None, None, f'No candles found for {symbol} on last trading day'
    return filtered, data_date, None


def _extract_rows(df):
    """DataFrame -> list of {"time","open","close"} sorted ascending by time."""
    ts = _pick_col(df, ('start_Time', 'timestamp', 'time', 'date'))
    oc = _pick_col(df, ('open', 'Open', 'o'))
    cc = _pick_col(df, ('close', 'Close', 'c'))
    if ts is None or oc is None or cc is None:
        return []
    rows = [
        {'time': _to_hhmm(row[ts]), 'open': float(row[oc]), 'close': float(row[cc])}
        for _, row in df.iterrows()
    ]
    rows.sort(key=lambda r: r['time'])
    return rows


def _normalize_series(rows):
    """
    rows: list of {"time","open","close"} sorted ascending by time.
    Returns list of {"time","close","pct"} where pct is % change of close
    vs the FIRST row's open (the instrument's own session-open baseline).
    A zero/missing first open degrades to flat 0.0% rather than raising.
    """
    if not rows:
        return []
    base_open = rows[0]['open']
    if not base_open:
        return [{'time': r['time'], 'close': round(r['close'], 4), 'pct': 0.0} for r in rows]
    out = []
    for r in rows:
        pct = (r['close'] - base_open) / base_open * 100
        out.append({'time': r['time'], 'close': round(r['close'], 4), 'pct': round(pct, 4)})
    return out


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'auth_failed — run login.py to refresh the access token'}))
        return

    helper = DhanHelper(dhan)

    series = {}
    errors = {}
    data_date = None
    is_today_flag = False
    today = date.today().strftime('%Y-%m-%d')

    for symbol, kind in INSTRUMENTS.items():
        df, sym_date, err = _fetch_symbol_candles(helper, symbol, kind)
        if err:
            errors[symbol] = err
            continue
        rows = _extract_rows(df)
        series[symbol] = _normalize_series(rows)
        if data_date is None:
            data_date = sym_date
            is_today_flag = sym_date == today

    if not series:
        print(json.dumps({'success': False, 'error': 'Could not fetch candles for any instrument', 'errors': errors}))
        return

    result = {
        'success': True,
        'data_date': data_date,
        'is_today': is_today_flag,
        'series': series,
    }
    if errors:
        result['errors'] = errors
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'success': False, 'error': str(exc)}))
```

- [ ] **Step 2: Write the failing unit test for the pure normalize function**

Create `tests/test_normalized_1min_candles.py`:

```python
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tools'))

from normalized_1min_candles import _normalize_series


def test_normalize_series_basis_is_first_open():
    rows = [
        {'time': '09:15', 'open': 100.0, 'close': 100.0},
        {'time': '09:16', 'open': 100.5, 'close': 101.0},
        {'time': '09:17', 'open': 101.0, 'close': 99.0},
    ]
    result = _normalize_series(rows)
    assert result[0]['pct'] == 0.0, result
    assert result[1]['pct'] == 1.0, result
    assert result[2]['pct'] == -1.0, result
    assert result[0]['close'] == 100.0


def test_normalize_series_empty_input():
    assert _normalize_series([]) == []


def test_normalize_series_zero_open_does_not_crash():
    rows = [{'time': '09:15', 'open': 0.0, 'close': 5.0}]
    result = _normalize_series(rows)
    assert result == [{'time': '09:15', 'close': 5.0, 'pct': 0.0}]


if __name__ == '__main__':
    test_normalize_series_basis_is_first_open()
    test_normalize_series_empty_input()
    test_normalize_series_zero_open_does_not_crash()
    print('OK - all normalized_1min_candles tests passed')
```

Run: `venv\Scripts\python.exe tests/test_normalized_1min_candles.py`
Expected: FAILS with `ModuleNotFoundError: No module named 'normalized_1min_candles'` (Step 1's file doesn't exist yet if you're doing Steps in strict TDD order — since Step 1 already wrote the file above, this step instead verifies the test file is syntactically correct and the import resolves; skip straight to Step 3).

- [ ] **Step 3: Run the test to verify it passes**

Run: `venv\Scripts\python.exe tests/test_normalized_1min_candles.py`
Expected output: `OK - all normalized_1min_candles tests passed`

- [ ] **Step 4: Manually verify the full script against the live DhanHQ API**

Run (during NSE or MCX market hours, after `venv\Scripts\python.exe login.py` if the token has expired):
```
venv\Scripts\python.exe scripts/tools/normalized_1min_candles.py
```
Expected: a single JSON line with `"success": true`, a `series` object containing `NIFTY`, `BANKNIFTY`, and `CRUDEOILM` arrays of `{time, close, pct}`, and the first element of each array having `"pct": 0.0`. If the market is fully closed for all three instruments, verify it still prints valid JSON (using the last trading day) rather than crashing.

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/normalized_1min_candles.py tests/test_normalized_1min_candles.py
git commit -m "feat(tools): add 1-min normalized candle fetcher for NIFTY/BANKNIFTY/CRUDEOILM"
```

---

### Task 2: API route — `/api/live-normalized-1min`

**Files:**
- Create: `rs_dashboard/app/api/live-normalized-1min/route.ts`

**Interfaces:**
- Consumes: `scripts/tools/normalized_1min_candles.py` (Task 1) via `spawnSync`, stdout JSON shape as documented in Task 1.
- Produces (consumed by Task 3): `GET /api/live-normalized-1min` → JSON body:
  ```ts
  {
    success: boolean;
    data_date?: string;
    is_today?: boolean;
    series?: Record<string, { time: string; close: number; pct: number }[]>;
    errors?: Record<string, string>;
    error?: string;
  }
  ```

- [ ] **Step 1: Create the route file**

Create `rs_dashboard/app/api/live-normalized-1min/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'normalized_1min_candles.py');

interface CandlePoint { time: string; close: number; pct: number }
interface ApiPayload {
  success: boolean;
  data_date?: string;
  is_today?: boolean;
  series?: Record<string, CandlePoint[]>;
  errors?: Record<string, string>;
  error?: string;
}
interface CacheEntry {
  data: ApiPayload;
  ts: number;
}

const cacheHolder: { entry: CacheEntry | null } = { entry: null };
const CACHE_TTL = 45_000;

export async function GET() {
  if (cacheHolder.entry && Date.now() - cacheHolder.entry.ts < CACHE_TTL) {
    return NextResponse.json(cacheHolder.entry.data);
  }

  const result = spawnSync(PYTHON_EXE, [SCRIPT_PATH], {
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });

  if (result.error) {
    console.error('[/api/live-normalized-1min] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as ApiPayload;

    if (!parsed.success) {
      console.error('[/api/live-normalized-1min]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json(parsed, { status: 500 });
    }

    cacheHolder.entry = { data: parsed, ts: Date.now() };
    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[/api/live-normalized-1min] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify the route builds**

Run:
```
cd rs_dashboard
npm run build
```
Expected: build succeeds with no TypeScript errors referencing `live-normalized-1min/route.ts`. (If a dev server is already running via `npm run dev`, a successful hot-reload with no red overlay/error is an acceptable substitute — no need to stop it to run a full build.)

- [ ] **Step 3: Manually verify the endpoint**

With the dev server running (`cd rs_dashboard && npm run dev`), in a separate terminal:
```
curl http://localhost:3000/api/live-normalized-1min
```
Expected: JSON body with `"success": true` and a `series` object (or a clear `"success": false` + `"error"` if the DhanHQ token has expired — in which case run `venv\Scripts\python.exe login.py` first and retry). Run the same `curl` command again immediately — the response should be near-instant (cache hit) rather than re-spawning Python.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/app/api/live-normalized-1min/route.ts
git commit -m "feat(dashboard): add cached API route for 1-min normalized candles"
```

---

### Task 3: Frontend tab component

**Files:**
- Create: `rs_dashboard/components/NormalizedIntradayTab.tsx`

**Interfaces:**
- Consumes: `GET /api/live-normalized-1min` (Task 2), response shape as documented there.
- Produces (consumed by Task 4): default-exported React component `NormalizedIntradayTab`, no props.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/NormalizedIntradayTab.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, Legend,
  ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CandlePoint { time: string; close: number; pct: number }
interface ApiResponse {
  success: boolean;
  data_date?: string;
  is_today?: boolean;
  series?: Record<string, CandlePoint[]>;
  errors?: Record<string, string>;
  error?: string;
}

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'CRUDEOILM'] as const;
type Symbol = typeof SYMBOLS[number];

const COLORS: Record<Symbol, string> = {
  NIFTY: '#10b981',
  BANKNIFTY: '#8b5cf6',
  CRUDEOILM: '#f59e0b',
};

const LABELS: Record<Symbol, string> = {
  NIFTY: 'Nifty 50',
  BANKNIFTY: 'Nifty Bank',
  CRUDEOILM: 'Crude Oil Mini',
};

const POLL_MS = 45_000;

export default function NormalizedIntradayTab() {
  const [data, setData]           = useState<ApiResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-normalized-1min');
      const json: ApiResponse = await res.json();
      setData(json);
      setLastFetch(new Date());
    } catch {
      /* keep last good data on transient network errors */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const merged = useMemo(() => {
    if (!data?.series) return [];
    const allTimes = new Set<string>();
    for (const sym of SYMBOLS) {
      (data.series[sym] ?? []).forEach((p) => allTimes.add(p.time));
    }
    const sortedTimes = [...allTimes].sort();
    const bySymTime: Record<string, Map<string, number>> = {};
    for (const sym of SYMBOLS) {
      bySymTime[sym] = new Map((data.series[sym] ?? []).map((p) => [p.time, p.pct]));
    }
    return sortedTimes.map((t) => {
      const row: Record<string, string | number> = { time: t };
      for (const sym of SYMBOLS) {
        const v = bySymTime[sym].get(t);
        if (v !== undefined) row[sym] = v;
      }
      return row;
    });
  }, [data]);

  const lastPct = (sym: Symbol): number | null => {
    const s = data?.series?.[sym];
    return s && s.length > 0 ? s[s.length - 1].pct : null;
  };

  const hasAnyData = merged.length > 0;
  const availableSymbols = SYMBOLS.filter((s) => (data?.series?.[s]?.length ?? 0) > 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
        <Activity className="h-3.5 w-3.5 text-violet-400" />
        <span className="text-[11px] font-medium text-zinc-300">
          1-Min Normalized · NIFTY / BANKNIFTY / CRUDEOILM
        </span>
        <span className="text-[10px] text-zinc-700 font-mono">poll every {POLL_MS / 1000}s</span>

        {data?.data_date && (
          <span className="text-[10px] text-zinc-600">
            DATA: {data.data_date}{data.is_today ? '' : ' (last session)'}
          </span>
        )}

        {lastFetch && (
          <span className="text-[10px] text-zinc-600 tabular-nums ml-auto hidden md:block">
            fetched {lastFetch.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}

        {loading && <RefreshCw className="h-3 w-3 text-zinc-600 animate-spin" />}
      </div>

      {/* Per-symbol legend / status badges */}
      <div className="flex flex-wrap gap-2">
        {SYMBOLS.map((sym) => {
          const pct = lastPct(sym);
          const err = data?.errors?.[sym];
          return (
            <div
              key={sym}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-950"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[sym] }} />
              <span className="text-[11px] text-zinc-300 font-medium">{LABELS[sym]}</span>
              {pct !== null ? (
                <span className={cn(
                  'text-[11px] font-semibold tabular-nums',
                  pct >= 0 ? 'text-emerald-400' : 'text-red-400',
                )}>
                  {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                </span>
              ) : (
                <span className="text-[11px] text-zinc-600">—</span>
              )}
              {err && (
                <span title={err}>
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        {!hasAnyData ? (
          <div className="flex flex-col items-center justify-center h-[600px] gap-2">
            {loading
              ? <><RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" /><span className="text-zinc-500 text-[12px]">Loading intraday candles…</span></>
              : <><Activity className="h-5 w-5 text-zinc-700" /><span className="text-zinc-600 text-[12px]">No intraday data available</span></>
            }
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={600}>
            <LineChart data={merged} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                domain={['auto', 'auto']}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="4 2" />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#a1a1aa' }}
                formatter={(value: number, name: string) => [
                  `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
                  LABELS[name as Symbol] ?? name,
                ]}
              />
              <Legend
                formatter={(name: string) => (
                  <span style={{ color: '#d4d4d8', fontSize: 11 }}>{LABELS[name as Symbol] ?? name}</span>
                )}
              />
              {availableSymbols.map((sym) => (
                <Line
                  key={sym}
                  type="monotone"
                  dataKey={sym}
                  name={sym}
                  stroke={COLORS[sym]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasAnyData && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {merged.length} candles · normalised to each instrument&apos;s session open
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the component builds**

Run:
```
cd rs_dashboard
npm run build
```
Expected: build succeeds with no TypeScript errors referencing `NormalizedIntradayTab.tsx`. (Component is not yet imported anywhere, so this step only checks it compiles standalone — Task 4 wires it in and is where it's actually rendered.)

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/NormalizedIntradayTab.tsx
git commit -m "feat(dashboard): add 1-min normalized chart tab component"
```

---

### Task 4: Wire the new tab into `LiveDashboard.tsx`

**Files:**
- Modify: `rs_dashboard/components/LiveDashboard.tsx:11` (import), `:203` (tab state type), `:322-337` (tab switcher), `:405-408` (content render)

**Interfaces:**
- Consumes: `NormalizedIntradayTab` default export (Task 3).

- [ ] **Step 1: Add the import**

In `rs_dashboard/components/LiveDashboard.tsx`, after the existing import at line 11:

Old:
```tsx
import LiveNormalizedTab from './LiveNormalizedTab';
```

New:
```tsx
import LiveNormalizedTab from './LiveNormalizedTab';
import NormalizedIntradayTab from './NormalizedIntradayTab';
```

- [ ] **Step 2: Widen the tab state type**

Old:
```tsx
  const [activeTab, setActiveTab] = useState<'market' | 'normalized'>('market');
```

New:
```tsx
  const [activeTab, setActiveTab] = useState<'market' | 'normalized' | 'intraday1min'>('market');
```

- [ ] **Step 3: Add the third tab button**

Old:
```tsx
        {/* Tab switcher */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 gap-0.5">
          {(['market', 'normalized'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-3 py-1 rounded-md text-[11px] font-semibold transition-all capitalize',
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {tab === 'market' ? 'Market' : 'Normalized'}
            </button>
          ))}
        </div>
```

New:
```tsx
        {/* Tab switcher */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 gap-0.5">
          {(['market', 'normalized', 'intraday1min'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-3 py-1 rounded-md text-[11px] font-semibold transition-all capitalize',
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {tab === 'market' ? 'Market' : tab === 'normalized' ? 'Normalized' : '1-Min Normalized'}
            </button>
          ))}
        </div>
```

- [ ] **Step 4: Render the new tab's content**

Old:
```tsx
        {activeTab === 'normalized' ? (
          <LiveNormalizedTab />
        ) : (
        <>
```

New:
```tsx
        {activeTab === 'normalized' ? (
          <LiveNormalizedTab />
        ) : activeTab === 'intraday1min' ? (
          <NormalizedIntradayTab />
        ) : (
        <>
```

- [ ] **Step 5: Verify the build**

Run:
```
cd rs_dashboard
npm run build
```
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Manual browser verification**

```
cd rs_dashboard
npm run dev
```
Then in a browser, open `http://localhost:3000/live`:
- Confirm a third tab labeled "1-Min Normalized" appears next to "Market" and "Normalized"
- Click it; confirm the header strip, three legend badges (Nifty 50 / Nifty Bank / Crude Oil Mini), and the line chart render
- Wait ~45s (or reload) and confirm the chart updates with new candles if the market is open
- If DhanHQ auth has expired, confirm the tab shows the "No intraday data available" state instead of crashing the page — run `venv\Scripts\python.exe login.py` and reload to confirm it recovers

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/components/LiveDashboard.tsx
git commit -m "feat(dashboard): wire 1-min normalized chart into /live tab switcher"
```

---

## Self-Review Notes

- **Spec coverage:** all four "Files Changed" entries from the design spec map 1:1 to Tasks 1–4. Symbol resolution table, normalization rule (% from own session open), partial-failure `errors` handling, and the "no start/stop lifecycle" constraint are all implemented as specified.
- **Type consistency:** `CandlePoint { time, close, pct }` and `ApiResponse` shapes are identical across the Python script's JSON output (Task 1), the API route's TypeScript interfaces (Task 2), and the frontend component's interfaces (Task 3) — verified name-for-name (`data_date`, `is_today`, `series`, `errors`, `error`).
- **No placeholders:** every step contains complete, runnable code; no "TODO" or "similar to Task N" shortcuts.
