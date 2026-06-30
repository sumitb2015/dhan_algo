# Live Normalized Intraday Charts — Design Spec

**Date:** 2026-06-30  
**Feature:** Add a "Normalized Charts" sub-tab to the `/live` page that plots live intraday % returns from session open for all NSE indices, streamed via WebSocket.

---

## Overview

The existing `/live` page shows a Nifty50 equity tick table. This feature adds a second tab — **Normalized** — that plots every-tick intraday normalized % return lines for Nifty, BankNifty, and all other available NSE indices (20+ total). NIFTY and BANKNIFTY are always visible; others are user-toggleable.

---

## Architecture

### Pattern

Follows the established bridge pattern in this codebase:
- Python script runs as a detached background process, subscribes via Dhan WebSocket, writes JSON files to `debug/` every 2 seconds.
- Next.js API route manages start/stop and reads the JSON files.
- React component polls the API route every 3 seconds.

### Components

1. **`scripts/tools/live_indices_ws.py`** — new Python bridge for indices
2. **`rs_dashboard/app/api/live-indices/route.ts`** — new API route
3. **`rs_dashboard/components/LiveDashboard.tsx`** — add tab switcher (Market | Normalized)
4. **`rs_dashboard/components/LiveNormalizedTab.tsx`** — new chart component

---

## Python Bridge — `scripts/tools/live_indices_ws.py`

### Index catalogue

Attempts to resolve all of the following via `helper.find_index(symbol)`. Any symbol not found in the master list is silently skipped (logged as WARNING).

| Symbol | Label | Category |
|--------|-------|----------|
| NIFTY | Nifty 50 | Broad Market |
| NIFTY100 | Nifty 100 | Broad Market |
| NIFTY200 | Nifty 200 | Broad Market |
| NIFTY500 | Nifty 500 | Broad Market |
| NIFTYNXT50 | Nifty Next 50 | Broad Market |
| MIDCAP100 | Nifty Midcap 100 | Broad Market |
| SMALLCAP100 | Nifty Smallcap 100 | Broad Market |
| BANKNIFTY | Nifty Bank | Sectoral |
| FINNIFTY | Nifty Fin Services | Sectoral |
| NIFTYIT | Nifty IT | Sectoral |
| NIFTYAUTO | Nifty Auto | Sectoral |
| NIFTYPHARMA | Nifty Pharma | Sectoral |
| NIFTYFMCG | Nifty FMCG | Sectoral |
| NIFTYMETAL | Nifty Metal | Sectoral |
| NIFTYREALTY | Nifty Realty | Sectoral |
| NIFTYPSUBANK | Nifty PSU Bank | Sectoral |
| NIFTYPVTBANK | Nifty Private Bank | Sectoral |
| NIFTYENERGY | Nifty Energy | Sectoral |
| NIFTYINFRA | Nifty Infra | Sectoral |
| NIFTYMEDIA | Nifty Media | Sectoral |
| NIFTYHEALTHCARE | Nifty Healthcare | Sectoral |
| NIFTYOILGAS | Nifty Oil and Gas | Sectoral |
| INDIAVIX | India VIX | Volatility |

Security IDs are resolved at startup via `find_index()`. Known hard-coded fallbacks: NIFTY→13, BANKNIFTY→25, FINNIFTY→27, INDIAVIX→21 (used if `find_index` fails for these critical ones).

### WebSocket subscription

Uses segment code `0` (IDX / Index segment) and feed type `17` (FEED_QUOTE: LTP + OHLC + volume) for all index instruments. Calls `helper.start_websocket(instruments)` with a list of `(0, security_id, 17)` tuples.

### Session open capture

`opens` dict is populated on the **first received tick** per symbol after the WebSocket connects. This is the intraday baseline for % normalization. On reconnects within the same calendar day (`session_date` matches), `opens` is preserved from the existing history file so the baseline stays stable.

### Output files

All written atomically (write to `.tmp` then `os.replace`).

**`debug/live_indices_history.json`** — full session time-series (overwritten every 2 s):
```json
{
  "session_date": "2026-06-30",
  "updated_at": "2026-06-30T10:32:05.123456",
  "available": ["NIFTY", "BANKNIFTY", "FINNIFTY", ...],
  "labels": { "NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", ... },
  "opens":  { "NIFTY": 24000.0, "BANKNIFTY": 52000.0, ... },
  "ltps":   { "NIFTY": 24120.0, "BANKNIFTY": 52180.0, ... },
  "ticks":  [
    { "t": "09:15:02", "NIFTY": 24000.0, "BANKNIFTY": 52000.0, "FINNIFTY": 23500.0 },
    { "t": "09:15:04", "NIFTY": 24006.5, "BANKNIFTY": 52015.0, "FINNIFTY": 23502.0 },
    ...
  ]
}
```

Each `ticks` entry is a single 2-second snapshot: timestamp + one LTP value per subscribed index. If a symbol had no tick in a given snapshot window, its last known LTP is forward-filled. Ticks accumulate all day (≈11,250 entries by 15:30 IST; at ~25 symbols × 8 bytes each + 10-byte timestamp ≈ ~220 bytes/entry → ~2.5 MB total by end of day — acceptable).

**`debug/live_indices_status.json`**:
```json
{ "status": "RUNNING", "pid": 12345, "subscribed": 12, "started_at": "...", "last_update": "..." }
```

**`debug/live_indices_stop.trigger`** — written by API route to stop the bridge gracefully.

### CLI

```
venv\Scripts\python.exe scripts/tools/live_indices_ws.py
```

No required arguments. Optional: `--interval 2` (write interval in seconds, default 2).

---

## API Route — `rs_dashboard/app/api/live-indices/route.ts`

Follows the same structure as `app/api/live-equity/route.ts`.

**GET** — returns:
```json
{
  "success": true,
  "status": { "status": "RUNNING", "pid": 12345, "subscribed": 12, ... },
  "history": { ...full live_indices_history.json content... }
}
```
Cross-checks PID with `tasklist` (Windows) to detect crashed bridges and marks status as `STOPPED` if PID is gone.

**POST `{ action: "start" }`** — spawns `live_indices_ws.py` detached via `pythonw.exe`, removes stale stop trigger, returns PID.

**POST `{ action: "stop" }`** — writes `debug/live_indices_stop.trigger`.

---

## UI — `LiveDashboard.tsx` changes

Add a tab bar to the sticky header between the title and NavBar. Two tabs:

- **Market** — existing stock table (default)
- **Normalized** — new chart tab

Tab state: `useState<'market' | 'normalized'>('market')`. The bridge start/stop button and live dot in the header remain relevant to whichever tab is active (each tab controls its own bridge independently). When on the Normalized tab, the header shows the indices bridge status dot and its own start/stop button.

---

## Component — `rs_dashboard/components/LiveNormalizedTab.tsx`

### Data fetching

- Polls `/api/live-indices` every 3 seconds via `setInterval`.
- Maintains full history in React state (replaces on each poll — the server sends the growing array).
- Tracks `bridgeStatus` and `lastTick` independently from the equity bridge.

### Bridge controls

Same Start/Stop button + live dot as the equity tab, wired to the indices bridge.

### Index selector

A compact chip grid above the chart, grouped by category label:

- **Broad Market** | **Sectoral** | **Volatility** — label rows, chips below each.
- NIFTY and BANKNIFTY chips are always highlighted and have no click handler (visually distinct: solid border, no hover state).
- All other chips toggle on/off. Default: all `available` indices selected on first mount.
- Selection persisted in `localStorage` key `live_normalized_selected_indices`.
- Only indices present in `history.available` are shown (i.e., only those the bridge successfully subscribed to).

### Chart

```
<ResponsiveContainer width="100%" height={420}>
  <LineChart data={ticks}>
    <XAxis dataKey="t" tick={{ fontSize: 10 }} tickLine={false} />
    <YAxis tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`} tick={{ fontSize: 10 }} />
    <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="4 2" />
    <Tooltip content={<CustomTooltip opens={opens} />} />
    {activeIndices.map((sym) => (
      <Line key={sym} dataKey={sym} stroke={COLOR_MAP[sym]} dot={false}
            strokeWidth={1.5} isAnimationActive={false}
            connectNulls={true} />
    ))}
  </LineChart>
</ResponsiveContainer>
```

The `data` prop passed to `LineChart` is the raw `ticks` array from the history JSON (each tick already has `{ t, NIFTY, BANKNIFTY, ... }` with raw LTP values). The `dataKey` for each Line is the symbol name. **% normalization is applied as a transform before passing to Recharts**: a `useMemo` converts the ticks array by replacing each LTP with `(ltp - opens[sym]) / opens[sym] * 100`, producing a parallel array of the same shape but with % values.

X-axis: raw `"HH:MM:SS"` strings from `ticks[].t`, displayed as `"HH:MM"` via `tickFormatter`. Ticks auto-spaced (Recharts default interval).

Y-axis: `% from open`, formatted as `+0.42%` / `-0.38%`.

### Color palette

20 distinct colors, assigned to symbols in a fixed order so colors are stable across sessions:

```ts
const PALETTE = [
  '#10b981', // emerald-500  — NIFTY (always first)
  '#8b5cf6', // violet-500   — BANKNIFTY (always second)
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
];
```

NIFTY is always index 0 (emerald), BANKNIFTY always index 1 (violet). Other symbols are assigned in the order they appear in `history.available`.

### Custom tooltip

On hover, shows a dark card listing all **active** indices sorted by current `%` descending:
```
09:32:14
Nifty 50        +0.42%   24101.50
Nifty Bank      +0.38%   52197.00
...
```

### Offline / loading states

- Bridge offline: same "WebSocket feed is offline" banner as the equity tab, with a Start button.
- Bridge starting: same amber "Connecting…" banner.
- No ticks yet: spinner with "Waiting for first tick…".
- History empty (pre-market): show chart shell with "Market opens at 09:15 IST".

### DATA chip

Header shows `DATA: LIVE` when bridge is running (green), `DATA: OFFLINE` when stopped (zinc-500), consistent with the rest of the dashboard.

---

## File summary

| File | Action |
|------|--------|
| `scripts/tools/live_indices_ws.py` | **New** — Python indices WebSocket bridge |
| `rs_dashboard/app/api/live-indices/route.ts` | **New** — API route (GET/POST) |
| `rs_dashboard/components/LiveNormalizedTab.tsx` | **New** — chart component |
| `rs_dashboard/components/LiveDashboard.tsx` | **Edit** — add tab switcher + conditional render |

---

## Out of scope

- Saving intraday history to disk between sessions (fresh start each day is correct — opens baseline resets at midnight).
- Candlestick view (tick line chart only, as requested).
- Comparison with previous-day close (normalized to today's open only).
- Per-index sparklines in the selector chips (future enhancement).
