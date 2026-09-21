---
name: dhan-payoff-diagrams
description: Use when building or extending an options payoff/P&L diagram — computing the curve (per-leg payoff, breakevens, max profit/loss, POP, SD expected-move bands, pre-expiry Black-76 on futures / Black-Scholes pricing, target sliders) or rendering it (the hand-rolled SVG chart family in BasketPayoffChart.tsx, PositionsPayoffChart.tsx, PayoffDiagram.tsx, StrategyBuilder, Baskets, PositionsAnalysis; or the recharts-based Options Monitor at app/options-monitor and lib/optionsMonitorMath.ts). Not for the draft-leg staging UI or margin/ROI stats strip around a payoff chart — that's dhan-options-analytics-page.
---

# Options Payoff Diagrams

## Overview
Payoff diagrams in this dashboard split into two distinct rendering architectures backed by specialized math modules:

1. **The Hand-Rolled SVG Family** (`lib/optionsStrategy.ts` + `components/BasketPayoffChart.tsx`, `components/analytics/PositionsPayoffChart.tsx`, `components/strategy/PayoffDiagram.tsx`):
   - Designed for strategy builders and static/draft position books.
   - Pure SVG drawing with two `clipPath`s split at $y=0$ to stroke/fill positive P&L in green and negative P&L in red.
   - `BasketPayoffChart.tsx` is the canonical reference implementation that correctly consumes `useChartChrome()`.

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
- **Not for**: Draft-leg staging UI, margin requirements, or historical payoff backtests — see `dhan-options-analytics-page`.

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
`exactExpiryProfile(legs, lotSize)` evaluates the payoff at every strike, at spot 0, and along the straight tail beyond the highest strike, so results do not depend on the sampled range:
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
  - **Target Time**: `09:15` to `15:30` IST.
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

## The Rendering Layer

### Hand-Rolled SVG Family (`BasketPayoffChart.tsx`, etc.)
- **Two `clipPath`s at `zeroY`**: Carves the plot at $y=0$. The curve path is rendered twice: once inside `profitClip` (green) and once inside `lossClip` (red).
- **Callback Ref for ResizeObserver**: Do not use `useRef` + `useEffect([])` because early-return loading states cause the mount effect to miss the element.
- **Chrome Theming**: Always call `useChartChrome()` from `lib/chartTheme.ts` for axis, gridlines, and tooltip chrome. Never hardcode dark hexes.
- **Full-Screen Viewport Portaling (`createPortal(chart, document.body)`)**:
  - A card ancestor with `backdrop-blur` (or any `filter`/`backdrop-filter`) creates a CSS containing block for `position: fixed` descendants — without portaling to `<body>`, a "fullscreen" overlay gets trapped inside the card's own box instead of covering the viewport.
  - Portaling to `document.body` with `fixed inset-0 z-50 overflow-y-auto bg-zinc-950 p-4 md:p-6` escapes all parent stacking contexts and filters.
  - All dashboard payoff diagrams implement full screen:
    - **Options Monitor** (`PositionsStrategyMonitor.tsx`): Fullscreen terminal with expanded chart (`h-[52vh] min-h-[380px]`), target spot/date sliders, futures basis card, and SD table.
    - **Strategy Builder** (`PayoffDiagram.tsx`): Fullscreen overlay with header, spot pill, breakevens, and responsive SVG height.
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

---

## Verification & Testing

### 1. Automated Math Test Suite
Run the test suite directly with Node:
```bash
node --test rs_dashboard/lib/optionsMonitorMath.test.ts
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

---

## One Canonical Time-to-Expiry Source (Cross-Page Parity)

`Baskets.tsx`/`BasketPayoffChart.tsx`, `app/options-monitor/page.tsx`/`PositionsStrategyMonitor.tsx`,
and `PositionsAnalysis`/`StraddleAnalysis`/`StrangleAnalysis` are all separate React trees that must
render **an identical payoff curve for identical legs** — that's the whole point of "Sensibull parity."
They can only stay in parity if every one of them computes remaining time the same way.

- **Always compute real time-to-expiry via `calculateTimeToExpiryYears(expiryDateStr)`** from
  `lib/optionsMonitorMath.ts`. It accounts for the exact 15:30 IST expiry cutoff and the current
  time of day, and floors at a small positive value (never zero) so Black-76 doesn't divide by
  zero. Do not reimplement a second "days to expiry" helper (calendar-day granularity, no
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
