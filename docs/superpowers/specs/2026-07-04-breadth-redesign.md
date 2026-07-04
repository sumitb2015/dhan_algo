---
name: breadth-redesign
description: Full redesign of /breadth page — data journalism style, three-universe side-by-side comparison, inline tooltips, full Nifty 50 constituent breadth suite
metadata:
  type: project
---

# Breadth Page Redesign Spec

**Date:** 2026-07-04  
**Scope:** `rs_dashboard/components/BreadthAnalysis.tsx` + `rs_dashboard/app/api/breadth/route.ts`

---

## Goal

Redesign `/breadth` as a deep-dive analysis tool with:
- Clear visual hierarchy (most important → supporting detail, top to bottom)
- Data journalism aesthetic (clean, structured, prominent numbers)
- Three-universe side-by-side comparison: Nifty 50 Index | Nifty 50 Stocks | Nifty 500 Stocks
- Inline formula/definition tooltips on every metric label
- Fixed computation labeling (SMA vs EMA, RSI bucket naming)

---

## API Changes (`app/api/breadth/route.ts`)

### Response shape

```ts
export interface BreadthResponse {
  nifty50: IndexStats;          // unchanged — index trend
  nifty50Breadth: BreadthStats; // NEW — full suite for 50 constituents
  nifty500Breadth: BreadthStats; // unchanged
  regimeLabel: string;
  regimeColor: 'green' | 'lime' | 'yellow' | 'orange' | 'red';
  dataDate: string;
}
```

**Removed:** `IndexStats.nifty50BreadthPct` — now covered by `nifty50Breadth.aboveEma200Pct`.

### New computation

In `GET()`, call `computeBreadthStats(NIFTY50_SYMBOLS)` alongside the existing `computeBreadthStats(nifty500Symbols)` call. Both run in parallel via `Promise.all`.

Remove `computeNifty50BreadthPct()` — it is superseded.

### RSI bucket rename

Rename `rsiNeutral` → `rsiBucket40to70` in `BreadthStats` to make the 40–70 range explicit. The UI splits this into two visual sub-buckets (60–70 "Elevated" and 40–60 "Neutral") using `rsiAbove60` and `rsiOverbought`. No formula change — rename only.

### MA labeling

- Index trend uses `ema()` → label as **EMA 20/50/200** everywhere.
- Stock breadth uses `simpleMA()` → label as **SMA 20/50/200** everywhere.
- No computation change.

---

## Component Changes (`components/BreadthAnalysis.tsx`)

### Visual design language

| Property | Spec |
|---|---|
| Font | System stack (`font-sans`) — Inter/SF Pro |
| Primary KPI numbers | `text-3xl font-bold tabular-nums` |
| Secondary numbers | `text-xl font-semibold tabular-nums` |
| Labels | `text-xs font-medium uppercase tracking-widest text-zinc-400` |
| Body text | `text-sm text-zinc-300` |
| Monospace | Only for `DATA:` date chip |
| Background (body) | `bg-zinc-950` |
| Background (cards) | `bg-zinc-900` |
| Background (card headers) | `bg-zinc-800` |
| Borders | `border-zinc-800` 1px |
| Signal colors | emerald-400 (bull), red-400 (bear), amber-400 (caution) |
| Structural chrome | zinc-* only — no amber used for structure |

**Removed:** Semi-circle SVG gauges — replaced by large stat tiles (number + colored badge).

### Page structure (top → bottom)

```
[ Sticky Header ]
[ Regime Banner ]
[ Three-column Comparison Grid ]  ← centerpiece
[ MA Penetration Table ]
[ RSI Distribution ]
[ 52W Extremes ]
[ Regime Guide ]
```

---

### Sticky Header

```
Left:  "MARKET BREADTH" (title) / "Nifty 50 · Nifty 500 Universe" (subtitle)
Center: <NavBar />
Right: DATA chip + refresh button + last-updated time
```

---

### Regime Banner

Full-width bar with subtle tinted background (`bg-emerald-950`, `bg-red-950`, etc.) and a 3px left border in the regime color.

Contents (left → right):
1. **Regime label** — `text-4xl font-black` e.g. "BULL MARKET"
2. Divider
3. KPI tile: **Participation Score** (number + `/100` + colored label badge) — from **N500 universe** (regime driver)
4. KPI tile: **A/D Ratio** (number + `x` + label) — from **N500 universe**
5. KPI tile: **Net Advance-Decline** (number with +/- sign + label) — from **N500 universe**
6. Right-aligned: condition text (e.g. "≥60% stocks above 200d SMA") + recommended action sentence

---

### Three-column Comparison Grid

Three equal columns. Sticky column-header row with universe names.

**Column headers:**
| Column | Title | Subtitle |
|---|---|---|
| 1 | NIFTY 50 INDEX | Trend analysis |
| 2 | NIFTY 50 STOCKS | 50 constituents |
| 3 | NIFTY 500 STOCKS | 500 universe |

**Row layout per column:** label left (with tooltip trigger = dotted underline), value right (colored).

**Column 1 — Nifty 50 Index rows:**
| Label | Value | Tooltip |
|---|---|---|
| Close | price | — |
| Trend State | badge (Strong Uptrend / Uptrend / etc.) | "Price vs EMA alignment: Strong Uptrend = Close > EMA20 > EMA50 > EMA200" |
| EMA 20 | value + % above/below | "20-day exponential moving average. k = 2/(20+1)" |
| EMA 50 | value + % above/below | "50-day EMA — medium-term trend anchor" |
| EMA 200 | value + % above/below | "200-day EMA — long-term trend. Most critical level for regime" |
| ADX (14) | value + label badge | "Average Directional Index (Wilder, 14-period). >40 strong, 25–40 trending, 20–25 weak, <20 no trend" |
| Chop Index | value + label badge | "Choppiness Index = 100 × log10(ΣTR / (HH−LL)) / log10(N). <38.2 trending, >61.8 choppy" |
| Trend Strength Score | 0–100 number + badge | "Composite: +20 Strong Uptrend, +10 Uptrend, +5 Above EMA200, −10 Below EMA200, −20 Downtrend; +15 if ADX≥25, −5 if ADX<20. Clamped 0–100" |

**Columns 2 & 3 — Breadth rows (identical structure):**
| Label | Value | Tooltip |
|---|---|---|
| Participation Score | 0–100 + badge | "Weighted: SMA200 pct × 0.40 + SMA50 pct × 0.30 + SMA20 pct × 0.20 + A/D transform × 0.10" |
| Above SMA 200 | count + pct + bar | "Stocks with close > 200-day simple moving average. Primary regime indicator" |
| Above SMA 50 | count + pct + bar | "Stocks above 50-day SMA — medium-term market breadth" |
| Above SMA 20 | count + pct + bar | "Stocks above 20-day SMA — short-term breadth momentum" |
| Bull Power | count + pct | "Close > SMA20 > SMA50 > SMA200 — all three MAs fully bullish-aligned" |
| Bear Power | count + pct | "Close < SMA20 < SMA50 < SMA200 — all three MAs fully bearish-aligned" |
| A/D Ratio (1W) | value + x + badge | "Advancing ÷ Declining stocks over past 7 calendar days. ≥3 strongly bullish, ≥2 bullish, ≥1 neutral-bull, <0.5 bearish" |
| Net A/D | ±number | "Advancing − Declining stocks (1 week)" |
| RSI Overbought >70 | count + pct + bar | "14-period Wilder RSI > 70. Many overbought stocks = crowded, risk of pullback" |
| RSI Elevated 60–70 | count + pct + bar | "RSI 60–70 = bullish momentum zone" |
| RSI Neutral 40–60 | count + pct + bar | "RSI 40–60 = neutral, no strong momentum" |
| RSI Oversold <40 | count + pct + bar | "RSI < 40 = oversold, potential reversal candidates" |
| 52W Highs | count + pct | "Within 0.5% of 52-week high (252 trading days)" |
| 52W Lows | count + pct | "Within 0.5% of 52-week low" |
| H/L Ratio | value + x + badge | "New 52W Highs ÷ New 52W Lows. ≥2 bullish, <0.5 bearish" |

Inline mini-bars (8px height, full width of cell) under each percentage — color-coded emerald/red.

---

### MA Penetration Table (full-width, below grid)

Two sub-tables side by side: N50 Stocks | N500 Stocks.
Columns: Indicator | Count | % Universe | Below | Interpretation.
Rows: Above SMA 20 / Above SMA 50 / Above SMA 200.
Active row highlighted if pct > 60% (emerald tint) or < 40% (red tint).

---

### RSI Distribution Section (full-width)

Two side-by-side stacked bar charts (N50 vs N500).
Bar segments: Overbought (red) | Elevated (orange) | Neutral (zinc) | Oversold (emerald).
Below each bar: count + pct for each segment.
Section title tooltip: "Wilder RSI(14) over trailing 60 closes."

---

### 52W Extremes Section (full-width)

Two side-by-side panels: N50 Stocks | N500 Stocks.
Each panel: Highs mini-bar + Lows mini-bar + H/L Ratio tile.

---

### Regime Guide (full-width)

Table: Regime | Condition | Trading Action.
Active row has left border + tinted background in regime color.
Column headers: `text-xs uppercase zinc-400`.

---

## Tooltip Component

```tsx
// Dotted underline on label; on hover show dark card:
// - Metric name (bold)
// - Formula / definition (text-sm zinc-300)
// - Threshold scale (optional, e.g. ">40 strong | 25–40 trending | <20 no trend")
// Implemented with CSS :hover + absolute positioning, no JS library needed
// z-index: 50, max-width: 280px
```

---

## What Does NOT Change

- API route path (`/api/breadth`)
- 5-minute server-side cache
- `computeADX`, `computeChopIndex`, `wilderRSI`, `ema`, `simpleMA` implementations
- Regime derivation logic (`aboveEma200Pct` thresholds)
- Participation score formula weights
- NavBar component
- All other dashboard pages

---

## Computation Cross-check Notes

These were verified during design against the source code:

1. **Participation score** = `EMA200pct×0.4 + EMA50pct×0.3 + EMA20pct×0.2 + (advDecRatio/(advDecRatio+1))×100×0.1`. The last term is a sigmoid transform capped at ~10 points. Correct.
2. **RSI sub-bucket** `rsiNeutral − (rsiAbove60 − rsiOverbought)` = stocks with RSI 40–60. Mathematically correct; addressed by rename + explicit tooltip.
3. **SMA vs EMA**: stock breadth uses `simpleMA()` (SMA); index uses `ema()` (EMA). Both are correct for their purposes; inconsistency was only in labeling.
4. **52W High/Low**: "within 0.5%" threshold is a standard approximation for "near high/low." Documented in tooltip.
5. **A/D uses 7 calendar days** — not 5 trading days. This means weekend gaps can affect the count. Documented in tooltip.
