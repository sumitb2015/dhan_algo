import time
import sys
import argparse
import json
import os
import re
import logging
import threading
from datetime import datetime
from typing import Any, Dict, NamedTuple, Optional, Tuple

import pandas as pd

# Adjust path to project root (two levels up from strategies/crudeoil/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, instance_log_suffix
from lib.trade_stops import ratchet_stop, stop_hit

# --- Constants ---
STRATEGY_KEY = "crudeoilm_ema_supertrend"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"        # find_future() exchange
INSTRUMENT = "FUTCOM"   # find_future() / get_ltp() instrument
SEGMENT = "MCX_COMM"    # get_ltp() / websocket segment

# --- Logging Setup ---
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "crudeoil_ema")
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
        # encoding: FileHandler otherwise opens with the system ANSI codepage
        # (cp1252 on Windows) and silently DROPS any log line containing a
        # non-ANSI glyph (INR sign, arrows, dashes) while still writing the
        # ASCII lines around it -- the log looks intact but loses those lines.
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        ),
    ],
    force=True,
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Signal core (pure — unit-testable without a broker session)
# ---------------------------------------------------------------------------

def desired_direction(price: float, st_val: float, ema_val: float, current: str) -> str:
    """Always-on with hysteresis: enter or flip only when price clears BOTH bands.

    Above Supertrend AND above EMA20  -> LONG
    Below Supertrend AND below EMA20  -> SHORT
    Anything in between (the "mixed zone") returns `current`, so an open
    position is HELD through mixed signals and a flat book stays flat --
    losing agreement from a single indicator is not by itself a signal.
    """
    if price <= 0 or st_val <= 0 or ema_val <= 0:
        return current  # indicators/price not ready — never act on a partial view
    if price > st_val and price > ema_val:
        return "LONG"
    if price < st_val and price < ema_val:
        return "SHORT"
    return current


class Snapshot(NamedTuple):
    """One confirmed-candle view. A NamedTuple, not a bare tuple: this is unpacked in
    half a dozen places and positional growth is how those get silently mismatched."""
    close: float
    st: float
    ema: float
    atr: float
    candle_ts: str


class CrudeOilMEmaSupertrendStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 5,
        contract_size: int = 10,
        interval: str = "5",
        supertrend_period: int = 7,
        supertrend_multiplier: float = 2.0,
        ema_length: int = 20,
        target_profit: float = 5000.0,
        stop_loss: float = 5000.0,
        start_time: str = "09:00",
        eod_time: str = "23:30",
        poll_seconds: int = 15,
        days: int = 3,
        allow_reverse: bool = True,
        exit_on_close: bool = False,
        flip_cooldown: int = 60,
        atr_stop_mult: float = 1.5,
        trail_trigger_atr: float = 1.0,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.contract_size = contract_size
        self.interval = interval
        self.supertrend_period = supertrend_period
        self.supertrend_multiplier = supertrend_multiplier
        self.ema_length = ema_length
        self.target_profit = target_profit
        self.stop_loss = abs(stop_loss)
        self.start_time = start_time
        self.eod_time = eod_time
        self.poll_seconds = poll_seconds
        self.days = days
        self.allow_reverse = allow_reverse
        self.exit_on_close = exit_on_close
        self.flip_cooldown = flip_cooldown
        self.atr_stop_mult = atr_stop_mult
        self.trail_trigger_atr = trail_trigger_atr
        # Backoff after a rejected entry, so a persistently failing order does not
        # get resubmitted once per second.
        self.entry_retry_seconds = max(5, poll_seconds)

        # Quantity semantics — these two numbers are NOT the same thing.
        #   qty      : what the broker receives. Dhan takes MCX quantity in LOTS
        #              (its master list reports LOT_SIZE=1 for MCX contracts).
        #   exposure : barrels actually controlled (lots x contract size), used
        #              for P&L ONLY. CRUDEOILM = 10 barrels/lot, CRUDEOIL = 100.
        # Conflating them under-reports P&L by contract_size and makes the daily
        # target/stop caps effectively unreachable.
        self.qty = lots
        self.exposure = lots * contract_size

        # Instance state
        self.security_id: Optional[str] = None
        self.expiry: Optional[str] = None
        self.lot_size: int = contract_size  # from master list when it reports something sane
        self.direction: str = "NONE"        # "LONG", "SHORT", or "NONE"
        self.entry_price: float = 0.0
        self.entry_time: Optional[datetime] = None
        self.ltp: float = 0.0
        self.position_pnl: float = 0.0      # unrealized P&L of the open position
        self.cumulative_pnl: float = 0.0    # sum of all closed position P&Ls today
        self.last_flip_ts: float = 0.0      # time of the last entry/flip, for the cooldown
        self._entry_retry_at: float = 0.0   # earliest time a failed entry may be retried
        self._last_cooldown_log: float = 0.0

        # Per-trade stop
        self.stop_level: float = 0.0
        self.stop_source: str = ""          # "ATR" | "SUPERTREND"

        self.trades_today: int = 0

        # Latest confirmed-candle snapshot, written by the poller thread only
        self._snap_lock = threading.Lock()
        self._snapshot: Optional[Snapshot] = None
        self._poll_thread = None
        self.last_processed_candle_time: str = ""

        self._signals_path = os.path.join(debug_dir, f"{STRATEGY_KEY}_signals.jsonl")

        # Init DhanHelper
        dhan = get_dhan_client()
        self.helper = DhanHelper(dhan)

    # ------------------------------------------------------------------
    # Indicators
    # ------------------------------------------------------------------

    def _poller_loop(self) -> None:
        """Daemon thread: refresh the Supertrend/EMA snapshot every poll_seconds.

        Only this thread calls compute_snapshot(), so the 1s main loop never
        blocks on the candle fetch + pandas_ta computation.
        """
        while True:
            try:
                self.compute_snapshot()
            except Exception as e:
                logger.error("Indicator poller error: %s", e)
            time.sleep(self.poll_seconds)

    def _start_poller(self) -> None:
        if self._poll_thread is None or not self._poll_thread.is_alive():
            self._poll_thread = threading.Thread(
                target=self._poller_loop, daemon=True, name="ema-st-poller"
            )
            self._poll_thread.start()
            logger.info("Background Supertrend/EMA poller started (every %ds).", self.poll_seconds)

    @staticmethod
    def _pick(df, row, *, prefix: str, exclude: Tuple[str, ...] = ()) -> Tuple[float, bool]:
        """Read the first column starting with `prefix`. Returns (value, found).

        calculate_ta_indicators() swallows per-indicator failures and only LOGS them
        (lib/dhan_helper.py), so a mistyped or unsupported indicator silently yields a
        frame missing that column. Never assume the column is there.
        """
        cols = [c for c in df.columns
                if c.startswith(prefix) and not any(c.startswith(x) for x in exclude)]
        if not cols:
            return 0.0, False
        val = row[cols[0]]
        if pd.isna(val):
            return 0.0, False
        return float(val), True

    def compute_snapshot(self) -> Optional[Snapshot]:
        """Fetch candles and read the last CONFIRMED candle's Supertrend + EMA20."""
        indicators = [
            {"kind": "supertrend", "length": self.supertrend_period, "multiplier": self.supertrend_multiplier},
            {"kind": "ema", "length": self.ema_length},
            {"kind": "atr", "length": self.supertrend_period},
        ]
        df = self.helper.get_indicators_ta(
            symbol=SYMBOL, interval=self.interval, indicators=indicators, days=self.days
        )
        if df is None or df.empty or len(df) < 2:
            if getattr(self.helper, "last_api_error", None):
                logger.warning("Indicator fetch returned no data. API error: %s", self.helper.last_api_error)
            return None

        row = df.iloc[-2]  # last CONFIRMED closed candle (second-to-last)
        close = float(row["Close"])

        # Level column: SUPERT_<period>_<mult>  (not SUPERTd_ / SUPERTl_ / SUPERTs_)
        st_val, _ = self._pick(df, row, prefix="SUPERT_",
                               exclude=("SUPERTd_", "SUPERTl_", "SUPERTs_"))
        if not any(c.startswith("SUPERT_") for c in df.columns):
            logger.error("Supertrend level column missing. Available: %s", df.columns.tolist())
            return None

        # pandas_ta names this EMA_<length> — matches nothing else in the frame.
        ema_val, _ = self._pick(df, row, prefix=f"EMA_{self.ema_length}")
        if not any(c.startswith(f"EMA_{self.ema_length}") for c in df.columns):
            logger.error("EMA%d column missing. Available: %s", self.ema_length, df.columns.tolist())
            return None

        atr_val, _ = self._pick(df, row, prefix="ATR")

        candle_ts = str(df.index[-2])

        snap = Snapshot(close=close, st=st_val, ema=ema_val, atr=atr_val, candle_ts=candle_ts)
        with self._snap_lock:
            self._snapshot = snap

        if candle_ts != self.last_processed_candle_time:
            zone = "ABOVE BOTH" if (close > st_val > 0 and close > ema_val > 0) else \
                   "BELOW BOTH" if (0 < st_val and close < st_val and 0 < ema_val and close < ema_val) else "MIXED"
            logger.info(
                "[SIGNAL] Candle: %s | Close: %.2f | ST: %.2f | EMA%d: %.2f | ATR: %.2f | Zone: %s",
                candle_ts, close, st_val, self.ema_length, ema_val, atr_val, zone,
            )
            self.last_processed_candle_time = candle_ts
            self._log_decision(snap)
        return snap

    def _read_snapshot(self) -> Optional[Snapshot]:
        with self._snap_lock:
            return self._snapshot

    def desired(self) -> str:
        """Direction the strategy wants right now.

        Flat  -> decided on the last CONFIRMED candle close (no intra-candle churn).
        In a position -> decided on the live LTP unless --exit-on-close. HOLDING is
                 deliberately not re-checked against anything else: once in a trade
                 the exit rules (signal flip / per-trade stop / EOD / daily caps) own it.
        """
        snap = self._read_snapshot()
        if snap is None:
            return self.direction
        if self.direction != "NONE":
            price = snap.close if self.exit_on_close else (self.ltp if self.ltp > 0 else snap.close)
            return desired_direction(price, snap.st, snap.ema, self.direction)
        return desired_direction(snap.close, snap.st, snap.ema, "NONE")

    # ------------------------------------------------------------------
    # Decision telemetry
    # ------------------------------------------------------------------

    def _log_decision(self, snap: Snapshot) -> None:
        """Append one JSON line per confirmed candle to debug/<key>_signals.jsonl."""
        try:
            raw = desired_direction(snap.close, snap.st, snap.ema, "NONE")
            record: Dict[str, Any] = {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "candle": snap.candle_ts,
                "close": round(snap.close, 2),
                "st": round(snap.st, 2),
                "ema": round(snap.ema, 2),
                "atr": round(snap.atr, 2),
                "raw_signal": raw,
                "direction": self.direction,  # what we are actually holding
                "trades_today": self.trades_today,
                "day_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            }
            with open(self._signals_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as e:
            logger.debug("Decision telemetry write failed (non-fatal): %s", e)

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
        # Dhan's master list reports LOT_SIZE=1 for MCX (its order quantity is in
        # lots); only trust the value when it is clearly a real contract size.
        try:
            lot_from_master = int(float(future.get("LOT_SIZE", 1)))
            if lot_from_master > 1:
                self.lot_size = lot_from_master
        except (ValueError, TypeError):
            pass
        if self.lot_size != self.contract_size:
            logger.warning(
                "Master list reports LOT_SIZE=%d but --contract-size is %d. "
                "P&L is computed with %d barrels/lot — verify against the broker.",
                self.lot_size, self.contract_size, self.contract_size
            )
        logger.info(
            "Contract resolved: %s | SecurityId: %s | Expiry: %s | Order qty: %d lot(s) | Exposure: %d barrels",
            SYMBOL, self.security_id, self.expiry, self.qty, self.exposure
        )

    # ------------------------------------------------------------------
    # Interval verification
    # ------------------------------------------------------------------

    def _probe_interval(self, interval: str) -> int:
        """Return the ACTUAL candle spacing in minutes for `interval`, or 0 if unusable.

        Dhan does not reject an interval it cannot serve. Measured on CRUDEOILM:
        "3" works, "30" comes back as 15-minute candles, and "60" comes back empty.
        Trusting the requested number would silently gate the strategy on the wrong
        timeframe, so measure the spacing that actually arrived.
        """
        try:
            df = self.helper.get_latest_candles(symbol=SYMBOL, interval=interval, days=5)
            if df is None or df.empty or len(df) < 3:
                return 0
            deltas = df.index.to_series().diff().dropna()
            if deltas.empty:
                return 0
            return int(deltas.mode().iloc[0].total_seconds() // 60)
        except Exception as e:
            logger.warning("Interval probe for %sm failed: %s", interval, e)
            return 0

    def _verify_interval(self) -> None:
        """A wrong signal interval is FATAL: get_latest_candles returns an empty frame
        rather than an error, so the strategy would sit in SCANNING all session with
        nothing in the log to say why."""
        want = int(self.interval)
        got = self._probe_interval(self.interval)
        if got == 0:
            logger.critical(
                "Dhan returned no %sm candles for %s. The strategy cannot compute a "
                "signal — pick a different --interval.", self.interval, SYMBOL
            )
            self.save_state(status="ERROR_BAD_INTERVAL")
            sys.exit(1)
        if got != want:
            logger.critical(
                "Requested %sm candles but Dhan returned %dm ones. Dhan downgrades "
                "unsupported intervals silently — the strategy would trade the wrong "
                "timeframe. Use --interval %d.", self.interval, got, got
            )
            self.save_state(status="ERROR_BAD_INTERVAL")
            sys.exit(1)

    # ------------------------------------------------------------------
    # MCX Session Wait
    # ------------------------------------------------------------------

    def _wait_for_mcx_session(self) -> None:
        """Wait for the MCX session window using a time-only check.

        Deliberately does NOT call helper.is_market_open() — that is NSE equity
        hours (09:15-15:30) and would never open for MCX.
        """
        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                self.save_state(status="STOPPED")
                sys.exit(0)
            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.eod_time:
                return  # let the main loop handle EOD
            if now_str >= self.start_time:
                return  # session is open
            logger.info("Waiting for MCX session to open (%s IST). Current: %s", self.start_time, now_str)
            self.save_state(status="SCANNING")
            time.sleep(60 if not self.dry_run else 5)

    def _unsubscribe_ws(self) -> None:
        if not self.security_id:
            return
        try:
            self.helper.unsubscribe_instruments([(SEGMENT, self.security_id, 15)])
        except Exception as e:
            logger.warning("WebSocket unsubscribe failed (non-fatal): %s", e)

    def _shutdown_and_exit(self, reason: str) -> None:
        logger.info(reason)
        self._flatten(reason)
        self._unsubscribe_ws()
        self.save_state(status="STOPPED")
        sys.exit(0)

    def _refresh_ltp(self) -> bool:
        """Update self.ltp / position_pnl. WebSocket cache at 1s, REST throttled.

        Returns True when position_pnl is priced off a real quote. The caller MUST
        skip the daily target/stop checks when this is False: get_ltp() returns 0.0
        on any failure (WS silent + a rate-limited REST quote is enough), and marking
        an open position against a price of zero reads as a catastrophic loss that
        would trip the daily stop and end the day on a transient quote glitch.
        """
        if not self.security_id:
            return False
        ltp = 0.0
        if str(self.security_id) in self.helper.live_data:
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
        elif time.time() - getattr(self, "_last_rest_ltp_ts", 0.0) >= 3.0:
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            self._last_rest_ltp_ts = time.time()
        if ltp > 0:
            self.ltp = ltp

        if self.direction == "NONE":
            self.position_pnl = 0.0
            return True
        if self.ltp <= 0 or self.entry_price <= 0:
            self.position_pnl = 0.0
            if time.time() - getattr(self, "_last_noquote_log", 0.0) >= 30.0:
                logger.warning(
                    "No usable quote for %s yet — P&L and the daily target/stop are paused "
                    "(position is still open).", SYMBOL
                )
                self._last_noquote_log = time.time()
            return False

        if self.direction == "LONG":
            self.position_pnl = (self.ltp - self.entry_price) * self.exposure
        else:
            self.position_pnl = (self.entry_price - self.ltp) * self.exposure
        return True

    # ------------------------------------------------------------------
    # Entry
    # ------------------------------------------------------------------

    def enter_position(self, direction: str) -> bool:
        """Open a futures position. Returns True on success."""
        if direction not in ("LONG", "SHORT"):
            return False

        if check_shutdown_trigger(STRATEGY_KEY):
            logger.info("Shutdown triggered before entry.")
            self.save_state(status="STOPPED")
            sys.exit(0)

        self._ensure_contract_resolved()
        if not self.security_id:
            logger.error("Could not find %s futures contract. Skipping entry.", SYMBOL)
            return False

        if not self.dry_run:
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
            ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            if ltp <= 0:
                snap = self._read_snapshot()
                ltp = snap.close if snap else 5000.0
            self.entry_price = ltp
            logger.info("[DRY RUN] Simulating %s entry @ %.2f", direction, self.entry_price)

        self.direction = direction
        self.entry_time = datetime.now()
        self.position_pnl = 0.0
        self.trades_today += 1
        snap = self._read_snapshot()
        self._arm_initial_stop(snap)
        logger.info(
            "Entered %s @ %.2f | Qty: %d lot(s) = %d barrels | ST: %.2f | EMA%d: %.2f | "
            "Stop: %.2f (%s) | Trade %d | Expiry: %s",
            direction, self.entry_price, self.qty, self.exposure,
            snap.st if snap else 0.0, self.ema_length, snap.ema if snap else 0.0,
            self.stop_level, self.stop_source or "none", self.trades_today,
            self.expiry
        )
        return True

    # ------------------------------------------------------------------
    # Per-trade stop: ATR at entry, then ratcheted onto the Supertrend band
    # ------------------------------------------------------------------

    def _arm_initial_stop(self, snap: Optional[Snapshot]) -> None:
        """Set the fixed ATR stop at entry. --atr-stop-mult 0 disables it entirely."""
        self.stop_level = 0.0
        self.stop_source = ""
        if self.atr_stop_mult <= 0 or snap is None or snap.atr <= 0 or self.entry_price <= 0:
            return
        offset = snap.atr * self.atr_stop_mult
        self.stop_level = (self.entry_price - offset) if self.direction == "LONG" \
            else (self.entry_price + offset)
        self.stop_source = "ATR"

    def _update_trailing_stop(self) -> None:
        """Once the trade is far enough in profit, hand the stop to the Supertrend band.

        The band only ever tightens the stop (ratchet_stop), so a mid-trend pullback
        cannot hand back locked-in profit. Without this the signal flip is the only
        exit and a winner round-trips through the mixed zone before it fires.
        """
        if self.direction == "NONE" or self.atr_stop_mult <= 0:
            return
        snap = self._read_snapshot()
        if snap is None or snap.atr <= 0 or snap.st <= 0 or self.ltp <= 0:
            return
        move = (self.ltp - self.entry_price) if self.direction == "LONG" \
            else (self.entry_price - self.ltp)
        if move < snap.atr * self.trail_trigger_atr:
            return
        # Never adopt a band that is already on the wrong side of price -- that would
        # be an immediate stop-out on the very tick that armed the trail.
        if self.direction == "LONG" and snap.st >= self.ltp:
            return
        if self.direction == "SHORT" and snap.st <= self.ltp:
            return
        new_stop = ratchet_stop(self.direction, self.stop_level, snap.st)
        if new_stop != self.stop_level:
            logger.info(
                "Trailing stop %.2f -> %.2f (Supertrend band, %s @ %.2f)",
                self.stop_level, new_stop, self.direction, self.ltp
            )
            self.stop_level = new_stop
            self.stop_source = "SUPERTREND"

    # ------------------------------------------------------------------
    # Exit
    # ------------------------------------------------------------------

    def _exit_position(self, reason: str) -> float:
        """Exit the current position. Returns realized P&L from the actual fill price."""
        if self.direction == "NONE":
            return 0.0

        logger.warning("!!! EXITING: %s !!!", reason)

        exit_price = 0.0
        if not self.dry_run:
            if self.direction == "LONG":
                order_id = self.helper.sell(self.security_id, self.qty)
            else:
                order_id = self.helper.buy(self.security_id, self.qty)

            if order_id is None:
                logger.critical("Exit order placement FAILED for %s %s. Manual intervention required!", self.direction, SYMBOL)
                self.save_state(status="ERROR_EXIT_ORDER_FAILED")
                sys.exit(1)

            self.helper.wait_for_fill(order_id, timeout=10)
            order_data = self.helper.get_order_by_id(order_id) or {}
            if order_data.get("orderStatus") != "TRADED":
                logger.critical("Exit order %s not confirmed as TRADED. Manual intervention required!", order_id)
                self.save_state(status="ERROR_EXIT_NOT_CONFIRMED")
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

        if exit_price > 0 and self.entry_price > 0:
            if self.direction == "LONG":
                realized_pnl = (exit_price - self.entry_price) * self.exposure
            else:
                realized_pnl = (self.entry_price - exit_price) * self.exposure
        else:
            realized_pnl = self.position_pnl  # fallback: last LTP-based estimate

        logger.info(
            "Realized P&L: %.2f (entry %.2f -> exit %.2f, %d barrels)",
            realized_pnl, self.entry_price, exit_price, self.exposure
        )

        self.direction = "NONE"
        self.entry_price = 0.0
        self.entry_time = None
        self.position_pnl = 0.0
        self.stop_level = 0.0
        self.stop_source = ""
        return realized_pnl

    def _flatten(self, reason: str) -> None:
        """Exit any open position and bank the realized P&L."""
        if self.direction != "NONE":
            self.cumulative_pnl += self._exit_position(reason)
            self.position_pnl = 0.0

    # ------------------------------------------------------------------
    # Reverse (always-on stop-and-reverse)
    # ------------------------------------------------------------------

    def reverse_position(self, new_direction: str) -> None:
        """Stop-and-reverse: close the current position, immediately open the opposite one."""
        snap = self._read_snapshot()
        bands = f"ST {snap.st:.2f} / EMA{self.ema_length} {snap.ema:.2f}" if snap else "bands unavailable"
        price = self.ltp if self.ltp > 0 else (snap.close if snap else 0.0)
        self._flatten(f"Signal flip to {new_direction}: price {price:.2f} cleared both bands ({bands})")
        self.save_state(status="REVERSING")
        if not self.enter_position(new_direction):
            # Stay flat; the flat branch of the main loop re-derives the desired
            # direction from the indicator snapshot and retries. Arm the same
            # backoff it uses, or a broker rejecting every order would be retried
            # once per second from here on.
            self._entry_retry_at = time.time() + self.entry_retry_seconds
            logger.critical(
                "Reversal entry FAILED — flat, retrying in %ds.", self.entry_retry_seconds
            )

    # ------------------------------------------------------------------
    # State Persistence
    # ------------------------------------------------------------------

    def save_state(self, status: str = "RUNNING") -> None:
        snap = self._read_snapshot()
        save_strategy_state(STRATEGY_KEY, {
            "strategy": STRATEGY_KEY,
            "status": status,
            "dry_run": self.dry_run,
            "symbol": SYMBOL,
            "interval": self.interval,
            "supertrend_period": self.supertrend_period,
            "supertrend_multiplier": self.supertrend_multiplier,
            "ema_length": self.ema_length,
            "direction": self.direction,
            "entry_price": round(self.entry_price, 2),
            "ltp": round(self.ltp, 2),
            "st_level": round(snap.st, 2) if snap else 0.0,
            "ema": round(snap.ema, 2) if snap else 0.0,
            "signal_close": round(snap.close, 2) if snap else 0.0,
            "atr": round(snap.atr, 2) if snap else 0.0,
            # --- per-trade risk ---
            "stop_level": round(self.stop_level, 2),
            "stop_source": self.stop_source,
            "atr_stop_mult": self.atr_stop_mult,
            "trail_trigger_atr": self.trail_trigger_atr,
            "trades_today": self.trades_today,
            "qty": self.qty,
            "lots": self.lots,
            "contract_size": self.contract_size,
            "exposure_units": self.exposure,
            "position_pnl": round(self.position_pnl, 2),
            "daily_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "total_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "target_profit": self.target_profit,
            "stop_loss": self.stop_loss,
            "start_time": self.start_time,
            "eod_time": self.eod_time,
            "expiry": self.expiry or "",
            "allow_reverse": self.allow_reverse,
            "exit_on_close": self.exit_on_close,
            "flip_cooldown": self.flip_cooldown,
        })

    # ------------------------------------------------------------------
    # State Restore
    # ------------------------------------------------------------------

    def _restore_daily_pnl(self) -> None:
        """Restore today's realized P&L and trade count from the state file on restart."""
        state_file = os.path.join(debug_dir, f"{STRATEGY_KEY}_state.json")
        try:
            if not os.path.exists(state_file):
                return
            mtime = datetime.fromtimestamp(os.path.getmtime(state_file))
            if mtime.date() != datetime.now().date():
                return
            with open(state_file) as f:
                saved = json.load(f)
            restored = float(saved.get("daily_pnl", 0.0))
            if restored != 0.0:
                self.cumulative_pnl = restored
                logger.info("Restored daily P&L from state file: %.2f", restored)
            self.trades_today = int(saved.get("trades_today", 0))
        except Exception as e:
            logger.warning("Could not restore daily state from state file: %s", e)

    # ------------------------------------------------------------------
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        mode = "LIVE" if not self.dry_run else "DRY RUN"
        print(
            f"\n{'='*66}\n"
            f"  CrudeOilM EMA + Supertrend Always-On Strategy\n"
            f"  Mode        : {mode}\n"
            f"  Candles     : {self.interval}m\n"
            f"  Supertrend  : ({self.supertrend_period}, {self.supertrend_multiplier})\n"
            f"  EMA         : {self.ema_length}\n"
            f"  Rule        : LONG above BOTH | SHORT below BOTH | hold in between\n"
            f"  On flip     : {'stop-and-reverse' if self.allow_reverse else 'exit to flat (--no-reverse)'}"
            f" (min {self.flip_cooldown}s between flips)\n"
            f"  Exit price  : {'confirmed close' if self.exit_on_close else 'live LTP'}\n"
            f"  Trade stop  : "
            + (f"{self.atr_stop_mult}x ATR, trails the Supertrend band after "
               f"{self.trail_trigger_atr}x ATR of profit" if self.atr_stop_mult > 0 else "none")
            + f"\n"
            f"  Quantity    : {self.lots} lot(s) -> broker qty {self.qty}, exposure {self.exposure} barrels\n"
            f"  Day target  : +{self.target_profit:.0f} INR | Day stop: -{self.stop_loss:.0f} INR\n"
            f"  Session     : {self.start_time} - {self.eod_time} IST\n"
            f"{'='*66}\n"
        )
        # Restore BEFORE the first save_state, which overwrites the state file
        self._restore_daily_pnl()
        self.save_state(status="INITIALIZING")
        self._wait_for_mcx_session()

        self._ensure_contract_resolved()
        if self.security_id:
            try:
                self.helper.start_websocket([(SEGMENT, self.security_id, 15)])
                time.sleep(2)
            except Exception as e:
                logger.warning("WebSocket subscribe failed (will use REST fallback): %s", e)

        self._verify_interval()
        self._start_poller()

        last_log_time = 0.0
        last_wait_log_time = 0.0
        while True:
            try:
                # 1. Shutdown trigger
                if check_shutdown_trigger(STRATEGY_KEY):
                    self._shutdown_and_exit("UI Shutdown Request in main loop")

                # 2. EOD
                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    self._flatten("EOD Auto-Exit")
                    logger.info("Past EOD time (%s). Stopping.", self.eod_time)
                    self._unsubscribe_ws()
                    self.save_state(status="STOPPED")
                    break

                pnl_priced = self._refresh_ltp()

                # 3 & 4. Daily target / stop — the only signal-independent way the
                # always-on cycle ends before EOD. Skipped while the position is
                # unpriced, so a missing quote can never masquerade as a full loss.
                if pnl_priced:
                    total_pnl = self.cumulative_pnl + self.position_pnl
                    if total_pnl >= self.target_profit:
                        self._flatten(f"Daily target reached: {total_pnl:.2f} >= {self.target_profit:.2f}")
                        self._unsubscribe_ws()
                        self.save_state(status="STOPPED")
                        logger.info("Daily profit target hit. Day P&L: %.2f. Stopping.", self.cumulative_pnl)
                        break
                    if total_pnl <= -self.stop_loss:
                        self._flatten(f"Daily stop-loss hit: {total_pnl:.2f} <= -{self.stop_loss:.2f}")
                        self._unsubscribe_ws()
                        self.save_state(status="STOPPED")
                        logger.info("Daily stop-loss hit. Day P&L: %.2f. Stopping.", self.cumulative_pnl)
                        break

                # 5. Per-trade stop / trail. Gated on pnl_priced for the same reason
                # the daily caps are: get_ltp() returns 0.0 on failure, and a 0.0 LTP
                # is below every long stop and above every short one.
                if self.direction != "NONE" and pnl_priced:
                    self._update_trailing_stop()
                    if stop_hit(self.direction, self.ltp, self.stop_level):
                        self._flatten(
                            f"Stop hit: LTP {self.ltp:.2f} through {self.stop_level:.2f} "
                            f"({self.stop_source})"
                        )
                        self.last_flip_ts = time.time()
                        self.save_state(status="SCANNING")
                        time.sleep(1)
                        continue

                # 6. Signal dispatch
                snap = self._read_snapshot()
                if snap is None:
                    if time.time() - last_wait_log_time >= self.poll_seconds:
                        logger.info("Waiting for the first Supertrend/EMA snapshot...")
                        last_wait_log_time = time.time()
                    self.save_state(status="SCANNING")
                    time.sleep(1)
                    continue

                want = self.desired()
                now_s = time.time()
                if self.direction == "NONE":
                    # Back off after a failed entry: without this a broker that keeps
                    # rejecting (margin, contract, rate limit) would be hit once per
                    # second for the rest of the session.
                    if want != "NONE" and now_s >= self._entry_retry_at:
                        if self.enter_position(want):
                            self.last_flip_ts = now_s
                        else:
                            self._entry_retry_at = now_s + self.entry_retry_seconds
                            logger.warning(
                                "Entry failed — retrying in %ds.", self.entry_retry_seconds
                            )
                elif want != self.direction:
                    # Supertrend and EMA cross each other regularly. When they nearly
                    # coincide the hold-zone collapses to a point and a price ticking
                    # across it would flip a live position every second, so require a
                    # minimum gap between flips.
                    if now_s - self.last_flip_ts < self.flip_cooldown:
                        if now_s - self._last_cooldown_log >= 10.0:
                            logger.info(
                                "Flip to %s suppressed: %.0fs since the last flip (cooldown %ds).",
                                want, now_s - self.last_flip_ts, self.flip_cooldown
                            )
                            self._last_cooldown_log = now_s
                    elif self.allow_reverse:
                        self.reverse_position(want)
                        self.last_flip_ts = now_s
                    else:
                        self._flatten(f"Signal flip to {want} (--no-reverse: staying flat)")
                        self.last_flip_ts = now_s

                self.save_state(status="RUNNING" if self.direction != "NONE" else "SCANNING")

                now_ts = time.time()
                if now_ts - last_log_time >= 30:
                    logger.info(
                        "[MONITOR] Dir: %s | Entry: %.2f | LTP: %.2f | Stop: %.2f (%s) | "
                        "ST: %.2f | EMA%d: %.2f | ATR: %.2f | Trades: %d | Pos P&L: %.2f | "
                        "Day P&L: %.2f (T:+%.0f/S:-%.0f)",
                        self.direction, self.entry_price, self.ltp,
                        self.stop_level, self.stop_source or "-",
                        snap.st, self.ema_length, snap.ema, snap.atr, self.trades_today,
                        self.position_pnl, self.cumulative_pnl + self.position_pnl,
                        self.target_profit, self.stop_loss,
                    )
                    last_log_time = now_ts

                time.sleep(1)

            except SystemExit:
                raise
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
        description="MCX CrudeOilM EMA + Supertrend Always-On Futures Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Rule:
  LONG   when price is above BOTH the Supertrend and EMA20
  SHORT  when price is below BOTH
  HOLD   the current position while price sits between them (hysteresis)

Examples:
  # Dry run (default), 5 lots, Supertrend(7,2) + EMA20 on 5-min candles
  python strategies/crudeoil/crudeoilm_ema_supertrend.py

  # Live trading, 5 lots, +/- 10000 INR daily caps
  python strategies/crudeoil/crudeoilm_ema_supertrend.py --live --lots 5 --target-profit 10000 --stop-loss 10000

  # Exit to flat on a flip instead of reversing, using confirmed closes only
  python strategies/crudeoil/crudeoilm_ema_supertrend.py --no-reverse --exit-on-close
""",
    )
    parser.add_argument("--live", action="store_true", default=False,
                        help="Enable live trading (default: dry run)")
    parser.add_argument("--lots", type=int, default=5,
                        help="Order quantity in LOTS, sent to the broker as-is (default: 5)")
    parser.add_argument("--contract-size", type=int, default=10,
                        help="Barrels per lot, used for P&L only (CRUDEOILM=10, CRUDEOIL=100; default: 10)")
    parser.add_argument("--interval", type=str, default="5",
                        help="Candle interval in minutes (default: 5)")
    parser.add_argument("--supertrend-period", type=int, default=7,
                        help="Supertrend ATR length (default: 7)")
    parser.add_argument("--supertrend-multiplier", type=float, default=2.0,
                        help="Supertrend ATR multiplier (default: 2)")
    parser.add_argument("--ema-length", type=int, default=20,
                        help="EMA length (default: 20)")
    parser.add_argument("--target-profit", type=float, default=5000.0,
                        help="Daily cumulative profit target in INR; flatten and stop (default: 5000)")
    parser.add_argument("--stop-loss", type=float, default=5000.0,
                        help="Daily cumulative stop-loss in INR (positive number); flatten and stop (default: 5000)")
    parser.add_argument("--start-time", type=str, default="09:00",
                        help="Session start time HH:MM IST (default: 09:00)")
    parser.add_argument("--eod-time", type=str, default="23:30",
                        help="End-of-day flatten time HH:MM IST (default: 23:30)")
    parser.add_argument("--poll-seconds", type=int, default=15,
                        help="Indicator refresh cadence in seconds (default: 15)")
    parser.add_argument("--days", type=int, default=3,
                        help="Candle lookback days for the indicator fetch (default: 3)")
    parser.add_argument("--no-reverse", action="store_true", default=False,
                        help="Exit to flat on a signal flip instead of reversing (disables always-on)")
    parser.add_argument("--exit-on-close", action="store_true", default=False,
                        help="Use the confirmed candle close for exits instead of the live LTP")
    parser.add_argument("--flip-cooldown", type=int, default=60,
                        help="Minimum seconds between position flips (default: 60). Guards against "
                             "tick-level thrash when the Supertrend and EMA nearly coincide")
    parser.add_argument("--atr-stop-mult", type=float, default=1.5,
                        help="Initial per-trade stop, in ATRs from the entry (default: 1.5; "
                             "0 disables the stop and the trail)")
    parser.add_argument("--trail-trigger-atr", type=float, default=1.0,
                        help="ATRs of open profit before the stop hands over to the Supertrend "
                             "band and starts ratcheting (default: 1.0)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")
    args = parser.parse_args()

    # Reject values that would silently brick the run rather than fail loudly:
    # a 0 target/stop trips on the very first tick (0 >= 0), a 0 quantity places
    # empty orders, and an unpadded "9:00" never compares >= as a string so the
    # EOD flatten would never fire.
    _hhmm = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
    problems = []
    if args.lots < 1:
        problems.append("--lots must be at least 1")
    if args.contract_size < 1:
        problems.append("--contract-size must be at least 1")
    if args.target_profit <= 0:
        problems.append("--target-profit must be greater than 0 (0 stops the strategy on the first tick)")
    if args.stop_loss == 0:
        problems.append("--stop-loss must be non-zero (0 stops the strategy on the first tick)")
    if args.supertrend_period < 2:
        problems.append("--supertrend-period must be at least 2")
    if args.supertrend_multiplier <= 0:
        problems.append("--supertrend-multiplier must be greater than 0")
    if args.ema_length < 2:
        problems.append("--ema-length must be at least 2")
    if args.poll_seconds < 1:
        problems.append("--poll-seconds must be at least 1")
    if args.days < 1:
        problems.append("--days must be at least 1")
    if args.flip_cooldown < 0:
        problems.append("--flip-cooldown cannot be negative")
    if args.atr_stop_mult < 0:
        problems.append("--atr-stop-mult cannot be negative")
    if args.trail_trigger_atr < 0:
        problems.append("--trail-trigger-atr cannot be negative")
    if not str(args.interval).isdigit() or int(args.interval) < 1:
        problems.append("--interval must be a positive whole number of minutes")
    # Which intervals Dhan actually serves is NOT a fixed list and is not worth
    # guessing: measured against CRUDEOILM on 2026-08-24, "3" works, "30" silently
    # returns 15-minute candles, and "60" returns nothing at all. So argparse only
    # checks the arithmetic; the real interval is VERIFIED against the candle spacing
    # at startup by _verify_interval().
    for flag, value in (("--start-time", args.start_time), ("--eod-time", args.eod_time)):
        if not _hhmm.match(value):
            problems.append(f"{flag} must be zero-padded 24h HH:MM (got {value!r})")
    if not problems and args.start_time >= args.eod_time:
        problems.append(
            f"--start-time ({args.start_time}) must be earlier than --eod-time ({args.eod_time})"
        )
    if problems:
        parser.error("; ".join(problems))

    if args.instance_id:
        STRATEGY_KEY = f"{STRATEGY_KEY}_{args.instance_id}"

    strat = CrudeOilMEmaSupertrendStrategy(
        dry_run=not args.live,
        lots=args.lots,
        contract_size=args.contract_size,
        interval=args.interval,
        supertrend_period=args.supertrend_period,
        supertrend_multiplier=args.supertrend_multiplier,
        ema_length=args.ema_length,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
        start_time=args.start_time,
        eod_time=args.eod_time,
        poll_seconds=args.poll_seconds,
        days=args.days,
        allow_reverse=not args.no_reverse,
        exit_on_close=args.exit_on_close,
        flip_cooldown=args.flip_cooldown,
        atr_stop_mult=args.atr_stop_mult,
        trail_trigger_atr=args.trail_trigger_atr,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt. Exiting cleanly.")
        strat._flatten("KeyboardInterrupt / Manual Stop")
        strat.save_state(status="STOPPED")
