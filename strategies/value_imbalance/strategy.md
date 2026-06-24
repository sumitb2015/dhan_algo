# Nifty Value-Imbalance Strategies

This document provides a detailed breakdown of the value-imbalance option selling strategies located in the `strategies/value_imbalance/` directory:
1.  **Nifty Advanced Value-Imbalance Straddle & Strangle** (`nifty_advanced_imbalance.py`)
2.  **Nifty Value-Imbalance Straddle** (`nifty_value_imbalance_straddle.py`)
3.  **Nifty Value-Imbalance Strangle** (`nifty_value_imbalance_strangle.py`)

---

## 1. Core Mechanics & Mathematical Formulas

The value-imbalance framework seeks to maintain premium balance (and therefore delta neutrality) in a short option portfolio by dynamically adjusting legs as the underlying market trends.

```mermaid
flowchart TD
    Init([Start Strategy]) --> ATMSelect[Select ATM CE & PE Strikes]
    ATMSelect --> EntryWait{Are Premiums Balanced?}
    EntryWait -- "No (Diff >= Entry Threshold)" --> EntryWait
    EntryWait -- "Yes (Diff < Entry Threshold)" --> PlaceEntry[Place Short CE & PE Orders]
    PlaceEntry --> Monitoring[Monitor Active Positions & P&L]
    
    Monitoring --> SLCheck{Profit Target or SL Hit?}
    SLCheck -- Yes --> SquareOff[Square Off All Positions]
    
    Monitoring -- Normal --> CalcDiff[Calculate Value Imbalance diff_pct]
    CalcDiff --> ShiftCheck{Straddle/Strangle Shift Boundary Breached?}
    ShiftCheck -- Yes --> CycleReset[Cycle Reset: Exit All + Wait 5m] --> ATMSelect
    
    ShiftCheck -- No --> ImbalanceCheck{diff_pct > Active Threshold?}
    ImbalanceCheck -- Yes --> MaxLotsCheck{Active Leg Qty >= max_lots?}
    
    MaxLotsCheck -- No --> WinnerAdd[Option A: Add Winner lot to average down] --> Monitoring
    MaxLotsCheck -- Yes --> StrikeShift[Option B: Shift challenged leg further OTM] --> Monitoring
```

### A. Mathematical Definitions

*   **Premium Value**:
    $$\text{Value}_{\text{leg}} = \text{Lots}_{\text{leg}} \times \text{LTP}_{\text{leg}}$$
*   **Imbalance Percentage (`diff_pct`)**:
    $$\text{diff\_pct} = \frac{|\text{CE\_val} - \text{PE\_val}|}{\max(\text{CE\_val}, \text{PE\_val})} \times 100$$
*   **Active Trigger Threshold**:
    $$\text{Active Threshold} = \text{Threshold}_{\text{Lot/Strike}} + \text{entry\_diff\_pct}$$
    *(where `entry_diff_pct` is the initial imbalance offset recorded at entry)*

---

## 2. Strategy Phases (Legacy Straddle & Strangle)

The standard straddle (`nifty_value_imbalance_straddle.py`) and strangle (`nifty_value_imbalance_strangle.py`) strategies operate in five distinct phases:

### Phase 1: Initialization & ATM Selection
*   Fetches the current Nifty spot price.
*   Identifies ATM strike (for straddle) or OTM strikes (for strangle).
*   Resolves contract IDs and fetches current lot sizes dynamically.

### Phase 2: Balanced Entry Check
*   Monitors premium prices.
*   Triggers entry only when the premium difference is below the threshold (default: `< 15.0%` for straddle, `< 25.0%` for strangle).

### Phase 3: Value Balancing (Lot Addition)
*   If the market trends and `diff_pct` exceeds the `threshold_lot` (default: `25.0%` + entry offset):
    *   Sells `1` additional lot on the **Winner** (cheaper, decaying) leg.
    *   Averages down the entry price and collects more theta decay to offset the losing leg.
    *   Repeats until `max_lots` (default: `4`) is reached.

### Phase 4: Single-Leg Strike Adjustment
*   If `max_lots` is reached and `diff_pct` exceeds `threshold_strike` (default: `40.0%` + entry offset):
    *   Shifts the **Loser** (expensive, challenged) leg to a further OTM strike.
    *   Selects a new strike such that:
        $$\text{New\_Lots} \times \text{New\_Price} \approx \text{Current\_Value}_{\text{winner}}$$
    *   This resets the risk of the challenged leg without squaring off the entire trade.

### Phase 5: Straddle Shift (Cycle Reset)
*   **Straddle**: If the current ATM strike shifts by **$\ge$ 100 points** from the original entry strike (e.g. when spot reaches `initial_atm + 75` or `initial_atm - 75`, causing the ATM to change by 100 points), the entire trade is squared off, pauses for 5 minutes, and restarts.
*   **Strangle**: If spot breaches the outer strike boundaries, exits all positions, pauses 5 minutes, and restarts a fresh strangle.

---

## 3. Advanced Strategy Mode Variations (`nifty_advanced_imbalance.py`)

The advanced script introduces selectable adjustment logic modes to optimize margin efficiency and hedge tail risk:

### A. `winner_roll_atm` (Default)
*   **Action**: Checks the value of the losing leg and chooses the appropriate strike to balance the winner leg's premium against that value, maintaining a flat 1:1 lot ratio.
*   **Benefit**: Eliminates margin inflation by keeping lot counts static.
*   **Inversion Prevention**: Strictly enforces `CE strike > PE strike`. If a roll would cross strikes, it triggers an emergency cycle exit.

### B. `loser_ratio_roll`
*   **Action**: Rolls the challenged loser leg further OTM and increments quantity (ratio spread) to maintain premium collections.
*   **Benefit**: Highly configurable lot increment size (default: `1` lot increment via `--loser-ratio-lots`).

### C. `hedged_addition`
*   **Action**: Adds short lots to the winner leg (like legacy) but buys further OTM options (200 pts out) to hedge against market whipsaws.
*   **Benefit**: Limits potential reversal losses to:
    $$\text{Max Wing Loss} = \text{Strike Difference (200)} - \text{Net Credit Added}$$

### D. `legacy`
*   **Action**: Original unhedged winner lot addition strategy.

---

## 4. CLI Parameters Reference

### A. Nifty Advanced Value-Imbalance Strategy (`nifty_advanced_imbalance.py`)

| CLI Flag | Default | Description |
| :--- | :--- | :--- |
| **`--live`** | *Flag* | Enable real order placement (defaults to dry-run mode). |
| **`--lots N`** | `1` | Initial lots per leg. |
| **`--mode MODE`** | `winner_roll_atm` | Selects adjustment mode (`winner_roll_atm`, `loser_ratio_roll`, `hedged_addition`, `legacy`). |
| **`--loser-ratio-lots N`** | `1` | Number of lots to increment during a loser ratio roll adjustment. |
| **`--entry-type TYPE`** | `straddle` | Entry position type (`straddle`, `strangle`). |
| **`--delta`** | *Flag* | Use delta-based strike selection for strangle. |
| **`--target-delta D`** | `0.20` | Target absolute delta in delta strangle mode. |
| **`--premium`** | *Flag* | Use premium-based strike selection for strangle. |
| **`--target-premium PREM`** | `50.0` | Target premium in premium strangle mode. |
| **`--ce-offset PTS`** | `200` | Points above spot for CE strike in distance strangle. |
| **`--pe-offset PTS`** | `200` | Points below spot for PE strike in distance strangle. |
| **`--target-profit AMT`** | `4000.0` | Global daily profit target in ₹. |
| **`--stop-loss AMT`** | `4000.0` | Global daily stop loss in ₹. |
| **`--start-time TIME`** | `09:20` | Market start monitoring time (HH:MM IST). |

### B. Nifty Value-Imbalance Straddle Strategy (`nifty_value_imbalance_straddle.py`)

| CLI Flag | Default | Description |
| :--- | :--- | :--- |
| **`--live`** | *Flag* | Enable real order placement (defaults to dry-run mode). |
| **`--lots N`** | `1` | Initial lots per leg. |
| **`--target-profit AMT`** | `4000.0` | Global daily profit target in ₹. |
| **`--stop-loss AMT`** | `4000.0` | Global daily stop loss in ₹. |
| **`--start-time TIME`** | `09:20` | Market start monitoring time (HH:MM IST). |
| **`--entry-balance-threshold PCT`** | `15.0` | Initial balance threshold percentage for entry. |

### C. Nifty Value-Imbalance Strangle Strategy (`nifty_value_imbalance_strangle.py`)

| CLI Flag | Default | Description |
| :--- | :--- | :--- |
| **`--live`** | *Flag* | Enable real order placement (defaults to dry-run mode). |
| **`--lots N`** | `1` | Initial lots per leg. |
| **`--delta`** | *Flag* | Use delta-based strike selection. |
| **`--distance`** | *Flag* | Use fixed-point offset strike selection (default). |
| **`--premium`** | *Flag* | Use premium-based strike selection. |
| **`--ce-offset PTS`** | `200` | Points above spot for CE strike. |
| **`--pe-offset PTS`** | `200` | Points below spot for PE strike. |
| **`--target-delta D`** | `0.20` | Target absolute delta in delta mode. |
| **`--target-premium PREM`** | `50.0` | Target premium in premium mode. |
| **`--target-profit AMT`** | `4000.0` | Global daily profit target in ₹. |
| **`--stop-loss AMT`** | `4000.0` | Global daily stop loss in ₹. |
| **`--start-time TIME`** | `09:20` | Market start monitoring time (HH:MM IST). |

---

## 5. Execution Examples

> [!IMPORTANT]
> All commands must be executed from the project root using the virtual environment python interpreter.

### Activate Virtual Environment
```powershell
c:\dhan_algo\dhan_algo\venv\Scripts\activate
```

### Dry Run Simulations (Safe — No Real Orders)

*   **Advanced Straddle (Default Winner Roll, 1 lot)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --mode winner_roll_atm
    ```
*   **Advanced Strangle (Distance, OTM Loser Ratio Roll with 2-lot increments)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode loser_ratio_roll --loser-ratio-lots 2
    ```
*   **Legacy Straddle (Lot Addition)**:
    ```powershell
    python strategies/value_imbalance/nifty_value_imbalance_straddle.py
    ```
*   **Legacy Strangle (Premium-based entry <= Rs. 40)**:
    ```powershell
    python strategies/value_imbalance/nifty_value_imbalance_strangle.py --premium --target-premium 40.0
    ```

### Live Trading (Real Orders)

*   **Live Advanced Straddle (Winner Roll, 2 lots initial)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --live --lots 2 --entry-type straddle --mode winner_roll_atm
    ```
*   **Live Advanced Strangle (Delta-based 0.20, Hedged Addition, 1 lot initial)**:
    ```powershell
    python strategies/value_imbalance/nifty_advanced_imbalance.py --live --lots 1 --entry-type strangle --delta --target-delta 0.20 --mode hedged_addition --target-profit 5000 --stop-loss 3000
    ```
*   **Live Legacy Straddle (2 lots initial, custom entry balance 5%)**:
    ```powershell
    python strategies/value_imbalance/nifty_value_imbalance_straddle.py --live --lots 2 --entry-balance-threshold 5
    ```

---

## 6. Detailed Trade Flow Examples

Here are step-by-step examples of how trades flow under different market conditions.

### Scenario A: Symmetrical Decay & Target Exit (No Adjustments)
1.  **Selection & Balanced Entry**: 
    *   Nifty Spot is `24,015`. Rounding to nearest `50` yields `24,000` ATM strike.
    *   `24000 CE` trades @ ₹120; `24000 PE` trades @ ₹115.
    *   Difference = $(120 - 115) / 120 \times 100 = 4.17\%$. Since $4.17\% < 15.0\%$ entry threshold, the trade is entered (Sell 1 lot CE @ ₹120, Sell 1 lot PE @ ₹115).
    *   Initial `entry_diff_pct` offset is recorded as `4.17%`.
2.  **Symmetrical Market Decay**:
    *   Market ranges between `23,980` and `24,020` for two hours.
    *   `24000 CE` decays to ₹80; `24000 PE` decays to ₹75.
    *   Combined unrealized profit: $(120 - 80 + 115 - 75) \times 75 \text{ (lot size)} = \mathbf{₹6,000}$ (assuming Nifty lot size is 75).
3.  **Target Reached & Square Off**:
    *   Total P&L (₹6,000) exceeds target profit limit of ₹4,000.
    *   The strategy executes market buy back orders to close both legs and terminates for the day.

---

### Scenario B: Dynamic Lot Addition (Martingale Balancing)
1.  **Entry Setup**: 
    *   Short 1 lot `24000 CE` @ ₹120; Short 1 lot `24000 PE` @ ₹115. Offset: `4.17%`.
    *   Lot addition trigger threshold: $25\% + 4.17\% = \mathbf{29.17\%}$.
2.  **Market Trending Move**:
    *   Spot climbs to `24,070`.
    *   `24000 CE` spikes to ₹170 (Value: ₹170).
    *   `24000 PE` decays to ₹70 (Value: ₹70).
    *   Imbalance = $(170 - 70) / 170 \times 100 = 58.82\%$. This breaches the $29.17\%$ trigger.
3.  **Adjustment (Lot Addition)**:
    *   Leg count ($1$) is less than `max_lots` ($4$).
    *   Sells `1` additional lot on the winning (cheaper) side: `24000 PE` @ ₹70.
    *   PE Avg Price is updated to: $(115 + 70) / 2 = \mathbf{₹92.50}$ (2 lots).
    *   Baseline offset `entry_diff_pct` is recalculated:
        $$\text{CE Value} = 1 \times 170 = 170$$
        $$\text{PE Value} = 2 \times 70 = 140$$
        $$\text{new\_entry\_diff\_pct} = \frac{170 - 140}{170} \times 100 = 17.65\%$$
    *   Active trigger threshold becomes: $25\% + 17.65\% = \mathbf{42.65\%}$.
4.  **Subsequent Monitoring**:
    *   Market stabilizes. The 2 lots of `24000 PE` decay twice as fast, neutralizing the risk of the challenged CE.

---

### Scenario C: OTM Winner Rolling (`winner_roll_atm` Mode)
1.  **Entry Setup**: 
    *   Short 1 lot `24000 CE` @ ₹120; Short 1 lot `24000 PE` @ ₹115. Offset: `4.17%`.
    *   Trigger threshold: $25\% + 4.17\% = \mathbf{29.17\%}$.
2.  **Market Trending Move**:
    *   Spot climbs to `24,070`.
    *   `24000 CE` spikes to ₹170; `24000 PE` decays to ₹70. Imbalance = $58.82\% > 29.17\%$.
3.  **Adjustment (Winner Value-Balanced Roll)**:
    *   Instead of adding lots or rolling blindly to ATM, the strategy checks the value of the losing PE leg (1 lot * ₹170 = ₹170) and selects the PE strike whose value matches ₹170.
    *   Action: Buys to close `24000 PE` @ ₹70 (Realized Profit: +₹45).
    *   Action: Queries option chain for the PE strike trading closest to ₹170 (e.g., `24050 PE` @ ₹105).
    *   Action: Sells 1 lot `24050 PE` @ ₹105.
    *   New Position: `24000 CE` (1 lot @ avg ₹120) & `24050 PE` (1 lot @ avg ₹105).
    *   Premium balance is restored with zero margin inflation.

---

### Scenario D: Straddle Shift (Cycle Reset)
1.  **Entry Setup**: 
    *   Initial Nifty Spot is `24,015`. Sells `24000 CE` & `24000 PE` ATM Straddle.
    *   Initial ATM strike `initial_ce_strike` is recorded as `24,000`.
2.  **Market Trending Move**:
    *   Heavy buying pushes Nifty Spot to `24,076`.
    *   The current spot ATM strike becomes `24,100` (since `int(round(24076 / 50) * 50) = 24100`).
3.  **Cycle Reset Trigger**:
    *   The strategy calculates `current_atm` as `24,100`.
    *   The strike shift distance is:
        $$\text{Shift Distance} = |24100 - 24000| = \mathbf{100\text{ points}}$$
    *   Since the ATM strike has shifted by $\ge 100$ points (meaning the strike that was originally 100 points above the initial ATM has now become the current ATM), the shift triggers.
    *   **Action**: Immediately buys to close all active straddle positions (`24000 CE` and `24000 PE`) to protect against extreme directional moves.
    *   Pauses for **5 minutes** (cooldown) and then restarts a fresh cycle at the new ATM strike (`24,100`).
