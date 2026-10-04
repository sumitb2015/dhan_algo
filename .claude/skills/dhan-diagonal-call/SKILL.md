---
name: dhan-diagonal-call
description: Use when touching the Delta-Controlled Low-Gamma Diagonal Covered Call — strategies/diagonal_call/nifty_diagonal_call.py (+ strategy.md, readmes/), rs_dashboard/lib/diagonalStrikeAdvisor.ts and components/basket/DiagonalStrikeAdvisorCard.tsx, the `low-gamma-diagonal-call` Baskets template/preset, scripts/analysis/backtest_diagonal_call.py, or tests/test_diagonal_call.py. Covers the Python/TypeScript sizing parity, the long-first entry / short-first exit order, the LCR "Free Long Call" regime, gamma/drawdown limits, the phantom-leg exit-side rule, and what the 2026 backtest does and does not prove. Not for the generic strategy kit (dhan-new-strategy) or payoff math (dhan-payoff-diagrams).
---

# Diagonal Covered Call (long 60-120 DTE call, short 25-45 DTE calls)

One idea, **three implementations that must agree**: the live strategy (Python), the dashboard advisor and
Baskets template (TypeScript), and the backtest. Spec lives in `strategies/diagonal_call/strategy.md`; the
Strategies+ modal shows the short `readmes/nifty_diagonal_call.md`. **Status: UNVALIDATED live** — dry-run
default, never forward-tested (see the backtest caveat below). Positional (`MARGIN`), multi-broker via
`ExecutionBroker`; market data always from `DhanHelper`.

## The rules in one screen
- Long: buy CE, 60-120 DTE, delta 0.55-0.65 (prefer 0.60), `--long-lots` default 3. **Entered first.**
- Short: sell CE, monthly expiry only (`is_monthly_expiry`), 25-45 DTE (+14d if no monthly fits), expiring before the long, delta 0.15-0.22.
  Strike = closest to target delta; `Theta/|Gamma|` is only a tie-break (it is ~0.5*sigma^2*S^2 for every strike, so as primary key it picked the
  0.22 edge). Nothing sold out of band. IV floor `--min-iv`. New shorts are trimmed to 75% of the gamma floor.
- Sizing: `short_lots = round((long_delta - target_net_delta) / (short_delta * lot_size))`, then clamped by
  **both** `--max-short-ratio` (1.25 x long delta) **and** `--max-short-lots` (default 6, hard margin ceiling,
  added in `7fb4a8d` after sizing alone could ask for more lots than margin allowed).
- Roll the short on: DTE <= 14, short delta > 0.35, portfolio delta < -40, gamma < -0.20, or 65% decay.
  Roll the long at DTE < 35. **Exit order: shorts first, then longs** (a naked short is the only bad state).
- Risk: daily loss 1.5% halts adjustments; 5% drawdown halves shorts; 8% closes everything. Gamma floor
  -0.15 target / -0.20 emergency.
- LCR = cumulative net short premium / initial long debit. At >= 100% ("Free Long Call") the short delta band
  drops to 0.08-0.15 and the ratio cap to 0.60x so the funded long can ride a rally.
- Holds overnight (no 15:17 auto-square-off — an exception to the repo-wide rule; do not "fix" it).

## Parity: change one, change all
| Concern | Python | TypeScript |
|---|---|---|
| lots sizing + caps | `calculate_required_short_lots` | `calculateRequiredShortLots` in `diagonalStrikeAdvisor.ts` (same `maxShortRatio=1.25`, `maxShortLots=6`) |
| portfolio Greeks / gamma zones | `calculate_portfolio_greeks` | `calculatePortfolioGreeks` (zones at -0.10/-0.15/-0.20) |
| Baskets template | — | `basketStrategies.ts` `low-gamma-diagonal-call` (front 25-45 / far 60-120 DTE), `strategyPresets.ts`, `optionsStrategy.ts` |
Both sides use their own Black-Scholes Greeks (the TS side defaults IV 0.15 when a leg has none) — they are an
*advisor*, not the broker's chain Greeks, so they will not match `dhan-position-greeks` output. `tests/test_diagonal_call.py`
and `lib/diagonalStrikeAdvisor.test.ts` pin the sizing; extend both when a constant changes.

## Bugs already paid for
- **Unsafe unwind / retry paths (review of `f54b31c`).** `exit_all` must never sell the long while a short is open
  (it retries via `pending_exit_reason`, also after restart); long roll buys the new long *before* selling the old;
  a timed-out order is cancelled and the broker position re-read (`_confirm_fill_or_cancel`) before any retry;
  entry has backoff/halt; there are no synthetic prices; the daily loss limit latches. `tests/test_diagonal_call.py`
  (`TestDiagonalFailurePaths`, `TestDiagonalSelectionAndAdjustments`) pins each — keep them green.
- **TS advisor mirrors the live selection** (`recommendDiagonalStrikes`): closest-to-0.18Δ ranking with Theta/|Gamma| as a
  0.02Δ tie-break, gamma-budget lot trim (75% of the floor), and `summary.warnings` for a weekly front expiry or a short that
  would outlive the long (shown in `DiagonalStrikeAdvisorCard`). It cannot filter expiries itself — the caller picks the
  expiry — so it warns instead. Change the Python selector and this together.
- **Phantom-leg exit side (`43cded8`).** `detect_phantom_leg_broker(..., side=)` takes the **closing** side of
  the leg being checked: long leg -> `"SELL"`, short leg -> `"BUY"`. It was passing `"BUY"` for the long leg, so
  a missing long call was never detected. A vanished **long** with a live short = naked risk -> `exit_all`; a
  vanished **short** just means it was closed elsewhere -> mark it flat, recompute LCR, save position. Keep the
  asymmetry; the test `test_phantom_leg_detection_sides` covers both directions.
- **Margin cap (`7fb4a8d`).** Never size shorts from delta alone; the lots ceiling is a margin guard.
- Short-entry failure after the long filled -> `UNWINDING` (close the long, return to `FLAT`); long-entry failure
  -> abort without selling. A short roll close must be *confirmed* before a new short is sold.

## What the backtest does and does not say
`scripts/analysis/backtest_diagonal_call.py` replays 2026-01-01..09-30 from `Options Data/nifty_options.db`
(39 expiries, Dhan friction model). Output in `debug/backtests/options/diagonal_call_2026/` (`summary.json`,
`trades.csv`, `equity_curve.csv`): 290 short cycles, 71.7% win rate, net short premium ~Rs 4.10L vs an initial
long debit ~Rs 1.93L, LCR 212%, max drawdown 3.74%, "zero-recovery ROI" 43%. Treat it as **a premium-harvest
accounting model, not a validated edge**: it is one 9-month window in a single trending-up/flat regime, the
"zero-recovery" line assumes the long loses its whole cost but not that shorts are stopped out at a loss in a
sharp rally, and it has no live fills. Do not quote these numbers as expected returns; the forward test is the gate.

## Before shipping a change
1. `venv/bin/python -m pytest tests/test_diagonal_call.py` (or run the file) and `node --test lib/diagonalStrikeAdvisor.test.ts` (from `rs_dashboard/`; `npm test` runs `node --test lib/*.test.ts`).
2. Run dry-run once and confirm the state file renders on Strategies+ (params shown in both `StrategyCard` and
   `StrategyRowWide`; readme via `dhan-new-strategy` -> dashboard-wiring §6).
3. Any new flag: add to the readme's Exit/Stop sections and the CLI block in `strategy.md`.
