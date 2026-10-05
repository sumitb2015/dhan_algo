---
name: dhan-payoff-diagrams
description: Use when building or extending an options payoff/P&L diagram — computing the curve (per-leg payoff, breakevens, max profit/loss, POP, SD expected-move bands, pre-expiry Black-76 on futures / Black-Scholes pricing, target sliders) or rendering it (the hand-rolled SVG chart family in BasketPayoffChart.tsx, PositionsPayoffChart.tsx, PayoffDiagram.tsx, StrategyBuilder, Baskets, PositionsAnalysis; or the recharts-based Options Monitor at app/options-monitor and lib/optionsMonitorMath.ts). Not for the draft-leg staging UI or margin/ROI stats strip around a payoff chart — that's dhan-options-analytics-page. Not for aggregating/displaying a live position book's Greeks from Dhan's own chain-supplied per-contract Greeks (Positions Analysis' Greeks tab, ScalperGreeksModal, DeltaPanel) — that's a different pipeline with its own units convention, see dhan-position-greeks.
---

# Options Payoff Diagrams

## Overview
Payoff diagrams in this dashboard split into two distinct rendering architectures backed by specialized math modules:

1. **The Hand-Rolled SVG Family** (`lib/optionsStrategy.ts` + `components/BasketPayoffChart.tsx`, `components/analytics/PositionsPayoffChart.tsx`, `components/strategy/PayoffDiagram.tsx`):
   - Designed for strategy builders and static/draft position books.
   - Pure SVG drawing with two `clipPath`s split at $y=0$ to stroke/fill positive P&L in green and negative P&L in red.
   - `BasketPayoffChart.tsx` is the canonical reference implementation that correctly consumes `useChartChrome()`.
   - **Every instance in this family must also plot the T+0 curve — see "Every Payoff Diagram Must Plot the T+0 (Today) Curve" below.** `components/strategy/PayoffDiagram.tsx` takes it as an optional `todayCurve` prop (2026-09); a caller that doesn't yet pass one is a gap to close, not an acceptable permanent state.

2. **The Options Monitor Terminal (Recharts)** (`lib/optionsMonitorMath.ts` + `app/options-monitor/page.tsx`, `components/options-monitor/PositionsStrategyMonitor.tsx`):
   - A high-density, interactive options terminal matching Sensibull's analytics, payoff curves, Black-76 Greeks, and what-if target sliders.
   - Built on Recharts `<ResponsiveContainer>`, `<LineChart>`, `<ReferenceArea>`, and `<ReferenceLine>` primitives.
   - Prices off underlying **Futures (Black-76)** with live basis tracking.
   - Calculates exact Standard Deviation ($\pm 1\text{SD}$, $\pm 2\text{SD}$) bands, probability shading, and multi-horizon target projections.

---

## When to Use
- Adding a new payoff/P&L chart or extending an existing one with target-date curves, what-if sliders, or Greek projections.
- Modifying breakeven calculation, max profit/loss, probability of profit (POP), or standard deviation expected-move bands.
- Pricing options pre-expiry via Black-76 on futures or Black-Scholes on spot.
- Sizing delta-hedge orders or rendering position Greeks ("Multiply by Lot Size" vs per-share).
- Diagnosing payoff visual bugs: wobbly curve lines, vanished reference markers, light/dark theme contrast failures, or missing leg IV warnings.
- **Not for**: Draft-leg staging UI, margin requirements, or historical payoff backtests — see `dhan-options-analytics-page`. For the recharts-specific mechanics of the Options Monitor terminal itself (tooltip theming, animation-on-live-tick, axis domain scaling) see `dhan-recharts-charting` — this skill owns the curve math, that one owns how the chart is wired.

---

## The Math Layer

### 1. Per-Leg Payoff & Single Lot-Size Scaling
In `lib/optionsStrategy.ts`, `legPayoffAtExpiry(spot, leg)` calculates intrinsic payoff **per unit of lot**:
- **BUY Call**: $\max(0, \text{spot} - K) - \text{entryPrice}$
- **SELL Call**: $\text{entryPrice} - \max(0, \text{spot} - K)$
- **BUY Put**: $\max(0, K - \text{spot}) - \text{entryPrice}$
- **SELL Put**: $\text{entryPrice} - \max(0, K - \text{spot})$

The portfolio curve sums per-unit payoffs and multiplies by `lotSize` **once at the end**:
$$\text{netPnl} = \text{lotSize} \times \sum_{i} \text{legPayoff}_i \times \text{lots}_i$$
*Never scale by lot size per leg*, or mixed books will miscalculate ratios. In `lib/optionsMonitorMath.ts`, legs hold raw broker signed `qty` (already lot-scaled), so payoff is calculated directly: `qty * (intrinsic - entryPrice)` for BUY and `qty * (entryPrice - intrinsic)` for SELL.

### 2. Spot Sampling Must Include All Strikes
Piecewise-linear payoff curves only kink at strikes:
- Sampling evenly on a naive grid rounds off sharp corners and skips exact breakevens.
- `buildSpotSamples` (`lib/optionsStrategy.ts`) builds 150 even samples over the larger of ±`spanPct` of spot (default `DEFAULT_SPAN_PCT` = **1.5%**, not 10-15%) and `strikeStep * 4` beyond the outermost strike, **widened to cover every exact breakeven plus the same padding**, floored at spot 0. It then force-adds every leg's exact strike. Sort and deduplicate.
- The window only decides what is *drawn*. Never derive stats from it (next section).

### 3. Breakevens and Bounded Extremes: Exact, Not Sampled
> **Implementation note (2026-10-05):** `exactExpiryProfile`, `zeroCrossings` and `findBreakevens` were deleted; `buildPayoffModel` (lib/optionsPayoff.ts) now solves break-evens by bisection (rounded to 2 dp) and takes extremes from the kink values. The rules below still hold.

The solver evaluates the payoff at every strike, at spot 0, and along the straight tail beyond the highest strike, so results do not depend on the sampled range:
- **Breakevens** = every sign change of that point list (`zeroCrossings`), linearly interpolated. A run of exact zeros counts once and only if the sign really flips; a curve that only touches zero, or sits flat on it, has no breakeven. `findBreakevens(curve)` uses the same walk for callers that only have a sampled curve.
- **Bounded max profit / max loss** come from the same kink values (a long put's best point is at spot 0: strike − premium), never from `Math.max/min` of the drawn samples. Those window figures survive only as `maxProfitInRange` / `maxLossInRange`, which must be shown with `rangeLo`/`rangeHi`.
- Failure this replaced (NISM example, spot 6100): a long strangle 6200 CE + 6000 PE returned no breakevens (real: 5715 and 6485) and a long put showed a window value as "maximum profit". Regression tests: `lib/optionsStrategy.test.ts` ("exact expiry profile" block).

### 4. True Unlimited Profit/Loss Contract
Never determine "unlimited" by checking whether the finite sampled array tail is sloping:
- Compute net signed quantity per contract type:
  - Net short calls ($\sum \text{qty}_{\text{CE}} < 0$) $\implies$ **Unlimited loss upside**.
  - Net short puts ($\sum \text{qty}_{\text{PE}} < 0$) $\implies$ **Unlimited loss downside**.
  - Net long calls ($\sum \text{qty}_{\text{CE}} > 0$) $\implies$ **Unlimited profit upside**.
  - Net long puts ($\sum \text{qty}_{\text{PE}} > 0$) $\implies$ **Capped downside profit** (spot cannot fall below 0).
- If displaying `maxLossInRange` or `maxProfitInRange` for an unlimited position, always render an accompanying label stating the sampled domain bounds so users are never misled into treating it as a capped risk.

### 5. Probability of Profit (POP): Lognormal Zone Integration
Do not use a naive delta sum ($\sum |\Delta_i|$) — an ATM straddle would report $\approx 0\%$ POP despite having real win probability.
Instead:
- The breakevens divide the spot axis into discrete intervals $(-\infty, \text{BE}_1)$, $(\text{BE}_1, \text{BE}_2)$, $\dots$, $(\text{BE}_k, \infty)$.
- Evaluate intrinsic payoff at the midpoint of each interval.
- For profitable intervals $(a, b)$, integrate the lognormal risk-neutral probability density using the cumulative normal distribution $N(d_2)$:
  $$P(S \in [a, b]) = N(d_2(a)) - N(d_2(b))$$
  where $d_2(S) = \frac{\ln(S_0 / S) + (r - 0.5 \sigma^2) t}{\sigma \sqrt{t}}$.
- Sum probabilities across all winning intervals to obtain the true POP $\%$.

### 6. Calendar & Diagonal Spreads (Mixed-Expiry Payoffs)
A single "both legs at intrinsic value at expiration" curve is not economically meaningful across two different expiration dates:
- **Evaluation Date**: Calendar/Diagonal spreads are evaluated **as of the near (front) leg's expiry** ($T_{\text{front}}$).
- **Front Leg**: Reaches its expiration, so it is evaluated at **pure intrinsic value**:
  - Front Call: $\max(0, S - K) - \text{entryPrice}$ (or inverted for short)
  - Front Put: $\max(0, K - S) - \text{entryPrice}$ (or inverted for short)
- **Far Leg**: Still carries residual time value. It is priced via **Black-76 / Black-Scholes** using remaining time $t_{\text{far}} = \max(D_{\text{far}} - D_{\text{front}}, 0.25) / 365$ and the leg's own IV:
  $$\text{Far Leg Value} = \text{BS}(S + \text{basis}, K, t_{\text{far}}, \sigma_{\text{far}})$$
- **Deriving `effectiveFarExpiry`**: Template-created baskets populate `basket.farExpiry`, but custom multi-expiry baskets (or legs manually toggled to a secondary expiry) may leave `basket.farExpiry` unset. Always derive `effectiveFarExpiry`:
  ```ts
  const effectiveFarExpiry = basket.farExpiry
    || basket.legs.find(l => l.status !== 'CLOSED' && l.expiry && l.expiry !== basket.expiry)?.expiry;
  ```
  If `hasMixedExpiry` is true, suppress the naive single-expiry `computePayoff` and use `buildPayoffModel` / `computeMultiExpiryStats`: the book is valued as of the NEAREST expiry, later legs keep their time value (`computeCalendarPayoffCurve` was deleted).
- **Return on Margin**: Calculate and surface max profit as a percentage of margin (`(calendarCurve.maxPnl / basketMargin) * 100`) so capital efficiency is clearly visible alongside single-expiry strategies.

---

## Black-76 on Futures & Sensibull Parity

### Why Indian Index F&O Prices on Futures
In Indian equity derivatives (NIFTY, BANKNIFTY, SENSEX), options price against the active **Futures contract ($F$)**, not Spot ($S$):
- Spot cannot be shorted without borrowing, dividends are lumpy, and the cash-futures basis ($F - S$, typically $+40$ to $+100$ pts for Nifty) reflects supply/demand carry far wider than synthetic carry $S e^{rt}$.
- Pricing Greeks off Spot creates an immediate $\approx 22\%$ error on ATM deltas ($0.36$ vs $0.44$).
- Sizing a delta hedge or matching broker platforms (Sensibull) requires pricing off Futures.

### Black-76 Formulation (`lib/optionsMonitorMath.ts`)
For an option on futures with strike $K$, futures price $F$, annualized ATM/leg IV $\sigma$, risk-free rate $r$, and time to expiry $t = \text{days} / 365$:
$$d_1 = \frac{\ln(F / K) + 0.5 \sigma^2 t}{\sigma \sqrt{t}}, \quad d_2 = d_1 - \sigma \sqrt{t}$$

- **Call Price**: $C = e^{-rt} [F \cdot N(d_1) - K \cdot N(d_2)]$
- **Put Price**: $P = e^{-rt} [K \cdot N(-d_2) - F \cdot N(-d_1)]$
- **Delta**:
  $$\Delta_{\text{Call}} = e^{-rt} N(d_1), \quad \Delta_{\text{Put}} = -e^{-rt} N(-d_1)$$
- **Gamma**:
  $$\Gamma = \frac{e^{-rt} n(d_1)}{F \sigma \sqrt{t}}$$
- **Theta (decay per calendar day)**:
  $$\Theta_{\text{daily}} = \frac{1}{365} \left[ -\frac{F \sigma e^{-rt} n(d_1)}{2 \sqrt{t}} + r C \right]$$
- **Vega (per 1% IV move)**:
  $$\mathcal{V}_{\text{1\%}} = 0.01 \times F e^{-rt} \sqrt{t} n(d_1)$$

*Fallback*: If the live futures price is temporarily unavailable, default to synthetic forward $F = S e^{rt}$.

### Futures Data Pipeline
1. `scripts/tools/options_data_fetch.py`: Discovers the active monthly derivative contract (`FUTIDX` / `FUTSTK`) for the underlying, resolves `future_price`, and computes `future_basis = future_price - spot`.
2. `scripts/tools/live_options_ws.py`: Resolves the future's security ID and subscribes to market feed ticks in the background.
3. `rs_dashboard/app/api/options/chain/route.ts`: Exposes `futurePrice` and `futureBasis` in the chain response.
4. `rs_dashboard/components/options-monitor/TopMetricBar.tsx`: Displays the live underlying futures contract and basis badge.

---

## Standard Deviation Bands (Expected Move)

### Sensibull Parity Formula
$$\text{Move}_{1\text{SD}} = \text{Spot} \times \sigma_{\text{ATM}} \times \sqrt{\frac{t}{365}}$$
$$\text{Move}_{2\text{SD}} = 2 \times \text{Move}_{1\text{SD}}$$

For a reference Nifty position at Spot $23,398.10$, $t = 4.0$ days, and ATM IV $13.13\%$:
- $\text{Move}_{1\text{SD}} = 23,398.10 \times 0.1313 \times \sqrt{4 / 365} = 321.7\text{ pts}$ ($1.4\%$)
- $\text{Move}_{2\text{SD}} = 643.3\text{ pts}$ ($2.7\%$)
- $\pm 1\text{SD} = [23,076.4, 23,719.8] \implies \mathbf{23,076 \text{ to } 23,720}$
- $\pm 2\text{SD} = [22,754.8, 24,041.4] \implies \mathbf{22,755 \text{ to } 24,041}$

### Key Rules for SD Bands
- **ATM IV vs India VIX**: Sensibull bases expected move on **ATM implied volatility**, not India VIX. India VIX is a 30-day index variance metric (~21.5%), while near-term weekly options may trade at 13.13%. Do not overwrite the page's IV state with live VIX on every poll.
- **Unrounded Coordinates vs Display Integers**: `optionsMonitorMath.ts` exports both `exactLo1`/`exactHi1` (exact floats for chart elements) and `lo1`/`hi1` (rounded integers for text cards).
- **Visualization**:
  - **Probability Shading**: Render `<ReferenceArea x1={exactLo1} x2={exactHi1} fill="#2d7ff9" fillOpacity={0.04} />` behind curves to clearly display the ~68.3% probability zone.
  - **Gridlines**: Render vertical `<ReferenceLine x={level} stroke="var(--chart-tick)" strokeDasharray="3 3" />` with labels `-2SD`, `-1SD`, `1SD`, `2SD`.
  - **Table**: Render a 3-column table (`SD`, `Points`, `Price`) directly matching broker terminals.

---

## Target Projections ("What-If" Analysis)

Interactive target controls allow traders to simulate future payoff outcomes before expiry:
- **Sliders**:
  - **Target Date**: $0$ (Today) to $D$ (Expiry Date).
  - **Target Time**: `09:15` to `15:40` IST (F&O close, post-SEBI-CAS — was `15:30`).
  - **Target Spot**: Interactive slider or quick-select breakevens/SD bands.
  - **Projected IV Offset**: $-50\%$ to $+50\%$ relative adjustment.
- **Target Time to Expiry ($t_{\text{target}}$)**:
  Compute elapsed trading and calendar time to the target timestamp:
  $$t_{\text{target}} = \max\left(0, \frac{\text{targetExpiryMs} - \text{targetTimestampMs}}{365 \times 86,400,000}\right)$$
- **Target Payoff Curve (`pnlTarget`)**:
  Price each leg at $t_{\text{target}}$ using Black-76 with adjusted volatility $\sigma \times (1 + \Delta\text{IV})$.
  Rendered on Recharts as a distinct dashed amber/cyan line. When $t_{\text{target}} \to 0$, it smoothly converges to the expiration payoff.

---

## Position Greeks & Multipliers

> This section covers **self-computed Black-76 Greeks** (this skill's pricing engine), used
> for target-date/what-if simulation where no live chain Greek exists yet for the projected
> scenario. For aggregating a live position book's **actual current Greeks as Dhan's chain
> already reports them** (Positions Analysis' Greeks tab and similar), see `dhan-position-greeks`
> instead — that pipeline's Greeks are already in final per-unit units and must **not** receive
> the ×100 (Gamma) / ×0.01 (Vega) scaling below a second time.

Option traders analyze Greeks both per-contract and position-wide:
- **Toggle**: Provide a clear "Multiply by Lot Size" switch.
- **Units & Conversions**:
  | Greek | Per Unit / Share | Multiplied by Lot Size (Position) |
  |---|---|---|
  | **Delta ($\Delta$)** | Rate of change per ₹1 move | Net share equivalents ($\sum \Delta_i \times \text{Qty}_i$) |
  | **Gamma ($\Gamma$)** | $\Delta$ change per ₹1 move | $\Delta$ change per **100-pt move** ($\sum \Gamma_i \times \text{Qty}_i \times 100$) |
  | **Theta ($\Theta$)** | Annualized or daily per unit | **₹ / calendar day** decay ($-\sum \Theta_i \times \text{Qty}_i$) |
  | **Vega ($\mathcal{V}$)** | ₹ per 100% vol | **₹ per 1% IV change** ($\sum \mathcal{V}_i \times \text{Qty}_i \times 0.01$) |

---

## Portfolio Greeks page: a fifth payoff surface (`components/deltaDesk/PayoffPanel.tsx`, `lib/deltaDesk.ts`)

Added 2026-10-05 and audited against this skill. `lib/deltaDesk.ts` holds only the portfolio layer (`enrichLegs()`, `payoff()`, `ladder()`, aggregation
bases); all pricing is `lib/optionsPricing.ts`, with IV solved per leg from the live premium on the futures forward. Parity is enforced by `lib/deltaDesk.test.ts` (prices/deltas vs `computeBsGreeks` with `isFutures`,
put-call parity, exact breakevens, strike sampling, net-signed-qty unlimited flags, T+0 reproducing each mark).

What it shares with the rules above: Black-76 on the futures forward; 365-day calendar; `r = 0.065`; time via
`calculateTimeToExpiryYears`; each leg priced at its **own** expiry and IV; far legs keep residual time value at the front
expiry (floored at 0.25 day); T+0 on the same x-samples as the expiry curve with every strike force-added; breakevens exact
(bisection on the model, not interpolated between samples); "unlimited" from net signed CE/PE quantity, with the drawn-window
figure shown beside it; SD band = spot × **ATM IV** × √t.

Deliberate differences: the what-if forward is `leg.forward + (s − spot)` (additive basis, per leg's own expiry);
IV is solved per leg rather than read from the chain; POP is not shown.

Design tokens not yet matched (cosmetic, not computation): zero line is `var(--color-zinc-500)` rather than `--chart-axis` 1.5;
no `ReferenceDot` breakeven markers (dashed verticals instead); T+0 is `sky-400` rather than `PAYOFF_TODAY` `#2d7ff9`.

### The payoff library and the one chart (2026-10-05) — read before touching any payoff diagram
Two files do everything; a page supplies legs and a spot and must **not** build curves, break-evens, extremes, SD bands, POP or Greeks itself:
- `lib/optionsPayoff.ts` — `buildPayoffModel({legs, spot, margin?, atmIv?, sim?, daysForward?, light?})` → expiry curve, T+0 curve, what-if curve, exact break-evens,
  max profit/loss (+ `…Unlimited` flags), ROM, POP, risk:reward, ±1σ band, net Greeks, strike pins, nearest/later expiries, `nowPnl`, `ivAssumed`;
  `payoffLadder` (scenario table); `bookGreeks` (per-leg and net Greeks, same pricing); `builderLegsToPayoffLegs` (strategy-builder leg shape).
- `components/strategy/PayoffDiagram.tsx` — the single chart (recharts; zoom, full screen, What-If days/IV sliders, strike pins, BE markers, tooltip, header stats).
  Feed it with `{...modelToDiagramProps(model)} currentSpot={spot}`; add `note`, `headerExtras` (e.g. a P&L Table button), `title=""` when the page has its own panel title.
Semantics every page now shares (each was a real divergence):
1. **T+0 is the real mark-to-market.** IV is solved from each leg's live `mark`, P&L is measured from `entryPrice`. Solving IV from the entry price (as Multi-Leg Focus did)
   forces T+0 to ₹0 at spot and hides the open P&L.
2. **The futures basis decays to zero at each leg's own expiry** (`forwardAt`). The expiry curve therefore measures intrinsic value against the index itself; carrying today's basis
   (~68 pts on Nifty) into it shifted every break-even by ~40 points (ours 21,929/23,158 vs the broker's 21,969/23,195; now within 3 and 6 points).
3. **"Expiry" = the nearest expiry among the legs**, taken from each leg's own `expiry`, never from basket metadata (a basket's `expiry`/`farExpiry` can be stale: one showed far = 29 Sep, before near = 27 Oct).
4. Unlimited risk/profit from net signed CE/PE quantity; single-expiry extremes exact (kinks); mixed-expiry extremes are the drawn window. Break-evens by bisection on the model.
5. `light: true` returns only the header numbers (no curves) — use it for collapsed rows; key the memo on the leg VALUES, not on a fresh `ltpFor` closure.
**Every payoff chart in the dashboard is now `PayoffDiagram`** (2026-10-05). Where each page stands:
| Page | Draws with | Computes curves with |
|---|---|---|
| Portfolio Greeks (`deltaDesk/PayoffPanel.tsx`) | `PayoffDiagram` | `buildPayoffModel` |
| Multi-Leg Focus (`MultiLegStrategyRow`, incl. its Greeks panel via `bookGreeks`) | `PayoffDiagram` | `buildPayoffModel` |
| Option Strats, Option Strats (Stocks), Flyagonal | `PayoffDiagram` | `buildPayoffModel` (via `builderLegsToPayoffLegs`) — they now draw T+0 too |
| Baskets (`BasketPayoffChart`) and Options Monitor (`PositionsStrategyMonitor`) | `PayoffWorkbench` → `PayoffDiagram` | `generatePayoffCurve`, now a thin adapter over `buildPayoffModel` (same signature, grid and rounding; the Sensibull-parity tests still pass) |
| Positions Analysis, Live Builder, Intraday Edge, `/options-analytics/live` (`PositionsPayoffChart`) | `PayoffDiagram` (wrapper) | `buildPayoffModel` via `lib/positionPayoff.ts` (`positionPayoff`, `withSolvedIv`, `positionNetGreeks`) |
- `components/strategy/PayoffWorkbench.tsx` is the Sensibull-style panel Baskets and the Options Monitor share: the chart plus target-price / target-date controls, futures card, SD table, strike-clearance
  card and expected-move line. Display only; the page supplies `payoffPoints`, `breakevens`, `sdLevels` and owns the target state.
- `PayoffDiagram` extras added for those pages: `draftCurve` (what-if legs, violet dashed), `oiBars` + `showOi` + `onToggleOi` (OI histogram on its own axis), `targetSpot` (marker + per-curve readout),
  `legendLabels`, `externalZoom` (the page owns the price window), `warning`, `expectedMove.sd2Lo/sd2Hi` (2σ lines). Full screen portals to `<body>` (a `backdrop-blur` ancestor traps `position: fixed`).
- **Position pages (2026-10-05):** `lib/positionPayoff.ts` is the adapter for `ResolvedLeg` / `PositionLeg` books. `positionPayoff(legs, spot, {strikeStep, spanPct, targetDays, defaultExpiry, future})` returns the curves, the `PayoffStats` the
  strips read and `missingIv`; `withSolvedIv` fills IV from each leg's live mark (chain IV only as a fallback, a leg with neither is priced at intrinsic and reported). The chain response's `future_price` / `future_expiry` are rolled to each leg's own expiry.
  **Convention change:** the at-expiry curve is valued as of the NEAREST expiry (the broker analyzer's convention), not the final one. On the live Nifty book Positions Analysis' break-evens moved from 21,882 / 23,277 to 21,972 / 23,201
  (broker 21,969 / 23,195) and max profit from ₹1,24,007 (everything settled at the final expiry) to ₹74,853 (broker ₹75,140); T+0 at spot equals the open P&L exactly. A target date past a leg's expiry still settles that leg.
- **Adapters, not engines.** `computePayoffStats`, `buildHeatmapGrid` (`optionsStrategy.ts`), `generatePayoffCurve`, `computeMultiExpiryStats`, `computeExpiryPnlAtSpot` (`optionsMonitorMath.ts`) keep their signatures but price through the library
  (`buildPayoffModel`, `payoffGrid`, `payoffAt`). The P&L-by-date grid now handles books with several expiries (the "narrow to one expiry" refusal is gone). Deleted as dead: `buildMultiExpiryCurve`, `buildTargetPayoffCurve`, `legsMissingIv`,
  `buildPayoffCurve`, `exactExpiryProfile`, `findBreakevens`, `computeCalendarPayoffCurve` and their tests (the calendar-spread semantics are covered in `lib/optionsPayoff.test.ts`).
- **Monitor legs follow the same recipe (2026-10-05).** Options Monitor and Baskets monitor legs no longer carry their own convention (they used the monthly future as EVERY leg's forward, a hardcoded 0.065, and in places Dhan's chain Greeks or spot pricing).
  Every per-leg Greek now comes from `greeksForLeg(leg, {spot, future})` in `lib/optionsPricing.ts`: forward = the monthly future rolled to THAT leg's expiry (`rollForward`), IV solved from the leg's live premium (chain IV, then an assumed IV, only as fallbacks),
  the library's rate and clock. `futureQuote(price, expiry)` guards the page's display label ("15 Sep") from reaching the clock. The Options Monitor page has one local wrapper, `modelLeg(...)`, for its twelve call sites. `generatePayoffCurve`,
  `computeMultiExpiryStats` and `computeExpiryPnlAtSpot` take the future's expiry (`FutureQuote`) and roll per leg. **Sensibull parity is retired:** the pinned T+0 figure of −260 only held with the monthly forward on every leg; the parity test now
  asserts the two surfaces agree with each other and that a just-entered strangle's T+0 P&L at spot is near zero.
- **Diagonal advisor (2026-10-05):** `lib/diagonalStrikeAdvisor.ts` `computeBsGreeks` is a thin wrapper over `computeBsGreeksExact` (spot Black-Scholes, library rate). The Python strategy and its backtest use `RISK_FREE_RATE = 0.065` and `MIN_DTE_DAYS = 0.25`;
  a test in `diagonalStrikeAdvisor.test.ts` fails if either drifts from the dashboard. Moving 7% → 6.5% shifted the backtest from +43.3% to +42.7% ROI (Jan–Sep 2026, 290 cycles).
- **Focus Tool and Covered Call (2026-10-05):** strike selection and delta rules now use the model delta too. Focus Tool: the chain is mapped to quotes in one place (`FocusTool.tsx` chain fetch) through `modelAbsDelta100` in `lib/focusToolRules.ts`
  (central recipe; Dhan's delta only when the model cannot price the strike, so a delta stop never silently falls back to SL ×); the pure rules and the Python parity fixtures are untouched. Covered Call: `chainLegGreeks` in `lib/coveredCallEngine.ts`
  drives `computeBook` (book Greeks, no longer summed from the chain), `suggestCoveredCall`, the write-call delta and the chain modal; the terminal keeps the chain response's future for the forward.
- **Python side (2026-10-05):** `lib/options_pricing.py` is a line-for-line port of `optionsPricing.ts` (the same Hart normal-CDF algorithm, so the two agree to ~1e-9). The diagonal-call, adaptive-strangle and condor-to-ratio strategies, `live_options_tracker`,
  the CSP scanner/watchlist, the options-screener collector (vectorised `implied_vols`) and the four options backtests all price through it; their private Black-Scholes/IV/normal-CDF copies are deleted. Every strategy now uses 6.5% (it was 7%, 6% or none in
  different files). `tests/test_options_pricing_parity.py` checks the port against `optionsPricing.parity.json`, which the TypeScript test generates (`UPDATE_PARITY=1 node --test lib/optionsPricing.test.ts`) and verifies on every run, so changing a formula in one language
  fails the other's test. Remaining non-library clock: the screener collector's MCX expiry close (exchange-specific data, not a formula).
- **Review follow-ups (2026-10-05):** (1) `trustedMark(last, bid, ask)` in `optionsPricing.ts`: a chain row's LAST price is only used to solve IV while it sits inside the quoted book (else the mid; a one-sided book means "use the chain IV"); applied to the Focus Tool delta,
  Covered Call and the Options Monitor chain paths. A live tick needs no check. (2) Focus Tool fills carry `ceDeltaModel`/`peDeltaModel`: a leg opened before the model delta holds Dhan's entry delta, so its delta SL/target/trail is read against Dhan's live delta
  (`legDeltaBasis`, `RowLive.ceDeltaDhan`); new fills use the model on both sides. (3) The normal CDF is Hart's double-precision algorithm in both languages (|error| < 3e-16, exactly 0.5 at 0). (4) `detect_phantom_leg(_broker)` take `dry_run` and every strategy passes
  `self.dry_run`: a paper book is not at the broker, so the check used to wipe every paper leg on the first tick. (5) `backtest_short_straddle.py --rate 0.06` reproduces the pre-library validated runs (to ~Rs 0.1 on Rs 103k).
- **Left alone on purpose:** `computePayoff` in `basketStrategies.ts` (pure intrinsic payoff, no pricing, used for Baskets stats and thumbnails). Nothing else computes or sums a Greek outside `lib/optionsPricing.ts`; Dhan's chain Greeks remain only as per-strike display values
  (option-chain tables, Skew, SmartChain) and as the last-resort delta fallback above.

### The pricing library: `lib/optionsPricing.ts` — the ONE place option maths lives (2026-10-05)
Every page prices options and computes Greeks through this file, so a number can only be wrong in one place. Do not write a private
Black-Scholes, normal CDF, IV solver, expiry clock or Greek in a component, hook, API route or scanner — import from here.

| Need | Call |
|---|---|
| Price + all Greeks, unrounded (anything multiplied by qty, summed across legs, or used in a curve) | `computeBsGreeksExact(type, S_or_F, K, T, iv, r?, isFutures?)` → price, delta, gamma, theta, vega, rho, vanna, vomma, charm |
| One display cell (₹0.05 tick price, 2 dp / 4 dp) | `computeBsGreeks(...)` (the rounded view of the same numbers; never sum it) |
| Price only, unclamped (curves, IV solving) | `priceOption(...)`; spot shortcut `bsPrice(...)` |
| IV from a premium | `impliedVol(type, U, K, T, price, { isFutures })` (null if below the no-arbitrage floor or above 500% vol); spot shortcut `impliedVolFromPrice` |
| "Solve IV from the mark, then Greeks at that IV" | `greeksFromMark({type, strike, expiry, mark, underlying, isFutures, fallbackIv?})` → Greeks + `iv` + `ivSource: 'mark' \| 'fallback'` |
| Time to expiry | `calculateTimeToExpiryYears(expiry, now?)` (15:40 IST, /365, 0.25-day floor); `expiryEpochMs(expiry)` for a clock label |
| Forward / spot | `rollForward(F, fromExpiry, toExpiry)`, `spotFromFutures(F, futExpiry)` (an estimate: flag it on screen) |
| P(finish above K) | `riskNeutralProbAbove(S, K, t, iv)` |
| Constants | `RISK_FREE_RATE` (6.5%), `CALENDAR_DAYS_PER_YEAR` (365), `FNO_CLOSE_UTC` |

Units: delta per unit; gamma per index point; theta ₹/calendar day; vega ₹ per 1% IV; rho ₹ per 1% rate; vanna Δdelta per 1% IV; vomma Δvega
per 1% IV; charm Δdelta per day. IV is always a fraction. Model: Black-76 when `isFutures`, else Black-Scholes on spot (the documented fallback
when no futures price is wired in).

`optionsMonitorMath.ts` and `optionsStrategy.ts` re-export `computeBsGreeks`, `computeBsGreeksExact`, `calculateTimeToExpiryYears`, `OptType`,
`bsPrice`, `riskNeutralProbAbove` and `impliedVolFromPrice`, so old import paths still resolve to the same single implementation. Who calls
what: Options Monitor, Baskets, Multi-Leg Focus (strategy-row curves and net Greeks, Position Map, calendar far leg), Portfolio Greeks
(`lib/deltaDesk.ts` `enrichLegs()`/`b76()`), the Ultimate Scanner (delta and POP) and `BasketPayoffChart` (expiry clock) all go through it.

**Adding or changing a Greek/formula:** edit `blackCore` in `optionsPricing.ts` and add a case to `lib/optionsPricing.test.ts`. That file differences
the price itself (delta, gamma, vega, theta, rho, vanna, vomma, charm; futures and spot; Nifty-like and "unit" cases) and pins results to 20 fixed values
from `py_vollib` 1.0.12 + `blackscholes` 0.2.2. It fails on the old buggy formulas (20 of 32 finite-difference cases). Do not edit expected values to make
a test pass. The rate, 365-day year, 15:40 close and "futures as the forward" are choices no reference can prove.

**Deliberately NOT on the library (do not "fix" these in passing):**
- `buildHeatmapGrid` columns are whole calendar days from a chosen date (`daysBetweenDates`); only the PRICING is the library's (`payoffGrid`), not a new intraday clock per column.
- `computePayoff` in `basketStrategies.ts`: pure intrinsic payoff, no pricing, so it cannot disagree with a Greek.
- The screener collector's MCX expiry-close time (exchange hours, not a formula).
- Dhan's chain Greeks as PER-STRIKE DISPLAY values (option-chain tables, Skew, SmartChain) and the Focus Tool's last-resort delta fallback.
Everything else, in either language, prices through `lib/optionsPricing.ts` / `lib/options_pricing.py`.

### `computeBsGreeks`: four Greeks corrected 2026-10-05, guarded by finite-difference tests
Decision (see the vault note on following Sensibull vs correctness): formulas and units are verified against the price itself,
never against a vendor; vendor differences are conventions to document, not numbers to copy.
- **Theta, futures branch:** the carry term was subtracted. Correct: `(−Fσe^{−rt}n(d1)/(2√t) + rC)/365` (call), `+rP` (put). Old error
  0.5–1.2% near the money, 6.6% (90-day ATM put) to ~44–60% (180-day deep ITM). Confirmed by finite difference, the `blackscholes`
  package's published Black-76 theta, and this skill's formula.
- **Theta, spot branch:** the volatility term was multiplied by `e^{−rt}`; plain Black-Scholes has none.
- **Gamma and vega, spot branch:** same stray `e^{−rt}` (`φ(d1)/(Sσ√t)` and `Sφ(d1)√t` are undiscounted). Black-76 keeps it.
- **Delta, futures branch:** now `e^{−rt}N(d1)` (call) and `−e^{−rt}N(−d1)` (put), the true derivative with respect to the futures price
  and the one that sizes a futures hedge. Vendors that print the undiscounted forward delta `N(d1)` read ~0.4% higher at 22 days; that is a
  convention difference, not an error on either side.
- **Guard:** `lib/optionsPricing.test.ts` ("Greeks match finite differences of its own price") differences an unrounded
  high-precision reference price for delta, gamma, vega and theta, for futures and spot, over ten cases including long-dated, deep-ITM,
  and "unit" cases (underlying 100, 0.5–1y) chosen so the old 3–6% discount errors exceed the output's 2 dp / 4 dp rounding. Against the old
  code 20 of the 32 cases fail. Add a case there for any new Greek rather than asserting a number.
- **External reference:** the same file also holds 20 fixed library values ("vs independent library reference values"), produced by
  `py_vollib` 1.0.12 and `blackscholes` 0.2.2 (which agree with each other to 1e-6) at r = 0.065, so the formulas are pinned to something outside the
  repo. Theta is per calendar day (library per-year ÷ 365), vega per 1% (library per 1.00 × 0.01). Tolerance is half the output's rounding step.
  Regenerate by rerunning both libraries on the inputs listed there; do not edit expected values to make a failing test pass.
  Not covered by any reference: the *inputs* (6.5% rate, 365-day year, 15:40 IST close, futures as forward, IV solved from the premium) are choices.

---

## The Rendering Layer

### Hand-Rolled SVG Family (`BasketPayoffChart.tsx`, `PayoffDiagram.tsx`, etc.)
- **Dynamic `useId()` Scoped `clipPath` IDs (Crucial Bug Prevention)**:
  - Carves the plot at $y=0$ (`zeroY`) into green (profit) and red (loss) halves.
  - **Never use static DOM IDs** (like `id="sb-clip-profit"`). When multiple strategy rows render on the same page (e.g. `/multi-leg-focus`), SVGs resolve `url(#sb-clip-profit)` to the *first* matching element in the DOM tree. If Row 0 has `zeroY = 120` and Row 1 has `zeroY = 220`, Row 1 will clip at Row 0's coordinates, producing an inverted red wash across profitable territory!
  - **Always scope via React `useId()`**:
    ```tsx
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const profitClipId = `sb-clip-profit-${uid}`;
    const lossClipId = `sb-clip-loss-${uid}`;
    ```
- **Viewport Boundary Interpolation & Zero-Span Guards**:
  - Zooming in narrows the visible domain $[x_{\text{Lo}}, x_{\text{Hi}}]$. Always clamp $x_{\text{Lo}}, x_{\text{Hi}}$ to the computed curve bounds (`[curve[0].spot, curve[curve.length - 1].spot]`) so points are never extrapolated into flat tails.
  - Guard against zero/sub-epsilon domain span before dividing: `if (xHi - xLo < 1e-4) return null;`.
  - Filter interior points with an epsilon to avoid duplicating edge samples: `curve.filter(c => c.spot > xLo + 1e-4 && c.spot < xHi - 1e-4)`.
- **Y-Domain Scaling for Undefined Risk (1.8× Max Profit Clamp)**:
  - For undefined-risk trades (short straddles, naked sales), negative P&L can extend to $-₹100,000+$. If clamped to $3.0\times$ Max Profit, the profit peak is squished into the top 20-25% of the chart height.
  - Clamping undefined loss to **$1.8\times$ Max Profit** (`clampedYMin = Math.max(rawYMin, -rawYMax * 1.8)`) gives the profit zone and near-zero plateaus $\approx 45\%$ of the vertical height, ensuring peak kinks and flat zones remain prominent.
  - Always bound with `Math.min(0, clampedYMin)` and `Math.max(0, clampedYMax)` with minimum padding (`|| 1`) so the zero line is never cropped out.
- **Strike Pins & Axis Clearance**:
  - Pin active leg strikes directly on the X-axis with colored badges (`#38bdf8` for BUY, `#fb7185` for SELL).
  - Increase `PAD.bottom` to at least 38px to maintain an 18-20px vertical clearance between strike badges (`y = H - PAD.bottom - 16`) and spot tick numbers (`y = H - PAD.bottom + 17`), preventing badge collisions.
- **Callback Ref for ResizeObserver**: Do not use `useRef` + `useEffect([])` because early-return loading states cause the mount effect to miss the element.
- **Chrome Theming**: Always call `useChartChrome()` from `lib/chartTheme.ts` for axis, gridlines, and tooltip chrome. Never hardcode dark hexes.
- **Full-Screen Viewport Portaling (`createPortal(chart, document.body)`)**:
  - A card ancestor with `backdrop-blur` (or any `filter`/`backdrop-filter`) creates a CSS containing block for `position: fixed` descendants — without portaling to `<body>`, a "fullscreen" overlay gets trapped inside the card's own box instead of covering the viewport.
  - Portaling to `document.body` with `fixed inset-0 z-50 overflow-y-auto bg-zinc-950 p-4 md:p-6` escapes all parent stacking contexts and filters.
  - All dashboard payoff diagrams implement full screen:
    - **Options Monitor** (`PositionsStrategyMonitor.tsx`): Fullscreen terminal with expanded chart (`h-[52vh] min-h-[380px]`), target spot/date sliders, futures basis card, and SD table.
    - **Strategy Builder / Multi-Leg Focus** (`PayoffDiagram.tsx`): Fullscreen overlay with header, spot pill, breakevens, What-If simulation bar, Net Greeks strip, and responsive SVG height.
    - **Baskets** (`BasketPayoffChart.tsx`): Fullscreen overlay with responsive SVG width and height (`H_ = 540`).
    - **Positions Analytics** (`PositionsPayoffChart.tsx`): Fullscreen overlay with OI bars and responsive height.
  - **Escape Key & Body Scroll Lock**: Always attach a `keydown` listener for `'Escape'` and lock `document.body.style.overflow = 'hidden'` while fullscreen is active.

### Recharts Terminal (`PositionsStrategyMonitor.tsx`)
- **XAxis Must Be `type="number"`**:
  `<XAxis dataKey="spot" type="number" domain={[minSpot, maxSpot]} />`. A category axis spaces points equally regardless of strike differences, causing straight lines to bend into wobbly curves and silently dropping off-grid reference lines.
- **Ticks**: Compute round-number ticks (`niceTicks`) at 100, 200, or 500 intervals.
- **Palette**:
  - `PAYOFF_EXPIRY` `#e0533d` (sharp red line at expiry)
  - `PAYOFF_TODAY` `#2d7ff9` (smooth blue Black-76 curve today)
  - `PAYOFF_TARGET` `#f59e0b` (dashed amber projected curve)
- **Token Resolution in Recharts**: Recharts resolves CSS variables in `stroke="var(--chart-tick)"` and `fill="var(--chart-grid)"` natively.
- **Custom ReferenceLine Labels**: Use custom SVG rendering functions for callout boxes (Current Spot pill, Target P&L badge) with `<rect>` background to prevent collision with tick labels.

### Zero P&L Line & Breakeven Markers — Uniform Across Every Payoff Diagram (2026-09)
The $y=0$ line and its breakeven crossings are load-bearing reference points, not decoration —
a zero line rendered in the same faint tone as the gridlines (`var(--chart-grid)`) reads as just
another gridline and disappears against the curves. All four payoff-diagram surfaces
(`PositionsStrategyMonitor.tsx`, `BasketPayoffChart.tsx`, `PositionsPayoffChart.tsx`,
`PayoffDiagram.tsx`) now render both consistently:
- **Zero line color**: `var(--chart-axis)`, never `var(--chart-grid)` (too faint — the original
  bug report) or `var(--chart-tick)` (over-corrected too dark on a follow-up report). `--chart-axis`
  is the deliberate middle tone already used for the X/Y axis lines themselves, so the zero line
  reads as "another axis," not a gridline or bold annotation.
- **Zero line width**: `1.5` in the Recharts family (`PositionsStrategyMonitor.tsx`,
  `BasketPayoffChart.tsx` — `<ReferenceLine y={0} stroke="var(--chart-axis)" strokeWidth={1.5} />`),
  `1.25` in the hand-rolled SVG family (`PositionsPayoffChart.tsx`, `PayoffDiagram.tsx` — same
  token, drawn as a plain `<line>` at `zeroY`). The two families don't need pixel-identical
  widths; they need the same *token* and the same "visibly heavier than the gridlines" weight.
- **Breakeven markers**: a small circle (`r={4}`) sitting on the zero line at each breakeven's
  x-coordinate, on top of the curve it belongs to:
  - Recharts family: `<ReferenceDot x={breakeven} y={0} r={4} fill="var(--color-zinc-900)" stroke={PAYOFF_EXPIRY} strokeWidth={2} isFront />` — a hollow ring in the expiry-curve's red, punched through by the panel background color so it doesn't add a new fill color to the palette. Import `ReferenceDot` from `recharts` alongside the other reference primitives.
  - Hand-rolled SVG family: solid amber circle (`fill="#f59e0b"`, `stroke` matched to the panel's near-black background, `strokeWidth={2}`) with a small numeric label above it — this family already had breakeven markers before the 2026-09 pass, so the Recharts family's `ReferenceDot` styling was matched to fit next to it, not the other way around.
  - Filter to the visible domain before mapping (`breakevens.filter(b => b > lo && b < hi)`) —
    rendering a dot outside the current spot/zoom window throws off Recharts' auto-layout.
- **`BasketPayoffChart.tsx` was the outlier** until this pass: it had the `breakevens` array
  (used only for the strike-clearance width text) but never rendered it on the curve, and its
  zero line was still on the pre-2026-09 `var(--chart-grid)` treatment. `PositionsPayoffChart.tsx`
  and `PayoffDiagram.tsx` were already correct — they're the reference for the hand-rolled family.
- If you add a fifth payoff-diagram surface, copy the token/width/marker pattern from whichever
  family it renders with (Recharts vs hand-rolled SVG) rather than re-deriving colors — a payoff
  chart that reintroduces `var(--chart-grid)` for the zero line is a regression to catch in review.

---

## Every Payoff Diagram Must Plot the T+0 (Today) Curve

A payoff diagram that shows only the at-expiry line is answering the wrong question for anyone
holding a live, unexpired position — it tells you what you'd get if you did nothing until
expiry, not what your position is worth *right now*. Every payoff diagram in this dashboard —
hand-rolled SVG or Recharts, strategy-builder or live-position terminal — must draw both:

- **At Expiry** (green/red, sign-split): intrinsic value only, computed as in section 1-4 above.
- **Today (T+0)** (a single continuous blue line, `#2d7ff9` — `PAYOFF_TODAY` in
  `lib/optionsMonitorMath.ts`, matched by `TODAY_COLOR` in `PayoffDiagram.tsx`): each leg's
  live mark-to-market value via `computeBsGreeks(...)` at the current spot, that leg's own IV,
  and its remaining time-to-expiry (`calculateTimeToExpiryYears`) — **never** sign-split into a
  green/red clip path, since T+0 P&L doesn't have the expiry curve's all-or-nothing intrinsic
  shape (it's usually a smooth arch/cushion sitting *above* a net-short position's expiry line,
  or below a net-long one's, converging onto it far from spot and at $t \to 0$).

**This was missed once already** (2026-09): the Multi-Leg Focus strategy payoff diagram shipped
with the at-expiry curve only. A screenshot review caught it — "i dont see the blue line (T+0)
line in the payoff. this should always be plotted in a payoff diagram." The fix
(`MultiLegStrategyRow.tsx`'s `todayCurve` useMemo) is the reference pattern for wiring T+0 into
any hand-rolled-SVG payoff surface:

1. Build the T+0 curve on the **same x-samples as the expiry curve** (map over
   `payoffResult.points.map(p => p.x)`, or the calendar/whatever curve is active) — never let it
   pick its own domain, or the two lines silently drift onto different x-grids.
2. Price each leg at every sampled spot with `computeBsGreeks(option, spotOrFuture, strike,
   timeYears, iv, lotSize, r, isFutures)`. Use each leg's **own** expiry and IV, not the basket's
   front expiry — a calendar/diagonal far leg still carries its own residual time value in the
   T+0 curve even though the expiry curve only goes out to the front leg's expiry.
3. **No live futures price wired to this surface yet?** Pass `isFutures: false` with `F = spot`
   — `computeBsGreeks`'s non-futures branch already applies the `r·t` drift term, which *is* the
   documented synthetic-forward fallback ($F = Se^{rt}$) from the Black-76 section above, not a
   separate approximation to invent. Don't skip the T+0 curve just because a real futures price
   isn't plumbed to this component — the fallback is still meaningfully more useful than no T+0
   curve at all.
4. Missing/zero premium or IV on any leg → return `null`/`undefined` for the whole T+0 curve
   rather than drawing a partially-wrong line. `PayoffDiagram.tsx` treats an absent `todayCurve`
   as "nothing to show yet," not an error — it must never be forced to render a curve built from
   placeholder zeros.
5. Fold the T+0 curve's own P&L range into the chart's Y-domain calculation (it usually needs
   less room than the expiry curve, but never assume that — it can exceed it far OTM at high IV).
6. Show a legend distinguishing the two lines, and — if the chart already has a hover
   readout/tooltip for the expiry curve — extend it to show both values at once rather than
   adding a second disconnected tooltip.

**Fixed 2026-10-05:** every payoff surface now draws through `PayoffDiagram`, and the builder pages draw T+0 (see "The payoff library and the one chart" above). The Positions Analysis family still computes
its own curves; they do plot T+0 (the target-date curve). Wiring T+0 into any of them is a straightforward application of the pattern above — do
it opportunistically when next touching one of those files, and update this list when you do.

---

## Verification & Testing

### 1. Automated Math Test Suite
Run the test suite directly with Node:
```bash
node --test rs_dashboard/lib/optionsPricing.test.ts rs_dashboard/lib/optionsMonitorMath.test.ts
```
The suite verifies:
1. Black-76 pricing vs Black-Scholes.
2. Put-Call parity under futures pricing.
3. Exact delta matching ($0.44$ on 23500 CE, $-0.27$ on 23300 PE).
4. Exact Standard Deviation bounds ($23,076 / 23,720$).
5. Expiry payoff convergence at $t=0$.

### 2. Browser Verification Caveat
Playwright `fullPage: true` captures cause Recharts `ResponsiveContainer` to collapse to 0 height. Always screenshot the viewport or specific container element rather than fullPage.

---

## Common Mistakes Checklist
- **Pricing off spot instead of futures**: Results in ~22% delta error on Indian index options. Always check `isFutures: true`.
- **Using India VIX for weekly SD bands**: VIX is 30-day annualized; weekly expected move must use ATM IV.
- **Leaving Recharts XAxis as `type="category"`**: Wobbly curves and vanishing reference lines. Must use `type="number"`.
- **Hardcoding 252 trading days**: Annualization for options in Indian exchanges uses 365 calendar days.
- **Scaling by lot size per leg**: Double-counts lots in mixed-lot books. Scale once at the aggregate book level.
- **Inferring unlimited risk from curve tails**: Always inspect net signed call/put quantities.
- **Shipping a payoff diagram with only the at-expiry line**: every payoff diagram must also plot
  the T+0 curve — see "Every Payoff Diagram Must Plot the T+0 (Today) Curve" above. This is easy
  to miss because the expiry curve alone still looks like a complete, correct chart.

---

## One Canonical Time-to-Expiry Source (Cross-Page Parity)

`Baskets.tsx`/`BasketPayoffChart.tsx`, `app/options-monitor/page.tsx`/`PositionsStrategyMonitor.tsx`,
and `PositionsAnalysis`/`StraddleAnalysis`/`StrangleAnalysis` are all separate React trees that must
render **an identical payoff curve for identical legs** — that's the whole point of "Sensibull parity."
They can only stay in parity if every one of them computes remaining time the same way.

- **Always compute real time-to-expiry via `calculateTimeToExpiryYears(expiryDateStr)`** from
  `lib/optionsMonitorMath.ts`. It accounts for the exact 15:40 IST F&O expiry cutoff (SEBI's
  Close Auction Session moved this from 15:30 — `BasketPayoffChart.tsx`'s `formatTargetDateDisplay`
  carries the same constant and must be kept in sync by hand if this one ever changes again)
  and the current time of day, and floors at a small positive value (never zero) so Black-76
  doesn't divide by zero. Do not reimplement a second "days to expiry" helper (calendar-day granularity, no
  time-of-day awareness) for anything that feeds a payoff curve, SD band, or Greek — that
  divergence is exactly what caused Baskets' payoff diagram to stop matching Options Monitor's
  (2026-09 regression: `BasketPayoffChart` used `lib/basketStrategies.ts`'s `daysToExpiry`,
  calendar-day granularity with no intraday precision, while `PositionsStrategyMonitor` used a
  dead `initialDays` prop that was never wired to the real expiry at all — two different wrong
  answers that happened to look right only in the one reference scenario both were tested
  against). `daysToExpiry` (calendar-day integer, 0 on expiry day) remains fine for a plain "N
  DAYS" text stat — just never feed it into pricing math.
- **The target-date slider's max must be the real remaining time, never a fixed weekly-expiry
  constant.** All three target-date sliders in this codebase (`BasketPayoffChart`,
  `PositionsStrategyMonitor`, and `app/options-monitor/page.tsx`'s own `effectiveTimeToExpiryYears`)
  follow this shape — copy it exactly for a new one:
  ```ts
  const maxDays = Math.max(0.05, calculateTimeToExpiryYears(currentExpiry) * 365);
  const effectiveTargetDays = Math.min(targetDays ?? maxDays, maxDays);
  ```
  A same-day or next-day expiry (very common here — NIFTY has frequent short-dated weekly
  expiries) must cap the slider at its own remaining hours. Flooring `maxDays` at a constant like
  `4.0` lets the user (or the untouched-slider default) simulate "4 days of time value" on a
  contract that expires in an hour — badly overstating both the T+0 Black-76 curve and the SD
  band width, in the wrong direction from what "Sensibull parity" is trying to achieve.
- When adding a **fourth** payoff surface (e.g. wiring this into `PositionsAnalysis`), reuse this
  exact `maxDays`/`effectiveTargetDays` pattern and reuse `calculateTimeToExpiryYears` rather than
  writing a new time helper — that is the only way a fourth page stays in parity with the other
  three without a dedicated cross-page test.

---

## Never Leak Sensibull Reference-Fixture Values Into Production Fallbacks

The math test suite (`lib/basketStrategies.test.ts`, `lib/optionsMonitorMath.test.ts`) pins exact
numbers from one reference screenshot to prove parity: spot `23398.10`, futures `23463.60`
(basis `+65.50`), ATM IV `13.13%`, a 4.0-day-to-expiry Short Strangle (`23500 CE @ 61.20`,
`23300 PE @ 55.65`, IVs `9.5%`/`11.0%`). These are correct as **test fixtures** and as
documentation of what parity looks like — see the SD-band example above.

They are a bug the moment they appear as a live-data fallback, an initial `useState`, or a
strike/IV special-case (`if (leg.strike === 23500) ...`) in a component that real users load:
- A component that falls back to a fixed spot/futures-basis when a live quote or chain fetch is
  slow/unavailable must fall back to the underlying's **generic** configured default (e.g.
  `UNDERLYINGS[underlying].defaultSpot` in `optionsMonitorMath.ts`), never a NIFTY-only magic
  number lifted from the reference screenshot — every other underlying already falls back
  generically, so a NIFTY-only special case is also an inconsistency smell on its own.
  (Fixed 2026-09 in `Baskets.tsx`'s `spot`/`effectiveFutureBasis` fallbacks.)
- A strike/IV override keyed on the literal reference strikes (`23500`/`23300`) will silently
  return the wrong premium/IV for every other strike, and will keep returning stale 2026-09
  numbers for those two strikes forever, even once real chain data is flowing.
  (Fixed 2026-09 in `Baskets.tsx`'s `autoPremium`/`effectivePremium`/`applyTemplate`/`monitorLegs`.)
- `app/options-monitor/page.tsx` still initializes `spot`, `prevClose`, `futurePrice`,
  `futureBasis`, `futureExpiry`, `targetSpot`, and `ivPct` to these exact reference values as
  `useState` defaults. That's lower-risk than a fallback branch that can be *re-entered* after
  live data loads (these are simply overwritten once the chain/WS fetch resolves), but it's the
  same anti-pattern and worth cleaning up if you're touching that state block again — don't copy
  this pattern into a new page.
- **The default `activeLegs` array was the one instance of this that was load-bearing, not just
  cosmetic** (fixed 2026-09): it seeded the literal reference strangle (`23500 CE @ 61.20` /
  `23300 PE @ 55.65`) as the page's starting position. A separate effect exists purely to replace
  that with a real ATM±2-strike strangle built from the live chain (the exact same live
  WS-tick → chain `last_price` → chain IV → Black-76 Greeks lookup that `handleUpdateLegStrike`
  already uses for any manual strike change) — but it's guarded by
  `if (activeLegs.length > 0) return`, so with a non-empty seed it silently no-ops on every fresh
  load. The page would show the frozen demo position (and its frozen premiums going into the
  payoff curve, Greeks, and margin estimate) indefinitely, looking perfectly plausible, until a
  user manually touched a leg's strike and the live lookup ran for the first time — which is also
  why "the math is right, I can prove it by changing the strike" and "the position on load is
  hardcoded" were both true at once and looked contradictory. The fix was `useState<OptionLegModel[]>([])`
  so the guard's "no legs yet" branch is genuinely reachable. If a future page follows this same
  "seed a demo position, then an effect replaces it once real data arrives" shape, initialize the
  seeded state to empty/null and let the effect's own now-legitimately-reachable branch build the
  first real value — never pre-fill it with the reference fixture's answer.
- **`Baskets.tsx` had the quieter version of the same bug shape** (fixed 2026-09, same session):
  its default `legs` state was a literal 23300 PE / 23500 CE pair — not values keyed to a
  reference screenshot, just the ATM±2 strikes that happened to be correct for spot ≈ 23400 at
  the time the file was last edited, with no effect ever refreshing them once the real chain
  loaded (unlike Options Monitor's frozen demo, Baskets had no equivalent "build a real position
  on load" effect at all — the strike-template `applyTemplate` only ran on an explicit template
  click). Correct *today*, but silently stale the moment spot drifts away from that level,
  exactly like a hardcoded fallback would be. The fix mirrors Options Monitor's: seed `legs` as
  `[]`, and add a one-shot effect (`hasInitializedLegsRef`, same guard shape as
  `hasInitializedPresetRef`) that calls `applyTemplate` for the default Short Strangle once
  `atmStrike` is real. Do not call `applyTemplate` before `atmStrike` is real just to avoid the
  extra effect — `applyTemplate`'s own `atmStrike ?? 23400` fallback exists only to keep a
  *manual* button click from erroring before data loads, not to be a legitimate seed for the
  page's starting position.
- **When copying a working payoff feature from one page to another** (as `Baskets.tsx` did from
  `PositionsStrategyMonitor.tsx`), do a literal `grep` for the reference numbers
  (`23500`, `23300`, `23398`, `23463`, `65.50`, `61.20`, `55.65`, `13.13`, `0.095`, `0.110`) in the
  new file before shipping — anything still hard-coded outside a comment or a `defaultSpot`-style
  named underlying config is a leftover fixture value, not a real default.

---

## Verify an Edit Actually Replaced the Old Code, Not Just `git diff`

While fixing the fixture-leak issue above, four separate spots in `Baskets.tsx` turned out to have
the **old** Sensibull-hardcoded body and the **new** generic-replacement body concatenated back to
back (duplicate `const`/`let` declarations, dead code after an early `return`, a duplicated object
key) — a bad find-and-replace that appended instead of substituting. `git diff`'s default 3-line
context rendered this as a clean-looking removal (matching unrelated identical lines above/below as
the "old" side), so the diff was misleading; `tsc --noEmit` caught it immediately (duplicate
declaration / unreachable code errors), and reading the full function body end-to-end caught the
rest (the dead-but-syntactically-valid duplicate `return` and object key, which `tsc` does not
flag as an error).
- After any edit that claims to "replace" or "remove" hardcoded logic in this feature, run
  `npx tsc --noEmit` (from `rs_dashboard/`) before trusting the diff summary.
- Re-read the whole touched function (not just the diff hunk) when the change was described as a
  replacement — a duplicate `return`/object key is syntactically valid and silently keeps the old
  behavior while `git diff` and `tsc` both stay quiet.

---

## P&L-by-Date Grid (`buildHeatmapGrid`) — Time Clock, Solved IV, Closed Legs

*Added 2026-10-04 (commits `09d3c96`, `de7d10d`).* The spot × date P&L table is one function,
`buildHeatmapGrid` in `lib/optionsStrategy.ts`, rendered by `components/analytics/PnlTableTab.tsx`. It is
shared by Option Strats, Option Strats Stock, Positions Analysis and Multi-Leg Focus's `PnlTableModal`, so a
fix to one is a fix to all — and a regression shows up on all.

- **Price time from the real expiry clock, not whole days.** Leg IVs are solved against the real time left
  to the 15:40 IST expiry (`Date.UTC(y, m-1, d, 10, 10)`). The grid must use that same clock
  (`liveDays`) or column 0 ("today") will not reproduce the live P&L — the old `daysToExpiry/365` overstated
  short-premium profit on short-dated books and, on expiry day, wiped out all remaining time value. Column 0 is
  *now*, each later column is the same clock time on a later date, and only the last column settles
  intrinsically (`t = 0`). Mirrors `calculateTimeToExpiryYears`.
- **Expiry day has one date but two moments.** `dates` gets a duplicate of today and `labels = ['Now',
  'Expiry']` overrides the header (`grid.labels?.[i] ?? fmtExpiryShort(d)`). Never key the `<th>`/cells on the
  date string — it repeats; key on the index.
- **`fixedPnl` is a spot- and date-independent constant added to every cell** — the realised P&L of legs already
  closed. Without it a strategy that booked a leg shows a table that disagrees with the header P&L.
  Multi-Leg Focus passes the closed legs' booked P&L; do not also fold closed legs into `legs`.
- **Solve IV from the live premium; chain IV is the fallback only.** `PnlTableModal` and the Position Map
  Greeks invert the grid's own Black-Scholes against the live leg price. Dhan's chain IV mis-prices the grid
  (calls read low, puts high), so a table built on chain IV disagrees with the live P&L before any spot move.
  Use the model's `ivAssumedIdx` / `positionPayoff(...).missingIv` to find legs that still need a fallback (`legsMissingIv()` was deleted), and **refuse to build the grid without a live
  spot** rather than defaulting one.
- **Position Map pricing** (`components/multiLegFocus/PositionVisualizer*.tsx`, page
  `/multi-leg-focus/visualization`): leg prices come from live ticks, then the REST option chain — **never the
  entry price**. An unpriced leg renders `-`, not a fake 0 or a flat P&L. The combined view is per-expiry.
  `crudeQtyMultiplier()` (CRUDEOIL ×100, CRUDEOILM ×10, else 1) is the single source for ledger-qty → P&L
  scaling; do not re-derive it per component.
- **Checks after touching the grid:** (1) the first column at the live spot equals the live P&L within
  rounding; (2) on expiry day the `Expiry` column equals intrinsic payoff; (3) a book with a closed leg shows
  the same total as the header; (4) the `large` prop (wide `FocusModal`) still scrolls at `90vh-14rem`.
