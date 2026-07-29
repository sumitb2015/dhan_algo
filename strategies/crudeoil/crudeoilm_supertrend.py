import time
import sys
import argparse
import os
import logging
import threading
import pandas as pd
from datetime import datetime
from typing import Tuple, Optional

# Adjust path to project root (two levels up from strategies/crudeoil/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, instance_log_suffix

# --- Constants ---
STRATEGY_KEY = "crudeoilm_supertrend"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"
INSTRUMENT = "FUTCOM"
SEGMENT = "MCX_COMM"

# --- Logging Setup ---
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
        FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log")),
    ],
    force=True,
)
logger = logging.getLogger(__name__)


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
        start_time: str = "09:00",
        eod_time: str = "23:30",
        cooldown_candles: int = 1,
        use_vwap: bool = False,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.interval = interval
        self.supertrend_period = supertrend_period
        self.supertrend_multiplier = supertrend_multiplier
        self.target_profit = target_profit
        self.stop_loss = stop_loss
        self.start_time = start_time
        self.eod_time = eod_time
        self.cooldown_candles = cooldown_candles
        self.use_vwap = use_vwap

        # Instance state
        self.security_id: Optional[str] = None
        self.expiry: Optional[str] = None
        self.lot_size: int = 10  # MCX crude mini default
        self.qty: int = 0
        self.direction: str = "NONE"   # "LONG", "SHORT", or "NONE"
        self.entry_price: float = 0.0
        self.st_level: float = 0.0     # trailing SL reference (Supertrend band)
        self.vwap: float = 0.0
        self.entry_time: Optional[datetime] = None
        self.ltp: float = 0.0
        self.position_pnl: float = 0.0   # unrealized P&L of current open position
        self.cumulative_pnl: float = 0.0  # sum of all closed position P&Ls today
        self.exit_candle_time: Optional[str] = None        # candle timestamp of last exit bar
        self.last_processed_candle_time: Optional[str] = None

        # Init DhanHelper
        dhan = get_dhan_client()
        self.helper = DhanHelper(dhan)

        # Background ST-refresh thread: while a position is open, the candle
        # fetch + Supertrend compute runs off-loop at each candle boundary so
        # the 1s SL-monitoring loop never stalls on it. The thread is the only
        # get_signal() caller while the event is set (the scan loop in run()
        # is idle then), so there is no concurrent indicator computation.
        self._st_lock = threading.Lock()
        self._st_snapshot = None  # (st_level, timestamp)
        self._st_thread = None
        self._st_active = threading.Event()

    # ------------------------------------------------------------------
    # Signal
    # ------------------------------------------------------------------

    def _st_poller_loop(self):
        interval_min = int(self.interval)
        last_candle = ""
        while True:
            if self._st_active.is_set():
                now = datetime.now()
                candle_mark = f"{now.strftime('%Y-%m-%d %H:')}{(now.minute // interval_min) * interval_min:02d}"
                if candle_mark != last_candle:
                    try:
                        saved_ts = self.last_processed_candle_time
                        _, _, st_val = self.get_signal()
                        self.last_processed_candle_time = saved_ts
                        if st_val > 0:
                            with self._st_lock:
                                self._st_snapshot = (st_val, time.time())
                        last_candle = candle_mark
                    except Exception as e:
                        logger.error("ST poller error: %s", e)
            time.sleep(2)

    def _start_st_poller(self):
        if self._st_thread is None or not self._st_thread.is_alive():
            self._st_thread = threading.Thread(
                target=self._st_poller_loop, daemon=True, name="supertrend-st-poller"
            )
            self._st_thread.start()
            logger.info("Background Supertrend refresh thread started.")

    def get_signal(self) -> Tuple[str, float, float]:
        """Returns (signal, close, st_level) where signal is LONG, SHORT, or NEUTRAL."""
        indicators = [{"kind": "supertrend", "length": self.supertrend_period, "multiplier": self.supertrend_multiplier}]
        if self.use_vwap:
            indicators.append({"kind": "vwap", "anchor": "D"})
        df = self.helper.get_indicators_ta(symbol=SYMBOL, interval=self.interval, indicators=indicators, days=3)
        if df.empty or len(df) < 2:
            return "NEUTRAL", 0.0, 0.0

        row = df.iloc[-2]  # last CONFIRMED closed candle (second-to-last)
        close = float(row["Close"])

        # Direction column: SUPERTd_<period>_<mult>
        dir_cols = [c for c in df.columns if c.startswith("SUPERTd_")]
        if not dir_cols:
            logger.error("Supertrend direction column missing. Available: %s", df.columns.tolist())
            return "NEUTRAL", close, 0.0
        st_dir = float(row[dir_cols[0]])

        # Level column: SUPERT_<period>_<mult>  (not SUPERTd_, SUPERTl_, SUPERTs_)
        level_cols = [c for c in df.columns if c.startswith("SUPERT_") and not any(c.startswith(p) for p in ("SUPERTd_", "SUPERTl_", "SUPERTs_"))]
        st_val = float(row[level_cols[0]]) if level_cols and not pd.isna(row[level_cols[0]]) else 0.0

        # VWAP filter
        vwap_val = 0.0
        if self.use_vwap:
            vwap_cols = [c for c in df.columns if c.startswith("VWAP")]
            if vwap_cols and not pd.isna(row[vwap_cols[0]]):
                vwap_val = float(row[vwap_cols[0]])
            self.vwap = vwap_val

        # Log only on new candle
        candle_ts = str(df.index[-2])
        if candle_ts != self.last_processed_candle_time:
            vwap_info = f" | VWAP: {vwap_val:.2f}" if self.use_vwap else ""
            logger.info("[SIGNAL] Candle: %s | Close: %.2f | STd: %.1f | ST: %.2f%s", candle_ts, close, st_dir, st_val, vwap_info)
            self.last_processed_candle_time = candle_ts

        if st_dir == 1.0:
            if self.use_vwap and vwap_val > 0 and close <= vwap_val:
                logger.info("[VWAP FILTER] LONG blocked: Close %.2f <= VWAP %.2f", close, vwap_val)
                return "NEUTRAL", close, st_val
            return "LONG", close, st_val
        elif st_dir == -1.0:
            if self.use_vwap and vwap_val > 0 and close >= vwap_val:
                logger.info("[VWAP FILTER] SHORT blocked: Close %.2f >= VWAP %.2f", close, vwap_val)
                return "NEUTRAL", close, st_val
            return "SHORT", close, st_val
        return "NEUTRAL", close, st_val

    # ------------------------------------------------------------------
    # Entry
    # ------------------------------------------------------------------

    def enter_position(self, direction: str, initial_st_level: float) -> bool:
        """Open a futures position. Returns True on success."""
        if check_shutdown_trigger(STRATEGY_KEY):
            logger.info("Shutdown triggered before entry.")
            return False

        future = self.helper.find_future(SYMBOL, exchange=EXCHANGE, instrument=INSTRUMENT)
        if future is None:
            logger.error("Could not find %s futures contract. Skipping entry.", SYMBOL)
            return False

        self.security_id = str(future.get("SECURITY_ID", ""))
        self.expiry = str(future.get("SM_EXPIRY_DATE", ""))
        # Master list LOT_SIZE for MCX shows 1 (Dhan convention); keep hardcoded default of 10 barrels/lot
        try:
            lot_from_master = int(float(future.get("LOT_SIZE", 1)))
            self.lot_size = lot_from_master if lot_from_master > 1 else self.lot_size
        except (ValueError, TypeError):
            pass
        self.qty = self.lot_size * self.lots

        # Subscribe WebSocket for live ticks
        try:
            self.helper.start_websocket([(SEGMENT, self.security_id, 15)])
            time.sleep(2)
        except Exception as e:
            logger.warning("WebSocket subscribe failed (will use REST fallback): %s", e)

        if not self.dry_run:
            # Place real order
            if direction == "LONG":
                order_id = self.helper.buy(self.security_id, self.qty)
            else:
                order_id = self.helper.sell(self.security_id, self.qty)

            if order_id is None:
                logger.error("Order placement failed for %s %s.", direction, SYMBOL)
                return False

            filled = self.helper.wait_for_fill(order_id, timeout=10)
            if not filled:
                logger.warning("Order %s did not fill in time. Cancelling.", order_id)
                # Cancel only this order — cancel_all_orders() is account-wide and would
                # kill pending orders belonging to other strategies / duplicated instances.
                self.helper.cancel_order(order_id)
                return False

            order_data = self.helper.get_order_by_id(order_id) or {}
            fill_price = float(
                order_data.get("averageTradedPrice")
                or order_data.get("avgFilledPrice")
                or order_data.get("price")
                or 0.0
            )
            if fill_price == 0:
                fill_price = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            self.entry_price = fill_price
        else:
            # Dry run — simulate
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            self.entry_price = ltp if ltp > 0 else 5000.0
            logger.info("[DRY RUN] Simulating %s entry @ %.2f", direction, self.entry_price)

        self.direction = direction
        if initial_st_level > 0:
            self.st_level = initial_st_level
        else:
            self.st_level = self.entry_price * (0.98 if direction == "LONG" else 1.02)
        self.entry_time = datetime.now()
        logger.info(
            "Entered %s @ %.2f | ST SL: %.2f | Qty: %d | Expiry: %s",
            direction, self.entry_price, self.st_level, self.qty, self.expiry
        )
        return True

    # ------------------------------------------------------------------
    # Monitor
    # ------------------------------------------------------------------

    def monitor_position(self) -> None:
        """1-second tick loop monitoring open position until exit."""
        last_log_time = 0.0

        # Hand ST refreshing to the background thread for the life of the position
        with self._st_lock:
            self._st_snapshot = None  # drop any snapshot from a previous position
        self._start_st_poller()
        self._st_active.set()
        try:
            self._monitor_position_loop(last_log_time)
        finally:
            self._st_active.clear()

    def _monitor_position_loop(self, last_log_time: float) -> None:
        while self.direction != "NONE":
            # Apply the latest background ST refresh (computed at candle boundaries)
            with self._st_lock:
                snap = self._st_snapshot
            if snap and snap[0] > 0 and snap[0] != self.st_level:
                logger.info("[ST REFRESH] ST level updated: %.2f → %.2f", self.st_level, snap[0])
                self.st_level = snap[0]

            # Exit condition 1: shutdown trigger
            if check_shutdown_trigger(STRATEGY_KEY):
                realized = self._exit_position("UI Shutdown Request")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                self.save_state(status="STOPPED")
                sys.exit(0)

            # Exit condition 2: EOD
            if datetime.now().strftime("%H:%M") >= self.eod_time:
                realized = self._exit_position("EOD Auto-Exit")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            # Fetch LTP. At 1s cadence only consult the WebSocket cache; fall
            # back to REST every 3s so a WS outage doesn't hammer the API.
            if str(self.security_id) in self.helper.live_data:
                ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            elif time.time() - getattr(self, "_last_rest_ltp_ts", 0.0) >= 3.0:
                ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
                self._last_rest_ltp_ts = time.time()
            else:
                ltp = 0.0
            if ltp <= 0:
                time.sleep(1)
                continue
            self.ltp = ltp

            # Compute position P&L
            if self.direction == "LONG":
                self.position_pnl = (ltp - self.entry_price) * self.qty
            else:
                self.position_pnl = (self.entry_price - ltp) * self.qty

            self.save_state()

            # Log every 30s
            now_ts = time.time()
            if now_ts - last_log_time >= 30:
                total = self.cumulative_pnl + self.position_pnl
                vwap_str = f" | VWAP: {self.vwap:.2f}" if self.use_vwap and self.vwap > 0 else ""
                logger.info(
                    "[MONITOR] Dir: %s | Entry: %.2f | LTP: %.2f | ST: %.2f%s | Pos P&L: %.2f | Day P&L: %.2f",
                    self.direction, self.entry_price, ltp, self.st_level, vwap_str, self.position_pnl, total
                )
                last_log_time = now_ts

            total_day_pnl = self.cumulative_pnl + self.position_pnl

            # Exit condition 3: daily profit target
            if total_day_pnl >= self.target_profit:
                realized = self._exit_position(f"Daily Profit Target Hit ({total_day_pnl:.2f} >= {self.target_profit:.2f})")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            # Exit condition 4: daily stop loss
            if total_day_pnl <= -self.stop_loss:
                realized = self._exit_position(f"Daily Stop Loss Hit ({total_day_pnl:.2f} <= -{self.stop_loss:.2f})")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            # Exit condition 5: trailing SL (Supertrend band)
            if self.direction == "LONG" and ltp < self.st_level:
                realized = self._exit_position(f"Trailing SL Hit: LTP {ltp:.2f} < ST {self.st_level:.2f}")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            if self.direction == "SHORT" and ltp > self.st_level:
                realized = self._exit_position(f"Trailing SL Hit: LTP {ltp:.2f} > ST {self.st_level:.2f}")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            time.sleep(1)

    # ------------------------------------------------------------------
    # Exit
    # ------------------------------------------------------------------

    def _exit_position(self, reason: str) -> float:
        """Exit the current position. Returns realized P&L (entry_price → fill price, sign-correct)."""
        logger.warning("!!! EXITING: %s !!!", reason)

        exit_price = 0.0
        if not self.dry_run:
            if self.direction == "LONG":
                order_id = self.helper.sell(self.security_id, self.qty)
            else:
                order_id = self.helper.buy(self.security_id, self.qty)

            if order_id is None:
                logger.critical("Exit order placement FAILED for %s %s. Manual intervention required!", self.direction, SYMBOL)
                sys.exit(1)

            self.helper.wait_for_fill(order_id, timeout=10)
            order_data = self.helper.get_order_by_id(order_id) or {}
            if order_data.get("orderStatus") != "TRADED":
                logger.critical("Exit order %s not confirmed as TRADED. Manual intervention required!", order_id)
                sys.exit(1)

            exit_price = float(
                order_data.get("averageTradedPrice")
                or order_data.get("avgFilledPrice")
                or order_data.get("price")
                or 0.0
            )
            if exit_price == 0.0:
                exit_price = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
        else:
            exit_price = self.ltp if self.ltp > 0 else self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            logger.info("[DRY RUN] Simulating exit of %s position @ %.2f", self.direction, exit_price)

        # Compute realized P&L from actual fill price before resetting state
        if exit_price > 0 and self.entry_price > 0:
            if self.direction == "LONG":
                realized_pnl = (exit_price - self.entry_price) * self.qty
            else:
                realized_pnl = (self.entry_price - exit_price) * self.qty
        else:
            realized_pnl = self.position_pnl  # fallback: use last LTP-based estimate
        logger.info("Realized P&L: %.2f (entry %.2f → exit %.2f, qty %d)", realized_pnl, self.entry_price, exit_price, self.qty)

        # Unsubscribe WebSocket
        try:
            self.helper.unsubscribe_instruments([(SEGMENT, self.security_id, 15)])
        except Exception as e:
            logger.warning("WebSocket unsubscribe failed (non-fatal): %s", e)

        self.exit_candle_time = self.last_processed_candle_time

        # Reset state
        self.direction = "NONE"
        self.entry_price = 0.0
        self.st_level = 0.0
        self.ltp = 0.0
        self.entry_time = None
        self.security_id = None
        self.expiry = None
        return realized_pnl

    # ------------------------------------------------------------------
    # State Persistence
    # ------------------------------------------------------------------

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
            "total_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "target_profit": self.target_profit,
            "stop_loss": self.stop_loss,
            "start_time": self.start_time,
            "eod_time": self.eod_time,
            "expiry": self.expiry or "",
            "use_vwap": self.use_vwap,
            "vwap": round(self.vwap, 2),
        })

    # ------------------------------------------------------------------
    # State Restore
    # ------------------------------------------------------------------

    def _restore_daily_pnl(self) -> None:
        """Restore cumulative_pnl from today's state file on process restart."""
        import json
        state_file = os.path.join(debug_dir, f"{STRATEGY_KEY}_state.json")
        try:
            if not os.path.exists(state_file):
                return
            # Only restore if the file was written today
            mtime = datetime.fromtimestamp(os.path.getmtime(state_file))
            if mtime.date() != datetime.now().date():
                return
            with open(state_file) as f:
                saved = json.load(f)
            restored = float(saved.get("daily_pnl", 0.0))
            if restored != 0.0:
                self.cumulative_pnl = restored
                logger.info("Restored daily P&L from state file: %.2f", restored)
        except Exception as e:
            logger.warning("Could not restore daily P&L from state file: %s", e)

    # ------------------------------------------------------------------
    # Re-entry Cooldown
    # ------------------------------------------------------------------

    def _candles_since_exit(self) -> int:
        """Return how many full candles have elapsed since the last exit."""
        if self.exit_candle_time is None or self.last_processed_candle_time is None:
            return 999
        try:
            exit_dt = datetime.fromisoformat(str(self.exit_candle_time)[:19])
            current_dt = datetime.fromisoformat(str(self.last_processed_candle_time)[:19])
            elapsed_min = max(0.0, (current_dt - exit_dt).total_seconds() / 60)
            return int(elapsed_min // int(self.interval))
        except Exception:
            return 999

    # ------------------------------------------------------------------
    # Contract Resolution
    # ------------------------------------------------------------------

    def _ensure_contract_resolved(self) -> None:
        """Resolve and cache the nearest CRUDEOILM futures contract if not already done."""
        if self.security_id:
            return
        future = self.helper.find_future(SYMBOL, exchange=EXCHANGE, instrument=INSTRUMENT)
        if future is None:
            return
        self.security_id = str(future.get("SECURITY_ID", ""))
        self.expiry = str(future.get("SM_EXPIRY_DATE", ""))
        try:
            lot_from_master = int(float(future.get("LOT_SIZE", 1)))
            self.lot_size = lot_from_master if lot_from_master > 1 else self.lot_size
        except (ValueError, TypeError):
            pass
        self.qty = self.lot_size * self.lots

    def _get_ltp_safe(self) -> float:
        """Fetch current LTP; resolves contract lazily. Returns 0.0 on failure."""
        self._ensure_contract_resolved()
        if not self.security_id:
            return 0.0
        return self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)

    # ------------------------------------------------------------------
    # MCX Session Wait
    # ------------------------------------------------------------------

    def _wait_for_mcx_session(self) -> None:
        """Wait for MCX session window using time-only check (no weekday or holiday filter)."""
        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                self.save_state(status="STOPPED")
                sys.exit(0)
            now = datetime.now()
            now_str = now.strftime("%H:%M")
            if now_str >= self.eod_time:
                return  # let outer loop handle EOD
            if now_str >= self.start_time:
                return  # session is open
            next_check = 60 if not self.dry_run else 5
            logger.info("Waiting for MCX session to open (%s IST). Current: %s", self.start_time, now_str)
            time.sleep(next_check)

    # ------------------------------------------------------------------
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        mode = "LIVE" if not self.dry_run else "DRY RUN"
        print(
            f"\n{'='*60}\n"
            f"  CrudeOilM Supertrend Strategy\n"
            f"  Mode        : {mode}\n"
            f"  Interval    : {self.interval}m\n"
            f"  Supertrend  : period={self.supertrend_period}, mult={self.supertrend_multiplier}\n"
            f"  VWAP Filter : {'ON (buy only above VWAP, sell only below VWAP)' if self.use_vwap else 'OFF'}\n"
            f"  Session     : {self.start_time} – {self.eod_time} IST\n"
            f"  Lots        : {self.lots} (qty per lot: {self.lot_size})\n"
            f"{'='*60}\n"
        )
        # Restore BEFORE the first save_state, which overwrites the state file
        self._restore_daily_pnl()
        self.save_state(status="INITIALIZING")

        while True:
            # Shutdown check
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(status="STOPPED")
                sys.exit(0)

            # EOD guard
            if datetime.now().strftime("%H:%M") >= self.eod_time:
                logger.info("Past EOD time (%s). Stopping.", self.eod_time)
                self.save_state(status="STOPPED")
                break

            try:
                # Wait for session open
                self._wait_for_mcx_session()
                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    continue

                # Daily P&L caps (before new position)
                if self.cumulative_pnl >= self.target_profit:
                    logger.info("Daily profit target already reached (%.2f). Done for the day.", self.cumulative_pnl)
                    self.save_state(status="STOPPED")
                    break
                if self.cumulative_pnl <= -self.stop_loss:
                    logger.info("Daily stop loss already hit (%.2f). Done for the day.", self.cumulative_pnl)
                    self.save_state(status="STOPPED")
                    break

                # Resolve contract early so LTP is available during scan
                self._ensure_contract_resolved()
                self.save_state(status="SCANNING")

                signal, _, initial_st = self.get_signal()

                # Re-entry cooldown: wait cooldown_candles full candles after an exit
                candles_elapsed = self._candles_since_exit()
                if candles_elapsed < self.cooldown_candles:
                    logger.info(
                        "Cooldown: %d/%d candles elapsed since last exit on %s.",
                        candles_elapsed, self.cooldown_candles, self.exit_candle_time
                    )
                    time.sleep(15)
                    continue

                if signal in ("LONG", "SHORT"):
                    logger.info("Signal: %s | Initial ST SL: %.2f", signal, initial_st)
                    success = self.enter_position(signal, initial_st)
                    if success:
                        self.monitor_position()
                else:
                    current_ltp = self._get_ltp_safe()
                    price_str = f" | {SYMBOL} LTP: {current_ltp:.2f}" if current_ltp > 0 else ""
                    logger.info("Signal: NEUTRAL. Waiting for trend confirmation...%s", price_str)
                    time.sleep(20 if self.dry_run else 30)

            except Exception as e:
                logger.error("Error in main loop: %s", e)
                import traceback
                logger.debug(traceback.format_exc())
                time.sleep(10)


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="MCX CrudeOilM Supertrend Futures Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default), 1 lot, 5m candles
  python strategies/crudeoil/crudeoilm_supertrend.py

  # Live trading, 2 lots
  python strategies/crudeoil/crudeoilm_supertrend.py --live --lots 2

  # Custom session window
  python strategies/crudeoil/crudeoilm_supertrend.py --start-time 09:00 --eod-time 23:00
""",
    )
    parser.add_argument("--live", action="store_true", default=False,
                        help="Enable live trading (default: dry run)")
    parser.add_argument("--lots", type=int, default=1,
                        help="Number of lots to trade (default: 1)")
    parser.add_argument("--interval", type=str, default="5",
                        help="Candle interval in minutes: 1/3/5/15 (default: 5)")
    parser.add_argument("--supertrend-period", type=int, default=7,
                        help="Supertrend ATR period (default: 7)")
    parser.add_argument("--supertrend-multiplier", type=float, default=3.0,
                        help="Supertrend multiplier (default: 3.0)")
    parser.add_argument("--target-profit", type=float, default=3000.0,
                        help="Daily profit target in INR (default: 3000)")
    parser.add_argument("--stop-loss", type=float, default=3000.0,
                        help="Daily stop loss in INR (default: 3000)")
    parser.add_argument("--start-time", type=str, default="09:00",
                        help="Session start time HH:MM IST (default: 09:00)")
    parser.add_argument("--eod-time", type=str, default="23:30",
                        help="End-of-day time HH:MM IST (default: 23:30)")
    parser.add_argument("--cooldown-candles", type=int, default=1,
                        help="Candles to skip after exit before re-entry (default: 1)")
    parser.add_argument("--use-vwap", action="store_true", default=False,
                        help="Require price above VWAP for LONG, below VWAP for SHORT (default: off)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")
    args = parser.parse_args()
    if args.instance_id:
        STRATEGY_KEY = f"{STRATEGY_KEY}_{args.instance_id}"

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
        use_vwap=args.use_vwap,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt. Exiting cleanly.")
        if strat.direction != "NONE":
            realized = strat._exit_position("KeyboardInterrupt / Manual Stop")
            strat.cumulative_pnl += realized
            strat.position_pnl = 0.0
            strat.save_state(status="STOPPED")
        sys.exit(0)
