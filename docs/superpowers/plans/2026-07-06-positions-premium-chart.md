# Combined Open Premium Chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Combined Open Premium" panel inside the Positions tab that shows a minute-by-minute line chart of combined open sell premium reconstructed from the day's tradebook.

**Architecture:** A new Python script fetches the tradebook, filters to FNO, applies FIFO position matching, and builds a per-minute premium series. A new Next.js API route shells out to that script. The existing `OptionsPositionsTab` component gains a new panel at the bottom with the chart and a stat tile.

**Tech Stack:** Python 3 + DhanHelper, Next.js App Router (TypeScript), Recharts

## Global Constraints

- All Python commands run from project root `c:\dhan_algo\dhan_algo` using `venv\Scripts\python.exe`
- `PROJECT_ROOT` in API routes = `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`)
- Python exe in API routes = `venv/Scripts/pythonw.exe` (windowsHide: true, timeout: 30_000)
- No text color opacity modifiers on Tailwind classes (use solid zinc colors, not `text-white/70`)
- Table headers: `text-xs font-bold text-white` on `bg-zinc-800`
- Premium unit: **per-lot** (`qty_lots × price`), NOT `raw_qty × price`. `qty_lots = tradedQuantity / lot_size`
- FIFO position matching: SELL pushes onto a per-symbol deque; BUY pops from the front (partial exits split the front entry)

---

### Task 1: Python script `scripts/tools/tradebook_premium.py`

**Files:**
- Create: `scripts/tools/tradebook_premium.py`

**Interfaces:**
- Consumes: `DhanHelper.get_trade_book()` → `List[Dict]` with fields `tradingSymbol`, `exchangeSegment`, `transactionType`, `tradedQuantity`, `tradedPrice`, `exchangeTime`, `createTime`; `DhanHelper.get_lot_size(underlying: str)` → `int`
- Produces: stdout JSON `{ success, data: [{time: "HH:MM", premium: float}], current_premium: float, session_date: str, trades_count: int }`

- [ ] **Step 1: Write the script**

Create `scripts/tools/tradebook_premium.py` with the full content below:

```python
"""
Outputs minute-by-minute combined open sell premium from today's FNO tradebook.
Called by the Next.js /api/options/premium-chart route.
"""
import sys
import os
import json
import re
from collections import deque
from datetime import datetime, date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

SESSION_START = "09:15"
SESSION_END   = "15:30"


def extract_underlying(symbol: str) -> str:
    """Extract underlying from option symbol, e.g. NIFTY2470725000CE → NIFTY."""
    m = re.match(r'^([A-Z&]+)\d{6}', symbol)
    return m.group(1) if m else symbol


def get_trade_minute(trade: dict) -> str:
    """Return HH:MM from trade dict, preferring exchangeTime over createTime."""
    raw = trade.get('exchangeTime') or trade.get('createTime') or ''
    try:
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
            try:
                return datetime.strptime(raw[:19], fmt).strftime('%H:%M')
            except ValueError:
                continue
    except Exception:
        pass
    return raw[11:16] if len(raw) >= 16 else SESSION_START


def build_minute_series(
    events: list[tuple[str, float]],
    is_post_session: bool,
) -> list[dict]:
    """
    Expand (HH:MM, premium) events into a per-minute flat series.
    Holds last known value between events.
    """
    now_str  = datetime.now().strftime('%H:%M')
    end_str  = SESSION_END if is_post_session or now_str >= SESSION_END else now_str

    start_dt = datetime.strptime(SESSION_START, '%H:%M')
    end_dt   = datetime.strptime(end_str,       '%H:%M')

    # Last event per minute wins
    event_map: dict[str, float] = {}
    for t, p in events:
        event_map[t] = p

    series: list[dict] = []
    current      = start_dt
    last_premium = 0.0

    while current <= end_dt:
        t = current.strftime('%H:%M')
        if t in event_map:
            last_premium = event_map[t]
        series.append({'time': t, 'premium': round(last_premium, 2)})
        current += timedelta(minutes=1)

    return series


def main() -> None:
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'Failed to authenticate'}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    trades     = helper.get_trade_book()
    fno_trades = [t for t in trades if t.get('exchangeSegment') == 'NSE_FNO']

    today = date.today().isoformat()

    if not fno_trades:
        print(json.dumps({
            'success': True,
            'data': [],
            'current_premium': 0.0,
            'session_date': today,
            'trades_count': 0,
        }))
        return

    # Resolve lot sizes for each unique underlying
    underlyings = {extract_underlying(t['tradingSymbol']) for t in fno_trades}
    lot_sizes: dict[str, int] = {}
    for u in underlyings:
        try:
            lot_sizes[u] = int(helper.get_lot_size(u) or 1)
        except Exception:
            lot_sizes[u] = 1

    # Sort trades chronologically
    fno_trades.sort(key=lambda t: (t.get('exchangeTime') or t.get('createTime') or ''))

    # FIFO open-position tracking
    # open_positions[symbol] = deque of {'lots': float, 'sell_price': float}
    open_positions: dict[str, deque] = {}
    combined_premium = 0.0
    events: list[tuple[str, float]] = []

    for trade in fno_trades:
        symbol     = trade.get('tradingSymbol', '')
        underlying = extract_underlying(symbol)
        lot_size   = lot_sizes.get(underlying, 1)
        raw_qty    = float(trade.get('tradedQuantity') or 0)
        qty_lots   = raw_qty / lot_size
        price      = float(trade.get('tradedPrice') or 0)
        txn        = trade.get('transactionType', '')
        minute     = get_trade_minute(trade)

        if txn == 'SELL':
            if symbol not in open_positions:
                open_positions[symbol] = deque()
            open_positions[symbol].append({'lots': qty_lots, 'sell_price': price})
            combined_premium += qty_lots * price

        elif txn == 'BUY':
            q         = open_positions.get(symbol, deque())
            remaining = qty_lots
            while remaining > 0 and q:
                front = q[0]
                if front['lots'] <= remaining:
                    combined_premium -= front['lots'] * front['sell_price']
                    remaining        -= front['lots']
                    q.popleft()
                else:
                    combined_premium      -= remaining * front['sell_price']
                    front['lots']         -= remaining
                    remaining              = 0

        events.append((minute, round(combined_premium, 2)))

    now_hm        = datetime.now().strftime('%H:%M')
    is_post       = now_hm > SESSION_END
    series        = build_minute_series(events, is_post)

    print(json.dumps({
        'success':         True,
        'data':            series,
        'current_premium': round(combined_premium, 2),
        'session_date':    today,
        'trades_count':    len(fno_trades),
    }))


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run the script directly and verify output**

```powershell
venv\Scripts\python.exe scripts/tools/tradebook_premium.py
```

Expected: valid JSON on stdout with `"success": true`. On a trading day with FNO trades, `data` array should have entries every minute from `09:15`. On a non-trading day or if no FNO trades exist, `data` should be `[]` and `trades_count` should be `0`. No Python traceback.

- [ ] **Step 3: Commit**

```bash
git add scripts/tools/tradebook_premium.py
git commit -m "feat(tools): tradebook_premium script — minute-by-minute open sell premium series"
```

---

### Task 2: API route `rs_dashboard/app/api/options/premium-chart/route.ts`

**Files:**
- Create: `rs_dashboard/app/api/options/premium-chart/route.ts`

**Interfaces:**
- Consumes: `scripts/tools/tradebook_premium.py` stdout JSON (see Task 1 Produces)
- Produces: `GET /api/options/premium-chart` → `{ success, data, current_premium, session_date, trades_count }` or `{ success: false, error }`

- [ ] **Step 1: Create the route file**

Create `rs_dashboard/app/api/options/premium-chart/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const PREMIUM_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'tradebook_premium.py');

interface PremiumPoint { time: string; premium: number }

interface ScriptResponse {
  success: boolean;
  data: PremiumPoint[];
  current_premium: number;
  session_date: string;
  trades_count: number;
  error?: string;
}

export async function GET() {
  const result = spawnSync(
    PYTHON_EXE,
    [PREMIUM_SCRIPT],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/premium-chart] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as ScriptResponse;

    if (!parsed.success) {
      console.error('[/api/options/premium-chart]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json({ success: false, error: parsed.error ?? 'Script error' }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[/api/options/premium-chart] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: Start the dev server and verify the endpoint**

```powershell
cd rs_dashboard; npm run dev
```

In another terminal or browser:
```
GET http://localhost:3000/api/options/premium-chart
```

Expected: JSON response with `success: true`, `data` array, `current_premium` number. HTTP 200. No 500 errors in the Next.js terminal.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/options/premium-chart/route.ts
git commit -m "feat(api): /api/options/premium-chart — proxies tradebook_premium.py output"
```

---

### Task 3: Frontend panel in `OptionsPositionsTab.tsx`

**Files:**
- Modify: `rs_dashboard/components/OptionsPositionsTab.tsx`

**Interfaces:**
- Consumes: `GET /api/options/premium-chart` → `{ success, data: PremiumPoint[], current_premium, error? }`
- Produces: New "Combined Open Premium" section rendered below the existing positions table

- [ ] **Step 1: Add `LineChart` to the recharts import**

In `rs_dashboard/components/OptionsPositionsTab.tsx`, change line 4–7:

```typescript
// Before:
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

// After:
import {
  ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
```

- [ ] **Step 2: Add the `PremiumPoint` type and `isMarketHours` helper**

Add after the existing `interface DataPoint` block (around line 45):

```typescript
interface PremiumPoint { time: string; premium: number }

function isMarketHours(): boolean {
  const now = new Date();
  const hm  = now.getHours() * 100 + now.getMinutes();
  return hm >= 915 && hm <= 1530;
}
```

- [ ] **Step 3: Add state variables inside `OptionsPositionsTab`**

Add after the existing state declarations (around line 113, after `const entryPremiumRef`):

```typescript
const [premiumData, setPremiumData]           = useState<PremiumPoint[]>([]);
const [currentPremium, setCurrentPremium]     = useState<number>(0);
const [premiumLastUpdated, setPremiumLastUpdated] = useState<string>('');
const [isPostSession, setIsPostSession]       = useState<boolean>(false);
const [premiumError, setPremiumError]         = useState<string | null>(null);
const [premiumRefreshKey, setPremiumRefreshKey] = useState(0);
```

- [ ] **Step 4: Add the premium chart polling `useEffect`**

Add after the existing live polling `useEffect` (around line 165, after the closing `}, [pollMs]);`):

```typescript
// ── Premium chart (tradebook-based) ─────────────────────────────────
useEffect(() => {
  const postSession = !isMarketHours();
  setIsPostSession(postSession);

  async function fetchPremiumChart() {
    try {
      const res  = await fetch('/api/options/premium-chart');
      const data = await res.json() as {
        success: boolean;
        data: PremiumPoint[];
        current_premium: number;
        error?: string;
      };
      if (!data.success) {
        setPremiumError(data.error ?? 'Failed to load premium chart');
        return;
      }
      setPremiumData(data.data);
      setCurrentPremium(data.current_premium);
      setPremiumLastUpdated(
        new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      );
      setPremiumError(null);
    } catch {
      setPremiumError('Network error fetching premium chart');
    }
  }

  fetchPremiumChart();
  if (!postSession) {
    const id = setInterval(fetchPremiumChart, 30_000);
    return () => clearInterval(id);
  }
}, [premiumRefreshKey]);
```

- [ ] **Step 5: Add the panel to the JSX**

In the return block, add the following section just before the final closing `</div>` (after the positions table, around line 418):

```tsx
{/* Combined Open Premium Chart */}
<div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
  <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-bold text-white">Combined Open Premium</h3>
      {isPostSession ? (
        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-zinc-700 text-zinc-400 border border-zinc-600">
          POST-SESSION
        </span>
      ) : (
        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          LIVE
        </span>
      )}
      {premiumLastUpdated && (
        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
          DATA: {premiumLastUpdated}
        </span>
      )}
    </div>
    <button
      onClick={() => setPremiumRefreshKey(k => k + 1)}
      className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
      title="Refresh premium chart"
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  </div>

  <div className="mb-4">
    <StatTile
      label="Open Sell Premium"
      value={fmtNum(currentPremium)}
      sub="pts/lot · open positions only"
      valueClass={currentPremium > 0 ? 'text-emerald-400' : 'text-zinc-400'}
    />
  </div>

  {premiumError ? (
    <div className="px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400">
      {premiumError}
    </div>
  ) : premiumData.length < 2 ? (
    <div className="flex items-center justify-center h-[280px] text-zinc-500 text-sm">
      {premiumData.length === 0 ? 'No FNO trades today' : 'Collecting data…'}
    </div>
  ) : (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={premiumData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fill: '#71717a', fontSize: 11 }}
          axisLine={{ stroke: '#3f3f46' }}
          tickLine={false}
          tickFormatter={(v: string, i: number) => i % 30 === 0 ? v : ''}
        />
        <YAxis
          tick={{ fill: '#71717a', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={55}
          tickFormatter={(v: number) => v.toFixed(0)}
        />
        <Tooltip content={<ChartTooltip />} />
        <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
        <Line
          type="stepAfter"
          dataKey="premium"
          name="Open Premium"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )}
</div>
```

- [ ] **Step 6: Verify in the browser**

With the dev server running (`cd rs_dashboard && npm run dev`):

1. Open `http://localhost:3000/options` → click the **Positions** tab
2. Scroll to the bottom — the "Combined Open Premium" panel should render
3. If market is open: badge shows **LIVE**, chart polls every 30s, `DATA: HH:MM` chip updates
4. If market is closed: badge shows **POST-SESSION**, no further polling
5. No FNO trades today: chart area shows "No FNO trades today" (not an error, not a crash)
6. Click the refresh icon — chart refetches immediately
7. Check browser console for zero TypeScript or network errors

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/components/OptionsPositionsTab.tsx
git commit -m "feat(options): combined open premium chart panel in Positions tab"
```
