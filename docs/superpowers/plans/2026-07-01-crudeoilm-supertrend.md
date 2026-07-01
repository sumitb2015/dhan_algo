# CrudeOil Mini Supertrend Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a directional MCX CRUDEOILM futures strategy driven by the Supertrend indicator, running in the 17:00–23:25 evening session, fully integrated with the existing Next.js strategy dashboard.

**Architecture:** A class-based Python strategy (`CrudeOilMSupertrendStrategy`) in `strategies/crudeoil/crudeoilm_supertrend.py` follows the exact lifecycle pattern of `nifty_spread_trend.py` — `get_signal()` → `enter_position()` → `monitor_position()` → `_exit_position()` — writing state to `debug/crudeoilm_supertrend_state.json` each tick. The Next.js dashboard reads this state file and adds a strategy card with editable Interval, Supertrend Period, Supertrend Multiplier, Lots, Target and Stop Loss fields.

**Tech Stack:** Python 3.x, dhanhq SDK, pandas_ta (Supertrend), Next.js App Router, TypeScript, Tailwind CSS

## Global Constraints

- All Python commands run from project root `c:\dhan_algo\dhan_algo` using `venv\Scripts\python.exe`
- Strategy key: `crudeoilm_supertrend` (used for state file, shutdown trigger file, and API route)
- State file: `debug/crudeoilm_supertrend_state.json`
- Shutdown trigger: `debug/crudeoilm_supertrend_shutdown.trigger`
- Log file: `debug/logs/crudeoil/YYYYMMDD.log`
- `sys.path.insert(0, ...)` must point two levels up to project root (same as other strategies in `strategies/<subdir>/`)
- MCX segment constant: `"MCX_COMM"`, instrument: `"FUTCOM"`, exchange: `"MCX"`
- `is_market_open()` and `wait_for_market_open()` accept `start_time` and `eod_time` kwargs — use `start_time="17:00"`, `eod_time="23:25"` throughout
- Default dry run — `--live` flag required for real orders
- Fill timeout on exit → `sys.exit(1)` (naked position risk, same policy as `nifty_spread_trend.py`)
- Dashboard: `text-xs font-bold text-white` on table headers; no Tailwind slash-opacity on text; solid zinc colors only

---

## File Map

| Action | Path |
|--------|------|
| Create | `strategies/crudeoil/__init__.py` |
| Create | `strategies/crudeoil/crudeoilm_supertrend.py` |
| Create | `strategies/crudeoil/strategy.md` |
| Modify | `rs_dashboard/app/api/strategies/route.ts` |
| Modify | `rs_dashboard/components/StrategyCard.tsx` |

---

## Task 1: Python Strategy

**Files:**
- Create: `strategies/crudeoil/__init__.py`
- Create: `strategies/crudeoil/crudeoilm_supertrend.py`
- Create: `strategies/crudeoil/strategy.md`

**Interfaces:**
- Produces: `debug/crudeoilm_supertrend_state.json` with keys: `strategy`, `status`, `dry_run`, `symbol`, `interval`, `supertrend_period`, `supertrend_multiplier`, `direction`, `entry_price`, `ltp`, `st_level`, `qty`, `lots`, `daily_pnl`, `target_profit`, `stop_loss`, `start_time`, `eod_time`, `expiry`, `last_update`, `pid`
- Produces: `debug/logs/crudeoil/YYYYMMDD.log`
- Consumes: `lib/dhan_helper.py` — `find_future`, `get_indicators_ta`, `get_ltp`, `start_websocket`, `unsubscribe_instruments`, `buy`, `sell`, `wait_for_fill`, `get_order_by_id`, `cancel_order`, `wait_for_market_open`, `is_market_open`
- Consumes: `lib/strategy_state_helper.py` — `save_strategy_state`, `check_shutdown_trigger`

- [ ] **Step 1: Create the package init file**

```python
# strategies/crudeoil/__init__.py
```
File is intentionally empty — only needed to make the directory a Python package.

- [ ] **Step 2: Create the strategy file**

Create `strategies/crudeoil/crudeoilm_supertrend.py` with the full content below:

```python
"""
CrudeOil Mini Supertrend Strategy
MCX CRUDEOILM futures — directional long/short based on Supertrend indicator.
Evening session default: 17:00-23:25 IST (US crude volatility window).
"""
import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime
from typing import Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "crudeoil")
os.makedirs(log_dir, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}.log")),
    ],
    force=True,
)
logger = logging.getLogger(__name__)

STRATEGY_KEY = "crudeoilm_supertrend"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"
INSTRUMENT = "FUTCOM"
SEGMENT = "MCX_COMM"


class CrudeOilMSupertrendStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        interval: str = "5",
        supertrend_period: int = 7,
        supertrend_multiplier: float = 3.0,
        target_profit: float = 3000.0,
        stop_loss: float = 3000.0,
        start_time: str = "17:00",
        eod_time: str = "23:25",
        cooldown_candles: int = 1,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.interval = interval
        self.supertrend_period = supertrend_period
        self.supertrend_multiplier = float(supertrend_multiplier)
        self.target_profit = target_profit
        self.stop_loss = abs(stop_loss)
        self.start_time = start_time
        self.eod_time = eod_time
        self.cooldown_candles = cooldown_candles

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise RuntimeError("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

        # Resolved at entry time
        self.security_id: Optional[str] = None
        self.expiry: Optional[str] = None
        self.lot_size: int = 10  # default MCX crude mini lot size
        self.qty: int = 0

        # Position state
        self.direction: str = "NONE"
        self.entry_price: float = 0.0
        self.st_level: float = 0.0
        self.entry_time: Optional[datetime] = None

        # Live stats
        self.ltp: float = 0.0
        self.position_pnl: float = 0.0  # unrealized P&L of current open position
        self.cumulative_pnl: float = 0.0  # sum of all closed position P&Ls today

        # Re-entry guard: candle timestamp of the bar on which we last exited
        self.exit_candle_time: Optional[str] = None
        self.last_processed_candle_time: Optional[str] = None

    # ── SIGNAL ──────────────────────────────────────────────────────────────

    def get_signal(self) -> Tuple[str, float, float]:
        """
        Returns (signal, close, st_level).
        signal: "LONG" | "SHORT" | "NEUTRAL"
        Uses second-to-last candle (last confirmed closed bar).
        """
        try:
            indicators = [{
                "kind": "supertrend",
                "length": self.supertrend_period,
                "multiplier": self.supertrend_multiplier,
            }]
            df = self.helper.get_indicators_ta(
                symbol=SYMBOL,
                interval=self.interval,
                indicators=indicators,
                days=3,
            )
            if df.empty or len(df) < 2:
                logger.warning("Insufficient candle data for Supertrend computation.")
                return "NEUTRAL", 0.0, 0.0

            row = df.iloc[-2]
            close = float(row["Close"])

            # Direction column: SUPERTd_<period>_<mult>
            dir_cols = [c for c in df.columns if c.startswith("SUPERTd_")]
            if not dir_cols:
                logger.error("Supertrend direction column missing. Available: %s", df.columns.tolist())
                return "NEUTRAL", close, 0.0
            st_dir = float(row[dir_cols[0]])

            # Level column: SUPERT_<period>_<mult> (exclude SUPERTd_, SUPERTl_, SUPERTs_)
            level_cols = [
                c for c in df.columns
                if c.startswith("SUPERT_") and not any(c.startswith(p) for p in ("SUPERTd_", "SUPERTl_", "SUPERTs_"))
            ]
            st_val = float(row[level_cols[0]]) if level_cols and not pd.isna(row[level_cols[0]]) else 0.0

            # Log on each new candle
            candle_ts = str(df.index[-2] if not isinstance(df.index[-2], str) else df.index[-2])
            if candle_ts != self.last_processed_candle_time:
                logger.info("[SIGNAL] Candle: %s | Close: %.2f | STd: %.1f | ST_level: %.2f",
                            candle_ts, close, st_dir, st_val)
                self.last_processed_candle_time = candle_ts

            if st_dir == 1.0:
                return "LONG", close, st_val
            elif st_dir == -1.0:
                return "SHORT", close, st_val
            return "NEUTRAL", close, st_val

        except Exception as e:
            logger.error("Error in get_signal: %s", e)
            return "NEUTRAL", 0.0, 0.0

    def _refresh_st_level(self) -> None:
        """Pull latest Supertrend band level and update self.st_level."""
        _, _, new_st = self.get_signal()
        if new_st > 0:
            old = self.st_level
            self.st_level = new_st
            if abs(new_st - old) > 0.01:
                logger.info("ST level updated: %.2f → %.2f", old, new_st)

    # ── ENTRY ────────────────────────────────────────────────────────────────

    def enter_position(self, direction: str, initial_st_level: float) -> bool:
        """Resolve contract, subscribe WebSocket, place market order. Returns True on success."""
        if check_shutdown_trigger(STRATEGY_KEY):
            return False

        sec = self.helper.find_future(SYMBOL, exchange=EXCHANGE, instrument=INSTRUMENT)
        if not sec:
            logger.error("Could not resolve CRUDEOILM future from master list.")
            return False

        self.security_id = str(sec["SECURITY_ID"])
        self.expiry = str(sec.get("SM_EXPIRY_DATE", ""))
        try:
            self.lot_size = int(sec.get("LOT_SIZE", 10))
        except (TypeError, ValueError):
            self.lot_size = 10
        self.qty = self.lot_size * self.lots

        logger.info("Resolved CRUDEOILM: ID=%s | Expiry=%s | LotSize=%d | Qty=%d",
                    self.security_id, self.expiry, self.lot_size, self.qty)

        try:
            self.helper.start_websocket([(SEGMENT, self.security_id, 15)])
            time.sleep(2)
        except Exception as ws_err:
            logger.warning("WebSocket subscribe failed (%s) — will use REST LTP fallback.", ws_err)

        if not self.dry_run:
            order_id = self.helper.buy(self.security_id, self.qty) if direction == "LONG" \
                       else self.helper.sell(self.security_id, self.qty)

            if not order_id:
                logger.error("Failed to place %s order. Aborting entry.", direction)
                return False

            if not self.helper.wait_for_fill(order_id, timeout=10):
                logger.error("Order %s not filled within timeout. Cancelling.", order_id)
                try:
                    self.helper.cancel_order(order_id)
                except Exception as e:
                    logger.error("Cancel failed: %s", e)
                return False

            details = self.helper.get_order_by_id(order_id)
            fill_price = 0.0
            if details:
                fill_price = float(
                    details.get("averageTradedPrice", 0.0) or
                    details.get("avgFilledPrice", 0.0) or
                    details.get("price", 0.0)
                )
            self.entry_price = fill_price if fill_price > 0 else \
                self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
        else:
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            self.entry_price = ltp if ltp > 0 else 5000.0  # fallback for after-hours dry run
            logger.info("[DRY RUN] Simulating %s entry @ %.2f", direction, self.entry_price)

        self.direction = direction
        # Use initial ST level; if zero (e.g. after-hours), approximate from price
        if initial_st_level > 0:
            self.st_level = initial_st_level
        else:
            self.st_level = self.entry_price * (0.98 if direction == "LONG" else 1.02)
        self.entry_time = datetime.now()
        logger.info("Entered %s @ %.2f | Initial ST_SL: %.2f", direction, self.entry_price, self.st_level)
        return True

    # ── MONITOR ─────────────────────────────────────────────────────────────

    def monitor_position(self) -> None:
        """1-second tick loop. Exits on trailing SL, P&L cap, EOD, or shutdown."""
        last_log_time = 0.0
        last_indicator_candle = ""
        interval_min = int(self.interval)

        while self.direction != "NONE":
            time.sleep(1)

            # Refresh ST level on each new candle boundary
            now = datetime.now()
            candle_mark = f"{now.strftime('%Y-%m-%d %H:')}{ (now.minute // interval_min) * interval_min:02d}"
            if candle_mark != last_indicator_candle:
                self._refresh_st_level()
                last_indicator_candle = candle_mark

            # 1. Shutdown trigger
            if check_shutdown_trigger(STRATEGY_KEY):
                self._exit_position("UI Shutdown Request")
                self.save_state(status="STOPPED")
                sys.exit(0)

            # 2. EOD
            if now.strftime("%H:%M") >= self.eod_time:
                self._exit_position("EOD Auto-Exit")
                break

            # Fetch LTP
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            if ltp <= 0:
                continue
            self.ltp = ltp

            # Unrealized P&L for current position
            if self.direction == "LONG":
                self.position_pnl = (ltp - self.entry_price) * self.qty
            else:
                self.position_pnl = (self.entry_price - ltp) * self.qty

            self.save_state()

            if time.time() - last_log_time >= 30:
                logger.info("[MONITOR] %s | Entry: %.2f | LTP: %.2f | ST_SL: %.2f | Pos P&L: ₹%.2f | Day P&L: ₹%.2f",
                            self.direction, self.entry_price, ltp, self.st_level,
                            self.position_pnl, self.cumulative_pnl + self.position_pnl)
                last_log_time = time.time()

            total_day_pnl = self.cumulative_pnl + self.position_pnl

            # 3. Daily profit target
            if total_day_pnl >= self.target_profit:
                self._exit_position(f"Daily Profit Target Reached: ₹{total_day_pnl:.2f}")
                self.cumulative_pnl += self.position_pnl
                self.position_pnl = 0.0
                break

            # 4. Daily stop loss
            if total_day_pnl <= -self.stop_loss:
                self._exit_position(f"Daily Stop Loss Hit: ₹{total_day_pnl:.2f}")
                self.cumulative_pnl += self.position_pnl
                self.position_pnl = 0.0
                break

            # 5. Trailing SL
            if self.direction == "LONG" and ltp < self.st_level:
                self._exit_position(f"Trailing SL: LTP {ltp:.2f} < ST {self.st_level:.2f}")
                self.cumulative_pnl += self.position_pnl
                self.position_pnl = 0.0
                break
            if self.direction == "SHORT" and ltp > self.st_level:
                self._exit_position(f"Trailing SL: LTP {ltp:.2f} > ST {self.st_level:.2f}")
                self.cumulative_pnl += self.position_pnl
                self.position_pnl = 0.0
                break

    # ── EXIT ─────────────────────────────────────────────────────────────────

    def _exit_position(self, reason: str) -> None:
        """Close the futures position. sys.exit(1) on fill failure (naked position risk)."""
        logger.warning("!!! EXITING: %s !!!", reason)

        if not self.dry_run:
            order_id = self.helper.sell(self.security_id, self.qty) if self.direction == "LONG" \
                       else self.helper.buy(self.security_id, self.qty)

            if not order_id:
                logger.critical("CRITICAL: Close order placement failed. Naked position. HALTING.")
                sys.exit(1)

            if not self.helper.wait_for_fill(order_id, timeout=10):
                details = self.helper.get_order_by_id(order_id)
                if not (details and details.get("orderStatus") == "TRADED"):
                    logger.critical("CRITICAL: Close order %s did not fill. Naked position. HALTING.", order_id)
                    sys.exit(1)
            logger.info("Close order filled.")
        else:
            logger.info("[DRY RUN] Simulating exit of %s position.", self.direction)

        # Unsubscribe WebSocket
        if self.security_id:
            try:
                self.helper.unsubscribe_instruments([(SEGMENT, self.security_id, 15)])
            except Exception as e:
                logger.warning("WebSocket unsubscribe error: %s", e)

        # Record exit candle (re-entry guard)
        self.exit_candle_time = self.last_processed_candle_time

        # Reset state
        self.direction = "NONE"
        self.entry_price = 0.0
        self.st_level = 0.0
        self.entry_time = None
        self.security_id = None
        self.expiry = None

    # ── STATE ────────────────────────────────────────────────────────────────

    def save_state(self, status: str = "RUNNING") -> None:
        save_strategy_state(STRATEGY_KEY, {
            "strategy": STRATEGY_KEY,
            "status": status,
            "dry_run": self.dry_run,
            "symbol": SYMBOL,
            "interval": self.interval,
            "supertrend_period": self.supertrend_period,
            "supertrend_multiplier": self.supertrend_multiplier,
            "direction": self.direction,
            "entry_price": round(self.entry_price, 2),
            "ltp": round(self.ltp, 2),
            "st_level": round(self.st_level, 2),
            "qty": self.qty,
            "lots": self.lots,
            "daily_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "target_profit": self.target_profit,
            "stop_loss": self.stop_loss,
            "start_time": self.start_time,
            "eod_time": self.eod_time,
            "expiry": self.expiry or "",
        })

    # ── RUN ──────────────────────────────────────────────────────────────────

    def run(self) -> None:
        logger.info("=" * 60)
        logger.info("CRUDEOIL MINI SUPERTREND STRATEGY — %s MODE", "LIVE" if not self.dry_run else "DRY RUN")
        logger.info("Interval: %sm | ST(%d, %.1f) | Session: %s–%s | Lots: %d",
                    self.interval, self.supertrend_period, self.supertrend_multiplier,
                    self.start_time, self.eod_time, self.lots)
        logger.info("=" * 60)
        self.save_state(status="INITIALIZING")

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger detected in outer loop.")
                self.save_state(status="STOPPED")
                sys.exit(0)

            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.eod_time:
                logger.info("Past EOD time (%s). Strategy complete.", self.eod_time)
                self.save_state(status="STOPPED")
                break

            # Wait for session to open
            self.helper.wait_for_market_open(
                self.dry_run,
                start_time=self.start_time,
                eod_time=self.eod_time,
                shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY),
            )

            # Daily P&L cap check (before scanning for new entry)
            day_pnl = self.cumulative_pnl
            if day_pnl >= self.target_profit:
                logger.info("Daily profit target reached (₹%.2f). Stopping.", day_pnl)
                self.save_state(status="STOPPED")
                break
            if day_pnl <= -self.stop_loss:
                logger.info("Daily loss limit reached (₹%.2f). Stopping.", day_pnl)
                self.save_state(status="STOPPED")
                break

            self.save_state(status="SCANNING")
            signal, _, initial_st = self.get_signal()

            # Re-entry candle guard: skip if still on the same candle as last exit
            if (self.exit_candle_time is not None
                    and self.last_processed_candle_time == self.exit_candle_time):
                logger.info("Re-entry guard: same candle as exit (%s). Waiting.", self.exit_candle_time)
                time.sleep(15)
                continue

            if signal in ("LONG", "SHORT"):
                logger.info("Signal: %s | ST level: %.2f — entering position.", signal, initial_st)
                success = self.enter_position(signal, initial_st)
                if not success:
                    logger.warning("Entry failed. Retrying in 30s.")
                    time.sleep(30)
                    continue
                self.monitor_position()
            else:
                logger.info("Signal: NEUTRAL. Waiting for Supertrend confirmation...")
                time.sleep(20 if self.dry_run else 30)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="CrudeOil Mini (CRUDEOILM) MCX Supertrend Futures Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run, default settings (evening session, 5m ST(7,3.0))
  python strategies/crudeoil/crudeoilm_supertrend.py

  # Live, 2 lots, 15m timeframe, custom ST params
  python strategies/crudeoil/crudeoilm_supertrend.py --live --lots 2 --interval 15 --supertrend-period 10 --supertrend-multiplier 2.5

  # Full morning session override (for testing)
  python strategies/crudeoil/crudeoilm_supertrend.py --start-time 09:00 --eod-time 23:25
""",
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")
    parser.add_argument("--lots", type=int, default=1,
                        help="Number of lots to trade (default: 1)")
    parser.add_argument("--interval", type=str, default="5",
                        help="Candle interval in minutes: 1, 3, 5, 15 (default: 5)")
    parser.add_argument("--supertrend-period", type=int, default=7,
                        help="Supertrend ATR period (default: 7)")
    parser.add_argument("--supertrend-multiplier", type=float, default=3.0,
                        help="Supertrend multiplier (default: 3.0)")
    parser.add_argument("--target-profit", type=float, default=3000.0,
                        help="Daily profit cap in INR (default: 3000)")
    parser.add_argument("--stop-loss", type=float, default=3000.0,
                        help="Daily loss cap in INR (default: 3000)")
    parser.add_argument("--start-time", type=str, default="17:00",
                        help="Session start HH:MM (default: 17:00)")
    parser.add_argument("--eod-time", type=str, default="23:25",
                        help="EOD square-off HH:MM (default: 23:25)")
    parser.add_argument("--cooldown-candles", type=int, default=1,
                        help="Candles to skip before re-entry after exit (default: 1)")

    args = parser.parse_args()

    strat = CrudeOilMSupertrendStrategy(
        dry_run=not args.live,
        lots=args.lots,
        interval=args.interval,
        supertrend_period=args.supertrend_period,
        supertrend_multiplier=args.supertrend_multiplier,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
        start_time=args.start_time,
        eod_time=args.eod_time,
        cooldown_candles=args.cooldown_candles,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt. Exiting cleanly.")
        if strat.direction != "NONE":
            strat._exit_position("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
```

- [ ] **Step 3: Create the strategy logic doc**

Create `strategies/crudeoil/strategy.md`:

```markdown
# CrudeOil Mini Supertrend Strategy

## Overview
Directional MCX CRUDEOILM futures strategy. Buys or sells the nearest futures contract
when Supertrend confirms a trend direction. Trails stop via the Supertrend band level.

## Session
Default: 17:00–23:25 IST (US crude volatility window). Configurable via `--start-time` / `--eod-time`.

## Signal
- Uses pandas_ta Supertrend on configurable-interval candles (default 5m)
- Entry on confirmed closed candle (second-to-last row): STd=+1 → LONG, STd=-1 → SHORT
- ST band level becomes the initial trailing stop

## Exit Conditions (priority order)
1. UI shutdown trigger file
2. EOD time reached
3. Daily profit target hit (cumulative across positions)
4. Daily stop loss hit (cumulative across positions)
5. Trailing SL: LTP crosses Supertrend band (refreshed each new candle)

## Re-entry
After any exit, waits for one full new candle before re-evaluating signal.

## Key CLI Flags
```
--live                        Real orders (default: dry run)
--lots INT                    Position size (default: 1)
--interval STR                1/3/5/15 minutes (default: 5)
--supertrend-period INT        ATR period (default: 7)
--supertrend-multiplier FLOAT  Multiplier (default: 3.0)
--target-profit FLOAT         Daily profit cap INR (default: 3000)
--stop-loss FLOAT             Daily loss cap INR (default: 3000)
--start-time STR              Session start HH:MM (default: 17:00)
--eod-time STR                EOD HH:MM (default: 23:25)
```
```

- [ ] **Step 4: Smoke-test the strategy import and argument parsing**

Run:
```powershell
venv\Scripts\python.exe strategies/crudeoil/crudeoilm_supertrend.py --help
```

Expected output: argparse help text showing all flags with defaults, no import errors, no tracebacks.

- [ ] **Step 5: Dry-run startup test**

Run (will block waiting for 17:00 session unless already in window):
```powershell
venv\Scripts\python.exe strategies/crudeoil/crudeoilm_supertrend.py --start-time 00:00 --eod-time 23:59 2>&1 | head -20
```

Expected: Strategy prints the startup banner and "INITIALIZING" or "SCANNING" log lines. Confirm `debug/crudeoilm_supertrend_state.json` is created with correct schema. Interrupt with Ctrl+C after 5 seconds.

```powershell
# Verify state file exists and has correct keys
venv\Scripts\python.exe -c "import json; d=json.load(open('debug/crudeoilm_supertrend_state.json')); print(list(d.keys()))"
```

Expected: `['strategy', 'status', 'dry_run', 'symbol', 'interval', 'supertrend_period', 'supertrend_multiplier', 'direction', 'entry_price', 'ltp', 'st_level', 'qty', 'lots', 'daily_pnl', 'target_profit', 'stop_loss', 'start_time', 'eod_time', 'expiry', 'last_update', 'pid']`

- [ ] **Step 6: Commit**

```bash
git add strategies/crudeoil/__init__.py strategies/crudeoil/crudeoilm_supertrend.py strategies/crudeoil/strategy.md debug/crudeoilm_supertrend_state.json
git commit -m "feat(crudeoil): add CrudeOilM Supertrend futures strategy"
```

---

## Task 2: API Route — Register Strategy

**Files:**
- Modify: `rs_dashboard/app/api/strategies/route.ts:11-40`

**Interfaces:**
- Consumes: `strategies/crudeoil/crudeoilm_supertrend.py` (script path)
- Produces: `GET /api/strategies` response now includes `crudeoilm_supertrend` key
- Produces: `POST /api/strategies` with `{ action: "start", strategy: "crudeoilm_supertrend", args: [...] }` spawns the strategy

- [ ] **Step 1: Add the strategy entry to STRATEGIES_METADATA**

In `rs_dashboard/app/api/strategies/route.ts`, find the closing brace of `STRATEGIES_METADATA` (after the `nifty_oi_directional` entry at line ~39) and add the new entry:

```typescript
// Before (line ~32-39):
  nifty_spread_trend: {
    name: 'Nifty Spread Trend-Following',
    path: path.join(PROJECT_ROOT, 'strategies', 'spread_trend', 'nifty_spread_trend.py')
  },
  nifty_oi_directional: {
    name: 'Nifty OI Directional',
    path: path.join(PROJECT_ROOT, 'strategies', 'oi_directional', 'nifty_oi_directional.py')
  },
};

// After:
  nifty_spread_trend: {
    name: 'Nifty Spread Trend-Following',
    path: path.join(PROJECT_ROOT, 'strategies', 'spread_trend', 'nifty_spread_trend.py')
  },
  nifty_oi_directional: {
    name: 'Nifty OI Directional',
    path: path.join(PROJECT_ROOT, 'strategies', 'oi_directional', 'nifty_oi_directional.py')
  },
  crudeoilm_supertrend: {
    name: 'CrudeOil Mini Supertrend',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_supertrend.py')
  },
};
```

- [ ] **Step 2: Verify the API returns the new strategy**

With the dashboard dev server running (`cd rs_dashboard && npm run dev`):

```powershell
curl http://localhost:3000/api/strategies
```

Expected: JSON response with `success: true` and `strategies.crudeoilm_supertrend` present in the object with `meta.name === 'CrudeOil Mini Supertrend'` and `state.status === 'STOPPED'` (or the contents of the state file if it exists from Task 1's smoke test).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/strategies/route.ts
git commit -m "feat(dashboard): register crudeoilm_supertrend in strategies API"
```

---

## Task 3: Dashboard UI — StrategyCard

**Files:**
- Modify: `rs_dashboard/components/StrategyCard.tsx`

**Interfaces:**
- Consumes: `GET /api/strategies` — `state.direction`, `state.entry_price`, `state.ltp`, `state.st_level`, `state.daily_pnl`, `state.interval`, `state.supertrend_period`, `state.supertrend_multiplier`, `state.expiry`
- Produces: `POST /api/strategies` with args `['--lots', '1', '--interval', '5', '--supertrend-period', '7', '--supertrend-multiplier', '3.0', '--target-profit', '3000', '--stop-loss', '3000']` (plus `--live` if checked)

- [ ] **Step 1: Add StrategyState interface fields**

In `rs_dashboard/components/StrategyCard.tsx`, find the `StrategyState` interface (around line 15) and add the missing CrudeOil fields after the existing `// Spread Trend` comment block:

```typescript
  // CrudeOil Mini Supertrend
  entry_price?: number;
  st_level?: number;
  daily_pnl?: number;
  expiry?: string;
```

Note: `direction`, `ltp`, `interval` fields already exist in the interface — do not duplicate them.

- [ ] **Step 2: Add CrudeOil state variables**

In `StrategyCard`, find the `// Spread Trend` state block (around line 128) and add CrudeOil-specific state after it:

```typescript
  // CrudeOil Mini Supertrend
  const [crudeoilInterval, setCrudeoilInterval] = useState<string>('5');
  const [crudeoilStPeriod, setCrudeoilStPeriod] = useState<number>(7);
  const [crudeoilStMultiplier, setCrudeoilStMultiplier] = useState<number>(3.0);
  const [crudeoilEodTime, setCrudeoilEodTime] = useState<string>('23:25');
  const [crudeoilStartTime, setCrudeoilStartTime] = useState<string>('17:00');
```

- [ ] **Step 3: Add handleStart args for CrudeOil**

In `handleStart`, find the last `else if` block for `nifty_spread_trend` (around line 210) and add a new `else if` block immediately after it, before the closing `}` of the strategy-specific args section:

```typescript
      } else if (meta.key === 'crudeoilm_supertrend') {
        args.push('--interval', crudeoilInterval);
        args.push('--supertrend-period', String(crudeoilStPeriod));
        args.push('--supertrend-multiplier', String(crudeoilStMultiplier));
        args.push('--start-time', crudeoilStartTime);
        args.push('--eod-time', crudeoilEodTime);
      }
```

- [ ] **Step 4: Add CrudeOil config panel block**

In `configPanel`, find the closing `</div>` of the OI Directional-specific block (around line 510) and add the CrudeOil block after it:

```typescript
        {/* CrudeOil Mini Supertrend-specific */}
        {meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Timeframe</label>
              <Select value={crudeoilInterval} onValueChange={(v) => v && setCrudeoilInterval(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <label className={lbl}>ST Period</label>
              <Input
                type="number"
                value={crudeoilStPeriod}
                onChange={(e) => setCrudeoilStPeriod(parseInt(e.target.value) || 7)}
                min={2}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>ST Multiplier</label>
              <Input
                type="number"
                step="0.5"
                value={crudeoilStMultiplier}
                onChange={(e) => setCrudeoilStMultiplier(parseFloat(e.target.value) || 3.0)}
                min={0.5}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Start Time</label>
              <Input
                type="text"
                value={crudeoilStartTime}
                onChange={(e) => setCrudeoilStartTime(e.target.value)}
                placeholder="17:00"
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>EOD Time</label>
              <Input
                type="text"
                value={crudeoilEodTime}
                onChange={(e) => setCrudeoilEodTime(e.target.value)}
                placeholder="23:25"
                className={inputCls}
              />
            </div>
          </>
        )}
```

- [ ] **Step 5: Add CrudeOil running stats**

In the running stats strip, find the `{meta.key === 'nifty_oi_directional' ? (` ternary (around line 715). This ternary currently has two arms: OI Directional and everything else. Replace the outer ternary with a three-way if-else pattern:

Find this block (approximately lines 715–849):
```typescript
              {meta.key === 'nifty_oi_directional' ? (
                <>
                  {/* ... OI directional stats ... */}
                </>
              ) : (
                <>
                  {/* ... default stats ... */}
                </>
              )}
```

Replace with:
```typescript
              {meta.key === 'nifty_oi_directional' ? (
                <>
                  {state.spot != null && (
                    <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                      <span className={lbl}>Spot</span>
                      <span className="font-mono font-bold text-zinc-200">{state.spot.toFixed(1)}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Direction</span>
                    <span className={`font-mono font-bold ${state.direction === 'BULLISH' ? 'text-emerald-400' : state.direction === 'BEARISH' ? 'text-rose-400' : 'text-zinc-500'}`}>
                      {state.direction || '—'}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">diff {state.oi_diff != null ? (state.oi_diff > 0 ? '+' : '') + state.oi_diff.toFixed(0) : '—'}</span>
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[100px]">
                    <span className={lbl}>Position</span>
                    {state.in_position && state.sold_strike ? (
                      <>
                        <span className={`font-mono font-bold ${state.position_type === 'PE_SELL' ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {state.sold_strike} {state.position_type?.replace('_SELL', '') ?? ''}
                        </span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          avg ₹{state.avg_price?.toFixed(1) ?? '—'} · ltp ₹{state.current_ltp?.toFixed(1) ?? '—'}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-zinc-600">FLAT</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>PCR</span>
                    <span className="font-mono font-bold text-zinc-300">
                      {state.entry_pcr ? state.entry_pcr.toFixed(3) : '—'}
                    </span>
                    {state.exit_pcr_level ? (
                      <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                        exit @{state.exit_pcr_level.toFixed(3)}
                      </span>
                    ) : null}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
                    </span>
                    {state.realized_pnl !== undefined && state.realized_pnl !== 0 && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">real ₹{state.realized_pnl.toFixed(0)}</span>
                    )}
                  </div>
                </>
              ) : meta.key === 'crudeoilm_supertrend' ? (
                <>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Direction</span>
                    <span className={`font-mono font-bold ${
                      state.direction === 'LONG' ? 'text-emerald-400' :
                      state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'
                    }`}>
                      {state.direction || 'NONE'}
                    </span>
                    {state.expiry && (
                      <span className="text-[10px] text-zinc-500 font-mono">{state.expiry}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[110px]">
                    <span className={lbl}>Entry / LTP</span>
                    {state.direction && state.direction !== 'NONE' ? (
                      <>
                        <span className="font-mono font-bold text-zinc-200">
                          {state.ltp != null ? state.ltp.toFixed(2) : '—'}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono whitespace-nowrap">
                          avg ₹{state.entry_price?.toFixed(2) ?? '—'}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-zinc-600">—</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>ST SL</span>
                    <span className="font-mono font-bold text-amber-400">
                      {state.st_level != null && state.st_level > 0 ? state.st_level.toFixed(2) : '—'}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">
                      {state.interval ? `${state.interval}m ST(${state.supertrend_period ?? 7},${state.supertrend_multiplier ?? 3})` : ''}
                    </span>
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Day P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${(state.daily_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {(state.daily_pnl ?? 0) >= 0 ? '+' : ''}₹{(state.daily_pnl ?? 0).toFixed(0)}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                      tgt ₹{state.target_profit?.toFixed(0) ?? '—'} · sl ₹{state.stop_loss?.toFixed(0) ?? '—'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {meta.key !== 'nifty_spread_trend' && state.spot && (
                    <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                      <span className={lbl}>Spot</span>
                      <span className="font-mono font-bold text-zinc-200">{state.spot.toFixed(1)}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[90px]">
                    {meta.key === 'nifty_spread_trend' ? (
                      <>
                        <span className={lbl}>Spread</span>
                        <span className="font-mono font-bold text-sky-400">{state.active_spread || '—'}</span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          S:{state.short_strike || '-'} · L:{state.long_strike || '-'}
                        </span>
                        <div className="flex gap-1 mt-0.5">
                          {(state.use_ema !== false) && (
                            <span className="text-[9px] font-bold px-1 rounded bg-indigo-500/15 text-indigo-400">EMA</span>
                          )}
                          {(state.use_supertrend !== false) && (
                            <span className="text-[9px] font-bold px-1 rounded bg-violet-500/15 text-violet-400">ST</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={lbl}>CE Strike</span>
                        <div className="flex items-center gap-1">
                          <span className="font-mono font-bold text-emerald-400">{state.ce_strike || '—'}</span>
                          {state.mode === 'reentry_straddle' && state.ce_active != null && (
                            <span className={`text-[9px] font-bold px-1 rounded ${state.ce_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                              {state.ce_active ? 'LIVE' : 'RE-ENTRY'}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          {state.ce_lots ?? 0}L{state.ce_ltp != null ? ` · ₹${state.ce_ltp.toFixed(0)}` : ''}{state.ce_avg_price ? ` (avg ${state.ce_avg_price.toFixed(0)})` : ''}
                        </span>
                        {state.mode === 'reentry_straddle' && state.ce_sl != null && state.ce_sl > 0 && (
                          <span className="text-[10px] text-rose-400/70 font-mono whitespace-nowrap">
                            SL ₹{state.ce_sl.toFixed(0)}{state.leg_sl_pct != null ? ` (${Math.round(state.leg_sl_pct * 100)}%)` : ''}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {meta.key !== 'nifty_spread_trend' && (
                    <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[90px]">
                      <span className={lbl}>PE Strike</span>
                      <div className="flex items-center gap-1">
                        <span className="font-mono font-bold text-rose-400">{state.pe_strike || '—'}</span>
                        {state.mode === 'reentry_straddle' && state.pe_active != null && (
                          <span className={`text-[9px] font-bold px-1 rounded ${state.pe_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                            {state.pe_active ? 'LIVE' : 'RE-ENTRY'}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                        {state.pe_lots ?? 0}L{state.pe_ltp != null ? ` · ₹${state.pe_ltp.toFixed(0)}` : ''}{state.pe_avg_price ? ` (avg ${state.pe_avg_price.toFixed(0)})` : ''}
                      </span>
                      {state.mode === 'reentry_straddle' && state.pe_sl != null && state.pe_sl > 0 && (
                        <span className="text-[10px] text-rose-400/70 font-mono whitespace-nowrap">SL ₹{state.pe_sl.toFixed(0)}</span>
                      )}
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
                    </span>
                    {state.realized_pnl !== undefined && state.realized_pnl !== 0 && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">real ₹{state.realized_pnl.toFixed(0)}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Adj</span>
                    <span className="font-mono font-bold text-zinc-300">{state.adjustments ?? 0}</span>
                    {state.max_lots != null && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">max {state.max_lots}L</span>
                    )}
                  </div>
                </>
              )}
```

- [ ] **Step 6: Also hide the "Start Time" field for crudeoilm_supertrend in the shared config area**

In the shared config area, find the condition that hides Start Time for `nifty_spread_trend` (around line 358):

```typescript
        {meta.key !== 'nifty_spread_trend' && (
          <div className={fieldCls}>
            <label className={lbl}>Start Time</label>
```

Update to also exclude `crudeoilm_supertrend` (it has its own Start Time field in the CrudeOil-specific block):

```typescript
        {meta.key !== 'nifty_spread_trend' && meta.key !== 'crudeoilm_supertrend' && (
          <div className={fieldCls}>
            <label className={lbl}>Start Time</label>
```

- [ ] **Step 7: Verify in browser**

With `cd rs_dashboard && npm run dev` running, open `http://localhost:3000/strategies`.

Verify:
1. "CrudeOil Mini Supertrend" card appears in the strategies grid
2. Status badge shows "Stopped"
3. Clicking the ⚙ icon opens the config panel showing: Execution (LIVE checkbox), Lots, Target ₹, Stop Loss ₹, Timeframe (dropdown 1/3/5/15), ST Period, ST Multiplier, Start Time, EOD Time
4. Click "Launch Algorithm" (dry run) — card should show "Initializing" briefly, then "Scanning"
5. State file `debug/crudeoilm_supertrend_state.json` updates with the correct `interval`, `supertrend_period`, `supertrend_multiplier` values from the UI
6. "Square Off & Stop" button sends the shutdown trigger and card returns to "Stopped"

- [ ] **Step 8: Commit**

```bash
git add rs_dashboard/components/StrategyCard.tsx
git commit -m "feat(dashboard): add CrudeOil Mini Supertrend strategy card with configurable ST params"
```

---

## Self-Review

**Spec coverage check:**
- Signal logic (Supertrend, 5m default, configurable) ✓ Task 1
- Entry (find_future MCX, WebSocket, market order, fill wait) ✓ Task 1
- Trailing SL (ST level, refreshed per candle) ✓ Task 1
- Exit conditions (shutdown, EOD, profit cap, loss cap, trailing SL) ✓ Task 1
- Re-entry candle guard ✓ Task 1
- State file with all required fields ✓ Task 1
- CLI flags (all 9) ✓ Task 1
- API registry entry ✓ Task 2
- UI config panel (interval, ST period, ST multiplier, lots, target, SL, start/eod time) ✓ Task 3
- UI running stats (direction, entry, LTP, ST SL, daily P&L) ✓ Task 3

**Placeholder scan:** No TBDs or missing code blocks.

**Type consistency:**
- `state.daily_pnl` used in Task 3 Step 5 matches `daily_pnl` key written by `save_state()` in Task 1 ✓
- `state.st_level`, `state.entry_price`, `state.direction`, `state.interval`, `state.supertrend_period`, `state.supertrend_multiplier`, `state.expiry` all match state file keys ✓
- `STRATEGY_KEY = "crudeoilm_supertrend"` matches API route key and trigger file name ✓
