---
name: dhan-data-sync-pipeline
description: Use when touching the CSV data-download/sync pipeline that populates Historical Data/, Daily_Historical_Data_Fresh/, and the index CSVs — scripts/downloader/refresh_dashboard_data.py (the main orchestrator), download_yahoo_daily.py (yfinance, the DEFAULT data source), fetch_today_quotes.py (today's-row live patch), backfill_stocks_history.py/backfill_indices_history.py, fix_flat_*_candles.py, and the rs_dashboard refresh/backfill/futures-refresh API routes that spawn them. Covers the Yahoo-vs-Dhan dual-source design, the incremental-append-not-redownload logic, the status/stop-trigger polling pattern, and the flat-candle/data-gap repair machinery. Not for the expired-options SQLite pipeline (dhan-expired-options-data, an entirely separate pipeline — no shared code, no yfinance) or the live-quote-patch read side in lib/dataLoader.ts (dhan-prevclose-pct-change covers reading; this skill covers writing the same debug/today_quotes.json file).
---

# CSV Data Sync / Download Pipeline

## Yahoo Finance is the DEFAULT data source, not a fallback — know this before debugging "why is this number different from Dhan"

`refresh_dashboard_data.py --source` defaults to `"yahoo"` (`refresh_dashboard_data.py:1076-77`).
The no-args refresh command in CLAUDE.md runs `run_yahoo_backup()` (`refresh_dashboard_data.py:
1033-1068`), which uses **yfinance** (`scripts/downloader/download_yahoo_daily.py:31,173-229,
272+`) for stocks, Nifty 50, and Nifty 500 index data — **not because Dhan lacks this data**, but
because Yahoo needs no Dhan auth/token and is faster/more resilient for a bulk daily sweep
(CLI help text, `refresh_dashboard_data.py:1076-77`). Sector indices are the one deliberate
exception: all 27 are always sourced from **Dhan**, because "Yahoo Finance does not reliably
maintain narrow sector indices" (`refresh_dashboard_data.py:1048-49`) — this Dhan call happens
even when `--source yahoo` is in effect, requiring an active Dhan token, and silently no-ops
with a log line if no token is available (`refresh_dashboard_data.py:1057-1059`).

`--source dhan` runs the full Dhan-only path instead (`refresh_nifty50`/`refresh_nifty500_index`/
`refresh_indices`/`refresh_stocks`), but **auto-falls back to Yahoo** on Dhan auth failure or any
`FatalAPIError` mid-run (subscription/auth errors like DH-902), unless `--fallback-yahoo` is
explicitly disabled (`refresh_dashboard_data.py:1099-1105,1150-1156`). **If a stock's numbers
look off vs. a Dhan-sourced page elsewhere in the dashboard, check which source actually wrote
that CSV** — Yahoo and Dhan can disagree on adjusted/unadjusted close, especially around
corporate actions (see the gap below).

## Incremental append, never a full redownload — except three specific triggers

Every Dhan-path refresh phase (`refresh_nifty50`, `refresh_nifty500_index`, `refresh_indices`,
`refresh_stocks`) follows the same pattern: read `get_last_date(csv)`
(`refresh_dashboard_data.py:236-255`); if already current, skip; otherwise fetch only
`[from_date, last_trading_day]` in 365-day chunks (the Dhan daily-history API **silently
returns empty for longer ranges instead of erroring**, `refresh_dashboard_data.py:786-788`),
then `pd.concat` + dedupe-keep-last into the existing CSV (`refresh_dashboard_data.py:542-556`
and equivalents). A **full re-fetch** only happens for:
1. A brand-new CSV (no existing file) — 5-year lookback for indices, 2-year for stocks
   (`refresh_dashboard_data.py:484-488,755-759`).
2. A corrupt/truncated CSV under `MIN_INDEX_ROWS=200` rows (`refresh_dashboard_data.py:442,
   463-468`) — forces a full 5Y re-download for that index file.
3. A detected flat/degenerate row or multi-day data gap inside the last window (see below) —
   partial repair-fetch, not a full redownload, but still bypasses the "already current" skip.

## Repair machinery: the flat-LTP-row and data-gap problem

`fetch_today_quotes.py` (below) can write a degenerate O=H=L=C, Volume=0 row when Dhan's batch
API fails to return real intraday OHLC. Before the `_is_genuine_ohlc` guard existed, these rows
landed permanently in CSVs and were never self-corrected by incremental refresh (it only checks
`last_date`, not row quality) — `fix_flat_index_candles.py` / `fix_flat_stock_candles.py` exist
specifically to re-fetch authoritative Dhan EOD over the trailing window and overwrite any such
rows, and also strip bogus weekend rows carried forward. `refresh_dashboard_data.py`'s own
`find_earliest_bad_date()` (`refresh_dashboard_data.py:258-294`) proactively scans the last 10
days of each CSV for the same flat-row signature and re-fetches from there during normal
refresh, so the repair scripts are mostly needed for pre-guard historical damage or one-off
Dhan API glitches.

`find_data_gap_start()` (`refresh_dashboard_data.py:297-325`) detects a >30-day hole mid-file
(delisting/trading-suspension symbols — e.g. a real case where a stock had no data from
2020-10-31 to 2025-02-19) and repair-fetches from just after the gap; a confirmed-empty gap is
cached for 30 days in `debug/confirmed_data_gaps.json` (`refresh_dashboard_data.py:39-47,
328-353`) so a genuinely delisted stock isn't re-probed every single refresh run forever.

## `fetch_today_quotes.py` — the two-output live-quote patch

Fetches live LTP/OHLC for all Nifty 500 symbols + ~29 indices via Dhan `ohlc_data`/`quote_data`
in batches of 100 security IDs (`fetch_today_quotes.py:58-92,133-183,373-403`). Writes two
things with different durability guarantees:
1. **CSV upsert** (`upsert_today_row`, `fetch_today_quotes.py:188-250`) — only for quotes that
   pass `_is_genuine_ohlc()` (`fetch_today_quotes.py:288-298`: rejects O=H=L=C-with-zero-volume
   LTP-only snapshots) **and** only on a trading day (`is_trading_day()`, `fetch_today_quotes.py:
   280-286`, weekday<5 — guards against an unattended scheduled run firing on a weekend and
   writing Friday's stale price forward as a fake dated row). This is the durable, EOD-safe half.
2. **`debug/today_quotes.json`** (`fetch_today_quotes.py:581-591`) — writes **every** quote,
   including LTP-only ones with no genuine-OHLC filter, because this file only feeds same-day
   in-memory display, never gets baked into permanent history. This is the exact file
   `lib/dataLoader.ts`'s live-quote-patch reads — see `dhan-prevclose-pct-change` for the read
   side and its own guard (`isGenuineQuoteRow()`) against the same LTP-only-row problem on the
   TypeScript side. Two independent guards, same underlying Dhan-API quirk, two different
   languages — if you find a new variant of this bug, check whether both sides need the fix.

`RATE_DELAY = 2.0` seconds between quote batches, with an explicit comment that `0.35s was too
short, causing alternating batch failures due to rate limiting` (`fetch_today_quotes.py:27`) —
don't lower this without re-testing at full Nifty-500 batch volume.

## Script inventory (`scripts/downloader/`, `scripts/data_utils/`)

| Script | Role |
|---|---|
| `refresh_dashboard_data.py` | main orchestrator (above) |
| `download_yahoo_daily.py` | yfinance engine — the actual default data source |
| `fetch_today_quotes.py` | today's-row live patch (above) |
| `fix_flat_index_candles.py` / `fix_flat_stock_candles.py` | repair degenerate rows + strip weekend rows |
| `backfill_indices_history.py` / `backfill_stocks_history.py` | one-time backward backfill before the normal 5Y/2Y seed window (default start 2019-01-01) |
| `download_indices.py` | 5Y daily OHLCV for sector/broad indices (excludes Nifty50/500, owned by the orchestrator) |
| `download_nifty500_historical.py` / `download_nifty_historical.py` | interactive menu-driven bulk/intraday downloaders, not part of the automated refresh path |
| `download_nifty500_index.py` | one-off NIFTY_500_Daily.csv fetch from Dhan |
| `download_stocks_sample.py` | 3y 1-min sample data for a symbol subset |
| `download_futures_manual.py` | NIFTY/BANKNIFTY futures OHLCV+OI, run manually per contract roll |
| `download_expired_options.py` | **separate pipeline** — see `dhan-expired-options-data`, no yfinance, writes SQLite not CSV |
| `refresh_intraday_1min.py` | append-only 1-min intraday Parquet archive for Nifty50 (feeds `lib/intraday_signals.py`) |
| `compare_nifty_data.py` (data_utils) | diagnostic only — cross-checks repo Parquet vs. yfinance `^NSEI`, not part of the write pipeline |
| `convert_to_parquet.py`, `extend_nifty_minute.py`, `resample_nifty_data.py`, `append_indicators_to_nifty_parquet.py` (data_utils) | Parquet conversion/extension/resampling/indicator utilities downstream of the CSV pipeline |

## API route → script spawn map (`rs_dashboard/app/api/`)

All follow the standard spawn/poll/stop-trigger pattern (`dhan-polling-guards`,
`dhan-dashboard-page`):
- `refresh/route.ts` → `refresh_dashboard_data.py --target <t> [--source yahoo]` (default
  source yahoo), status `debug/refresh_status.json`, stop `debug/refresh_stop.trigger`; on
  completion, clears the dashboard's in-memory caches (dataLoader/indices-performance/
  movers/breadth) so a manual refresh is visible immediately rather than waiting on TTLs.
- `options-refresh/route.ts` → `download_expired_options.py`, own status/stop files (separate
  pipeline, see `dhan-expired-options-data`).
- `futures-refresh/route.ts` → `download_futures_manual.py`, status `debug/
  futures_refresh_status.json` — **no dedicated stop-trigger file** for this route; a
  long-running futures download cannot be cancelled from the UI the way the others can.
- `backfill/route.ts` → dispatches on `?target=stocks|indices` to `backfill_stocks_history.py`
  / `backfill_indices_history.py` with their own status/stop file pairs and a `--start-date` arg.

## Data-quality gaps to know about, not just fix reactively

No corporate-action/split/bonus-adjustment logic exists anywhere in this pipeline — Dhan and
Yahoo data are both used as-is. If a stock's historical chart shows an unexplained multi-day
jump/drop that lines up with a known split or bonus issue, that's expected behavior of this
pipeline (unadjusted data), not a download bug — don't spend time debugging the fetch logic for
that symptom.
