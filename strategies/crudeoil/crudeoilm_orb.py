"""
MCX CRUDEOILM Opening Range Breakout (ORB) with pivot-based structure stop.

The opening range (first `--or-minutes` of the session) gives the entry level; the
pivot module gives the exit. Pivots deliberately do NOT drive the entry -- the opening
range is a time-based level and needs no swing detection. What pivots add is:

  1. A TRAILING STOP that follows market structure. Once long, the stop ratchets up to
     each newly confirmed pivot low, so the position exits when the uptrend's structure
     actually breaks rather than at an arbitrary fixed distance.
  2. A BREAKOUT FILTER. A break of the opening range high that does not also clear the
     most recent pivot high is price poking through a clock boundary, not through a
     level anyone defended.

TWO-STAGE STOP -- the important part. A pivot needs `n` candles on each side plus the
forming-candle discard, so the first pivot of the session confirms well after the ORB
entry fires. Until one exists the stop is the opposite edge of the opening range; the
pivot stop takes over the moment structure appears and never gives ground after that.

See strategies/crudeoil/strategy.md and docs/PIVOT_DETECTION.md.
"""
import time
import sys
import argparse
import os
import json
import logging
import threading
import pandas as pd
from datetime import datetime, time as dtime
from typing import Optional, Tuple

# Adjust path to project root (two levels up from strategies/crudeoil/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.pivots import PivotTracker
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, instance_log_suffix

# --- Constants ---
STRATEGY_KEY = "crudeoilm_orb"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"
INSTRUMENT = "FUTCOM"
SEGMENT = "MCX_COMM"

# Dhan's intraday endpoint accepts only these. A value outside the set comes back as an
# API error -> empty DataFrame -> the strategy would silently never see a candle.
VALID_INTERVALS = ["1", "5", "15", "25", "60"]

# --- Logging Setup ---
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "crudeoil_orb")
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
# Pure decision logic
#
# Deliberately module-level and broker-free so tests/test_orb_logic.py can drive
# every branch without a Dhan session. Keep them free of self / network / clock.
# ---------------------------------------------------------------------------

def parse_hhmm(value: str) -> dtime:
    """'09:00' -> datetime.time(9, 0). Raises ValueError on anything else."""
    hh, mm = value.split(":")
    return dtime(int(hh), int(mm))


def window_end(start: dtime, minutes: int) -> dtime:
    """End of a window `minutes` after `start`, clamped within the same day."""
    total = start.hour * 60 + start.minute + minutes
    total = min(total, 24 * 60 - 1)
    return dtime(total // 60, total % 60)


def compute_opening_range(
    df: Optional[pd.DataFrame],
    session_start: dtime,
    or_minutes: int,
    ref_date=None,
) -> Tuple[float, float, int]:
    """Highest high / lowest low of the candles inside the opening-range window.

    A candle belongs to the window when `session_start <= its timestamp < end`. The
    timestamp is the candle's OPEN time, so on a 5-minute series with a 15-minute
    window that is exactly the 09:00, 09:05 and 09:10 bars.

    Args:
        df:            OHLC frame indexed by tz-naive IST datetimes.
        ref_date:      Which session to measure. Defaults to the date of the last row,
                       which is what a live loop wants; tests pass it explicitly.

    Returns:
        `(orh, orl, bar_count)`. `(0.0, 0.0, 0)` when the frame is empty or no candle
        falls inside the window -- callers must treat a zero range as "not ready",
        never as a real level.
    """
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return 0.0, 0.0, 0
    if "High" not in df.columns or "Low" not in df.columns:
        return 0.0, 0.0, 0

    end = window_end(session_start, or_minutes)
    if ref_date is None:
        ref_date = df.index[-1].date()

    mask = [
        (ts.date() == ref_date and session_start <= ts.time() < end)
        for ts in df.index
    ]
    window = df[mask]
    if window.empty:
        return 0.0, 0.0, 0
    return float(window["High"].max()), float(window["Low"].min()), len(window)


def breakout_signal(
    close: float,
    orh: float,
    orl: float,
    last_pivot_high: Optional[float] = None,
    last_pivot_low: Optional[float] = None,
    use_filter: bool = True,
) -> Tuple[str, str]:
    """Decide a breakout from one closed candle. Returns `(signal, reason)`.

    Signal is LONG / SHORT / NEUTRAL. The decision is on the CLOSE, never on the high
    or low -- a wick through the range that closes back inside is the single most
    common ORB false trigger.

    When `use_filter` is on, a long additionally requires the close to clear the most
    recent pivot high. `last_pivot_high=None` means no pivot has confirmed yet (early
    session), and the filter is skipped rather than blocking every trade -- otherwise
    the strategy could not trade at all before the first pivot forms.
    """
    if orh <= 0 or orl <= 0:
        return "NEUTRAL", "opening range not ready"

    if close > orh:
        if use_filter and last_pivot_high is not None and close <= last_pivot_high:
            return "NEUTRAL", (
                f"close {close:.2f} cleared ORH {orh:.2f} but not pivot high {last_pivot_high:.2f}"
            )
        why = "no pivot yet, filter skipped" if last_pivot_high is None else "cleared ORH and pivot high"
        return "LONG", f"close {close:.2f} > ORH {orh:.2f} ({why})"

    if close < orl:
        if use_filter and last_pivot_low is not None and close >= last_pivot_low:
            return "NEUTRAL", (
                f"close {close:.2f} broke ORL {orl:.2f} but not pivot low {last_pivot_low:.2f}"
            )
        why = "no pivot yet, filter skipped" if last_pivot_low is None else "cleared ORL and pivot low"
        return "SHORT", f"close {close:.2f} < ORL {orl:.2f} ({why})"

    return "NEUTRAL", f"close {close:.2f} inside range [{orl:.2f}, {orh:.2f}]"


def ratchet_stop(direction: str, current_stop: float, pivot_price: Optional[float]) -> float:
    """Tighten the stop toward a newly confirmed pivot. Never loosens it.

    For a LONG the stop only moves UP; a pivot low that forms below the current stop is
    ignored. Without this a mid-trend pullback would hand back profit already locked in.
    An unset (`<= 0`) stop adopts the pivot outright.
    """
    if pivot_price is None or pivot_price <= 0:
        return current_stop
    if current_stop <= 0:
        return float(pivot_price)
    if direction == "LONG":
        return max(current_stop, float(pivot_price))
    if direction == "SHORT":
        return min(current_stop, float(pivot_price))
    return current_stop


def stop_hit(direction: str, ltp: float, stop_level: float) -> bool:
    """Has price traded through the stop?"""
    if stop_level <= 0 or ltp <= 0:
        return False
    if direction == "LONG":
        return ltp < stop_level
    if direction == "SHORT":
        return ltp > stop_level
    return False


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class CrudeOilMORBStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        interval: str = "5",
        or_minutes: int = 15,
        session_start: str = "09:00",
        eod_time: str = "23:30",
        pivot_n: int = 5,
        pivot_interval: str = "1",
        use_pivot_filter: bool = True,
        allow_reentry: bool = False,
        target_profit: float = 3000.0,
        stop_loss: float = 3000.0,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.interval = interval
        self.or_minutes = or_minutes
        self.session_start = parse_hhmm(session_start)
        self.session_start_str = session_start
        self.range_end = window_end(self.session_start, or_minutes)
        self.eod_time = eod_time
        self.pivot_n = pivot_n
        self.pivot_interval = pivot_interval
        self.use_pivot_filter = use_pivot_filter
        self.allow_reentry = allow_reentry
        self.target_profit = target_profit
        self.stop_loss = stop_loss

        # Contract / position state
        self.security_id: Optional[str] = None
        self.expiry: Optional[str] = None
        self.lot_size: int = 10  # MCX crude mini default; master list reports LOT_SIZE=1
        self.qty: int = 0
        self.direction: str = "NONE"
        self.entry_price: float = 0.0
        self.entry_time: Optional[datetime] = None
        self.ltp: float = 0.0
        self.position_pnl: float = 0.0
        self.cumulative_pnl: float = 0.0

        # ORB state
        self.orh: float = 0.0
        self.orl: float = 0.0
        self.range_bars: int = 0
        self.range_locked: bool = False
        self.taken_long: bool = False
        self.taken_short: bool = False
        self.stop_level: float = 0.0
        self.stop_source: str = "NONE"   # "RANGE" or "PIVOT" — surfaced in state for the UI
        self.range_date: Optional[str] = None
        self.last_processed_candle_time: Optional[str] = None

        # Pivot tracking on its own (faster) series
        self.tracker = PivotTracker(n=self.pivot_n, maxlen=5)
        self._primed = False

        dhan = get_dhan_client()
        self.helper = DhanHelper(dhan)

        # Background pivot-refresh thread. While a position is open the 1s stop loop
        # must never block on a REST candle fetch, so the refresh runs off-loop and
        # publishes a snapshot. Same shape as crudeoilm_supertrend's ST poller.
        self._pivot_lock = threading.Lock()
        self._pivot_snapshot: Optional[Tuple[Optional[float], Optional[float]]] = None
        self._pivot_thread = None
        self._pivot_active = threading.Event()

    # ------------------------------------------------------------------
    # Pivots
    # ------------------------------------------------------------------

    def refresh_pivots(self) -> Tuple[Optional[float], Optional[float]]:
        """Fetch the pivot series and feed the tracker. Returns (last_high, last_low) prices."""
        df = self.helper.get_latest_candles(SYMBOL, interval=self.pivot_interval, days=2)
        if df is None or df.empty:
            # Dhan returns empty on API failure rather than raising — distinguish the two,
            # otherwise a DH-902 lapse reads as "this instrument has no swing points".
            if getattr(self.helper, "last_api_error", None):
                logger.warning("Pivot candle fetch failed: %s", self.helper.last_api_error)
            return self._snapshot_prices()

        if not self._primed:
            absorbed = self.tracker.prime(df)
            self._primed = True
            logger.info(
                "Primed %d historical pivots on %sm series (no entry signals fired for them).",
                absorbed, self.pivot_interval,
            )
        else:
            for p in self.tracker.update(df):
                logger.info("[PIVOT] %s @ %.2f (%s)", p.type, p.price, p.timestamp)

        high = self.tracker.latest_high()
        low = self.tracker.latest_low()
        prices = (high.price if high else None, low.price if low else None)
        with self._pivot_lock:
            self._pivot_snapshot = prices
        return prices

    def _snapshot_prices(self) -> Tuple[Optional[float], Optional[float]]:
        with self._pivot_lock:
            return self._pivot_snapshot or (None, None)

    def _pivot_poller_loop(self) -> None:
        interval_min = int(self.pivot_interval)
        last_candle = ""
        while True:
            if self._pivot_active.is_set():
                now = datetime.now()
                candle_mark = f"{now.strftime('%Y-%m-%d %H:')}{(now.minute // interval_min) * interval_min:02d}"
                if candle_mark != last_candle:
                    try:
                        self.refresh_pivots()
                        last_candle = candle_mark
                    except Exception as e:
                        logger.error("Pivot poller error: %s", e)
            time.sleep(2)

    def _start_pivot_poller(self) -> None:
        if self._pivot_thread is None or not self._pivot_thread.is_alive():
            self._pivot_thread = threading.Thread(
                target=self._pivot_poller_loop, daemon=True, name="orb-pivot-poller"
            )
            self._pivot_thread.start()
            logger.info("Background pivot refresh thread started.")

    # ------------------------------------------------------------------
    # Opening Range
    # ------------------------------------------------------------------

    def _throttled_wait_log(self, message: str, every_seconds: float = 300.0) -> None:
        """Log an idle-state reason at most once per `every_seconds`.

        The outer loop retries every 10-30s; without throttling a closed-market day would
        write thousands of identical lines. Silence is worse than repetition, so the first
        occurrence always prints.
        """
        now = time.time()
        if now - getattr(self, "_last_wait_log_ts", 0.0) >= every_seconds:
            logger.info("%s Waiting…", message)
            self._last_wait_log_ts = now

    def build_opening_range(self) -> bool:
        """Compute and, once the window has elapsed, freeze ORH/ORL. Idempotent."""
        today = datetime.now().strftime("%Y-%m-%d")
        if self.range_locked and self.range_date == today:
            return True

        # A new session invalidates yesterday's range and the once-per-side caps.
        if self.range_date is not None and self.range_date != today:
            logger.info("New session detected — resetting opening range and trade caps.")
            self.orh = self.orl = 0.0
            self.range_locked = False
            self.taken_long = self.taken_short = False
            self.stop_level = 0.0
            self.stop_source = "NONE"

        df = self.helper.get_latest_candles(SYMBOL, interval=self.interval, days=2)
        if df is None or df.empty:
            # An empty frame is Dhan's *silent* failure mode as well as its "market closed"
            # answer, so say which. Without this the strategy loops with zero log output and
            # looks indistinguishable from a hang.
            if getattr(self.helper, "last_api_error", None):
                logger.warning("Opening-range candle fetch failed: %s", self.helper.last_api_error)
            else:
                self._throttled_wait_log("No candles returned for %s (market closed or no data yet)." % SYMBOL)
            return False

        orh, orl, bars = compute_opening_range(
            df, self.session_start, self.or_minutes, ref_date=datetime.now().date()
        )
        if bars == 0:
            self._throttled_wait_log(
                "No candles yet inside the %s–%s opening-range window (latest bar: %s)."
                % (self.session_start_str, self.range_end.strftime("%H:%M"), df.index[-1])
            )
            return False

        self.orh, self.orl, self.range_bars = orh, orl, bars
        self.range_date = today

        # Freeze only once the clock is past the window — before that the range is still
        # forming and acting on it would trade a partial range.
        if datetime.now().time() >= self.range_end:
            self.range_locked = True
            logger.info(
                "Opening range LOCKED %s–%s: ORH %.2f / ORL %.2f (%d bars, width %.2f)",
                self.session_start_str, self.range_end.strftime("%H:%M"),
                self.orh, self.orl, self.range_bars, self.orh - self.orl,
            )
        else:
            logger.info(
                "Opening range forming: ORH %.2f / ORL %.2f (%d bars so far)",
                self.orh, self.orl, self.range_bars,
            )
        return self.range_locked

    # ------------------------------------------------------------------
    # Signal
    # ------------------------------------------------------------------

    def get_signal(self) -> Tuple[str, str]:
        """Evaluate the last CLOSED candle against the frozen range. (signal, reason)."""
        if not self.range_locked:
            return "NEUTRAL", "opening range not locked yet"

        df = self.helper.get_latest_candles(SYMBOL, interval=self.interval, days=2)
        if df is None or df.empty or len(df) < 2:
            if getattr(self.helper, "last_api_error", None):
                logger.warning("Signal candle fetch failed: %s", self.helper.last_api_error)
            return "NEUTRAL", "no candle data"

        # iloc[-2] is the last CONFIRMED close; iloc[-1] is still forming.
        row = df.iloc[-2]
        self.last_processed_candle_time = str(df.index[-2])
        close = float(row["Close"])

        piv_high, piv_low = self.refresh_pivots()
        signal, reason = breakout_signal(
            close, self.orh, self.orl, piv_high, piv_low, self.use_pivot_filter
        )

        if signal == "LONG" and self.taken_long and not self.allow_reentry:
            return "NEUTRAL", "long already taken today"
        if signal == "SHORT" and self.taken_short and not self.allow_reentry:
            return "NEUTRAL", "short already taken today"
        return signal, reason

    # ------------------------------------------------------------------
    # Entry
    # ------------------------------------------------------------------

    def enter_position(self, direction: str) -> bool:
        if check_shutdown_trigger(STRATEGY_KEY):
            logger.info("Shutdown triggered before entry.")
            return False

        future = self.helper.find_future(SYMBOL, exchange=EXCHANGE, instrument=INSTRUMENT)
        if future is None:
            logger.error("Could not find %s futures contract. Skipping entry.", SYMBOL)
            return False

        self.security_id = str(future.get("SECURITY_ID", ""))
        self.expiry = str(future.get("SM_EXPIRY_DATE", ""))
        try:
            lot_from_master = int(float(future.get("LOT_SIZE", 1)))
            self.lot_size = lot_from_master if lot_from_master > 1 else self.lot_size
        except (ValueError, TypeError):
            pass
        self.qty = self.lot_size * self.lots

        try:
            self.helper.start_websocket([(SEGMENT, self.security_id, 15)])
            time.sleep(2)
        except Exception as e:
            logger.warning("WebSocket subscribe failed (will use REST fallback): %s", e)

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
                # kill pending orders belonging to other strategies / instances.
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
            self.entry_price = ltp if ltp > 0 else 5000.0
            logger.info("[DRY RUN] Simulating %s entry @ %.2f", direction, self.entry_price)

        self.direction = direction
        self.entry_time = datetime.now()
        if direction == "LONG":
            self.taken_long = True
            self.stop_level = self.orl      # Stage 1: opposite edge of the opening range
        else:
            self.taken_short = True
            self.stop_level = self.orh
        self.stop_source = "RANGE"

        logger.info(
            "Entered %s @ %.2f | Initial stop %.2f (opening range edge) | Qty: %d | Expiry: %s",
            direction, self.entry_price, self.stop_level, self.qty, self.expiry,
        )
        return True

    # ------------------------------------------------------------------
    # Monitor
    # ------------------------------------------------------------------

    def update_trailing_stop(self) -> None:
        """Stage 2: hand the stop over to market structure once a pivot exists."""
        piv_high, piv_low = self._snapshot_prices()
        pivot = piv_low if self.direction == "LONG" else piv_high
        new_stop = ratchet_stop(self.direction, self.stop_level, pivot)
        if new_stop != self.stop_level:
            logger.info(
                "[STOP] %s → %.2f (pivot %s, was %s)",
                f"{self.stop_level:.2f}", new_stop,
                "low" if self.direction == "LONG" else "high", self.stop_source,
            )
            self.stop_level = new_stop
            self.stop_source = "PIVOT"

    def monitor_position(self) -> None:
        with self._pivot_lock:
            self._pivot_snapshot = None   # drop structure from the previous trade
        self._start_pivot_poller()
        self._pivot_active.set()
        try:
            self._monitor_position_loop()
        finally:
            self._pivot_active.clear()

    def _monitor_position_loop(self) -> None:
        last_log_time = 0.0
        while self.direction != "NONE":
            self.update_trailing_stop()

            if check_shutdown_trigger(STRATEGY_KEY):
                realized = self._exit_position("UI Shutdown Request")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                self.save_state(status="STOPPED")
                sys.exit(0)

            if datetime.now().strftime("%H:%M") >= self.eod_time:
                realized = self._exit_position("EOD Auto-Exit")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            # At 1s cadence prefer the WS cache; fall back to REST only every 3s so a
            # WS outage doesn't hammer the rate-limited quote API.
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

            if self.direction == "LONG":
                self.position_pnl = (ltp - self.entry_price) * self.qty
            else:
                self.position_pnl = (self.entry_price - ltp) * self.qty

            self.save_state()

            now_ts = time.time()
            if now_ts - last_log_time >= 30:
                total = self.cumulative_pnl + self.position_pnl
                logger.info(
                    "[MONITOR] Dir: %s | Entry: %.2f | LTP: %.2f | Stop: %.2f (%s) | Pos P&L: %.2f | Day P&L: %.2f",
                    self.direction, self.entry_price, ltp, self.stop_level,
                    self.stop_source, self.position_pnl, total,
                )
                last_log_time = now_ts

            total_day_pnl = self.cumulative_pnl + self.position_pnl

            if total_day_pnl >= self.target_profit:
                realized = self._exit_position(
                    f"Daily Profit Target Hit ({total_day_pnl:.2f} >= {self.target_profit:.2f})")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            if total_day_pnl <= -self.stop_loss:
                realized = self._exit_position(
                    f"Daily Stop Loss Hit ({total_day_pnl:.2f} <= -{self.stop_loss:.2f})")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            if stop_hit(self.direction, ltp, self.stop_level):
                realized = self._exit_position(
                    f"{self.stop_source} stop hit: LTP {ltp:.2f} vs stop {self.stop_level:.2f}")
                self.cumulative_pnl += realized
                self.position_pnl = 0.0
                break

            time.sleep(1)

    # ------------------------------------------------------------------
    # Exit
    # ------------------------------------------------------------------

    def _exit_position(self, reason: str) -> float:
        logger.warning("!!! EXITING: %s !!!", reason)

        exit_price = 0.0
        if not self.dry_run:
            if self.direction == "LONG":
                order_id = self.helper.sell(self.security_id, self.qty)
            else:
                order_id = self.helper.buy(self.security_id, self.qty)

            if order_id is None:
                logger.critical(
                    "Exit order placement FAILED for %s %s. Manual intervention required!",
                    self.direction, SYMBOL)
                sys.exit(1)

            self.helper.wait_for_fill(order_id, timeout=10)
            order_data = self.helper.get_order_by_id(order_id) or {}
            if order_data.get("orderStatus") != "TRADED":
                logger.critical(
                    "Exit order %s not confirmed as TRADED. Manual intervention required!", order_id)
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
            exit_price = self.ltp if self.ltp > 0 else self.helper.get_ltp(
                self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
            logger.info("[DRY RUN] Simulating exit of %s position @ %.2f", self.direction, exit_price)

        # Book P&L from the actual fill BEFORE resetting state.
        if exit_price > 0 and self.entry_price > 0:
            if self.direction == "LONG":
                realized_pnl = (exit_price - self.entry_price) * self.qty
            else:
                realized_pnl = (self.entry_price - exit_price) * self.qty
        else:
            realized_pnl = self.position_pnl
        logger.info(
            "Realized P&L: %.2f (entry %.2f → exit %.2f, qty %d)",
            realized_pnl, self.entry_price, exit_price, self.qty)

        try:
            self.helper.unsubscribe_instruments([(SEGMENT, self.security_id, 15)])
        except Exception as e:
            logger.warning("WebSocket unsubscribe failed (non-fatal): %s", e)

        self.direction = "NONE"
        self.entry_price = 0.0
        self.ltp = 0.0
        self.entry_time = None
        self.security_id = None
        self.expiry = None
        self.stop_level = 0.0
        self.stop_source = "NONE"
        return realized_pnl

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def save_state(self, status: str = "RUNNING") -> None:
        save_strategy_state(STRATEGY_KEY, {
            "strategy": STRATEGY_KEY,
            "status": status,
            "dry_run": self.dry_run,
            "symbol": SYMBOL,
            "interval": self.interval,
            "direction": self.direction,
            "entry_price": round(self.entry_price, 2),
            "ltp": round(self.ltp, 2),
            "qty": self.qty,
            "lots": self.lots,
            "orh": round(self.orh, 2),
            "orl": round(self.orl, 2),
            "range_locked": self.range_locked,
            "range_bars": self.range_bars,
            "or_minutes": self.or_minutes,
            "session_start": self.session_start_str,
            "stop_level": round(self.stop_level, 2),
            "stop_source": self.stop_source,
            "taken_long": self.taken_long,
            "taken_short": self.taken_short,
            "pivot_n": self.pivot_n,
            "pivot_interval": self.pivot_interval,
            "pivots": self.tracker.to_dict(),
            "daily_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "total_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "target_profit": self.target_profit,
            "stop_loss": self.stop_loss,
            "eod_time": self.eod_time,
            "expiry": self.expiry or "",
        })

    def _restore_daily_state(self) -> None:
        """Restore today's P&L and once-per-side caps after a process restart."""
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
            # Without these a restart would re-take a side already traded today.
            self.taken_long = bool(saved.get("taken_long", False))
            self.taken_short = bool(saved.get("taken_short", False))
            if self.taken_long or self.taken_short:
                logger.info("Restored trade caps: long=%s short=%s", self.taken_long, self.taken_short)
        except Exception as e:
            logger.warning("Could not restore state: %s", e)

    # ------------------------------------------------------------------
    # Contract / session helpers
    # ------------------------------------------------------------------

    def _ensure_contract_resolved(self) -> None:
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
        self._ensure_contract_resolved()
        if not self.security_id:
            return 0.0
        return self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)

    def _wait_for_session(self) -> None:
        """Wait for the MCX session window (time-only, no weekday/holiday filter)."""
        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                self.save_state(status="STOPPED")
                sys.exit(0)
            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.eod_time:
                return
            if now_str >= self.session_start_str:
                return
            logger.info("Waiting for MCX session (%s IST). Current: %s", self.session_start_str, now_str)
            time.sleep(60 if not self.dry_run else 5)

    # ------------------------------------------------------------------
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        mode = "LIVE" if not self.dry_run else "DRY RUN"
        print(
            f"\n{'='*64}\n"
            f"  CrudeOilM Opening Range Breakout + Pivot Structure Stop\n"
            f"  Mode         : {mode}\n"
            f"  Trade candles: {self.interval}m\n"
            f"  Opening range: {self.session_start_str}–{self.range_end.strftime('%H:%M')} "
            f"({self.or_minutes} min)\n"
            f"  Pivots       : n={self.pivot_n} on {self.pivot_interval}m candles "
            f"(~{(self.pivot_n + 1) * int(self.pivot_interval)} min confirmation lag)\n"
            f"  Entry filter : {'ON (must clear last pivot too)' if self.use_pivot_filter else 'OFF'}\n"
            f"  Re-entry     : {'unlimited' if self.allow_reentry else 'one trade per side per day'}\n"
            f"  Lots         : {self.lots} (qty per lot: {self.lot_size})\n"
            f"  EOD flat     : {self.eod_time} IST\n"
            f"{'='*64}\n"
        )
        # Restore BEFORE the first save_state, which overwrites the state file.
        self._restore_daily_state()
        self.save_state(status="INITIALIZING")

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(status="STOPPED")
                sys.exit(0)

            if datetime.now().strftime("%H:%M") >= self.eod_time:
                logger.info("Past EOD time (%s). Stopping.", self.eod_time)
                self.save_state(status="STOPPED")
                break

            try:
                self._wait_for_session()
                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    continue

                if self.cumulative_pnl >= self.target_profit:
                    logger.info("Daily profit target already reached (%.2f). Done for the day.", self.cumulative_pnl)
                    self.save_state(status="STOPPED")
                    break
                if self.cumulative_pnl <= -self.stop_loss:
                    logger.info("Daily stop loss already hit (%.2f). Done for the day.", self.cumulative_pnl)
                    self.save_state(status="STOPPED")
                    break

                self._ensure_contract_resolved()

                if not self.build_opening_range():
                    self.save_state(status="BUILDING_RANGE")
                    time.sleep(10 if self.dry_run else 30)
                    continue

                if self.taken_long and self.taken_short and not self.allow_reentry:
                    logger.info("Both sides traded today. Done.")
                    self.save_state(status="STOPPED")
                    break

                self.save_state(status="SCANNING")
                signal, reason = self.get_signal()

                if signal in ("LONG", "SHORT"):
                    logger.info("Signal: %s — %s", signal, reason)
                    if self.enter_position(signal):
                        self.monitor_position()
                else:
                    current_ltp = self._get_ltp_safe()
                    price_str = f" | LTP: {current_ltp:.2f}" if current_ltp > 0 else ""
                    logger.info("Signal: NEUTRAL — %s%s", reason, price_str)
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
        description="MCX CrudeOilM Opening Range Breakout with pivot-based structure stop",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default), 1 lot, 15-min opening range
  python strategies/crudeoil/crudeoilm_orb.py

  # Live, 2 lots, 30-min opening range
  python strategies/crudeoil/crudeoilm_orb.py --live --lots 2 --or-minutes 30

  # Wider structure stop (slower, fewer whipsaws)
  python strategies/crudeoil/crudeoilm_orb.py --pivot-interval 5 --pivot-n 3

  # Pure ORB — pivots trail the stop but do not gate entry
  python strategies/crudeoil/crudeoilm_orb.py --no-pivot-filter
""",
    )
    parser.add_argument("--live", action="store_true", default=False,
                        help="Enable live trading (default: dry run)")
    parser.add_argument("--lots", type=int, default=1,
                        help="Number of lots to trade (default: 1)")
    parser.add_argument("--interval", type=str, default="5", choices=VALID_INTERVALS,
                        help="Trading candle interval in minutes (default: 5)")
    parser.add_argument("--or-minutes", type=int, default=15,
                        help="Opening range width in minutes (default: 15)")
    parser.add_argument("--session-start", type=str, default="09:00",
                        help="Session/range start HH:MM IST (default: 09:00)")
    parser.add_argument("--eod-time", type=str, default="23:30",
                        help="End-of-day flat time HH:MM IST (default: 23:30)")
    parser.add_argument("--pivot-n", type=int, default=5,
                        help="Candles required each side of a pivot (default: 5)")
    parser.add_argument("--pivot-interval", type=str, default="1", choices=VALID_INTERVALS,
                        help="Candle interval for the pivot series (default: 1)")
    parser.add_argument("--no-pivot-filter", action="store_true", default=False,
                        help="Enter on the opening-range break alone; pivots only trail the stop")
    parser.add_argument("--allow-reentry", action="store_true", default=False,
                        help="Lift the one-trade-per-side-per-day cap")
    parser.add_argument("--target-profit", type=float, default=3000.0,
                        help="Daily profit target in INR (default: 3000)")
    parser.add_argument("--stop-loss", type=float, default=3000.0,
                        help="Daily stop loss in INR (default: 3000)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy")
    args = parser.parse_args()
    if args.instance_id:
        STRATEGY_KEY = f"{STRATEGY_KEY}_{args.instance_id}"

    strat = CrudeOilMORBStrategy(
        dry_run=not args.live,
        lots=args.lots,
        interval=args.interval,
        or_minutes=args.or_minutes,
        session_start=args.session_start,
        eod_time=args.eod_time,
        pivot_n=args.pivot_n,
        pivot_interval=args.pivot_interval,
        use_pivot_filter=not args.no_pivot_filter,
        allow_reentry=args.allow_reentry,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
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
