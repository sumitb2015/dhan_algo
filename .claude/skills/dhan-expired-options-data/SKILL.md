---
name: dhan-expired-options-data
description: Use when touching scripts/downloader/download_expired_options.py, scripts/analysis/convert_options_to_sqlite.py, Options Data/nifty_options.db, scripts/analysis/strike_history.py, or the Strike History page/components (StrikeHistoryPage.tsx, StrikeHistoryTab.tsx, api/options/strike-history). Covers the expiry-window date-labeling bug and the "no NOT NULL constraint" data-quality assumptions the whole pipeline must carry through to the UI.
---

# Dhan Expired Options Data Pipeline

## Overview
A pair of commits (`97b29e1`, `b491474`) found and repaired a silent data-corruption
bug affecting **265 of 295 tracked expiries (4.14M of 26.6M DB rows)**: the
downloader's fetch window for one expiry could land on the exact calendar date of
the *previous* weekly expiry, and Dhan's `expiry_code=1` ("near week relative to
query date") resolved that request to the wrong, dying contract — which
`convert_options_to_sqlite.py` then mislabeled with the target expiry from the
filename. A following pass on the new Strike History page (`1bcbf9c`, after
`fc1d79c..ba992e2`) found the frontend hadn't accounted for the resulting
data-quality reality: `option_prices` columns carry no `NOT NULL` constraint, so
contamination or gaps surface as `null`, not just "wrong but present" values. Read
this before touching any stage of downloader → SQLite → API route → chart.

## When to Use
- Changing the expiry-window / date-range logic in `download_expired_options.py`.
- Changing how `convert_options_to_sqlite.py` labels rows with an expiry.
- Adding a field to `strike_history.py`'s query or the `api/options/strike-history`
  route's response shape.
- Building or extending a chart/table over `Options Data/nifty_options.db` data —
  the null-safety and true-baseline rules below generalize to any such view.

## Invariants

1. **NIFTY weeklies are exactly 7 calendar days apart** — a naive `from_date =
   expiry - 7 days` fetch window almost always equals the *previous* week's own
   expiry date. On that date, Dhan's `expiry_flag="WEEK", expiry_code=1` resolves
   to the prior (0-DTE, about-to-expire) contract, not the target one. Any fetch
   window built the same way (a new instrument, a different weekly cadence) needs
   the same guard: start the window the day *after* the immediately preceding
   expiry in the known expiry list, not a fixed offset before the target
   (`_safe_from_date()` in `download_expired_options.py`, from `97b29e1`).
2. **The filename-labeled expiry is not verified against the fetched data.**
   `convert_options_to_sqlite.py` trusts the expiry encoded in the source CSV's
   filename for every row in that file — if the fetch window was ever wrong, every
   row in the file silently inherits the wrong label. When adding new ingestion
   logic, don't assume "labeled as expiry X" implies "is actually expiry X's data"
   without checking the invariant that produced the label.
3. **`Options Data/nifty_options.db` is gitignored; `Options Data/NIFTY/*.csv` is
   tracked.** A DB-level data fix (as in `97b29e1`) does not fix the tracked CSVs —
   `b491474` was a *separate*, necessary commit to strip the same contamination
   from the CSVs, because rebuilding the DB from CSVs via
   `convert_options_to_sqlite.py` would otherwise reintroduce it. Fixing one
   without the other leaves a time bomb for the next DB rebuild.
4. **`option_prices` columns have no `NOT NULL` constraint** — any consumer
   (`strike_history.py`, the API route, chart/table components) must treat
   OI/strike/spot/price fields as `number | null` and render/format accordingly
   (`fmtOi`, strike/spot display all null-guard as of `1bcbf9c`). Don't add a new
   raw `.toLocaleString()` or arithmetic call on these fields without a guard.
5. **"Since entry" stats must baseline off the full unfiltered series, not the
   currently selected timeline filter.** The Strike History page's "Total Decay"
   column baselined against the first bar of whichever 1D/5D/10D range was
   selected, silently under-reporting cumulative decay for narrower ranges — fixed
   by deriving `trueEntryOpen` from the full `points` array before the timeline
   filter is applied (`1bcbf9c`). Any new lifetime/cumulative metric on this page
   needs the same unfiltered-baseline treatment, not the filtered `timelinePoints`.
6. **Don't compute the same derived stats on both the server and the client.**
   `strike_history.py` computed a meta block (spot/strike/decay stats) that the API
   route typed but never read, while `StrikeHistoryTab.tsx` independently
   recomputed the same numbers client-side — the server computation was dead code,
   removed in `1bcbf9c`. Decide once which side owns a derived stat.

## Common Mistakes
- Fixing a date-window bug in the downloader without checking whether the tracked
  CSVs (not just the gitignored DB) carry the same contamination.
- Adding a new numeric field to the strike-history response and reading it with a
  bare `.toLocaleString()` / arithmetic op on the frontend instead of a null guard.
- Computing a "total"/"cumulative" stat against a filtered/windowed array when the
  label implies a lifetime quantity.
