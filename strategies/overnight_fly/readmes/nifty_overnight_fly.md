## Summary

Hedged short-straddle Nifty options strategy — the only one in the repo that holds
**overnight**, not flattened at the usual 15:17 intraday cutoff. Sells an ATM straddle hedged
by further-OTM long call/put, entered only on the trading day immediately before expiry and
carried through to expiry day. Product type is `MARGIN` throughout, never `INTRADAY`, so it
survives the broker's own RMS square-off.

## Entry

- Runs only on the day immediately before expiry (`--entry-dte`, default **1**), within a window of `--entry-time` (default **09:15**) + `--entry-window-min` (default **15** minutes).
- Sells one ATM call + one ATM put (`--lots`, default **1**).
- Buys a hedge call and put further OTM, at `hedge_points = round(--hedge-multiplier × (ce_entry + pe_entry) / 50) × 50` (`--hedge-multiplier`, default **2.0** — roughly twice the straddle's own premium out).
- If either hedge leg fails, the whole entry unwinds immediately — the strategy never runs an unhedged short straddle.

## Exit

- **Expiry day only**: square off everything at `--eod-exit-time`, default **15:17 IST**. Any other day in the cycle, the position holds through the close untouched.
- A dashboard Stop request always flattens everything on any day — no supervising process would otherwise manage a naked-if-unwatched straddle overnight.

## Target

- No fixed rupee profit target — profit comes from theta decay on the short legs, protected by the trailing stop below.

## Stop Loss

- Per-leg stop-loss: `--leg-sl-pct`, default **40%** above entry premium. On a hit, the stopped leg is bought back, its hedge is dragged one strike closer to the new ATM (unless that would invert past the new short strike), and a fresh short leg with a fresh SL is sold at the new ATM — capped at `--max-rolls-per-leg` (default **2**) rolls per side per cycle.
- Whole-position trailing stop: arms once total P&L reaches `--trail-start-rs` (default **₹3,000**), then trails `--trail-gap-rs` (default **₹1,500**) below the best P&L seen — a breach closes everything early.
