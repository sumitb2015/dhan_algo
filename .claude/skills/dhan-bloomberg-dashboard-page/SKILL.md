---
name: dhan-bloomberg-dashboard-page
description: Use when building or extending the landing Market Dashboard (rs_dashboard/components/MarketDashboard.tsx, the page at `/`) or any new page meant to look like a Bloomberg-style institutional terminal — dense multi-panel overviews with ticker strips, stat tiles, per-broker cards, and badges. Not for chart-driven analytics pages (dhan-quant-terminal-page) or order-entry tickets (dhan-terminal-polish) — this is the third visual genre: a scannable, non-chart overview screen.
---

# Dhan Bloomberg Dashboard Page

## Overview
`MarketDashboard.tsx` (the `/` landing page, shown right after login) is a
from-scratch visual language distinct from the other two dashboard styles:

- `dhan-quant-terminal-page` — chart-driven analytics pages built around `recharts`.
- `dhan-terminal-polish` — dense order-entry tickets (Scalper, FocusTool).
- **This skill** — a non-chart, panel-and-tile overview screen: ticker strips,
  stat tiles, progress bars, badges, and dense per-broker cards. Think a
  Bloomberg terminal home screen, not a chart page and not an order ticket.

**Reference implementation**: `rs_dashboard/components/MarketDashboard.tsx` +
`rs_dashboard/components/TerminalNavigationDirectory.tsx`. Read these first —
every convention below is extracted from them, and they're what a new panel on
this page (or a new page in this style) should visually match.

## When to Use
- Adding a new panel/section to the Market Dashboard.
- Building a new "terminal home screen" style overview page.
- Reviewing a change to `MarketDashboard.tsx` or `TerminalNavigationDirectory.tsx`
  for style-system consistency before it ships.

## The One Rule That Gets Broken Every Time

**Accent text colors stop at the `-400` step. Never `-500` or higher.**

`app/globals.css` only wires CSS variables for the `200`/`300`/`400` steps of
every accent color (emerald, red, amber, sky, indigo, violet, purple, orange,
yellow, lime, pink, teal, blue — see the `--color-<name>-2/3/400: var(--a-...)`
block). `zinc` is the only ramp with a full 50–950 chain. Reach for
`text-amber-500`, `text-emerald-500`, `text-sky-500`, etc. and Tailwind falls
back to its own **unthemed, hardcoded** swatch — it does not resolve through a
CSS variable at all. You can prove this in devtools: a themed
`text-amber-400` computes to a plain `rgb(...)` that changes between light and
dark; an unthemed `text-amber-500` computes to Tailwind's own `lab(...)`
color-space literal that never changes with the theme.

The failure mode is silent and cosmetic, not a crash — which is exactly why it
survives review. In dark mode `amber-500` still looks "orange enough" next to
tokenized `amber-400` siblings, so nobody notices. In light mode it becomes
visibly the WRONG orange — brighter and less contrasty than every neighboring
badge using the tokenized step — because it's not participating in the
light/dark swap at all.

This exact mistake recurred three times independently while this page was
being built (`MarketDashboard.tsx:1034` `text-emerald-500` on an online-status
dot, `MarketDashboard.tsx:1817` and `TerminalNavigationDirectory.tsx:560`, both
`text-amber-500` on section labels) despite the rest of both files — over 60
other amber/emerald/red/sky color usages — correctly capping at `-400`. It's
the single highest-value thing to grep for before shipping a change here:

```bash
grep -noE "text-(amber|emerald|red|sky|rose|orange|yellow|lime|teal|blue|green|pink|purple|violet|indigo)-(5|6|7|8|9)[0-9]{2}\b" \
  rs_dashboard/components/MarketDashboard.tsx rs_dashboard/components/TerminalNavigationDirectory.tsx
```
Any hit is a bug — replace the step with `-400` (or `-300` for a slightly
brighter/lighter emphasis variant, which IS tokenized).

Background and border colors don't have this problem the same way — `bg-amber-500/10`,
`border-emerald-500/30` etc. are used constantly and correctly throughout, because
CLAUDE.md's opacity exception is about *text*, not backgrounds/borders, and Tailwind's
raw `-500` swatch is close enough as a translucent fill/border tint that the
non-theming doesn't read as wrong the way solid text does. Keep using `-500/NN` for
backgrounds and borders; just never for solid text.

## Accent Colors Are Semantic, Not Decorative

This page uses a wider palette than the emerald/red-only convention on other
pages, but every color still means one specific thing — never pick one for
visual variety:

| Color | Meaning | Where |
|---|---|---|
| `amber-400` | The page's own chrome accent — panel titles, hairline rules, section eyebrows, "the terminal's own color" | Every `TerminalPanel` header, every micro-label |
| `emerald-400` | Positive direction / online / running | P&L up, BUY side, broker ONLINE, bot RUNNING |
| `red-400` | Negative direction / danger | P&L down, SELL side, high margin utilization |
| `sky-400` | CE (call) option leg | Contract type tag only |
| `amber-400` (2nd use) | PE (put) option leg | Contract type tag only — yes, PE reuses the chrome accent; don't invent a new color for it |
| `zinc-500`/`zinc-600` | Muted/secondary/offline | Field labels, OFFLINE badge, "no data" placeholders |

If you need a new semantic color (a new badge tone, a new regime indicator),
confirm it's one of the tokenized ramps in `globals.css` before reaching for it,
and pick a color that isn't already carrying a different meaning elsewhere on
this same page — VIX regime badges already use emerald/amber/red for
low/normal/high volatility, which happens to line up with the same colors used
for P&L direction one panel over. That's intentional (green=favorable,
red=risk, in both contexts) — preserve it rather than reassigning colors per-panel.

## Typography Scale

Everything is `font-mono` (Geist Mono, the `--font-geist-mono` var) for data —
numbers, tickers, badges, table cells — and the default `font-sans` (Inter) only
for a handful of plain prose labels (`<th>` header text, empty-state prose).
When in doubt, data gets `font-mono`; UI chrome text doesn't need it but isn't
wrong to have it either — most labels on this page do.

Sizes are all arbitrary-value Tailwind (`text-[Npx]`), not the default `xs/sm/base`
scale, because the default scale's steps are too coarse for how dense this page is.
The scale in actual use, smallest to largest:

| Size | Use |
|---|---|
| `text-[8px]` | The tiniest inline status pip (e.g. a bot RUN/IDLE tag inside an already-small card) |
| `text-[9px]` | Badge/pill text, `dl` `dt` labels inside cards |
| `text-[10px]` | The default "meta" size — most micro-labels, sub-values, footer telemetry |
| `text-[11px]` | Slightly emphasized secondary text — panel header meta, table-adjacent captions |
| `text-xs` (12px) | Table `<th>`/`<td>` body text, buttons, search input — anywhere CLAUDE.md's "12px minimum for a header" rule applies |
| `text-base` (16px) | Index strip LTP values, the page `<h1>` |
| `text-lg` (18px) | `StatTile` big numbers |
| `text-xl` (20px) | Breadth panel's advancing/declining counts — the single largest numbers on the page |

Micro-labels (`text-[9px]`/`text-[10px]`) are always paired with
`font-bold uppercase tracking-[0.14em]` to `tracking-[0.18em]` — that letter-spacing
is what keeps 9-10px text legible as a label rather than reading as a typo-sized
accident. Never use a micro-size without both the bold weight and the wide tracking.

## The Panel Shell (`TerminalPanel`)

Every content block on this page is one `<section>` with the exact same header
formula — copy `TerminalPanel` in `MarketDashboard.tsx` rather than
hand-rolling a new header:

```tsx
<section className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm">
  <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5">
    <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
      <Icon className="h-3.5 w-3.5 text-amber-400" />
      {title}
    </span>
    {/* optional badge, optional meta on the right in font-mono text-[11px] text-zinc-400 */}
  </header>
  <div className="flex-1 min-h-0">{children}</div>
</section>
```

The header border is `border-amber-500/25` (an opacity form — fine per the rule
above) — a hairline amber rule under every panel title is the single motif that
makes the whole page read as one instrument. Don't substitute `border-zinc-800`
here even though the panel's outer border uses it; the header rule is
deliberately the accent color, everything else is zinc.

If the panel title should link somewhere, wrap the heading in a `<Link>` with
`hover:text-amber-300` and append a small `<ExternalLink className="h-2.5 w-2.5" />`
— every linked panel title does this so a hover always previews as clickable.

## Nesting Depth = Darkness

The page has exactly three background darknesses, and they encode nesting, not
arbitrary variety:

1. `bg-zinc-950` — the page ground, and the innermost data cards (`StatTile`,
   the per-broker card body, the volatility metric cards).
2. `bg-zinc-900/70` — the panel shell itself (`TerminalPanel`'s `<section>`).
3. `bg-zinc-950/60` — the panel's own header strip (slightly darker than the
   panel body, so the title bar reads as a distinct band).

Table headers break this pattern deliberately: `<thead>` rows are
`bg-zinc-800` (lighter than the panel around them) with `text-white` — this is
CLAUDE.md's own global rule ("Table header style: `text-xs font-bold text-white`
on solid `bg-zinc-800`"), not specific to this page, and it stays that way here too.

## The Badge/Pill Formula

Every status tag, direction tag, and contract-type tag on this page is the same
shape — a bordered pill with a 10%-opacity fill of the same hue as the text and border:

```tsx
<span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold
                  border border-{color}-500/30 bg-{color}-500/10 text-{color}-400">
  {label}
</span>
```

`{color}` is one of the semantic colors above and its text step is always
`-400` (see the one rule). The border/bg step is conventionally `-500` (translucent,
so the non-tokenization doesn't matter) but `border-{color}-500/25` also appears —
either is fine, just stay consistent within one badge family (all ONLINE badges
use the same opacity, don't mix `/25` and `/30` for the same semantic badge type
across the page).

An OFFLINE/neutral variant of the same badge drops the color entirely:
`border-zinc-700 bg-zinc-800 text-zinc-500` (or `text-zinc-400` for slightly
less muted). Never invent a "neutral" tint by lightening a semantic color —
zinc is the only neutral.

## Stat Tiles

`StatTile` is the reusable big-number block for summary strips (portfolio
totals, VIX metrics):

```tsx
<div className="flex flex-col justify-between gap-1.5 rounded-lg border border-zinc-800
                bg-zinc-950 px-3.5 py-3 transition-colors hover:border-zinc-700">
  <div className="flex items-center justify-between">
    <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">{label}</span>
    {/* optional %-progress readout, font-mono text-[10px] font-semibold text-zinc-400 */}
  </div>
  <div className="font-mono text-lg font-bold leading-none tabular-nums {toneClass}">{value}</div>
  {/* optional progress bar: h-1.5 rounded-full bg-zinc-800, inner fill bg-amber-400 or a risk color */}
  {/* optional sub caption, font-mono text-[10px] text-zinc-500 */}
</div>
```

`toneClass` is one of `text-zinc-100` (neutral), `text-emerald-400` (up),
`text-red-400` (down), `text-amber-400` (accent/headline figure like total
portfolio value) — reuse the same `tone` prop pattern rather than inlining a new
conditional per tile.

Every numeric value on this page — stat tiles, table cells, ticker LTPs — carries
`tabular-nums` so columns of numbers align vertically as they update. Don't drop
this when adding a new numeric display.

## Tables

Standard dashboard table, per CLAUDE.md's global rule plus this page's spacing:

```tsx
<table className="w-full border-collapse text-left">
  <thead>
    <tr className="bg-zinc-800">
      <th className="px-3 py-2 text-xs font-bold text-white">Column</th>
      {/* text-right for numeric columns, text-center for tag/action columns */}
    </tr>
  </thead>
  <tbody className="divide-y divide-zinc-800 font-mono text-xs">
    <tr className="transition-colors hover:bg-zinc-800/50">
      <td className="px-3 py-2">…</td>
    </tr>
  </tbody>
</table>
```

`px-3 py-2` is this page's cell padding — denser than a 4-padding table, part of
the "zero-gap" density the page is going for. A `<tfoot>` subtotal row (see
`BrokerPositionsTable`) uses `border-t-2 border-zinc-700 bg-zinc-950 font-bold`
to visually separate itself from the body without needing a different color.

## Interaction States

- Hover on a card/row: `hover:bg-zinc-800/40` to `/50` (rows), or
  `hover:border-zinc-700` (cards that don't want a full background wash).
- Hover on a link/label: `hover:text-amber-300` (one step brighter than the
  resting `amber-400` — `amber-300` is tokenized, so this is safe).
- All color/background transitions: `transition-colors` (rows, cards, links);
  progress bar fills additionally get `transition-all duration-500` since their
  `width` animates too.
- Every interactive surface (badge-as-button, tab, search input) still needs a
  visible focus state for keyboard users — this page doesn't yet have a
  systematic answer for that beyond browser defaults; don't regress it further
  by adding `focus:outline-none` without a replacement ring.

## Icon Sizing

`lucide-react` icons scale with the text they sit next to, not a fixed size:
`h-2.5 w-2.5` (inline with 9-10px badge text), `h-3 w-3` / `h-3.5 w-3.5` (inline
with 10-11px labels, the most common size on this page), `h-4 w-4` (inline with
base-size text, loading spinners), `h-5 w-5` (the page's own header icon inside
its `h-9 w-9` accent-tinted square). Never use a `w-N h-N` pair where the
number implies pixels wider than the text baseline it sits on — a 5px icon next
to 9px text looks like a rendering glitch, not a design choice.

## Before You Ship

- Grep for un-tokenized `-500`+ text accent colors (command above) — this is
  the recurring mistake, check it every time.
- New panel? Use `TerminalPanel`, not a hand-rolled `<section>`.
- New badge? Match the bordered-pill-with-10%-fill formula, text step `-400`.
- New numeric value? `font-mono` + `tabular-nums`.
- New micro-label? Bold + uppercase + wide tracking, never bare.
- Does the new color you reached for already mean something else on this page?
