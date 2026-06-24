# Nifty Expiry (0DTE) Strategy

The Nifty Expiry Strategy (`strategies/expiry/nifty_expiry.py`) implements a classic, rule-based 0DTE (expiry day) option selling strategy (Straddles or Strangles) on Nifty index options. It utilizes individual leg stop-losses, dynamic winner lot additions, value-balancing rolls, and double-leg decay protection to manage exposure to Gamma on expiry days.

---

## 1. Strategy Architecture & Flow

### A. Entry Selection
Executed at market entry time (default `--start-time` is `09:20 AM` IST):
* **ATM Straddle**: Rounds the current Nifty spot to the nearest `50` increment and sells the corresponding ATM CE and ATM PE options.
* **OTM Strangle**: Selects strikes based on three configurable methods:
  * **Distance Mode** (Default): Points offset above/below spot (e.g. `--ce-offset 100` and `--pe-offset 100`).
  * **Premium Mode** (via `--premium`): Picks OTM strikes with premiums closest to but below a target price (default `Rs. 50.00` via `--target-premium`).
  * **Delta Mode** (via `--delta`): Picks OTM strikes whose absolute delta is closest to a target delta (default `0.20` via `--target-delta`).

### B. Broker-Side Stop Losses
Upon entering positions, the strategy retrieves the actual execution prices and immediately places **broker-side Stop-Loss Market (SL-M) orders** (default `+40%` of entry premium via `--leg-sl-pct 40.0`). This ensures robust speed and capital protection.

### C. Value Imbalance Monitoring (`winner_addition`)
While both legs are active, the strategy tracks the value difference (`diff_pct`) between the CE and PE positions:
$$\text{diff\_pct} = \frac{|\text{CE\_lots} \times \text{CE\_ltp} - \text{PE\_lots} \times \text{PE\_ltp}|}{\max(\text{CE\_val}, \text{PE\_val})} \times 100$$
If the imbalance exceeds the trigger threshold (e.g. `50.0%` + initial entry imbalance offset), the strategy runs the following checks:

1. **Double-Leg Decay Protection**: If **both** active option premiums have decayed below `--min-adjust-price` (default `Rs. 10.00`), adjustments are completely bypassed.
2. **Projected Addition Pre-Check**: Evaluates projected value difference if we add 1 lot of the current winner (cheaper) option:
   - **Option A (Lot Addition)**: If the projected difference is $\le 10\%$, the winner LTP is $\ge \text{min\_adjust\_price}$ (default `10.0`), and the winner leg has **not yet reached** `--max-lots` (default `4`), the strategy sells `1` additional lot on the same strike. It averages down the entry price and replaces the broker-side SL order.
   - **Option B (Winner Roll Closer)**: If the projected difference is $> 10\%$, the winner LTP is $< \text{min\_adjust\_price}$ (too cheap to add lots), **or the winner leg has already reached `--max-lots`**, the strategy **buys to close the current winner leg and rolls it closer to spot ATM**:
     - Sells the new closer strike with current winner lots quantity (which stays capped at `max_lots`).
     - Ensures the new strike's value matches the challenged leg within 10% ($\ge 90\%$ of challenged leg value).
     - Strictly enforces `CE strike > PE strike` to prevent strike inversion.
     - Replaces WS subscriptions and places the new broker-side SL order.

### D. What Happens if a Stop Loss is Hit
* If one of the legs rises and hits its broker-side SL-M trigger:
  * That leg is closed, realizing a capped loss.
  * **Default Behavior**: The surviving winner leg runs unadjusted with its active SL, collecting decay until zero, SL breach, or EOD auto-exit. (In `winner_addition` mode, no trailing SL adjustment is performed).
  * **Strangle Rebalancing Behavior (via `--post-sl-balance`)**: When enabled, the strategy automatically re-enters the stopped-out side by selling a new option contract. It selects the strike whose current premium matches the surviving leg's LTP, and sells it using the **exact lot quantity** of the surviving leg. It resets the stopped leg's `sl_hit` state to `False`, places a new broker-side SL order, updates WebSocket subscription, and recalculates the baseline imbalance to resume normal double-leg value imbalance monitoring. This eliminates the risk of running a single naked position post-SL.

---

## 2. Command Line Parameters Reference

| CLI Parameter | Default | Description |
| :--- | :--- | :--- |
| `--live` | dry run (off) | Run with live order execution. Default is simulated dry run. |
| `--lots N` | `1` | Initial lots per leg. |
| `--entry-type TYPE` | `straddle` | Entry position type (`straddle` or `strangle`). |
| `--ce-offset PTS` | `100` | Points above spot for CE strike in distance strangle mode. |
| `--pe-offset PTS` | `100` | Points below spot for PE strike in distance strangle mode. |
| `--delta` | off | Use delta-based strike selection for strangle mode. |
| `--target-delta D` | `0.20` | Target absolute delta in delta strangle mode. |
| `--premium` | off | Use premium-based strike selection for strangle mode. |
| `--target-premium P` | `50.0` | Target option premium in premium strangle mode. |
| `--leg-sl-pct PCT` | `40.0` | Stop loss percentage per individual leg (e.g. `40.0%`). |
| `--adjustment MODE` | `c2c` | Adjustment mode (`c2c`, `roll_closer`, `restrangle`, `winner_addition`, `none`). |
| `--min-adjust-price P`| `10.0` | Minimum option price below which lot addition is bypassed and roll closer is triggered. |
| `--post-sl-balance`   | off (False) | Rebalances stopped-out leg to match surviving leg's current premium and lots. |
| `--max-lots N`        | `4` | Maximum lots permitted per leg in `winner_addition` mode. |
| `--target-profit AMT` | `4000.0` | Global daily profit target in Rs. |
| `--stop-loss AMT` | `4000.0` | Global daily stop loss in Rs. |
| `--start-time TIME` | `09:20` | Entry time in HH:MM IST. |
| `--eod-time TIME` | `15:15` | EOD auto-square-off time. |

---

## 3. Numeric Examples

### Example A: Option A (Lot Addition)
1. **Initial Entry**:
   * **CE 24,100**: Sold 1 lot @ Rs. 80.00 (Value: Rs. 5,200)
   * **PE 24,100**: Sold 1 lot @ Rs. 55.00 (Value: Rs. 3,575)
   * **Initial Baseline Offset (`entry_diff_pct`)**:
     $$\text{entry\_diff\_pct} = \frac{|5200 - 3575|}{\max(5200, 3575)} \times 100 = 31.25\%$$
   * **Active Trigger Threshold**:
     $$\text{Active Threshold} = \text{imbalance\_threshold } (50.0\%) + \text{entry\_diff\_pct } (31.25\%) = 81.25\%$$

2. **Market Shift & Threshold Check**:
   * CE LTP rises to **Rs. 95.00** (Value: Rs. 6,175).
   * PE LTP decays to **Rs. 10.50** (Value: Rs. 682.50).
   * **Current Imbalance (`diff_pct`)**:
     $$\text{diff\_pct} = \frac{|6175 - 682.50|}{6175} \times 100 = 88.95\%$$
   * **Trigger Verification**:
     Since `diff_pct` ($88.95\%$) $>$ `Active Threshold` ($81.25\%$), the imbalance check triggers.

3. **Projected Addition Check**:
   * Winner leg is PE (2 lots projected total):
     $$\text{projected\_PE\_val} = 2 \text{ lots} \times \text{Rs. } 10.50 \times 65 = \text{Rs. } 1,365$$
     $$\text{projected\_diff\_pct} = \frac{|6175 - 1365|}{6175} \times 100 = 77.89\%$$
   * **Result**:
     Since `projected_diff_pct` ($77.89\%$) is $> 10\%$, a simple lot addition would not successfully balance the system.
     * **Final Action**: Bypasses lot addition and triggers **Option B (Winner Roll Closer)** instead.

---

### Example B: Option A (Lot Addition - Successful Check)
1. **Initial Entry**:
   * **CE 24,100**: Sold 1 lot @ Rs. 80.00 (Value: Rs. 5,200)
   * **PE 24,100**: Sold 1 lot @ Rs. 70.00 (Value: Rs. 4,550)
   * **Initial Baseline Offset (`entry_diff_pct`)**:
     $$\text{entry\_diff\_pct} = \frac{|5200 - 4550|}{5200} \times 100 = 12.5\%$$
   * **Active Trigger Threshold**:
     $$\text{Active Threshold} = 50.0\% + 12.5\% = 62.5\%$$

2. **Market Shift & Threshold Check**:
   * CE LTP rises to **Rs. 90.00** (Value: Rs. 5,850).
   * PE LTP decays to **Rs. 32.00** (Value: Rs. 2,080).
   * **Current Imbalance (`diff_pct`)**:
     $$\text{diff\_pct} = \frac{|5850 - 2080|}{5850} \times 100 = 64.44\%$$
   * **Trigger Verification**:
     Since `diff_pct` ($64.44\%$) $>$ `Active Threshold` ($62.5\%$), the imbalance check triggers.

3. **Projected Addition Check**:
   * Winner leg is PE (2 lots projected total):
     $$\text{projected\_PE\_val} = 2 \text{ lots} \times \text{Rs. } 32.00 \times 65 = \text{Rs. } 4,160$$
     $$\text{projected\_diff\_pct} = \frac{|5850 - 4160|}{5850} \times 100 = 28.89\%$$
   * **Result**:
     Wait, since `projected_diff_pct` ($28.89\%$) is still $> 10\%$, it would trigger **Winner Roll Closer**.
     Let's see what happens if PE price was **Rs. 42.00** (where it would be close enough):
     * If PE price is **Rs. 42.00** (Value: Rs. 2,730, current diff = 53.33%, which is below active threshold, so let's say active threshold is set lower or imbalance is triggered):
       $$\text{projected\_PE\_val} = 2 \text{ lots} \times \text{Rs. } 42.00 \times 65 = \text{Rs. } 5,460$$
       $$\text{projected\_diff\_pct} = \frac{|5850 - 5460|}{5850} \times 100 = 6.67\%$$
     * Since $6.67\% \le 10\%$, and PE LTP ($42.00$) $\ge 10.00$, the lot addition is allowed.
     * **Final Action**: Sells 1 additional lot of **PE 24,100**. PE average entry becomes **Rs. 56.00** with **2 lots** and updated SL.

---

### Example C: Post-SL Strangle Rebalancing (via `--post-sl-balance`)
1. **CE SL Triggered**:
   * **CE 24,100**: Hits Stop Loss price (Rs. 98.00) and is closed (CE qty = 0, `ce_sl_hit` = True).
   * **PE 24,100**: Remains open with **2 lots** (Value: Rs. 1,950 @ current LTP of Rs. 15.00).

2. **Rebalancing Configuration Check**:
   * Since one leg is stopped out, the strategy calls `_adjust_surviving_leg`.
   * It checks: `if self.post_sl_balance:` (which is enabled via the `--post-sl-balance` CLI argument).
   * It checks: `if self.adjustment_count < self.max_adjustments:` (adjustment count is 0, max is 3).
   * **Decision**: Proceed with rebalancing to neutralize the naked PE leg.

3. **Rebalancing Execution**:
   * Finds surviving PE leg price (LTP = Rs. 15.00) and lot size (**2 lots**).
   * Filters the option chain for CE strikes above the PE strike of `24,100` (to avoid strike inversion).
   * Selects **CE 24,250** whose premium is closest to Rs. 15.00 (LTP = Rs. 13.50).
   * Sells **2 lots** (130 shares) of **CE 24,250** at market.
   * Places a new CE Stop Loss at **Rs. 18.90** (`13.50 * 1.4` rounded).
   * Resets `ce_sl_hit = False`, allowing normal double-leg monitoring to resume.

4. **Recalculation of Baseline Offset**:
   * Immediately after entry, the strategy updates `self.entry_diff_pct` using the new LTPs:
     * CE Value: $2 \text{ lots} \times \text{Rs. } 13.50 \times 65 = \text{Rs. } 1,755$
     * PE Value: $2 \text{ lots} \times \text{Rs. } 15.00 \times 65 = \text{Rs. } 1,950$
     $$\text{new\_entry\_diff\_pct} = \frac{|1950 - 1755|}{1950} \times 100 = 10.0\%$$
     The strategy saves `self.entry_diff_pct = 10.0%`.
   * **New Active Trigger Threshold**:
     $$\text{New Active Threshold} = \text{imbalance\_threshold } (50.0\%) + \text{entry\_diff\_pct } (10.0\%) = 60.0\%$$

5. **Subsequent Market Shift & Threshold Check**:
   * Later in the day, the market moves down.
   * **CE 24,250** premium decays to **Rs. 3.00** (Value: Rs. 390).
   * **PE 24,100** premium rises to **Rs. 25.00** (Value: Rs. 3,250).
   * **Current Imbalance (`diff_pct`)**:
     $$\text{diff\_pct} = \frac{|3250 - 390|}{3250} \times 100 = 88.0\%$$
   * **Subsequent Trigger Verification**:
     Since the current imbalance `diff_pct` ($88.0\%$) $>$ `New Active Threshold` ($60.0\%$), the strategy triggers another imbalance adjustment cycle. Since winner CE LTP ($3.00$) is $< \text{min\_adjust\_price}$ (Rs. 10.00), it will trigger a Winner Roll Closer on the CE leg.

---

## 4. How to Run the Strategy

All commands must be executed from the project root (`c:\dhan_algo\dhan_algo`) using the python interpreter within the virtual environment.

### Activate Virtual Environment
```powershell
c:\dhan_algo\dhan_algo\venv\Scripts\activate
```

### Dry-Run Simulations (Safe - No Real Orders)

#### Default Straddle Entry with Winner Addition
```powershell
python strategies/expiry/nifty_expiry.py --adjustment winner_addition
```

#### Straddle Entry with Winner Addition and Post-SL Rebalancing
```powershell
python strategies/expiry/nifty_expiry.py --adjustment winner_addition --post-sl-balance
```

#### Strangle Entry (Distance) with Winner Addition (Target Rs. 10 Min Price)
```powershell
python strategies/expiry/nifty_expiry.py --entry-type strangle --ce-offset 150 --pe-offset 150 --adjustment winner_addition --min-adjust-price 10.0
```

#### Strangle Entry (Premium) with Cost-to-Cost (C2C) Adjustment
```powershell
python strategies/expiry/nifty_expiry.py --entry-type strangle --premium --target-premium 45.0 --adjustment c2c
```

---

### Live Trading (Real Orders)

#### Live Straddle (Winner Addition, 1 lot, max 4 lots)
```powershell
python strategies/expiry/nifty_expiry.py --live --lots 1 --entry-type straddle --adjustment winner_addition --max-lots 4
```

#### Live Strangle with Winner Addition and Post-SL Rebalancing (1 lot, max 4 lots, target premium Rs. 50)
```powershell
python strategies/expiry/nifty_expiry.py --live --lots 1 --entry-type strangle --premium --target-premium 50.0 --adjustment winner_addition --max-lots 4 --min-adjust-price 10.0 --post-sl-balance
```

#### Live Strangle (Premium-Based Selection, 2 lots, Winner Addition)
```powershell
python strategies/expiry/nifty_expiry.py --live --lots 2 --entry-type strangle --premium --target-premium 50.0 --adjustment winner_addition --min-adjust-price 12.0
```

#### Live Strangle (Delta-Based Selection, 2 lots, C2C Adjustment)
```powershell
python strategies/expiry/nifty_expiry.py --live --lots 2 --entry-type strangle --delta --target-delta 0.20 --adjustment c2c --target-profit 6000 --stop-loss 3000
```
