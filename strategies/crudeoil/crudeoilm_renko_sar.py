import time
import sys
import argparse
import os
import math
import logging
import threading
from collections import namedtuple
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

# Adjust path to project root (two levels up from strategies/crudeoil/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, instance_log_suffix

# --- Constants ---
STRATEGY_KEY = "crudeoilm_renko_sar"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"
INSTRUMENT = "FUTCOM"
SEGMENT = "MCX_COMM"

# --- Logging Setup ---
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "crudeoil_renko")
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
# Renko brick construction (pure, close-only, standard 2x reversal rule)
# ---------------------------------------------------------------------------

Brick = namedtuple("Brick", ["direction", "open", "close", "ts"])  # direction: +1 green, -1 red


def build_renko(closes: List[Tuple[object, float]], box: float) -> List[Brick]:
    """Build a Renko brick series from (timestamp, close) pairs.

    Close-only bricks: highs/lows never form bricks. Anchor is the first close
    rounded down to a box multiple. A continuation brick needs a full `box`
    beyond the leading edge; a reversal needs 2x`box` (classic non-overlapping
    bricks). One candle spanning N boxes emits N bricks sharing its timestamp.
    """
    if not closes or box <= 0:
        return []

    anchor = math.floor(closes[0][1] / box) * box
    up_edge = anchor
    down_edge = anchor
    trend = 0  # 0 until the first brick prints
    bricks: List[Brick] = []

    for ts, c in closes:
        while True:
            if trend >= 0 and c >= up_edge + box:
                bricks.append(Brick(+1, up_edge, up_edge + box, ts))
                up_edge += box
                down_edge = up_edge - box
                trend = +1
            elif trend <= 0 and c <= down_edge - box:
                bricks.append(Brick(-1, down_edge, down_edge - box, ts))
                down_edge -= box
                up_edge = down_edge + box
                trend = -1
            elif trend == +1 and c <= up_edge - 2 * box:
                bricks.append(Brick(-1, up_edge - box, up_edge - 2 * box, ts))
                down_edge = up_edge - 2 * box
                up_edge = down_edge + box
                trend = -1
            elif trend == -1 and c >= down_edge + 2 * box:
                bricks.append(Brick(+1, down_edge + box, down_edge + 2 * box, ts))
                up_edge = down_edge + 2 * box
                down_edge = up_edge - box
                trend = +1
            else:
                break
    return bricks


def trailing_run(bricks: List[Brick]) -> Tuple[int, int]:
    """Return (direction, count) of the trailing same-color brick run."""
    if not bricks:
        return 0, 0
    tail_dir = bricks[-1].direction
    count = 0
    for b in reversed(bricks):
        if b.direction != tail_dir:
            break
        count += 1
    return tail_dir, count


def desired_direction(bricks: List[Brick], reverse_bricks: int, current: str) -> str:
    """SAR decision: initial entry follows the latest brick color; an open
    position flips only after `reverse_bricks` consecutive opposite bricks."""
    if not bricks:
        return "NONE"
    if current == "NONE":
        return "LONG" if bricks[-1].direction == +1 else "SHORT"
    tail_dir, tail_count = trailing_run(bricks)
    tail_name = "LONG" if tail_dir == +1 else "SHORT"
    if tail_name != current and tail_count >= reverse_bricks:
        return tail_name
    return current


class CrudeOilMRenkoSARStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        qty: int = 10,
        box_size: float = 5.0,
        reverse_bricks: int = 3,
        interval: str = "5",
        days: int = 5,
        poll_seconds: int = 15,
        start_time: str = "09:00",
        eod_time: str = "23:30",
    ):
        self.dry_run = dry_run
        self.qty = qty
        self.box_size = box_size
        self.reverse_bricks = reverse_bricks
        self.interval = interval
        self.days = days
        self.poll_seconds = poll_seconds
        self.start_time = start_time
        self.eod_time = eod_time

        # Instance state
        self.security_id: Optional[str] = None
        self.expiry: Optional[str] = None
        self.lot_size: int = 10  # MCX crude mini default — used only to sanity-check qty
        self.direction: str = "NONE"   # "LONG", "SHORT", or "NONE"
        self.entry_price: float = 0.0
        self.entry_time: Optional[datetime] = None
        self.ltp: float = 0.0
        self.position_pnl: float = 0.0    # unrealized P&L of current open position
        self.cumulative_pnl: float = 0.0  # sum of all closed position P&Ls today
        self.bricks: List[Brick] = []
        self.pinned_start_ts = None       # first candle ts seen — pins the Renko anchor
        self.last_brick_ts: Optional[str] = None

        # Init DhanHelper
        dhan = get_dhan_client()
        self.helper = DhanHelper(dhan)

        # Background brick poller: owns the candle fetch + build_renko work
        # (every poll_seconds) so the main loop can tick at 1s for shutdown,
        # EOD and P&L checks without stalling on network/CPU.
        self._bricks_thread = None

    # ------------------------------------------------------------------
    # Renko series
    # ------------------------------------------------------------------

    def _bricks_poller_loop(self):
        """Daemon thread: rebuild the Renko series every poll_seconds.

        Only this thread calls get_bricks(), so its mutations of
        self.bricks / pinned_start_ts / last_brick_ts stay single-threaded;
        the main loop just reads the latest self.bricks list reference.
        """
        while True:
            try:
                self.get_bricks()
            except Exception as e:
                logger.error("Brick poller error: %s", e)
            time.sleep(self.poll_seconds)

    def _start_bricks_poller(self):
        if self._bricks_thread is None or not self._bricks_thread.is_alive():
            self._bricks_thread = threading.Thread(
                target=self._bricks_poller_loop, daemon=True, name="renko-bricks-poller"
            )
            self._bricks_thread.start()
            logger.info("Background Renko brick poller started (every %ds).", self.poll_seconds)

    def get_bricks(self) -> List[Brick]:
        """Fetch 5-min candles, keep only fully closed ones, rebuild the brick series."""
        df = self.helper.get_latest_candles(SYMBOL, interval=self.interval, days=self.days)
        if df is None or df.empty:
            return self.bricks

        # Pin the window start so the anchor (and hence the whole brick series)
        # is stable across polls even though the API window rolls forward.
        if self.pinned_start_ts is None:
            self.pinned_start_ts = df.index[0]
        else:
            df = df[df.index >= self.pinned_start_ts]
            if df.empty:
                # Window rolled past the pin (e.g. very long run) — re-pin.
                logger.warning("Candle window rolled past pinned anchor. Re-pinning Renko series.")
                self.pinned_start_ts = None
                return self.bricks

        # Drop the in-progress candle: a candle is closed once its start + interval has passed
        interval_min = int(self.interval)
        cutoff = datetime.now() - timedelta(minutes=interval_min)
        df = df[df.index <= cutoff]
        if df.empty:
            return self.bricks

        closes = list(zip(df.index, df["Close"].astype(float)))
        bricks = build_renko(closes, self.box_size)
        self.bricks = bricks

        if bricks:
            newest_ts = str(bricks[-1].ts)
            if newest_ts != self.last_brick_ts:
                tail_dir, tail_count = trailing_run(bricks)
                new_count = sum(1 for b in bricks if str(b.ts) == newest_ts)
                logger.info(
                    "[BRICK] +%d brick(s) @ %s | last: %s %.2f->%.2f | total: %d | trailing run: %d %s",
                    new_count, newest_ts,
                    "GREEN" if bricks[-1].direction == +1 else "RED",
                    bricks[-1].open, bricks[-1].close, len(bricks),
                    tail_count, "GREEN" if tail_dir == +1 else "RED",
                )
                self.last_brick_ts = newest_ts
        return bricks

    def _consecutive_opposite(self) -> int:
        """Trailing opposite-color brick count relative to the open position."""
        if self.direction == "NONE" or not self.bricks:
            return 0
        tail_dir, tail_count = trailing_run(self.bricks)
        tail_name = "LONG" if tail_dir == +1 else "SHORT"
        return tail_count if tail_name != self.direction else 0

    # ------------------------------------------------------------------
    # Entry
    # ------------------------------------------------------------------

    def enter_position(self, direction: str) -> bool:
        """Open a futures position. Returns True on success."""
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
            self.entry_price = ltp if ltp > 0 else (self.bricks[-1].close if self.bricks else 5000.0)
            logger.info("[DRY RUN] Simulating %s entry @ %.2f", direction, self.entry_price)

        self.direction = direction
        self.entry_time = datetime.now()
        self.position_pnl = 0.0
        logger.info(
            "Entered %s @ %.2f | Qty: %d | Box: %.1f | Reverse after %d opposite bricks | Expiry: %s",
            direction, self.entry_price, self.qty, self.box_size, self.reverse_bricks, self.expiry
        )
        return True

    # ------------------------------------------------------------------
    # Exit
    # ------------------------------------------------------------------

    def _exit_position(self, reason: str) -> float:
        """Exit the current position. Returns realized P&L from the actual fill price."""
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

        if exit_price > 0 and self.entry_price > 0:
            if self.direction == "LONG":
                realized_pnl = (exit_price - self.entry_price) * self.qty
            else:
                realized_pnl = (self.entry_price - exit_price) * self.qty
        else:
            realized_pnl = self.position_pnl  # fallback: last LTP-based estimate
        logger.info("Realized P&L: %.2f (entry %.2f -> exit %.2f, qty %d)", realized_pnl, self.entry_price, exit_price, self.qty)

        self.direction = "NONE"
        self.entry_price = 0.0
        self.entry_time = None
        self.position_pnl = 0.0
        return realized_pnl

    # ------------------------------------------------------------------
    # Reverse (SAR)
    # ------------------------------------------------------------------

    def reverse_position(self, new_direction: str) -> None:
        """Stop-and-reverse: close the current position, immediately open the opposite one."""
        opp = self._consecutive_opposite()
        color = "RED" if new_direction == "SHORT" else "GREEN"
        realized = self._exit_position(f"SAR reversal: {opp} consecutive {color} bricks")
        self.cumulative_pnl += realized
        self.save_state(status="REVERSING")
        if not self.enter_position(new_direction):
            # Stay flat; the next poll re-derives the desired direction from the
            # brick series and retries the entry automatically.
            logger.critical("SAR reversal entry FAILED — flat until next poll retries.")

    # ------------------------------------------------------------------
    # State Persistence
    # ------------------------------------------------------------------

    def save_state(self, status: str = "RUNNING") -> None:
        tail_dir, _ = trailing_run(self.bricks)
        save_strategy_state(STRATEGY_KEY, {
            "strategy": STRATEGY_KEY,
            "status": status,
            "dry_run": self.dry_run,
            "symbol": SYMBOL,
            "interval": self.interval,
            "box_size": self.box_size,
            "reverse_bricks": self.reverse_bricks,
            "direction": self.direction,
            "entry_price": round(self.entry_price, 2),
            "ltp": round(self.ltp, 2),
            "qty": self.qty,
            "brick_count": len(self.bricks),
            "last_brick_color": ("GREEN" if tail_dir == +1 else "RED") if self.bricks else "",
            "last_brick_close": round(self.bricks[-1].close, 2) if self.bricks else 0.0,
            "consecutive_opposite": self._consecutive_opposite(),
            "position_pnl": round(self.position_pnl, 2),
            "daily_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "total_pnl": round(self.cumulative_pnl + self.position_pnl, 2),
            "start_time": self.start_time,
            "eod_time": self.eod_time,
            "expiry": self.expiry or "",
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
        # Master list LOT_SIZE for MCX shows 1 (Dhan convention); keep hardcoded default of 10 barrels/lot
        try:
            lot_from_master = int(float(future.get("LOT_SIZE", 1)))
            self.lot_size = lot_from_master if lot_from_master > 1 else self.lot_size
        except (ValueError, TypeError):
            pass
        if self.qty % self.lot_size != 0:
            nearest_lo = (self.qty // self.lot_size) * self.lot_size
            nearest_hi = nearest_lo + self.lot_size
            logger.warning(
                "Quantity %d is not a multiple of the MCX lot size (%d). "
                "The broker will reject this order — use %d or %d instead.",
                self.qty, self.lot_size, nearest_lo, nearest_hi
            )

    # ------------------------------------------------------------------
    # MCX Session Wait
    # ------------------------------------------------------------------

    def _wait_for_mcx_session(self) -> None:
        """Wait for MCX session window using time-only check (no weekday or holiday filter)."""
        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                self.save_state(status="STOPPED")
                sys.exit(0)
            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.eod_time:
                return  # let outer loop handle EOD
            if now_str >= self.start_time:
                return  # session is open
            next_check = 60 if not self.dry_run else 5
            logger.info("Waiting for MCX session to open (%s IST). Current: %s", self.start_time, now_str)
            time.sleep(next_check)

    def _shutdown_and_exit(self, reason: str) -> None:
        logger.info(reason)
        if self.direction != "NONE":
            realized = self._exit_position(reason)
            self.cumulative_pnl += realized
        self._unsubscribe_ws()
        self.save_state(status="STOPPED")
        sys.exit(0)

    def _unsubscribe_ws(self) -> None:
        if not self.security_id:
            return
        try:
            self.helper.unsubscribe_instruments([(SEGMENT, self.security_id, 15)])
        except Exception as e:
            logger.warning("WebSocket unsubscribe failed (non-fatal): %s", e)

    # ------------------------------------------------------------------
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        mode = "LIVE" if not self.dry_run else "DRY RUN"
        print(
            f"\n{'='*60}\n"
            f"  CrudeOilM Renko Stop-and-Reverse Strategy\n"
            f"  Mode        : {mode}\n"
            f"  Candles     : {self.interval}m (close-only Renko)\n"
            f"  Box Size    : {self.box_size}\n"
            f"  Reverse     : {self.reverse_bricks} consecutive opposite bricks\n"
            f"  Session     : {self.start_time} – {self.eod_time} IST\n"
            f"  Quantity    : {self.qty} (MCX lot size: {self.lot_size})\n"
            f"{'='*60}\n"
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

        self._start_bricks_poller()

        last_log_time = 0.0
        last_scan_log_time = 0.0
        while True:
            try:
                if check_shutdown_trigger(STRATEGY_KEY):
                    self._shutdown_and_exit("UI Shutdown Request in main loop")

                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    if self.direction != "NONE":
                        realized = self._exit_position("EOD Auto-Exit")
                        self.cumulative_pnl += realized
                    logger.info("Past EOD time (%s). Stopping.", self.eod_time)
                    self._unsubscribe_ws()
                    self.save_state(status="STOPPED")
                    break

                # Latest snapshot from the background poller (refreshed every poll_seconds)
                bricks = self.bricks
                if not bricks:
                    if time.time() - last_scan_log_time >= self.poll_seconds:
                        logger.info("No Renko bricks yet (waiting for price to travel one full box).")
                        last_scan_log_time = time.time()
                    self.save_state(status="SCANNING")
                    time.sleep(1)
                    continue

                want = desired_direction(bricks, self.reverse_bricks, self.direction)
                if self.direction == "NONE":
                    self.enter_position(want)
                elif want != self.direction:
                    self.reverse_position(want)

                # Update LTP / unrealized P&L. At 1s cadence only consult the
                # WebSocket cache; fall back to REST at the old poll_seconds
                # cadence so the REST rate does not increase vs the 15s loop.
                ltp = 0.0
                if self.security_id:
                    if str(self.security_id) in self.helper.live_data:
                        ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
                    elif time.time() - getattr(self, "_last_rest_ltp_ts", 0.0) >= self.poll_seconds:
                        ltp = self.helper.get_ltp(self.security_id, exchange=SEGMENT, instrument=INSTRUMENT)
                        self._last_rest_ltp_ts = time.time()
                if ltp > 0:
                    self.ltp = ltp
                    if self.direction == "LONG":
                        self.position_pnl = (ltp - self.entry_price) * self.qty
                    elif self.direction == "SHORT":
                        self.position_pnl = (self.entry_price - ltp) * self.qty

                self.save_state(status="RUNNING")

                now_ts = time.time()
                if now_ts - last_log_time >= 30:
                    tail_dir, tail_count = trailing_run(bricks)
                    logger.info(
                        "[MONITOR] Dir: %s | Entry: %.2f | LTP: %.2f | Bricks: %d | Last run: %d %s | Opp: %d/%d | Pos P&L: %.2f | Day P&L: %.2f",
                        self.direction, self.entry_price, self.ltp, len(bricks),
                        tail_count, "GREEN" if tail_dir == +1 else "RED",
                        self._consecutive_opposite(), self.reverse_bricks,
                        self.position_pnl, self.cumulative_pnl + self.position_pnl,
                    )
                    last_log_time = now_ts

                # 1s cadence: brick refresh happens on the poller thread, so the
                # loop stays responsive to shutdown/EOD/reversals between polls.
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
        description="MCX CrudeOilM Renko Stop-and-Reverse Futures Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default), 1 lot (10 barrels), 5-pt bricks, flip on 3 opposite bricks
  python strategies/crudeoil/crudeoilm_renko_sar.py

  # Live trading, 2 lots (20 barrels)
  python strategies/crudeoil/crudeoilm_renko_sar.py --live --qty 20

  # Wider bricks, faster flips
  python strategies/crudeoil/crudeoilm_renko_sar.py --box-size 10 --reverse-bricks 2
""",
    )
    parser.add_argument("--live", action="store_true", default=False,
                        help="Enable live trading (default: dry run)")
    parser.add_argument("--qty", type=int, default=10,
                        help="Order quantity in barrels (MCX CRUDEOILM lot size is 10; default: 10 = 1 lot)")
    parser.add_argument("--box-size", type=float, default=5.0,
                        help="Renko box size in points (default: 5)")
    parser.add_argument("--reverse-bricks", type=int, default=3,
                        help="Consecutive opposite bricks required to stop-and-reverse (default: 3)")
    parser.add_argument("--interval", type=str, default="5",
                        help="Source candle interval in minutes (default: 5)")
    parser.add_argument("--days", type=int, default=5,
                        help="Candle lookback days for the Renko series (default: 5, helper minimum)")
    parser.add_argument("--poll-seconds", type=int, default=15,
                        help="Main loop poll cadence in seconds (default: 15)")
    parser.add_argument("--start-time", type=str, default="09:00",
                        help="Session start time HH:MM IST (default: 09:00)")
    parser.add_argument("--eod-time", type=str, default="23:30",
                        help="End-of-day flatten time HH:MM IST (default: 23:30)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")
    args = parser.parse_args()
    if args.instance_id:
        STRATEGY_KEY = f"{STRATEGY_KEY}_{args.instance_id}"

    strat = CrudeOilMRenkoSARStrategy(
        dry_run=not args.live,
        qty=args.qty,
        box_size=args.box_size,
        reverse_bricks=args.reverse_bricks,
        interval=args.interval,
        days=args.days,
        poll_seconds=args.poll_seconds,
        start_time=args.start_time,
        eod_time=args.eod_time,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt. Exiting cleanly.")
        if strat.direction != "NONE":
            realized = strat._exit_position("KeyboardInterrupt / Manual Stop")
            strat.cumulative_pnl += realized
        strat.save_state(status="STOPPED")
        sys.exit(0)
