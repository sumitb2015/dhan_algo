## Summary

Positional, multi-day, CNC-delivery equity portfolio — the only strategy of this kind in the
repo. Ranks the Nifty 500 by composite relative strength versus the Nifty 50, holds up to 10
names, and rotates via a trailing stop ladder or a weekly rank review. Regime-gated by default
(only buys while the Nifty 50 is above its weekly 200 SMA). Backtested 2019–2026: CAGR 13.63%,
max drawdown −13.07%, Sharpe 1.16. **Stopping this strategy does NOT flatten the book** — it
exits cleanly and leaves holdings in place for the next start to reload.

## Entry

All must hold at the weekly review:
1. Regime ON (previous week's Nifty 50 close above its 200 SMA — disable with `--no-regime`).
2. Composite RS rank ≤ 20 (weighted blend of 10/21/63/126-day relative strength vs Nifty 50; the 63-day term dominates).
3. `Close > EMA20 > EMA50 > EMA200`.
4. Close above the 55-day closing high, confirmed by two consecutive closes.
5. Volume above its 20-day average (skipped gracefully if volume data is unavailable).
6. Passes eligibility (≥250 bars history, price ≥ ₹50, 20-day avg traded value ≥ ₹5cr), within the 2-per-sector cap, not in a 10-day post-stop cooldown, and a slot is free (10 slots total).

## Exit

Checked **daily**, not only at reviews — cumulative floors, all apply, stop takes the max:
- Entry: stop at **−12%**.
- Peak ≥ +15%: stop = max(stop, entry) — risk removed.
- Peak ≥ +25%: stop = max(stop, peak × 0.75) — trailing.
- Close < stop: exit.
- At reviews only: sells if RS rank > 25 for **two consecutive** weekly reviews, subject to a 7-day minimum hold.
- Regime turning OFF liquidates the entire book by default (`--no-regime-exit` blocks new buys but holds through instead).

## Target

- **No fixed profit target by default** (`--target none`) — backtesting shows a target caps the right-tail momentum the strategy depends on (capping at +30% reduced CAGR to 9.00% vs 11.54% with none).

## Stop Loss

- Initial stop `--stop`, default **−12%** from entry.
- Trailing stop ratchets to breakeven at +15% peak, then to 75% of peak (`--trail-pct`) once peak reaches +25%.
