# Nifty 500 Momentum Investing Portfolio

Autonomous positional equity strategy. Ranks the Nifty 500 by composite relative strength
versus the Nifty 50, holds up to 10 names, exits on a trailing stop ladder or a weekly
rank-rotation review, and redeploys freed capital into the next qualifying names.

**This is the only multi-day, CNC-delivery, portfolio-level strategy in the repo.** Read
[Operational notes](#operational-notes) before changing anything — several conventions that
hold for the intraday F&O strategies do not hold here.

| | |
|---|---|
| Script | `strategies/momentum_investing/nifty500_momentum.py` |
| Shared rules engine | `lib/momentum.py` (also used by the backtest — do not fork the logic) |
| Backtest | `scripts/analysis/backtest_momentum_portfolio.py` |
| State key | `nifty500_momentum` (`_<instance-id>` when suffixed) |
| Portfolio file | `debug/nifty500_momentum_portfolio.json` |
| Logs | `debug/logs/momentum_investing/YYYYMMDD.log` |

---

## Rules

### Universe
Nifty 500 from `ind_nifty500list.csv` (carries `Industry`, which drives the sector cap).
A name is eligible only with ≥250 bars of history, price ≥ ₹50, and 20-day average traded
value ≥ ₹5 crore. Symbols whose newest bar predates the ranking date are dropped rather than
ranked on stale prices — `debug/confirmed_data_gaps.json` documents multi-year holes in this
dataset.

### Ranking — composite relative strength
```
RS = Σ wₙ · [ (Sₜ / Sₜ₋ₙ) / (Iₜ / Iₜ₋ₙ) − 1 ]     (n, w) ∈ {(10,.10) (21,.20) (63,.40) (126,.30)}
```
Zero means the stock tracked the index exactly. The 63-day term dominates deliberately: long
enough to ignore noise, short enough to catch rotation. Rank 1 = strongest.

### Regime gate — optional (`--no-regime` to disable)
Week W is ON iff the **previous** week's Nifty 50 close was above its 200 SMA. Deciding from
a completed week removes the intra-week whipsaw that hurt earlier daily-regime versions.
Regime OFF ⇒ no new entries, and (by default) the book is liquidated at the review.

Measured over 2019-06 → 2026-08 on the Nifty 500, varying only the filter:

| Variant | CAGR | Max DD | Sharpe | Days invested |
|---|---|---|---|---|
| **weekly 200 SMA + exit (default)** | **13.63%** | **−13.07%** | **1.16** | 70.3% |
| weekly 150 SMA + exit | 13.57% | −13.69% | 1.15 | 66.8% |
| weekly 200 SMA, stay invested | 11.48% | −19.72% | 0.91 | 83.1% |
| weekly 100 SMA + exit | 6.68% | −20.79% | 0.60 | 59.8% |
| weekly 50 SMA + exit | 4.59% | −23.41% | 0.46 | 55.6% |
| `--no-regime` | 13.35% | −18.05% | 1.01 | 90.9% |

Reading: disabling it costs almost no return (−0.28 pts CAGR) but adds **5 points of
drawdown**, so the filter is best understood as risk control that happens to be free rather
than a return driver. In 2020 it returned +24.9% with a −7.1% drawdown against +18.3% / −16.2%
unfiltered.

Two things not to do: **do not speed it up** (100/50 SMA cut returns to a third — a twitchy
filter whipsaws, and each regime exit liquidates the entire book), and note that
`--no-regime-exit` (block buys but hold through) is worse on every axis than either extreme.
150 SMA performs identically to 200, so the parameter sits on a plateau rather than a spike.

### Entry — all must hold at the weekly review
1. Regime ON
2. RS rank ≤ 20
3. `Close > EMA20 > EMA50 > EMA200`
4. Close above the 55-day closing high, confirmed by two consecutive closes
5. Volume above its 20-day average *(skipped when volume is unavailable — see below)*
6. Passes eligibility, within the 2-per-sector cap, not in a post-stop cooldown (10 days)
7. A slot is free

### Exit — checked **daily**, not only at reviews
| Rung | Effect |
|---|---|
| Entry | stop at −12% |
| Peak ≥ +15% | stop = max(stop, entry) — risk removed |
| Peak ≥ +25% | stop = max(stop, peak × 0.75) — trailing |
| Close < stop | exit |

**There is no fixed profit target.** A target caps exactly the right tail momentum depends
on; backtested +30% ⇒ 9.00% CAGR, +60% ⇒ 9.69%, none ⇒ 11.54%, and widening the trail from
there reached 14.20%.

Rungs are **cumulative floors, not exclusive branches**. An `if/elif` would let a position
that gaps straight past +25% skip the breakeven rung, and with a 25% trail the resulting
stop sits below entry (1.30 × 0.75 = 0.975) — a stock up 30% could stop out for a loss.
Both rungs apply and the stop takes the max.

Additionally at reviews only: sell if rank > 25 for **two consecutive** reviews (one bad week
in a 500-name universe is noise), subject to a 7-day minimum hold.

### Sizing
10 slots. Ranks 1–5 get a 4:3 larger allocation than ranks 6–10 — exactly ₹20k/₹15k on
₹1.75L. The weights are **derived from `slots`**, so any slot count commits 100% of capital;
they were briefly hardcoded for 10 slots, which left `--slots 8` 17% in cash and made
`--slots 15` commit 143% and silently fail to fund its last positions.
Freed capital returns to cash and is redeployed at the next review, with **no cap on new buys
per review** — capping it at 2/week left the book permanently under-filled and cost roughly
4 points of CAGR in idle cash.

---

## Backtested performance

Nifty 500, 2019-06 → 2026-08, ₹1.75L, costs at 0.111%/side + ₹20/order + 0.05% slippage:

| | Strategy | Nifty 50 | FD @6.45% |
|---|---|---|---|
| Total return | **150.05%** | 103.62% | 56.55% |
| CAGR | **13.63%** | 10.43% | 6.45% |
| Max drawdown | **−13.07%** | −38.44% | 0% |

293 trades · win rate 40.3% · profit factor 1.94 · Sharpe 1.16 · Calmar 1.04.
Exits: rebalance 142, stop 110, regime 41.

Split-sample (the parameters were tuned on the full period, so the second row matters most):

| Period | Strategy | Nifty 50 |
|---|---|---|
| 2019–2022 | 20.88% | 11.96% |
| **2023–2026 (held out)** | **14.07%** | 8.79% |

**Known limitations — do not treat the CAGR as an expectation:**
- **Survivorship bias.** The universe is *today's* Nifty 500 list, so names added after a
  strong run are ranked during that run. No point-in-time constituent history exists here.
- In 2023–2026 the drawdown was −19.2% against the index's −15.8%: it is not always the
  calmer holding.
- Seven years is roughly one full cycle, mostly bullish. The regime gate has been tested on
  one major crash (2020) and one correction.

---

## Running it

```powershell
# One cycle then exit — safe any time, and the right form for Task Scheduler
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py --once

# Paper daemon: cycles every trading day at 15:20 IST
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py

# Live delivery trading — NOT IMPLEMENTED YET (Phase 4)
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py --live
```

Dry run is the default. `--live` currently refuses to place orders and logs an alert rather
than trading — real CNC execution lands in Phase 4.

Useful flags: `--capital`, `--slots`, `--stop`, `--trail-pct`, `--target` (`none` by default),
`--buy-rank-limit`, `--sector-cap`, `--run-at`, `--instance-id`, and the regime controls
`--no-regime` / `--no-regime-exit` / `--regime-sma N`.

The dashboard exposes capital, slots and a **Market Filter** checkbox on the Strategies card;
unchecking it passes `--no-regime`. It defaults to on, and the `/momentum` page then shows a
grey **NO REGIME FILTER** chip instead of the usual REGIME ON/OFF — with the filter disabled
every day reports "on", which would otherwise read as "the market is in an uptrend" rather
than "we are not checking".

**Data dependency:** the strategy ranks off `Daily_Historical_Data_Fresh/`, so
`scripts/downloader/refresh_dashboard_data.py` must have run. If the newest bar is more than
4 days old the cycle aborts rather than rotating the book on stale prices.

---

## Operational notes

These differ from every other strategy here.

**Positions survive restarts.** The book lives in `debug/<state_key>_portfolio.json`, written
atomically after every mutation and reloaded on startup — holdings, ratcheted stop, peak
close, ladder stage, cooldowns, cash and closed trades. Nothing else in this repo does this
(the crudeoil strategies restore P&L only). A restart mid-week must not lose the book, and
**a corrupt portfolio file raises rather than starting flat** — starting flat would re-buy
names already held.

**The ratcheted stop is restored verbatim, never recomputed.** Recomputing it from the entry
price would silently undo every raise.

**Product type is CNC.** `helper.place_entry()` and `place_sl_market()` both default to
`MARGIN`, so CNC must be passed explicitly at every call site (Phase 4).

**Do not use `close_position()` / `get_net_quantity()` / `resolve_exit_qty()` for exits.**
All three read `dhan.get_positions()`, which returns *day* positions only — a CNC holding
bought last week reports 0. Sell an explicit quantity from the portfolio file, reconciled
against `helper.get_holdings()`.

**RS is computed on a benchmark-aligned calendar.** `build_rs_matrix()` reindexes every symbol
onto the Nifty's trading days before any lookback. Comparing `stock[-1-n]` to `index[-1-n]`
positionally is wrong whenever a stock is missing bars the index has — and only 3 of 483
Nifty 500 symbols share the index's calendar exactly. `backtest_nifty50_rs_v9.py` has this
bug; it never showed because a Nifty 50 universe is nearly aligned.

**A symbol missing from the ranking is not a sell signal.** `rank_universe()` drops any symbol
without a fresh bar, so a stale CSV looks identical to a collapse in relative strength.
`rank_rotation_exits()` therefore holds the strike counter steady for unranked names instead
of incrementing it — otherwise two bad data days would force-sell a healthy position.

**Prices come from `bulk_ltp()`**, one batched request per segment. Never loop `get_ltp()`
over the portfolio; the Dhan quote endpoint is limited to roughly 1 req/s.

**`wait_for_next_day_market_open()` is unusable here** — it returns immediately in dry-run,
so it cannot pace a multi-day paper run. The strategy uses its own `sleep_until()`, which
ticks once a second so the dashboard stop button still works overnight.

**Volume filter degrades gracefully.** `fetch_today_quotes.py` writes `Volume=0` for the
patched intraday row; `load_daily()` converts that to NaN and the volume test is skipped
rather than rejecting every candidate on quote-patched days.

**Timing vs the backtest.** The backtest signals on day D's close and fills at D+1's open.
Live, the cycle runs at 15:20 and fills at LTP. So the ranking "close" is a near-final 15:20
price, and live fills avoid the overnight gap risk the backtest charges itself. Neither
difference flatters live results.
