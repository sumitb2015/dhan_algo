# Nifty OI Directional Strategy

`strategies/oi_directional/nifty_oi_directional.py`

A directional options-selling strategy driven by **Open Interest imbalance** across the ±5 strikes nearest ATM. It sells a naked PE when the market is bullish or a naked CE when bearish, entering at the strike closest to a PCR threshold and exiting when that PCR unwinds by a configurable percentage.

---

## 1. Strategy Logic

### OI Signal

Every `--poll-interval` seconds (default: 60 s) the strategy fetches the option chain for the nearest expiry and reads OI across **11 strikes** — ATM ±5 × 50 points.

```
monitored_strikes = [ATM - 250, ATM - 200, ..., ATM, ..., ATM + 200, ATM + 250]

diff = sum(CE_OI across all 11 strikes)
     - sum(PE_OI across all 11 strikes)
```

Direction follows the **traditional PCR interpretation** — put writers defend support (bullish), call writers defend resistance (bearish):

```
diff < 0  AND  curr_diff < prev_diff  →  BULLISH   (PE_OI > CE_OI, expanding)
diff > 0  AND  curr_diff > prev_diff  →  BEARISH   (CE_OI > PE_OI, expanding)
otherwise                             →  NEUTRAL   (no action)
```

At least 2 snapshots are required before a direction is trusted.

### Entry

**Bullish — Sell PE:**

Scan all 11 monitored strikes for PE options where `PCR > pcr_threshold` (default 1.5).  
Select the strike whose PCR is **closest to the threshold from above** (just over 1.5, not the highest).  
This favours the nearest qualified support level rather than a deep-OTM outlier.

**Bearish — Sell CE:**

Scan for CE options where `PCR < 1 / pcr_threshold` (default 0.67).  
Select the strike whose PCR is **closest to the threshold from below** (just under 0.67).

PCR per strike = `PE_OI at that strike / CE_OI at that strike`.

Only one leg is held at a time. A new entry is not taken while a position is open.

### Exit

The exit trigger is based on the **PCR of the held strike** unwinding from the entry level:

| Position | Entry PCR example | Exit condition | Exit PCR example |
|---|---|---|---|
| PE sell (bullish) | 1.50 | PCR drops 30 % | 1.50 × 0.70 = **1.05** |
| CE sell (bearish) | 0.67 | PCR rises 30 % | 0.67 × 1.30 = **0.87** |

The exit percentage is configurable via `--exit-pcr-change`.

Additional exit conditions (always active):
- Global profit target hit (default ₹ 5 000)
- Global stop loss hit (default ₹ 5 000)
- Intraday auto-exit at **15:17 IST**
- Dashboard shutdown trigger (`debug/nifty_oi_directional_shutdown.trigger`)

---

## 2. CLI Parameter Reference

| Flag | Default | Description |
|---|---|---|
| `--live` | off (dry run) | Enable real order placement |
| `--broker BROKER` | `dhan` | Execution broker (`dhan`, `zerodha`, `kotak`). Market data remains on Dhan |
| `--lots N` | `1` | Lots per leg |
| `--start-time HH:MM` | `09:30` | Session start time IST |
| `--pcr-threshold X` | `1.5` | PCR level above which to sell PE; CE entry threshold is `1/X` |
| `--exit-pcr-change PCT` | `30` | % change in held strike's PCR from entry that triggers exit |
| `--poll-interval SECS` | `60` | Seconds between option chain fetches. Dhan receives OI directly from the exchange feed (~1 min granularity in practice) |
| `--expansion-window N` | `3` | Number of OI snapshots required before direction is trusted and entries are allowed. Time to first entry = `expansion_window × poll_interval` seconds (default: 9 min) |
| `--target-profit INR` | `5000` | Global daily profit target in ₹ |
| `--stop-loss INR` | `5000` | Global daily stop loss in ₹ (positive value) |

---

## 3. Execution Examples

```powershell
# Dry run (default)
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py

# Dry run — tighter PCR threshold (poll stays at 180s to respect NSE OI refresh cycle)
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py --pcr-threshold 2.0

# Dry run — wider exit trigger, larger expansion window
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py --exit-pcr-change 25 --expansion-window 5

# Live — 2 lots, default parameters
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py --live --lots 2

# Live — 1 lot, custom profit/SL targets
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py --live --lots 1 --target-profit 3000 --stop-loss 3000
```
