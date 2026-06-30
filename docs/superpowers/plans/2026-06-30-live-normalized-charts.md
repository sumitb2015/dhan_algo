# Live Normalized Intraday Charts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Normalized" tab to the `/live` page that plots every-tick intraday % return from session open for all available NSE indices, streamed via a new Python WebSocket bridge.

**Architecture:** A new detached Python process (`live_indices_ws.py`) subscribes to index instruments via Dhan WebSocket and writes a growing session time-series to `debug/live_indices_history.json` every 2 seconds. A new Next.js API route (`/api/live-indices`) manages start/stop and serves that file. A new React component (`LiveNormalizedTab`) polls the route every 3 seconds and renders a Recharts `LineChart` with one line per active index. The existing `LiveDashboard` gains a two-tab header (Market | Normalized) that conditionally renders each view.

**Tech Stack:** Python 3.11 (venv), dhanhq SDK, Next.js App Router, TypeScript, Recharts 3, Tailwind CSS, `lucide-react`.

## Global Constraints

- All Python must run via `venv\Scripts\python.exe` from project root `c:\dhan_algo\dhan_algo`.
- No new npm packages — Recharts is already installed.
- Follow atomic-write pattern for all JSON files: write to `.tmp` then `os.replace`.
- All Next.js files are in `rs_dashboard/` under App Router (`app/` dir).
- `PROJECT_ROOT` in API routes = `path.resolve(process.cwd(), '..')` (one level above `rs_dashboard/`).
- Text colors: never use Tailwind slash-opacity on text (e.g. no `text-white/70`); use solid zinc colors.
- Table/header text: `text-xs font-bold text-white bg-zinc-800` for headers.
- Intraday auto-exit has no bearing on this feature (display only, no orders).
- `PYTHON_EXE` in API route = `path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe')`.

---

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `scripts/tools/live_indices_ws.py` | **Create** | Python bridge: subscribes to index WebSocket ticks, writes history JSON |
| `rs_dashboard/app/api/live-indices/route.ts` | **Create** | API: GET history/status, POST start/stop |
| `rs_dashboard/components/LiveNormalizedTab.tsx` | **Create** | Chart tab: polls API, renders index selector + Recharts line chart |
| `rs_dashboard/components/LiveDashboard.tsx` | **Edit** | Add tab switcher (Market \| Normalized), conditionally render new tab |

---

## Task 1: Python WebSocket bridge — `live_indices_ws.py`

**Files:**
- Create: `scripts/tools/live_indices_ws.py`

**Interfaces:**
- Produces: `debug/live_indices_history.json`, `debug/live_indices_status.json`
- Stop signal: `debug/live_indices_stop.trigger` (bridge polls for this file and exits)

- [ ] **Step 1: Create the file with index catalogue and constants**

Create `scripts/tools/live_indices_ws.py`:

```python
"""
Live indices WebSocket bridge for the RS dashboard Normalized Charts tab.

Subscribes to NSE index instruments via Dhan WebSocket and writes
debug/live_indices_history.json every 2 seconds — full intraday tick history
from session open, used by the Next.js /live Normalized tab.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_indices_ws.py

Stop gracefully by writing debug/live_indices_stop.trigger (done automatically
by the dashboard's /api/live-indices POST {action:"stop"} endpoint).
"""
import sys
import os
import json
import time
import argparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

DEBUG_DIR    = os.path.join(ROOT, 'debug')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_indices_history.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_indices_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_indices_stop.trigger')

# MarketFeed segment/type constants (from dhanhq SDK)
IDX        = 0   # Index segment
FEED_QUOTE = 17  # Quote packet: LTP + OHLC + prev_close

# Index catalogue — symbol → (label, category)
# Symbols must match DhanHelper.find_index() lookup keys.
INDEX_CATALOGUE = [
    # Broad Market
    ('NIFTY',        'Nifty 50',                   'Broad Market'),
    ('NIFTYNXT50',   'Nifty Next 50',               'Broad Market'),
    ('NIFTY100',     'Nifty 100',                   'Broad Market'),
    ('NIFTY200',     'Nifty 200',                   'Broad Market'),
    ('NIFTY500',     'Nifty 500',                   'Broad Market'),
    ('MIDCAP100',    'Nifty Midcap 100',            'Broad Market'),
    ('SMALLCAP100',  'Nifty Smallcap 100',          'Broad Market'),
    # Sectoral
    ('BANKNIFTY',    'Nifty Bank',                  'Sectoral'),
    ('FINNIFTY',     'Nifty Fin Services',           'Sectoral'),
    ('NIFTYIT',      'Nifty IT',                    'Sectoral'),
    ('NIFTYAUTO',    'Nifty Auto',                  'Sectoral'),
    ('NIFTYPHARMA',  'Nifty Pharma',                'Sectoral'),
    ('NIFTYFMCG',    'Nifty FMCG',                  'Sectoral'),
    ('NIFTYMETAL',   'Nifty Metal',                 'Sectoral'),
    ('NIFTYREALTY',  'Nifty Realty',                'Sectoral'),
    ('NIFTYPSUBANK', 'Nifty PSU Bank',              'Sectoral'),
    ('NIFTYPVTBANK', 'Nifty Private Bank',          'Sectoral'),
    ('NIFTYENERGY',  'Nifty Energy',                'Sectoral'),
    ('NIFTYINFRA',   'Nifty Infra',                 'Sectoral'),
    ('NIFTYMEDIA',   'Nifty Media',                 'Sectoral'),
    ('NIFTYHEALTHCARE', 'Nifty Healthcare',         'Sectoral'),
    ('NIFTYOILGAS',  'Nifty Oil and Gas',           'Sectoral'),
    # Volatility
    ('INDIAVIX',     'India VIX',                   'Volatility'),
]
```

- [ ] **Step 2: Add atomic write + status helpers**

Append to the same file:

```python
def atomic_write(path: str, data: dict):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def write_status(status: str, subscribed: int = 0, started_at: str = ''):
    atomic_write(STATUS_FILE, {
        'status': status,
        'pid': os.getpid(),
        'subscribed': subscribed,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
    })


def ist_time() -> str:
    """Return current IST wall-clock time as HH:MM:SS string."""
    # IST = UTC+5:30; use local time since the machine is in IST.
    return datetime.now().strftime('%H:%M:%S')
```

- [ ] **Step 3: Add `main()` — resolve security IDs**

Append to the same file:

```python
def main():
    parser = argparse.ArgumentParser(description='Live indices WebSocket bridge')
    parser.add_argument('--interval', type=float, default=2.0,
                        help='Write interval in seconds (default: 2)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', started_at=started_at)
    print('[live_indices_ws] Starting…', flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_indices_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    # ── Resolve security IDs ─────────────────────────────────────────────────
    sid_to_symbol: dict[str, str] = {}
    labels:   dict[str, str] = {}
    categories: dict[str, str] = {}
    instruments = []

    for sym, label, category in INDEX_CATALOGUE:
        try:
            sec = helper.find_index(sym)
            if sec is None:
                print(f'[live_indices_ws] WARNING: {sym} not found — skipping', flush=True)
                continue
            sid = str(int(sec['SECURITY_ID']))
            sid_to_symbol[sid] = sym
            labels[sym]     = label
            categories[sym] = category
            instruments.append((IDX, sid, FEED_QUOTE))
            print(f'[live_indices_ws] Resolved {sym} → SID {sid}', flush=True)
        except Exception as e:
            print(f'[live_indices_ws] WARNING: could not resolve {sym}: {e}', flush=True)

    n = len(instruments)
    if n == 0:
        print('[live_indices_ws] ERROR: no instruments resolved — aborting', flush=True)
        write_status('ERROR', started_at=started_at)
        sys.exit(1)

    print(f'[live_indices_ws] Subscribing to {n} indices…', flush=True)
```

- [ ] **Step 4: Add WebSocket start + session-open baseline restore**

Append inside `main()` after the resolution block:

```python
    helper.start_websocket(instruments)
    time.sleep(3)  # wait for connection + first tick batch

    # ── Restore session open baseline if same calendar day ───────────────────
    session_date = datetime.now().strftime('%Y-%m-%d')
    opens:      dict[str, float] = {}
    ticks:      list[dict]       = []
    last_known: dict[str, float] = {}  # forward-fill buffer

    try:
        if os.path.exists(HISTORY_FILE):
            existing = json.loads(open(HISTORY_FILE).read())
            if existing.get('session_date') == session_date:
                opens = existing.get('opens', {})
                ticks = existing.get('ticks', [])
                print(f'[live_indices_ws] Restored {len(opens)} opens and '
                      f'{len(ticks)} ticks from existing history', flush=True)
    except Exception as e:
        print(f'[live_indices_ws] WARNING: could not restore history: {e}', flush=True)

    write_status('RUNNING', subscribed=n, started_at=started_at)
    print('[live_indices_ws] WebSocket connected. Writing history every '
          f'{args.interval}s…', flush=True)
```

- [ ] **Step 5: Add main polling loop**

Append inside `main()` after the restore block:

```python
    try:
        while True:
            # ── Graceful stop ─────────────────────────────────────────────────
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_indices_ws] Stop trigger detected — exiting.', flush=True)
                break

            # ── Collect snapshot ──────────────────────────────────────────────
            snapshot: dict[str, float] = {}
            for sid, sym in sid_to_symbol.items():
                tick = helper.live_data.get(sid)
                if tick:
                    ltp = float(tick.get('LTP') or tick.get('last_price') or 0)
                    if ltp > 0:
                        last_known[sym] = ltp
                # forward-fill if no new tick
                if sym in last_known:
                    snapshot[sym] = last_known[sym]

            if snapshot:
                # Capture session open on first valid tick per symbol
                for sym, ltp in snapshot.items():
                    if sym not in opens:
                        opens[sym] = ltp

                entry: dict = {'t': ist_time()}
                entry.update(snapshot)
                ticks.append(entry)

            # ── Build current LTPs map ────────────────────────────────────────
            ltps = {sym: last_known[sym] for sym in last_known}

            # ── Write history file ────────────────────────────────────────────
            available = list(sid_to_symbol.values())
            atomic_write(HISTORY_FILE, {
                'session_date': session_date,
                'updated_at':   datetime.now().isoformat(),
                'available':    available,
                'labels':       labels,
                'categories':   categories,
                'opens':        opens,
                'ltps':         ltps,
                'ticks':        ticks,
            })
            write_status('RUNNING', subscribed=n, started_at=started_at)

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print('[live_indices_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        write_status('STOPPED', subscribed=0, started_at=started_at)
        print('[live_indices_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
```

- [ ] **Step 6: Smoke-test the bridge manually**

Run (after activating venv and ensuring market hours or testing with cached master list):

```powershell
venv\Scripts\python.exe scripts/tools/live_indices_ws.py
```

Expected output (first ~10 seconds):
```
[live_indices_ws] Starting…
[live_indices_ws] Resolved NIFTY → SID 13
[live_indices_ws] Resolved BANKNIFTY → SID 25
[live_indices_ws] Resolved FINNIFTY → SID 27
...
[live_indices_ws] Subscribing to N indices…
[live_indices_ws] WebSocket connected. Writing history every 2.0s…
```

Then check `debug/live_indices_history.json` exists and contains `ticks` array growing each poll. Press Ctrl+C to stop — confirm `status` in `debug/live_indices_status.json` shows `STOPPED`.

If outside market hours, `ticks` will be empty but the file will be written with `available`, `labels`, `opens: {}`.

- [ ] **Step 7: Test stop trigger**

```powershell
# In one terminal, start the bridge:
venv\Scripts\python.exe scripts/tools/live_indices_ws.py

# In another terminal, write the stop trigger:
New-Item -Path "debug\live_indices_stop.trigger" -ItemType File -Force
```

Expected: bridge prints `Stop trigger detected — exiting.` and status file shows `STOPPED`.

- [ ] **Step 8: Commit**

```bash
git add scripts/tools/live_indices_ws.py
git commit -m "feat(live): add live_indices_ws.py WebSocket bridge for index tick streaming"
```

---

## Task 2: API route — `/api/live-indices`

**Files:**
- Create: `rs_dashboard/app/api/live-indices/route.ts`

**Interfaces:**
- Consumes: `debug/live_indices_history.json`, `debug/live_indices_status.json`, `debug/live_indices_stop.trigger`
- Produces GET response:
  ```ts
  {
    success: boolean;
    status: { status: 'STARTING'|'RUNNING'|'STOPPED'|'ERROR'; pid?: number; subscribed?: number; started_at?: string; last_update?: string };
    history: {
      session_date: string;
      updated_at: string;
      available: string[];
      labels: Record<string, string>;
      categories: Record<string, string>;
      opens: Record<string, number>;
      ltps: Record<string, number>;
      ticks: Array<Record<string, string | number>>;
    } | null;
  }
  ```

- [ ] **Step 1: Create the route file**

Create `rs_dashboard/app/api/live-indices/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const DEBUG_DIR     = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'live_indices_ws.py');
const HISTORY_FILE  = path.join(DEBUG_DIR, 'live_indices_history.json');
const STATUS_FILE   = path.join(DEBUG_DIR, 'live_indices_status.json');
const STOP_TRIGGER  = path.join(DEBUG_DIR, 'live_indices_stop.trigger');

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      return out.includes(String(pid));
    }
    execSync(`ps -p ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** GET — return history + bridge status */
export async function GET() {
  const history = readJson(HISTORY_FILE);
  const status  = readJson(STATUS_FILE);

  if (status && status.pid && status.status === 'RUNNING') {
    if (!isPidRunning(Number(status.pid))) {
      status.status = 'STOPPED';
    }
  }

  return NextResponse.json({
    success: true,
    status:  status ?? { status: 'STOPPED', subscribed: 0 },
    history: history ?? null,
  });
}

/** POST — start or stop the WebSocket bridge */
export async function POST(request: NextRequest) {
  const body   = await request.json().catch(() => ({}));
  const action = (body.action ?? '') as string;

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (action === 'stop') {
    fs.writeFileSync(STOP_TRIGGER, '');
    return NextResponse.json({ success: true, message: 'Stop trigger written' });
  }

  if (action === 'start') {
    const status = readJson(STATUS_FILE);
    if (status?.pid && status.status === 'RUNNING' && isPidRunning(Number(status.pid))) {
      return NextResponse.json({ success: true, message: 'Bridge already running', pid: status.pid });
    }
    if (fs.existsSync(STOP_TRIGGER)) fs.unlinkSync(STOP_TRIGGER);

    const child = spawn(PYTHON_EXE, [BRIDGE_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    return NextResponse.json({ success: true, message: 'Bridge started', pid: child.pid });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
```

- [ ] **Step 2: Test GET while bridge is stopped**

With the Next.js dev server running (`cd rs_dashboard && npm run dev`), visit:

```
http://localhost:3000/api/live-indices
```

Expected response:
```json
{
  "success": true,
  "status": { "status": "STOPPED", "subscribed": 0 },
  "history": null
}
```

- [ ] **Step 3: Test start via POST**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/live-indices" `
  -Method POST -ContentType "application/json" `
  -Body '{"action":"start"}'
```

Expected: `{"success":true,"message":"Bridge started","pid":XXXXX}`

Then wait 5 seconds and GET again — `status.status` should be `"RUNNING"` and `history` should have `available`, `ticks`.

- [ ] **Step 4: Test stop via POST**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/live-indices" `
  -Method POST -ContentType "application/json" `
  -Body '{"action":"stop"}'
```

Expected: `{"success":true,"message":"Stop trigger written"}`

Wait 3 seconds, GET again — `status.status` should be `"STOPPED"`.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/app/api/live-indices/route.ts
git commit -m "feat(live): add /api/live-indices route for indices bridge management"
```

---

## Task 3: `LiveNormalizedTab` component

**Files:**
- Create: `rs_dashboard/components/LiveNormalizedTab.tsx`

**Interfaces:**
- Consumes: `/api/live-indices` GET response (shape defined in Task 2 interfaces)
- Props: none (self-contained, manages its own polling and bridge controls)

- [ ] **Step 1: Create file — types, constants, colour palette**

Create `rs_dashboard/components/LiveNormalizedTab.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, TooltipProps,
} from 'recharts';
import { Activity, Play, Square, RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BridgeStatus {
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  pid?: number;
  subscribed?: number;
  started_at?: string;
  last_update?: string;
}

interface IndexHistory {
  session_date: string;
  updated_at: string;
  available: string[];
  labels: Record<string, string>;
  categories: Record<string, string>;
  opens: Record<string, number>;
  ltps: Record<string, number>;
  ticks: Array<Record<string, string | number>>;
}

// ─── Colour palette ───────────────────────────────────────────────────────────
// Fixed order: NIFTY=emerald, BANKNIFTY=violet, then cycling through the rest.

const SYMBOL_ORDER = [
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'NIFTYIT', 'NIFTYAUTO', 'NIFTYPHARMA',
  'NIFTYFMCG', 'NIFTYMETAL', 'NIFTYREALTY', 'NIFTYPSUBANK', 'NIFTYPVTBANK',
  'NIFTYENERGY', 'NIFTYINFRA', 'NIFTYMEDIA', 'NIFTYHEALTHCARE', 'NIFTYOILGAS',
  'NIFTY100', 'NIFTY200', 'NIFTY500', 'NIFTYNXT50', 'MIDCAP100', 'SMALLCAP100',
  'INDIAVIX',
];

const PALETTE = [
  '#10b981', // emerald-500  — NIFTY
  '#8b5cf6', // violet-500   — BANKNIFTY
  '#06b6d4', // cyan-500
  '#f59e0b', // amber-500
  '#f43f5e', // rose-500
  '#3b82f6', // blue-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
  '#ef4444', // red-500
  '#0ea5e9', // sky-500
  '#a855f7', // purple-500
  '#22c55e', // green-500
  '#eab308', // yellow-500
  '#64748b', // slate-500
  '#d946ef', // fuchsia-500
  '#78716c', // stone-500
  '#0d9488', // teal-600
  '#7c3aed', // violet-600
  '#b45309', // amber-700
  '#be123c', // rose-700
];

function colorFor(sym: string): string {
  const idx = SYMBOL_ORDER.indexOf(sym);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : PALETTE.length - 1];
}

const STORAGE_KEY = 'live_normalized_selected_indices';
const PINNED = new Set(['NIFTY', 'BANKNIFTY']);
```

- [ ] **Step 2: Add custom tooltip component**

Append to `LiveNormalizedTab.tsx`:

```tsx
// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface PctTooltipProps extends TooltipProps<number, string> {
  opens: Record<string, number>;
  labels: Record<string, string>;
  activeSymbols: string[];
}

function PctTooltip({ active, payload, label, opens, labels, activeSymbols }: PctTooltipProps) {
  if (!active || !payload?.length) return null;

  const entries: { sym: string; pct: number; ltp: number }[] = [];
  for (const sym of activeSymbols) {
    const p = payload.find((e) => e.dataKey === sym);
    if (p?.value !== undefined && opens[sym]) {
      const pct = (p.value as number);
      const ltp = opens[sym] * (1 + pct / 100);
      entries.push({ sym, pct, ltp });
    }
  }
  entries.sort((a, b) => b.pct - a.pct);

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-[11px] shadow-xl min-w-[200px]">
      <div className="text-zinc-400 font-semibold mb-1.5 pb-1 border-b border-zinc-800">{label}</div>
      {entries.map(({ sym, pct, ltp }) => (
        <div key={sym} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorFor(sym) }} />
            <span className="text-zinc-300">{labels[sym] ?? sym}</span>
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            <span className={pct >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
              {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
            </span>
            <span className="text-zinc-500">{ltp.toFixed(2)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add live dot micro-component and index selector chip**

Append to `LiveNormalizedTab.tsx`:

```tsx
// ─── Micro-components ─────────────────────────────────────────────────────────

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {active && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
      <span className={cn('relative inline-flex rounded-full h-2 w-2', active ? 'bg-emerald-500' : 'bg-zinc-600')} />
    </span>
  );
}

function IndexChip({
  sym, label, color, selected, pinned, onToggle,
}: {
  sym: string; label: string; color: string; selected: boolean; pinned: boolean; onToggle: () => void;
}) {
  return (
    <button
      onClick={pinned ? undefined : onToggle}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border transition-all',
        pinned
          ? 'border-zinc-600 bg-zinc-800 text-zinc-200 cursor-default'
          : selected
            ? 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            : 'border-zinc-800 bg-zinc-950 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400',
      )}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: selected ? color : '#52525b' }} />
      {label}
      {pinned && <span className="text-[9px] text-zinc-500 ml-0.5">●</span>}
    </button>
  );
}
```

- [ ] **Step 4: Add main `LiveNormalizedTab` component — state and data fetch**

Append to `LiveNormalizedTab.tsx`:

```tsx
// ─── Main component ────────────────────────────────────────────────────────────

export default function LiveNormalizedTab() {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'STOPPED' });
  const [history, setHistory]           = useState<IndexHistory | null>(null);
  const [selected, setSelected]         = useState<Set<string>>(new Set(PINNED));
  const [actionLoading, setActionLoading] = useState(false);
  const [lastTick, setLastTick]         = useState<Date | null>(null);
  const pollRef                         = useRef<ReturnType<typeof setInterval> | null>(null);
  const initializedRef                  = useRef(false);

  // ── Restore selection from localStorage ────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: string[] = JSON.parse(stored);
        setSelected(new Set([...PINNED, ...parsed]));
      }
    } catch { /* ignore */ }
  }, []);

  // ── When history first arrives, select all available indices ───────────────
  useEffect(() => {
    if (!history || initializedRef.current) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored && history.available.length > 0) {
      // First ever load — select everything
      setSelected(new Set(history.available));
    }
    initializedRef.current = true;
  }, [history]);

  // ── Poll /api/live-indices ─────────────────────────────────────────────────
  const pollLive = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-indices');
      const json = await res.json();
      if (!json.success) return;
      setBridgeStatus(json.status);
      if (json.history) {
        setHistory(json.history);
        if (json.history.ticks?.length > 0) setLastTick(new Date());
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    pollLive();
    pollRef.current = setInterval(pollLive, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollLive]);

  // ── Bridge start / stop ────────────────────────────────────────────────────
  const sendAction = useCallback(async (action: 'start' | 'stop') => {
    setActionLoading(true);
    try {
      await fetch('/api/live-indices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setTimeout(pollLive, 1000);
    } catch { /* ignore */ }
    finally { setActionLoading(false); }
  }, [pollLive]);

  // ── Toggle index selection ─────────────────────────────────────────────────
  const toggleIndex = useCallback((sym: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      try {
        const toStore = [...next].filter((s) => !PINNED.has(s));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
      } catch { /* ignore */ }
      return next;
    });
  }, []);
```

- [ ] **Step 5: Add normalised ticks memo and render**

Append inside the component (before the return statement):

```tsx
  // ── Normalise ticks to % from open ────────────────────────────────────────
  const pctTicks = useMemo(() => {
    if (!history?.ticks?.length || !history.opens) return [];
    return history.ticks.map((tick) => {
      const entry: Record<string, string | number> = { t: tick.t as string };
      for (const sym of history.available) {
        const ltp  = tick[sym] as number | undefined;
        const open = history.opens[sym];
        if (ltp !== undefined && open && open > 0) {
          entry[sym] = parseFloat(((ltp - open) / open * 100).toFixed(4));
        }
      }
      return entry;
    });
  }, [history]);

  const activeSymbols = history
    ? history.available.filter((s) => selected.has(s))
    : [];

  const isLive     = bridgeStatus.status === 'RUNNING';
  const isStarting = bridgeStatus.status === 'STARTING';
  const staleQuotes = lastTick && (Date.now() - lastTick.getTime() > 15_000);

  // Group available indices by category
  const byCategory = useMemo(() => {
    if (!history) return {} as Record<string, string[]>;
    const map: Record<string, string[]> = {};
    for (const sym of history.available) {
      const cat = history.categories[sym] ?? 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(sym);
    }
    return map;
  }, [history]);

  // X-axis tick spacing: show ~12 ticks max
  const xInterval = pctTicks.length > 12
    ? Math.floor(pctTicks.length / 12)
    : 0;

  return (
    <div className="flex flex-col gap-3">

      {/* ── Bridge controls strip ── */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
        <LiveDot active={isLive} />
        <span className={cn(
          'text-[11px] font-medium',
          isLive ? 'text-emerald-400' : isStarting ? 'text-amber-400' : 'text-zinc-500',
        )}>
          {isLive
            ? `Indices feed live · ${bridgeStatus.subscribed ?? 0} subscribed`
            : isStarting ? 'Connecting to indices…'
            : 'Indices feed offline'}
        </span>

        <button
          onClick={() => sendAction(isLive || isStarting ? 'stop' : 'start')}
          disabled={actionLoading}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-50',
            isLive || isStarting
              ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
          )}
        >
          {actionLoading
            ? <RefreshCw className="h-3 w-3 animate-spin" />
            : isLive || isStarting
              ? <Square className="h-3 w-3" />
              : <Play className="h-3 w-3" />}
          {isLive || isStarting ? 'Stop Indices Feed' : 'Start Indices Feed'}
        </button>

        {lastTick && (
          <span className={cn('text-[10px] tabular-nums ml-auto hidden md:block', staleQuotes ? 'text-amber-400' : 'text-zinc-600')}>
            {lastTick.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}
        {history && (
          <span className="text-[10px] text-zinc-600 hidden md:block">
            DATA: {isLive ? <span className="text-emerald-500">LIVE</span> : <span className="text-zinc-500">OFFLINE</span>}
          </span>
        )}
      </div>

      {/* ── Offline banner ── */}
      {!isLive && !isStarting && (
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 rounded-lg border border-zinc-700/50 bg-zinc-900/40 text-[12px]">
          <WifiOff className="h-4 w-4 text-zinc-500 shrink-0" />
          <span className="text-zinc-400">Indices WebSocket feed is offline — start the feed to see live normalized charts.</span>
          <button
            onClick={() => sendAction('start')}
            disabled={actionLoading}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 font-semibold transition-all disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> Start Indices Feed
          </button>
        </div>
      )}

      {/* ── Connecting banner ── */}
      {isStarting && (
        <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/5 text-[12px] text-amber-300">
          <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
          Connecting to index WebSocket — first ticks usually arrive within 5–10 seconds…
        </div>
      )}

      {/* ── Index selector grid ── */}
      {history && history.available.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex flex-col gap-2.5">
          {Object.entries(byCategory).map(([cat, syms]) => (
            <div key={cat}>
              <div className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-1.5">{cat}</div>
              <div className="flex flex-wrap gap-1.5">
                {syms.map((sym) => (
                  <IndexChip
                    key={sym}
                    sym={sym}
                    label={history.labels[sym] ?? sym}
                    color={colorFor(sym)}
                    selected={selected.has(sym)}
                    pinned={PINNED.has(sym)}
                    onToggle={() => toggleIndex(sym)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Chart area ── */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        {pctTicks.length < 2 ? (
          <div className="flex flex-col items-center justify-center h-[420px] gap-2">
            {isLive || isStarting
              ? <><RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" /><span className="text-zinc-500 text-[12px]">Waiting for first ticks…</span></>
              : <><Activity className="h-5 w-5 text-zinc-700" /><span className="text-zinc-600 text-[12px]">Start the indices feed to see the chart</span><span className="text-zinc-700 text-[11px]">Market hours: 09:15 – 15:30 IST</span></>
            }
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <LineChart data={pctTicks} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
              <XAxis
                dataKey="t"
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
                interval={xInterval}
                tickFormatter={(v: string) => v.slice(0, 5)}
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
                content={
                  <PctTooltip
                    opens={history?.opens ?? {}}
                    labels={history?.labels ?? {}}
                    activeSymbols={activeSymbols}
                  />
                }
              />
              {activeSymbols.map((sym) => (
                <Line
                  key={sym}
                  type="monotone"
                  dataKey={sym}
                  stroke={colorFor(sym)}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Footer note ── */}
      {pctTicks.length > 1 && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {pctTicks.length} ticks · normalised to session open · {activeSymbols.length} of {history?.available.length ?? 0} indices shown
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors. If there are type errors in `TooltipProps<number, string>` usage, adjust generic params to match the installed recharts version — check with `node -e "console.log(require('recharts/package.json').version)"`.

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/components/LiveNormalizedTab.tsx
git commit -m "feat(live): add LiveNormalizedTab component with index selector and Recharts line chart"
```

---

## Task 4: Wire tab switcher into `LiveDashboard.tsx`

**Files:**
- Modify: `rs_dashboard/components/LiveDashboard.tsx`

**Interfaces:**
- Imports: `LiveNormalizedTab` from `./LiveNormalizedTab`
- Adds tab state: `useState<'market' | 'normalized'>('market')`

- [ ] **Step 1: Add import at top of file**

In `rs_dashboard/components/LiveDashboard.tsx`, add after the existing imports:

```tsx
import LiveNormalizedTab from './LiveNormalizedTab';
```

- [ ] **Step 2: Add tab state inside `LiveDashboard` component**

Inside the `LiveDashboard` function, after the existing `useState` declarations (around line 201), add:

```tsx
  const [activeTab, setActiveTab] = useState<'market' | 'normalized'>('market');
```

- [ ] **Step 3: Add tab switcher to the sticky header**

In the header JSX, after the title block (the `<div>` containing the `Activity` icon and "Live Market" text, around line 310–316) and the divider `<div className="w-px h-5 bg-zinc-800 ...">`, add a tab bar before `<NavBar />`:

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

- [ ] **Step 4: Make bridge status dot + button tab-aware**

The existing header shows the equity bridge dot and button unconditionally. Wrap them in `{activeTab === 'market' && (...)}` so they only show on the Market tab:

Find the "Bridge status" block (around line 323–334) and wrap it:
```tsx
        {/* Bridge status — only on Market tab */}
        {activeTab === 'market' && (
          <div className="flex items-center gap-1.5 ml-1">
            <LiveDot active={isLive} />
            <span className={cn(
              'text-[11px] font-medium',
              isLive ? 'text-emerald-400' : isStarting ? 'text-amber-400' : 'text-zinc-500',
            )}>
              {isLive
                ? `Live · ${bridgeStatus.subscribed ?? 0} symbols`
                : isStarting ? 'Connecting…'
                : 'Offline'}
            </span>
          </div>
        )}
```

Find the "Start / Stop" button block (around line 337–353) and wrap it:
```tsx
        {/* Start/Stop — only on Market tab */}
        {activeTab === 'market' && (
          <button
            onClick={() => sendAction(isLive || isStarting ? 'stop' : 'start')}
            disabled={actionLoading}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-50',
              isLive || isStarting
                ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
            )}
          >
            {actionLoading
              ? <RefreshCw className="h-3 w-3 animate-spin" />
              : isLive || isStarting
                ? <Square className="h-3 w-3" />
                : <Play className="h-3 w-3" />}
            {isLive || isStarting ? 'Stop Feed' : 'Start Feed'}
          </button>
        )}
```

Also wrap the search input and last-tick chip in `{activeTab === 'market' && (...)}` to keep the header uncluttered on the Normalized tab (the search field is stock-only).

- [ ] **Step 5: Conditionally render content based on active tab**

In the `<main>` block, replace the entire content with a conditional:

```tsx
      <main className="flex-1 w-full max-w-[1800px] mx-auto px-4 py-3 flex flex-col gap-3">
        {activeTab === 'normalized' ? (
          <LiveNormalizedTab />
        ) : (
          <>
            {/* No-feed banner */}
            {/* ... all existing market tab content unchanged ... */}
          </>
        )}
      </main>
```

The existing content (no-feed banner, starting banner, summary strip, loading state, live table, mini leaders) moves verbatim into the `<>...</>` fragment — nothing is deleted.

- [ ] **Step 6: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Manual end-to-end test in browser**

Start the dev server if not running:
```powershell
cd rs_dashboard
npm run dev
```

1. Navigate to `http://localhost:3000/live`
2. Confirm two tabs appear in the header: **Market** and **Normalized**
3. **Market tab**: existing stock table renders as before; Start/Stop button and live dot visible.
4. **Normalized tab**: click it. Confirm header controls (equity bridge dot/button/search) are hidden. Controls strip shows "Indices feed offline" with a Start button.
5. Click "Start Indices Feed" — observe amber "Connecting…" banner, then green "Indices feed live" after a few seconds.
6. Confirm the index selector grid appears grouped by Broad Market / Sectoral / Volatility.
7. Confirm chart renders with colored lines once ticks accumulate (may need to wait ~10 s for 5+ ticks).
8. Toggle an index chip off — confirm its line disappears from chart.
9. Refresh the page — confirm selected indices are restored from localStorage.
10. Click "Stop Indices Feed" — confirm banner returns to offline state.

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/components/LiveDashboard.tsx
git commit -m "feat(live): add Market/Normalized tab switcher and wire LiveNormalizedTab"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task covering it |
|-----------------|-----------------|
| New Python bridge for indices | Task 1 |
| Resolve indices via `find_index()`, skip failures | Task 1 Step 3 |
| Segment code 0 (IDX), feed type 17 (FEED_QUOTE) | Task 1 Step 1 |
| Session open baseline captured on first tick | Task 1 Step 4 |
| Baseline restored from existing file on same calendar day | Task 1 Step 4 |
| Forward-fill last known LTP | Task 1 Step 5 |
| `debug/live_indices_history.json` wide-format output | Task 1 Steps 4–5 |
| `debug/live_indices_status.json` + stop trigger pattern | Task 1 Steps 2, 7 |
| `/api/live-indices` GET/POST route | Task 2 |
| PID cross-check for crashed bridge detection | Task 2 Step 1 |
| `LiveNormalizedTab` component with polling | Task 3 |
| Color palette — NIFTY=emerald, BANKNIFTY=violet | Task 3 Step 1 |
| Index selector grouped by category | Task 3 Step 5 |
| NIFTY + BANKNIFTY always pinned | Task 3 Steps 1, 3 |
| Default: all available indices selected | Task 3 Step 4 |
| Selection persisted in localStorage | Task 3 Steps 4, 5 |
| Recharts `LineChart`, `dot={false}`, `isAnimationActive={false}` | Task 3 Step 5 |
| % normalised to session open via `useMemo` | Task 3 Step 5 |
| Custom tooltip: sorted by % desc, shows LTP | Task 3 Step 2 |
| X-axis HH:MM format | Task 3 Step 5 |
| Y-axis `+0.42%` format | Task 3 Step 5 |
| Y=0 `ReferenceLine` | Task 3 Step 5 |
| Offline / connecting / waiting banners | Task 3 Step 5 |
| DATA: LIVE / OFFLINE chip | Task 3 Step 5 |
| Tab switcher in `LiveDashboard.tsx` | Task 4 |
| Header controls tab-aware (equity controls hidden on Normalized tab) | Task 4 Steps 4 |
| Full index catalogue (20+ symbols) | Task 1 Step 1 |

No gaps found.

**Type consistency check:**

- `IndexHistory.ticks` typed as `Array<Record<string, string | number>>` — consistent with how `pctTicks` is produced in Task 3 Step 5 and how the bridge writes `{ t: "HH:MM:SS", NIFTY: 24000.0, ... }`.
- `colorFor(sym)` defined in Task 3 Step 1, used in Steps 3 and 5 — consistent.
- `PINNED` defined as `Set<string>` in Step 1, used in Steps 3 and 4 — consistent.
- `activeSymbols` is `string[]`, passed to `PctTooltip.activeSymbols: string[]` — consistent.
- `sendAction` signature `(action: 'start' | 'stop') => Promise<void>` — used correctly in Steps 4 and 5.
