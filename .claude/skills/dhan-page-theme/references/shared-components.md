# Shared Components, States and Page Skeleton

## Contents
1. Page skeleton (`page.tsx` + client component)
2. Layering: the z-index scale
3. What exists, and how much it is used
4. Controls: buttons, segmented control, tooltips
5. Page states: loading, refreshing, empty, error, stale
6. Modals, drawers, toasts
7. Repeated local components (do not add another copy)

## 1. Page skeleton
```tsx
// app/<route>/page.tsx  (server component: no 'use client')
import type { Metadata } from 'next';
import Foo from '@/components/Foo';

export const metadata: Metadata = { title: 'Foo' };   // layout template appends " | Dhan Algo"

export default function FooPage() { return <Foo />; }
```
`components/Foo.tsx` starts with `'use client'` and renders the root + header + body from `header-anatomy.md`.
- **A `'use client'` `page.tsx` cannot export `metadata`.** That is why 8 pages have no tab title: nifty-oi-profile,
  options-monitor, performance, reports, strategies, strategies-plus, trending-oi, volume-footprint (all fat
  client pages of 450 to 1830 lines with the UI inline). The other 3 (`backtest*`) are thin pages that just
  omit it. Fix by extracting the body to a component and leaving a thin server page.
- Title text is the page name only, no suffix. `metadata.title` in the layout is `template: '%s | Dhan Algo'`.
- Root wrapper: `flex flex-col min-h-screen bg-zinc-950 text-white` (17 uses; `text-zinc-100` is also seen,
  pick one per page and keep it).
- Body wrapper: `flex-1 flex flex-col gap-4 px-6 py-5`; wide-table pages add `max-w-[1680px] w-full mx-auto`.
- Do not offset for the sidebar; `body` has `padding-left: var(--sidebar-w)`.
- Route-group `loading.tsx` exists for `(options)`; add one only if the route fetches on the server.

## 2. Layering: the z-index scale
Measured on `fixed`/`sticky` elements: z-50 (64), z-10 (57), z-30 (27), z-20 (23), z-40 (6).
| z | Owner |
|---|---|
| `z-10` | sticky `<thead>`, chart overlays, floating chips inside a card |
| `z-20` | in-page sticky strips (tab row, filter bar) below the page header |
| `z-30` | **page sticky header** |
| `z-40` | `Sidebar` (fixed, left) |
| `z-50` | modals, drawers, sheets, popovers, dropdowns, toasts |
Nothing between 30 and 40 is needed. The one accepted step above 50 is `z-[60]`, for a modal opened from inside a
z-50 sheet (`UpdateAppPanel`). If you reach for `z-[999]`, the parent stacking context is wrong.

## 3. What exists, and how much it is used
Files importing each (of ~165 components + 78 pages):
| Component | Files | Use it for |
|---|---|---|
| `NavBar` | 75 | last item in every page header (Sync Data, Update, Disconnect, theme toggle) |
| `ui/button` | 20 | dialog actions, forms; shadcn semantic tokens (`bg-primary`) |
| `ui/tooltip` | 17 | every icon-only control |
| `ui/badge` | 15 | status pills that fit its variants |
| `BrokerSelector` | 31 | broker choice on scalper and strategy pages |
| `ui/card` | 9 | grouping when a plain panel is not enough |
| `ui/select`, `ui/input`, `ui/toggle-group`, `ui/tabs` | 4 to 7 | forms and mode switches |
| `Spinner` | 4 | tiny inline spinner (hard-codes `border-t-sky-400`) |
| `ui/skeleton` | **0** | placeholder blocks (themed via `bg-muted`); 99 hand-rolled `animate-pulse` divs exist instead |
| `DayChangeChip`, `LogConsole`, `AnimatedNumber` | 2 to 3 | one job each; reuse rather than restyle |
The UI kit is built on **Base UI** (`@base-ui/react`), not Radix: use the `render` prop, not `asChild`:
```tsx
<Tooltip>
  <TooltipTrigger render={<button aria-label="Refresh" className="..." />}>
    <RefreshCw className="h-3.5 w-3.5" />
  </TooltipTrigger>
  <TooltipContent>Refresh</TooltipContent>
</Tooltip>
```
`TooltipProvider` is mounted once in `app/layout.tsx`.

## 4. Controls
Header action button (secondary; Premarket's Refresh is the reference):
```tsx
className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-100
           bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg transition-colors
           cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
```
Accent action (primary: opens a guide, starts a scan): `border border-<a>-500/30 bg-<a>-500/10 text-<a>-300
hover:bg-<a>-500/20 rounded-lg` with the page accent written out literally. Destructive: `border-red-500/30
bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-oncolor`. Any button that places an order, exits a position or
starts a process also follows `dhan-commit-on-blur` and `dhan-a11y-controls` (focus ring, `aria-label`).

Segmented control (4 near-identical class strings exist today, use this one; 28 uses):
```tsx
<div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
  {items.map(i => (
    <button key={i.key} onClick={() => set(i.key)} aria-pressed={value === i.key}
      className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all',
        value === i.key ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
      {i.label}
    </button>
  ))}
</div>
```
Active fill uses the page accent (`bg-amber-500/15 text-amber-400 border-amber-500/25` on Weekly Target).

Table header: `text-xs font-bold text-white` on solid `bg-zinc-800` (CLAUDE.md). `sticky top-0 z-10` on a
scrolling table's `<thead>`, never on the page header's z.

## 5. Page states
Every data page has all five; missing ones show as blank panels. Use solid steps, no text opacity.
| State | Markup |
|---|---|
| First load | centered `Loader2 h-6 w-6 animate-spin text-emerald-400`, title `text-zinc-200 font-semibold`, hint `text-[11px] text-zinc-500` with the expected wait ("first load of an expiry can take ~10 s") |
| Refreshing | keep the old data on screen; header `RefreshCw h-3.5 w-3.5` gets `animate-spin`; never blank the panel |
| Placeholder | `<Skeleton className="h-4 w-24" />` from `ui/skeleton` for tiles and table rows |
| Empty | centered icon `h-6 w-6 text-zinc-600`, sentence `text-sm text-zinc-400` that names the filter to loosen, optional `text-[11px] text-zinc-500` hint |
| Error | `flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400` with `AlertTriangle h-3.5 w-3.5 shrink-0 mt-0.5`; show the server's `error` string, and keep the last good data below it |
| Stale | same shape in `amber` (`border-amber-500/30 bg-amber-500/10 text-amber-300`) with the data's timestamp |
Several red banner class strings exist today; this is the modal one. "Failed" and "no data" are different
states (`dhan-polling-guards` #7): an empty array from a failed fetch must render the error, not the empty text.

## 6. Modals, drawers, toasts
- Backdrop `fixed inset-0 z-50 bg-oncolor-dark/70` (37 uses at /60 to /80). `bg-black/NN` becomes a near-white
  wash in light mode (still in `OptionsBacktester.tsx` twice, `bg-black/40`: fix on contact). A full-screen chart
  ground (`bg-black` in `PayoffDiagram`, `PositionsPayoffChart`) is fine: it is meant to be the page ground. Panel `bg-zinc-900 border border-zinc-800
  rounded-2xl`. Close with `X` (`aria-label="Close"`) and Escape.
- Prefer `ui/sheet` or `ui/drawer` for side panels (`DataRefreshPanel`, `UpdateAppPanel` show the pattern).
- Toasts: `sonner` (`toast.success` 10, `toast.error` 9); `<Toaster>` is mounted in `app/layout.tsx`, do not mount
  another. Use a toast for the outcome of an action, a banner for a state of the page.

## 7. Repeated local components (do not add another copy)
Defined again and again inside page files: `StatTile` (10), `Section` (3), `Metric` (3), `StatCard` (2),
`SectionCard` (2), `Badge` (2), plus per-file `TH`/`TD`. Before writing an eleventh `StatTile`, copy the markup
from `dhan-bloomberg-dashboard-page` ("Stat Tiles"), and if a third page needs it, extract one to
`components/ui/` in the same change and migrate the caller you are editing. `HelpTooltip` exists only inside
`BreadthAnalysis.tsx`; use `ui/tooltip` elsewhere.
