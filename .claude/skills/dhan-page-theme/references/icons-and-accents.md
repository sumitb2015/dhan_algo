# Icons and Accent Colours

## Contents
1. Icon rules
2. Sizes
3. Semantic icon vocabulary
4. Page icons: what exists, what collides
5. Accent = domain
6. Themed vs un-themed colour steps
7. Tile recipes

## 1. Icon rules
- **`lucide-react` only** (147 files import it; no other icon library is installed). Import named icons:
  `import { Activity } from 'lucide-react'`. Installed version 1.35.0.
- One icon per page, chosen from the page's *subject*, not its category. The Sidebar icons name **groups**
  (`Equity` TrendingUp, `Derivatives` Layers, `Options Analysis` LineChart, `Trading` Zap, `Market Health`
  Activity, `Algo` Cpu, plus Portfolio); a page must not reuse its own group's icon, or the header looks like
  the nav.
- Chrome uses lucide, not emoji. (36 files contain emoji or dingbats; the sort arrows `▲ ▼ ⇅` in table
  headers are the accepted exception. Do not add others to headers, buttons or tiles.)
- Decorative icons get no label. An **icon-only button** needs `aria-label` (and `title`); see
  `dhan-a11y-controls`.
- Icons inherit `currentColor`. Colour them with a themed text step (`text-emerald-400`), never a hex, and on
  a saturated fill use `text-oncolor`.

## 2. Sizes
Measured over ~900 sized icons: `3` (300), `3.5` (292), `4` (202), then `5`/`6` (55) and `8` (16).
| Where | Size |
|---|---|
| Inside a dense row, chip, table cell | `h-3 w-3` |
| Inside a button or control | `h-3.5 w-3.5` |
| Header tile glyph | `w-4 h-4` (compact tier `h-3.5 w-3.5`) |
| Empty / loading hero | `h-5 w-5` to `h-6 w-6`, `text-zinc-600` (empty) or accent-400 (loading) |
Use the Tailwind size classes; `size={13}` (17 uses) drifts from the scale.

## 3. Semantic icon vocabulary
The same action must be the same icon on every page. Frequencies are imports across `components/`:
| Meaning | Icon | Notes |
|---|---|---|
| Refresh / re-fetch | `RefreshCw` (41) | `animate-spin` while loading |
| Pending, first load | `Loader2` (19) | `animate-spin`, accent-400 |
| Stale, caution, warning | `AlertTriangle` (26) | amber |
| Error, failure | `AlertCircle` (10) | red |
| Risk, protection | `ShieldAlert` (6) | |
| Close, remove | `X` (25) | |
| Add | `Plus` (14) | |
| Delete | `Trash2` | destructive: red hover |
| Expand / collapse | `ChevronDown` / `ChevronUp` | |
| Direction | `TrendingUp` / `TrendingDown` | with emerald-400 / red-400 |
| Fullscreen | `Maximize2` | Fullscreen API on the panel, see `dhan-plotly-3d-scene` |
| Filter / settings | `SlidersHorizontal` / `Settings` | |
| Export | `Download` | |
| Search | `Search` | |
| Start / stop | `Play` / `Square` | strategy and scalper controls |
| Undo / reset | `RotateCcw` | |
| Help / guide | `BookOpen` | opens a guide or playbook modal |
| Sync data | `DatabaseZap` | NavBar only |
| Update app | `GitPullRequest` | NavBar only |
A control icon is never a page identity: do not put `RefreshCw`, `ChevronLeft`, `Play` or `ExternalLink` in the
header tile.

## 4. Page icons: what exists, what collides
Regenerate the live table with `scripts/audit_pages.py`; `page-registry.md` is a dated snapshot. Collisions
today (same lucide icon heading 3 or more pages):
| Icon | Pages | Suggested distinct icons (verified to exist in 1.35.0; not applied) |
|---|---|---|
| `Layers` x8 | Option Analyzer, Batman Matrix, Net Delta, Straddle Matrix, RS Scanner, Ultimate Scanner, Reports, Strategies, Strategies+ | Analyzer `ListFilter`, Batman `AudioWaveform`, Net Delta `Scale`, Straddle Matrix `Crosshair`, RS Scanner `Radar`, Ultimate Scanner `ScanSearch`, Reports `FileBarChart`, Strategies `Cpu`, Strategies+ `Workflow` |
| `Activity` x5 | Breadth, Distribution, Futures, Live, Strangle Matrix | Distribution `Sigma`, Futures `CandlestickChart`, Live `Waves`, Strangle Matrix `Grid3x3` |
| `Compass` x5 | Highs/Lows, Sector Breadth, Market Regime, Stage Screener, Trend Confluence | Highs/Lows `Mountain`, Sector Breadth `LayoutGrid`, Market Regime `Gauge`, Stage Screener `Telescope`, Trend Confluence `Combine` |
| `Terminal` x3 | Cash Secured Puts, CSP Screener, Equity Watchlist | CSP `Landmark`, CSP Screener `Coins`, Watchlist `PiggyBank` |
Rules of thumb when picking: search the audit first (`--only DUP_ICON`), choose an icon nobody uses, and check
it exists (`grep -w Name node_modules/lucide-react/dist/lucide-react.d.ts`). `npx tsc --noEmit` rejects a
missing name; skip it and the page dies at runtime with "Element type is invalid".

## 5. Accent = domain
An accent names the *domain* of a page and stays constant across that page's header tile, eyebrow, active
pills and focus rings. It is not decoration and it never encodes a value.
| Accent | Domain | Pages today |
|---|---|---|
| `emerald` (default) | options and derivatives analytics, equity analytics, algo and trading terminals | 22 tiled pages: the options-analytics family, Seasonality, Terminal, Cyber Scalper, Covered Call, Ultimate Scanner, Breadth, Scanner |
| `sky` | index, futures and live market-structure | Futures, Markets, Straddle Matrix, Normalized |
| `amber` | commodities, pre-market, journal, goals | Crude Oil Options, Premarket, Trader's Diary, Weekly Target, RS Scanner |
| `indigo` / `violet` | portfolio and account (indigo), trading desks (violet) | Portfolio, Trade P&L, Level Chart (indigo); Focus Tool, Distribution (violet) |
| `purple` | rotation | RRG (pulse dot and mode pills only; it has no tile) |
| `blue` | volatility | IV Charts |
Another 11 pages use a neutral `bg-zinc-900` tile and 25 have no tile at all, so their accent is undefined.
Use emerald unless the page clearly belongs to another row. Do not invent a new hue for one page.
**P&L colour is separate**: profit `text-emerald-400`, loss `text-red-400` on the values only. An emerald page
accent and a green profit number coexist by design, so never tint a whole tile or card by P&L sign.
Amber is also the "attention" hue: a page with an amber accent needs a visibly different warning banner
(border + `AlertTriangle`).

## 6. Themed vs un-themed colour steps
`app/globals.css` re-points only some accent steps per theme: `-300` and `-400` for every accent family, plus
`-200` for emerald, green, red, rose, amber, yellow, sky, blue, indigo and violet. **`-500` and `-600` text is
not themed**, so it looks identical in dark and white mode (and low-contrast in white mode):
| Use | OK | Not OK |
|---|---|---|
| Accent text (eyebrow, active label, icon) | `text-emerald-400` | `text-emerald-500` (11 eyebrows), `text-amber-500` |
| Tile fill | `bg-emerald-500/10 border-emerald-500/25` | solid `bg-emerald-600` behind a `text-white` glyph |
| Saturated gradient fill | `from-emerald-600 to-cyan-400` + `text-oncolor` glyph | `text-white` glyph |
`text-white` and `bg-black` are tokens that flip (`#0f172a` / `#f8fafc` in light mode); they mean "brightest
text" and "page ground", not literal white and black. See `dhan-theme-tokens`.

## 7. Tile recipes
Flat (standard):
```tsx
<div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sky-500/10 border border-sky-500/25">
  <CandlestickChart className="w-4 h-4 text-sky-400" />
</div>
```
Neutral (only for a tile that is itself a control): `bg-zinc-900 border border-zinc-800 text-zinc-400
hover:text-white hover:border-zinc-700`.
Gradient (legacy, edit-in-place only): `h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-cyan-400
shadow-lg shadow-emerald-500/10` with `<Icon className="h-4 w-4 text-oncolor" />`.
