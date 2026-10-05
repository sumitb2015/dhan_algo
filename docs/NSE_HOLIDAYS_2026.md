# NSE Trading Holidays — 2026 (Equities)

Source: <https://www.nseindia.com/resources/exchange-communication-holidays>, section
"Holidays for the calendar year 2026 - Equities". Read 2026-10-05.

## Where the list lives in code

One file is the source of truth: **`rs_dashboard/lib/nseHolidays.json`** — weekday holidays for 2019-2026 plus
`special_sessions` (Diwali Muhurat dates, and two Saturday live sessions seen in the data). Never keep a second
copy; read it through:

- TypeScript: `rs_dashboard/lib/nseHolidays.ts` (`NSE_HOLIDAYS`, `isNseTradingDay`, `isRegularSession`, `istDateIso`)
- Python: `lib/nse_holidays.py` (`NSE_HOLIDAYS`, `is_nse_trading_day`, `is_regular_session`,
  `regular_session_days`, `drop_non_regular_sessions`)

*Trading day* = weekday and not a holiday. *Regular session* = a trading day that is also not a Muhurat day
(the one-hour Diwali session trades on some weekdays: 2021-11-04, 2022-10-24, 2024-11-01, 2025-10-21).

**Source.** All years come from NSE's own API, `https://www.nseindia.com/api/holiday-master?type=trading&year=YYYY`
(CM segment, identical to F&O), read 2026-10-05. 2026 also matches the NSE web page and the list you pasted.
The 2021-2025 lists the repo used to hold by hand were **wrong in places**: 2023-06-28, 2023-11-13 and 2024-04-10
were really 2023-06-29, 2023-11-14 and 2024-04-11, and 2024-01-22, 2024-05-20, 2024-11-20, 2025-10-22 and
2025-11-05 were missing. The repo's own NIFTY data agrees with NSE's list: the only holiday-dated rows left are
the 2025-10-21 Muhurat session.

### Consumers
- **Live tools:** Focus Tool trading-day/DTE maths (`focusToolRules.ts`), NSE open/closed state (`marketHours.ts`
  `isNseLive`, `marketStatus.ts` `indianMarketState`), `DhanHelper.NSE_HOLIDAYS` (market-open checks,
  `get_next_market_open`, the put-condor, volcano-calendar and IV-snapshot gates), the data downloaders and the
  dashboard refresh route, the momentum review-day projection and runner schedule, the market-data hub, the
  unusual-options scanner and the options screener collector (NSE/BSE only).
- **Backtesting:** every backtest now sees the same calendar as the live tools — non-regular days are dropped
  before any date logic, so a Muhurat hour is never traded as a full session and "N days before expiry" counts
  real sessions. Covered: the shared loader `.claude/skills/dhan-backtest-data/scripts/dhan_data.py`
  (`load_ohlcv(regular_sessions_only=True)`), `lib/momentum.py` loaders (momentum + swing backtests),
  `lib/intraday_signals.load_1m` (intraday-equity backtest), and `backtest_short_straddle`, `_rolling_straddle`,
  `_rolling_straddle_rules`, `_straddle_diff_sl_shift`, `_options_regime`, `_nifty50_rs_v9`, `_ema_breakout`,
  `_ab_test`. The dashboard backtest page spawns these scripts, so it inherits the change. Example: a short-straddle
  intraday run over 2025-10-14..31 used to trade 2025-10-21 (the Muhurat hour); it no longer does.

Deliberately **not** changed: MCX sessions (MCX keeps its own calendar, not modelled);
`scripts/tools/copy_trade_bridge.py`'s `market_is_open()` (it also guards MCX positions); the superseded
`backtest_nifty50_rs` v1-v8 research snapshots (kept reproducible); `backtest_diagonal_call` and
`backtest_condor_to_ratio` (they iterate expiries and use calendar-day time-to-expiry, which is correct).

### Known data gaps (not holidays)
The NIFTY daily CSV lacks three real trading sessions: 2021-01-01, 2023-08-29 and 2024-08-29. The options DB has
the latter two. Fill them with `scripts/downloader/refresh_dashboard_data.py` (Dhan only), not another provider.

Tests: `tests/test_nse_holidays.py`, `rs_dashboard/lib/nseHolidays.test.ts`.

## Weekday holidays (exchange closed) — 16

| # | Date | Day | Holiday |
|---|------|-----|---------|
| 1 | 2026-01-15 | Thursday | Municipal Corporation Election - Maharashtra |
| 2 | 2026-01-26 | Monday | Republic Day |
| 3 | 2026-03-03 | Tuesday | Holi |
| 4 | 2026-03-26 | Thursday | Shri Ram Navami |
| 5 | 2026-03-31 | Tuesday | Shri Mahavir Jayanti |
| 6 | 2026-04-03 | Friday | Good Friday |
| 7 | 2026-04-14 | Tuesday | Dr. Baba Saheb Ambedkar Jayanti |
| 8 | 2026-05-01 | Friday | Maharashtra Day |
| 9 | 2026-05-28 | Thursday | Bakri Id |
| 10 | 2026-06-26 | Friday | Muharram |
| 11 | 2026-09-14 | Monday | Ganesh Chaturthi |
| 12 | 2026-10-02 | Friday | Mahatma Gandhi Jayanti |
| 13 | 2026-10-20 | Tuesday | Dussehra |
| 14 | 2026-11-10 | Tuesday | Diwali-Balipratipada |
| 15 | 2026-11-24 | Tuesday | Prakash Gurpurb Sri Guru Nanak Dev |
| 16 | 2026-12-25 | Friday | Christmas |

## Holidays that fall on a Saturday / Sunday — 4

Already non-trading days, so they are **not** in `NSE_HOLIDAYS`.

| Date | Day | Holiday |
|------|-----|---------|
| 2026-02-15 | Sunday | Mahashivratri |
| 2026-03-21 | Saturday | Id-Ul-Fitr (Ramadan Eid) |
| 2026-08-15 | Saturday | Independence Day |
| 2026-11-08 | Sunday | Diwali Laxmi Pujan* |

\* NSE note: 8 Nov 2026 is a trading holiday for Diwali Laxmi Pujan, but **Muhurat Trading is
held that day**; its timings are to be notified by a later circular. It is a Sunday, so
weekday-based logic does not count it as a trading day. Anything that must see the Muhurat
session needs its own handling.

## Other tables on the page

The page also lists a 20-row table (it adds Gudhi Padwa, Chhatrapati Shivaji Maharaj Jayanti,
Annual Bank Closing on 2026-04-01 and Id-E-Milad on 2026-08-26). The segment label for it did
not survive the page scrape, so it is **not** used by the code and is not reproduced here.
Check the page before relying on it.

## Maintenance

NSE publishes the next year's list late in the year. When it appears, add its weekday holidays to
`rs_dashboard/lib/nseHolidays.json` (re-pull `holiday-master?year=` rather than copying by hand), update the
expected 2026-style list in both test files, add a Muhurat date to `special_sessions.muhurat` when NSE announces
it, and add a new section to this file with the read date. A special Saturday session is a trading day the weekday
logic cannot see — list it under `special_sessions.saturday` if a backtest should know about it.
