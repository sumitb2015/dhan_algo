# Nifty Overnight Fly

`strategies/overnight_fly/nifty_overnight_fly.py`

A hedged short-straddle strategy that holds its position **overnight** — the only options strategy in this repo that does not flatten at the 15:17 intraday cutoff. Sourced from Nilesh Kadam's "overnight Iron Fly" (Trading with Groww, 2026-08-29); see the strategy-framework report's "Hedged Overnight Fly" proposal for the full comparison against the rest of the catalog.

---

## 1. Why this strategy is different from every other one in the repo

- **Product type is `MARGIN` (carry-forward), never `INTRADAY`.** An MIS/INTRADAY order gets force-squared by the broker's own RMS near the close regardless of what the script's loop does. Using the wrong product type would silently defeat the entire point of the strategy.
- **Position state survives a process restart.** `debug/nifty_overnight_fly_position.json` (atomic write, same pattern as `nifty500_momentum.py`'s portfolio file) is the source of truth for what's actually open. A restart mid-hold reloads it and resubscribes to every live leg instead of re-entering blind or losing track of the hedge.
- **Stop DOES flatten it**, unlike `nifty500_momentum` (which leaves holdings in place on stop). There's no supervising process managing rolls/SL on a naked-if-unwatched short straddle, so a manual Stop always closes everything.

## 2. Entry

- Runs only on the trading day **immediately before expiry** (`--entry-dte`, default 1 — i.e. `helper.days_to_expiry("NIFTY") == 1`). Around a holiday that shifts the calendar gap between the trading day before expiry and expiry itself to more than 1 day, raise `--entry-dte` accordingly — v1 does not detect this automatically.
- Entry window: `--entry-time` (default `09:15`) through `--entry-time + --entry-window-min` (default 15 minutes).
- Sells one ATM call + one ATM put (`--lots`, default 1).
- **Hedge**: buys one call and one put further OTM, at a distance derived from what the straddle actually collected — `hedge_points = round(hedge_multiplier * (ce_entry + pe_entry) / 50) * 50` (`--hedge-multiplier`, default 2.0, i.e. roughly twice the straddle's own premium out).
- If either hedge leg's quote or order fails, the strategy treats "never run unhedged" as an invariant: it immediately unwinds everything placed so far (`exit_all_positions`) rather than leaving a naked short straddle live.

## 3. Adjustment: roll on stop-loss

Each short leg carries its own stop-loss, `--leg-sl-pct` (default 40% above entry premium). On a hit:

1. Buy back the stopped short leg, booking its realized P&L.
2. **Drag the hedge** on that side one strike closer to the new ATM (close the old hedge leg, buy a new one) — unless doing so would invert past the new short strike, in which case the hedge is left where it is.
3. Sell a fresh short leg at the new ATM strike, with a fresh SL.

This is capped at `--max-rolls-per-leg` (default 2) rolls per side per cycle. Past the cap, that side is left flat for the rest of the cycle rather than rolling indefinitely into a trend — its hedge stays on, still bounding risk on that side.

If a hedge drag's buy-back or re-buy fails partway, the strategy logs `CRITICAL` and marks that side's hedge as `None` (unhedged) rather than guessing a price — this needs manual operator attention; it does not auto-retry.

## 4. Trailing stop

A rupee-MTM trailing stop across the *whole* position (all four legs), reusing the same `trail_start_rs`/`trail_gap_rs` idea as `nifty_advanced_imbalance.py`'s `reentry_straddle` mode: once total P&L reaches `--trail-start-rs` (default 3000), the stop arms and trails `--trail-gap-rs` (default 1500) below the best P&L seen. A breach closes everything early.

## 5. Exit

- **Expiry day only** (`days_to_expiry() == 0`): square off everything at `--eod-exit-time` (default `15:17`), same convention as every other strategy's intraday cutoff, but only fires on this one day of the cycle.
- Any other day, the position holds through the close untouched (no 15:17 exit).
- Trailing stop or a shutdown request (dashboard Stop button) can close it early on any day.

## 6. What v1 deliberately does not do

Per the strategy-framework report, this is the "highest-value gap fill" proposal — implemented to the point of being safely runnable, not to replicate every nuance in the source video:

- No re-entry after a roll's SL is hit and price returns to the rolled strike (Recovery/Rotation-style re-entry) — a rolled-off leg simply stays flat for the rest of the cycle.
- No richer "keep the winning side running, ladder profits on the losing side" trend-capture mechanic.
- `--entry-dte` is a fixed day-count, not calendar-holiday-aware.

## CLI Reference

```
python strategies/overnight_fly/nifty_overnight_fly.py [--live]
    [--lots N] [--hedge-multiplier X] [--leg-sl-pct PCT] [--max-rolls-per-leg N]
    [--trail-start-rs INR] [--trail-gap-rs INR]
    [--entry-time HH:MM] [--entry-window-min MIN] [--entry-dte N] [--eod-exit-time HH:MM]
    [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

Dry run by default. See `--help` for full flag documentation and defaults.
