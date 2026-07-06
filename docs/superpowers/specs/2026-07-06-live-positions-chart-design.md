# Live Positions Chart — Design Spec

**Date:** 2026-07-06
**Feature:** Options page — new "Positions" tab with live combined-premium chart and VIX overlay

---

## Context

Traders running intraday F&O strategies (straddles, spreads) need to see the combined market value of their open position legs evolve over the session — at a glance, without switching to a broker terminal. A time-series of net combined premium (sell legs LTP sum minus buy legs LTP sum) paired with VIX on a secondary axis gives both P&L direction and market-fear context in one view.

---

## Scope

Two new files + one modified file:

| File | Change |
|---|---|
| `rs_dashboard/app/api/options/positions-live/route.ts` | New API route |
| `rs_dashboard/components/OptionsPositionsTab.tsx` | New tab component |
| `rs_dashboard/components/OptionsCharts.tsx` | Wire in new tab |

---

## API Route — `/api/options/positions-live`

**Method:** GET only  
**Cache TTL:** 2 s in-module (prevents burst calls; frontend polls every 3 s)

### Logic

1. Read `access_token.json` (same `getToken()` pattern as `/api/scalper/vix/route.ts`)
2. `GET https://api.dhan.co/v2/positions` with auth headers → full positions array
3. Filter to F&O option legs: trading symbols containing `-CE-` or `-PE-`
4. Collect security IDs of those legs
5. `POST https://api.dhan.co/v2/marketfeed/ohlc` with those security IDs **plus VIX (ID 21, NSE_IDX)** in one call → fresh LTPs
6. Compute net premium:
   ```
   net_premium = Σ(ltp for legs where netQty < 0)   ← net-short / sell
               − Σ(ltp for legs where netQty > 0)   ← net-long / buy
   ```
   One LTP value per leg, unweighted by lot count ("sum of LTPs").
7. Return JSON response

### Response Shape

```ts
{
  net_premium: number,       // combined LTP: sell legs − buy legs
  vix: number,               // India VIX spot
  legs: {
    symbol: string,          // e.g. "NIFTY-CE-24500-25JUL25"
    strike: number,
    type: 'CE' | 'PE',
    side: 'SELL' | 'BUY',    // derived from sign of netQty
    ltp: number,
    netQty: number,
  }[],
  timestamp: string,         // ISO timestamp of this snapshot
  has_positions: boolean,    // false when no F&O option legs open
}
```

### Error Handling

- No token → 200 with `{ has_positions: false, error: 'auth' }`
- Dhan API failure → 200 with `{ has_positions: false, error: 'api' }` (frontend shows a message, does not crash)
- Empty positions → `{ has_positions: false, legs: [], net_premium: 0, vix: <vix or 0> }`

---

## Frontend Component — `OptionsPositionsTab`

Self-contained `'use client'` component. No props — fetches all data internally.

### State

```ts
dataPoints: { time: string; netPremium: number; vix: number }[]  // in-memory, clears on mount
legs: Leg[]          // current snapshot of open legs
entryPremium: number // first data point's netPremium (set once, used for ReferenceLine)
loading: boolean
error: string | null
```

### Polling

- `setInterval` every 3 s, starts on mount, cleared on unmount
- Each tick: fetch `/api/options/positions-live`, push new `{ time, netPremium, vix }` onto `dataPoints`
- `entryPremium` is locked to the first non-zero `netPremium` received

### Layout

```
┌─ Stat row (4 tiles) ─────────────────────────────────────────────┐
│  Net Premium  │  Change from Entry  │  VIX  │  Open Legs         │
└──────────────────────────────────────────────────────────────────┘
┌─ Dual-axis line chart (height 420) ──────────────────────────────┐
│  Left Y:  netPremium  (emerald #10b981 solid line)               │
│  Right Y: vix         (amber #f59e0b dashed line)                │
│  X:       time (HH:MM:SS)                                        │
│  ReferenceLine at entryPremium (dashed white, label "Entry")     │
└──────────────────────────────────────────────────────────────────┘
┌─ Positions table ────────────────────────────────────────────────┐
│  Strike │ Type │ Side │ LTP                                      │
└──────────────────────────────────────────────────────────────────┘
```

**Chart type:** `ComposedChart` from Recharts (already used in the dashboard)  
**Dual Y axes:** `<YAxis yAxisId="premium">` (left) and `<YAxis yAxisId="vix" orientation="right">` (right)  
**Empty state:** "No open F&O option positions" message when `has_positions` is false  
**Loading state:** spinner on first load before any data arrives

### Stat tile colors

- Net Premium: emerald if positive (net credit), red if negative (net debit)
- Change from Entry: green if improving (decreasing for sells), red if worsening
- VIX: amber/orange
- Open Legs: zinc (neutral)

---

## OptionsCharts Integration

### Changes to `OptionsCharts.tsx`

1. **Import:** `import OptionsPositionsTab from './OptionsPositionsTab'`
2. **Tab union type:** add `'positions'` to the `activeTab` type
3. **Tab button:** add "Positions" tab button in the tab bar (after `pcdiff`)
4. **Render:** `{activeTab === 'positions' && <OptionsPositionsTab />}`
5. **Hide existing controls:** the expiry selector, poll-interval toggle, and bridge status badge are already conditionally shown based on `activeTab` — add `'positions'` to the exclusion list (same pattern as `'vix'` tab)

---

## Verification

1. Open `/options` page, click the new **Positions** tab
2. With no open F&O positions: confirm "No open F&O option positions" empty state renders
3. With open positions (or market hours): confirm stat tiles populate and the chart begins building a time series
4. Confirm VIX line appears on the right axis and scales independently of the premium axis
5. Confirm the Entry reference line appears after the first data point
6. Confirm the positions table shows the correct strike, type, side, and LTP for each leg
7. Switch to another tab and back — confirm the in-memory series resets (empty state again, fresh series)
