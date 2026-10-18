# VWAP Momentum Buyer (Algo Lab) — UNVALIDATED

Code: `rs_dashboard/lib/algoLab/strategies/vwapMomentumBuyer.ts` · Page: `/algo-lab?strategy=vwap_momentum_buyer`

Built as the Algo Lab's first strategy, to exercise the framework's BUY path end to end. It is **not** a validated
edge: its first backtest lost money (below). Keep it in SIM.

## Rules

- **Gate (NIFTY)**, on today's closed index candles of the timeframe: BULLISH = spot > session mean of 1-minute closes
  (the index VWAP stand-in) and EMA9 > EMA20 → calls only; BEARISH = the mirror → puts only; otherwise no entries.
  `trendMode = BYPASS` allows both sides.
- **Signal (each option, ATM ± strike window)**: the last closed candle closes above both its session VWAP and its
  EMA (`emaPeriod`), counted as consecutive bars above (`age`). Eligible when 1 ≤ age ≤ `maxSignalAge` and the premium
  is within `minPremium`..`maxPremium`.
- **Rank**: freshness (50) + ATM proximity (30, −6 per strike) + strength (20, average % above VWAP and EMA × 4).
- **Entry**: BUY 1 position per pick (framework caps apply).
- **Exits**: initial stop `slPct` % below entry; lock to cost at `trailStartPct` % gain, then +`trailByPts` per
  `trailStepPts` of further gain; target `targetPct` % (0 = off); "momentum lost" when the premium trades below its
  EMA (`recoveryExit`), checked on every price, like every stop.

Defaults: 5m, ATM ± 4, EMA 20, age ≤ 2, ₹20-₹300, stop 20 %, target 40 %, lock at 15 %, trail 2 per 5 pts.

## First backtest (2026-10-18, defaults, 2026-09-15 → 2026-10-13, 20 sessions)

350 trades, 10 % win rate, net −₹11,609 after ₹22,312 costs (gross +₹10,703), max drawdown −₹26,597, profit factor
0.82. Exits: momentum-lost 302, trailing stop 24, target 17, stop 5, EOD 2. The audit passed all 9 checks.

Reading: the momentum-lost exit fires on the first intrabar dip below the EMA, so most trades are cut within minutes
and costs (~₹64 per round trip) exceed the gross. Ideas not yet tried: evaluate momentum-lost on closed candles only, a
minimum hold, fewer re-entries. Each needs a re-run and the cold-entry share checked.
