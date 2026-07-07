# Combined Open Premium Chart — Design Spec

**Date:** 2026-07-06  
**Location:** Panel inside OptionsPositionsTab (Options page → Positions tab)

---

## Context

Traders running intraday F&O sell strategies (straddles, strangles, spreads) need visibility into how much open sell premium they are holding at any given minute during the session. The existing Positions tab shows current live metrics polled from DhanHQ, but gives no historical view of how the combined premium has evolved during the day. This feature adds a minute-by-minute chart reconstructed from the tradebook, showing combined open sell premium from session start to now.

---

## Feature Summary

A new "Combined Open Premium" panel is added as a section inside `OptionsPositionsTab.tsx`, below the existing stat tiles and live premium chart. It shows a line chart of combined open sell premium over the trading session (09:15–15:30), derived from the day's tradebook. Live polling during market hours; single fetch (post-session summary) outside market hours.

---

## Premium Calculation Rules

- **Unit**: per-lot premium (NOT multiplied by lot size). Formula: `lots × tradedPrice` where `lots = tradedQuantity / lot_size`.
- **Open position tracking (FIFO per symbol)**:
  - SELL trade → push `{lots, sell_price}` onto the symbol's queue
  - BUY trade (exit) → pop from front of symbol's queue; partial exits split the front entry
  - When a symbol's queue is fully drained, its contribution = 0
- **Combined premium at any moment** = `Σ(lots × sell_price)` over all entries in all open queues
- **Minute interpolation**: premium stays constant between trade events; the series has one data point per minute from 09:15 to current minute

---

## Architecture

### 1. Python Script — `scripts/tools/tradebook_premium.py`

Responsibilities:
1. Instantiate `DhanHelper` via `get_dhan_client()`, call `helper.get_trade_book()`
2. Filter to `exchangeSegment == "NSE_FNO"` trades only
3. For each unique `tradingSymbol`, resolve lot size from master list (already in-memory after `DhanHelper` init). Extract underlying by stripping the expiry+strike+type suffix from the option symbol, then use `helper.get_lot_size(underlying)`.
4. Sort all FNO trades by `exchangeTime` (fallback: `createTime`)
5. Walk trades chronologically, maintaining `open_positions: dict[symbol, deque[{lots, sell_price}]]`
6. After each trade, record `(minute_str, combined_premium)` event
7. Expand events into a per-minute series from `09:15` to current minute (or `15:30` post-session), holding last value flat
8. Print JSON to stdout:

```json
{
  "success": true,
  "data": [{"time": "09:15", "premium": 0.0}, {"time": "09:23", "premium": 200.0}, ...],
  "current_premium": 180.0,
  "session_date": "2026-07-06",
  "trades_count": 8
}
```

No existing script covers this logic — this is a new file.

### 2. API Route — `rs_dashboard/app/api/options/premium-chart/route.ts`

- GET handler only
- `execFile("venv/Scripts/python.exe", ["scripts/tools/tradebook_premium.py"])` from `PROJECT_ROOT`
- Parse last non-empty line of stdout as JSON
- Pass response through directly — same pattern as `/api/options/candles/route.ts`
- No server-side cache needed (Python script is fast; client controls poll frequency)

### 3. Frontend — addition to `OptionsPositionsTab.tsx`

New section rendered below the existing chart:

**Header row**: "Combined Open Premium" label + `DATA: HH:MM` chip + refresh icon button

**Stat tile**: current `current_premium` value (emerald if > 0, zinc if 0)

**Chart** (`<ResponsiveContainer width="100%" height={280}>`):
- `<LineChart data={data}>`
- X-axis: `dataKey="time"`, tick every 30 min (show label when `index % 30 === 0`)
- Y-axis: auto-domain, label "Premium (pts/lot)"
- Single `<Line dataKey="premium" stroke="#10b981" dot={false} strokeWidth={2} />`
- `<ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />`
- Custom tooltip: time + premium rounded to 2 decimal places

**Polling**:
- Market hours (09:15–15:30 IST): `setInterval` every 30s, replaces full data array (not append)
- Outside market hours: fetch once on mount, no interval; show "Post-session" grey badge next to header

**State**:
```ts
const [premiumData, setPremiumData] = useState<{time: string; premium: number}[]>([])
const [currentPremium, setCurrentPremium] = useState<number>(0)
const [lastUpdated, setLastUpdated] = useState<string>('')
const [isPostSession, setIsPostSession] = useState<boolean>(false)
```

---

## Lot Size Resolution

The option symbol in the tradebook (`tradingSymbol`) follows Dhan's format, e.g. `NIFTY2470725000CE`. Extract the underlying by matching the known index/stock names from the master list, or by stripping the expiry date pattern (6-digit YYMMDD) and everything after it. Use `helper.get_lot_size(underlying)` which already queries the master list. Fallback: if lot size cannot be resolved, treat as 1 (log a warning).

---

## Edge Cases

| Scenario | Handling |
|---|---|
| No FNO trades today | Return `data: []`, `current_premium: 0` |
| Partial BUY exit | Split front FIFO entry: reduce its lots by the exit quantity |
| Re-entry after full exit | New SELL pushes a fresh entry; correctly adds back to premium |
| Multiple legs same symbol | FIFO queue handles each lot independently |
| Tradebook unavailable / error | Return `{success: false, error: "..."}`, frontend shows error state |

---

## Files to Create/Modify

| File | Action |
|---|---|
| `scripts/tools/tradebook_premium.py` | **Create** — new Python script |
| `rs_dashboard/app/api/options/premium-chart/route.ts` | **Create** — new API route |
| `rs_dashboard/components/OptionsPositionsTab.tsx` | **Modify** — add premium chart panel section |

---

## Verification

1. Run `venv\Scripts\python.exe scripts/tools/tradebook_premium.py` directly and confirm valid JSON output with `success: true` and a populated `data` array
2. Hit `GET http://localhost:3000/api/options/premium-chart` in a browser/curl and confirm the response
3. Open the dashboard → Options → Positions tab → scroll to "Combined Open Premium" panel
4. Confirm chart renders with correct x-axis times and y-axis premium values
5. After market hours: confirm no polling occurs and a "Post-session" badge appears
6. Edge case: if no FNO trades today, confirm chart shows empty state (no JS error)
