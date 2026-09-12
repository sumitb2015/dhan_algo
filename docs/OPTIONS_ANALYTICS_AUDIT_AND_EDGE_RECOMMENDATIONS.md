# Options Analytics Audit & Edge Recommendations

**Date**: September 12, 2026  
**Target Repository**: `dhan_algo` / `rs_dashboard`  
**Scope**: Options analytics engine, Greeks and risk calculation, positional & intraday option selling edges, and implementation roadmap.

---

## 1. Executive Summary & Architectural Overview

The `rs_dashboard` options analytics infrastructure features an advanced, multi-broker architecture:
- **Core Positions Analytics**: `app/(options)/options-analytics/[underlying]` powered by `components/PositionsAnalysis.tsx`.
- **Brokers Supported**: Dhan (native) & Kotak Neo (shimed), with quotes, IV, Greeks, and chains dynamically enriched via Dhan's REST & WebSocket feeds.
- **Companion Analytics Suites**:
  - `app/(options)/iv-charts` (`components/IVChartsPage.tsx`): 3D surface heatmap, strike smile/skew, intraday ATM IV.
  - `app/(options)/straddle-analysis` & `strangle-analysis`: Historical DTE decay curves, seller win rates, weekday stats, distribution.
  - `app/(options)/options/strangle-matrix` & `batman-matrix`: Real-time RoM%, POP%, offset selection across expiries.
  - `app/(options)/options/delta`: Portfolio-level net delta risk monitor.
  - `app/(options)/expiry-analysis`: Historical expiry day return probabilities.
- **Autonomous Sentinel**: `scripts/tools/antigravity_options_analyzer.py` running in background daemon or on-demand mode to flag near-expiry pin risk, high profit capture, runaway losses, and delta skew.

---

## 2. Rigorous Codebase Audit & Current Blindspots

### 2.1 Multi-Expiry Margin Blindspot (`PositionsAnalysis.tsx`)
- **Location**: `rs_dashboard/components/PositionsAnalysis.tsx:766-777`
- **Issue**: If an options book holds legs across multiple expiries (e.g., calendar spreads, diagonal strangles, or roll hedges), standalone margin computation is bypassed entirely:
  ```typescript
  const marginExpiry = useMemo(() => {
    if (!pricedLegs.length) return null;
    const first = pricedLegs[0].expiry;
    return first && pricedLegs.every((l) => l.expiry === first) ? first : null;
  }, [pricedLegs]);
  ```
- **Consequence**: Positional sellers executing calendar spreads or holding weekly hedges against monthly shorts get no margin requirement or margin-call buffer visibility.

### 2.2 Quarantined Institutional Regime Intelligence (`lib/optionsRegime.ts`)
- **Location**: `rs_dashboard/lib/optionsRegime.ts`
- **Issue**: Contains an institutional-grade **Writing Pressure Index (WPI)**:
  $$\text{WPI} = \Delta\text{PE\_OI} \cdot (-\Delta\text{PE\_Premium}) + \Delta\text{CE\_OI} \cdot (\Delta\text{CE\_Premium})$$
  combined with rolling linear-regression OI divergence slope and Spot-VWAP z-scores.
- **Consequence**: This logic is only consumed by `app/api/options/iv-history/route.ts` and is **not rendered on the primary Options Analytics dashboard**. Traders cannot see live institutional writing vs. unwinding pressure while managing positions.

### 2.3 Absence of Higher-Order Greeks ($\text{Vanna}$ and $\text{Charm}$)
- **Location**: `rs_dashboard/lib/positionGreeks.ts`
- **Issue**: Only aggregates $\Delta, \Gamma, \Theta, \text{Vega}$.
- **Consequence**: Positional writers holding 15–45 DTE options face significant weekend holding risk governed by:
  - **Charm** ($\frac{\partial \Delta}{\partial t}$): Delta decay over time.
  - **Vanna** ($\frac{\partial \Delta}{\partial \sigma}$): Delta sensitivity to sudden IV spikes or crashes.

### 2.4 Static Stop Multiple Heuristic in `BookRiskCard.tsx`
- **Location**: `rs_dashboard/components/analytics/BookRiskCard.tsx:79-86`
- **Issue**: Hardcoded $2\times$ premium stop calculation.
- **Consequence**: A $2\times$ stop on a 12-IV option produces an entirely different probability of stop-out compared to a 24-IV option. It fails to account for volatility regimes.

---

## 3. The Edge in POSITIONAL Option Selling (What Is Missing)

Positional option sellers (strangles, iron condors, ratio spreads held across days/weeks) generate edge primarily through structural premia and disciplined risk containment.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      THE POSITIONAL SELLER'S EDGE                      │
├────────────────────────┬───────────────────────────────────────────────┤
│ Core Edge Source       │ Implementation Gap in Dashboard               │
├────────────────────────┼───────────────────────────────────────────────┤
│ Variance Risk Premium  │ No live IV vs RV (Realized Volatility) spread │
│ Volatility Valuation   │ Missing IV Rank (IVR) and IV Percentile (IVP) │
│ Black Swan Protection  │ No 2D Stress Matrix (Gap % × IV Shock %)      │
│ DTE Lifecycle Gamma    │ No automated 21-DTE / Gamma transition alert  │
│ Margin Efficiency      │ No automated SPAN tail-hedge optimizer        │
└────────────────────────┴───────────────────────────────────────────────┘
```

### 3.1 Variance Risk Premium (VRP) & IV vs. RV Engine
- **Mathematical Edge**: Options are systematically overpriced relative to actual price movement:
  $$\text{VRP} = \text{IV}_{\text{ATM}} - \text{RV}_{20\text{d}}$$
- **Application**:
  - When $\text{VRP} > 0$: Net option selling has positive expected value ($+\text{EV}$).
  - When $\text{VRP} < 0$ (e.g. before major political events or during directional momentum): Option selling has negative expected value ($-\text{EV}$).
- **Recommendation**: Implement a real-time VRP gauge tracking ATM IV against Parkinson / Garman-Klass / Close-to-Close Realized Volatility.

### 3.2 IV Rank (IVR) & IV Percentile (IVP)
- **Mathematical Edge**:
  $$\text{IVR} = \frac{\text{IV}_{\text{current}} - \text{IV}_{252\text{d\_min}}}{\text{IV}_{252\text{d\_max}} - \text{IV}_{252\text{d\_min}}} \times 100$$
- **Application**: Never enter wide short strangles/straddles when IVR $< 30$. Vega expansion on a market drop will overpower theta decay.
- **Recommendation**: Integrate a 252-day IVR and IVP meter in the sticky header for NIFTY, BANKNIFTY, SENSEX, and CRUDEOIL.

### 3.3 2D Overnight Gap & Volatility Shock Matrix
- **Mathematical Edge**: Black-Scholes assumes continuous geometric Brownian motion. Indian markets frequently gap $\pm 1.5\%$ to $\pm 3.5\%$ overnight due to global cues.
- **Application**: A 2-dimensional scenario matrix:
  - Spot Shock: $-3.0\%, -2.0\%, -1.0\%, 0.0\%, +1.0\%, +2.0\%, +3.0\%$
  - IV Shock: $0\%, +15\%, +30\%, +50\%$
- **Recommendation**: Add a "Stress Matrix" tab showing projected rupee P&L and margin call risk under gap-down + vol-spike scenarios.

### 3.4 The 21-DTE Roll Rule (Gamma Climax Prevention)
- **Mathematical Edge**: Empirical options research proves that theta-to-gamma efficiency peaks between 45 DTE and 21 DTE. Inside 14–21 DTE, gamma explodes non-linearly while remaining premium is negligible.
- **Recommendation**: Implement an automated rule in `antigravity_options_analyzer.py` flagging positional legs inside 21 DTE or at $\ge 50\%$ profit capture to roll forward.

### 3.5 Automated SPAN Margin Optimization via Tail Wings
- **Mathematical Edge**: In Indian exchanges, purchasing deep OTM wings (e.g., 2–5 delta puts/calls trading at ₹3–₹7) reduces SPAN + Exposure margin by **50% to 65%**, doubling Return on Margin (RoM) while eliminating tail ruin.
- **Recommendation**: Add a 1-click **“Hedge Tail & Optimize Margin”** button in `DraftStrikeBuilder.tsx` to automatically find and stage the cheapest margin-relieving strikes.

---

## 4. The Edge in INTRADAY Option Selling (What Is Missing)

Intraday option sellers (0-DTE expiry straddles, 9:20 AM strangles) profit from daily theta decay while avoiding sudden momentum spikes and gamma pin risk.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       THE INTRADAY SELLER'S EDGE                       │
├────────────────────────┬───────────────────────────────────────────────┤
│ Core Edge Source       │ Implementation Gap in Dashboard               │
├────────────────────────┼───────────────────────────────────────────────┤
│ Combined Premium (CP)  │ No live CP line vs VWAP, High-Water Mark lock │
│ OI Shift Dynamics      │ WPI & OI-unwinding alerts not on main screen  │
│ Non-linear Time Decay  │ Missing expected intraday decay benchmark     │
│ Rebalance Triggers     │ CE:PE ratio boundary indicators not rendered  │
└────────────────────────┴───────────────────────────────────────────────┘
```

### 4.1 Live Combined Premium (CP) Decay Tracker
- **Mathematical Edge**: Trading the synthetic instrument $\text{CP} = \text{LTP}_{\text{CE}} + \text{LTP}_{\text{PE}}$:
  1. Comparing CP against its intraday VWAP.
  2. High-Water Mark (HWM) tracking to lock in trailing decay (e.g. scalp floor at 25% decay).
  3. Decay velocity ($\Delta\text{CP}/\text{minute}$).
- **Recommendation**: Add a live Combined Premium chart directly inside the "Intraday (MIS)" tab.

### 4.2 Real-Time WPI & Panic Unwinding Detection
- **Mathematical Edge**: When institutional put writers panic, Put OI drops while Put premium expands. This indicates an imminent waterfall decline.
- **Recommendation**: Connect `lib/optionsRegime.ts` directly to the `PositionsAnalysis` header to display an active badge:
  - `Confirmed Put Writing (Bullish)`
  - `Confirmed Call Writing (Bearish)`
  - `Warning: Put Panic Unwinding`

### 4.3 Intraday Decay vs. Historical Expected Curve
- **Mathematical Edge**: Intraday decay in Indian markets is front- and back-loaded:
  - `09:15 – 10:00`: High IV crush & discovery.
  - `10:00 – 12:30`: Steady theta decay.
  - `12:30 – 13:45`: European open / lunchtime flatline.
  - `14:00 – 15:15`: 0-DTE gamma volatility or final collapse.
- **Recommendation**: Plot the current intraday trade decay against the median historical decay curve (from `straddle-analysis`).

### 4.4 Automated CE:PE Ratio Rebalancing Indicators
- **Mathematical Edge**: When spot trends, the winning leg decays to near zero while the losing leg expands. Once the ratio $\frac{\text{Loser LTP}}{\text{Winner LTP}} > 2.0$, delta risk becomes asymmetric.
- **Recommendation**: Provide real-time rebalancing cues:
  - *Roll Winner ATM* to collect fresh premium.
  - *Roll Loser OTM* to neutralize delta.

---

## 5. Prioritized Implementation Roadmap

| Priority | Feature / Module | Files Impacted | Estimated Effort |
|---|---|---|---|
| **P1** | **Options Regime Live Badge** (WPI & OI Slope on header) | `PositionsAnalysis.tsx`, `optionsRegime.ts` | 1 Day |
| **P1** | **2D Overnight Gap & Vol Shock Matrix** | `PnlTableTab.tsx`, `optionsStrategy.ts` | 1–2 Days |
| **P1** | **Multi-Expiry Margin Calculation** | `optionsMargin.ts`, `PositionsAnalysis.tsx` | 1 Day |
| **P2** | **Variance Risk Premium (VRP) & IV vs. RV Gauge** | `iv-charts/page.tsx`, `PositionsAnalysis.tsx` | 2–3 Days |
| **P2** | **IV Rank (IVR) & IV Percentile (IVP) Component** | `iv_history/route.ts`, `PositionsAnalysis.tsx` | 2 Days |
| **P2** | **Live Combined Premium (CP) Decay & HWM Lock** | `PositionsAnalysis.tsx` (Intraday Tab) | 2–3 Days |
| **P3** | **One-Click SPAN Margin Wing Optimizer** | `DraftStrikeBuilder.tsx`, `optionsMargin.ts` | 3–4 Days |
| **P3** | **Sentinel Rule Upgrades** (21-DTE roll, CE:PE ratio, VRP gate) | `antigravity_options_analyzer.py` | 2 Days |
