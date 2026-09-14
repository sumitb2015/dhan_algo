---
name: dhan-payoff-diagrams
description: Use when building or extending an options payoff/P&L diagram — computing the curve (per-leg payoff, breakevens, max profit/loss, POP, SD expected-move bands, pre-expiry Black-Scholes pricing) or rendering it (the hand-rolled SVG chart family in BasketPayoffChart.tsx, PositionsPayoffChart.tsx, PayoffDiagram.tsx, StrategyBuilder, Baskets, PositionsAnalysis; or the recharts-based Options Monitor at app/options-monitor and lib/optionsMonitorMath.ts). Not for the draft-leg staging UI or margin/ROI stats strip around a payoff chart — that's dhan-options-analytics-page.
---

# Options Payoff Diagrams

## Overview
Payoff diagrams in this dashboard split into two layers that should stay separate:
a pure math layer (`lib/optionsStrategy.ts`) that turns resolved legs into a
`{spot, pnl}[]` curve plus derived stats, and a rendering layer — three hand-rolled
SVG components that read as one family (`components/BasketPayoffChart.tsx`,
`components/analytics/PositionsPayoffChart.tsx`, `components/strategy/PayoffDiagram.tsx`)
because each one's own header comment says it copies the previous one's technique.
`BasketPayoffChart.tsx` is the original and is the one to copy from — the two later
ones copied its layout/interaction code faithfully but **dropped its theme-awareness**
(see Theming below). A fourth path, `lib/useUnderlyingPayoff.ts`, is the orchestration
layer that fetches the option chain and feeds the math layer for the "all positions"
live view.

**Why hand-rolled SVG instead of recharts** (used for every simpler chart in this
dashboard): recharts cannot stroke a single line in two different colors split at
y=0. A profit/loss curve needs exactly that — green above zero, red below — so all
three components draw the line/area twice, once per sign, each clipped to its own
half of the plot via an SVG `clipPath`. Don't reach for recharts for a new payoff
chart; copy this family's clip-path technique instead.

**The one accepted exception** is the Options Monitor
(`app/options-monitor/page.tsx` + `components/options-monitor/PositionsStrategyMonitor.tsx`
+ its own math module `lib/optionsMonitorMath.ts` — parallel to, not built on,
`lib/optionsStrategy.ts`, because it models live-editable broker legs with a
pre-resolved `qty` rather than resolved static legs). It's a dense reference-line-heavy
terminal panel (strike markers, breakeven markers, SD bands, a live spot marker) where
recharts' declarative `ReferenceLine`/`ReferenceArea` primitives are worth more than the
bicolor-stroke trick, so it gets the green/red split via full-height `ReferenceArea`
zones carved at the breakevens instead of a clipped bicolor line. See "A Fourth Path"
below before touching it — it has its own gotchas that don't apply to the SVG family.

## When to Use
- Adding a new payoff/P&L chart, or a new curve type (a new Greek-adjusted curve, a
  new multi-leg combination) to an existing one.
- Changing how max profit/loss, breakevens, or probability-of-profit (POP) are
  computed.
- A payoff chart looks wrong in one theme, has an off tooltip, or mis-clips an
  unlimited-loss/profit wing.
- Not for: staging draft ("what-if") legs before they're real, the margin/ROI stats
  strip beside a payoff chart, or the historical validity-report modals — see
  `dhan-options-analytics-page` for all three.

## The Math Layer (`lib/optionsStrategy.ts`)

### Per-leg payoff, then scale by lot size once
`legPayoffAtExpiry(spot, leg)` returns **per-unit-of-lot** P&L: intrinsic value at
that spot, offset by the leg's own entry price, signed by side (`SELL` profits from
`price - intrinsic`, `BUY` from `intrinsic - price`), multiplied by `qtyLots`. The
book-level curve (`netPnlAtExpiry`) sums every leg this way and multiplies by
`lotSize` exactly once at the end — never scale by lot size per leg, or a mixed-side
book double-counts it.

### Sample the x-axis at strikes, not just evenly
A piecewise-linear payoff only kinks at strikes — sampling evenly can step over a
strike's exact vertex and round off a sharp corner, or miss the true breakeven.
`buildSpotSamples()` builds 150 evenly-spaced points across a domain that's forced
symmetric around spot (so the zero-line doesn't visually skew to one side), *and*
force-adds every leg's exact strike as an extra sample point. Copy this shape for
any new curve function — don't sample on a bare evenly-spaced grid.

### Breakevens are exact interpolation, not a heuristic
`findBreakevens()` walks the sampled curve for sign changes and linearly interpolates
the exact zero-crossing between the two bracketing samples — not "nearest sample to
zero," which would be off by up to half a sample step. A `pnl === 0` sample is
reported as its own breakeven directly.

### Unlimited profit/loss is a *position* fact, not a curve-shape guess
`computePayoffStats()` does not infer "unlimited" from whether the sampled curve's
tail is still sloping — it computes net signed quantity per option type
(`netCallQty`, `netPutQty`: positive = net short that type) directly from the leg
list. Net short calls ⇒ unlimited loss on the upside; net short puts ⇒ unlimited
loss on the downside; net long calls ⇒ unlimited profit on the upside (a net long
put's profit is capped because spot can't go below 0 — there's no downside
equivalent). Never derive "unlimited" from `Math.max/min` over the sampled range —
that range is finite by construction and will always report *some* number.
`maxLossInRange`/`maxProfitInRange` exist precisely for callers that still want a
number to display in the unlimited case, but they carry an explicit contract: any UI
showing them **must** annotate the sampled range alongside, or it reads as a real
floor/ceiling and silently understates an unbounded risk.

### POP integrates the risk-neutral distribution over breakeven zones, not a delta sum
`computePayoffStats()`'s `popPct` sums `N(d2)` (the same term `bsPrice()` uses for a
call) across each zone the breakevens carve the spot axis into, keeping only zones
where the exact intrinsic payoff (evaluated at a point safely inside the zone, not
off the discretely-sampled curve) is profitable. This was deliberately chosen over a
naive delta-sum heuristic (`|delta_leg1| + |delta_leg2|...`), which collapses to
~0% for an ATM straddle even though such a position plainly has real profit
probability — both legs' deltas near ±0.5 sum to ~1.0 and read as "certain to lose."
Reuse this zone-integration approach for any new probability-style stat; don't
reintroduce a delta-sum shortcut.

### Pre-expiry curves need Black-Scholes, and must disclose missing IV
`buildTargetPayoffCurve()` (single expiry) and `buildMultiExpiryCurve()` (a book
spanning several expiries, pricing each leg at its own *residual* days-to-expiry)
price with `bsPrice()` when a leg has usable IV, falling back to intrinsic-only
otherwise — which draws a curve that *looks* valid but is quietly wrong wherever
time value is being ignored. Dhan's option chain often returns a one-sided or
all-zero `implied_volatility`, so `impliedVolFromPrice()` inverts `bsPrice()` by
bisection to backfill it from the leg's own traded price (returns `null`, not a
clamped bound, when no positive-vol solution exists — treat null as "unavailable,"
not zero). Any UI drawing a pre-expiry curve must call `legsMissingIv()` and surface
which legs are being drawn wrong, the way the existing `ivWarning` banners do — don't
silently ship a confident-looking blue line built partly on intrinsic-only legs.

## The Rendering Layer (hand-rolled SVG family)

Conventions shared by all three components — copy them together, not piecemeal:

- **Fixed pixel height, full-bleed responsive width.** The SVG's `viewBox` height is
  a constant (`H`/`H_FULL`); only the width tracks the container via a
  `ResizeObserver`. Attach the observer through a **callback ref**, not
  `useRef` + `useEffect([])` — these components early-return a loading/empty
  placeholder before the chart's own `<div>` exists, so an effect keyed on mount
  would fire before the ref ever attaches and permanently miss the real width.
- **`niceTicks(lo, hi, count)`** produces round-number axis ticks (1/2/5 × a power
  of ten) — copy this verbatim rather than re-deriving tick spacing.
- **Bicolor line via two `clipPath`s at `zeroY`.** One clip rect covers
  `[0, zeroY]` (profit), the other `[zeroY, H]` (loss); the *same* line and fill-area
  path is drawn twice, once inside each clip, once styled green and once red.
- **Breakeven markers**: an amber/gold dot sitting exactly on the zero line at each
  breakeven's x-position, labeled with both the absolute strike/spot value and its
  `%` distance from current spot (`((be - spot) / spot) * 100`).
- **Current-spot marker**: a full-height dashed vertical line, distinctly colored
  from the breakeven markers (sky-blue in the strategy builder, red in the positions
  book — match whichever page you're extending).
- **Crosshair readout**: binary-search the nearest sample to the cursor's x-position
  (or, in `PayoffDiagram`/`PositionsPayoffChart`, interpolate via the exported
  `pnlAt()` helper for a value *between* samples), then render a small floating
  tooltip box that flips from right-of-cursor to left-of-cursor once the cursor
  crosses ~60% of plot width — so it never runs off the right edge of the SVG.
- **Unlimited wings get an explicit continuation glyph.** `BasketPayoffChart.tsx`'s
  `rightWing` prop draws a small arrow + "unlimited profit/loss" label at the plot's
  right edge instead of just letting the line exit the viewBox — prefer this explicit
  treatment over relying on domain padding to imply continuation, since a user
  reading the chart at a glance can't tell "cut off" from "actually flattens here."
- **Fullscreen via `createPortal(chart, document.body)`.** A card ancestor with
  `backdrop-blur` (or any `filter`/`backdrop-filter`) creates a CSS containing block
  for `position: fixed` descendants — without portaling to `<body>`, a "fullscreen"
  overlay gets trapped inside the card's own box instead of covering the viewport.
- **Draft-leg overlay**: a dashed violet line/curve alongside the real-book curve —
  see `dhan-options-analytics-page` for the full draft-leg staging contract this
  visual convention belongs to.

## Theming — call `useChartChrome()`, don't hardcode chrome hex

This is the one place the family actually diverged. `BasketPayoffChart.tsx` (the
original) calls `lib/chartTheme.ts`'s `useChartChrome()` — the same hook
`dhan-theme-tokens` documents for canvas-based `lightweight-charts` charts — and uses
its returned `gridline`/`baseline`/`textSecondary`/`textMuted`/`surface` values for
every chrome element (grid lines, axis labels, tooltip box, crosshair). Because the
hook returns plain re-computed strings (not CSS `var()` references), it works
perfectly as an SVG presentation-attribute value and re-renders automatically when
the user toggles the theme.

`PositionsPayoffChart.tsx` and `PayoffDiagram.tsx` — built later, explicitly copying
this family's layout — **dropped the `useChartChrome()` call** and hardcoded their
chrome to the dark-theme hex values instead (`stroke="#27272a"`, `fill="#71717a"`,
tooltip `fill="#09090b"`, etc.). Both are dark-mode-only today: their grid, axis
text, and tooltip box do not flip in light mode. `app/globals.css` also already
defines dedicated `--chart-grid` / `--chart-axis` / `--chart-tick` /
`--chart-tooltip-bg` / `--chart-tooltip-border` / `--chart-tooltip-text` /
`--chart-pos` / `--chart-neg` tokens (both themes) that recharts consumes via global
CSS class rules — a hand-rolled SVG chart doesn't get that for free and must either
call `useChartChrome()` (preferred; proven working in this exact component family)
or reference those tokens via inline `style={{ stroke: 'var(--chart-grid)' }}`
(inline `style` resolves `var()`; a bare `stroke="var(--chart-grid)"` attribute does
not, per `dhan-theme-tokens`).

**For any new payoff diagram: call `useChartChrome()` for chrome, same as
`BasketPayoffChart.tsx`.** Saturated profit/loss green/red, the spot-line blue, and
the breakeven amber are the accepted "data color" exception in CLAUDE.md's theming
rules and can stay hardcoded hex literals like all three components already do.

## A Fourth Path: the Options Monitor (recharts, not hand-rolled SVG)

`app/options-monitor/page.tsx`, `components/options-monitor/PositionsStrategyMonitor.tsx`,
and `lib/optionsMonitorMath.ts` render a Sensibull-style strangle/strategy terminal with
recharts instead of the SVG family. It's a legitimate second implementation of the same
concepts (breakevens, max profit/loss, POP, a pre-expiry curve) against a different leg
shape — don't try to unify it with `lib/optionsStrategy.ts`, but do apply every lesson
above to it, since it's easy to reintroduce a bug here that was already fixed in the SVG
family.

- **The spot axis MUST be `type="number"` — a category axis silently bends the curve.**
  This is the single most important rule for this chart. `<XAxis dataKey="spot">` with no
  `type` defaults to `type="category"`, and recharts spaces categories **equally in
  pixels regardless of their numeric value**. Because `generatePayoffCurve()` deliberately
  force-adds off-grid samples (the current spot, every strike) alongside its ~120 evenly
  spaced ones, a category axis renders a sample 2 points from its neighbour with the same
  horizontal gap as one 16 points away — so the x-scale is non-linear and **straight
  payoff segments visibly bend into a twisted, wobbly line**, worst exactly at the strikes
  where the kinks matter. It looks like a broken interpolation or bad math; it is neither.
  The fix is `type="number"` plus an explicit `domain={[minSpot, maxSpot]}` taken from the
  first/last sample.
  This also removes a whole class of workaround: on a numeric axis every `ReferenceLine`
  `x` and `ReferenceArea` `x1`/`x2` positions itself off the real scale, so breakevens, SD
  levels and any other interpolated marker are passed through **exactly as computed** —
  no snapping to sample points, no force-adding them into the sample set. (On a category
  axis an unmatched value renders *nothing, with no error*, which is what makes the wrong
  axis type so easy to misdiagnose: markers vanish AND lines bend, and neither symptom
  points at the axis.) Keep force-adding strikes to the *data* sampler, though — that's
  for curve vertex accuracy, not axis positioning.
- **Give it round-number ticks.** A numeric axis left to its own devices still labels
  irregular sample values. Pass an explicit `ticks={...}` array built with the 1/2/5 ×
  power-of-ten rule (same idea as the SVG family's `niceTicks`) so the axis reads
  "22,500 / 23,000 / 23,500 / 24,000" rather than a crowded row of raw sample numbers.
- **Curve color convention: blue = smooth/target-date, red = kinked/at-expiry.**
  Worth matching exactly, since users compare this chart against Sensibull side by side.
  The palette is declared once at the top of `PositionsStrategyMonitor.tsx` — reuse the
  constants, don't re-pick hexes:
  `PAYOFF_EXPIRY` `#e0533d` (the `pnlExpiry` line: sharp corners at every strike, flat top
  between breakevens), `PAYOFF_TODAY` `#2d7ff9` (the `pnlToday` line: smooth Black-Scholes
  curve that sits *below* the expiry line near max profit, because it hasn't captured full
  theta decay yet), `PAYOFF_PROFIT` `#16a34a`, `PAYOFF_LOSS` `#e5484d`, `PAYOFF_SPOT`
  `#e5484d`. These are the CLAUDE.md "saturated data colour" exception — fixed hex in both
  themes on purpose.
  The two curve colours were shipped inverted once: the math was correct throughout, but
  the kinked shape appeared under the colour a reader expects to be the smooth one, which
  reads exactly like a computation bug to anyone checking against a reference screenshot.
  When a colour-based bug report comes in, check the `stroke`/`dataKey` pairing on the
  `<Line>` elements before re-deriving any math.
- **POP must never be a hardcoded constant.** `computePortfolioMetrics()`'s `popPct` was
  shipped as a literal `68` for a period — a bare number that looks like a real stat in
  every screenshot until someone changes the position and notices it never moves. It now
  runs the same lognormal zone-integration as `lib/optionsStrategy.ts`'s
  `computePayoffStats()`: a local `computeAvgIv()` helper averages each leg's own IV
  (shared by both the POP calculation and the SD-band calculation below, so they stay
  mutually consistent), and `riskNeutralProbAbove()` is the same `N(d2)` term. Treat any
  bare numeric stat sitting in a payoff/risk panel as suspect until you've traced it to a
  live computation — a hardcoded placeholder doesn't throw, doesn't look wrong, and
  survives code review easily because the UI is "populated."
- **1SD/2SD expected-move bands share the POP calculation's inputs, on purpose.**
  `generatePayoffCurve()` computes `sd1Move = spot * avgIv * sqrt(t)` using the *same*
  `computeAvgIv()`/`t` the POP block uses, then returns exact, unsnapped `sdLevels`
  (`lo2/lo1/hi1/hi2`) — the numeric axis (see above) means these are never rounded to a
  strike or forced into a sample set, unlike the pre-numeric-axis version of this code.
  A level is only rendered if it lands inside the plotted domain (checked against
  `spotDomain`, i.e. the first/last sampled `spot`) — don't widen the domain just to fit
  an outsized 2SD line from a long-dated/high-IV position; let it fall off the edge.
  Sharing inputs with POP makes the chart self-explanatory: when the breakevens visually
  sit close to the ±1SD gridlines, POP will be close to 68% (the textbook 68-95-99.7
  rule) — a fast sanity check when eyeballing a new POP number.
- **Time annualizes over 365 CALENDAR days. Do not "correct" it to 252 trading days.**
  `calculateTimeToExpiryYears()` is the sole source of `t` for every BS/POP/SD calculation
  here and divides by `CALENDAR_DAYS_PER_YEAR = 365`. The 252-trading-day convention is a
  real and defensible one in the abstract, and it is exactly the trap: it *sounds* more
  correct, and it can appear to close a gap you are chasing. It is empirically wrong for
  this market. This was actually changed to 252 during one session (it narrowed an SD-band
  gap from -22% to -6%) and had to be reverted the next, once Greeks became available to
  test against. See "How to verify this model against a reference" below — the Greeks are
  decisive where the SD alone is not. If extending this math layer with a new
  time-sensitive calculation, route it through `calculateTimeToExpiryYears()` rather than
  hand-rolling a `/365` or a `/252`.
- **The SD expected-move band uses the UNDERLYING's vol (India VIX), not the legs' IVs.**
  `generatePayoffCurve()` computes `sd1Move = spot * baseIv * sqrt(t)`, where `baseIv` is
  the page's `ivPct/100` — which `app/options-monitor/page.tsx` sets from live India VIX
  (`setIvPct(liveQuotes.vix.ltp)`). It deliberately does **not** use `computeAvgIv(legs)`.
  Two reasons, one conceptual and one measured. Conceptually an expected-move band is a
  property of the underlying, not of whichever strikes this strategy happens to hold —
  averaging two skewed OTM wings makes the band silently shift when the user rolls a
  strike, which is plainly wrong. Empirically, for the reference strangle (23500 CE @ 9.5%
  IV, 23300 PE @ 11% IV, spot 23398.10, 4 days out) Sensibull's published ±321.7pt 1SD
  implies a vol of **13.13%** — above both leg IVs *and* above the ~9.5% ATM IV implied by
  that skew, i.e. unmistakably an underlying-level vol, not a strike-level one. Averaging
  the legs (10.25%) gives ±251pts, a 22% error; VIX-style sourcing reproduces their
  published bands to the rupee. Note `computeAvgIv()` is still correct for POP, which
  *is* a property of the specific legs.
- **Always print a derived band's inputs next to it.** `SdLevels` carries `points1`, `vol`
  and `days` purely so the banner under the chart can render "1SD 23,121 — 23,675 (±276.9
  pts / 1.2%) … from 21.5% IV over 1.10d to expiry". An SD band is `spot * vol * sqrt(t)`,
  so it legitimately moves whenever either input moves — and a bare gridline gives a user
  comparing against another tool no way to tell a real bug from a different vol or a
  different number of days left. Most of the back-and-forth on this chart was exactly that
  ambiguity: the formula was right and the *inputs* differed (1.10d @ 21.5% VIX here vs
  4.00d @ 13.13% in the reference — same formula, 23,675 vs 23,720). Any future derived
  overlay (a target-date curve, a probability cone) should show its inputs the same way.

## How to verify this model against a reference (and how NOT to)

Matching a broker's published analytics is a recurring request here, and most of the
model's parameters are individually unidentifiable from a payoff chart alone — several
different (vol, day-count, underlying) combinations produce a similar-looking curve. Two
hard-won rules:

**Greeks are the decisive test; SD and POP are not.** A published delta pins down the
underlying, the day-count and the IV simultaneously, because it's a sharp function of all
three. Reverse-engineering the reference strangle's deltas over the obvious candidate grid
produced exactly one match, to four decimals on *both* legs:

| model | 23500 CE delta | 23300 PE delta |
|---|---|---|
| 4d/365, **futures**-based | **0.4400** | **-0.2698** |
| 4d/365, spot-based | 0.3593 | -0.3327 |
| 4d/252, futures-based | 0.4508 | -0.3044 |
| 4d/252, spot-based | 0.3932 | -0.3503 |
| *published* | *0.44* | *-0.27* |

That single table settled both the day-count question (365, not 252 — reversing an earlier
wrong conclusion) and revealed the futures-basis issue below. An SD band, by contrast, is
one number from a product of three unknowns, so *many* wrong combinations fit it — which is
how the 252 change came to be made in the first place.

**Never tune a constant until one screenshot lines up.** IV is live and continuously
changing, so two captures of "the same" position minutes apart imply different IV, and a
constant fitted to one is wrong for the next. Only trust a fix derived from a *solvable*
test case — one where the reference publishes its own inputs (strikewise IVs, days to
expiry, the resulting Greeks) so the model is fully determined — or from a convention you
can independently justify. If the reference doesn't publish enough to pin the model down,
say so rather than curve-fitting.

**Known remaining divergence: we price Greeks off SPOT, the reference prices off FUTURES.**
`computeBsGreeks()` takes spot and applies `r` as cost-of-carry. The reference uses the
actual futures price for that expiry (23463.60 vs spot 23398.10 — a 65pt basis, far wider
than the ~17pt pure carry a synthetic forward `S*e^(rt)` would give, so a synthetic forward
does **not** close it). The effect is material: 0.36 vs 0.44 delta on a near-ATM leg, ~22%
off. That matters here specifically because the Delta Hedge control on this page sizes a
real order off net delta. Fixing it properly needs the live futures LTP for the selected
expiry wired into the page as a data source — not yet done.
- **Recharts here *does* resolve `var(--token)` in bare `stroke`/`fill` attributes** —
  unlike the hand-rolled SVG family, where `dhan-theme-tokens` warns a bare
  `stroke="var(--chart-grid)"` attribute won't resolve and inline `style` is required.
  This file already relies on bare `var()` attributes for `CartesianGrid`/`XAxis`/`YAxis`/
  the zero-line `ReferenceLine`, so keep using that pattern for new recharts chrome here;
  don't "fix" it into `style={{ stroke: ... }}` — that's a different chart tech's rule.
- **The "Current price" pill and "Projected P&L" badge** (`ReferenceLine`'s `label` prop)
  are custom render functions returning an SVG `<rect>` + `<text>`, not the built-in string
  label — recharts' default label is plain text with no background, which can't match the
  reference's bordered callout box. `label` accepts a function receiving `{ viewBox }`; use
  `viewBox.x` for the marker's pixel x-position, `viewBox.y` to anchor above the plot, and
  `viewBox.y + viewBox.height + ~20` to sit *below the x-axis tick labels* (recharts draws
  those just under the plot, so a +2 offset lands the badge right on top of them). Bump
  `margin.top`/`margin.bottom` to make room — currently 28 / 46. A `ReferenceLine` used
  purely as a label anchor takes `stroke="transparent"`.
- **Annotation lines must use `--chart-tick`, not `--chart-axis`.** `--chart-axis` is
  `#cbd5e1` in light mode — fine as the axis spine, invisible as a gridline you are
  expected to *read*. The SD band lines and their labels were unreadable in light mode for
  exactly this reason. `--chart-tick` (`#475569` light / `#a1a1aa` dark) is the token for
  anything annotation-like that must stay legible in both themes.
- **Zone hatching wants far less opacity than feels right.** The profit/loss zones use
  SVG `<defs><pattern patternTransform="rotate(45)">` diagonal hatches (declared as a
  `<defs>` child of `<LineChart>`, referenced as `fill="url(#id)"`). Calibrate low —
  `fillOpacity` ≈ 0.05 on the pattern's background `<rect>` and ≈ 0.12 on its `<line>`.
  A first pass at 0.09/0.22 already read as a heavy saturated wash that overpowered the
  curves, especially in dark mode.
- **Don't repeat in the chart what the banner under it already says.** Breakeven, PE-strike
  and CE-strike `ReferenceLine` *labels* were removed: the strike-clearance banner directly
  below the chart names all of them, and in-chart they collided with the SD labels and the
  projected-P&L badge. The breakeven lines themselves are redundant too — the boundary
  between the green profit zone and the red loss zones *is* the breakeven. Strike lines are
  kept, unlabelled, because the panel is a strike-clearance graph.
- **Verifying this chart in a browser:** a Playwright `fullPage: true` screenshot renders
  the chart area **blank** — `ResponsiveContainer` re-measures during full-page capture and
  loses its size. It's a capture artifact, not a rendering bug. Screenshot the viewport (or
  the `.recharts-wrapper` element) instead. Toggle themes for review via
  `localStorage['dhan-theme'] = 'light' | 'dark'` + reload; `lib/theme.ts` applies a `.dark`
  class on `<html>`, so setting a `data-theme` attribute does nothing here.

## Common Mistakes
- Copying `PositionsPayoffChart.tsx` or `PayoffDiagram.tsx` as the template for a new
  chart instead of `BasketPayoffChart.tsx` — you inherit the dark-only chrome
  regression along with the layout.
- Scaling a leg's payoff by `lotSize` inside the per-leg function instead of once at
  the book level — double-scales in a mixed single/multi-lot book.
- Sampling the spot axis evenly without force-including every strike — rounds off
  kinks and can miss a breakeven that falls exactly on one.
- Inferring "unlimited profit/loss" from the sampled curve's shape instead of net
  signed quantity per option type — always finite by construction, so this silently
  reports a bounded number for a naked short.
- Displaying `maxLossInRange`/`maxProfitInRange` without stating the sampled range —
  reads as a real floor/ceiling and understates unbounded risk.
- Drawing a pre-expiry (Black-Scholes) curve without calling `legsMissingIv()` and
  surfacing which legs fell back to intrinsic-only pricing.
- Reintroducing a delta-sum POP heuristic — collapses to ~0% for an ATM straddle.
- Shipping a hardcoded placeholder for POP (or any other headline payoff stat) instead of
  wiring it to a real computation — it renders fine and passes a glance-review; only a
  second position with a different number exposes it (see the Options Monitor above).
- On the Options Monitor's recharts chart specifically: leaving the spot `XAxis` as the
  default `type="category"`. It bends straight payoff segments into a twisted line (equal
  pixel spacing for unequally spaced samples) *and* silently drops any reference marker
  whose value isn't an exact sample. Use `type="number"` with an explicit `domain`; if you
  find yourself snapping a breakeven to its nearest sample point to make a marker appear,
  that's the smell — fix the axis type instead of the value.
- On the Options Monitor: swapping the at-expiry/T+0 curve colors relative to the
  blue=smooth/red=kinked convention — the math can be entirely correct while the chart
  still looks wrong to anyone comparing against Sensibull, since the wrong curve shape
  ends up under the "wrong" (but visually expected) color.
- Using `--chart-axis` for a line or label the user is meant to *read* — it's near-white
  in light mode. `--chart-tick` is the legible-in-both-themes annotation token.
- Concluding the chart is broken because a `fullPage` Playwright screenshot came back
  blank — `ResponsiveContainer` loses its measurement during full-page capture. Verify
  with a viewport or element screenshot.
- "Correcting" the 365-calendar-day annualization to 252 trading days. It sounds more
  rigorous and it will appear to improve an SD-band gap — it is empirically wrong here and
  was already made and reverted once. The published Greeks disprove it outright.
- Feeding the SD expected-move band the average of the legs' IVs instead of the
  underlying's own vol — makes the band move when the user rolls a strike, and is 22% off
  the reference.
- Chasing an exact numeric match to a single reference screenshot (Sensibull or
  otherwise) by tweaking constants until one example lines up. IV is a live, continuously
  changing number — two screenshots of "the same" position taken minutes apart can imply
  meaningfully different IV, so a formula tuned to fit one capture can be wrong for the
  next. Trust a fix only when it's derived from a *solvable* test case (the reference
  publishes its own inputs and Greeks, so the model is fully determined) or a convention
  you can independently justify — never from minimizing the gap against one screenshot.
