---
name: dhan-oi-analytics
description: Use when working on open-interest buildup classification, PCR (put-call ratio), max pain, or resistance/support-from-OI panels — components/OIBuildupDashboard.tsx, OptionsBuildupTab.tsx, OptionsCumulativeOITab.tsx, OptionsOITab.tsx, OptionsPCRSpotTab.tsx, OIChangeProfileChart.tsx, OIProfileChart.tsx, TrendingOiChartModal.tsx/TrendingOiTable.tsx, CrudeOilOITab.tsx/CrudeOilCumulativeOITab.tsx, and scripts/tools/nifty_oi_profile_fetch.py / crudeoil_oi_collector.py / trending_oi_fetch.py / nifty_time_analysis_fetch.py. Covers the OI-change-sign guards that make PCR and buildup labels trustworthy on a thin or unwinding day, and the max-pain scan. Not for Greeks (dhan-position-greeks/dhan-payoff-diagrams), not for the draft-leg margin strip (dhan-options-analytics-page), not for CSP-specific screening (dhan-csp-desk).
---

# OI Buildup / PCR / Max Pain Analytics

## Don't assume a background collector is needed for a same-day OI time series

`get_option_chain()`/`get_option_chain_df()` only return the *current* snapshot — true, and
documented in `dhan-option-chain-analysis`. But that does **not** mean a time-based OI/PCR/
Max-Pain table needs a live poller writing rows all day. `helper.get_intraday_minute_data(...,
oi=True)` returns that **contract's own per-minute OI history for the whole trading day**,
retrievable at any time during or after that session — Dhan retains it, it isn't live-only.
`trending_oi_fetch.py` and `nifty_time_analysis_fetch.py` are both built this way: stateless,
reconstructing the entire session (spot + futures + a band of strikes, each fetched with
`oi=True`, reindexed onto a per-minute grid with `ffill().bfill()`) on every invocation, no
background process, no state file. This means such a page works identically whether the
market is open right now or has been closed for hours, and needs no Start/Stop button.
`nifty_time_analysis_fetch.py` originally shipped as a live-only background collector
(`nifty_time_analysis_collector.py`) before being rewritten this way — don't repeat that first
design for a new OI-time-series page; start from the stateless pattern.

Two independent OI-analytics code paths exist in this repo — a Python aggregate-profile
fetcher and a TypeScript per-strike classifier. They compute different things from the same
raw chain data and use **different label vocabularies**. Know which one you're in before
touching either.

## Path 1 — `scripts/tools/nifty_oi_profile_fetch.py`: aggregate PCR + resistance/support

Fetches a chain window around ATM and produces one aggregate profile: total call/put OI,
total OI *change*, an OI-based PCR, a PCR-change ratio, and the single strike with the
largest CE OI ("resistance") / largest PE OI ("support"). Three deliberate guards, each
added because the naive version silently produced a wrong-but-plausible number:

1. **NaN previous-OI baseline** (`nifty_oi_profile_fetch.py:227-229`) — `clean_val()` turns a
   missing/NaN `previous_oi` into `0.0`. If OI-change were computed as `curOI - prevOI`
   unconditionally, a NaN baseline would silently report the *entire* current OI as "today's
   change." The guard only computes `curOI - prevOI` when `prevOI > 0`; otherwise it falls
   back to the chain's own `ce_oi_change`/`pe_oi_change` field.
2. **Zero-OI seed for resistance/support** (`nifty_oi_profile_fetch.py:246-248`) — the max-OI
   scan is seeded at `-1` with a strict `>` comparator and an explicit `oi > 0` guard. Without
   both, an all-zero chain (holiday, stale feed, wrong security id) would nominate the lowest
   strike in the window as "resistance" instead of reporting no signal.
3. **Denominator-only guard on PCR-change** (`nifty_oi_profile_fetch.py:273-275`) —
   `pcr_change = put_oi_change / call_oi_change` guards only the denominator being nonzero,
   deliberately. Requiring *both* changes to be positive (the naive "safe" version) reports
   `0.0` on any unwinding day, which reads as "no change" when the truth is "puts and calls
   moved in opposite directions" — a negative ratio here is a real, meaningful signal, not an
   error state to suppress.

If you add a new aggregate OI stat to this script, copy the same discipline: decide whether a
zero/NaN input means "no data" (exclude) or "no change" (include as zero), and don't let the
former masquerade as the latter.

## Path 2 — `components/OptionsBuildupTab.tsx`: per-strike buildup classification + max pain

`classifyBuildup(side)` (`OptionsBuildupTab.tsx:77-88`) labels **one strike's one side** (CE
or PE) independently, from that side's own OI-change and price-change sign — it does not use
the Python script's aggregate PCR at all:

```
oiChg > 0 && priceChg >= 0  → Long Buildup    (fresh longs, price up + OI up)
oiChg > 0 && priceChg <  0  → Short Buildup    (fresh shorts, price down + OI up)
oiChg < 0 && priceChg >= 0  → Short Covering   (shorts closing, price up + OI down)
oiChg < 0 && priceChg <  0  → Long Unwinding   (longs closing, price down + OI down)
!prevOI || oiChg === 0      → Neutral
```

This is standard options-market buildup terminology (four quadrants of OI-change × price-
change), but it is **the CE/PE side's own price**, not the underlying's — a CE showing "Short
Buildup" means call premium fell while call OI rose, independent of what PE or the underlying
did. Don't conflate this per-side classification with the Python script's PCR, which is an
aggregate across the whole strike window; a chain can show CE "Short Buildup" and still have
overall put-side PCR flat.

`computeMaxPain` (`OptionsBuildupTab.tsx:92-104`) is a brute-force O(n²) scan over every
candidate strike × every strike's OI (`payout = Σ ce_oi·max(0,K−s) + pe_oi·max(0,s−K)`,
minimized over K) — fine at typical chain widths (~40-80 strikes) but **not memoized**
(`OptionsBuildupTab.tsx:237` calls it inline in the render body on every strike-window
change). If this component grows to render on every live tick rather than on
expiry/window change, memoize it — recomputing an O(n²) scan per tick is wasted work the
chain data doesn't justify.

## Gotcha shared by both paths: OI-change fields can come from two different sources

Both paths read a chain-supplied `*_oi_change`/`*_previous_oi` field when present, but fall
back differently when it's missing (Path 1 falls back to the chain's own pre-computed change
field; Path 2 requires `previous_oi` truthy or reports `Neutral`, with no fallback field at
all). If a new OI panel is built against a data source that doesn't populate one of these
fields, check which of the two documented behaviors it should replicate rather than inventing
a third.

## `get_ohlc_data()` never returns OI — use `get_quote_data()`

`DhanHelper.get_ohlc_data()` (`lib/dhan_helper.py:3222-3226`) returns only `last_price` and
`ohlc: {open, high, low, close}` for any segment, including `NSE_FNO` — there is no `oi` key
in its response, ever. `get_quote_data()` (`lib/dhan_helper.py:3241-3246`, the `/marketfeed/quote`
L2 endpoint) is the one that returns `oi` per-instrument. Reading `get_ohlc_data(...).get('oi')`
doesn't raise — it just returns `None`/`0`, which then reads as "OI is zero" instead of "wrong
endpoint." `nifty_time_analysis_collector.py` made exactly this mistake fetching NIFTY futures
OI for its Fut-OI-Change column (caught in code review, 2026-09-23, before it shipped) — check
which method a new OI read actually calls before trusting its output, not just whether the call
succeeded.

This compounds with the zero/NaN-baseline guard two sections up: a fetch that silently returns
0 instead of erroring makes the "is this a real zero or a missing baseline" ambiguity *harder*
to catch, not easier — the same collector also initially computed its OI-change% as `0.0` for a
missing baseline instead of excluding the row, reproducing the guard's own anti-pattern in a
third code path despite this skill already documenting it twice above. If you're adding a fourth
OI-consuming path, treat "did I get a real OI reading this poll" as its own tracked boolean, not
something you infer from whether the number is zero.
