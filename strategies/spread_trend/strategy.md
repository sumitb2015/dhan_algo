# Nifty Spread Trend-Following Strategy

`strategies/spread_trend/nifty_spread_trend.py`

A trend-following options-selling strategy that sells Bear Call Spreads or Bull Put Spreads depending on the alignment of the Nifty price relative to the **EMA 20** and the **Supertrend (7, 3)** indicators.

---

## 1. Strategy Logic

### Trend Definition

```
Close > EMA 20  AND  Supertrend = Bullish (1)
                │
                ▼ Yes
      [BULLISH TREND SIGNAL]
    Sell Bull Put Spread (sell OTM PE, buy further OTM PE)

Close < EMA 20  AND  Supertrend = Bearish (-1)
                │
                ▼ Yes
     [BEARISH TREND SIGNAL]
    Sell Bear Call Spread (sell OTM CE, buy further OTM CE)
```

Both indicators must agree — a single indicator flip does not trigger a trade.

### Execution Sequence

**On Entry (margin safety)**
1. Buy the long hedge leg first and confirm fill.
2. Sell the short leg. This locks in the margin benefit immediately and avoids a high naked-margin window.

**On Exit**
1. Buy back the short leg first and confirm fill.
2. Sell the long hedge leg. Minimises residual directional exposure during close-out.

---

## 2. CLI Parameter Reference

| Flag | Default | Description |
|---|---|---|
| `--live` | off (dry run) | Enable real order placement |
| `--symbol SYM` | `NIFTY` | Underlying index (`NIFTY`, `BANKNIFTY`) |
| `--interval MIN` | `5` | Candle interval in minutes (`1`, `3`, `5`) |
| `--ema-period N` | `20` | EMA period used for trend filter |
| `--supertrend-period N` | `7` | Supertrend ATR period |
| `--supertrend-multiplier F` | `3.0` | Supertrend ATR multiplier |
| `--no-ema` | off | Disable the EMA filter (trade on Supertrend alone) |
| `--no-supertrend` | off | Disable the Supertrend filter (trade on EMA alone) |
| `--ce-offset PTS` | `100` | Points above spot for the short Call strike (Bear Call Spread) |
| `--pe-offset PTS` | `100` | Points below spot for the short Put strike (Bull Put Spread) |
| `--spread-width PTS` | `100` | Width of the vertical spread — points between the short and long strike |
| `--lots N` | `1` | Lots per spread leg |
| `--target-profit INR` | `2000` | Global daily profit target in ₹ |
| `--stop-loss INR` | `2000` | Global daily stop loss in ₹ |
| `--eod-time HH:MM` | `15:15` | EOD auto-square-off time (IST) |
| `--no-exit-on-signal-change` | off | Disables early exits on trend reversals; holds to SL / target / EOD instead |
| `--cooldown-minutes N` | `5` | Cooldown period in minutes after a standard exit before re-entry is permitted |
| `--min-hold-minutes N` | `5` | Minimum hold time in minutes before a signal-change exit can trigger |

---

## 3. Execution Examples

```powershell
# Dry run — Nifty, 5-min candles, 1 lot, 100-pt spread
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py

# Dry run — wider spread, 15-min candles, 2 lots
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --interval 15 --spread-width 150 --lots 2

# Dry run — Bank Nifty
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --symbol BANKNIFTY --spread-width 100

# Live — Nifty, 5-min, 1 lot, custom profit/SL targets
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --live --lots 1 --target-profit 4000 --stop-loss 2000

# Live — hold through signal reversals (no early exit)
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --live --no-exit-on-signal-change
```
