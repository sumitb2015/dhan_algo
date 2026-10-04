# Nifty Delta-Controlled, Low-Gamma Diagonal Covered Call Strategy

## 1. Why / Edge Hypothesis & Overview

Standard fixed-lot covered call or diagonal call strategies suffer from a severe **gamma deficit**:
when the underlying rallies, short call gamma expands rapidly, flipping the portfolio violently short (e.g. net delta dropping below -40) and inflicting sharp losses. When the underlying drops or consolidates, fixed-lot selling either leaves unhedged vega risk or collects insufficient theta.

### Core Principle
> **"Long-dated calls provide convexity + vega. Shorter/medium-dated calls provide theta. Delta determines the quantity. Gamma determines when we become defensive."**

Instead of hard-coding a static number of short lots (e.g. "always sell 5 lots"), this strategy sizes the short position dynamically from option delta, targets an initial net delta buffer of **+0.10 to +0.20 Nifty-lot equivalent** (+6.5 to +13 delta units per 65-unit lot), and selects short strikes by maximizing the **Theta / |Gamma|** efficiency ratio among 25–45 DTE options.

### The Economics: A Long-Call Financing Strategy
A fundamental insight of this strategy is that **the long calls do NOT have to recover to their initial entry price for the strategy to be profitable**:
- The long call is an **insurance, convexity, and margin-reduction asset**.
- The short calls are the **financing engine**.
- If Nifty remains below the long strike and the long call expires at ₹0, the strategy still breaks even or makes money if cumulative net short premium exceeds the initial long debit plus friction.

### Long Cost Recovery (LCR) Metric
The strategy tracks **Cumulative Net Short Premium** against the initial long debit:
$$\text{LCR} = \frac{\text{Cumulative Net Short Premium}}{\text{Initial Long Option Debit}} \times 100\%$$

| LCR Range | Stage / Meaning | Strategy Posture |
|---:|---|---|
| **0–25%** | Early Stage | Active financing; normal dynamic delta balancing. |
| **25–50%** | Good Progress | Capital recovery underway. |
| **50–75%** | Substantial Recovery | Cost basis reduced by more than half. |
| **75–100%** | Mostly Funded | Long option almost free. |
| **$\ge 100\%$** | **"FREE LONG CALL"** | **Long call completely funded by short premium.** |
| **$> 120\%$** | Profit Buffer | Permanent profit buffer created. |

### The "Free Long Call" Regime Shift
Once $\text{LCR} \ge 100\%$, the strategy achieves a "Free Long Call". At this juncture, the algo **does NOT continue selling aggressively**:
- **Defensive Gamma Posture**: Short candidate delta shifts from $0.15\text{--}0.22$ down to $0.08\text{--}0.15$ (far OTM).
- **Reduced Short Exposure**: The maximum short lots ratio is clamped down to $\le 0.60\times$ long delta (instead of $1.25\times$).
- **Upside Asymmetry**: This cuts negative gamma to near zero, protects accumulated profits from sharp rally spikes, and allows the fully-funded long call to participate uninhibited in large market moves.

### Validation Status
- **Empirical Greek Architecture**: Designed around Black-Scholes Greeks with live chain feeds, dynamic delta balancing, and strict negative gamma ceilings ($>-0.15$ target, $>-0.20$ hard emergency guard).
- **Default Mode**: `--live` disabled by default (safe dry-run paper trading). Live execution requires `--live`.

---

## 2. Instruments & Product

- **Underlying**: `NIFTY 50` (Spot index ID `13`, Master list `NIFTY`, Derivative Underlying ID `26000`).
- **Product Type**: `MARGIN` (Positional carry-forward; long calls held 60–120 days, short calls 25–45 days).
- **Lot Size**: Dynamically fetched via `helper.get_lot_size("NIFTY")` (currently 65 units).
- **Exchange**: `NSE` / `NSE_FNO`.
- **Supported Brokers**: Multi-broker execution via `ExecutionBroker` (`dhan`, `zerodha`, `kotak`).

---

## 3. Entry Rules & Strike Selection

### A. Long Leg (Convexity Engine)
- **Structure**: Buy ATM or slightly ITM Call (`CE`).
- **DTE**: **60–120 days** (quarterly or far monthly expiry).
- **Target Delta**: **0.55–0.65** (prefer ~0.60 delta).
- **Position Size**: **2–4 lots** (default: `--long-lots 3`).
- **Order Sequence**: Long leg is always entered **first** before any short leg is sold.

### B. Short Leg (Theta Engine)
- **Structure**: Sell OTM Calls (`CE`).
- **DTE**: **25–45 days** (medium-dated monthly/bi-weekly; **never** weekly options).
- **Target Delta**: **0.15–0.22** (prefer ~0.18–0.20 delta).
- **Selection Optimization Score**:
  $$\text{Score} = \frac{\text{Theta Decay per Day (₹)}}{|\text{Gamma}|}$$
  Among candidate strikes satisfying $0.15 \le \Delta \le 0.22$ and $25 \le \text{DTE} \le 45$, the strike with the highest Score is selected.
- **IV Filter**: Rejects strikes if IV is depressed below `--min-iv` (default: 10% / IV Rank > 30).

### C. Dynamic Position Sizing Formula
1. $\text{Long Delta} = \sum (\text{Long Quantity (shares)} \times \Delta_{\text{long}})$
2. $\text{Target Short Delta} = \text{Long Delta} - \text{Target Net Delta}$ (where Target Net Delta defaults to $+10$ to $+20$ delta units).
3. $\text{Required Short Lots} = \text{round}\left(\frac{\text{Target Short Delta}}{\Delta_{\text{short}} \times \text{lot\_size}}\right)$
4. **Max Exposure Guard**: Total Short Delta cannot exceed **1.25 × Total Long Delta**:
   $$\text{Short Lots} = \min\left(\text{Required Short Lots}, \left\lfloor\frac{1.25 \times \text{Long Delta}}{\Delta_{\text{short}} \times \text{lot\_size}}\right\rfloor\right)$$

---

## 4. Delta & Gamma Management (Zones & Adjustments)

### Delta Zones
| Zone | Net Delta (units) | Action |
|---|---|---|
| 🟢 **Normal Zone** | `0` to `+20` | **Hold**: Do nothing. Let theta work. |
| 🟡 **Slightly Bearish** | `-20` to `-40` | **Monitor**: Do not add short calls. Wait for next scheduled rebalance window. |
| 🔴 **Defensive** | `< -40` | **Mandatory defensive adjustment**: Reduce short-call delta by rolling higher (lower delta) or buying back lots. **Never add shorts when Delta < -40.** |
| 🟡 **Too Bullish** | `> +30` | **Increase short exposure**: Sell additional 0.15–0.20 delta calls only if gamma limit is acceptable, returning net delta to `+10` to `+20`. |

### Gamma Rules
| Portfolio Gamma | Rating | Strategy Action |
|---|---|---|
| `> -0.10` | **Excellent** | Optimal risk-return. |
| `-0.10` to `-0.15` | **Acceptable** | Normal operational range. |
| `-0.15` to `-0.20` | **Caution** | Monitor closely; restrict new short additions. |
| `< -0.20` | **Defensive Trigger** | Reduce short gamma: roll short calls to higher strike / further out or reduce lots. |

---

## 5. Roll & Profit-Taking Rules

### Short-Call Roll & Exit Triggers
Short calls are closed and rolled into a fresh 25–45 DTE call ($0.15 \le \Delta \le 0.22$) when **any** of the following occur:
1. **DTE Threshold**: $\text{DTE} \le 14$ days (prevents holding into high-gamma expiry weeks).
2. **Delta Expansion (Rally)**: Short call $\Delta > 0.35$ (or $\Delta > 0.50$ critical emergency).
3. **Portfolio Delta Threat**: Portfolio Net Delta $< -40$.
4. **Gamma Violation**: Portfolio Gamma $< -0.20$.
5. **Profit-Taking**: Captured **60–70% of premium** (default: 65% decay captured, i.e., current price $\le 35\%$ of entry price).

### Long-Call Roll Triggers
1. **DTE Threshold**: Long call $\text{DTE} < 35$ days (configurable 35–45 days).
2. **Action**: Sell current long call and buy a fresh 60–120 DTE call with $\Delta \approx 0.55\text{--}0.65$.

---

## 6. Risk Limits & Capital Preservation

- **Daily Loss Limit**: 1.0–1.5% of strategy capital (`--daily-loss-pct 1.5`, default ₹7,500 on ₹5L capital). Halts adjustments for the remainder of the session.
- **Drawdown Halving**: If portfolio drawdown reaches **5.0%** (`--drawdown-halve-pct 5.0`), halve the short position size immediately.
- **Max Strategy Drawdown / Hard Exit**: If portfolio drawdown reaches **8.0%** (`--drawdown-exit-pct 8.0`), close all positions and shut down.
- **Target Profit**: Optional global target profit in INR or `%` (`--target-profit 10%`).

---

## 7. Trading Hours & Rebalance Windows

- **Market Open Buffer**: No new entries before **09:30 AM IST** (`--start-time 09:30`).
- **Scheduled Rebalance Windows**: Evaluated at **10:00 AM**, **12:00 PM**, and **02:00 PM IST** (`--rebalance-times "10:00,12:00,14:00"`).
- **Emergency Continuous Loop**: Checked on every 1–2s tick:
  - Net Delta $< -40$
  - Short Delta $> 0.35$
  - Short Profit $\ge 65\%$
  - Gamma $< -0.20$
  - Portfolio SL / Drawdown breach
- **Overnight Transition**: At 15:25 IST, strategy transitions to `HOLDING OVERNIGHT` state without squaring off (since it is a positional `MARGIN` strategy) and resumes next morning.

---

## 8. Failure Modes & State Recovery

| Event | Tracking State | Action |
|---|---|---|
| Long Leg Entry Fails | `WAITING` | Abort entry, do not place short leg. |
| Short Leg Entry Fails | `UNWINDING` | Immediately close long leg and return to `FLAT`. |
| Short Roll Close Fails | `ROLLING_SHORT` | Retry close until confirmed; do not sell new leg while old short is open. |
| Quote Unavailable / 0.0 | `RUNNING` | Skip tick, log warning, do not act on zero prices. |
| Process Killed Mid-Session | `RESTARTING` | Atomic `_position.json` reloads legs, resubscribes WebSocket feeds, and reconciles with broker. |
| Stop Trigger Written | `STOPPED` | Gracefully closes all open legs via `resolve_exit_qty_broker()`. |

---

## 9. CLI Reference

```bash
# Dry run default (3 long lots, dynamic short sizing, 13 target net delta units)
venv/bin/python strategies/diagonal_call/nifty_diagonal_call.py

# Live execution with custom capital and broker
venv/bin/python strategies/diagonal_call/nifty_diagonal_call.py --live --broker dhan --capital 500000 --long-lots 3

# Custom delta and risk thresholds
venv/bin/python strategies/diagonal_call/nifty_diagonal_call.py \
  --live \
  --long-lots 3 \
  --target-net-delta 13.0 \
  --long-target-delta 0.60 \
  --short-target-delta 0.18 \
  --short-profit-pct 65.0 \
  --daily-loss-pct 1.5 \
  --drawdown-halve-pct 5.0 \
  --drawdown-exit-pct 8.0 \
  --broker dhan
```
