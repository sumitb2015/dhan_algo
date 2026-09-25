# Payoff Diagram Architecture & OpenAlgo Upgrades

**Date**: September 25, 2026  
**Scope**: `rs_dashboard/components/strategy/PayoffDiagram.tsx`, `MultiLegStrategyRow.tsx`, and `lib/optionsStrategy.ts`.

---

## 1. Overview & Architectural Principles

The Payoff Diagram in `rs_dashboard` provides visual, real-time risk modeling for options strategies (single-expiry baskets, vertical spreads, Iron Condors, short straddles/strangles, and multi-expiry calendar/diagonal structures).

### Core Principles
1. **Mathematical Invariance**: Visual and UI improvements must never alter or compromise existing calculation engines (`computePayoff`, `buildPayoffCurve`, `computeMultiExpiryStats`, `computeBsGreeks`).
2. **Sub-Millisecond Responsiveness**: Hand-rolled SVG rendering delivers instant visual feedback when dragging simulation sliders, without the layout overhead or animation lag of heavy canvas/DOM charting libraries.
3. **Instance Isolation**: Every chart instance on multi-row pages (e.g. `/multi-leg-focus`) must be strictly isolated to prevent SVG clipping, gradient, or coordinate collisions.
4. **Theme Parity**: Seamless contrast and token resolution across Dark, White, and Beige dashboard themes via `useChartChrome()` and CSS theme variables.

---

## 2. OpenAlgo Benchmark & Comparative Analysis

Following an audit of OpenAlgo options payoff diagram specifications (`https://docs.openalgo.in/skills`), we identified several institutional UX features that elevated trader situational awareness:

| Feature Dimension | dhan_algo (Baseline) | OpenAlgo Benchmark | dhan_algo (Upgraded) |
|---|---|---|---|
| **Underlying Math** | Black-76 on Futures + Intrinsic Expiry | Black-Scholes / Intrinsic | Unchanged — our Black-76 multi-expiry engine was retained 100%. |
| **Strategy Metrics Strip** | Split across external card text | Unified top ribbon | Embedded header badge strip: Max Profit (+ ROM %), Max Loss, R:R (`1 : 1.8`), and POP %. |
| **Greeks Visibility** | Separate modal table | Prominent on chart | Live Net Greeks badge strip ($\Delta$, $\theta$ in ₹/day, $\nu$ in ₹/% IV) in the header. |
| **What-If Simulation** | Static expiry + $T+0$ line | Time ($\theta$) & Vol ($\Delta\text{IV}$) sliders | Embedded dual simulation slider bar with instant "Reset All". |
| **Strike Pins** | Not pinned on X-axis | Strike markers on X-axis | Colored buy (`#38bdf8`) / sell (`#fb7185`) badges with dashed vertical guidelines to kinks. |
| **Expected Move** | Computed in math, not plotted on SVG | Shaded $\pm 1\text{SD}$ zone | Shaded expected move zone (`#0ea5e9`, 4.5% opacity) with clipped boundary markers. |
| **Y-Axis Scale (Undefined Risk)**| Clamped to $3.0\times$ Max Profit | Adaptive | Clamped to $1.8\times$ Max Profit, expanding the profit zone from 25% to ~45% of vertical height. |

---

## 3. Corner-Case Hardening & Guard Reference

### 3.1 SVG `clipPath` Collision Across Multi-Strategy Rows
* **Symptom**: On `/multi-leg-focus`, the second strategy row showed an inverted red loss wash across profitable territory above the zero line.
* **Root Cause**: SVG `<clipPath id="sb-clip-profit">` shared a static ID. The browser resolved `url(#sb-clip-profit)` to Row 0's clipping rectangle (`zeroY ≈ 120px`) instead of Row 1's (`zeroY ≈ 220px`).
* **Fix**: Scoped IDs with React `useId()`:
  ```tsx
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const profitClipId = `sb-clip-profit-${uid}`;
  const lossClipId = `sb-clip-loss-${uid}`;
  ```

### 3.2 Viewport Domain Bounding & Epsilon Filtering
* **Extrapolation Guard**: Bounded $x_{\text{Lo}}$ and $x_{\text{Hi}}$ strictly within `[curve[0].spot, curve[curve.length - 1].spot]` to avoid flat-tail extrapolation on high zoom.
* **Zero-Span Guard**: Added `if (xHi - xLo < 1e-4) return null;` to prevent divide-by-zero errors in `sx(x)`.
* **Epsilon Filtering**: Used `curve.filter(c => c.spot > xLo + 1e-4 && c.spot < xHi - 1e-4)` to prevent duplicating interpolated edge points.

### 3.3 What-If Simulation Mathematical Bounds
* **Time Expiry Floor**: When dragging time decay forward to expiry, time remaining $t$ is strictly floored:
  ```ts
  const timeYears = Math.max(0.0001, totalTimeYears - (simTargetDays / 365));
  ```
* **Implied Volatility Floor**: When applying negative IV shifts (up to $-15\%$), shifted IV is floored:
  ```ts
  const iv = Math.max(0.01, baseIv + (simIvShift / 100));
  ```

### 3.4 Strike Pin & X-Axis Clearance
* Increased `PAD.bottom` to `38px`.
* Strike badges positioned at `H_ - PAD.bottom - 16` (height 14px).
* X-axis spot tick numbers positioned at `H_ - PAD.bottom + 17`.
* Vertical clearance between badges and ticks is ~19px, completely eliminating visual overlap.

---

## 4. Verification Suite

All modifications are verified by automated tests:
```bash
# Unit tests: Options Math + Strategy Tests (37/37 passing)
node --test rs_dashboard/lib/optionsMonitorMath.test.ts rs_dashboard/lib/optionsStrategy.test.ts

# TypeScript compilation (0 errors)
npx tsc --noEmit

# Production build (All 130+ routes optimized)
npm run build
```
