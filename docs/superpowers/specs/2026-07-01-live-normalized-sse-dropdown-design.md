# Live Normalized Chart — SSE + Index Dropdown Design

**Date:** 2026-07-01  
**Scope:** `rs_dashboard/` — `/live` page, Normalized tab only  
**Goal:** Replace HTTP polling with SSE for real-time chart updates; replace chip grid with a compact dropdown for index selection.

---

## Context

The `/live` page has two tabs — Market (Nifty 50 equity quotes) and Normalized (index % change from open). The Normalized tab is backed by `live_indices_ws.py`, a Python bridge that:

- Resolves security IDs for 26 NSE indices via `DhanHelper.find_index()`
- Subscribes to Dhan WebSocket (segment `IDX=0`, feed type `QUOTE=17`)
- Writes `debug/live_indices_history.json` every 2 seconds

The frontend (`LiveNormalizedTab.tsx`) currently polls `/api/live-indices` every 3 seconds via `setInterval`. The index selector is a full-width chip grid grouped by category.

---

## Changes

### 1. New SSE route — `/api/live-indices/stream/route.ts`

- GET handler opens a `ReadableStream`
- Polls `debug/live_indices_history.json` + `debug/live_indices_status.json` every 1 second
- Compares `updated_at` timestamp; sends a `data: <json>\n\n` event only when data changed
- Sends one event immediately on connect (no blank wait)
- Exits loop when `request.signal.aborted` (browser disconnected)
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Payload shape: `{ success: true, status: BridgeStatus, history: IndexHistory | null }` — identical to current GET response

The existing `/api/live-indices/route.ts` (GET status check + POST start/stop) is **unchanged**.

### 2. Frontend — replace polling with SSE (`LiveNormalizedTab.tsx`)

**Remove:**
- `pollRef`, `pollLive` callback, `setInterval(pollLive, 3000)` effect

**Add:**
- `useEffect` that opens `new EventSource('/api/live-indices/stream')` on mount
- `onmessage`: parse JSON → same state setters (`setBridgeStatus`, `setHistory`, `setLastTick`)
- On unmount: `eventSource.close()`
- Browser `EventSource` handles reconnection natively — no retry logic needed

`sendAction` (POST start/stop) is unchanged.

### 3. Index selector — compact dropdown (`LiveNormalizedTab.tsx`)

**Remove:** the full-width chip-grid `<div>` (currently renders when `isMarketOpen && history && history.available.length > 0`)

**Add:** `IndexDropdown` component (inline, ~60 lines):

- **Trigger button:** `"Indices (N / M) ▾"` sitting in the controls strip
- **Floating panel:** `position: absolute`, `z-50`, drops below the button
  - Categories as bold section headers (Broad Market, Sectoral, Volatility)
  - Each index: `<input type="checkbox">` + short label, wrapping flex grid
  - NIFTY & BANKNIFTY: always checked, `disabled`
  - "Select All" / "Clear All" links at panel top
  - Closes on outside click (`useRef` + `document.mousedown` listener)
- localStorage persistence: unchanged (same `STORAGE_KEY`, same `PINNED` set)

---

## Data Flow

```
Dhan WebSocket
     ↓
live_indices_ws.py  (writes JSON every 2 s)
     ↓
debug/live_indices_history.json
     ↓
/api/live-indices/stream  (polls file every 1 s, pushes SSE on change)
     ↓
EventSource in LiveNormalizedTab  (~1 s push latency)
     ↓
Recharts LineChart  (normalized % from session open)
```

---

## Files Changed

| File | Action |
|------|--------|
| `rs_dashboard/app/api/live-indices/stream/route.ts` | **New** — SSE streaming route |
| `rs_dashboard/components/LiveNormalizedTab.tsx` | **Edit** — SSE client + dropdown |
| `rs_dashboard/app/api/live-indices/route.ts` | **No change** |
| `scripts/tools/live_indices_ws.py` | **No change** |

---

## Out of Scope

- Changes to the Market tab
- Changes to `live_equity_ws.py` or `/api/live-equity`
- Custom WebSocket server setup
- Any changes to Python bridge logic
