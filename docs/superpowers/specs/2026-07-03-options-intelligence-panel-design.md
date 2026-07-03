# Options Market Intelligence Panel — Design Spec

**Date:** 2026-07-03  
**Status:** Approved  
**Author:** sumitb2015

---

## Context

The existing Options page (`/options`) has five tabs: Premium, Skew, OI, Cumulative OI, Smart Chain. These show *what* the market looks like (OI distribution, IV levels, straddle cost) but do not synthesize a *why* or *regime* signal. A trader running NIFTY straddle or directional strategies currently has to mentally combine PCR, OI flow, and IV observations into a trade decision.

This feature adds a sixth tab — **Intelligence** — that synthesises options-derived microstructure signals into actionable regime and directional bias labels, backed by intraday time-series and a GEX-anchored key-levels grid.

---

## Goal

A unified "Options Market Intelligence Panel" that answers three questions at a glance:
1. **Is the market in a pinning or trending regime?** (affects straddle vs directional choice)
2. **What is the directional bias right now?** (bull/bear/neutral from options flow)
3. **Where are the key structural levels?** (max pain, GEX flip strike, OI walls, expected range)

---

## Data Sources

| Source | Route / File | Refresh |
|---|---|---|
| Live option chain (Greeks, OI per strike) | `GET /api/options/chain` (existing) | 30 s |
| Intraday snapshot history | `GET /api/options/intelligence` **(new)** reads `debug/iv_snapshots_YYYY-MM-DD.csv` | 60 s |

The snapshot CSV is written by `scripts/tools/iv_snapshot_collector.py` (already exists). It records all 26 fields per strike per 30-second poll: `timestamp, spot, expiry, strike, CE_LTP, CE_IV, CE_OI, CE_change_OI, CE_volume, CE_bid, CE_ask, CE_delta, CE_gamma, CE_theta, CE_vega, PE_LTP, PE_IV, PE_OI, PE_change_OI, PE_volume, PE_bid, PE_ask, PE_delta, PE_gamma, PE_theta, PE_vega`.

---

## Core Formula: Gamma Exposure (GEX)

```
per_strike_net_gex = (CE_OI × CE_gamma − PE_OI × PE_gamma) × lot_size × spot / 100
```

- `CE_gamma` and `PE_gamma` are from the chain API's `greeks` dict (already returned by `options_data_fetch.py chain`).
- `lot_size` = 75 (NIFTY hardcoded; same constant used in iv_snapshot_collector.py).
- **Positive GEX at a strike** → call gamma dominates → dealers are net long gamma there → they sell into rallies and buy dips → stabilising / pinning force.
- **Negative GEX at a strike** → put gamma dominates → dealers short gamma → they amplify directional moves → trending force.
- **GEX Flip Strike** = lowest strike where cumulative net GEX (summed from lowest strike upwards) crosses zero. This is the strongest structural support/resistance level.

---

## Regime & Bias Classification

### Market Regime Badge

Computed from `net_gex_total = sum(per_strike_net_gex)` across ATM±10 strikes and today's intraday IV range:

| Priority | Condition | Label | Color |
|---|---|---|---|
| 1 | Current ATM IV > 80th percentile of today's intraday IV range | **Volatile** | Red |
| 2 | `net_gex_total > 0` | **Pinning** | Amber |
| 3 | `net_gex_total < 0` | **Trending** | Blue |
| 4 | Otherwise (no snapshot data yet or GEX ≈ 0) | **Indecisive** | Gray |

The IV percentile uses today's snapshot CSV min/max ATM IV. If the snapshot collector is not running, regime defaults to "Indecisive".

### Directional Bias Badge

Computed from the chain API's current PCR and the 30-minute PCR delta from the snapshot timeline:

| Condition | Label | Color |
|---|---|---|
| `pcr > 1.3` AND `pcr_30min_ago < pcr_now` (rising) | **Bullish** | Green |
| `pcr < 0.7` AND `pcr_30min_ago > pcr_now` (falling) | **Bearish** | Red |
| Otherwise | **Neutral** | Amber |

`pcr_30min_ago` is taken from the snapshot timeline entry closest to `now − 30 min`. Falls back to current PCR if timeline has < 2 entries.

---

## Visual Layout (OptionsIntelligenceTab.tsx)

Four stacked sections, rendered top to bottom within the tab:

### ① Regime Header

Two large badge tiles (full-width row, split 50/50):

```
┌─────────────────────────────────┬─────────────────────────────────┐
│   MARKET REGIME                 │   DIRECTIONAL BIAS              │
│   ● Pinning                     │   ● Bullish                     │
└─────────────────────────────────┴─────────────────────────────────┘
   Net GEX: +2.4Cr    PCR: 1.42    ATM IV: 12.3%    IV Range: 10.1–14.8%
```

Stat chips below (4 chips in a row): Net GEX (formatted as Cr), Chain PCR, ATM IV (%), IV Intraday Range.

### ② GEX Profile (bar chart, 300px tall)

One vertical bar per strike (ATM±10 = 21 strikes). X-axis = strike labels. Y-axis = `per_strike_net_gex`.

- Blue bars: positive GEX (stabilising)
- Red bars: negative GEX (amplifying)
- Zero reference line (horizontal, white/dim)
- Vertical dashed reference lines: current spot (white), max pain (amber), GEX flip strike (cyan label)
- Tooltip: strike, net GEX, CE OI × gamma, PE OI × gamma

### ③ Intraday Signal Timeline (3 synchronized charts, 150px each)

Data from `/api/options/intelligence`. All three share the same X-axis: 09:15–15:30 IST.

| Chart | Series | Reference lines |
|---|---|---|
| PCR | Chain PCR over session | Dashed at 0.7 (bearish) and 1.3 (bullish) |
| ATM IV | ATM strike CE IV over session | None |
| Net GEX | Total net GEX over session | Zero line; fills green above 0, red below |

If `debug/iv_snapshots_YYYY-MM-DD.csv` does not exist or has < 2 rows for today, renders a soft placeholder:
> "Intraday signals require the snapshot collector — start it from the IV Charts page."

### ④ Key Levels Grid (2 rows × 3 tiles)

| Row 1 | Max Pain strike | GEX Flip Strike | Expected Move |
|---|---|---|---|
| Row 2 | PE OI Wall (highest PE OI strike) | CE OI Wall (highest CE OI strike) | IV Intraday Range |

Each tile: label chip + large numeric value + small subtitle.

---

## New Files

| File | Purpose |
|---|---|
| `rs_dashboard/app/api/options/intelligence/route.ts` | Reads snapshot CSV, returns intraday PCR/IV/GEX timeline + current regime inputs |
| `rs_dashboard/components/OptionsIntelligenceTab.tsx` | Full intelligence tab component |

## Modified Files

| File | Change |
|---|---|
| `rs_dashboard/components/OptionsCharts.tsx` | Add `'intelligence'` to `activeTab` union type; add tab button; render `<OptionsIntelligenceTab expiry={expiry} />` |

---

## New API Route: `/api/options/intelligence`

**Query params:** `?date=YYYY-MM-DD&wings=10` (both optional; default to today and 10 wings)

**Response shape:**

```ts
{
  success: boolean;
  date: string;
  atm: number;
  expiry: string;
  hasData: boolean;           // false if CSV missing or empty
  current: {
    net_gex: number;          // sum of per_strike_net_gex across wings
    pcr: number;              // current chain PCR (from most recent snapshot row)
    atm_iv: number;           // current ATM CE IV
    iv_min: number;           // today's intraday ATM IV minimum
    iv_max: number;           // today's intraday ATM IV maximum
    pcr_30min_ago: number | null;
  };
  gex_profile: Array<{        // one entry per strike in ATM±wings
    strike: number;
    net_gex: number;
    ce_gex: number;           // CE_OI × CE_gamma × lot_size
    pe_gex: number;           // PE_OI × PE_gamma × lot_size
  }>;
  gex_flip_strike: number | null;   // strike where cumulative GEX crosses zero
  timeline: Array<{
    time: string;             // HH:MM IST
    ts: number;               // epoch ms (for X-axis domain)
    pcr: number;
    atm_iv: number;
    net_gex: number;
  }>;
}
```

**Server-side computation:**
1. Read CSV → parse into rows grouped by timestamp
2. For each timestamp: filter to ATM±wings strikes; compute `sum(PE_OI)/sum(CE_OI)` for PCR; take CE_IV at the ATM strike for atm_iv; compute `sum((CE_OI×CE_gamma − PE_OI×PE_gamma) × 75)` scaled by `spot/100` for net_gex
3. Build GEX profile from the **most recent** timestamp's rows
4. Compute GEX flip strike: sort strikes ascending, compute cumulative GEX, find first strike where cumulative sum crosses from negative to positive
5. Compute iv_min/iv_max from all timeline atm_iv values
6. For pcr_30min_ago: find the timeline entry with `ts` closest to `now_ts − 30*60*1000`

---

## Verification

1. **Unit path**: Start `iv_snapshot_collector.py`, wait 2+ polls, then hit `GET /api/options/intelligence` — verify `hasData: true`, `timeline` has ≥2 entries, `gex_profile` has 21 entries, `gex_flip_strike` is a valid NIFTY strike (multiple of 50).
2. **Regime badge**: If net_gex is positive in the response, the regime badge on screen shows "Pinning" in amber. If negative, "Trending" in blue.
3. **Bias badge**: Artificially set PCR = 1.5 (via mock data or by inspecting a live session) — badge should show "Bullish" in green.
4. **No data graceful degradation**: Delete today's snapshot CSV or stop the collector before market open — the timeline section shows the placeholder message; the header and GEX profile still render from the chain API alone.
5. **GEX flip strike**: The GEX Profile chart should show a `(cyan)` label on the bar corresponding to `gex_flip_strike` returned by the API.
6. **Tab integration**: The "Intelligence" tab button appears after "Smart Chain" in `OptionsCharts.tsx`; clicking it renders the new component without affecting other tabs.
