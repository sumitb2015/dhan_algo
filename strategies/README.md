# Nifty Advanced Imbalance Strategy: Execution & Adjustment Examples

This documentation details command-line execution parameters and step-by-step examples of how each of the adjustment modes in `nifty_advanced_imbalance.py` handles position management during market trends and reversals.

---

## CLI Command-Line Parameters

You can configure and launch the strategy using the following parameters:

| Parameter | Type / Choices | Default | Description |
| :--- | :--- | :--- | :--- |
| **`--mode`** | `winner_roll_atm`<br>`loser_ratio_roll`<br>`hedged_addition`<br>`legacy` | **`winner_roll_atm`** | Selects the adjustment strategy mode to execute when value imbalance triggers. |
| **`--live`** | *Flag (Boolean)* | **`False`** | If specified, enables live order placement with the broker. If omitted, runs in a safe dry-run simulation mode. |
| **`--lots`** | *Integer* | **`1`** | Initial lot count to trade per leg (e.g. `--lots 2` starts with 2 lots on CE and 2 lots on PE). |
| **`--target-profit`** | *Float* | **`4000.0`** | Global daily profit target in INR. The strategy exits all positions and halts for the day if this target is reached. |
| **`--stop-loss`** | *Float* | **`4000.0`** | Global daily stop loss in INR. Exits all positions and halts for the day if hit. |
| **`--entry-type`** | `straddle`<br>`strangle` | **`straddle`** | Selects the entry position type (Straddle ATM vs Strangle OTM). |
| **`--delta`** | *Flag (Boolean)* | **`False`** | Use delta-based strike selection for Strangle entry. |
| **`--target-delta`**| *Float* | **`0.20`** | Target absolute delta in delta strangle mode (e.g. `0.20` targets $\approx 0.20$ delta). |
| **`--ce-offset`** | *Integer* | **`200`** | Points above spot for CE strike in distance strangle mode. |
| **`--pe-offset`** | *Integer* | **`200`** | Points below spot for PE strike in distance strangle mode. |
| **`--premium`** | *Flag (Boolean)* | **`False`** | Use premium-based strike selection for Strangle entry. |
| **`--target-premium`** | *Float* | **`50.0`** | Target premium value in premium strangle mode. |
| **`--start-time`** | *String* | **`09:20`** | Market start monitoring time (HH:MM IST format). |

### Example Usages
```powershell
# 1. Standard Straddle dry run (Winner roll, 1 lot)
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type straddle --mode winner_roll_atm

# 2. Distance Strangle dry run (asymmetric: tighter CE offset, wider PE offset)
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type strangle --ce-offset 150 --pe-offset 250 --mode winner_roll_atm

# 3. Delta-based Strangle dry run (Target 0.15 delta) with hedged additions
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type strangle --delta --target-delta 0.15 --mode hedged_addition

# 4. Live execution using OTM loser rolling with custom target & stop loss
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --live --entry-type strangle --delta --target-delta 0.20 --mode loser_ratio_roll --target-profit 6000 --stop-loss 3000
```

---

## Core Strategy Parameters
* **Initial Lots**: 1 lot per leg.
* **Max Lots**: 4 lots per leg.
* **Lot Addition Threshold (`threshold_lot`)**: 25%.
* **Strike Shift Threshold (`threshold_strike`)**: 40%.
* **Initial Setup**: Rounded spot price determines the ATM strike. Let Nifty Spot = 24,000.
  * **Short 24000 CE**: Sold 1 lot at ₹150 (Total Value: ₹150)
  * **Short 24000 PE**: Sold 1 lot at ₹145 (Total Value: ₹145)
  * **Entry Imbalance (`entry_diff_pct`)**: $\frac{150 - 145}{150} \times 100 = 3.3\%$
  * **Lot Addition Trigger**: $25.0\% + 3.3\% = \mathbf{28.3\%}$

---

## 1. Mode: `winner_roll_atm` (Untested Winner Leg Roll)
* **Goal**: Collect more premium by rolling the winning leg closer to spot without increasing contract quantity (retaining a strict 1:1 lot ratio).

```
[Entry] Short 1x 24000 CE (₹150) & 1x 24000 PE (₹145)
   │
   ▼ (Nifty spot rises from 24,000 to 24,080)
[Imbalance Triggered] Short 1x CE spikes to ₹210, PE decays to ₹80 (Diff: 61.9% > 28.3%)
   │
   ▼ (Roll PE to new ATM 24,100)
[Action] Buy back 1x 24000 PE at ₹80 (Realized Profit: +₹65)
[Action] Sell-to-open 1x 24100 PE at ₹140
   │
   ▼
[New State] Short 1x 24000 CE (avg ₹150) & 1x 24100 PE (avg ₹140)
```

### Risk/Reward in Reversal
* **If Nifty reverses back to 24,000**: The CE decays back to ₹150, and the new 24100 PE increases. However, because you are holding a flat 1:1 lot ratio, the losses on the PE are naturally offset by the gains on the CE, and your total premium base is larger by the realized ₹65 profit.

---

## 2. Mode: `loser_ratio_roll` (OTM Challenged Loser Roll)
* **Goal**: Close the challenged leg and roll it further OTM, using a larger lot count to finance the roll.

```
[Entry] Short 1x 24000 CE (₹150) & 1x 24000 PE (₹145)
   │
   ▼ (Nifty spot rises from 24,000 to 24,080)
[Imbalance Triggered] Short 1x CE spikes to ₹210, PE decays to ₹80 (Diff: 61.9% > 28.3%)
   │
   ▼ (Roll loser CE OTM and increment quantity to 2 lots)
[Action] Buy back 1x 24000 CE at ₹210 (Realized Loss: -₹60)
[Action] Target premium per option = Winner Value (80) / New Lots (2) = ₹40
[Action] Sell-to-open 2x 24200 CE (closest strike) at ₹42
   │
   ▼
[New State] Short 1x 24000 PE (avg ₹145) & 2x 24200 CE (avg ₹42)
```

### Risk/Reward in Reversal
* **If Nifty continues to rise to 24,200**: The 24200 CE is challenged, and you roll it again to 3 lots of a further OTM strike (e.g. 24350 CE).
* **If Nifty reverses to 24,000**: The 2x 24200 CE options decay rapidly to zero, providing double the decay velocity on the CE side, offsetting the rise in the 1x 24000 PE.

---

## 3. Mode: `hedged_addition` (Hedged Winner Lot Addition)
* **Goal**: Average down on the winning side to collect decay, but buy protective OTM options to prevent catastrophic reversal losses.

```
[Entry] Short 1x 24000 CE (₹150) & 1x 24000 PE (₹145)
   │
   ▼ (Nifty spot rises from 24,000 to 24,080)
[Imbalance Triggered] Short 1x CE spikes to ₹210, PE decays to ₹80 (Diff: 61.9% > 28.3%)
   │
   ▼ (Add PE lot and hedge it)
[Action] Buy-to-open 1x 23800 PE (200 pts OTM from 24000 PE) at ₹20
[Action] Sell-to-open 1x 24000 PE at ₹80 (Net Credit added: +₹60)
   │
   ▼
[New State] Short 1x 24000 CE (avg ₹150), Short 2x 24000 PE (avg ₹112.50) & Long 1x 23800 PE (buy price ₹20)
```

### Risk/Reward in Reversal
* **If Nifty crashes to 23,700 (Reversal)**: The 2 lots of short 24000 PE spike in price. However, your long 23800 PE also spikes. The maximum loss on the added leg is capped at:
  $$\text{Max Wing Loss} = \text{Strike Difference (200)} - \text{Net Credit (60)} = \mathbf{140\text{ points}}$$
  This prevents the unhedged martingale explosion associated with legacy lot addition.

---

## 4. Mode: `legacy` (Legacy Winner Lot Addition)
* **Goal**: Average down on the winning side by selling additional naked options.

```
[Entry] Short 1x 24000 CE (₹150) & 1x 24000 PE (₹145)
   │
   ▼ (Nifty spot rises from 24,000 to 24,080)
[Imbalance Triggered] Short 1x CE spikes to ₹210, PE decays to ₹80 (Diff: 61.9% > 28.3%)
   │
   ▼ (Add naked winner lot)
[Action] Sell-to-open 1x 24000 PE at ₹80 (Unhedged)
   │
   ▼
[New State] Short 1x 24000 CE (avg ₹150) & Short 2x 24000 PE (avg ₹112.50)
```

### Risk/Reward in Reversal
* **If Nifty crashes to 23,700 (Reversal)**: Your 2 lots of short 24000 PE are completely unhedged. As Nifty trends downwards, both PE options will expand rapidly to ₹300+, resulting in a large, uncapped loss that easily wipes out the premium collected on the CE side.

---

## 5. Nifty Spread Trend-Following Option Selling Strategy (`strategies/nifty_spread_trend.py`)

This strategy implements a trend-following option selling system that sells **Bear Call Spreads** or **Bull Put Spreads** on index options (e.g. NIFTY) depending on the alignment of the price relative to the **EMA 20** and the **Supertrend (7, 3)** indicators.

### Trend Definition
Signals are evaluated on the last completed candle (avoiding active bar noise and whipsaws):
*   **Bullish Trend**: `Close > EMA 20` AND `Supertrend Direction = 1` (Bullish).
    *   *Action*: Enters a **Bull Put Spread** (Sells PE, Buys lower strike PE).
*   **Bearish Trend**: `Close < EMA 20` AND `Supertrend Direction = -1` (Bearish).
    *   *Action*: Enters a **Bear Call Spread** (Sells CE, Buys higher strike CE).
*   **Neutral Trend**: Any conflicting or non-aligned indicator state. No positions are opened.

### Margin-Efficient Execution Sequence
To keep broker margins low and ensure safety:
1.  **On Entry**: Buys the Long hedge leg first, confirms execution fill, then sells the Short option.
2.  **On Exit**: Buys back the Short option first, confirms execution fill, then sells the Long hedge.

### Cooldown and Immediate Reversals
*   **Signal Reversal**: If the trend reverses (e.g. a Bull Put Spread is open and the signal shifts completely to `BEARISH`), the strategy exits the current spread and **immediately** triggers the opposite position (Bear Call Spread) on the next tick, bypassing the standard cooldown.
*   **Standard Cooldown**: For regular exits (EOD auto-exit, profit targets, or stop loss), the strategy enforces a 5-minute cool-down period before starting to scan for trend signals again.

### CLI Parameters Reference

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`--live`** | *Flag* | `False` (Dry run) | Enables live broker order placement. |
| **`--symbol`** | `str` | `NIFTY` | Underlying index to trade (e.g. `NIFTY`, `BANKNIFTY`). |
| **`--interval`** | `str` | `5` | Timeframe interval in minutes (`1`, `5`, `15`, `30`, `60`). |
| **`--ema-period`** | `int` | `20` | EMA period parameter. |
| **`--supertrend-period`** | `int` | `7` | Supertrend ATR lookback length. |
| **`--supertrend-multiplier`** | `float` | `3.0` | Supertrend ATR multiplier. |
| **`--ce-offset`** | `int` | `100` | Points above spot for the Short CE strike. |
| **`--pe-offset`** | `int` | `100` | Points below spot for the Short PE strike. |
| **`--spread-width`** | `int` | `100` | Width of the spread in points (Short strike to Long strike). |
| **`--lots`** | `int` | `1` | Number of lots per spread leg. |
| **`--target-profit`** or<br>**`--total-profit`** | `float` | `2000.0` | Global daily profit target in INR. |
| **`--stop-loss`** or<br>**`--total-loss`** | `float` | `2000.0` | Global daily stop loss in INR. Can be passed as positive or negative. |
| **`--no-exit-on-signal-change`**| *Flag* | `False` | Disables early exits on trend reversals (holds to SL/Target/EOD). |
| **`--eod-time`** | `str` | `15:15` | EOD auto-square-off time (HH:MM). |
| **`--cooldown-minutes`** | `int` | `5` | Cooldown period in minutes post standard exits. |

### Command-Line Execution Examples
```powershell
# 1. Standard dry run (Nifty, 5-minute, 1 lot)
python strategies/nifty_spread_trend.py

# 2. Custom parameters dry run (Nifty, 15-minute, wider offsets, 2 lots)
python strategies/nifty_spread_trend.py --interval 15 --ce-offset 150 --pe-offset 150 --spread-width 100 --lots 2

# 3. Bank Nifty dry run (strike step auto-detects to 100 points)
python strategies/nifty_spread_trend.py --symbol BANKNIFTY --ce-offset 200 --pe-offset 200 --spread-width 100

# 4. Live execution with daily profit target and stop loss limit
python strategies/nifty_spread_trend.py --live --lots 1 --target-profit 4000 --stop-loss 2000
```
