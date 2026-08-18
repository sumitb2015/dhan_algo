---
name: dhan-quant-terminal-page
description: Use when building a new rs_dashboard analytics page or redesigning an existing text/table-heavy one into the "quant-terminal" visual style — the chart-driven, dark-glass look already applied to Options Premium Bar, Futures, IV Charts, Straddle/Strangle Analysis, Breadth, and Live Charts.
---

# Dhan Quant-Terminal Page

## Overview
Six dashboard pages have independently converged on the same chart-driven redesign
(`feat(options-premium-bar): redesign as quant-terminal with volatility smile chart` and
five follow-on commits matching it). Each redo re-derived the same layout, tooltip, and
color conventions from scratch. This skill captures them so the next page starts from the
pattern instead of reinventing it.

**Reference implementation**: `rs_dashboard/components/OptionsPremiumBarPage.tsx` +
`OptionsPremiumBarTab.tsx` — read these first; they're the canonical example every later
redesign was built "to match."

## When to Use
- Building a new analytics/chart page for `rs_dashboard`.
- Asked to redesign an existing text/table-heavy page "to match Futures" / "quant-terminal
  style" / similar to Options Premium Bar.
- Not for operational pages (strategies, scalper order tickets, login) — this is for
  read-only analytics/chart surfaces.

## Structure

A quant-terminal page is two components:
1. **`<Name>Page.tsx`** — thin shell: owns page-level state (expiry/symbol/underlying
   selectors), fetches the option list, renders the sticky header, delegates the body to:
2. **`<Name>Tab.tsx`** (or multiple tabs) — the actual chart(s): data fetching for that
   view, `recharts` components, tooltips, stat tiles, view-mode toggle.

## Sticky Header (page shell)

```tsx
<div className="flex flex-col min-h-screen bg-zinc-950 text-white">
  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                  px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
    <div className="flex items-center gap-3">
      <div className="flex items-center justify-center w-8 h-8 rounded-lg
                      bg-emerald-500/10 border border-emerald-500/25 shrink-0">
        {/* 15x15 accent icon, text-emerald-400 (or the page's accent color) */}
      </div>
      <div>
        <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
          {/* eyebrow: domain · underlying, e.g. "Options · NIFTY" */}
        </p>
        <h1 className="text-sm font-bold text-white tracking-tight leading-none">{/* title */}</h1>
        <p className="text-[10px] text-zinc-500 font-medium mt-1">{/* one-line subtitle */}</p>
      </div>
    </div>
    <div className="flex items-center gap-2 flex-wrap">{/* expiry/mode selectors */}</div>
  </div>
  {/* error banner: bg-red-900/20 border-red-700/40 text-red-400 */}
  <div className="flex-1 flex flex-col gap-4 px-6 py-5">{/* tab content */}</div>
</div>
```

Remember CLAUDE.md's dashboard rules apply here too: a `DATA: YYYY-MM-DD` chip if the page
shows dated market data, and `text-xs font-bold text-white` on any `<thead>`.

## Chart Panel

Wrap each chart in a card: `bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5`
(`overflow-hidden` if it has a background glow/gradient). Standard `recharts` grid:

```ts
const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };
```

`<ResponsiveContainer width="100%" height={420}>` is the default chart height across the
existing pages — match it unless the content needs more.

## Tooltip

Custom tooltip component per chart (not the default recharts one):

```tsx
<div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs
                shadow-2xl backdrop-blur min-w-[180px] font-mono">
  {/* rows; separate sections with: pt-2 border-t border-zinc-800 flex justify-between gap-8 */}
</div>
```

Bar/area cursor: `cursor={{ fill: '#27272a', opacity: 0.5 }}`. Line cursor:
`cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}`.

## Color & Text Rules (inherited from CLAUDE.md — repeated here because it's easy to violate in chart code)

- **Never** use text opacity modifiers (`text-white/70`, `text-zinc-400/50`). Use the solid
  zinc scale: 100/200/300 body, 400 secondary, 500 muted, 600 very dim.
- Background/border opacity modifiers ARE fine and used constantly for the glass look:
  `bg-emerald-500/10`, `bg-zinc-900/60`, `border-emerald-500/25`, `bg-zinc-950/95 backdrop-blur`.
  This is a background-only exception — don't extend it to `<text>`/SVG fill on data labels
  either; use solid hex/token colors for chart series.
- Accent color signals domain, not brand: emerald for the default/options theme,
  indigo/purple for Live Charts, red/green (never opacity-modified) for P&L direction.
- View-mode toggles use a segmented control: `flex items-center gap-1 bg-zinc-900
  border border-zinc-800 p-0.5 rounded-lg` wrapping small pill buttons.

## Common Mistakes

- Building the chart directly inside the page shell instead of a separate `*Tab.tsx` —
  makes it harder to add a second tab later (see `OptionsPremiumBarPage` splitting page vs.
  tab, and pages like Options Analytics that host multiple tabs this way).
- Reaching for the recharts default `<Tooltip/>` instead of a custom `content=` component —
  it doesn't match the dark-glass style and reads poorly on `bg-zinc-950`.
- Forgetting `vertical: false` on `CartesianGrid` — vertical gridlines clutter these dense
  charts; every reference page omits them.
- Applying an opacity modifier to a text class instead of dropping to a dimmer solid zinc
  shade — this is the single most common regression when copying old table-style code into
  a new chart page.
