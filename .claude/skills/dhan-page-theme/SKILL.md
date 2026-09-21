---
name: dhan-page-theme
description: The per-page theme standard for rs_dashboard - page header anatomy, header icon tile and accent colour, icon vocabulary and sizes, DATA chip, NavBar placement, z-index layering, page skeleton and metadata title, and the shared components and loading/empty/error/stale states every page must reuse. Use whenever the user adds a new dashboard page, restyles or "makes consistent" an existing page, asks why one page's header, icon, colours or spacing look different from the others, adds a header control, DATA chip, loading spinner, error banner, modal or tooltip, picks an icon or accent colour for a page, or asks to audit the pages for theme consistency. Includes an audit script and a dated per-page registry. Not for chart internals (dhan-quant-terminal-page), the landing dashboard (dhan-bloomberg-dashboard-page), dense order terminals (dhan-terminal-polish), the palette itself (dhan-theme-tokens) or sidebar links (dhan-sidebar-nav).
---

# Dhan Page Theme

Every page in `rs_dashboard` should read as one product: same header, same icon language, same states. Today
they do not. The audit of 78 pages found five header anatomies, z-index from 10 to 40, six eyebrow letter
spacings, the same lucide icon heading up to eight unrelated pages, three pages with no title row at all, and
eleven with no browser-tab title. This skill pins one standard, tells you which variants are acceptable, and
ships the audit so drift is measurable instead of remembered.

## How to use it
1. **New page**: follow "Build a page" below, using `assets/PageHeader.example.tsx`.
2. **Editing an existing page**: match that page's family (`references/page-registry.md`). Fix only the
   deviations in code you are already changing; do not restyle a header during an unrelated edit.
3. **Consistency pass**: run the audit, fix the flagged rows you own, re-run.
```bash
cd rs_dashboard && python3 ../.claude/skills/dhan-page-theme/scripts/audit_pages.py            # table
python3 ../.claude/skills/dhan-page-theme/scripts/audit_pages.py --only TILE_WHITE             # one flag
```
The audit is a regex heuristic: a flagged row means "go and look".

## Build a page
1. **Thin server `page.tsx`** exporting `metadata.title` (page name only; the layout adds ` | Dhan Algo`), rendering
   one `'use client'` component. A client `page.tsx` cannot export `metadata`; that is why 8 pages have no tab
   title.
2. **Pick the accent by domain** (below), and the icon by the page's *subject*. Search the audit for a free icon.
3. **Root** `flex flex-col min-h-screen bg-zinc-950 text-white`, then the **standard header**, then a body
   `flex-1 flex flex-col gap-4 px-6 py-5` (add `max-w-[1680px] w-full mx-auto` for wide tables).
4. **Header contents, left to right**: accent icon tile, eyebrow (`Domain · Scope`), title, subtitle; on the right
   the page's selectors and refresh, the `DATA:` chip, a divider, then `<NavBar />` last.
5. **Implement all five states** (first load, refreshing, empty, error, stale) with the shared markup.
6. **Check both themes** with the toggle and run `npx tsc --noEmit`.

## The standard in one screen
```tsx
<div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap
                px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
  <div className="flex items-center gap-3">
    <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
      <Activity className="w-4 h-4 text-emerald-400" />
    </div>
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Options · NIFTY</p>
      <h1 className="text-sm font-bold text-white tracking-tight leading-none">Title</h1>
      <p className="text-[10px] text-zinc-500 font-medium mt-1">One-line subtitle</p>
    </div>
  </div>
  <div className="flex items-center gap-2 flex-wrap">
    {/* controls */} {/* DATA chip */}
    <span className="w-px h-5 bg-zinc-800 shrink-0" />
    <NavBar />
  </div>
</div>
```
Why each token is what it is: `references/header-anatomy.md`.

## Non-negotiables (each one is a measured, recurring defect)
- **`z-30` for the page header.** Scale: `z-10` thead/overlays, `z-20` sub-strips, `z-30` header, `z-40` Sidebar,
  `z-50` modals/toasts. Headers at z-10 (10 pages) and z-40 (3 pages) collide with table heads or the sidebar.
- **`NavBar` last, inside the header, never in a layout.** No page may render it bare above the content (Trending OI,
  Volume Footprint, Nifty OI Profile do, and so have no title, icon or sticky header).
- **`border-zinc-800`, not `border-zinc-850`** (not a Tailwind step: silently no border) and not `-900`.
- **Accent text is `-400`.** Only `-200` to `-400` accent steps are themed; `-500`/`-600` text looks the same in dark
  and white mode (19 pages do this, mostly eyebrows).
- **On a saturated fill use `text-oncolor`, never `text-white`.** `text-white` flips to `#0f172a` in white mode; 15
  pages put it on a gradient tile.
- **Accent classes are literal strings.** `bg-${accent}-500/10` is not generated by Tailwind. Use a lookup map.
- **`DATA: YYYY-MM-DD` chip** on every page with dated market data, from the payload's date, amber pill (markup in
  `header-anatomy.md` section 4). Not `new Date()`.
- **Icon = lucide-react only**, a control icon is never a page icon (`RefreshCw`, `Play`, `ChevronLeft`), and no
  page reuses its Sidebar group's icon.
- **One sidebar home per page.** Do not use the Compass "home link" tile (5 Market Health pages do): give the page
  its own icon; the Sidebar already links Dashboard.
- **Modal backdrop `bg-oncolor-dark/NN` at `z-50`**; `bg-black/NN` stops dimming in white mode.
- **No text opacity modifiers** (`text-white/70`); use `text-zinc-100`..`-600`. Background opacity is fine.

## Accent = domain
`emerald` is the default (options and derivatives analytics, equity analytics, trading terminals, algo). Use the
others only for their domain: `sky` index/futures/market structure, `amber` commodities/pre-market/journal/goals,
`indigo` portfolio and account, `violet` trading desks, `purple` rotation, `blue` volatility. P&L colour is
separate: emerald-400 / red-400 on the *values*, never a tint on a whole card. Full table and the icon vocabulary
(which icon means refresh, warning, close, fullscreen...) in `references/icons-and-accents.md`.

## Variants you may meet
| Variant | When | Notes |
|---|---|---|
| Standard (flat tile) | default for new pages | above |
| Compact | filter-heavy screeners (Scanner) | `px-4 py-2`, `h-6 w-6` tile, one-line title |
| Terminal | order-placing desks (Cyber Scalper, Covered Call) | eyebrow = tool name in caps, live spot/MTM in the title row |
| Legacy gradient (~15 pages) | edit in place only | keep `ml-auto` layout; fix the icon to `text-oncolor` |
Details and the exact class strings: `references/header-anatomy.md` section 6.

## Shared pieces (reuse before writing)
`NavBar` (75 files), `ui/tooltip` for every icon-only button (Base UI: use `render=`, not `asChild`), `ui/button`,
`ui/badge`, `ui/sheet`/`ui/drawer` for side panels, `sonner` toasts (mounted once in the layout), `ui/skeleton`
(unused today while 99 `animate-pulse` divs are hand-rolled), the segmented control and the five page states in
`references/shared-components.md`. Ten pages define their own `StatTile`; copy the Bloomberg skill's markup and
extract a shared one on the third use, do not write an eleventh.

## Related skills
`dhan-quant-terminal-page` (chart panels, tooltips), `dhan-bloomberg-dashboard-page` (landing, stat tiles),
`dhan-terminal-polish` (dense order terminals), `dhan-theme-tokens` (palette mechanics), `dhan-a11y-controls`
(focus ring, aria-labels), `dhan-commit-on-blur` (free-typed inputs), `dhan-sidebar-nav` (adding the nav link),
`dhan-dashboard-page` (routes, spawn-a-script pattern).

## Files
- `references/header-anatomy.md`: full header standard, token rationale, DATA chip, live status, variants, shapes to fix.
- `references/icons-and-accents.md`: icon rules and sizes, semantic vocabulary, collisions with suggested icons, accent map, themed colour steps.
- `references/shared-components.md`: page skeleton, z-index scale, component usage, controls, five page states, modals and toasts.
- `references/page-registry.md`: dated per-page snapshot (route, component, tier, icon, accent, z, flags).
- `assets/PageHeader.example.tsx`: type-checked reference component (not wired into the app).
- `scripts/audit_pages.py`: read-only audit that regenerates the registry.
