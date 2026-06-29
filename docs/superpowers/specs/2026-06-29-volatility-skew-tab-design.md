# Volatility Skew Tab — Design Spec

**Date:** 2026-06-29  
**Status:** Approved

---

## Overview

Add a **Skew** tab to the existing `/options` page that displays the Nifty options implied volatility smile and put-call IV differential. Polls every 10 seconds using the existing `/api/options/chain` endpoint.

---

## Requirements

- IV smile chart: CE IV and PE IV lines vs strike, ±10 strikes around ATM (21 strikes)
- IV differential chart: `CE_IV − PE_IV` bar chart, same strike range
- Raw data table: Strike, CE IV, PE IV, Diff, CE LTP, PE LTP — ATM row highlighted
- Auto-selects nearest expiry (no expiry dropdown on this tab)
- Polls every 10 seconds; shows last-updated timestamp and LIVE badge
- Standalone component file: `rs_dashboard/components/OptionsSkewTab.tsx`

---

## Architecture

### Data Source

Reuse the existing `/api/options/chain?underlying=NIFTY&expiry=<nearest>` endpoint. No new API route or Python script changes required.

**Cache TTL change:** Reduce the server-side cache in `rs_dashboard/app/api/options/chain/route.ts` from 30s → 10s to match the polling cadence.

### IV Field

The Dhan option chain `oc` dict contains per-strike objects:
```json
"24000": {
  "ce": { "last_price": 145.5, "implied_volatility": 12.4, "oi": 80000 },
  "pe": { "last_price": 138.2, "implied_volatility": 13.1, "oi": 90000 }
}
```
Extract `implied_volatility` from `ce` and `pe` for each strike. Fall back to `greeks.iv` if the top-level field is absent (handle both shapes defensively).

### Strike window

ATM = `Math.round(spot / 50) * 50`, snapped to nearest available strike. Keep strikes where `Math.abs(strike - atm) <= 10 * 50` (500 pts each side).

---

## Component Structure

### Tab shell (`OptionsCharts.tsx` changes)

- Add `activeTab: 'premium' | 'skew'` state
- Render a tab bar at the top: **Premium** | **Skew**
- Extract existing body into `<OptionsPremiumTab ...>` (inline, no new file — just wrapped in a conditional render block)
- Render `<OptionsSkewTab expiry={expiries[0]} />` when skew tab is active

### `OptionsSkewTab.tsx`

**Props:** `expiry: string` (nearest expiry, passed from parent)

**State:**
- `skewData: SkewRow[]` — processed per-strike IV data
- `spot: number`
- `atm: number`
- `lastUpdated: string | null`
- `loading: boolean`
- `error: string`

**Types:**
```ts
interface SkewRow {
  strike: number;
  ceIV: number;
  peIV: number;
  diff: number;  // ceIV - peIV
  ceLTP: number;
  peLTP: number;
}
```

**Polling:** `useEffect` sets up a 10s `setInterval`. Fetches chain, parses `oc`, filters to ±10 strikes, sorts by strike. Clears interval on unmount.

---

## UI Layout

```
┌──────────────────────────────────────────────────────┐
│  Spot: 24,150  ATM: 24,150  Updated: 09:32:15  LIVE  │
├──────────────────────────────────────────────────────┤
│                                                      │
│   IV Smile  (LineChart, ~300px)                      │
│   CE IV ──  PE IV ──   [vertical line at ATM]        │
│                                                      │
├──────────────────────────────────────────────────────┤
│   IV Differential  (BarChart, ~150px)                │
│   CE IV − PE IV per strike, pos=blue neg=amber       │
│   Zero reference line                                │
├──────────────────────────────────────────────────────┤
│  Strike | CE IV | PE IV | Diff | CE LTP | PE LTP     │
│  ...    | ...   | ...   | ...  | ...    | ...        │
│  [ATM row highlighted in zinc-700]                   │
└──────────────────────────────────────────────────────┘
```

**Chart colours** (consistent with existing OptionsCharts palette):
- CE IV line: `#60a5fa` (blue-400)
- PE IV line: `#fbbf24` (amber-400)
- Positive diff bars: `#60a5fa`
- Negative diff bars: `#fbbf24`
- ATM reference line: `#a1a1aa` (zinc-400), dashed

---

## Files Changed

| File | Change |
|------|--------|
| `rs_dashboard/app/api/options/chain/route.ts` | Reduce `CACHE_TTL` from `30_000` → `10_000` |
| `rs_dashboard/components/OptionsCharts.tsx` | Add tab bar; wrap existing body in `activeTab === 'premium'` guard; render `<OptionsSkewTab>` when skew active |
| `rs_dashboard/components/OptionsSkewTab.tsx` | New file — full skew tab component |

---

## Out of Scope

- Expiry selector (nearest only)
- Multi-expiry overlay / term structure
- Historical skew snapshots
- Greeks (delta, gamma, vega, theta) display
