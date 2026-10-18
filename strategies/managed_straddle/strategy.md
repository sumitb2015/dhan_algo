# Nifty Managed Straddle Strategy

Intraday Nifty short ATM straddle that waits for ATM CE and PE premiums to balance before entering, then enforces a 20% combined premium stop-loss, 20% leg-level stop-loss, and 30% leg-level profit target with dynamic premium-matching rolls.

---

## 1. Edge & Core Hypothesis

The intraday ATM short straddle is a premier theta-harvesting structure that benefits from the rapid intraday time-decay of near-the-money options. However, unhedged straddles suffer severe asymmetric tail risk when a sharp trending impulse expands the losing leg faster than the winning leg decays.

This strategy introduces a dual-layer risk control and premium-matching mechanism:
1. **Balanced ATM Entry Filter (< 10% Imbalance)**: Rather than entering blindly at market open, the strategy observes the ATM strike on a 1-minute chart cadence at or after 09:20 IST. It enters only when `abs(CE - PE) / max(CE, PE) < 10%`, ensuring Delta-neutrality at initiation.
2. **20% Combined Premium Stop Loss**: Protects against high-volatility regime shifts or gamma squeezes where both legs expand (or the net straddle premium expands by 20% above entry baseline).
3. **20% Leg Stop-Loss with Premium Matching**: When an individual leg expands by 20% from its entry price:
   - The losing leg is immediately bought back to cap further adverse movement.
   - The strategy inspects the surviving opposite leg's live LTP.
   - It rolls the closed side to a new replacement strike whose market premium matches the opposite leg, re-centering the position's Delta and restoring equal theta decay.
4. **30% Leg Profit Target with Premium Matching**: When an individual leg decays by 30%:
   - The winning leg is bought back to lock in accrued decay.
   - It is rolled to a strike that matches the surviving leg's current premium, resetting the decay baseline and preventing the winning leg from becoming an insignificant sliver of premium.
5. **Global EOD Exit at 15:15 IST**: Guarantees zero overnight gap risk.

---

## 2. Instruments & Product

- **Underlying**: `NIFTY 50` Index.
- **Product Type**: `INTRADAY` (MIS). All open positions are squared off by 15:15 IST.
- **Expiry**: Nearest weekly F&O contract (`helper.get_nearest_expiry("NIFTY")`).
- **Strike Step**: 50 points.
- **Lot Sizing**: Dynamic lot size fetched via `helper.get_lot_size("NIFTY")`.

---

## 3. Entry Rules

| Parameter | Value | Description |
|---|---|---|
| **Entry Window Start** | `09:20 IST` | Allows opening 5-minute volatility settling |
| **Cadence** | 1-minute | Evaluates on 1-minute closed bars / 1-second ticks |
| **ATM Strike Selection** | `round(Spot / 50) * 50` | Closest ATM strike |
| **Premium Balance Filter** | `< 10.0%` | `abs(CE - PE) / max(CE, PE) < 0.10` |
| **Action** | Sell 1 lot ATM CE + Sell 1 lot ATM PE | Multi-leg entry with rollback |

If the ATM premiums differ by 10% or more, the strategy logs the imbalance and continues monitoring every minute without taking a position.

---

## 4. Risk Management & Adjustments

### A. Global Combined Premium Stop-Loss (20%)
- **Baseline**: `combined_p0 = ce_fill_price + pe_fill_price`
- **Trigger**: `(ce_ltp + pe_ltp) >= combined_p0 * 1.20`
- **Action**: Immediate emergency square-off of both legs. The strategy halts for the remainder of the session to prevent repeated chop losses.

### B. Leg Stop-Loss (20%) + Premium-Matching Roll
- **Trigger**: An active short leg's LTP reaches `>= entry_price * 1.20`.
- **Execution**:
  1. Buy-to-close the losing leg using `resolve_exit_qty_broker()`.
  2. Read the surviving opposite leg's current LTP (`surviving_ltp`).
  3. Scan the live option chain for a replacement strike on the same side whose LTP is closest to `surviving_ltp`.
  4. Enforce strike non-inversion (`CE strike > PE strike`).
  5. Sell the replacement strike and subscribe its WebSocket feed.
  6. Set new leg's SL at `+20%` and Target at `-30%`.
  7. Update baseline `combined_p0 = new_fill + surviving_ltp`.

### C. Leg Profit Target (30%) + Premium-Matching Roll
- **Trigger**: An active short leg's LTP decays to `<= entry_price * 0.70` (30% decay).
- **Execution**:
  1. Buy-to-close the winning leg, locking in realized theta.
  2. Scan option chain for a replacement strike whose LTP matches the surviving leg's LTP.
  3. Sell the replacement strike and reset its individual 20% SL and 30% target.
  4. Update baseline `combined_p0 = new_fill + surviving_ltp`.

### D. Hard EOD Cutoff
- At `15:15 IST`, all open legs are squared off at market price regardless of current P&L.

---

## 5. Modular Architecture

The strategy is built on decoupled, unit-tested primitives:
- `lib/managed_straddle_rules.py`: Pure math functions (`atm_strike`, `atm_imbalance_pct`, `is_atm_balanced`, `combined_sl_hit`, `leg_sl_hit`, `leg_target_hit`, `find_match_strike`).
- `lib/straddle_manager.py`: Data structures (`StraddleLeg`, `StraddlePosition`, `StraddleRiskConfig`, `StraddleSignal`) and operator `StraddleExecutor`.
- `strategies/managed_straddle/nifty_managed_straddle.py`: Strategy orchestrator and CLI entry point.

---

## 6. CLI Reference

```powershell
# Dry run with default 20% combined SL, 20% leg SL, 30% leg target, 10% entry balance
venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py

# Live execution with 2 lots on Dhan
venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py --live --lots 2

# Live execution on Kotak Neo broker
venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py --live --broker kotak --lots 1
```

