---
name: dhan-theme-tokens
description: Use when changing the dashboard colour palette, adding a themed surface or injected style block, wiring a new chart's colours, or debugging a component that does not flip correctly between dark and white mode. Explains how app/globals.css, lib/theme.ts and lib/chartTheme.ts fit together. The always-on rules for ordinary UI edits are in CLAUDE.md.
---

# Dhan Theme Tokens

## Overview
The dashboard was written dark-only: ~4,600 hardcoded `zinc-*` / `text-white` /
`bg-black` utilities across 130+ files, with only a handful of components consuming
the shadcn semantic tokens. Rather than rewrite every file, **the palette itself is
themed** — each `--color-zinc-N` is re-pointed at a `--z-N` variable that flips
between the dark ramp and an inverted light ramp.

So `bg-zinc-900` means "panel surface" in both themes and `text-zinc-400` means
"secondary text" in both themes. Existing components flip with no changes at all.

Everything lives in `app/globals.css`. `lib/theme.ts` is the store, `lib/chartTheme.ts`
serves the canvas charts, and `components/ThemeToggle.tsx` is the NavBar control.

## When to Use
- Changing palette values, or adding a new token.
- Adding an injected `<style>` block (see `components/PanelStyles.tsx`).
- Adding a chart and wondering where its colours come from.
- A component looks wrong in one theme.

## The Mechanism

### `@theme inline` must reference a var, never a literal
```css
@theme inline {
  --color-zinc-400: var(--z-400);   /* correct */
  --color-zinc-400: #a1a1aa;        /* WRONG - can never flip */
}
```
`@theme inline` substitutes the declared value straight into the generated utility.
A literal is therefore baked into the stylesheet at build time and cannot change at
runtime; pointing at `--z-400` inlines `var(--z-400)`, which re-resolves per theme.

Verify after a build — the emitted rule must be
`.text-zinc-400{color:var(--z-400)}`, not a hex.

### `:root` is light, `.dark` is dark
`.dark` sits on `<html>`, which is also `:root` — same origin, higher specificity, so
it wins. **Never define a colour only inside one block**: a token that exists in
`.dark` but not `:root` falls back to the Tailwind default and looks broken in white
mode.

### The neutral ramp is inverted, not remapped
`--z-950` is the page ground (near-black in dark, white in light) and `--z-50` is the
strongest text. Read the comments in `globals.css` for the per-step intent before
changing a value — several steps carry a specific role (`--z-800` is the table-header
and hairline step, `--z-700` is borders).

### `white` and `black` are tokens too
`--color-white` and `--color-black` point at `--c-white` / `--c-black`, because in
this codebase `text-white` means "brightest text" and `bg-black` means "page ground",
not literal white and black. Both flip.

That leaves two escape hatches for the cases where you really do mean a fixed colour:

| Token | Utility | Use for |
|---|---|---|
| `--color-oncolor` (always `#fff`) | `text-oncolor`, `bg-oncolor` | a label on a saturated `bg-emerald-600` button; a switch knob |
| `--color-oncolor-dark` (always `#09090b`) | `text-oncolor-dark`, `bg-oncolor-dark/NN` | a label on `bg-amber-500`; **every modal scrim** |

A scrim written as `bg-black/70` becomes a near-white 70% wash in light mode and
stops dimming anything. Modal and drawer backdrops must use `bg-oncolor-dark/NN`.

### Accent steps 200-400 flip; 500+ do not
Steps 200-400 are used as *text* on the page ground, and the dark-mode values
(`emerald-400` = `#34d399`) fail contrast on white — so light mode re-points them at
the 700/800 end of each ramp. Steps 500+ are left alone because those are solid
badge and button fills, which read correctly on either ground.

If you need a new accent family themed, add `--a-<name>-{200,300,400}` to **both**
palette blocks and the matching `--color-<name>-N: var(--a-<name>-N)` to `@theme`.

## Charts

### Recharts (SVG) — themed by class, not by prop
SVG presentation **attributes** cannot resolve `var()`, so `stroke="var(--x)"` does
not work and ~37 chart components hardcode their chrome as hex props. `globals.css`
therefore restyles recharts' own generated class names — one rule per concern,
covering every chart at once:
`.recharts-cartesian-grid line`, `.recharts-cartesian-axis-line`,
`.recharts-cartesian-axis-tick text`, `.recharts-legend-item-text`,
`.recharts-default-tooltip`, `.recharts-tooltip-label`.

`!important` is required on the tooltip rules because `contentStyle` and `labelStyle`
land as inline styles.

Deliberately **not** themed: `.recharts-tooltip-item`. Recharts colours each item row
with its series colour, which is information rather than chrome. A chart that wants a
flat neutral item row passes `var(--chart-tooltip-text)` inline instead.

`.chart-light-surface` is a higher-specificity opt-out for a chart drawn on a
deliberately always-white card — currently only the Dhan-style volatility-skew panel
in `components/OptionsSkewTab.tsx`.

Inline `style={{}}` on a custom tooltip *is* an ordinary CSS property, so `var()`
works there — see `components/OptionsPCDiffTab.tsx`.

### lightweight-charts (canvas) — themed by hook
A canvas cannot read CSS variables. `lib/chartTheme.ts` exposes `useChartChrome()`,
which returns the palette as plain values and re-renders on theme change. See the
`dhan-live-chart` skill for how to apply it without recreating the chart.

### Hand-rolled SVG (not recharts) — same hook as canvas, not the recharts trick
A one-off SVG chart built from raw `<path>`/`<line>`/`<text>` (not recharts'
`<ComposedChart>` etc.) gets none of the global class-name CSS rules above — there
are no `.recharts-*` classes to hook into. Use `useChartChrome()` here too and pass
its plain string values as presentation-attribute props (`stroke={chrome.gridline}`),
exactly as for canvas. `components/BasketPayoffChart.tsx` does this correctly;
`components/analytics/PositionsPayoffChart.tsx` and `components/strategy/
PayoffDiagram.tsx` — built later, copying its layout — dropped the hook and
hardcoded dark-theme hex instead, so they don't flip in light mode. See
`dhan-payoff-diagrams` for the full writeup.

## Injected `<style>` Blocks
`components/PanelStyles.tsx` is the worked example: the whole `lc-*` design system is
driven by `--lc-*` tokens declared in both palette blocks — surfaces, hairlines, text
tiers, accent, plus `--lc-shadow` (an elevation used only in light mode, `none` in
dark) and `--lc-hover-bg` / `--lc-active-bg` / `--lc-active-border`.

Do **not** add a parallel `:root:not(.dark)` override block alongside the tokens. That
was tried and reverted: it duplicated the same properties, needed `!important`, and
meant editing a token silently did nothing in white mode.

## The Pre-Paint Contract
`app/layout.tsx` runs an inline script in `<head>` that applies the stored theme
before first paint, so a light-mode user never sees the dark shell flash. It must
stay in sync with `lib/theme.ts`:
- same storage key (`dhan-theme`),
- same default (`dark`, which is also the SSR `<html className="... dark">` and the
  store's server snapshot — matching them is what avoids a hydration mismatch),
- `<html suppressHydrationWarning>` because the script mutates the class.

`components/ThemeInit.tsx` is mounted in the root layout so the store initialises even
on pages without a NavBar (e.g. `/login`), where `ThemeToggle` never mounts.

## Verifying a Change
Toggle both themes and check: modal scrims still dim, chart tooltips are legible,
table headers read as headers, and no surface has gone flat. Grep for regressions:
`grep -rn 'bg-black/\|#[0-9a-f]\{6\}' app components` in `rs_dashboard/`.
