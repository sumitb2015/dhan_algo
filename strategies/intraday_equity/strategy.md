# Intraday Equity — Nifty 50 VWAP + Relative Strength

**Status: NOT VALIDATED. Dry run only.** See [Backtest verdict](#backtest-verdict).

`nifty50_vwap_rs.py` — multi-symbol intraday cash-equity auto-trader. Buys Nifty-50
names showing VWAP + trend confluence while outperforming NIFTY intraday, with ATR
stops, an R-multiple target, and a hard square-off.

## Where the logic lives

All rules are in [`lib/intraday_signals.py`](../../lib/intraday_signals.py) — a pure,
broker-free module imported by **both** the live strategy and
[`scripts/analysis/backtest_intraday_vwap_rs.py`](../../scripts/analysis/backtest_intraday_vwap_rs.py).
This mirrors the `lib/momentum.py` precedent. **Do not reimplement entry, sizing,
stop or exit logic in either caller** — if the two drift, a dry-run session can no
longer be reconciled against a replay of that session, which is the only real check
on whether the backtest is telling the truth.

## Signal

Long-only by default. Evaluated on the last **confirmed** bar (`iloc[-2]`).

**Hard gates — all must pass:**
| Gate | Meaning |
|---|---|
| `above_vwap` | Price at least `min_vwap_edge_bps` above session VWAP |
| `st_bull_htf` | Supertrend bullish on the confirmation frame (`htf_min`, default **30m**) |
| `adx_ok` | HTF ADX ≥ `adx_min` |
| `rs_day_ok` | Outperforming NIFTY since the open |
| `not_stretched` | Within `max_vwap_stretch_atr` ATRs of VWAP (don't chase) |

**Soft (score only):** `ema_stacked` (EMA9 > EMA20), `rs_lb_ok` (lookback RS), `vol_ok`.

**Score, 0–100:** RS 30 · ADX 20 · VWAP edge 20 · Supertrend headroom 15 · EMA stack 10 ·
volume 5. This is a **ranking heuristic**, not a proven quality filter — no score bucket
was profitable in the 81-session sample. `min_score` (default 60) is only a cutoff after
the hard gates. Candidates are ranked, then filtered by `max_positions` and `max_per_sector`.

The live poller watches a subset of the universe between full sweeps. That watchlist is
built **gated first, then one-hard-gate-away, then remaining by score** so candle budget
follows names that can actually trade.

## Risk and exits

- Size = `risk_per_trade / |entry − stop|`, clamped by `max_order_value` and remaining
  `max_deployed`. **Returns 0 (skip) when unsizable — never falls back to 1 share.**
- Stop = `atr_stop_mult × ATR`; target = `target_r × R`; trailing stop arms at
  `trail_arm_r` and only ever ratchets.
- Exit priority: `SQUARE_OFF` → `STOP` → `TARGET` → `ST_FLIP` → `VWAP_LOSS` → `RS_LOSS`.
  Price levels evaluate on live LTP; signal exits on the confirmed bar.
- Square-off at **15:17**, retried every 15s until 15:25, then logs `CRITICAL … MANUAL
  INTERVENTION` and stays alive rather than exiting with positions open.

## Rate-limit architecture (the structurally new part)

This is the only multi-symbol strategy in the repo. Three tiers keep 50 symbols inside
a 1 req/s quote budget:

1. **LTP** — one `get_ltps()` call per second for all 50 + NIFTY. Serves from the
   WebSocket first, then a 1s cache, then a single batched REST call. No per-symbol
   `get_ltp()` anywhere.
2. **Candles** — one REST call per symbol, so a full 50-symbol sweep costs ~55s. A full
   sweep runs every `--rerank-minutes` to pick a **watchlist** of the top
   `--watchlist-size`; only those are polled each cycle. Open positions are always
   polled. These calls are paced by `--candle-pace` (default 0.8s): the intraday-data
   endpoint is a *separate* rate bucket that `DhanHelper` does not pace, and firing it
   back-to-back returns `DH-904 Rate_Limit` (observed 2026-08-09).
3. **Fills** — order-update WebSocket, with `wait_for_fill` as fallback.

The 1-second hot loop only reads a snapshot the poller thread publishes; it never
touches pandas and never makes a network call.

## Safety rails

`--max-positions` (3) · `--max-per-sector` (2) · `--max-order-value` · `--max-deployed` ·
`--risk-per-trade` · `--max-daily-loss` · `--target-profit` · `--max-trades` ·
`--max-symbol-trades` · `--symbol-cooldown` · `--entry-spacing` · order-reject backoff
(30s → 5min → day blacklist) · shutdown trigger.

Non-obvious ones worth keeping:
- **`--max-per-sector`** — `max_positions=3` reads as diversified, but HDFCBANK +
  ICICIBANK + AXISBANK is one bank bet at 3× size.
- **Unpriced-position guard** — if any open position has no LTP, the daily target/stop
  check is *skipped entirely*. Marking one unpriced position at a total loss would trip
  the daily stop on nothing more than a missing quote.
- **Exits use `resolve_exit_qty`**, never `close_position()` / `get_net_quantity()` /
  `cancel_all_orders()` — those are account-wide and would flatten another strategy's
  leg in the same security.
- **Software stops, not `place_sl_market`** — that helper converts to an SL-*Limit* with
  a ±5% cushion, so a fast move can blow through it while you believe you are protected.
- **Partial fills** — `pos.qty` is set from the actual filled quantity, not the request.

## Backtest verdict

Run 2026-08-09 over **81 sessions** (2026-04-13 → 2026-08-07), all 50 symbols.
Gate to go live: **expectancy > +0.15 R**.

**Timeframe matters, and it was the single biggest fixable cost.** Expectancy improves
monotonically as the clock slows:

| Base / confirm | Expectancy | PF | Trades |
|---|---|---|---|
| 1m / 5m (original) | −0.282 R | 0.47 | 338 |
| 5m / 15m | −0.160 R | 0.59 | 537 |
| **5m / 30m + no VWAP exit (current default)** | **−0.09 R** | **0.80** | 425 |
| 15m / 60m | −0.092 R | 0.72 | 500 |

1-minute bars were mostly noise. But slowing down is **not sufficient** — every
timeframe still loses, and the best config is **−0.09R even at ZERO cost** (PF 0.88).
So the residual is the rules, not fees. It also lost money while NIFTY drifted **+4.5%**.

Diagnostics worth keeping:
- The remaining gap is **entry selectivity**: 68 targets at +2.48R vs 309 stops at
  −0.68R — a 16% target-hit rate where break-even needs 21.5%.
- `VWAP_LOSS` fired on 222 of 338 trades at −0.75R in the original run. Price crosses
  VWAP constantly intraday, so it cut winners before they worked. **Now off by default.**
- Entry score is only *weakly* predictive (corr +0.086; worst decile −0.48R, best −0.01R) —
  some information, but **no score bucket is profitable**. A better clock cannot fix a
  weak signal.
- **Only 09:30–10:00 is positive** (+0.18R over 114 trades); every later hour loses,
  worst at 14:xx (−0.40R). The edge decays through the day.
- Inverting the signal yields +0.209R — it is systematically buying strength that
  mean-reverts. Together with the opening-window result, both point at **fading
  extension** rather than chasing it as the more promising rule family.
- Stacking four changes reached break-even (+0.067R, 129 trades) on the original
  timeframe. That is in-sample search on one regime, not an edge, and is **not** a
  basis for going live.

⚠️ ~18 variants have now been evaluated on this 81-session sample. The *directions*
(slower is better, opening is better, fade beats chase) are more trustworthy than any
individual number. A genuinely new rule set should be validated on data this search has
not touched.

**Consequence:** `--live` requires `--i-understand-the-backtest-failed`. Re-run the
backtest after any rule change; the gate is out-of-sample expectancy > 0.15R.

## Commands

```powershell
# Refresh the 1-minute store first (append-only — run daily, it cannot backfill later)
venv\Scripts\python.exe scripts\downloader\refresh_intraday_1min.py

# Backtest
venv\Scripts\python.exe scripts\analysis\backtest_intraday_vwap_rs.py --cost-sensitivity
venv\Scripts\python.exe scripts\analysis\backtest_intraday_vwap_rs.py --no-vwap-exit --excel --plot

# Dry run (default)
venv\Scripts\python.exe strategies\intraday_equity\nifty50_vwap_rs.py
venv\Scripts\python.exe strategies\intraday_equity\nifty50_vwap_rs.py --watchlist-size 8 --poll-seconds 25

# Unit tests (pure/offline — safe against a live account)
venv\Scripts\python.exe -m pytest tests\test_intraday_signals.py -q
```

Dashboard: **/terminal** (blotter, positions, chart, log, start/stop) and **/strategies**.
