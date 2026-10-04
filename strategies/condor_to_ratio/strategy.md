# Nifty Iron Condor to Ratio Spread Strategy

`strategies/condor_to_ratio/nifty_condor_ratio.py`

> **UNVALIDATED — dry-run default.** Sourced from YouTube video:
> [What If the Iron Condor Starts Trending? | Ratio Spread Strategy](https://www.youtube.com/watch?v=T4gvTshMEyA&t=1609s).
> In the source, the strategy is demonstrated on selected high-volatility months (March 2026, April 2026, November 2024) in AlgoTest.
> While the structural theory and transition rules are mathematically defined, this repo ships v1 without an automated multi-year backtest.
> `--live` requires `--i-understand-this-is-unvalidated`. Run in dry-run mode first.

---

## 1. Why / Edge Hypothesis

Standard Iron Condors are non-directional strategies designed for range-bound markets that profit from Theta decay. However, when the underlying market experiences a strong directional trend, defending an Iron Condor becomes challenging:
- Rolling the untested side collects diminishing credit while increasing directional risk.
- Repeated adjustments widen or invert the loss zone.
- Continuous defense often leads to compounding losses when the trend persists.

### Core Solution: Structural Regime Switch
Rather than fighting the trend by continuously adjusting a failing Iron Condor, this strategy changes its structural shape entirely:
1. **Neutral Phase (Iron Condor)**: Enter a neutral monthly Iron Condor (Sell 0.30 Delta CE & PE, Buy 0.10 Delta CE & PE hedges). If the market stays range-bound, theta decay produces steady profit.
2. **Directional Transition (Ratio Spread)**: When a short leg decays to **0.10 Delta** (indicating a significant directional expansion away from that strike), exit the Iron Condor immediately and deploy a **Directional Ratio Spread** aligned with the market trend:
   - **Market Downward Move** (Call decayed to 0.10 Delta): Deploy **Call Ratio Spread** (Bearish: Buy 0.50 Delta Call, Sell 2× 0.40 Delta Calls, Buy 0.10 Delta Call hedge).
   - **Market Upward Move** (Put decayed to 0.10 Delta): Deploy **Put Ratio Spread** (Bullish: Buy 0.50 Delta Put, Sell 2× 0.40 Delta Puts, Buy 0.10 Delta Put hedge).
3. **Trending Continuation Shift**: If the market continues strongly in our direction, the sold legs decay. When the combined delta of the short legs drops from ~0.80 to **<= 0.20** (or <= 0.10 single leg), close the Ratio Spread and re-deploy a shifted Ratio Spread with less aggressive strikes (Buy 0.40 Delta, Sell 2× 0.30 Delta, Buy 0.08 Delta hedge) to lock gains and widen the safety buffer.
4. **Reversal Reset**: If the market reverses aggressively, the sold legs' delta expands from ~0.80 to **>= 1.20** (or >= 0.60 single leg). The strategy closes the Ratio Spread and flips direction to the opposite side (Buy 0.50 Delta, Sell 2× 0.40 Delta, Buy 0.10 Delta hedge).

---

## 2. Instruments & Product

- **Underlying**: `NIFTY` index options.
- **Expiry Selection**: Monthly expiry (last expiry of the calendar month), targeting contracts with DTE inside `[--min-dte, --max-dte]` (default 15–45 days). Configurable `--expiry-type {monthly,nearest}`.
- **Product Type**: `MARGIN` (carry-forward positional hold across trading sessions). Also supports `INTRADAY` if restricted to single-day testing.
- **Lot Sizing**: Dynamic lot size fetched via `helper.get_lot_size("NIFTY")`. Base quantity is `--lots * lot_size`.
  - In Iron Condor: 1× lots for each of the 4 legs.
  - In Ratio Spread: 1× lots for long leg, 2× lots for short leg, 1× lots for hedge leg.

---

## 3. Entry Rules (Phase 1: Iron Condor)

- **Entry Timing**: Eligible trading days between `--entry-time` (default `09:20`) and `--entry-end` (default `15:00`).
- **Strike Selection**:
  - `ce_short_strike`: Strike closest to `--condor-short-delta` (default `0.30`).
  - `pe_short_strike`: Strike closest to `--condor-short-delta` (default `0.30`, i.e. `-0.30` put delta).
  - `ce_hedge_strike`: Strike closest to `--condor-hedge-delta` (default `0.10`).
  - `pe_hedge_strike`: Strike closest to `--condor-hedge-delta` (default `0.10`, i.e. `-0.10` put delta).
- **Execution Order (Hedges First)**:
  1. Buy `ce_hedge` (1× lots)
  2. Buy `pe_hedge` (1× lots)
  3. Sell `ce_short` (1× lots)
  4. Sell `pe_short` (1× lots)
  *Hedges are placed before shorts to prevent unhedged margin spikes or naked short execution.*

---

## 4. Transition & Adjustment Rules

### Phase 2: Iron Condor → Ratio Spread Transition
The strategy monitors the delta of both short legs (`ce_short`, `pe_short`) every poll interval:
- **Bearish Trigger**: `abs(ce_short_delta) <= --condor-exit-delta` (default `0.10`).
  - Signifies market has dropped sharply; put side is challenged while call side decayed to 0.10.
  - Action: Close all 4 Iron Condor legs (`exit_all()`). Book realized P&L.
  - Deploy **Call Ratio Spread**:
    1. Buy 1× Call at `--ratio-long-delta` (default `0.50` ATM).
    2. Buy 1× Call at `--ratio-hedge-delta` (default `0.10` Far OTM hedge).
    3. Sell 2× Calls at `--ratio-short-delta` (default `0.40` OTM).
- **Bullish Trigger**: `abs(pe_short_delta) <= --condor-exit-delta` (default `0.10`).
  - Signifies market has rallied sharply; call side is challenged while put side decayed to 0.10.
  - Action: Close all 4 Iron Condor legs (`exit_all()`). Book realized P&L.
  - Deploy **Put Ratio Spread**:
    1. Buy 1× Put at `--ratio-long-delta` (default `0.50` ATM).
    2. Buy 1× Put at `--ratio-hedge-delta` (default `0.10` Far OTM hedge).
    3. Sell 2× Puts at `--ratio-short-delta` (default `0.40` OTM).

### Phase 3: Ratio Spread Continuation Shift (Trending Rule)
When holding a Ratio Spread in direction $D$:
- Initial combined delta of the 2 sold legs is $\approx 0.80$ ($2 \times 0.40$).
- If the trend continues, the sold strike delta drops.
- **Shift Trigger**: Combined short delta drops to `<= --ratio-shift-delta` (default `0.20`, or `<= 0.10` per contract).
- **Action**:
  1. Close the current Ratio Spread (`exit_all()`).
  2. Re-enter a shifted Ratio Spread in the **same direction** with wider, less aggressive strikes:
     - Buy 1× at `--shift-long-delta` (default `0.40`).
     - Buy 1× hedge at `--shift-hedge-delta` (default `0.08`).
     - Sell 2× at `--shift-short-delta` (default `0.30`).
  3. Increment shift count (`shifts_count <= --max-shifts`, default 5).

### Phase 4: Ratio Spread Reversal Rule (Market Turnaround)
If the market sharply reverses against the active Ratio Spread:
- The delta of the sold legs expands toward the money.
- **Reversal Trigger**: Combined short delta rises to `>= --ratio-reversal-delta` (default `1.20`, or `>= 0.60` per contract).
- **Action**:
  1. Close the current Ratio Spread (`exit_all()`).
  2. Flip direction ($D_{\text{new}} = \text{BULLISH}$ if $D_{\text{old}} == \text{BEARISH}$ and vice-versa).
  3. Deploy fresh initial Ratio Spread in the new direction ($0.50$ Long, $2\times 0.40$ Short, $0.10$ Hedge).
  4. Increment reversal count (`reversals_count <= --max-reversals`, default 3).

---

## 5. Exits & Risk Controls

1. **Cycle Target Profit (`--target-profit`)**: Hard exit when cumulative cycle P&L (realized + unrealized) hits target (default `15%` or ₹15,000 per lot).
2. **Cycle Stop Loss (`--stop-loss`)**: Hard exit when cumulative cycle P&L drops below stop (default `-15%` or -₹15,000 per lot).
3. **Trailing Stop Loss**: Rupee-MTM trailing stop active once total P&L reaches `--trail-start-rs` (default ₹5,000), triggering exit on a `--trail-gap-rs` (default ₹2,500) giveback from peak P&L.
4. **Expiry Day Square-Off (`--eod-exit-time`)**: On the expiry date of the active contract, all legs are squared off at `15:15` IST to prevent physical delivery or settlement risk.
5. **Consecutive Stop Guard (`--max-consecutive-stops`)**: If consecutive cycles hit stop loss without profit, pauses trading until operator review.

---

## 6. Failure Modes Table

| Failure Scenario | Detection | Immediate Action | Tracked State |
|---|---|---|---|
| Hedge leg buy fails on entry | Broker returns None or order unconfirmed | Abort entry. Do NOT place shorts. Stay flat. | `status="WAITING"`, `position_open=False` |
| Short leg sell fails on entry | Broker returns None after hedge bought | Immediately buy-to-close the filled hedge legs. | `status="UNWINDING"` until confirmed flat |
| Process killed mid-position | Startup scans `debug/<key>_position.json` | Reloads all legs, resubscribes WebSocket feeds, reconciles quantities with broker. | Restores `status="RUNNING"`, resumes lifecycle |
| Quote is 0 or missing | Quote validation returns `<= 0` | Skips tick, logs warning, never acts on stale 0 quote. | No state change, wait for next tick |
| Option Greeks missing from chain | `ce_delta` or `pe_delta` is 0 or NaN | Falls back seamlessly to internal Black-Scholes delta engine (`math.erf`). | Normal operation uninterrupted |
| Broker rejects close order | `_buy_to_close` returns `closed=False` | Keeps leg in tracked position, switches status to `FLATTENING`, retries every loop. | `status="FLATTENING"`, operator alert via Telegram |

---

## 7. Restart Behaviour

- State and positions are persisted atomically to `debug/<state_key>_position.json`.
- On startup, the strategy verifies:
  - If a position file exists with `position_open=True`, it loads all legs (`CE`/`PE` or `Ratio` legs), their entry prices, quantities, and realized P&L.
  - Re-subscribes WebSocket instruments for all active legs.
  - Checks live broker positions via `ExecutionBroker.get_owned_net_qty()`. If there is any discrepancy between persisted state and broker net quantity, it halts with `[FATAL]` and refuses to trade blind.
  - Dashboard bridge file `debug/<state_key>_state.json` is updated every tick.

---

## 8. Deliberately Not Done in v1

- Intra-day scalping adjustments: This is designed as a positional monthly hold strategy.
- Naked ratio expansions: All ratio spreads strictly maintain the far OTM hedge leg (1x Long + 1x Hedge vs 2x Short) so tail risk is boxed.
- Unlimited re-entries into losing reversals: Reversals are capped at `--max-reversals` (default 3) to prevent whipsaw traps during tight range churn.

---

## 9. CLI Reference

```powershell
# Dry run default (safe, simulated fills, checks quotes & delta rules)
python strategies/condor_to_ratio/nifty_condor_ratio.py

# Dry run with custom target/stop
python strategies/condor_to_ratio/nifty_condor_ratio.py --lots 2 --target-profit 25000 --stop-loss 20000

# Live execution (requires --i-understand-this-is-unvalidated)
python strategies/condor_to_ratio/nifty_condor_ratio.py --live --i-understand-this-is-unvalidated --lots 1 --broker dhan
```
