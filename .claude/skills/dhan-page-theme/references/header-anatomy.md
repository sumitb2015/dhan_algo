# Page Header Anatomy

Measured over 78 pages (audit snapshot in `page-registry.md`): 86 files contain a `sticky top-0`, and the
page headers alone span five different anatomies, six eyebrow letter-spacings, four background opacities
and z-index 10 to 40. This file pins one standard and says when each variant is acceptable.

## Contents
1. The standard header (copy this)
2. Token-by-token rationale
3. Right-hand cluster order and NavBar placement
4. The DATA chip
5. Live-status idiom
6. Accepted variants (compact, terminal, legacy gradient)
7. Non-conforming shapes to fix when you touch them
8. Sub-tab strip (a second row, never a third)

## 1. The standard header
Root and header (a `PageHeader` version of this lives in `assets/PageHeader.example.tsx`):
```tsx
<div className="flex flex-col min-h-screen bg-zinc-950 text-white">
  <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap
                  px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
    <div className="flex items-center gap-3">
      <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0
                      bg-emerald-500/10 border border-emerald-500/25">
        <Activity className="w-4 h-4 text-emerald-400" />
      </div>
      <div>
        <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.16em] mb-0.5">Options · NIFTY</p>
        <h1 className="text-sm font-bold text-white tracking-tight leading-none">Page Title</h1>
        <p className="text-[10px] text-zinc-500 font-medium mt-1">One-line subtitle</p>
      </div>
    </div>
    <div className="flex items-center gap-2 flex-wrap">
      {/* selectors, view toggles, refresh */}
      {/* <DATA chip> */}
      <span className="w-px h-5 bg-zinc-800 shrink-0" />
      <NavBar />
    </div>
  </div>
  <div className="flex-1 flex flex-col gap-4 px-6 py-5">{/* body */}</div>
</div>
```
Wide table pages use `max-w-[1680px] w-full mx-auto` on the body wrapper (8 pages; 4 more use 1700px) and
keep `px-6 py-5`. Do not add left margin for the sidebar: `body` already has
`padding-left: var(--sidebar-w)` (`app/globals.css`), set by `Sidebar.tsx`.

## 2. Token-by-token rationale
| Token | Value | Why |
|---|---|---|
| position / z | `sticky top-0 z-30` | z-30 sits above in-page sticky strips (z-20) and table heads / chart overlays (z-10) and below the fixed sidebar (z-40) and every modal/drawer (z-50). A z-10 header can lose to a sticky `<thead>` or chart overlay at the same z-index that comes later in the DOM; z-40+ competes with the sidebar layer |
| surface | `bg-zinc-950/95 backdrop-blur` | 95 % keeps content from ghosting through; the 60 % / 80 % variants on ~14 pages let table rows show through text |
| border | `border-b border-zinc-800` | `border-zinc-850` is not a Tailwind step and silently does nothing (it appears ~49 times, including `Sidebar.tsx`); `border-zinc-900` is near-invisible on the page background |
| padding | `px-6 py-3` | matches the body wrapper's `px-6`, so the title aligns with the content edge |
| tile | `w-8 h-8 rounded-lg bg-<a>-500/10 border border-<a>-500/25`, icon `w-4 h-4 text-<a>-400` | flat accent tile: themes itself in both modes because `-400` and the `/10` fill flip; no `text-white` to get wrong |
| eyebrow | `text-[10px] font-bold uppercase tracking-[0.16em] text-<a>-400` | 0.16em is the measured majority (56 uses vs 25 for 0.18em); `-400` is themed, `-500` is not (see icons-and-accents.md) |
| title | `text-sm font-bold text-white tracking-tight leading-none` | ~20 of ~30 headings; `text-base` only in the gradient family |
| subtitle | `text-[10px] text-zinc-500 font-medium mt-1` | muted step, solid colour (never a text opacity modifier) |

Eyebrow copy is `Domain · Scope`: `Options · NIFTY`, `Analytics · Relative Strength`, `Portfolio · Weekly`.
The title says what the page is; the subtitle says what it answers, in one line.

**Tailwind cannot see interpolated class names.** `bg-${accent}-500/10` is never generated. Map an accent key to
literal strings (see `ACCENT` in `assets/PageHeader.example.tsx`) or the tile renders unstyled in production.

## 3. Right-hand cluster order and NavBar placement
Left to right: page selectors and toggles, refresh, live status, DATA chip, then a divider, then `<NavBar />`
last, so Sync Data / Update / Disconnect sit at the same screen position on every page.

Measured today: NavBar is last on 26 pages; it sits directly after the title with the controls pushed right by
`ml-auto` on 22 (the gradient-tile family: Breadth, Scanner, Portfolio, Distribution, Candlestick, Live, CSP);
mid-row on 4. Use "last" for anything new. When editing an existing `ml-auto` page, leave its order alone;
reshuffling it is churn, not a fix. Never render NavBar in a shared layout (`(options)/layout.tsx` was
emptied on purpose, commits `a9a768c`, `08b0c67`, `ff44171`).

## 4. The DATA chip
Required by CLAUDE.md on every page that shows stock or market data. Standard markup (the documented amber
pill, `dhan-dashboard-page`):
```tsx
<span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300
                 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
  DATA: {dataDate ?? '—'}
</span>
```
- Text is `DATA: YYYY-MM-DD`. When the data is not from today's session append ` · last session`
  (`data.is_today ? '' : ' (last session)'` exists on two pages; use the ` · ` form).
- Time-only chips (`DATA: 14:32:05 IST`) exist on live pages; keep the date chip and show the live time
  separately (section 5).
- Today there are ~12 text forms and ~8 class strings (zinc pill, amber pill, plain subtitle text). The amber
  pill is the documented one; zinc variants are drift.
- Amber means "metadata" here, not warning. A stale-data warning is a separate amber-bordered banner.
- Show the real data date (from the payload), never `new Date()`; `todayIso()` on four pages defeats the
  purpose of the chip.

## 5. Live-status idiom
Pages that tick show a pulse dot and the last tick time in the right cluster or the eyebrow row:
```tsx
<span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />{lastTickTime || 'LIVE'}
</span>
```
Stale or disconnected feed: same shape in `text-amber-400` / `bg-amber-400`, no `animate-ping`, text `STALE`.

## 6. Accepted variants
- **Compact (screeners, filter-heavy)**: `px-4 py-2`, tile `h-6 w-6 rounded-md`, icon `h-3.5 w-3.5`, title on one
  line `text-[14px] font-bold`, no eyebrow or subtitle (`Scanner`, `Advanced Scalper`). Use when the header must
  hold a universe picker plus filters.
- **Terminal (order-placing desks)**: `px-4 lg:px-6 py-2`, tile `w-7 h-7`, eyebrow is the tool name in caps
  (`CYBER SCALPER`), the `h1` row hosts live spot / change / MTM, DATA chip sits in the eyebrow row with a
  `LIVE` fallback (Cyber Scalper, Nifty Covered Call, Crude Oil Options). Density rules: `dhan-terminal-polish`.
- **Legacy gradient (about 15 pages)**: `h-9 w-9 rounded-xl bg-gradient-to-tr from-<a>-600 to-<b>-400` tile with a
  gradient-text `h1`. Do not use for new pages. When editing one, the icon must be `text-oncolor`, not
  `text-white` (the audit flags 15 pages: `text-white` resolves to `#0f172a` in light mode, a dark glyph on a
  saturated fill). Do not convert the whole header during an unrelated edit.
- The amber border (`border-amber-500/20`) on Landing, Baskets, Crude Options and Margin Allocator is a
  per-page tone, not a "live money" convention. Do not infer one.

## 7. Non-conforming shapes to fix when you touch them
- **Bare NavBar**: `<div className="min-h-screen ..."><NavBar />` with no title row (Trending OI, Volume
  Footprint, Nifty OI Profile). The page has no title, icon or sticky header. Add the standard header.
- **Compass home-link tile**: five Market Health pages (Highs/Lows, Sector Breadth, Market Regime, Stage
  Screener, Trend Confluence) use an amber `Compass` inside a `Link href="/"` as their icon. The page icon is
  therefore identical across five pages and the tile is an unlabelled link. The Sidebar already has Dashboard
  at the top; use a page-specific icon and drop the link.
- **z-index**: z-10 on 10 pages (e.g. Options Premium Bar, Option Cube, Level Chart, Markets, Movers) and z-40 on 3
  (Focus Tool, Synthetic Futures, Portfolio New).
- **No icon tile** (17 pages) and **no metadata title** (11 pages).

## 8. Sub-tab strip
A second row directly under the header is allowed (tabs, expiry stepper). Make it `sticky top-[<header-h>px] z-20`
only if the header height is fixed; otherwise let it scroll. A third sticky band is what the options layout
refactor removed. Tab styling: the segmented control in `shared-components.md`.
