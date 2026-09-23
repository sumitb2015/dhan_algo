---
name: dhan-recharts-charting
description: Use whenever building, extending, or debugging a `recharts` chart component anywhere in rs_dashboard — LineChart/AreaChart/BarChart/ComposedChart, a custom Tooltip, ResponsiveContainer sizing, axis domains, or a chart driven by a poll/WebSocket interval. Also use when a chart flickers or replays its animation on every live tick, a chart's colors don't flip across dark/white/beige theme, the tooltip cursor band looks wrong, ResponsiveContainer renders 0-height, or an axis is dominated by an outlier and the interesting data is squashed. Covers the ~50 recharts components in this dashboard (OptionsPremiumBarTab, BreadthAnalysis, IVChartsPage, PositionsStrategyMonitor, OptionsPCDiffTab, StrikeHistoryTab, and others) at the component-mechanics level — how a chart is wired and styled, not the math it plots or the page shell around it. Not for lightweight-charts canvas components (CombinedPremiumChart, FuturesCandleChart, LightweightCandlestickChart, FootprintChart — see dhan-live-chart), page-level header/tab layout around a chart (dhan-quant-terminal-page), payoff-curve math (dhan-payoff-diagrams), or the palette/token system in general (dhan-theme-tokens).
---

# Dhan Recharts Charting

## Overview

`recharts` renders to SVG, so — unlike the four `lightweight-charts` canvas components
(`dhan-live-chart`) — its chrome themes itself through plain CSS targeting recharts'
own class names in `app/globals.css`. That single fact is the source of most recurring
recharts bugs in this repo: components that fight the CSS-class theming by passing
hardcoded colors, or that forget the one piece recharts genuinely does not theme (the
tooltip cursor). The other recurring bug family is unrelated to theming: charts whose
data prop refreshes on a poll/WS interval replay their mount animation on every tick.

This skill is the mechanics layer under three other skills:
- `dhan-quant-terminal-page` owns the *page* around a chart (sticky header, tabs).
- `dhan-payoff-diagrams` owns the *math* some recharts charts plot (Black-76, breakevens, SD bands) and the hand-rolled SVG payoff family.
- `dhan-live-chart` owns the *other* charting library (`lightweight-charts`, canvas, incremental `update()`).

If you're deciding *what a chart should show*, or *where it sits on the page*, those
are the right skills. If you're deciding *how to wire the recharts component itself*
— theming, animation, axis domain, tooltip — this is the one.

**Reference implementations**: `components/OptionsPremiumBarTab.tsx` (token-correct
custom tooltips with cursor theming) and `components/OptionsPCDiffTab.tsx` (the
simplest correct token-based tooltip, ~15 lines).

---

## Theming: let CSS do it, except the cursor

`app/globals.css` styles recharts by its own emitted class names, `!important`, once
per theme block (dark/light/beige each redefine the same custom properties):

```css
.recharts-cartesian-grid line { stroke: var(--chart-grid) !important; }
.recharts-cartesian-axis-line,
.recharts-cartesian-axis-tick-line { stroke: var(--chart-axis) !important; }
.recharts-cartesian-axis-tick text,
.recharts-cartesian-axis-tick text tspan,
.recharts-cartesian-axis-tick-value,
.recharts-polar-angle-axis-tick text,
.recharts-polar-radius-axis-tick text { fill: var(--chart-tick) !important; }
.recharts-legend-item-text { color: var(--chart-tick) !important; }
.recharts-default-tooltip {
  background: var(--chart-tooltip-bg) !important;
  border-color: var(--chart-tooltip-border) !important;
  color: var(--chart-tooltip-text) !important;
}
```

Consequences:

- **Never pass a hex/stroke/fill prop for grid, axis, legend, or the default
  tooltip's chrome.** It's dead code at best (CSS wins with `!important` anyway)
  and at worst it's the only thing that *doesn't* get overridden — an inline
  `labelStyle={{ color: '#a1a1aa' }}` on `<Tooltip>` beats the inherited CSS color
  because inline styles win 2:1 against a class selector, even an `!important` one
  on the wrong element. This exact bug shipped on ~12 charts passing a grey
  `labelStyle`; the fix was a dedicated `.recharts-tooltip-label` rule, not removing
  every `labelStyle` prop. If you must override one tooltip row's color, pass
  `var(--chart-tooltip-text)` (or `--chart-tick`) as the value, never a literal hex.
- **Series colors** (Line/Bar/Area `stroke`/`fill` for the actual data, as opposed
  to chrome) come from `--chart-1` through `--chart-5` (oklch, theme-specific — see
  `app/globals.css`), or the sanctioned saturated exceptions `--chart-pos` /
  `--chart-neg` for P&L green/red. This is the chart-specific instance of the root
  CLAUDE.md rule: "saturated data colours are the exception; chrome is not."
- **A custom `Tooltip content={...}` component opts out of `.recharts-default-tooltip`
  entirely** — none of the CSS above reaches it, because it's your own JSX, not
  recharts' internal markup. You must theme it yourself. Two patterns exist in this
  codebase and only one of them actually themes:
  - **Token-based (correct, flips across dark/light/beige)** —
    `components/OptionsPCDiffTab.tsx`:
    ```tsx
    <div style={{
      background: 'var(--chart-tooltip-bg)',
      border: '1px solid var(--chart-tooltip-border)',
      color: 'var(--chart-tooltip-text)',
      borderRadius: 8, padding: '6px 10px', fontSize: 11,
    }}>
    ```
  - **Hardcoded "dark-glass" (looks intentional, does not theme)** — several
    tooltips (e.g. `PremiumTooltip` in `OptionsPremiumBarTab.tsx`) use literal
    `bg-zinc-950/98 border-zinc-700/70 text-white` Tailwind classes. This renders a
    near-black tooltip even in light/beige mode — it's a fixed dark surface, not a
    themed one. Don't copy this pattern into a new chart; if you're touching an
    existing one that does this, treat it as a bug to flag, not a style to match,
    unless the surrounding page is itself deliberately theme-pinned (see
    `.chart-light-surface` below).
- **`.chart-light-surface`**: when a chart must render with fixed light styling
  regardless of the app's current theme (an embedded light-mode widget inside an
  otherwise-dark page), `globals.css` provides a `.chart-light-surface` class that
  repins `--chart-cursor-fill`/`--chart-cursor-line` (and the grid/axis vars) to
  their light values for everything under it. Reach for this instead of hardcoding
  colors when a chart genuinely needs to opt out of the ambient theme.

### The tooltip cursor is the one thing CSS can't reach

Recharts renders the hover cursor (the shaded band on bar/area charts, the
crosshair line on line charts) with inline styles it computes itself — there's no
class to hook. Every `<Tooltip>` must theme it explicitly via the `cursor` prop, or
it silently keeps recharts' default gray:

```tsx
// Bar/Area chart — shaded hover band
<Tooltip content={<PremiumTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />

// Line chart — crosshair
<Tooltip content={<SmileTooltip />} cursor={{ stroke: 'var(--chart-cursor-line)', strokeWidth: 1, strokeDasharray: '4 4' }} />
```

Forgetting this was a real, repeated bug (commit `64c6425`, "theme the recharts
tooltip cursor via --chart-cursor-fill/-line tokens") — check for it on every new
`<Tooltip>`.

---

## Animation: kill it on anything that redraws on a timer

A chart mounted once and never re-fed (a static payoff curve, a one-shot report) can
keep recharts' default enter animation — it plays once and looks good. A chart whose
`data` prop is replaced on a `setInterval`/poll/WebSocket tick will **replay that
animation on every tick** unless told not to, which reads as a flicker or a visible
jump each refresh. This has been fixed as a bug at least three separate times in this
repo (`bb5a615`, `8e522e3`, and the merge `5395c65`) on live-updating payoff and
premium charts.

**Rule of thumb**: if the component that owns this chart's `data` is itself inside a
poll loop or subscribes to live ticks, set `isAnimationActive={false}` on every
`<Line>`/`<Area>`/`<Bar>` element that carries that data. Static, one-shot charts can
keep the default.

This pairs with a related performance rule: don't let a *derived* series (a computed
curve fed from raw data, e.g. a Black-76 T+0 curve) get recomputed every tick if the
panel showing it is collapsed or closed — gate the computation behind visibility
state and `useMemo` it against the inputs that actually change it (`dd6f04c`, "gate
T+0 curve computation on chart being open"). An invisible chart shouldn't cost CPU on
every poll.

---

## Axis domains: don't trust auto-scale on data with outliers

Recharts' default axis auto-scaling fits the full data range, which is wrong whenever
a chart plots something with a wide, mostly-uninteresting tail — a payoff curve
spanning strikes far from spot, an IV smile with a couple of illiquid far-OTM points.
The result is the *interesting* region (near spot, near the breakevens) getting
compressed into a few pixels while empty tail space dominates the plot.

Compute an explicit `domain` for `<XAxis>`/`<YAxis>` from the data's meaningful range
instead of leaving it on `'auto'` — e.g. breakevens ± a padding factor, or ATM ± N
strikes — and pair it with zoom/pan controls when a user might reasonably want the
full range back (`1cd6db8`, "scale X-domain to breakevens, add zoom controls"). Don't
do this reflexively on every chart — only where the raw domain would genuinely bury
the signal; a normal time series with no outliers is fine on auto.

---

## Structural conventions

**`ResponsiveContainer` needs a sized ancestor.** It measures its parent's box and
renders at that size — if the parent has no explicit height (a flex child with no
`h-*`, a grid cell that hasn't resolved yet), `ResponsiveContainer` silently renders
at 0×0 and the chart appears blank with no error. Give the wrapping `div` an explicit
height (`h-[420px]`, a fixed height class matching the design, or a flex-basis that
resolves before first paint) — every chart in this codebase does this
(`<ResponsiveContainer width="100%" height={420}>`).

**Custom tooltip components over the recharts default**, wherever the tooltip needs
to show more than one formatted line, a computed diff, or match the "dark-glass"
panel look — pass `content={<YourTooltip />}` and format the payload yourself
(`payload[0].payload` gives you back the original data row). Keep it themed per the
tokens above.

**`useMemo` the data array fed to the chart**, keyed on the actual upstream inputs
(not a new object/array literal built inline in JSX every render). Recharts treats a
new array identity as new data — for an animated chart this can retrigger the enter
animation even when the *values* haven't changed, and for a large series it's wasted
re-diffing on every parent re-render for unrelated reasons.

**Empty/loading state matches the chart's footprint.** A chart panel's placeholder
(spinner, "no data" message) should be sized to the same height as the eventual
`ResponsiveContainer` so the surrounding layout doesn't jump when data arrives —
don't collapse the panel to its content height while empty. Use `dhan-page-theme`'s
shared loading/empty/error state components for the actual visuals; this skill only
covers sizing the placeholder to match the chart.

**Prop-surface changes ripple to every call site.** A shared chart component's props
can drift out of sync with its callers with no runtime error — TypeScript only
catches it at build time, and a stale prop left on a call site after a signature
change breaks the build (`2e0655e`, "remove stale isFront prop breaking TS build").
Grep for every usage of the component before changing its prop interface, not just
the one call site you're editing.

---

## Quick checklist for a new or edited recharts chart

1. No hardcoded chrome colors (grid/axis/legend/default-tooltip) — let `globals.css` theme them.
2. Custom `<Tooltip content>`? Themed with `--chart-tooltip-bg/border/text`, not hardcoded zinc/black classes.
3. `cursor={{ fill: 'var(--chart-cursor-fill)', ... }}` or `{ stroke: 'var(--chart-cursor-line)', ... }` set explicitly.
4. Series colors from `--chart-1..5` or `--chart-pos`/`--chart-neg`, not ad hoc hex.
5. Data prop fed by a poll/WS loop? `isAnimationActive={false}` on Line/Area/Bar.
6. Derived/computed series gated behind visibility + `useMemo`, not recomputed blindly every tick.
7. Axis domain explicit where outliers would otherwise bury the interesting region.
8. `ResponsiveContainer`'s wrapping div has an explicit height.
9. Chart data array is `useMemo`'d, not rebuilt inline every render.
10. Empty/loading placeholder sized to match the chart's real height.
