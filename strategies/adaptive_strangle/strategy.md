# Nifty Bi-Weekly Adaptive Strangle Strategy

`strategies/adaptive_strangle/nifty_adaptive_strangle.py`

> **Positional (Bi-Weekly Carry) Option Selling Strategy.**
> Sells far-OTM Nifty strangles on the 2nd weekly expiry (~8–15 DTE) with zero upfront hedge drag.
> Dynamically buys conditional protective wings on Greek threat triggers (Delta or Vega/IV surge)
> and optionally transitions into a directional strategy upon confirmed Nifty index trends.
> Dry-run default — `--live` required for real orders.

---

## 1. Why / Edge Hypothesis

Traditional retail option sellers face two common pitfalls:
1. **Unhedged Strangles (Naked Tail Risk)**: Collecting pure theta is profitable in range-bound markets, but an unexpected sharp rally, market crash, or volatility expansion event can cause outsized gamma/vega losses.
2. **Fixed Iron Condors (Hedge Drag)**: Buying far OTM hedges upfront constantly erodes 20%–40% of collected premium. In ~70% of market sessions where Nifty stays within 1–2 standard deviations, upfront hedges expire worthless, creating a heavy performance drag.

### Core Solution: The Bi-Weekly Adaptive Strangle
This strategy balances maximum theta capture with institutional risk management through three pillars:
- **Bi-Weekly Far-OTM Expiry**: Targets the **second weekly expiry** (`helper.get_expiries("NIFTY")[1]`, ~8 to 15 DTE) at low delta ($\Delta \approx 0.10$). Compared to 0–3 DTE contracts, bi-weekly contracts offer lower gamma risk, wider safety margins (±450 to ±600 points from spot), and smooth theta decay.
- **Conditional Delta & Vega Hedging**:
  - Starts 100% naked (0 hedges), maximizing theta capture and initial credit.
  - **Delta Threat Trigger**: If Nifty drifts towards one strike such that the short leg's delta expands to $\ge 0.22$, the strategy immediately buys a protective OTM hedge on that threatened side ($\Delta \approx 0.08$), capping tail risk and transforming that side into a credit spread.
  - **Vega / IV Surge Trigger**: If implied volatility or India VIX surges by $\ge 20\%$, the strategy purchases protective wings on both sides to neutralize short Vega exposure.
- **Directional Trend Conversion (`--enable-directional-conversion`)**:
  - When Nifty establishes a sustained trend, continuing to defend an inverted or pressured strangle can result in consecutive losses.
  - If a short leg expands to $\ge 0.30$ Delta and Nifty index confirms directional momentum (e.g. Spot vs 15-min EMA 20 / Supertrend):
    - **Harvest Winning Leg**: Square off the decayed winning leg (often >80% decayed) to lock in realized profit.
    - **Deploy Directional Structure**: Close or transition the losing short leg into a directional vehicle (Bull Call Spread / Bear Put Spread under `--conversion-style spread`, or 1×2 Ratio Spread under `--conversion-style ratio`) to ride index momentum.

---

## 2. Instruments & Product

- **Underlying**: `NIFTY` index options (`IDX_I` / `NSE_FNO`).
- **Expiry Horizon**: Bi-weekly options (`helper.get_expiries("NIFTY")[1]`, 8 to 15 DTE).
- **Product Type**: `MARGIN` (positional carry-forward across sessions).
- **Lot Sizing**: Dynamic lot size from `helper.get_lot_size("NIFTY")`. Base quantity is `--lots * lot_size`.
- **Brokers Supported**: `dhan`, `zerodha`, `kotak` via `ExecutionBroker`.

---

## 3. Strategy Lifecycle & Phases

```
                     ┌────────────────────────┐
                     │ Phase 1: Entry         │
                     │ Sell 0.10Δ CE + PE     │
                     │ (Hedges = 0)           │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
        ┌───────────►│ Phase 2: Monitoring    │◄───────────┐
        │            │ Evaluate Δ & Vega      │            │
        │            └───────────┬────────────┘            │
        │                        │                         │
        │    Range-Bound         │ Threat Detected         │
        │    (Both Δ < 0.22)     │ (Δ >= 0.22 or IV Surge) │
        └────────────────────────┤                         │
                                 ▼                         │
                     ┌────────────────────────┐            │
                     │ Phase 3: Cond. Hedging │            │
                     │ Buy OTM Hedge on       ├────────────┘
                     │ Threatened Side        │
                     └───────────┬────────────┘
                                 │
                                 │ Sustained Trend Confirmed
                                 │ (Δ >= 0.30 & Index Trend)
                                 ▼
                     ┌────────────────────────┐
                     │ Phase 4: Directional   │
                     │ Harvest Win + Ride     │
                     │ Directional Spread     │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │ Phase 5: Exit          │
                     │ Target (+5%) / SL (-4%)│
                     │ or Expiry Day EOD      │
                     └────────────────────────┘
```

### Phase 1: Entry
- Evaluated between `--entry-time` (default `09:20`) and `--entry-end` (default `15:00`).
- Resolves bi-weekly expiry date.
- Selects far-OTM strikes:
  - `ce_short_strike`: Strike where Call delta $\approx 0.10$.
  - `pe_short_strike`: Strike where Put magnitude $|\text{delta}| \approx 0.10$.
- Inversion Guard: Strictly enforces `ce_short_strike > pe_short_strike`.
- Premium Symmetry: `min(ce_px, pe_px) / max(ce_px, pe_px) >= 0.60`.
- Sells both legs; zero hedges purchased initially.

### Phase 2 & 3: Monitoring & Conditional Hedging
Every poll interval (~1–2s), live/Black-Scholes Greeks are calculated:
- **Upside Threat**: `ce_short_delta >= --hedge-delta-trigger` (default `0.22`):
  - Buy Call Hedge at `--hedge-target-delta` (default `0.08`).
  - Upside risk is capped. Call side becomes a Bear Call Spread.
- **Downside Threat**: `abs(pe_short_delta) >= --hedge-delta-trigger` (default `0.22`):
  - Buy Put Hedge at `--hedge-target-delta` (default `0.08`).
  - Downside risk is capped. Put side becomes a Bull Put Spread.
- **Vega / IV Surge**: Implied Volatility jumps by $\ge \text{--vega-surge-pct}$ (default `20%`):
  - Buy hedges on both wings to neutralize negative Vega.

### Phase 4: Directional Trend Conversion (Optional)
If `--enable-directional-conversion` is enabled:
- **Bullish Trend Trigger**: `ce_short_delta >= --conversion-delta-trigger` (default `0.30`) AND Nifty spot > 15-min EMA 20:
  - Square off decayed PE leg (harvest >80% profit).
  - Close CE short leg (cut loss).
  - Deploy Bullish Spread (Buy 0.40 Delta CE, Sell 0.20 Delta CE).
- **Bearish Trend Trigger**: `abs(pe_short_delta) >= --conversion-delta-trigger` (default `0.30`) AND Nifty spot < 15-min EMA 20:
  - Square off decayed CE leg (harvest >80% profit).
  - Close PE short leg (cut loss).
  - Deploy Bearish Spread (Buy 0.40 Delta PE, Sell 0.20 Delta PE).

### Phase 5: Exits
- **Target Profit (`--target-profit`)**: Default +5% of deployed margin (or specified ₹ amount).
- **Stop Loss (`--stop-loss`)**: Default -4% of deployed margin (or specified ₹ amount).
- **Trailing Stop (`--trail-start-rs`, `--trail-gap-rs`)**: Locks in gains when P&L pulls back.
- **Expiry Day Exit (`--eod-exit-time`)**: Squares off all active legs at `15:15` IST on the expiry day.

---

## 4. Failure Modes & Recovery

| Failure Scenario | Detection | Immediate Action | Resulting State |
|---|---|---|---|
| PE sell fails after CE sold on entry | Second leg order returns None/unconfirmed | Immediately buy-to-close the filled CE leg. | `status="UNWINDING"` until flat |
| Conditional hedge buy rejected | `broker.buy()` returns None | Retries hedge order on next poll. Logs warning. | `status="RUNNING"`, continues monitoring |
| Process killed while position is open | Startup checks `debug/<key>_position.json` | Restores all legs, resubscribes WebSocket, reconciles with broker. | Restores `status="RUNNING"` |
| Quote drops to 0 or becomes stale | LTP validator detects `<= 0` | Skips tick without updating P&L or firing rules. | State unchanged, waits for valid tick |
| Close order unconfirmed on exit | `_confirm_close()` returns False | Retries close order every loop. Does not trade over unclosed legs. | `status="FLATTENING"` |

---

## 5. CLI Usage Examples

```powershell
# 1. Dry run after hours (safe, validates strike selection and state bridge)
python strategies/adaptive_strangle/nifty_adaptive_strangle.py

# 2. Dry run with directional conversion enabled and custom delta triggers
python strategies/adaptive_strangle/nifty_adaptive_strangle.py --entry-delta 0.10 --hedge-delta-trigger 0.20 --enable-directional-conversion

# 3. Live execution (requires --live)
python strategies/adaptive_strangle/nifty_adaptive_strangle.py --live --lots 1 --target-profit 5% --stop-loss 4% --broker dhan
```
