"""
Nifty VWAP Straddle Strategy

Sells the ATM straddle when:
  1. Combined premium (CE + PE) <= VWAP + entry_band  (price near/below running mean)
  2. Combined premium is declining over the last decline_ticks ticks
  3. CE/PE premium difference < max_premium_diff_pct

Exits when combined premium > VWAP + exit_buffer (stop-loss).

ATM shifts while in position are ignored — the strategy holds the current
strikes until a normal exit, then re-centers to the new ATM.

CLI args:
  --live                  Place real orders (default: dry run)
  --lots N                Lots per leg (default: 1)
  --start-time HH:MM      Session start (default: 09:20)
  --entry-band POINTS     Max points above VWAP to allow entry (default: 5)
  --decline-ticks N       Ticks window: premium must be falling over this window (default: 5)
  --exit-buffer POINTS    Points above VWAP that trigger exit (default: 10)
  --max-premium-diff PCT  Max CE/PE premium difference % for entry (default: 15)
  --vwap-warmup TICKS     Min ticks before VWAP is trusted (default: 60)
  --target-profit INR     Global profit target (default: 4000)
  --stop-loss INR         Global stop loss (default: 4000)
"""

import time
import sys
import argparse
import os
import logging
from datetime import datetime
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger

# ── Logging setup ────────────────────────────────────────────────────────────
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "tick_mean_straddle")
os.makedirs(log_dir, exist_ok=True)

STRATEGY_KEY = "nifty_tick_mean_straddle"


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}.log")
        ),
    ],
    force=True,
)
logger = logging.getLogger(__name__)


# ── Strategy ─────────────────────────────────────────────────────────────────

class NiftyTickMeanStraddle:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        start_time: str = "09:20",
        entry_band: float = 5.0,
        decline_ticks: int = 5,
        exit_buffer: float = 10.0,
        max_premium_diff_pct: float = 15.0,
        vwap_warmup_ticks: int = 60,
        profit_target: float = 4000.0,
        stop_loss: float = 4000.0,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.start_time = start_time
        self.entry_band = entry_band
        self.decline_ticks = decline_ticks
        self.exit_buffer = exit_buffer
        self.max_premium_diff_pct = max_premium_diff_pct
        self.vwap_warmup_ticks = vwap_warmup_ticks
        self.profit_target = profit_target
        self.stop_loss = -abs(stop_loss)

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise RuntimeError("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        logger.info("Starting WebSocket for NIFTY Index (security ID 13)...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)

        self.lot_size = self.helper.get_lot_size("NIFTY")
        logger.info(f"NIFTY lot size: {self.lot_size}")

        # Position state
        self._reset_position()

        # VWAP state (persists across re-entries within the same ATM cycle)
        self.combined_prices: deque = deque()  # raw observations (kept for tick count)
        self._vwap_sum: float = 0.0            # running sum avoids O(n) recalculation
        self.vwap: float = 0.0
        self.recent_combined: deque = deque(maxlen=self.decline_ticks)  # short window for decline detection

        # Session-level PnL
        self.realized_pnl: float = 0.0
        self.cycle_count: int = 0

    # ── helpers ──────────────────────────────────────────────────────────────

    def _reset_position(self):
        """Clear per-entry position state (not VWAP, not realized PnL)."""
        self.in_position = False
        self.ce_strike: int = 0
        self.pe_strike: int = 0
        self.ce_id: str = ""
        self.pe_id: str = ""
        self.ce_avg: float = 0.0
        self.pe_avg: float = 0.0
        self.entry_combined: float = 0.0

    def _reset_vwap(self):
        self.combined_prices.clear()
        self._vwap_sum = 0.0
        self.vwap = 0.0
        self.recent_combined.clear()

    def _update_vwap(self, price: float):
        self.combined_prices.append(price)
        self._vwap_sum += price
        self.vwap = self._vwap_sum / len(self.combined_prices)

    def _vwap_ready(self) -> bool:
        return len(self.combined_prices) >= self.vwap_warmup_ticks

    def _sleep_shutdown_aware(self, seconds: int):
        for _ in range(seconds):
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger detected in cooldown sleep.")
                self._save_state(0, 0, 0, 0, "STOPPED")
                sys.exit(0)
            time.sleep(1)

    def _save_state(self, spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING"):
        combined = (ce_ltp + pe_ltp) if ce_ltp > 0 and pe_ltp > 0 else 0
        save_strategy_state(
            STRATEGY_KEY,
            {
                "strategy": STRATEGY_KEY,
                "status": status,
                "dry_run": self.dry_run,
                "lots": self.lots,
                "ce_lots": self.lots,
                "pe_lots": self.lots,
                "in_position": self.in_position,
                "ce_strike": self.ce_strike,
                "pe_strike": self.pe_strike,
                "ce_ltp": ce_ltp,
                "pe_ltp": pe_ltp,
                "ce_avg_price": self.ce_avg,
                "pe_avg_price": self.pe_avg,
                "combined_price": combined,
                "vwap": round(self.vwap, 2),
                "vwap_ticks": len(self.combined_prices),
                "entry_combined": self.entry_combined,
                "realized_pnl": self.realized_pnl,
                "total_pnl": total_pnl,
                "spot": spot,
                "adjustments": self.cycle_count,
                "profit_target": self.profit_target,
                "stop_loss": self.stop_loss,
            },
        )

    def _get_option_info(self, strike: int, option_type: str):
        """Return (security_id, ltp, symbol_name) for a NIFTY option, or (None, 0, '') on failure."""
        quote = self.helper.option("NIFTY", strike, option_type)
        if not quote:
            return None, 0.0, ""
        if isinstance(quote, dict) and "CONTRACT_INFO" in quote:
            ci = quote["CONTRACT_INFO"]
            sid = str(ci.get("SECURITY_ID", ""))
            ltp = float(quote.get("last_price", 0) or quote.get("LTP", 0))
            name = ci.get("SYMBOL_NAME", f"NIFTY-{strike}-{option_type}")
            return sid, ltp, name
        return None, 0.0, ""

    def _ltp(self, security_id: str) -> float:
        return self.helper.get_ltp(security_id, exchange="NSE_FNO", instrument="OPTIDX")

    def _nifty_spot(self) -> float:
        return self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")

    def _atm(self, spot: float) -> int:
        return int(round(spot / 50) * 50)

    def _unrealized_pnl(self, ce_ltp: float, pe_ltp: float) -> float:
        if not self.in_position:
            return 0.0
        qty = self.lots * self.lot_size
        return (self.ce_avg - ce_ltp) * qty + (self.pe_avg - pe_ltp) * qty

    def _total_pnl(self, ce_ltp: float, pe_ltp: float) -> float:
        return self.realized_pnl + self._unrealized_pnl(ce_ltp, pe_ltp)

    def _subscribe(self, ce_id: str, pe_id: str):
        try:
            self.helper.subscribe_instruments([
                ("NSE_FNO", ce_id, 15),
                ("NSE_FNO", pe_id, 15),
            ])
            time.sleep(2)
        except Exception as e:
            logger.error(f"WebSocket subscribe error: {e}")

    def _unsubscribe(self, ce_id: str, pe_id: str):
        try:
            self.helper.unsubscribe_instruments([
                ("NSE_FNO", ce_id, 15),
                ("NSE_FNO", pe_id, 15),
            ])
        except Exception:
            pass

    # ── entry / exit orders ──────────────────────────────────────────────────

    def _enter_straddle(self, ce_id: str, pe_id: str, ce_ltp: float, pe_ltp: float) -> bool:
        """Sell both legs. Returns True on success."""
        qty = self.lots * self.lot_size
        if not self.dry_run:
            ce_oid = self.helper.sell(ce_id, qty)
            if not ce_oid:
                logger.error("CE sell order failed; not entering straddle.")
                return False
            pe_oid = self.helper.sell(pe_id, qty)
            if not pe_oid:
                logger.error("PE sell order failed; rolling back CE leg.")
                try:
                    self.helper.buy(ce_id, qty)
                except Exception as rb:
                    logger.error(f"CE rollback failed: {rb}")
                return False
            # Confirm actual fills
            ce_fill = self._get_fill_price(ce_oid, ce_ltp)
            pe_fill = self._get_fill_price(pe_oid, pe_ltp)
        else:
            ce_fill, pe_fill = ce_ltp, pe_ltp
            logger.info(f"[DRY RUN] Simulating SELL {self.lots}L CE {self.ce_strike} @ {ce_ltp:.2f}"
                        f" and PE {self.pe_strike} @ {pe_ltp:.2f}")

        self.ce_avg = ce_fill
        self.pe_avg = pe_fill
        self.entry_combined = ce_fill + pe_fill
        self.in_position = True
        logger.info(
            f"ENTERED straddle | CE {self.ce_strike} @ {ce_fill:.2f} | PE {self.pe_strike} @ {pe_fill:.2f}"
            f" | Combined: {self.entry_combined:.2f} | VWAP: {self.vwap:.2f}"
        )
        return True

    def _exit_straddle(self, reason: str):
        """Buy back both legs and book realized PnL."""
        logger.warning(f"EXITING straddle: {reason}")
        qty = self.lots * self.lot_size
        ce_ltp = self._ltp(self.ce_id)
        pe_ltp = self._ltp(self.pe_id)
        if ce_ltp <= 0:
            ce_ltp = self.ce_avg
        if pe_ltp <= 0:
            pe_ltp = self.pe_avg

        if not self.dry_run:
            for sid, leg, avg in [(self.ce_id, "CE", self.ce_avg), (self.pe_id, "PE", self.pe_avg)]:
                try:
                    oid = self.helper.buy(sid, qty)
                    if not oid:
                        logger.critical(f"Exit order FAILED for {leg} (ID: {sid})!")
                except Exception as e:
                    logger.error(f"Exit {leg} error: {e}")
        else:
            logger.info(f"[DRY RUN] Simulating BUY-TO-COVER | CE @ {ce_ltp:.2f} | PE @ {pe_ltp:.2f}")

        realized = (self.ce_avg - ce_ltp) * qty + (self.pe_avg - pe_ltp) * qty
        self.realized_pnl += realized
        logger.info(
            f"Exit PnL this leg: {realized:.2f} | Session realized PnL: {self.realized_pnl:.2f}"
        )
        self._reset_position()

    def _get_fill_price(self, order_id: str, fallback: float) -> float:
        if not order_id:
            return fallback
        if self.helper.wait_for_fill(order_id, timeout=5):
            detail = self.helper.get_order_by_id(order_id)
            if detail:
                price = float(
                    detail.get("averageTradedPrice", 0)
                    or detail.get("avgFilledPrice", 0)
                    or detail.get("price", 0)
                )
                if price > 0:
                    return price
        return fallback

    # ── ATM cycle setup ──────────────────────────────────────────────────────

    def _setup_atm_cycle(self, spot: float):
        """
        Fetch option quotes for the nearest ATM strike, subscribe WebSocket,
        reset VWAP, and return (ce_id, pe_id, ce_ltp, pe_ltp) or None on failure.
        """
        atm = self._atm(spot)
        logger.info(f"Setting up ATM cycle at {atm} (Spot: {spot:.2f})")

        ce_id, ce_ltp, ce_name = self._get_option_info(atm, "CE")
        pe_id, pe_ltp, pe_name = self._get_option_info(atm, "PE")

        if not ce_id or not pe_id or ce_ltp <= 0 or pe_ltp <= 0:
            logger.error(f"Could not fetch quotes for {atm} CE/PE. Will retry.")
            return None

        self.ce_strike = atm
        self.pe_strike = atm
        self.ce_id = ce_id
        self.pe_id = pe_id
        self._reset_vwap()

        self._subscribe(ce_id, pe_id)
        self.cycle_count += 1
        logger.info(
            f"ATM Cycle {self.cycle_count}: {atm} CE (ID:{ce_id}) @ {ce_ltp:.2f}"
            f" | PE (ID:{pe_id}) @ {pe_ltp:.2f}"
        )
        return ce_id, pe_id, ce_ltp, pe_ltp

    # ── main loop ────────────────────────────────────────────────────────────

    def run(self):
        logger.info(
            f"NiftyTickMeanStraddle START | dry_run={self.dry_run} | lots={self.lots}"
            f" | entry_band={self.entry_band}pts | decline_ticks={self.decline_ticks}"
            f" | exit_buffer={self.exit_buffer}pts"
            f" | max_diff={self.max_premium_diff_pct}% | warmup={self.vwap_warmup_ticks} ticks"
        )

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger in outer loop.")
                self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
                sys.exit(0)

            self._save_state(0, 0, 0, self.realized_pnl, "INITIALIZING")
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time="15:17", shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY))

            # ── Get initial spot and set up ATM ──────────────────────────────
            spot = self._nifty_spot()
            if spot <= 0:
                logger.error("Could not get NIFTY spot; retrying in 30s.")
                time.sleep(30)
                continue

            result = self._setup_atm_cycle(spot)
            if result is None:
                time.sleep(30)
                continue

            ce_id, pe_id, ce_ltp, pe_ltp = result
            last_atm = self._atm(spot)
            last_log_time = 0.0
            pending_atm: int = 0  # ATM level that shifted while in position

            # ── Inner monitoring loop for this ATM cycle ──────────────────────
            while True:
                if check_shutdown_trigger(STRATEGY_KEY):
                    ce_p = self._ltp(ce_id) or ce_ltp
                    pe_p = self._ltp(pe_id) or pe_ltp
                    if self.in_position:
                        self._exit_straddle("UI Shutdown Request")
                    self._save_state(spot, ce_p, pe_p, self.realized_pnl, "STOPPED")
                    sys.exit(0)

                now = datetime.now()
                if now.strftime("%H:%M") >= "15:17":
                    if self.in_position:
                        self._exit_straddle("Intraday Auto-Exit 15:17")
                    logger.info("Session ended at 15:17. Waiting for next day.")
                    self._unsubscribe(ce_id, pe_id)
                    self._reset_position()
                    break  # go back to outer loop (wait_for_market_open)

                # Fetch current prices
                ce_ltp = self._ltp(ce_id)
                pe_ltp = self._ltp(pe_id)
                if ce_ltp <= 0 or pe_ltp <= 0:
                    time.sleep(1)
                    continue

                combined = ce_ltp + pe_ltp
                self._update_vwap(combined)
                self.recent_combined.append(combined)

                spot = self._nifty_spot() or spot
                total_pnl = self._total_pnl(ce_ltp, pe_ltp)
                self._save_state(spot, ce_ltp, pe_ltp, total_pnl,
                                 "RUNNING" if self.in_position else "MONITORING")

                # ── ATM shift detection ───────────────────────────────────────
                current_atm = self._atm(spot)
                if current_atm != last_atm:
                    if self.in_position:
                        # Hold — don't exit just because ATM moved; log only once per new level
                        if current_atm != pending_atm:
                            logger.info(
                                f"ATM shifted to {current_atm} (spot {spot:.2f}) while in position. "
                                "Holding — will re-center after exit."
                            )
                            pending_atm = current_atm
                        # Don't update last_atm; re-centering will trigger naturally after exit
                    else:
                        logger.info(
                            f"ATM shifted: {last_atm} -> {current_atm} (spot {spot:.2f}). Re-centering."
                        )
                        self._unsubscribe(ce_id, pe_id)
                        result = self._setup_atm_cycle(spot)
                        if result is None:
                            time.sleep(30)
                            break  # restart outer loop
                        ce_id, pe_id, ce_ltp, pe_ltp = result
                        last_atm = current_atm
                        pending_atm = 0
                        time.sleep(1)
                        continue

                # ── Global P&L guards ─────────────────────────────────────────
                if total_pnl >= self.profit_target:
                    if self.in_position:
                        self._exit_straddle(f"Global Profit Target hit: {total_pnl:.2f}")
                    logger.info("Profit target reached. Waiting for next session.")
                    self._unsubscribe(ce_id, pe_id)
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)):
                        self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
                        sys.exit(0)
                    self._reset_position()
                    break

                if total_pnl <= self.stop_loss:
                    if self.in_position:
                        self._exit_straddle(f"Global Stop Loss hit: {total_pnl:.2f}")
                    logger.info("Stop loss hit. Waiting for next session.")
                    self._unsubscribe(ce_id, pe_id)
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)):
                        self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
                        sys.exit(0)
                    self._reset_position()
                    break

                # ── Periodic log ──────────────────────────────────────────────
                now_ts = time.time()
                if now_ts - last_log_time >= 5:
                    diff_pct = (
                        abs(ce_ltp - pe_ltp) / max(ce_ltp, pe_ltp) * 100
                        if max(ce_ltp, pe_ltp) > 0 else 0.0
                    )
                    vwap_ticks = len(self.combined_prices)
                    vwap_status = f"{self.vwap:.2f} ({vwap_ticks}t)" if self._vwap_ready() else f"warming ({vwap_ticks}/{self.vwap_warmup_ticks}t)"
                    vwap_gap = combined - self.vwap if self._vwap_ready() else float("nan")
                    unrealized = self._unrealized_pnl(ce_ltp, pe_ltp)

                    pos_label = "[IN] " if self.in_position else "[OUT]"
                    entry_info = (
                        f" entry={self.entry_combined:.2f}"
                        if self.in_position else ""
                    )
                    logger.info(
                        f"{pos_label} ATM:{self.ce_strike}"
                        f" | CE:{ce_ltp:.2f} PE:{pe_ltp:.2f}"
                        f" | Combined:{combined:.2f}{entry_info}"
                        f" | VWAP:{vwap_status} gap={vwap_gap:+.2f}"
                        f" | Diff:{diff_pct:.1f}%"
                        f" | PnL  real={self.realized_pnl:+.0f}"
                        f" unreal={unrealized:+.0f}"
                        f" total={total_pnl:+.0f}"
                    )
                    last_log_time = now_ts

                # ── State-machine logic ───────────────────────────────────────
                if self.in_position:
                    # Exit condition: combined premium > VWAP + exit_buffer
                    if self._vwap_ready() and combined > self.vwap + self.exit_buffer:
                        self._exit_straddle(
                            f"Combined {combined:.2f} > VWAP({self.vwap:.2f}) + buffer({self.exit_buffer})"
                        )
                        # stay in inner loop — keep monitoring for re-entry
                else:
                    # Entry conditions (VWAP must be warmed up):
                    #   1. combined <= VWAP + entry_band  (price near/below VWAP)
                    #   2. combined is declining over last decline_ticks ticks
                    #   3. premium difference < max_premium_diff_pct
                    if not self._vwap_ready():
                        time.sleep(1)
                        continue

                    diff_pct = (
                        abs(ce_ltp - pe_ltp) / max(ce_ltp, pe_ltp) * 100
                        if max(ce_ltp, pe_ltp) > 0 else 100.0
                    )
                    price_ok = combined <= self.vwap + self.entry_band
                    declining = (
                        len(self.recent_combined) >= self.decline_ticks
                        and combined < self.recent_combined[0]
                    )
                    diff_ok = diff_pct < self.max_premium_diff_pct

                    if price_ok and declining and diff_ok:
                        logger.info(
                            f"Entry signal: combined {combined:.2f} <= VWAP {self.vwap:.2f}"
                            f" + band {self.entry_band} | declining over {self.decline_ticks}t"
                            f" | diff {diff_pct:.1f}% < {self.max_premium_diff_pct}%"
                        )
                        success = self._enter_straddle(ce_id, pe_id, ce_ltp, pe_ltp)
                        if not success:
                            logger.warning("Entry failed; will retry next tick.")
                    elif price_ok and not declining:
                        logger.debug(
                            f"Price OK ({combined:.2f}) but not yet declining. Waiting."
                        )
                    elif price_ok and declining and not diff_ok:
                        logger.debug(
                            f"Price & declining OK but premium diff {diff_pct:.1f}% >= {self.max_premium_diff_pct}%. Waiting."
                        )

                time.sleep(1)


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty VWAP Straddle Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default)
  python strategies/value_imbalance/nifty_vwap_straddle.py

  # Live, 2 lots, tighter exit buffer
  python strategies/value_imbalance/nifty_vwap_straddle.py --live --lots 2 --exit-buffer 8

  # Custom premium diff, entry band, and decline window
  python strategies/value_imbalance/nifty_vwap_straddle.py --max-premium-diff 10 --entry-band 3 --decline-ticks 8
""",
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Place real orders (default: dry run)")
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Lots per leg (default: 1)")
    parser.add_argument("--start-time", type=str, default="09:20", metavar="HH:MM",
                        help="Session start time IST (default: 09:20)")
    parser.add_argument("--entry-band", type=float, default=5.0, metavar="PTS",
                        help="Max points above VWAP to allow entry (default: 5)")
    parser.add_argument("--decline-ticks", type=int, default=5, metavar="N",
                        help="Ticks window: combined must be declining over this many ticks to enter (default: 5)")
    parser.add_argument("--exit-buffer", type=float, default=10.0, metavar="PTS",
                        help="Points above VWAP that trigger exit (default: 10)")
    parser.add_argument("--max-premium-diff", type=float, default=15.0, metavar="PCT",
                        help="Max CE/PE premium difference %% for entry (default: 15)")
    parser.add_argument("--vwap-warmup", type=int, default=60, metavar="TICKS",
                        help="Min ticks before VWAP is trusted (default: 60, ≈ 1 min at 1s/tick)")
    parser.add_argument("--target-profit", type=float, default=4000.0, metavar="INR",
                        help="Global profit target in INR (default: 4000)")
    parser.add_argument("--stop-loss", type=float, default=4000.0, metavar="INR",
                        help="Global stop loss in INR, positive value (default: 4000)")

    args = parser.parse_args()

    logger.info(
        f"Config | mode={'LIVE' if args.live else 'DRY'} lots={args.lots}"
        f" start={args.start_time} entry_band={args.entry_band}pts"
        f" decline_ticks={args.decline_ticks} exit_buffer={args.exit_buffer}pts"
        f" max_diff={args.max_premium_diff}% warmup={args.vwap_warmup}ticks"
        f" profit={args.target_profit} sl={args.stop_loss}"
    )

    strategy = NiftyTickMeanStraddle(
        dry_run=not args.live,
        lots=args.lots,
        start_time=args.start_time,
        entry_band=args.entry_band,
        decline_ticks=args.decline_ticks,
        exit_buffer=args.exit_buffer,
        max_premium_diff_pct=args.max_premium_diff,
        vwap_warmup_ticks=args.vwap_warmup,
        profit_target=args.target_profit,
        stop_loss=args.stop_loss,
    )

    try:
        strategy.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt - squaring off all positions...")
        if strategy.in_position:
            strategy._exit_straddle("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
