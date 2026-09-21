# Strategy Families: What to Copy and What Bites

Pick the closest family, read its `strategy.md` and script, and copy its structure. Line counts are
approximate and only there to tell you which file is the compact one.

## Contents
1. Which sibling to copy
2. Index options, intraday (`value_imbalance/`, `spread_trend/`, `st_oi_bearcall/`, `oi_directional/`)
3. Index options, held (`overnight_fly/`, `delta_strangle/`)
4. MCX crude futures (`crudeoil/`)
5. Cash equity intraday (`intraday_equity/`)
6. Positional delivery (`momentum_investing/`)
7. Cross-family conventions that are easy to violate

## 1. Which sibling to copy
| Your idea | Copy | Why |
|---|---|---|
| Sell a straddle/strangle, adjust or roll on premium imbalance | `value_imbalance/nifty_advanced_imbalance.py` (reference for the 466e225 audit) | most complete leg/roll/trail handling |
| Roll a straddle on a trigger, capped | `value_imbalance/nifty_rolling_straddle.py` | transactional entry, roll booked once |
| VWAP / VIX / supertrend gated straddle | `nifty_vwap_1min_straddle.py`, `nifty_vix_straddle.py` | entry gates, hysteresis, per-day caps |
| Defined-risk credit spread on a trend signal | `spread_trend/`, `st_oi_bearcall/` | long-leg-first entry with rollback, min-hold |
| Naked directional sell off OI/PCR | `oi_directional/` | chain poller thread, expansion window |
| Hedged position held past the close | `overnight_fly/nifty_overnight_fly.py` | position file, hedge invariant, `MARGIN` |
| Weekly carry with delta management | `delta_strangle/nifty_delta_strangle.py` | best status machine, reconcile, confirm-close |
| Futures trend follower | `crudeoil/crudeoilm_supertrend.py` (compact) | MCX session/segment handling |
| Multi-symbol cash equity | `intraday_equity/nifty50_vwap_rs.py` | risk-per-trade sizing, rate-limit architecture |
| Multi-day delivery portfolio | `momentum_investing/nifty500_momentum.py` | portfolio file, `--once`, rank rotation |

## 2. Index options, intraday
- Product `INTRADAY`; flatten at **15:17** (`--eod-time`); start gate `--start-time` (09:20 typical).
- Underlying id for options is **26000**, not the index id 13 used for spot and expiry lists.
  `helper.get_lot_size("NIFTY")` for lots, `helper.get_nearest_expiry`, `helper.days_to_expiry`.
- Multiple instances routinely run on the same strike, so `resolve_exit_qty*` is mandatory here.
- Spreads: buy the protective (long) leg first, then sell; if the short fails, sell the long back
  (`st_oi_bearcall`). Exit the short first, then the long, so margin never spikes.
- Indicator/candle fetches happen once per candle interval (floored ~60 s), never inside a 1 s loop.
  `spread_trend` and `st_oi_bearcall` once did `days=5` history pulls every second (`466e225`).
- Session-anchored signals (option VWAP from 09:15) can fire the instant you enter; add a
  `--min-hold-minutes` guard (`3366b49`).
- Start-of-session data races: the first chain fetch and the poller thread can both hit the 1 req/s
  quota; let the poller win and fall back after a short wait (`55dfacf`).

## 3. Index options, held
- Product `MARGIN`, never `INTRADAY`: an MIS order is force-squared by the broker near close regardless
  of your loop. Put the constant at the top of the file and say why in the docstring.
- Position file is mandatory, restore refuses corrupt files, legs are re-subscribed, reconcile runs
  (`references/state-and-recovery.md`).
- Entry is date-driven (`days_to_expiry()`); a fixed `--entry-dte` is not holiday-aware. Say so in the
  spec's "not done" section.
- Stop **flattens** these (nothing supervises a live short otherwise), unlike `momentum_investing`
  where Stop leaves holdings in place. Decide and document which, in the spec.
- Expiry-day close uses the normal 15:17 rule, only on the last day.
- Hedge drag/roll must be all-or-nothing; a failed hedge close leaves the original hedge tracked.

## 4. MCX crude futures
- Constants: `SYMBOL="CRUDEOILM"`, `EXCHANGE="MCX"`, `INSTRUMENT="FUTCOM"`, `SEGMENT="MCX_COMM"`.
  `get_ltp()` must be called with the MCX segment or it defaults to the wrong one (`b70fba0`,
  `cefdd4a`: `FUTCOM` missing from `get_ltp`). Resolve the contract with `helper.find_future(...)`.
- Session is 09:00-23:30 IST with no weekday guard; `helper.wait_for_market_open()` uses the NSE
  holiday calendar and is **wrong** here. Use the time-only `_wait_for_mcx_session()` pattern, and
  keep `check_shutdown_trigger` inside it.
- Lot size: read from the master list (`lot_from_master if > 1`), fall back to 10 (MCX mini). Never
  invent a larger fallback; the crude-options dashboard page had to correct its own fallback to 1 rather
  than 100 (`b7c3ce0`). Kotak MCX quantity semantics differ ~100x from Dhan; read
  `docs/API_GOTCHAS.md` before sizing any Kotak MCX order.
- Futures have no option chain; P&L per point is `qty * points`. Dhan's positions API has no
  last-price column (the dashboard had to back-solve LTP from unrealized P&L, `820a66a`), so a strategy
  reads LTP from `get_ltp()` / the WebSocket instead.
- Cumulative daily P&L restores on restart (`_restore_daily_pnl`, `4aa3242`); cooldowns are counted in
  candles from timestamps, not by assuming one candle.
- Validate that a stop or target price is on the correct side of LTP before arming it, or it fires
  instantly (the crude-options dashboard hit this, `4c269eb`; the same check belongs in any strategy that
  accepts a price level).
- `crudeoil/` scripts set the state key by reassigning a module global inside `if __name__ ==
  "__main__":`. That works only because that block is module scope; prefer passing `state_key` into
  the class as `overnight_fly` and `delta_strangle` do.

## 5. Cash equity intraday
- Sizing is risk-per-trade over ATR stop distance, capped by `--max-order-value`, `--max-deployed`,
  `--max-positions`, `--max-per-sector`; add `--max-daily-loss` with a hard kill-switch.
- Rate limits are the structural problem across ~50 symbols: batch quotes, pace candle pulls
  (`--candle-pace`), rank on a schedule (`--rerank-minutes`), never per-symbol REST per second.
- Signals live in a shared pure module (`lib/intraday_signals.py`) that the backtest replays, so a dry
  run and a backtest of the same session must produce identical trades. Do this for any new strategy
  with a backtest: one signal implementation, two callers.
- Validation gate: if the backtest fails its threshold the strategy ships dry-run only, with a
  deliberate flag for `--live`, and the docstring says so first.

## 6. Positional delivery
- Product `CNC`, passed explicitly at every call site (`place_entry` defaults to `MARGIN`).
- Paper by default (`--live` for real orders); `--once` runs one review cycle and exits; `--run-at`
  schedules the daily cycle (default 15:20).
- Portfolio is persisted to `debug/nifty500_momentum_portfolio.json` and survives restarts; Stop leaves
  holdings in place (no supervising loop is needed to protect them).
- Rank-based rotation with a trailing-stop ladder, sector cap and a market-regime exit; regime and
  rank limits are flags, and each can be disabled with a `--no-*` flag.

## 7. Cross-family conventions that are easy to violate
- Naive `datetime.now()` is used throughout, so the host clock must be IST. Time gates compare
  `"HH:MM"` strings (`--start-time`, `--eod-time`), which is why every such flag is validated with
  `datetime.strptime(v, "%H:%M")`.
- `NIFTY` symbol, exchange `IDX_I` for the index, `NSE_FNO` for option ids, `instrument="OPTIDX"`;
  always pass `instrument=` and `exchange=` (never `exchange_segment=`) to `get_ltp()`.
- Subscribe a security to the WebSocket before polling it in a tight loop, so `get_ltp()` is served
  from `helper.live_data` instead of spending the shared ~1 req/s REST quota.
- Break-glass helpers (`close_position`, `cancel_all_orders`, `close_all_positions`) belong to a panic
  exit only; they act on the whole account.
- A strategy that is unvalidated, experimental or dry-run-only says so in its docstring, its
  `strategy.md` first paragraph, and (if applicable) by a friction flag on `--live`.
