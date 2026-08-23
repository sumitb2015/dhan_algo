---
name: dhan-terminal-polish
description: Use when asked to improve the styling/layout/readability of a dense operational page (an order-placing terminal like FocusTool, Scalper, AdvancedScalper) rather than a read-only analytics page. Covers naming an ad hoc type scale, giving a flat control strip real visual grouping, and adding inline sparkline/gauge signature elements without a charting library or a new color palette. dhan-quant-terminal-page is the sibling skill for read-only chart pages — it explicitly excludes these.
---

# Dhan Terminal Polish (Operational Pages)

## Overview

`dhan-quant-terminal-page` covers redesigning a read-only analytics page into
the chart-driven "quant-terminal" look — and explicitly excludes "operational
pages (strategies, scalper order tickets, login)". Those pages have a
different brief: they're already information-dense and already skinned in the
shared zinc/violet token system (`dhan-theme-tokens`), and a full rebrand would
break consistency with the 50+ other pages under the same NavBar. What they
actually need is structural/typographic discipline plus content-appropriate
"signature" elements — captured here from `FocusTool.tsx`'s pass
(`f312197 style(focus-tool): typography scale, control-strip grouping,
sparkline + risk rail`).

**Reference implementation**: `components/FocusTool.tsx` — read `TXT_MICRO`/
`TXT_LABEL`/`TXT_VALUE`/`TXT_CAPTION`, `ControlStrip`, `Sparkline`, and
`RiskRail` first.

## When to Use

- Asked to improve styling/layout/color of an order-placing or control-heavy
  page (not a read-only chart/analytics page — that's `dhan-quant-terminal-page`).
- A control strip or toolbar has grown to 10+ unrelated controls in one flat
  row with no visual grouping.
- A table/panel shows a live numeric value where the user actually cares about
  *trend*, not just the current level (premium, spot, P&L).
- Font sizes in the file are a scatter of `text-[Npx]` arbitrary values with no
  naming.

## Stay Within the Existing Token System

Don't introduce new hex values or a new palette for one page. Grep the file for
its existing arbitrary micro font sizes first — they're usually already a
small, consistent set used inconsistently, not truly random:

```ts
// Name the scale that's already there instead of inventing a fifth value.
const TXT_MICRO   = 'text-[8px]';  // stat labels, column footnotes
const TXT_LABEL   = 'text-[9px]';  // field labels, badges — default micro size
const TXT_VALUE   = 'text-[10px]'; // secondary readouts
const TXT_CAPTION = 'text-[11px]'; // switch labels, primary compact inputs
```

Migrate existing lines to the constants only where a section is already being
touched for another reason — a mechanical file-wide find/replace on a
real-money page in one pass is not worth the regression risk for a
zero-visual-diff change.

## Give a Flat Control Strip Real Grouping

A control strip with several logical clusters (e.g. Positions / Risk / Copy
Trade) separated only by a `w-px` divider reads as one undifferentiated row.
Turn each cluster's existing wrapper `<div>` into a recessed card instead:

```
bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5
```

Use `zinc-950/40`, not `zinc-900/40`, when the strip's own background is
`bg-zinc-900` — the card needs to read as a *recess*, not blend into its
parent. Delete the `w-px` dividers once the cards provide the separation. If a
shared child component (e.g. a copy-trade control block reused by multiple
pages) renders its own leading divider as its first child, don't edit the
shared component — hide just that instance from the new card wrapper with
`[&>span:first-child]:hidden` (or similar), scoped to the one call site.

## Table Border Noise

If a table already has a supergroup header row (multiple `<th colSpan={n}>`
sections), individual `<td>` borders inside a table body should mark *only*
those supergroup seams — not every column. Drop borders that don't align to an
actual seam; they're usually leftover per-column styling that predates the
supergroup header. Recover the lost row-scanability with zebra striping
instead (`rowIndex % 2 === 1 && 'bg-zinc-900/20'`, bump hover to `/30` so it
still reads over the tint) rather than more borders.

## Signature Element: Inline Sparkline (No Charting Library)

For a live numeric cell where trend matters more than the instantaneous value
(a scalper reading momentum, not just level), a ~20-line inline `<svg>` beats
pulling in `recharts` for something this small — no dashboard page currently
has a lightweight inline trend indicator; every `recharts` usage in the repo
is a full-size chart.

- **History lives in a ref, sampled off its own slow `setInterval`** (not the
  live-tick/WS path) — sampling into a ref never triggers a render, and
  redrawing off a slower cadence than the tick rate keeps this from adding
  per-tick cost on a page that may already re-render every animation frame.
  Read the *latest* live values through a ref that's kept in sync on every
  render (`someRef.current = someSnapshot` directly in the render body — see
  `schedulerRef` in `FocusTool.tsx` — or a lightweight `useEffect`), not by
  closing over stale state in the interval.
- **The leaf sparkline component owns its own redraw timer** (a `useState`
  tick counter on its own `setInterval`), so only that small component
  re-renders on the sampling cadence — not its parent row.
- **Don't add UI-only history to a type shared across a language boundary.**
  If the page has a `RowLive`/similar type also consumed by a Python worker or
  tested via a shared fixture file, keep sparkline history entirely on the UI
  side, keyed by the same row id, never merged into that type.
- **Color by what actually answers the user's question**, not by the plotted
  value's own direction — a premium can rise while the position is *winning*
  (long) or *losing* (short). If the row already computes its own P&L, color by
  the sign of *that* value's trend and plot the raw value's shape; that's
  correct regardless of leg direction and reuses a number already computed.
- Render `null` below 2 samples — graceful, not an error state.

```tsx
function Sparkline({ history, colorSourceHistory }: { history?: number[]; colorSourceHistory?: number[] }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1500);
    return () => clearInterval(id);
  }, []);
  if (!history || history.length < 2) return null;
  // normalize to a small viewBox, <polyline stroke="currentColor" />,
  // wrap in a Tailwind text-color class so it's theme-correct for free.
}
```

## Signature Element: A Rail/Gauge Instead of Disconnected Numbers

When a page shows several related numbers with no visual relationship (a
target, a stop, a peak, a trail floor), a slim horizontal bar communicates the
relationship a row of labeled numbers can't: where the current value sits
between the two bounds. Scale to the real domain (which may not be
`[low, high]` as typed — e.g. a "stop" stored as a positive loss magnitude
means the domain is `[-stop, +target]`, not `[stop, target]`), handle the
unset/degenerate case explicitly (render a flat neutral state, don't crash or
divide by zero), and **keep the exact numbers as text next to the bar** — on a
real-money page the number matters more than the visual, so the bar is
supplementary, never a replacement.

## Reuse Before Building

`cn()`, existing `pnlClass`/`fmtInr`/`fmtValue`-style helpers, and the
project's `text-emerald-400`/`text-rose-400`/`text-amber-400`/zinc-ramp
classes already resolve correctly per-theme via `dhan-theme-tokens`'
`--a-*`/`--z-*` remapping — a new signature element built from these needs no
light/dark special-casing and no new hex value. If a component is
single-purpose with exactly one call site, declare it locally in the same file
near where it's used (this codebase's convention — see `SwitchToggle`,
`SegPill`, `LotStepper` in `FocusTool.tsx`) rather than extracting a new file.

## Common Mistakes

- Reaching for a full `recharts` chart for a 56×16px trend indicator — the
  bundle/complexity cost isn't worth it for something this small.
- Sampling or redrawing a sparkline off the same tick/render path as the rest
  of the row — defeats the point of decoupling it and can visibly worsen an
  already tick-bound page's performance.
- Treating a bounded value's "positive magnitude" storage convention as its
  plotting domain directly — check how the value is actually used elsewhere in
  the codebase (e.g. the rule-evaluation function) before assuming the sign.
- Rebranding a shared-token page instead of working within
  `dhan-theme-tokens` — breaks consistency with every other page under the
  same NavBar for no reason the brief asked for.
