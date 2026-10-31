---
name: dhan-pnf-equity-history
description: Use when touching where the Point & Figure page (/straddle-pnf) gets a stock's price history — scripts/tools/price_pnf_candles.py (stored 1-min parquet + live Dhan API + daily-CSV prefix stitching), app/api/straddle-pnf/route.ts's session cap and cache, the `anchor_t` / `anchorT` hand-off, or any report like "the P&F box is tiny", "the chart is empty / far from the price", "history stops at a date", "times are 5.5 h off". Covers the three data tiers, the timestamp traps, and why the box size must be anchored on the first 1-minute bar, not the first bar.
---

# P&F equity history: three tiers, one anchor

Read `dhan-pnf-chart-panel` for the UI side. This skill is the data side, for **cash equity only** (index / futures / options keep the plain API window, `SESSIONS = 10`).

## The three tiers (`price_pnf_candles.py`, `--kind equity`)

Oldest to newest, all reduced to the Dhan frame shape `start_Time` (epoch s) / `close` / `volume` / `high` / `low`:

0. **Yahoo 2008→2018** — `Historical Data/Yahoo_Daily_Pre2019/<SYM>.csv`, fetched once from Yahoo (`yfinance`, `auto_adjust=False` = split-adjusted, not dividend-adjusted) and cached; the fetch runs to 90 days past the CSV's first day so the two bases can be compared. `rebase_yahoo()` multiplies it by the **median CSV/Yahoo close ratio over the first overlapping days** (RELIANCE: a steady 1.0167 — the CSV carries a small adjustment Yahoo does not) and **refuses to join (CSV only) if there are < 5 overlap days, the ratio is outside 0.2–5, or max/min > 1.05**. Never join two price bases on a guess. Yahoo is an allowed *market-data* source here (the repo's own daily refresh uses it); a failure just means less history. `load_yahoo_pre()`; tests inject a fake `fetch`.
1. **Daily CSV** — `Daily_Historical_Data_Fresh/<SYM>_Daily_2Y.csv` (back to 2019; the `2Y` in the name is stale), one bar per day stamped **15:29 IST** (the session's last minute, so a 1-day bar closes at the bell). Tiers 0 and 1 are concatenated and only dates *before* the first 1-min bar kept. `load_daily_before()`.
2. **Stored 1-min** — `Intraday_Historical_Data/1min/<SYM>.parquet` (the Nifty 50 only; `load_stored_1min()`). **Read the parquet's own last date, not `manifest.json`** — the manifest said 2026-08-07 while the file ran to 2026-09-04.
3. **Dhan API 1-min** — from `max(today - 85 d, last stored day + 1)`. 85 d stays inside the API's ~90-day-per-request limit. A stock with no parquet gets only this tier (~60 sessions) plus the prefix.

`stitch_history(stored, fresh)` concatenates; `_leg()` later does `drop_duplicates("t", keep="last")`, so **the API wins on an overlapping minute**. Stitch the prefix last-in-front: `stitch_history(prefix, stitch_history(stored, api))`.

The route passes `--sessions 5000` for equity (`EQUITY_SESSIONS`): `to_bars` keeps the last N *completed* sessions, and the daily prefix alone is ~1,900 days. A cap of 400 silently cut the history to 2026-06.

## Timestamp traps (each cost a wrong chart)

- The parquet index is `datetime64[ms]`, IST-naive. `DatetimeIndex.asi8 // 10**9` is **wrong** (gives 1780, i.e. 1970). Use `(ist - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)` after `tz_localize(_IST)`. A test pins 09:15 IST.
- Dhan API frames come in several column spellings and epoch units; always go through `_to_epoch_seconds` / `_leg` rather than reading columns directly.
- stdout carries a `Using cached access token…` line before the JSON; the route (`runPythonJson`) reads the **last** line. When piping the script in a shell, `tail -1`.

## The box-size anchor (the bug that made the chart look empty)

The P&F box is a **percentage of the first price** (`straddlePnfModel.ts` `firstPrice`). With the daily prefix, the first price became ADANIGREEN's 2019 close of ~₹41, so a 5 % box was ₹2.07 against a ₹1,296 price (~600 boxes away). Rule:

- The script prints `anchor_t` = epoch of the first **real 1-min** bar (stored or API), computed *before* the prefix is stitched on.
- Route → `anchorT` in the JSON body → `Loaded.anchorT` (`usePnfFeed.ts`) → `buildConfirmedModel(..., { anchorT })`, which takes `firstPrice` from the first bar with `t >= anchorT` (fallback: first positive bar).
- `withLive` reuses `build.anchorPrice`, so the live build stays on the same grid.
- Consequence to tell the user: a stock with **no parquet** anchors on the API window's first bar, which moves forward ~1 day per day, so its box/grid shifts daily. Parquet stocks are stable. Downloading 1-min history for more symbols is the real fix.

Any new bar source that prepends coarser history must pass an anchor the same way — do not rely on "first bar".

## Futures / options / straddles: every session the API serves

`SESSIONS = 10` made an option chart start 16 Oct while TradingView shows the contract from its first day (NIFTY 23000 CE 03 Nov: listed 2026-09-25, price 490 → the TradingView chart's first columns sit above 380). The route now passes `CONTRACT_SESSIONS = 200` for contracts and the script limits the request window to `API_WINDOW_DAYS = 85` (`from_date = today - min(sessions * 3 + 4, 85)`; a larger window makes the API return nothing, i.e. an empty chart). Index charts still use `SESSIONS`. F&O sessions here run 09:15 → 15:39 (385 one-minute bars with real volume after 15:30), unlike equity's 09:15 → 15:14; do not "fix" the 15:30–15:39 bars. Verified against TradingView's full NIFTY26N0323000CE chart (1 min, box 3, 3-box): the first 55 columns (25 Sep → 6 Oct) match one for one, and after a sequence alignment 364 of TradingView's 374 pixel-extracted columns match ours (direction + far end within 7 points); ours has 388, the residual gaps cluster on 6, 7, 15, 21–22, 26, 28 and 30 Oct. Dropping the 15:30–15:39 bars makes the match *worse* (cost 33 → 41.5), so they are real data. Comparison recipe: extract TradingView's columns by x colour runs (pitch ~5.2 px at 2497 px wide; mask the dotted last-price line), map y with two axis labels, then align with an edit-distance DP (match / missing-column costs) instead of comparing by index — a single missed column shifts every later index.

## Official closes: Dhan's 1-minute series ends at 15:14

Dhan's intraday 1-min bars (stored parquet and API alike) stop at **15:14** and miss the closing auction, so the day's last 1-min close is not the exchange close (ADANIGREEN 2026-10-23: 1,200.4 vs official 1,185.1; mean |diff| 4.7, max 48 over 61 days). A 1-day / 1-week / 1-month chart built from it can move a box and hide short columns (this made the July–November section of a weekly ADANIGREEN chart disagree with TradingView). `snap_session_closes(bars, daily)` sets each IST day's **last** 1-min close to `Daily_Historical_Data_Fresh`'s close for that date, skipping a day with no CSV row (today) and any day whose official close is > 10 % from the bar's (a different price basis). `read_daily_csv()` is shared with `load_daily_before()`; `stitch_history()` now always returns the normalised `start_Time` (int64) / `close` / `volume` frame (an empty side used to turn the epoch column into objects → 1970 timestamps). The intraday charts are unaffected except for each session's final bar.

## Cost and caching

- Equity payload is ~37–39k bars (a few MB) and the page re-fetches it every 30 s (`POLL_MS`); the route's 20 s cache (`CACHE_TTL`, max 40 keys) absorbs duplicate windows. If it feels heavy, send the old sessions once and refresh only the recent ones.
- After changing the route's body shape, the dev server's 20 s cache briefly serves the old shape (no `anchorT`) — the model falls back safely.
- Daily CSVs are used as downloaded; `lib/dataLoader.ts` applies `scripts/downloader/corporate_actions.json` but Python doesn't. RELIANCE's 2024 bonus is already in the CSV's basis (≈1,330 around 2024-10-30), so no jump appears — check a new symbol around its known splits before trusting a long chart.

## Close only — High / Low was tried and removed

TradingView's weekly P&F is **close-based**: its RELIANCE 1 w / 12.79 / 3-box columns match our close columns one for one (X up to 1,055, O 863→1,042, X 876→927 … last O down to ~1,170-1,176; 84 columns from 2008). A High/Low source (bar `h`/`l` through the Python frames, the resampler, the live tick and a `source` setting) was built on a misreading of the screenshot's column pitch (10 px per column, not 5 → ~85 columns, not ~170) and removed again. Do not re-add it without a concrete reference chart that needs it.

## Tests

`tests/test_price_pnf_candles.py` (`StoredHistory`, `DailyPrefix` — temp-dir parquet/CSV, no network) and `lib/straddlePnfModel.test.ts` (`anchorT` case). Verify against the live script with `venv/bin/python scripts/tools/price_pnf_candles.py --kind equity --symbol X --sessions 5000 | tail -1` — read-only, but needs a valid token.
