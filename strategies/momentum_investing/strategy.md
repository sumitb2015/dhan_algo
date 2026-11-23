# Nifty 500 Momentum Investing Portfolio

Autonomous positional equity strategy. Ranks the Nifty 500 by composite relative strength
versus the benchmark (Nifty 50 by default, `--benchmark nifty500` optional), holds up to 10
names, exits on a trailing stop ladder or a weekly rank-rotation review, scans for new
entries every session, and sizes each slot off current equity so profits are reinvested.

**This is the only multi-day, CNC-delivery, portfolio-level strategy in the repo.** Read
[Operational notes](#operational-notes) before changing anything — several conventions that
hold for the intraday F&O strategies do not hold here.

| | |
|---|---|
| Script | `strategies/momentum_investing/nifty500_momentum.py` |
| Shared rules engine | `lib/momentum.py` (also used by the backtest — do not fork the logic) |
| Backtest | `scripts/analysis/backtest_momentum_portfolio.py` (same engine as the `/momentum` replay: identical results on the same window) |
| Replay | `scripts/analysis/simulate_momentum_replay.py` (engine v2), tests `tests/test_momentum_engine.py` |
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
dataset. A run of 20+ sessions with no bar (`gap_reset_days`: a delisting and relisting, a long
suspension, a CSV hole) restarts the 250-bar count: until then the symbol is neither ranked nor
bought. Before this rule HEXT (no bars 2020-10-30 → 2025-02-19) compared its relisting price with
its 2020 price and ranked #1, with an RS of about +2.7, for two months.

### Ranking — composite relative strength
```
RS = Σ wₙ · [ (Sₜ / Sₜ₋ₙ) / (Iₜ / Iₜ₋ₙ) − 1 ]     (n, w) ∈ {(10,.10) (21,.20) (63,.40) (126,.30)}
```
I is the benchmark: the Nifty 50 by default (`--benchmark nifty500` to switch; it also drives the regime).
Zero means the stock tracked the index exactly. The 63-day term dominates deliberately: long
enough to ignore noise, short enough to catch rotation. Rank 1 = strongest.

### Regime gate — optional (`--no-regime` to disable)
Week W is ON iff the benchmark's close on the last session of week W−1 was above its daily
200 SMA (`--regime-interval daily` checks each day's close instead). Regime OFF ⇒ no new
entries, and (by default) the book is liquidated.

Measured over 2019-06-03 → 2026-11-20 on the Nifty 500 (engine v2: daily entries, weekly
rotation, compounding), varying only the filter:

| Variant | CAGR | Max DD | Sharpe | Days invested |
|---|---|---|---|---|
| **weekly 200 SMA + exit (default)** | **23.84%** | **−23.57%** | **1.15** | 67.3% |
| weekly 150 SMA + exit | 23.18% | −22.33% | 1.14 | 65.3% |
| weekly 200 SMA, stay invested (`--no-regime-exit`) | 23.54% | −23.54% | 1.06 | 86.1% |
| weekly 100 SMA + exit | 15.85% | −24.50% | 0.87 | 60.3% |
| weekly 50 SMA + exit | 13.53% | −29.87% | 0.83 | 56.4% |
| `--no-regime` | 21.40% | −29.04% | 0.94 | 91.4% |

Reading: switching the filter off costs 2.4 points of CAGR and adds 5.5 points of drawdown,
so it is both risk control and a small return driver. **Do not speed it up**: 100/50 SMA cut
CAGR by a third or more, because a twitchy filter whipsaws and each exit liquidates the whole
book. 150 SMA performs like 200, so the parameter sits on a plateau. Staying invested through
OFF weeks (`--no-regime-exit`) now matches the default on CAGR and drawdown with a lower Sharpe.
On the pre-2026-11-23 engine it was worse on every axis; that conclusion no longer holds.

### Entry — checked every session; all must hold
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

**There is no fixed profit target by default.** The original argument was that a target caps
the right tail momentum depends on. The old engine supported it: +30% ⇒ 9.00% CAGR, +60% ⇒
9.69%, none ⇒ 11.54%. **On engine v2 that no longer holds** (2019-06 → 2026-11):

| Target | CAGR | Max DD | Sharpe | Calmar | PF | Trades |
|---|---|---|---|---|---|---|
| none (default) | 23.84% | −23.57% | 1.15 | 1.01 | 1.73 | 378 |
| +60% (`--target 60`) | 24.39% | −21.79% | 1.22 | 1.12 | 1.61 | 437 |
| +30% (`--target 30`) | 23.17% | −17.41% | 1.25 | 1.33 | 1.55 | 515 |

A +30% target gives up 0.7 points of CAGR for 6 points less drawdown. This is one sweep over the
full period, not validated out of sample, so the default is unchanged. Revisit it with a
split-sample test.

Rungs are **cumulative floors, not exclusive branches**. An `if/elif` would let a position
that gaps straight past +25% skip the breakeven rung, and with a 25% trail the resulting
stop sits below entry (1.30 × 0.75 = 0.975) — a stock up 30% could stop out for a loss.
Both rungs apply and the stop takes the max.

Additionally, **once a week** (the first cycle of each ISO week, `rotation_due()`): sell if
rank > 25 for **two consecutive** weekly reviews (one bad week in a 500-name universe is noise),
subject to a 7-day minimum hold. It must stay weekly. Commit 4211016e ran it daily, so "two
reviews" became two days: 426 of 590 rotation sells came within 14 days of the buy, and the
2020-26 replay fell from 17.5% CAGR / PF 2.22 to 15.7% / 1.71 (fixed slots).

### Sizing
10 slots. Ranks 1–5 get a 4:3 larger allocation than ranks 6–10. The weights are **derived
from `slots`**, so any slot count commits 100%. They were briefly hardcoded for 10 slots, which
left `--slots 8` 17% in cash and made `--slots 15` commit 143%.

**Slots are a share of current equity** (cash + holdings at market; the replay and backtest
use the previous close, live uses LTP), so profits are redeployed (`compound`, default on;
`--no-compound` sizes off `--capital`). Sizing off the starting capital left the book ~29%
invested by 2026 in a 2020-26 replay: its later returns and drawdowns described a cash account.
With fixed slots the same 2019-06 → 2026-11 run gives 15.52% CAGR / −15.49% DD / Sharpe 1.23,
against 23.84% / −23.57% / 1.15 compounding. Compounding raises the drawdown in rupees and in
percent; that is the price of staying invested.

Freed capital returns to cash and is redeployed by the next session's scan, with **no cap on
new buys per day**. Capping it at 2 per review left the book permanently under-filled and cost
about 4 points of CAGR in idle cash.

---

## Backtested performance

Nifty 500, 2019-06-03 → 2026-11-20, ₹5L, engine v2 (daily entries, weekly rotation,
compounding, data-gap exits), costs at 0.111%/side + ₹20/order + 0.05% slippage, Nifty 50
benchmark and regime:

| | Strategy | Nifty 500 |
|---|---|---|
| Total return | **393.5%** | — |
| CAGR | **23.84%** | 10.69% |
| Max drawdown | **−23.57%** | −38.44% |

378 trades · win rate 43.1% · profit factor 1.73 · Sharpe 1.15 · Calmar 1.01.
Exits: rebalance 188, stop 122, regime 67, data gap 1.

Split sample (each window starts flat at ₹5L):

| Period | Strategy CAGR / DD | Nifty 500 CAGR / DD |
|---|---|---|
| 2019-06 → 2022-12 | 33.42% / −23.57% | 11.96% / −38.44% |
| **2023-01 → 2026-11** | **18.65% / −22.76%** | 9.41% / −15.77% |

The previous figures here (13.63% CAGR, −13.07% DD, 293 trades) described the weekly-buy,
fixed-slot system and are superseded. The replay and this backtest now agree exactly on the
same window (2020-01-10 → 2026-11-20: ₹25,28,917, 377 trades).

**Known limitations — do not treat the CAGR as an expectation:**
- **Survivorship bias.** The universe is *today's* Nifty 500 list, so names added after a
  strong run are ranked during that run. No point-in-time constituent history exists here.
- In 2023–2026 the drawdown was −22.8% against the index's −15.8%: it is not always the
  calmer holding.
- Seven years is roughly one full cycle, mostly bullish. The regime gate has been tested on
  one major crash (2020) and one correction.
- The regime, target and sizing sweeps above were run on the full period, so they are in-sample.

---

## Running it

```powershell
# One cycle then exit — safe any time, and the right form for Task Scheduler
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py --once

# Paper daemon: cycles every trading day at 15:20 IST
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py

# Live delivery trading (Phase 4 — automated CNC delivery orders)
venv\Scripts\python.exe strategies/momentum_investing/nifty500_momentum.py --live
```

Dry run is the default. `--live` places real CNC delivery orders via `DhanHelper` with fill confirmation.
Selling CNC shares requires active Demat Debit and Pledge Instruction (DDPI) or daily CDSL eDIS
authorization on Dhan; if unauthorized, Dhan will reject the sell order and the strategy logs
an alert.

Useful flags: `--capital`, `--slots`, `--stop`, `--trail-pct`, `--target` (`none` by default),
`--buy-rank-limit`, `--sector-cap`, `--run-at`, `--instance-id`, `--no-compound`,
`--benchmark nifty50|nifty500`, and the regime controls `--no-regime` / `--no-regime-exit` /
`--regime-sma N` / `--regime-interval weekly|daily`.

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

**Rank rotation is weekly, entries are daily.** `last_rotation_date` is persisted in the
portfolio file, and `rotation_due()` allows one rotation per ISO week. A Monday the bot missed
therefore rotates on Tuesday instead of skipping the week. The rotation's strike counter
assumes exactly one call per week.

**A data gap closes the position in simulation.** The replay and backtest close a held symbol
after 5 sessions with no bar (`gap_exit_days`), at its last close. Before this, HEXT was held at
a frozen ₹235 for 4.3 years and "sold" at its ₹745 relisting price: a fake +₹92.5k, about 11% of
the run's realized profit. Live sells at LTP and is unaffected.

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

## Model: Minervini Trend Template (`--model minervini`)

Alternative entry/exit model, selected with `--model minervini` (default stays `turtle_rs`). Rules live in
[`lib/minervini.py`](../../lib/minervini.py), shared with the historical replay
(`scripts/analysis/simulate_momentum_replay.py`) so the replay is evidence for this exact code.

- **Entry** (checked every session at `--run-at`, not only at the weekly review): Close > 50 > 150 > 200 SMA; 200 SMA
  above its level 22 sessions ago; >=25% above the 52-week low and within 20% of the high; close at/above the 20-day
  closing high (`--breakout-days 10` for a tight VCP) but no more than 5% above it; volume >= 20-day average;
  composite-RS percentile >= 70.
- **Exit**: close below the stop. Initial stop `--stop` % (default 12) below entry; after +15% it trails the 50 SMA and
  never loosens. Regime liquidation stays weekly. No rank rotation.
- **Book isolation**: the portfolio file records its model; a run with the other model refuses to start
  (use `--instance-id` to run both). Files from before this flag count as `turtle_rs`.
- **Validation**: replay on Nifty 500, 10 slots, regime on, pre-2026-11-23 engine (fixed slots, daily rotation): 2020-23 +192% (PF 3.84), 2024-26 +36% (PF 1.87). Engine v2 (compounding, data-gap rules), 2020-01-10 → 2026-11-20: 31.24% CAGR, −28.76% DD, PF 2.27, 254 trades (`backtest_strategy_comparison.py`). Parameters
  were tuned looking at both windows, so 2024-26 is lightly in-sample; 2025-26 alone was weak for momentum. Live fills
  happen at the 15:20 LTP, not the next open as in the replay. **Paper-trade it first** (`--once`, no `--live`).

## Model: Scanner Top-N (`--model scanner_top`)

Holds the **`/scanner` page's top N** (Nifty 500 universe) in its exact order and rotates it with the momentum
engine. Added 2026-11-23. **It failed its held-out test, so paper-trade it only.**

- **Ranking**: the scanner's own. That is the 0-15 checklist score (close vs EMA 20/50/200, Supertrend 7/3,
  RSI > 60, MACD, ADX > 25, volume > 1.5x the 20-day average, 252-day RS rising and above its 21-bar average), then
  the RS percentile, then that day's volume ratio. The maths lives in `rs_dashboard/lib/scannerMath.ts`.
  `lib/scanner_score.py` is its Python port, held to it by `tests/test_scanner_score_parity.py` against
  `lib/scannerMath.parity.json`. It reproduced the live scanner's 2026-11-20 top 15 exactly. Inputs are
  corporate-action adjusted, like the dashboard (`lib/corporate_actions.py`), and the model trades on the same
  adjusted series.
- **Entry (every session)**: scanner rank ≤ N, regime ON, max 2 per sector, 10-day cooldown after a stop, a bar
  today, and 60 bars since any long data gap. There is no other technical gate: the scanner's rank is the rule.
- **Exit**: the Turtle ladder (stop %, breakeven at +15%, 25% trail from +25%), plus a weekly rotation that sells a
  holding ranked below the sell buffer for two consecutive weekly reviews. The regime filter liquidates.
- **Defaults** (`SCANNER_TOP_DEFAULTS`): N = 15, sell below rank 45, 20% stop, sector cap 2. Flags: `--top-n`,
  `--sell-rank`, plus the usual `--stop` / `--sector-cap`. Always run it under its own `--instance-id`.

### Split-sample sweep (`scripts/analysis/optimise_scanner_top.py`, results in `debug/scanner_top_sweep/`)
32 configs (N 10/15 × sell buffer N/2N/3N/60 × stop 12/20 × sector cap 2/off) were tuned on 2020-01-10 → 2023-12-29
and ranked by Calmar. The top 3 were then run once on 2024-01-01 → 2026-11-20. Engine v2, ₹5L, Nifty 50 regime.

| Config | Window | CAGR | Max DD | Calmar | PF | Trades |
|---|---|---|---|---|---|---|
| **N15, sell >45, stop 20, cap 2 (default)** | tune 2020-23 | 45.19% | −19.73% | 2.29 | 1.89 | 684 |
| | **held-out 2024-26** | **−4.01%** | **−26.65%** | −0.15 | 0.90 | 441 |
| | full 2020-26 | 21.73% | −27.08% | 0.80 | 1.33 | 1126 |
| N15, sell >60, stop 20, cap 2 | held-out 2024-26 | −2.97% | −22.79% | −0.13 | 0.92 | 403 |
| N15, sell >45, stop 12, cap off | held-out 2024-26 | 5.80% | −23.90% | 0.24 | 1.14 | 432 |
| default, no regime filter | full 2020-26 | 15.67% | −39.98% | 0.39 | 1.17 | 1416 |
| turtle_rs (live default) | tune 2020-23 | 43.87% | −23.57% | 1.86 | 2.24 | 227 |
| | held-out 2024-26 | 6.27% | −20.99% | 0.30 | 1.25 | 143 |
| | full 2020-26 | 26.65% | −23.57% | 1.13 | 1.76 | 377 |

Reading:
- It beat Turtle RS in the tune window and **lost money on the held-out window**. The default stays the tune winner:
  choosing the third config because it held up on 2024-26 would be selecting on the held-out data.
- Narrow sell buffers (sell below N) churn: about 1,000 trades and a 14-day median hold, the worst configs.
- The regime filter matters more here than for Turtle RS: without it the drawdown reaches −40%.

Why it is weaker than Turtle RS:
- The score saturates. On 2026-11-20, 82 of 499 stocks scored 14-15, so the top 15 is decided by the RS percentile
  and a one-day volume ratio, which reshuffles daily. It trades about three times as often.
- A full score needs only a rising 20-day RS line. The top 15 that day included 1-year laggards (RS ratio as low as
  −0.10).
- With the sector cap, a clustered top 15 leaves slots empty. A dry run on 2026-11-20 filled 8 of 15 and held 47% in
  cash, because 5 of the top 15 were healthcare.

### Variant: score + positive RS (`scanner_rs`, research only)
Same engine and the same 32-config split-sample sweep (`SCANNER_STRATEGY=scanner_rs
scripts/analysis/optimise_scanner_top.py`, results in `debug/scanner_rs_sweep/`). The ranking keeps only names with
a 252-day RS ratio > 0 and orders them by score, then RS ratio, with no one-day volume tie-break. It is not exposed in
the dashboard or the live bot.

| Config | Window | CAGR | Max DD | Calmar | PF | Trades |
|---|---|---|---|---|---|---|
| **N10, sell >30, stop 20, cap off (tune winner)** | tune 2020-23 | 50.02% | −17.75% | 2.82 | 1.95 | 463 |
| | **held-out 2024-26** | **3.42%** | **−24.43%** | 0.14 | 1.09 | 290 |
| | full 2020-26 | 27.50% | −26.59% | 1.03 | 1.44 | 761 |
| N15, sell >30, stop 20, cap 2 (2nd) | held-out 2024-26 | −5.35% | −32.41% | −0.17 | 0.87 | 434 |
| N15, sell >45, stop 20, cap off (3rd) | held-out 2024-26 | 5.14% | −23.88% | 0.22 | 1.13 | 387 |
| tune winner, no regime filter | full 2020-26 | 20.24% | −38.27% | 0.53 | 1.22 | 942 |
| turtle_rs (live default) | held-out 2024-26 | 6.27% | −20.99% | 0.30 | 1.25 | 143 |
| | full 2020-26 | 26.65% | −23.57% | 1.13 | 1.76 | 377 |

Reading:
- The RS gate fixes part of the problem. Against the exact scanner order, the tune winner's held-out result goes
  from −4.0% to +3.4% CAGR, and the tune Calmar rises from 2.29 to 2.82.
- It **still trails Turtle RS out of sample** (Calmar 0.14 vs 0.30, deeper drawdown). Over the full period it has a
  slightly higher CAGR but a 3-point deeper drawdown and a lower Calmar.
- One of the three top picks lost money on 2024-26, so the result is not stable across nearby settings.
- Verdict: no scanner-ranked variant has beaten the live Turtle RS model out of sample. Keep Turtle RS as the live
  model.
