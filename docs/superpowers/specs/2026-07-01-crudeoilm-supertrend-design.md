# CrudeOil Mini Supertrend Strategy — Design Spec
**Date:** 2026-07-01  
**Status:** Approved

---

## Overview

A directional intraday futures strategy for MCX CrudeOil Mini (CRUDEOILM). It buys or sells the nearest CRUDEOILM futures contract based on the Supertrend indicator computed on configurable-interval candles. Runs in the evening session (default 17:00–23:25 IST) to capture US-crude-driven volatility. Fully integrated with the existing dashboard strategy panel.

---

## File Layout

```
strategies/
  crudeoil/
    crudeoilm_supertrend.py   # main strategy
    strategy.md               # brief logic reference
```

State file: `debug/crudeoilm_supertrend_state.json`  
Log file: `debug/logs/crudeoil/YYYYMMDD.log`  
Strategy key (for shutdown trigger): `crudeoilm_supertrend`

---

## Instrument

| Field | Value |
|---|---|
| Exchange | MCX |
| Segment | MCX_COMM |
| Instrument type | FUTCOM |
| Symbol | CRUDEOILM |
| Contract | Nearest expiry (auto-resolved via `find_future`) |
| Lot size | Auto-resolved via master list |

---

## Session

| Field | Value |
|---|---|
| Default start | 17:00 IST |
| Default EOD square-off | 23:25 IST (5 min before MCX close) |
| Configurable | Yes — `--start-time` and `--eod-time` CLI flags |

`wait_for_market_open()` is called with `start_time` and `eod_time` to block until session opens. `is_market_open()` uses the same window throughout the run.

---

## Signal Logic

### Indicator computation

On each signal check, call:

```python
helper.get_indicators_ta(
    symbol="CRUDEOILM",
    interval=self.interval,       # configurable, default "5"
    indicators=[{
        "kind": "supertrend",
        "length": self.supertrend_period,        # default 7
        "multiplier": self.supertrend_multiplier  # default 3.0
    }],
    days=3,
    exchange="MCX",
    instrument="FUTCOM"
)
```

### Signal derivation

Read the **second-to-last row** (last confirmed closed candle):

| `SUPERTd_<period>_<mult>` | Signal |
|---|---|
| `+1` | `LONG` |
| `-1` | `SHORT` |
| other / NaN | `NEUTRAL` |

Also extract the Supertrend band level (`SUPERT_<period>_<mult>` column) from the same row — used as the initial trailing SL reference.

### New-candle guard

Track `last_processed_candle_time`. Only log/act on signal changes when the candle timestamp changes, to avoid redundant churn within the same bar.

---

## Entry

1. Resolve security: `find_future("CRUDEOILM", exchange="MCX", instrument="FUTCOM")` → nearest expiry
2. Subscribe WebSocket on `MCX_COMM` for live LTP
3. Place market order: `helper.buy(security_id, qty)` or `helper.sell(security_id, qty)`
4. Wait for fill: `helper.wait_for_fill(order_id, timeout=10)`
5. Record `entry_price`, `st_level` (current Supertrend band), `direction`, `entry_time`

---

## Position Monitoring (1-second tick loop)

Refresh Supertrend level once per new candle boundary (i.e., when `datetime.now().strftime("%H:%M")` crosses a multiple of `interval` minutes) — same pattern as `_refresh_option_indicators` in spread_trend.

### Exit conditions (checked in order)

| # | Condition | Action |
|---|---|---|
| 1 | Shutdown trigger file exists | Exit position, save state `STOPPED`, sys.exit(0) |
| 2 | Current time ≥ `eod_time` | Exit — "EOD Auto-Exit" |
| 3 | `daily_pnl >= target_profit` | Exit — "Profit Target Reached" |
| 4 | `daily_pnl <= -stop_loss` | Exit — "Stop Loss Hit" |
| 5 | LONG and `ltp < st_level` | Exit — "Trailing SL Hit" |
| 5 | SHORT and `ltp > st_level` | Exit — "Trailing SL Hit" |

P&L formula:
- LONG: `(ltp - entry_price) × qty`
- SHORT: `(entry_price - ltp) × qty`

---

## Exit

1. Place opposite market order to close: `helper.sell(security_id, qty)` (LONG) or `helper.buy(security_id, qty)` (SHORT)
2. Wait for fill `timeout=10`; log critical and sys.exit(1) on failure (naked position risk)
3. Unsubscribe WebSocket
4. Reset position state

---

## Re-entry Logic

After any exit, skip re-entry until the **next 5-minute candle** closes (tracked via candle timestamp). On the next candle:
- If Supertrend still signals the same direction → enter in the same direction
- If Supertrend signals opposite direction → enter in the opposite direction
- If `NEUTRAL` → wait

This prevents re-entry on the same bar that triggered the exit.

---

## State File Schema

Written to `debug/crudeoilm_supertrend_state.json` every second while a position is open; every 10 seconds while scanning:

```json
{
  "strategy": "crudeoilm_supertrend",
  "status": "RUNNING | SCANNING | STOPPED | INITIALIZING",
  "dry_run": true,
  "symbol": "CRUDEOILM",
  "interval": "5",
  "supertrend_period": 7,
  "supertrend_multiplier": 3.0,
  "direction": "LONG | SHORT | NONE",
  "entry_price": 0.0,
  "ltp": 0.0,
  "st_level": 0.0,
  "qty": 0,
  "lots": 1,
  "daily_pnl": 0.0,
  "target_profit": 3000.0,
  "stop_loss": 3000.0,
  "start_time": "17:00",
  "eod_time": "23:25",
  "expiry": "2026-07-15",
  "last_update": "2026-07-01 17:32:10",
  "pid": 12345
}
```

---

## CLI Interface

```
python strategies/crudeoil/crudeoilm_supertrend.py [options]

Execution:
  --live                        Run in live mode (default: dry run)

Instrument:
  --lots INT                    Number of lots (default: 1)

Indicator:
  --interval STR                Candle interval in minutes: 1, 3, 5, 15 (default: 5)
  --supertrend-period INT        ATR period for Supertrend (default: 7)
  --supertrend-multiplier FLOAT  Multiplier for Supertrend (default: 3.0)

Risk management:
  --target-profit FLOAT         Daily profit cap in INR (default: 3000)
  --stop-loss FLOAT             Daily loss cap in INR (default: 3000)

Session:
  --start-time STR              Session start HH:MM (default: 17:00)
  --eod-time STR                EOD square-off HH:MM (default: 23:25)

Re-entry:
  --cooldown-candles INT        Candles to skip before re-entry after exit (default: 1)
```

---

## Dashboard Integration

### Backend — `app/api/strategies/route.ts`

Add `crudeoilm_supertrend` to the strategy registry:

```ts
{
  key: "crudeoilm_supertrend",
  displayName: "CrudeOil Mini Supertrend",
  script: "strategies/crudeoil/crudeoilm_supertrend.py",
  params: [
    { flag: "--lots",                  type: "int",    default: 1 },
    { flag: "--interval",              type: "select", options: ["1","3","5","15"], default: "5" },
    { flag: "--supertrend-period",     type: "int",    default: 7 },
    { flag: "--supertrend-multiplier", type: "float",  default: 3.0 },
    { flag: "--target-profit",         type: "float",  default: 3000 },
    { flag: "--stop-loss",             type: "float",  default: 3000 },
  ]
}
```

### Frontend — Strategy card

The CrudeOil Mini card displays:

- **Header**: "CrudeOil Mini Supertrend" + status badge (RUNNING / SCANNING / STOPPED)
- **Config inputs** (editable before Start): Lots, Interval (dropdown), ST Period, ST Multiplier, Target Profit, Stop Loss
- **Live fields** (shown while running): Direction (LONG/SHORT/NONE), Entry Price, LTP, ST Level, Daily P&L (green/red)
- **Controls**: Start (dry run / live toggle) + Stop button

The Stop button writes `debug/crudeoilm_supertrend_shutdown.trigger` via the existing `/api/strategies` DELETE/POST mechanism — no new API route needed.

---

## Error Handling

- Fill timeout on entry → cancel order, abort entry, log error, retry on next candle
- Fill timeout on exit → sys.exit(1) (naked position risk — same policy as spread_trend)
- WebSocket disconnect → DhanHelper auto-reconnects; strategy continues via REST LTP fallback
- `find_future` returns None → log error, sleep 60s, retry
- Market data gap (ltp = 0) → skip exit check for that tick, log warning

---

## Not In Scope

- Multiple simultaneous positions
- Pyramiding / adding to winners
- Options on crude
- Backtesting
- EMA or volume filter (can be added later as CLI flags)
