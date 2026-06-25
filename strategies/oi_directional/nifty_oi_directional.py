"""
Nifty OI Directional Strategy

Tracks open interest across ±5 NIFTY strikes from ATM (11 strikes total).
Computes diff = sum(CE_OI) - sum(PE_OI) across those strikes.

Direction signal:
  diff > 0 and expanding → BULLISH  → sell PE strike with PCR > pcr_threshold
  diff < 0 and expanding → BEARISH  → sell CE strike with PCR < 1/pcr_threshold

PCR per strike = PE_OI / CE_OI at that specific strike.

Exit:
  PE sell: exit when strike PCR drops by exit_pcr_change_pct from entry
           e.g. entry PCR 1.5, exit at 1.5 * 0.70 = 1.05
  CE sell: exit when strike PCR rises by exit_pcr_change_pct from entry
           e.g. entry PCR 0.67, exit at 0.67 * 1.30 = 0.87

Auto-exit at 15:17 IST.

CLI args:
  --live                  Place real orders (default: dry run)
  --lots N                Lots per leg (default: 1)
  --start-time HH:MM      Session start (default: 09:30)
  --pcr-threshold X       PCR level above which to sell PE / below 1/X to sell CE (default: 1.5)
  --exit-pcr-change PCT   % change in PCR from entry that triggers exit (default: 30)
  --poll-interval SECS    Seconds between option chain fetches (default: 60)
  --expansion-window N    Number of OI snapshots to confirm expansion (default: 3)
  --target-profit INR     Global profit target (default: 5000)
  --stop-loss INR         Global stop loss (default: 5000)
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
log_dir = os.path.join(debug_dir, "logs", "oi_directional")
os.makedirs(log_dir, exist_ok=True)

STRATEGY_KEY = "nifty_oi_directional"
NIFTY_STRIKE_STEP = 50
STRIKES_EACH_SIDE = 5


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


class NiftyOIDirectional:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        start_time: str = "09:30",
        pcr_threshold: float = 1.5,
        exit_pcr_change_pct: float = 30.0,
        poll_interval: int = 60,
        expansion_window: int = 3,
        profit_target: float = 5000.0,
        stop_loss: float = 5000.0,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.start_time = start_time
        self.pcr_threshold = pcr_threshold
        self.exit_pcr_change_pct = exit_pcr_change_pct
        self.poll_interval = poll_interval
        self.expansion_window = expansion_window
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

        # OI diff history — used to detect expansion
        self.diff_history: deque = deque(maxlen=expansion_window)

        # Per-entry position state
        self._reset_position()

        # Session PnL
        self.realized_pnl: float = 0.0

    # ── helpers ──────────────────────────────────────────────────────────────

    def _reset_position(self):
        self.in_position = False
        self.position_type: str = ""       # "PE_SELL" or "CE_SELL"
        self.sold_strike: int = 0
        self.sold_security_id: str = ""
        self.entry_pcr: float = 0.0
        self.exit_pcr_level: float = 0.0   # PCR level that triggers exit
        self.avg_price: float = 0.0

    def _nifty_spot(self) -> float:
        return self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")

    def _atm(self, spot: float) -> int:
        return int(round(spot / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP)

    def _monitored_strikes(self, spot: float) -> list:
        atm = self._atm(spot)
        return [atm + i * NIFTY_STRIKE_STEP for i in range(-STRIKES_EACH_SIDE, STRIKES_EACH_SIDE + 1)]

    def _fetch_chain(self, expiry: str):
        df = self.helper.get_option_chain_df("NIFTY", expiry)
        return None if df.empty else df

    def _ltp(self, security_id: str) -> float:
        return self.helper.get_ltp(security_id, exchange="NSE_FNO", instrument="OPTIDX")

    def _unrealized_pnl(self, current_ltp: float) -> float:
        if not self.in_position or self.avg_price <= 0:
            return 0.0
        return (self.avg_price - current_ltp) * self.lots * self.lot_size

    def _total_pnl(self, current_ltp: float) -> float:
        return self.realized_pnl + self._unrealized_pnl(current_ltp)

    def _sleep_shutdown_aware(self, seconds: int):
        for _ in range(seconds):
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger during sleep.")
                self._save_state(0, 0, "", 0, "STOPPED")
                sys.exit(0)
            time.sleep(1)

    def _subscribe_position(self, security_id: str):
        try:
            self.helper.subscribe_instruments([("NSE_FNO", security_id, 15)])
            time.sleep(1)
            logger.info(f"WebSocket subscribed for {security_id}")
        except Exception as e:
            logger.error(f"WebSocket subscribe error: {e}")

    def _unsubscribe_position(self, security_id: str):
        try:
            self.helper.unsubscribe_instruments([("NSE_FNO", security_id, 15)])
        except Exception:
            pass

    def _monitor_realtime(self, duration: int, spot: float, direction: str, oi_diff: float):
        """Real-time LTP loop between OI polls while in position. Returns when duration
        elapses, position is closed, or a session-ending condition fires."""
        last_log = 0.0
        elapsed = 0
        while elapsed < duration and self.in_position:
            if check_shutdown_trigger(STRATEGY_KEY):
                self._exit_position("UI Shutdown Request")
                self._save_state(spot, 0, direction, oi_diff, "STOPPED")
                sys.exit(0)

            if datetime.now().strftime("%H:%M") >= "15:17":
                self._exit_position("Intraday Auto-Exit 15:17")
                return

            current_ltp = self._ltp(self.sold_security_id)
            if current_ltp > 0:
                total_pnl = self._total_pnl(current_ltp)
                self._save_state(spot, current_ltp, direction, oi_diff, "RUNNING")

                if total_pnl >= self.profit_target:
                    self._exit_position(f"Profit target {total_pnl:.0f}", current_ltp)
                    return
                if total_pnl <= self.stop_loss:
                    self._exit_position(f"Stop loss {total_pnl:.0f}", current_ltp)
                    return

                now_ts = time.time()
                if now_ts - last_log >= 5:
                    logger.info(
                        f"[RT] {self.sold_strike} {self.position_type}"
                        f" | LTP:{current_ltp:.2f} avg:{self.avg_price:.2f}"
                        f" | unreal:{self._unrealized_pnl(current_ltp):+.0f}"
                        f" | total:{total_pnl:+.0f}"
                    )
                    last_log = now_ts

            time.sleep(1)
            elapsed += 1

    def _save_state(self, spot: float, current_ltp: float, direction: str, oi_diff: float, status: str = "RUNNING"):
        save_strategy_state(
            STRATEGY_KEY,
            {
                "strategy": STRATEGY_KEY,
                "status": status,
                "dry_run": self.dry_run,
                "lots": self.lots,
                "in_position": self.in_position,
                "position_type": self.position_type,
                "sold_strike": self.sold_strike,
                "entry_pcr": round(self.entry_pcr, 4),
                "exit_pcr_level": round(self.exit_pcr_level, 4),
                "avg_price": round(self.avg_price, 2),
                "current_ltp": round(current_ltp, 2),
                "direction": direction,
                "oi_diff": round(oi_diff, 0),
                "realized_pnl": round(self.realized_pnl, 2),
                "total_pnl": round(self._total_pnl(current_ltp), 2),
                "spot": round(spot, 2),
                "pcr_threshold": self.pcr_threshold,
            },
        )

    # ── OI signal ────────────────────────────────────────────────────────────

    def _compute_direction(self, df, monitored_strikes: list) -> tuple:
        """
        Returns (direction, diff, total_ce_oi, total_pe_oi).
        direction: "BULLISH", "BEARISH", or "NEUTRAL"
        Expansion means the diff is moving further from zero compared to the previous snapshot.
        """
        available = [float(s) for s in monitored_strikes if float(s) in df.index]
        if len(available) < 3:
            logger.warning(f"Only {len(available)} strikes found in chain; skipping signal.")
            return "NEUTRAL", 0.0, 0.0, 0.0

        sub = df.loc[available]
        total_ce_oi = float(sub["ce_oi"].fillna(0).sum()) if "ce_oi" in sub.columns else 0.0
        total_pe_oi = float(sub["pe_oi"].fillna(0).sum()) if "pe_oi" in sub.columns else 0.0
        diff = total_ce_oi - total_pe_oi

        self.diff_history.append(diff)
        if len(self.diff_history) < self.expansion_window:
            return "NEUTRAL", diff, total_ce_oi, total_pe_oi

        prev = self.diff_history[-2]
        curr = self.diff_history[-1]

        if curr < 0 and curr < prev:
            # PE OI dominates and expanding → put writers defending support → BULLISH
            direction = "BULLISH"
        elif curr > 0 and curr > prev:
            # CE OI dominates and expanding → call writers defending resistance → BEARISH
            direction = "BEARISH"
        else:
            direction = "NEUTRAL"

        return direction, diff, total_ce_oi, total_pe_oi

    def _pcr_at(self, df, strike: int):
        """PCR = PE_OI / CE_OI for the given strike. Returns None if unavailable."""
        key = float(strike)
        if key not in df.index:
            return None
        row = df.loc[key]
        ce_oi = float(row.get("ce_oi", 0) or 0)
        pe_oi = float(row.get("pe_oi", 0) or 0)
        if ce_oi <= 0:
            return None
        return pe_oi / ce_oi

    def _find_entry(self, df, monitored_strikes: list, direction: str):
        """
        Bullish: PE strike with PCR > pcr_threshold → pick highest PCR (strongest support).
        Bearish: CE strike with PCR < 1/pcr_threshold → pick lowest PCR (strongest resistance).
        Returns (strike, option_type, pcr) or None.
        """
        available = [float(s) for s in monitored_strikes if float(s) in df.index]
        if not available:
            return None

        sub = df.loc[available].copy()
        if "ce_oi" not in sub.columns or "pe_oi" not in sub.columns:
            return None

        sub["_ce_oi"] = sub["ce_oi"].fillna(0)
        sub["_pe_oi"] = sub["pe_oi"].fillna(0)
        sub["_pcr"] = sub.apply(
            lambda r: r["_pe_oi"] / r["_ce_oi"] if r["_ce_oi"] > 0 else 0.0, axis=1
        )

        if direction == "BULLISH":
            candidates = sub[sub["_pcr"] > self.pcr_threshold]
            if candidates.empty:
                return None
            # Pick the strike whose PCR is just above the threshold (closest to 1.5, not highest)
            best_idx = candidates["_pcr"].idxmin()
            return int(best_idx), "PE", float(candidates.loc[best_idx, "_pcr"])

        elif direction == "BEARISH":
            bear_threshold = 1.0 / self.pcr_threshold
            # Positive PCR below the threshold (exclude zero — no CE OI)
            candidates = sub[(sub["_pcr"] > 0) & (sub["_pcr"] < bear_threshold)]
            if candidates.empty:
                return None
            # Pick the strike whose PCR is just below the threshold (closest to 0.67, not lowest)
            best_idx = candidates["_pcr"].idxmax()
            return int(best_idx), "CE", float(candidates.loc[best_idx, "_pcr"])

        return None

    # ── order execution ──────────────────────────────────────────────────────

    def _get_option_sid_ltp(self, strike: int, option_type: str):
        """Return (security_id, ltp) for NIFTY option. Returns (None, 0) on failure."""
        quote = self.helper.option("NIFTY", strike, option_type)
        if not quote:
            return None, 0.0
        if isinstance(quote, dict) and "CONTRACT_INFO" in quote:
            ci = quote["CONTRACT_INFO"]
            sid = str(ci.get("SECURITY_ID", ""))
            ltp = float(quote.get("last_price", 0) or quote.get("LTP", 0))
            return sid, ltp
        return None, 0.0

    def _enter_position(self, strike: int, option_type: str, security_id: str, ltp: float, pcr: float) -> bool:
        qty = self.lots * self.lot_size
        fill_price = ltp

        if not self.dry_run:
            oid = self.helper.sell(security_id, qty)
            if not oid:
                logger.error(f"Sell order failed for {strike}{option_type}")
                return False
            if self.helper.wait_for_fill(oid, timeout=10):
                detail = self.helper.get_order_by_id(oid)
                if detail:
                    filled = float(
                        detail.get("averageTradedPrice", 0)
                        or detail.get("avgFilledPrice", 0)
                        or ltp
                    )
                    if filled > 0:
                        fill_price = filled
        else:
            logger.info(
                f"[DRY RUN] SELL {self.lots}L NIFTY {strike}{option_type}"
                f" @ {ltp:.2f} | PCR={pcr:.4f}"
            )

        self.in_position = True
        self.position_type = f"{option_type}_SELL"
        self.sold_strike = strike
        self.sold_security_id = security_id
        self.avg_price = fill_price
        self.entry_pcr = pcr

        if option_type == "PE":
            # Exit when PCR drops by exit_pcr_change_pct%
            self.exit_pcr_level = pcr * (1.0 - self.exit_pcr_change_pct / 100.0)
        else:
            # Exit when PCR rises by exit_pcr_change_pct%
            self.exit_pcr_level = pcr * (1.0 + self.exit_pcr_change_pct / 100.0)

        logger.info(
            f"ENTERED {self.position_type} | Strike:{strike} @ {fill_price:.2f}"
            f" | Entry PCR:{pcr:.4f} | Exit PCR trigger:{self.exit_pcr_level:.4f}"
        )
        self._subscribe_position(security_id)
        return True

    def _exit_position(self, reason: str, current_ltp: float = 0.0):
        logger.warning(f"EXITING {self.position_type} ({self.sold_strike}): {reason}")
        qty = self.lots * self.lot_size
        ltp = current_ltp or self._ltp(self.sold_security_id) or self.avg_price

        if not self.dry_run:
            try:
                oid = self.helper.buy(self.sold_security_id, qty)
                if not oid:
                    logger.critical(
                        f"Exit buy order FAILED for {self.sold_strike} {self.position_type}!"
                    )
            except Exception as e:
                logger.error(f"Exit order error: {e}")
        else:
            logger.info(
                f"[DRY RUN] BUY-TO-COVER {self.sold_strike}{self.position_type[0]}"
                f" @ {ltp:.2f}"
            )

        self._unsubscribe_position(self.sold_security_id)
        realized = (self.avg_price - ltp) * self.lots * self.lot_size
        self.realized_pnl += realized
        logger.info(
            f"Leg PnL: {realized:+.2f} | Session realized: {self.realized_pnl:+.2f}"
        )
        self._reset_position()

    # ── main loop ────────────────────────────────────────────────────────────

    def run(self):
        logger.info(
            f"NiftyOIDirectional START | dry_run={self.dry_run} | lots={self.lots}"
            f" | pcr_threshold={self.pcr_threshold}"
            f" | exit_pcr_change={self.exit_pcr_change_pct}%"
            f" | poll={self.poll_interval}s"
            f" | expansion_window={self.expansion_window}"
        )

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger in outer loop.")
                self._save_state(0, 0, "", 0, "STOPPED")
                sys.exit(0)

            self._save_state(0, 0, "", 0, "INITIALIZING")
            self.helper.wait_for_market_open(
                self.dry_run, start_time=self.start_time, eod_time="15:17",
                shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)
            )

            # Resolve nearest expiry once per session
            expiry = self.helper.get_nearest_expiry("NIFTY")
            if not expiry:
                logger.error("Could not fetch NIFTY expiry. Retrying in 60s.")
                time.sleep(60)
                continue
            logger.info(f"Trading nearest expiry: {expiry}")
            self.diff_history.clear()

            # ── Inner session loop ─────────────────────────────────────────
            while True:
                if check_shutdown_trigger(STRATEGY_KEY):
                    if self.in_position:
                        self._exit_position("UI Shutdown Request")
                    self._save_state(0, 0, "", 0, "STOPPED")
                    sys.exit(0)

                if datetime.now().strftime("%H:%M") >= "15:17":
                    if self.in_position:
                        self._exit_position("Intraday Auto-Exit 15:17")
                    logger.info("Session ended at 15:17.")
                    self._reset_position()
                    self.diff_history.clear()
                    break

                # Get spot
                spot = self._nifty_spot()
                if spot <= 0:
                    logger.warning("No NIFTY spot price; retrying in 30s.")
                    self._sleep_shutdown_aware(30)
                    continue

                # Fetch option chain
                df = self._fetch_chain(expiry)
                if df is None:
                    logger.warning("Option chain unavailable; retrying in 30s.")
                    self._sleep_shutdown_aware(30)
                    continue

                monitored_strikes = self._monitored_strikes(spot)
                atm = self._atm(spot)
                direction, oi_diff, total_ce_oi, total_pe_oi = self._compute_direction(df, monitored_strikes)

                # Current LTP for held position
                current_ltp = self._ltp(self.sold_security_id) if self.in_position else 0.0
                total_pnl = self._total_pnl(current_ltp)

                self._save_state(
                    spot, current_ltp, direction, oi_diff,
                    "RUNNING" if self.in_position else "MONITORING",
                )

                logger.info(
                    f"Spot:{spot:.2f} ATM:{atm}"
                    f" | CE_OI:{total_ce_oi:.0f} PE_OI:{total_pe_oi:.0f} Diff:{oi_diff:+.0f}"
                    f" | Direction:{direction}"
                    f" | Pos:{'%s %s @ %.2f (PCR %.3f→%.3f)' % (self.sold_strike, self.position_type, self.avg_price, self.entry_pcr, self.exit_pcr_level) if self.in_position else 'FLAT'}"
                    f" | PnL:{total_pnl:+.0f}"
                )

                if self.in_position:
                    # PCR exit check on each fresh option chain
                    current_pcr = self._pcr_at(df, self.sold_strike)
                    if current_pcr is not None:
                        logger.info(
                            f"PCR check | {self.sold_strike} {self.position_type}"
                            f" | entry:{self.entry_pcr:.4f}"
                            f" | current:{current_pcr:.4f}"
                            f" | exit_trigger:{self.exit_pcr_level:.4f}"
                        )
                        if self.position_type == "PE_SELL" and current_pcr <= self.exit_pcr_level:
                            self._exit_position(
                                f"PCR dropped {self.exit_pcr_change_pct:.0f}%:"
                                f" {self.entry_pcr:.4f} → {current_pcr:.4f}",
                                current_ltp,
                            )
                        elif self.position_type == "CE_SELL" and current_pcr >= self.exit_pcr_level:
                            self._exit_position(
                                f"PCR rose {self.exit_pcr_change_pct:.0f}%:"
                                f" {self.entry_pcr:.4f} → {current_pcr:.4f}",
                                current_ltp,
                            )
                    else:
                        logger.warning(
                            f"Could not read PCR for held strike {self.sold_strike}; holding."
                        )

                    # After PCR check: if still in position, monitor LTP in real-time
                    # until the next OI poll. PnL guards and auto-exit fire every second.
                    if self.in_position:
                        self._monitor_realtime(self.poll_interval, spot, direction, oi_diff)
                        # Check if profit/stop was hit inside the realtime loop
                        if not self.in_position:
                            rt_pnl = self.realized_pnl
                            if rt_pnl >= self.profit_target:
                                logger.info("Profit target reached. Waiting for next session.")
                                if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)):
                                    self._save_state(0, 0, "", 0, "STOPPED")
                                    sys.exit(0)
                                break
                            if rt_pnl <= self.stop_loss:
                                logger.info("Stop loss hit. Waiting for next session.")
                                if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)):
                                    self._save_state(0, 0, "", 0, "STOPPED")
                                    sys.exit(0)
                                break
                    else:
                        self._sleep_shutdown_aware(self.poll_interval)

                else:
                    # Look for a new entry when signal is confirmed and diff history is warmed up
                    if direction in ("BULLISH", "BEARISH") and len(self.diff_history) >= self.expansion_window:
                        entry = self._find_entry(df, monitored_strikes, direction)
                        if entry:
                            strike, option_type, pcr = entry
                            sec_id, ltp = self._get_option_sid_ltp(strike, option_type)
                            if sec_id and ltp > 0:
                                logger.info(
                                    f"Entry signal | {direction}"
                                    f" → {strike}{option_type} PCR:{pcr:.4f} LTP:{ltp:.2f}"
                                )
                                self._enter_position(strike, option_type, sec_id, ltp, pcr)
                                # If entry succeeded, start realtime monitoring immediately
                                if self.in_position:
                                    self._monitor_realtime(self.poll_interval, spot, direction, oi_diff)
                            else:
                                logger.warning(
                                    f"Could not resolve {strike}{option_type} (sid={sec_id} ltp={ltp})"
                                )
                                self._sleep_shutdown_aware(self.poll_interval)
                        else:
                            logger.info(
                                f"{direction} signal but no qualifying strike found"
                                f" (pcr_threshold={self.pcr_threshold:.2f})"
                            )
                            self._sleep_shutdown_aware(self.poll_interval)
                    else:
                        logger.info(
                            f"No entry: direction={direction}"
                            f" diff_history={len(self.diff_history)}/{self.expansion_window}"
                        )
                        self._sleep_shutdown_aware(self.poll_interval)


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty OI Directional Strategy — sells PE/CE based on OI imbalance and PCR",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default)
  python strategies/oi_directional/nifty_oi_directional.py

  # Live, 2 lots, tighter PCR threshold
  python strategies/oi_directional/nifty_oi_directional.py --live --lots 2 --pcr-threshold 2.0

  # Faster polling, wider exit trigger
  python strategies/oi_directional/nifty_oi_directional.py --poll-interval 45 --exit-pcr-change 25
""",
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Place real orders (default: dry run)")
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Lots per leg (default: 1)")
    parser.add_argument("--start-time", type=str, default="09:30", metavar="HH:MM",
                        help="Session start time IST (default: 09:30)")
    parser.add_argument("--pcr-threshold", type=float, default=1.5, metavar="X",
                        help="PCR level above which to sell PE (and below 1/X to sell CE) (default: 1.5)")
    parser.add_argument("--exit-pcr-change", type=float, default=30.0, metavar="PCT",
                        help="PCR %% change from entry that triggers exit (default: 30)")
    parser.add_argument("--poll-interval", type=int, default=60, metavar="SECS",
                        help="Seconds between option chain fetches (default: 60). "
                             "Dhan receives OI updates directly from the exchange feed, typically every ~1 minute.")
    parser.add_argument("--expansion-window", type=int, default=3, metavar="N",
                        help="Min OI snapshots before direction is trusted and entries are allowed (default: 3). "
                             "Time to first entry = expansion_window × poll_interval seconds.")
    parser.add_argument("--target-profit", type=float, default=5000.0, metavar="INR",
                        help="Global profit target in INR (default: 5000)")
    parser.add_argument("--stop-loss", type=float, default=5000.0, metavar="INR",
                        help="Global stop loss in INR, positive value (default: 5000)")

    args = parser.parse_args()

    logger.info(
        f"Config | mode={'LIVE' if args.live else 'DRY'} lots={args.lots}"
        f" start={args.start_time}"
        f" pcr_threshold={args.pcr_threshold}"
        f" exit_pcr_change={args.exit_pcr_change}%"
        f" poll={args.poll_interval}s"
        f" expansion_window={args.expansion_window}"
        f" target={args.target_profit} sl={args.stop_loss}"
    )

    strategy = NiftyOIDirectional(
        dry_run=not args.live,
        lots=args.lots,
        start_time=args.start_time,
        pcr_threshold=args.pcr_threshold,
        exit_pcr_change_pct=args.exit_pcr_change,
        poll_interval=args.poll_interval,
        expansion_window=args.expansion_window,
        profit_target=args.target_profit,
        stop_loss=args.stop_loss,
    )

    try:
        strategy.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt — squaring off open position...")
        if strategy.in_position:
            strategy._exit_position("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
