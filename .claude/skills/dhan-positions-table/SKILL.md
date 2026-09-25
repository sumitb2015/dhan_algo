---
name: dhan-positions-table
description: Use when designing, extending, reviewing or debugging the positions / legs table of a Dhan dashboard terminal — the per-strategy legs table in Multi-Leg Focus (MultiLegStrategyRow / MultiLegLegRow) and the positions table in Advanced Scalper / Cyber Scalper / Focus Tool. Covers adding or reordering columns (Avg, Exit, P&L %, Qty, IV, OTM %, Expiry), how each value is computed and when it must be a dash instead of a number, dynamic table-fixed column widths, the column chooser and remembered preferences, sortable headers and filters, row actions (shift/roll N strikes up or down, group shift, add lots, exit, partial exit), near vs far expiry handling and labels, the multiples-of-100 far-expiry strike rule, bid/ask spread checks before opening legs, concurrent order placement and exits, Dhan rate limits, and the payoff diagram / Greeks / order-book panels attached to the table. Use it even when the request is phrased as "add a column", "make the table more professional", "why does this leg show the wrong P&L", "shift buttons", "far expiry strikes" or "the table is too wide", and read it before touching any legs-table column, header or row action.
---

# Dhan Positions Table

## Overview
A "positions table" here is one table of **legs** (rows) per strategy. It is not a mirror of the broker's
position book. Each row is a leg this app opened, tracked in its own fill ledger; the broker is consulted
only to confirm or shrink that ledger. Most bugs in this area come from one of four mistakes: treating
a broker row as if it were the leg, showing `0` where the honest answer is "unknown", rendering a column
in the header but not the rows (or the reverse), and firing several orders without a guard between them.

Files that matter (all under `rs_dashboard/`):
- `components/multiLegFocus/MultiLegStrategyRow.tsx` — the strategy card: header, shift bar, toolbar, table header/colgroup, payoff panel.
- `components/multiLegFocus/MultiLegLegRow.tsx` — one leg row (cells, per-leg chevrons, EXIT/ADD).
- `components/multiLegFocus/LegColumnsMenu.tsx`, `lib/legColumns.ts` — optional-column chooser and its saved preference.
- `lib/multiLegFocus.ts` — the pure per-leg helpers (`legPnl`, `legAvgPrice`, `legPnlPct`, `legOtmPct`, `formatExpiryLabel`, ...). Put new value maths here, with tests, never inline in JSX.
- `lib/farExpiryRules.ts`, `lib/strikeShift.ts` — far-expiry strike rule + spread assessment; shift planning.
- `components/MultiLegFocus.tsx` — the orchestration: `placeBasket`, `exitOneLeg`, `exitBasket`, `shiftLegs`, `addNewLegCore`, `patchLegs`.
- `components/AdvancedScalper.tsx` + `Scalper.tsx` (`PositionsTable`) — the broker-position style table; see `dhan-broker-positions`.

Read these sibling skills for their part, and do not restate them here: `dhan-terminal-position-ownership` (ledger vs broker, reconcile down only), `dhan-broker-positions` (broker payloads, P&L, exit sizing), `dhan-order-tickets`, `dhan-payoff-diagrams`, `dhan-position-greeks`, `dhan-terminal-polish` and `dhan-a11y-controls` (density, focus rings), `dhan-theme-tokens`, `dhan-polling-guards`, `dhan-api-errors`.

## The rules, and why

### 1. A value that does not exist yet is a dash, never `0`
Every per-leg helper returns `null` when its inputs are missing, and the cell renders `—`. A closed leg with no
recorded close price, a DRAFT leg with no fill, a live leg with no LTP yet: showing `0`, `+100%` or a full-premium
gain here reads as real data and gets acted on. `legPnlPct` returns null for a live leg with `ltp <= 0` for exactly
this reason. (The older rupee `legPnl` still shows the full premium with no LTP — do not copy that.)

### 2. One condition list drives header, colgroup and cells
The legs table is `table-fixed` with a `<colgroup>`. When columns are optional, build a single ordered weights
array from the same booleans the header and the row use, then render `<col style={{ width: pct }}>` from it, and
set a `minWidth` so a wide selection scrolls instead of squashing. A column added to only one of the three
misaligns everything silently. Exit hides itself when the strategy has no CLOSED leg even if enabled (a column of dashes teaches nothing).
Full column catalog, formulas and sort keys: `references/columns-and-formulas.md`.

### 3. View state never changes data
Sort key, open/closed filter, chosen columns and the Steps stepper are presentation only. Sorting is opt-in (no
sort key = stored order) so editing a draft leg's strike does not make the row jump. Optional-column preferences
live in `localStorage` via `lib/legColumns.ts` (always try/catch, merge over defaults, corrupt value = defaults),
are owned by the page and passed to every strategy row so they agree, and are read in the `useState` initialiser
(rows only exist after the baskets load client-side, so nothing depends on it at server render). Do not read
storage in an effect: the repo's lint treats setState-in-effect as an error.

### 4. Popovers and toolbars must escape the table's clipping
The strategy card is `overflow-hidden` and the table wrapper is `overflow-x-auto`; an absolutely positioned menu
gets cut off on a strategy with two legs. Keep the toolbar (filter chips, Columns menu) outside the scroll
container and position popovers with `position: fixed` from the button's rect, closing on scroll/resize/Escape.

### 5. Expiry is a date, not FRONT/FAR
Show the leg's actual expiry (`formatExpiryLabel('2026-10-27')` -> `27 Oct 26`). "Front/far" carries no meaning
on its own; keep the highlight for a leg on the basket's second expiry, and keep the toggle for calendar/diagonal
drafts. Every leg carries its own `expiry`; always read it as `leg.expiry || basket.expiry`, and look up its
security id, strikes, LTP and IV against that expiry's chain, never the basket's. Rules for near vs far expiries,
the multiples-of-100 restriction and snapping: `references/expiry-and-strike-rules.md`.

### 6. Row actions are rolls, and rolls are atomic
"Shift up/down N strikes" = close the old leg (kept as CLOSED so realized P&L survives), then open a new leg at
`strike +/- N` listed strikes, sized off what actually closed, inheriting SL/TP/trail. Plan all-or-nothing (refuse
if any leg would clamp at the chain edge), refuse a landing strike that a leg on the opposite side already holds
(Dhan nets by security id), confirm on a sibling-basket collision, verify the close before reopening, reopen buys
before sells, and leave a leg flat rather than naked when a reopen fails. Details and the guard checklist:
`references/row-actions-and-order-safety.md`.

### 7. Several orders at once need a guard between them
Concurrent legs removed the natural "see leg 1 fill before sending leg 2" pause, so replace it with checks:
fail-closed margin (verified for the *current* legs, funds read fresh), a placement lock taken **before any
await**, buys-then-sells phases, an exit that never sells a hedge while a short is open, a spread check, and
functional state updates (`patchLegs`) so two responses landing in the same tick cannot overwrite each other.

### 8. Respect Dhan's rate buckets, account-wide
Orders go through one sliding-window limiter (8/s) with a single retry on HTTP 429; bid/ask reads go through the
shared quote lane (`lib/dhanQuotePacer.ts`, ~1 call/s, capped queue, state on `globalThis`); funds polls coalesce
per broker. Never retry a data-endpoint 429 on a short fixed delay; never let a market-data nicety block an order
for more than a couple of seconds. See `dhan-polling-guards` #6 and #11.

### 9. Attached panels have their own rules
Payoff diagram: one per **strategy** (not per leg), collapsed by default, T+0 curve computed only while open,
`isAnimationActive={false}` on live lines, X-domain sized off the breakevens, exact expiry break-evens. Greeks:
on-demand button, per-leg Gamma scaled by position sign and quantity. Order book (`OrdersTradesModal`): inline
limit modify/cancel. Header structure label comes from the live legs (`classifyBasketStructure`), not the stored
preset name. Symptoms and fixes: `references/issues-and-fixes.md`.

### 10. Look like the rest of the app
Theme tokens only (no hex, no `text-white/70`), table header `text-xs font-bold text-white` on `bg-zinc-800`,
`FOCUS_RING` and an `aria-label` on every icon-only button, `tabular-nums` on numbers, `select-none` on labels
that are not content, popovers at `z-40`, modals `z-50`. Group related controls into one bordered segment with
dividers rather than a row of separate boxes (`dhan-terminal-polish`). Keep the strategy list full width: a
`max-w` on the list left the header clipping `Exit Strategy` while margins sat empty.

## Workflow for a change
1. Decide which layer it belongs in: pure value (`lib/multiLegFocus.ts` + test), preference (`lib/legColumns.ts`), table markup (row + strategy row), or order path (`MultiLegFocus.tsx`).
2. Write the pure helper and its tests first; cover null/zero/closed/crude-multiplier cases.
3. Wire header, colgroup, cell from the same condition; add the sort key only if sorting is meaningful.
4. If it can open or close a position, walk the guard checklist in `references/row-actions-and-order-safety.md`.
5. `npx tsc --noEmit -p .`, `npm test`, `npm run lint -- <touched files>` (compare the error count with the file's baseline, do not just read "0 new"), `npm run build`.
6. Look at it in a browser after a rebuild **and a proper restart** (`references/issues-and-fixes.md`, "Operational"): kill the old server by PID and confirm the new process start time, then hard-reload the tab. Check dark, white and beige themes, a DRAFT strategy, a strategy with closed legs, and a narrow window.
7. Never place a real order to test a table change; verify order paths with a 1-lot far-OTM strategy only with the user's go-ahead.
