# Live Normalized Chart — SSE + Index Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace HTTP polling with Server-Sent Events for the Normalized tab and replace the chip-grid index selector with a compact dropdown with checkboxes.

**Architecture:** A new SSE route (`/api/live-indices/stream`) polls the JSON files the Python bridge writes every 2 s, and pushes an event to the browser whenever `updated_at` changes. The `LiveNormalizedTab` component replaces `setInterval` with `EventSource` and replaces the chip-grid section with an `IndexDropdown` inline component.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Recharts (unchanged), Lucide React.

## Global Constraints

- All files are under `rs_dashboard/` — run `npm run dev` from that directory to test.
- No new npm dependencies.
- Do not touch `LiveDashboard.tsx`, `live_equity_ws.py`, `/api/live-equity`, or the Python bridge `live_indices_ws.py`.
- The existing `/api/live-indices` route (GET status + POST start/stop) must remain unchanged.
- Payload shape from SSE must be `{ success: true, status: BridgeStatus, history: IndexHistory | null }` — identical to the current GET response shape that `LiveNormalizedTab` already handles.
- NIFTY and BANKNIFTY must always be checked and non-toggleable in the dropdown.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `rs_dashboard/app/api/live-indices/stream/route.ts` | **Create** | SSE endpoint — watches JSON files, pushes events |
| `rs_dashboard/components/LiveNormalizedTab.tsx` | **Modify** | Replace polling with EventSource; replace chip grid with IndexDropdown |

---

## Task 1: SSE stream route

**Files:**
- Create: `rs_dashboard/app/api/live-indices/stream/route.ts`

**Interfaces:**
- Produces: `GET /api/live-indices/stream` — `text/event-stream` response; each event is `data: <JSON>\n\n` where JSON is `{ success: true, status: BridgeStatus, history: IndexHistory | null }`

---

- [ ] **Step 1: Create the SSE route file**

Create `rs_dashboard/app/api/live-indices/stream/route.ts` with this exact content:

```typescript
import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const HISTORY_FILE = path.join(DEBUG_DIR, 'live_indices_history.json');
const STATUS_FILE  = path.join(DEBUG_DIR, 'live_indices_status.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      let lastUpdatedAt = '';

      const tick = () => {
        const history = readJson(HISTORY_FILE);
        const status  = readJson(STATUS_FILE) ?? { status: 'STOPPED', subscribed: 0 };
        const updatedAt = (history?.updated_at as string) ?? '';

        // Send immediately on first call (lastUpdatedAt === ''), then only on change
        if (updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = updatedAt;
          const payload = { success: true, status, history: history ?? null };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch { /* stream closed */ }
        }
      };

      tick(); // immediate event on connect
      interval = setInterval(tick, 1000);
    },
    cancel() {
      clearInterval(interval);
    },
  });

  request.signal.addEventListener('abort', () => clearInterval(interval));

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
```

- [ ] **Step 2: Verify the route is reachable**

With the Next.js dev server running (`npm run dev` inside `rs_dashboard/`), open a terminal and run:

```powershell
curl -N http://localhost:3000/api/live-indices/stream
```

Expected: the terminal stays open and prints one line of the form `data: {"success":true,"status":{...},"history":...}` immediately, then another line each time the bridge writes a new tick (or nothing if the bridge is not running — the first event fires regardless because `lastUpdatedAt` starts as `''`).

Press `Ctrl+C` to close. The dev server should not crash.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/live-indices/stream/route.ts
git commit -m "feat(live): add SSE stream route for live indices"
```

---

## Task 2: Replace polling with EventSource + add IndexDropdown

**Files:**
- Modify: `rs_dashboard/components/LiveNormalizedTab.tsx`

**Interfaces:**
- Consumes: `GET /api/live-indices/stream` from Task 1
- Consumes: `POST /api/live-indices` unchanged (start/stop)

---

- [ ] **Step 1: Replace the polling mechanism with EventSource**

Open `rs_dashboard/components/LiveNormalizedTab.tsx`.

**Remove** the `pollRef` ref declaration (line ~196):
```typescript
const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

**Remove** the `pollLive` callback (lines ~228–239):
```typescript
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
```

**Remove** the polling `useEffect` (lines ~241–244):
```typescript
useEffect(() => {
  pollLive();
  pollRef.current = setInterval(pollLive, 3000);
  return () => { if (pollRef.current) clearInterval(pollRef.current); };
}, [pollLive]);
```

**Add** this `useEffect` in their place (after the `initializedRef` declaration):
```typescript
// SSE connection — replaces polling
useEffect(() => {
  const es = new EventSource('/api/live-indices/stream');
  es.onmessage = (e) => {
    try {
      const json = JSON.parse(e.data as string);
      if (!json.success) return;
      setBridgeStatus(json.status);
      if (json.history) {
        setHistory(json.history);
        if (json.history.ticks?.length > 0) setLastTick(new Date());
      }
    } catch { /* ignore */ }
  };
  return () => es.close();
}, []);
```

Also update the `sendAction` callback — it still calls `POST /api/live-indices` which is correct, but it previously called `setTimeout(pollLive, 1000)` to refresh after start/stop. Replace that line with nothing (the SSE stream will pick up the status change automatically within 1 s):

Find in `sendAction`:
```typescript
    try {
      await fetch('/api/live-indices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setTimeout(pollLive, 1000);
    } catch { /* ignore */ }
```

Replace with:
```typescript
    try {
      await fetch('/api/live-indices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch { /* ignore */ }
```

Also remove `pollLive` from the `sendAction` dependency array — it should now be:
```typescript
  }, []);
```

- [ ] **Step 2: Add `selectAll` and `clearAll` handlers**

After the `toggleIndex` callback, add:

```typescript
const selectAll = useCallback(() => {
  if (!history) return;
  const next = new Set(history.available);
  setSelected(next);
  try {
    const toStore = [...next].filter((s) => !PINNED.has(s));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* ignore */ }
}, [history]);

const clearAll = useCallback(() => {
  const next = new Set(PINNED);
  setSelected(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  } catch { /* ignore */ }
}, []);
```

- [ ] **Step 3: Add the `IndexDropdown` component**

Add this component above the `export default function LiveNormalizedTab()` declaration (after `IndexChip` and before `LiveNormalizedTab`). Delete the existing `IndexChip` component — it is no longer used.

```typescript
function IndexDropdown({
  available,
  labels,
  categories,
  selected,
  onToggle,
  onSelectAll,
  onClearAll,
}: {
  available: string[];
  labels: Record<string, string>;
  categories: Record<string, string>;
  selected: Set<string>;
  onToggle: (sym: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const byCategory: Record<string, string[]> = {};
  for (const sym of available) {
    const cat = categories[sym] ?? 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(sym);
  }

  const selectedCount = available.filter((s) => selected.has(s)).length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 transition-all"
      >
        Indices ({selectedCount} / {available.length})
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-3 flex flex-col gap-2.5 max-h-[70vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
            <span className="text-[10px] text-zinc-500 font-medium">
              {selectedCount} of {available.length} selected
            </span>
            <div className="flex gap-3">
              <button
                onClick={onSelectAll}
                className="text-[10px] text-violet-400 hover:text-violet-300 font-semibold"
              >
                All
              </button>
              <button
                onClick={onClearAll}
                className="text-[10px] text-zinc-500 hover:text-zinc-400"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Categories */}
          {Object.entries(byCategory).map(([cat, syms]) => (
            <div key={cat}>
              <div className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-1.5">
                {cat}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {syms.map((sym) => {
                  const pinned = PINNED.has(sym);
                  const checked = selected.has(sym);
                  return (
                    <label
                      key={sym}
                      className={cn(
                        'flex items-center gap-1.5 text-[11px] select-none',
                        pinned
                          ? 'text-zinc-500 cursor-default'
                          : checked
                          ? 'text-zinc-200 cursor-pointer'
                          : 'text-zinc-500 cursor-pointer hover:text-zinc-300',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={pinned}
                        onChange={() => !pinned && onToggle(sym)}
                        className="accent-violet-500 w-3 h-3 shrink-0"
                      />
                      {labels[sym] ?? sym}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add `ChevronDown` to the lucide-react import**

Find at the top of `LiveNormalizedTab.tsx`:
```typescript
import { Activity, Play, Square, RefreshCw, WifiOff } from 'lucide-react';
```

Replace with:
```typescript
import { Activity, Play, Square, RefreshCw, WifiOff, ChevronDown } from 'lucide-react';
```

- [ ] **Step 5: Wire the dropdown into the controls strip and remove the chip grid**

In the JSX, inside the controls strip `<div>` (the one with class `flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950`), after the start/stop button, add the dropdown:

```tsx
{history && history.available.length > 0 && (
  <IndexDropdown
    available={history.available}
    labels={history.labels}
    categories={history.categories}
    selected={selected}
    onToggle={toggleIndex}
    onSelectAll={selectAll}
    onClearAll={clearAll}
  />
)}
```

Then **remove** the entire chip-grid section that currently reads:

```tsx
{/* ── Index selector grid (market hours only) ── */}
{isMarketOpen && history && history.available.length > 0 && (
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
```

Also remove the `byCategory` `useMemo` block that computed the chip grid grouping — it is now computed inside `IndexDropdown` directly.

- [ ] **Step 6: Verify in the browser**

1. `npm run dev` in `rs_dashboard/`
2. Navigate to `http://localhost:3000/live` → Normalized tab
3. Open DevTools → Network tab, filter by `stream`
4. Confirm a persistent `live-indices/stream` SSE connection is open (type `eventsource`)
5. Start the indices feed — confirm the chart hydrates within ~1 s of the first tick
6. Click the `"Indices (N / M) ▾"` button — confirm the floating panel opens with grouped checkboxes
7. Toggle a non-pinned index — confirm it disappears from / reappears on the chart immediately
8. Click outside the panel — confirm it closes
9. Click "Clear" — confirm only NIFTY and BANKNIFTY remain selected (pinned)
10. Click "All" — confirm all indices are re-selected
11. Reload the page — confirm the selection is restored from localStorage

- [ ] **Step 7: Commit**

```bash
git add rs_dashboard/components/LiveNormalizedTab.tsx
git commit -m "feat(live): replace polling with SSE and add index dropdown selector"
```
