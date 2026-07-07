# Morning Premarket Analysis Page — Design Spec

**Date:** 2026-07-06  
**Status:** Approved  
**Author:** sumitb2015

---

## Context

Traders need a single, consolidated premarket view before the Indian market opens (or in the first few minutes). Currently the dashboard has no dedicated premarket page — a trader has to manually check VIX on the options page, navigate to performance for index levels, and open external sites for US markets and commodity prices. This page aggregates all pre-trade context into one load-once view.

---

## Goal

A `/premarket` page that gives a holistic premarket snapshot:
1. Auto-computed market bias signal with contributing factors
2. Nifty spot, futures premium/discount, and expected day range
3. India VIX analysis (level + interpretation)
4. ATM IV, PCR, and OI-derived key levels (support/resistance) with fetch timestamp
5. Global markets — US (prev close) and Asian (prev close) via Yahoo Finance
6. MCX Commodities — Gold, Silver, Crude Oil via Dhan

---

## Data Sources

| Data | Source | Notes |
|---|---|---|
| Nifty spot | Dhan REST `/v2/marketfeed/ohlc` — security 13, NSE_IDX | LTP + prev close |
| Nifty futures LTP | Dhan REST — current-month NIFTY FUT via master_list lookup | Futures premium = Futures LTP − Spot |
| India VIX | Reuse logic from `app/api/scalper/vix/route.ts` — security 21, NSE_IDX | LTP + prev close |
| Options chain OI + ATM IV | Reuse logic from `app/api/options/chain/route.ts` — Python spawn | Max CE OI strike, max PE OI strike, ATM IV, PCR |
| MCX Commodities | Dhan REST `/v2/marketfeed/ohlc` — MCX security IDs from master_list (GOLD, SILVER, CRUDEOIL) | LTP + prev close for each |
| US markets | Yahoo Finance `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d` — ^DJI, ^GSPC, ^IXIC | Last two daily closes to compute % change. Labeled "Prev Close". |
| Asian markets | Yahoo Finance — ^N225 (Nikkei), ^HSI (Hang Seng) | Same format as US markets |
| Gift Nifty | Yahoo Finance — `^NSEI` (Nifty 50 index) as proxy, labeled "Nifty (Yahoo)" | Prev close + % change. Note: true Gift Nifty futures are not reliably available on Yahoo Finance; `^NSEI` gives close enough directional context. |

All data fetched in `Promise.all` inside the single aggregator route.

---

## Architecture

### New Files

```
rs_dashboard/
  app/
    premarket/
      page.tsx                  ← thin shell: return <PremarketDashboard />
    api/
      premarket/
        route.ts                ← aggregator GET route
  components/
    PremarketDashboard.tsx      ← 'use client', full page component
```

### API Route (`/api/premarket`)

Single `GET` handler. Runs these in `Promise.all`:

1. **Nifty spot + futures** — two Dhan OHLC calls (security 13 for spot, futures contract security ID looked up from master_list for the nearest expiry). Returns `{spot, spotPrevClose, futuresLtp, futuresPremium}`.
2. **India VIX** — inline the same Dhan OHLC call as `app/api/scalper/vix/route.ts` (security 21, NSE_IDX). Returns `{vix, vixPrevClose}`.
3. **Options chain** — `spawnSync` call to `scripts/tools/options_data_fetch.py chain` (same as existing chain route). Computes from response: `{atmIV, pcr, maxCeOiStrike, maxPeOiStrike, chainFetchedAt}`. `chainFetchedAt` is `new Date().toISOString()` recorded after the spawn completes.
4. **MCX commodities** — spawn a small Python script (or inline `spawnSync` calling `options_data_fetch.py` with a new `commodities` action) that uses `DhanHelper.find_future("GOLD", exchange="MCX")` etc. to resolve current-month MCX security IDs, then calls Dhan OHLC. Returns `[{name, ltp, prevClose, pctChange}]`. Symbols: `GOLD`, `SILVER`, `CRUDEOIL` on MCX.
5. **Global markets** — `fetch` to Yahoo Finance for each symbol (`^DJI`, `^GSPC`, `^IXIC`, `^N225`, `^HSI`, Gift Nifty proxy). Parse last two daily closes from the `chart.result[0].indicators.quote[0].close` array. Returns `{name, prevClose, prevPrevClose, pctChange}[]`. Wraps in `try/catch` — if Yahoo is unreachable, returns `null` entries for global markets (page renders "Unavailable" for those tiles).

Response shape:
```ts
{
  fetchedAt: string;           // ISO timestamp of full page fetch
  nifty: { spot, spotPrevClose, futuresLtp, futuresPremium };
  vix: { vix, vixPrevClose, vixPctChange };
  options: { atmIV, pcr, maxCeOiStrike, maxPeOiStrike, chainFetchedAt };
  commodities: { name, ltp, prevClose, pctChange }[];
  globalMarkets: { name, region, prevClose, pctChange }[] | null;
  bias: BiasResult;            // computed server-side (see below)
}
```

### Market Bias Computation (server-side, inside the route)

Computed after all data is gathered, before the response is sent:

| Signal | Condition | Score |
|---|---|---|
| Gift Nifty direction | pctChange > 0 (skip if data unavailable) | +1 |
| Gift Nifty direction | pctChange < 0 (skip if data unavailable) | −1 |
| India VIX level | < 14 | +1 |
| India VIX level | 14–18 | 0 |
| India VIX level | 18–25 | −1 |
| India VIX level | > 25 | −2 |
| PCR | > 1.2 | +1 |
| PCR | 0.8–1.2 | 0 |
| PCR | < 0.8 | −1 |
| Spot vs OI levels | spot closer to support than resistance | +1 |
| Spot vs OI levels | spot closer to resistance than support | −1 |

Total score → label:
- ≥ 3 → **Bullish**
- 1–2 → **Cautiously Bullish**
- 0 → **Neutral**
- −1 to −2 → **Cautiously Bearish**
- ≤ −3 → **Bearish**

`BiasResult` shape:
```ts
{ label: string; score: number; factors: { label: string; direction: 'positive' | 'negative' | 'neutral' }[] }
```

---

## Page Layout (`PremarketDashboard.tsx`)

### Header (sticky)
Same pattern as breadth/performance pages:
```tsx
<header className="sticky top-0 ... border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md">
  {/* gradient icon + "Morning Premarket" title */}
  <NavBar />
  <span>DATA: {date}</span>
  <button onClick={refresh}><RefreshCw /></button>
</header>
```

### Section 1 — Market Bias Card (full width)
Prominent card. Large label (e.g. "Cautiously Bullish") with color badge (green shades for bullish, zinc for neutral, red shades for bearish). Below it: a row of factor pills showing each contributing signal with a colored dot.

### Section 2 — Nifty Overview (4 stat tiles in a row)
| Tile | Value |
|---|---|
| Nifty Spot | LTP with prev close below |
| Futures Premium | +X.XX pts (green) or −X.XX pts (red) |
| Prev Close | yesterday's close |
| Expected Day Range | ±X pts (derived: `spot × atmIV/100 / √252`) |

### Section 3 — India VIX (3 stat tiles)
Current VIX | Prev Close | % Change + qualitative label (Low / Moderate / Elevated / Extreme) with color.

### Section 4 — ATM IV & OI Levels (4 stat tiles + fetch timestamp)
ATM IV % | PCR | Max CE OI Strike (Resistance) | Max PE OI Strike (Support)  
Below tiles: `"Options chain fetched at HH:MM on DD-MMM-YYYY"` in `text-zinc-500 text-xs`.

### Section 5 — Global Markets (two column groups)
Left: **US Markets** — Dow Jones, S&P 500, Nasdaq  
Right: **Asian Markets** — Nikkei 225, Hang Seng, Gift Nifty  
Each entry: name + prev close value + % change chip. Section labeled "Previous Close — updated pre-open".

### Section 6 — Commodities (3 stat tiles)
MCX Gold | MCX Silver | MCX Crude Oil  
Each tile: name + LTP + % change from prev close.

---

## NavBar Integration

Add "Premarket" entry to the `NavBar` component under the "Market Health" group (alongside Breadth, Performance).

---

## Tile / Component Style

Follow existing patterns from `BreadthAnalysis.tsx` and `performance/page.tsx`:
- Stat tiles: `bg-zinc-900 rounded-xl p-4 border border-zinc-800`
- Positive % change: `text-emerald-400`
- Negative % change: `text-red-400`
- Table headers: `text-xs font-bold text-white bg-zinc-800`
- No text color opacity modifiers (use solid zinc colors)

---

## Error Handling

- If Yahoo Finance fetch fails → global markets section shows "Data unavailable" message, rest of page renders normally.
- If Dhan OHLC call fails (e.g. market closed, token expired) → affected tiles show "—" with a muted error note.
- If options chain Python spawn fails → OI section shows "Chain unavailable" with the error.
- Overall: page-level error only if the entire route throws; otherwise section-level graceful degradation.

---

## Verification

1. Navigate to `http://localhost:3000/premarket` — page loads with spinner, then renders all sections.
2. Confirm "Fetched at" timestamp on the OI levels section matches current time.
3. Confirm futures premium tile shows a non-zero value (positive in contango, negative in backwardation).
4. Confirm MCX commodity tiles show values (not "—") during market hours.
5. Confirm global markets tiles show yesterday's close values with % change.
6. Confirm refresh button re-fetches everything and updates the `DATA:` chip.
7. Confirm "Premarket" link appears in NavBar under Market Health.
8. Disable network and confirm global markets shows "Data unavailable" without breaking the rest of the page.
