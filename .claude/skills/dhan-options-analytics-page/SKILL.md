---
name: dhan-options-analytics-page
description: Use when working on Positions Analysis, Straddle Analysis, or Strangle Analysis — the multi-leg options book pages under rs_dashboard/components/{PositionsAnalysis,StraddleAnalysis,StrangleAnalysis}.tsx and analytics/. Covers the draft ("what-if") leg builder, the payoff-chart draft overlay, margin/ROI stats, and the historical validity-report modals. Not for the live order-placing terminals (Scalper/AdvancedScalper) — that's dhan-broker-positions. Not for the payoff chart's own math/rendering — that's dhan-payoff-diagrams.
---

# Dhan Options Analytics Page

## Overview
Positions Analysis, Straddle Analysis and Strangle Analysis are the three "book +
backtest" pages built on the same shared pieces: a payoff chart, a broker-aware
margin header, and (for Straddle/Strangle) a historical validity report modal. Each
was extended independently over a run of commits (`e30b3e3`, `e777a9d`, `c355717`,
`260b017`, `206c0d6`) that converged on the same shapes — this captures them so the
next addition starts from the pattern instead of re-deriving it.

## When to Use
- Adding or changing anything in `rs_dashboard/components/PositionsAnalysis.tsx`,
  `StraddleAnalysis.tsx`, `StrangleAnalysis.tsx`, or `rs_dashboard/components/analytics/`.
- Adding a new "what-if" / staged-but-not-placed feature anywhere else in the
  dashboard — the draft-leg pattern below generalizes.
- Extending the margin/ROI stats strip or a validity-report-style historical modal.

## Draft ("What-If") Legs — Stage Before You Trade
`DraftStrikeBuilder.tsx` lets the user pick expiry/strike/CE-PE/lots and stage a
hypothetical leg with **zero broker interaction** — no `fetchStrikeMap`/
`placeOptionOrder` call happens until the user explicitly commits. Draft legs are
plain client state (`DraftLegSpec[]`), resolved against the same cached option chain
via `resolveFreeformLegs()`, and merged with the real book only for display:
- The payoff chart takes an optional `draftCurve` prop rendered as a dashed overlay
  distinct from the real-book curve (violet dashed, in the existing pages) — and its
  domain/guard logic must tolerate **zero real positions**, so a draft-only preview
  renders before any live leg exists.
- Show a second "Preview — Book + Draft" stats strip alongside the real one rather
  than mutating the real stats in place — the user needs to compare, not lose the
  current-state numbers.
- "Clear Drafts" must be zero-broker-interaction (pure state reset). Placing them is
  a separate, explicit, arm-then-confirm action that sequentially calls the same
  `fetchStrikeMap`/`placeOptionOrder` path real legs use — don't build a parallel
  order-placement path for drafts.
- One-click combo builders (`+ Straddle`, `+ Strangle`) that stage two legs at once
  are additive sugar over the same single-leg staging function — build the
  single-leg path first, then compose it.

## Margin / ROI Stats
The margin header is broker-aware and must be **re-fetched whenever the broker
selector changes**, not just on mount — margin figures are per-account. Before
adding a new broker's margin field, check it actually reports `utilizedAmount`-
equivalent: Zerodha's funds route was missing it and needed
`margins.equity.utilised.debits` from Kite specifically (`e777a9d`) — Dhan and Kotak
already returned it under their normal shape.

For ROI-style stats (Running P&L, Remaining Profit, Profit % of margin), scope the
rollup to the same view the strip is rendered in — an "Intraday (MIS)" tab needs its
own P&L rollup filtered to MIS legs, not the whole book's P&L, or a book-wide number
leaks into a tab that's supposed to show only its own slice.

## Multi-Expiry Carry-Forward (shared with `dhan-broker-positions`)
`positionLegs.ts` must filter positions by the row's own expiry — a leg still open
in the broker book from a prior expiry is not part of *this* expiry's book. See
`dhan-broker-positions` invariant on MTM history for the sibling bug in
`scalper_mtm_history.py`; this is the same root cause (identity keyed on symbol
without expiry) surfacing in a different table.

## Validity Report Modals
`StraddleValidityReportModal.tsx` / `StrangleValidityReportModal.tsx` render
regime-segmented (`all` / `pre_sep2025` / `post_sep2025`) DTE statistics — weekday
breakdown, seller-win%, decay%, range% — from a precomputed JSON blob, not a live
API call. **These two files are ~95% structurally identical** (same regime
tab-switcher, same stat-table layout, same formatters) with only the underlying
data shape differing slightly — if you're adding a third instrument's validity
report, or changing the shared layout, factor the common shell out instead of
copy-pasting a third near-duplicate; don't let this pattern replicate further
un-deduplicated.

## Common Mistakes
- Wiring a draft leg through the real order-placement state instead of a separate
  `draftLegs` array — makes "Clear Drafts" affect real positions.
- Letting the payoff chart's domain/guard logic assume at least one real position
  exists — breaks the draft-only preview case.
- Copy-pasting `StraddleValidityReportModal.tsx` again for a new instrument instead
  of extracting the shared shell now that a third copy would exist.
- Fetching margin once on mount instead of on every broker-selector change.
