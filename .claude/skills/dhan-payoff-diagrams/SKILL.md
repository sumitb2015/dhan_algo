---
name: dhan-payoff-diagrams
description: Use when building or extending an options payoff/P&L diagram — computing the curve (per-leg payoff, breakevens, max profit/loss, POP, pre-expiry Black-Scholes pricing) or rendering it (the hand-rolled SVG chart family in BasketPayoffChart.tsx, PositionsPayoffChart.tsx, PayoffDiagram.tsx, StrategyBuilder, Baskets, PositionsAnalysis). Not for the draft-leg staging UI or margin/ROI stats strip around a payoff chart — that's dhan-options-analytics-page.
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
