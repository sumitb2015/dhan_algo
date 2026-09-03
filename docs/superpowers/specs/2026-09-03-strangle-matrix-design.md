# Live Strangle Matrix — Design Spec

_Date: 2026-09-03_

## Context

Ultimate Scanner surfaces individual candidate strategies one scan at a time. Traders selling
strangles want a denser, always-on view: a single table with ATM-offset strangles down the rows
and every near-term expiry across the columns, refreshing live so they can eyeball which
offset/expiry combo currently pays the best RoM% without re-running filters. This is distinct
from the existing `/strangle-analysis` page, which shows *historical* premium statistics (poll-once,
one expiry regime) rather than live current premiums across multiple expiries.

## Data Source & Live Mechanism

The existing live options WS bridge (`scripts/tools/live_options_ws.py`, via `/api/options/live`)
only subscribes to one `--underlying --expiry` pair per running process — it cannot cover 4
expiry columns simultaneously without running 4 separate bridge processes. Given the poll-vs-WS
tradeoff, this page uses a **REST poll every 4 seconds** instead: the same architecture Ultimate
Scanner already uses for its own "live" chain data, reusing `fetchUnderlyingChain` /
`fetchUnderlyingExpiries` from `lib/ultimateScannerDhan.ts`. No new Python process is spawned.

RoM% uses the same **flat per-strategy margin estimate** Ultimate Scanner uses for its bulk
candidate list (not the live-margin-calculator enrichment added for Scanner's top-12 results) —
computing real netted margin per cell at this poll rate (up to 10 rows × 4 columns = 40 cells,
every 4s) is infeasible against Dhan's ~1 req/s margin-calculator rate limit. This is the same
known estimate-vs-real gap already documented on `ScannedStrategy.marginSource` in the Scanner;
this page does not attempt to close it.

## Shared Strangle Math (dedup)

`ultimateScannerEngine.ts`'s short-strangle candidate generation (net credit, flat margin
estimate, RoM%, RoM annualized, POP, risk tier, breakevens) is extracted into a new pure function:

```ts
// lib/strangleMath.ts
export function computeStrangleAtOffset(params: {
  underlying: UnderlyingType;
  atmStrike: number;
  offset: number;         // 1..N
  step: number;           // STRIKE_STEPS[underlying]
  spot: number;
  dte: number;
  vix: number;
  chainQuotes: Record<number, ChainStrikeQuote>;
  lotSize: number;
}): StrangleCell | null   // null when either leg's quote is missing/illiquid
```

`ultimateScannerEngine.ts`'s existing symmetric-offset loop (the one at line ~447, "Systematic
symmetric & near-symmetric strangles") is refactored to call this function instead of inlining the
math, so both the Scanner and this new page share one source of truth — no behavior change to the
Scanner.

`StrangleCell` fields: `strike (put/call)`, `netPremium (₹)`, `netPremiumPoints`, `romPct`,
`romAnnualizedPct`, `distancePct`, `popPct`, `riskTier`, `breakevens`.

## Architecture

### 1. API route — `app/api/options/strangle-matrix/route.ts`

`GET ?underlying=NIFTY`:
1. `fetchUnderlyingExpiries(underlying)` → take the first 4.
2. `Promise.all` the 4 `fetchUnderlyingChain(underlying, expiry)` calls (same concurrent pattern
   as `scan/route.ts`).
3. For each expiry × offset 1..15 (max row count the UI slider allows — see below), call
   `computeStrangleAtOffset`. Server always computes the full 1..15 range; the row-count slider is
   a client-side slice, so changing it doesn't require a re-fetch.
4. Return `{ success, underlying, spot, expiries: [{expiry, dte}], rows: [{offset, cells: [StrangleCell | null, ...]}] }`.

No Python process spawned beyond the existing chain-fetch script; reuses `dedupe`/`spaced` pacing
from `lib/pyExec.ts` already applied inside `fetchUnderlyingChain`/`fetchUnderlyingExpiries`.

### 2. Client polling — `components/StrangleMatrixPage.tsx`

- Polls the route every 4s via `setInterval`, **paused when `document.hidden`** (per this repo's
  polling-guard convention — resumes and immediately refetches on visibility regain).
- Request-sequencing guard (same pattern as Scanner's `scanRequestId`) so a slow response can't
  overwrite a newer one.
- No AbortController/Stop button needed — poll interval, not a long-running scan.

### 3. Page — `app/options/strangle-matrix/page.tsx`

Thin wrapper rendering `<StrangleMatrixPage />`, following the `app/ultimate-scanner/page.tsx`
pattern.

### 4. Navigation

Add to `NavBar.tsx`'s "Options Analysis" group: `{ href: '/options/strangle-matrix', label: 'Live Strangle Matrix', desc: 'Live ATM-offset strangle premiums across expiries, ranked by RoM%' }`.

## UI Design

Dark-glass quant-terminal shell (matching Ultimate Scanner / other analytics pages) — zinc-950
background, zinc-900/800 cards, no new colors introduced (existing zinc/emerald/cyan/amber/red
token system only, per CLAUDE.md).

### Header

- Sticky bar: title, `DATA:` chip (last poll timestamp), underlying toggle (NIFTY/SENSEX).
- Filters row: offset-row-count slider (1–15, default 10), Min RoM% cutoff, Risk Profile chips
  (conservative/moderate/aggressive/all — reusing Scanner's POP-based tiers), Min/Max Distance%
  OTM (clamps the effective offset range shown, since distance is a direct function of offset ×
  step / spot).
- Threshold inputs: "Good" RoM% and "Great" RoM% (defaults 1.0% / 2.5%) driving conditional
  formatting.
- Small pause/resume toggle for the poll (in case a trader wants to freeze the table mid-look).

### Table

- Rows: `ATM+N` label, put/call strike pair, live distance% — one row per offset within the
  slider's range and the Min/Max Distance filter. Distance% is a function of live spot (via
  `computeStrangleAtOffset`'s `distancePct`), not a fixed property of the offset, so which rows
  the Min/Max Distance filter admits can shift slightly poll-to-poll as spot moves — expected
  behavior, not a bug.
- Columns: one per expiry (date + DTE badge in the column header).
- Cell: `₹{netPremium}` bold, `{romPct}%` secondary line, tabular-nums, matching Scanner card
  metric styling.
- Conditional formatting (background tint, all within existing emerald/zinc/red tokens):
  - Missing/stale quote → `bg-zinc-900/40` with a small "—" placeholder, no premium/RoM shown.
  - Fails Risk Profile filter → `bg-zinc-900/60`, muted text (zinc-500), not colored — a hard
    exclusion, not just a weak signal.
  - Passes filters but RoM% < Min RoM cutoff → neutral zinc card, normal text.
  - RoM% ≥ "Good" → `bg-emerald-500/10` tint.
  - RoM% ≥ "Great" → `bg-emerald-500/20` tint, bolder text.
- Row/column hover highlight (light zinc-800/40) for scanning across a row or down a column.

## Verification

1. `cd rs_dashboard && npm run dev`, navigate to `/options/strangle-matrix`.
2. Confirm the table renders with 4 expiry columns and the default 10 offset rows, all cells
   populated (no perpetual "—" once the first poll completes).
3. Watch two consecutive poll cycles (~8s) — confirm cell values refresh in place without a full
   page flash/reload.
4. Toggle underlying NIFTY → SENSEX — confirm the whole table reloads for the new underlying's
   strikes/step size.
5. Move the offset-row-count slider — confirm rows appear/disappear without a new network request
   (client-side slice of the already-fetched 1..15 range).
6. Set Min RoM cutoff above the current market's typical RoM — confirm most cells go neutral;
   lower it — confirm emerald tints reappear.
7. Switch Risk Profile to "conservative" — confirm cells whose POP/risk tier don't qualify go
   muted zinc regardless of their RoM%.
8. Switch to a background tab for 30s, return — confirm the poll paused (no error) and immediately
   refetches on return (network tab / `DATA:` chip timestamp updates promptly).
9. In `ultimateScannerEngine.ts`, confirm the short-strangle symmetric-offset loop now calls
   `computeStrangleAtOffset` and Scanner's own strangle candidates are unchanged in value/shape
   (re-run a scan, spot-check a known strike pair's RoM%/premium against pre-refactor values).
