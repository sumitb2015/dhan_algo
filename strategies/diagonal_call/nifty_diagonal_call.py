"""
Nifty Delta-Controlled, Low-Gamma Diagonal Covered-Call Strategy.

Long-dated calls (60–120 DTE, 0.55–0.65 Delta) provide convexity + vega.
Medium-dated calls (25–45 DTE, 0.15–0.22 Delta) provide theta.
Short quantity is dynamically sized from Delta.
Gamma determines defensive adjustments.

Standard Feature Kit (dhan-new-strategy):
  - Dry run default (--live required for real execution).
  - Multi-broker support (Dhan, Zerodha, Kotak) via ExecutionBroker.
  - Atomic position persistence (debug/<key>_position.json) and startup broker reconciliation.
  - Dashboard state bridge (debug/<key>_state.json) and graceful shutdown trigger.
  - Safe exit sizing using resolve_exit_qty_broker() and detect_phantom_leg_broker().
  - Continuous P&L accounting across rolls, trailing stop loss, and positional overnight holding.
"""

import argparse
import json
import logging
import math
import os
import sys
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple


def _find_project_root(start: str) -> str:
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "login.py")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("Could not locate project root (login.py)")
        d = parent


project_root = _find_project_root(os.path.dirname(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from lib.strategy_state_helper import (
        check_shutdown_trigger, exit_if_market_closed, flush_state,
        instance_log_suffix, parse_target_spec, save_strategy_state,
    )
    from lib.strategy_risk import resolve_exit_qty_broker, detect_phantom_leg_broker
    from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
    from lib.telegram_alert import notify
except ImportError:
    get_dhan_client = None
    DhanHelper = None
    check_shutdown_trigger = lambda *a, **k: False
    exit_if_market_closed = lambda *a, **k: None
    flush_state = lambda *a, **k: None
    instance_log_suffix = lambda *a, **k: ""
    parse_target_spec = lambda spec, base: float(spec) if isinstance(spec, (int, float)) else 5000.0
    save_strategy_state = lambda *a, **k: None
    resolve_exit_qty_broker = lambda *a, **k: (0, 0)
    detect_phantom_leg_broker = lambda *a, **k: False
    ExecutionBroker = None
    ExecutionBrokerError = Exception
    notify = lambda *a, **k: None

STRATEGY_KEY_DEFAULT = "nifty_diagonal_call"
LOG_FOLDER = "diagonal_call"
UNDERLYING = "NIFTY"
INDEX_ID = "13"
PRODUCT = "MARGIN"  # carry-forward positional hold

debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", LOG_FOLDER)
os.makedirs(log_dir, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        ),
        logging.StreamHandler(),
    ],
    force=True,
)
logger = logging.getLogger(__name__)


# ── PURE CALCULATION & GREEK FUNCTIONS (Unit Testable) ─────────────────────────

def compute_bs_greeks(
    spot: float,
    strike: float,
    dte_days: float,
    iv: float = 0.15,
    r: float = 0.07,
    opt_type: str = "CE",
) -> Dict[str, float]:
    """Standard Black-Scholes Greeks calculator using math.erf (zero external dependencies).

    Returns:
        delta: signed option delta (0.0 to 1.0 for CE, -1.0 to 0.0 for PE)
        gamma: option gamma per underlying point move per share (> 0)
        theta_day: option price decay in INR per calendar day (negative for long)
        vega: 1% vega (INR change per 1 percentage point IV move)
    """
    if spot <= 0 or strike <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta_day": 0.0, "vega": 0.0}

    t = max(dte_days, 0.25) / 365.0
    vol = max(iv, 0.05)
    sqrt_t = math.sqrt(t)

    d1 = (math.log(spot / strike) + (r + 0.5 * vol * vol) * t) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t

    nd1 = 0.5 * (1.0 + math.erf(d1 / math.sqrt(2.0)))
    np_d1 = (1.0 / math.sqrt(2.0 * math.pi)) * math.exp(-0.5 * d1 * d1)
    nd2 = 0.5 * (1.0 + math.erf(d2 / math.sqrt(2.0)))

    is_call = opt_type.upper() == "CE"
    delta = nd1 if is_call else (nd1 - 1.0)
    gamma = np_d1 / (spot * vol * sqrt_t)

    theta_annual = -(spot * np_d1 * vol) / (2.0 * sqrt_t) - r * strike * math.exp(-r * t) * (
        nd2 if is_call else (1.0 - nd2)
    )
    theta_day = theta_annual / 365.0
    vega = (spot * sqrt_t * np_d1) / 100.0

    return {
        "delta": float(delta),
        "gamma": float(gamma),
        "theta_day": float(theta_day),
        "vega": float(vega),
    }


def score_short_call(theta_day: float, gamma: float) -> float:
    """Computes the Short Call Efficiency Score = Theta Decay per Day / |Gamma|.

    theta_day is negative for option price decay; captured decay is -theta_day.
    A higher score delivers maximum theta collection per unit of short gamma risk taken.
    """
    decay = -theta_day
    if decay <= 0 or gamma <= 0:
        return 0.0
    return decay / gamma


def calculate_portfolio_greeks(
    long_leg: Optional[Dict],
    short_leg: Optional[Dict],
    spot: float,
    lot_size: int,
    r: float = 0.07,
) -> Dict[str, float]:
    """Aggregates portfolio Greeks across active long and short option legs.

    Units:
      - delta_shares: net Nifty delta shares (e.g. +13 delta units = +0.20 lots at lot size 65).
      - delta_lots: net delta in lot equivalents.
      - gamma: total portfolio gamma (per 1 pt index move in delta units).
      - theta_day: daily rupee theta earned (+ positive for net decay gain).
      - vega: net rupee portfolio change per 1% IV shift.
    """
    long_delta_shares = 0.0
    short_delta_shares = 0.0
    port_gamma = 0.0
    port_theta_day = 0.0
    port_vega = 0.0

    if long_leg and long_leg.get("lots", 0) > 0:
        l_qty = long_leg["lots"] * lot_size
        l_dte = max(0.5, float(long_leg.get("dte", 60)))
        l_iv = float(long_leg.get("iv", 0.15))
        g_l = compute_bs_greeks(spot, float(long_leg["strike"]), l_dte, iv=l_iv, r=r, opt_type="CE")
        long_delta_shares = l_qty * g_l["delta"]
        port_gamma += l_qty * g_l["gamma"]
        port_theta_day += l_qty * g_l["theta_day"]  # long decay is cost
        port_vega += l_qty * g_l["vega"]

    if short_leg and short_leg.get("lots", 0) > 0:
        s_qty = short_leg["lots"] * lot_size
        s_dte = max(0.5, float(short_leg.get("dte", 30)))
        s_iv = float(short_leg.get("iv", 0.15))
        g_s = compute_bs_greeks(spot, float(short_leg["strike"]), s_dte, iv=s_iv, r=r, opt_type="CE")
        short_delta_shares = s_qty * g_s["delta"]
        port_gamma -= s_qty * g_s["gamma"]          # short gamma is negative
        port_theta_day -= s_qty * g_s["theta_day"]  # short decay is income
        port_vega -= s_qty * g_s["vega"]

    net_delta_shares = long_delta_shares - short_delta_shares
    net_delta_lots = net_delta_shares / max(1, lot_size)

    # Classify Delta Zone
    if 0.0 <= net_delta_shares <= 20.0:
        delta_zone = "NORMAL_HOLD"
    elif -40.0 <= net_delta_shares < 0.0:
        delta_zone = "SLIGHTLY_BEARISH"
    elif net_delta_shares < -40.0:
        delta_zone = "DEFENSIVE"
    else:  # net_delta_shares > 20.0
        delta_zone = "TOO_BULLISH" if net_delta_shares > 30.0 else "MILD_BULLISH"

    # Classify Gamma Status
    if port_gamma > -0.10:
        gamma_status = "EXCELLENT"
    elif -0.15 <= port_gamma <= -0.10:
        gamma_status = "ACCEPTABLE"
    elif -0.20 <= port_gamma < -0.15:
        gamma_status = "CAUTION"
    else:
        gamma_status = "DEFENSIVE"

    return {
        "long_delta_shares": round(long_delta_shares, 2),
        "short_delta_shares": round(short_delta_shares, 2),
        "net_delta_shares": round(net_delta_shares, 2),
        "net_delta_lots": round(net_delta_lots, 2),
        "portfolio_gamma": round(port_gamma, 4),
        "portfolio_theta_day": round(port_theta_day, 2),
        "portfolio_vega": round(port_vega, 2),
        "delta_zone": delta_zone,
        "gamma_status": gamma_status,
    }


def calculate_required_short_lots(
    long_delta_shares: float,
    target_net_delta_shares: float,
    short_call_delta: float,
    lot_size: int,
    max_short_ratio: float = 1.25,
) -> int:
    """Calculates required short call lots based on delta:

    Formula:
      Target Short Delta = Long Delta - Target Net Delta
      Short Lots = Target Short Delta / (short_call_delta * lot_size)
      Clamped by: Total Short Delta <= max_short_ratio * Long Delta
    """
    if short_call_delta <= 0.001 or lot_size <= 0:
        return 0

    target_short_delta = max(0.0, long_delta_shares - target_net_delta_shares)
    raw_lots = int(round(target_short_delta / (short_call_delta * lot_size)))

    # Hard risk limit: Total short delta <= max_short_ratio * total long delta
    max_short_delta = long_delta_shares * max_short_ratio
    max_lots = max(1, int(max_short_delta / (short_call_delta * lot_size)))

    short_lots = max(1, min(raw_lots, max_lots))
    return short_lots


def check_short_roll_triggers(
    short_leg: Dict,
    current_short_ltp: float,
    current_short_delta: float,
    net_delta_shares: float,
    portfolio_gamma: float,
    short_roll_dte: int = 14,
    short_roll_delta: float = 0.35,
    short_profit_pct: float = 65.0,
    min_gamma_limit: float = -0.20,
) -> Tuple[bool, str]:
    """Evaluates whether the short call leg must be rolled or closed immediately.

    Triggers:
      1. DTE <= short_roll_dte (default 14 days)
      2. Short delta > short_roll_delta (default 0.35 strong rally, >0.50 emergency)
      3. Net delta < -40 (defensive)
      4. Portfolio gamma < min_gamma_limit (default -0.20)
      5. Profit taking: captured >= short_profit_pct (default 65% decay)
    """
    if not short_leg or short_leg.get("lots", 0) <= 0:
        return False, ""

    dte = float(short_leg.get("dte", 30))
    entry_price = float(short_leg.get("entry_price", 0.0))

    # Profit-taking trigger (captured 60–70% of premium)
    if entry_price > 0 and current_short_ltp > 0:
        decay_captured_pct = ((entry_price - current_short_ltp) / entry_price) * 100.0
        if decay_captured_pct >= short_profit_pct:
            return True, f"PROFIT_TARGET_CAPTURED ({decay_captured_pct:.1f}% >= {short_profit_pct}%)"

    # DTE threshold (avoid gamma explosion near expiry)
    if dte <= short_roll_dte:
        return True, f"DTE_THRESHOLD (DTE {dte:.0f} <= {short_roll_dte})"

    # Short call delta threshold (strong rally protection)
    if current_short_delta >= 0.50:
        return True, f"CRITICAL_SHORT_DELTA ({current_short_delta:.2f} >= 0.50)"
    if current_short_delta >= short_roll_delta:
        return True, f"SHORT_DELTA_EXPANSION ({current_short_delta:.2f} >= {short_roll_delta:.2f})"

    # Portfolio net delta defensive trigger
    if net_delta_shares < -40.0:
        return True, f"PORTFOLIO_DELTA_DEFENSIVE ({net_delta_shares:.1f} < -40)"

    # Portfolio gamma emergency trigger
    if portfolio_gamma < min_gamma_limit:
        return True, f"GAMMA_LIMIT_BREACH ({portfolio_gamma:.4f} < {min_gamma_limit})"

    return False, ""


def check_long_roll_triggers(long_leg: Dict, long_roll_dte: int = 35) -> Tuple[bool, str]:
    """Evaluates whether the long call leg must be rolled to maintain convexity."""
    if not long_leg or long_leg.get("lots", 0) <= 0:
        return False, ""
    dte = float(long_leg.get("dte", 90))
    if dte <= long_roll_dte:
        return True, f"LONG_DTE_THRESHOLD (DTE {dte:.0f} <= {long_roll_dte})"
    return False, ""


# ── STRATEGY IMPLEMENTATION CLASS ─────────────────────────────────────────────

class NiftyDiagonalCallStrategy:
    def __init__(
        self,
        live: bool = False,
        broker: str = "dhan",
        instance_id: str = "",
        long_lots: int = 3,
        target_net_delta: float = 13.0,
        long_target_delta: float = 0.60,
        long_min_dte: int = 60,
        long_max_dte: int = 120,
        long_roll_dte: int = 35,
        short_target_delta: float = 0.18,
        short_min_dte: int = 25,
        short_max_dte: int = 45,
        short_roll_dte: int = 14,
        short_roll_delta: float = 0.35,
        short_profit_pct: float = 65.0,
        capital: float = 500000.0,
        daily_loss_pct: float = 1.5,
        drawdown_halve_pct: float = 5.0,
        drawdown_exit_pct: float = 8.0,
        target_profit: str = "10%",
        stop_loss: str = "8%",
        start_time: str = "09:30",
        rebalance_times: str = "10:00,12:00,14:00",
        max_short_ratio: float = 1.25,
        min_gamma_limit: float = -0.20,
        helper: Optional[Any] = None,
    ):
        self.live = live
        self.dry_run = not live
        self.broker_name = broker
        self.instance_id = instance_id
        self.state_key = f"{STRATEGY_KEY_DEFAULT}_{instance_id}" if instance_id else STRATEGY_KEY_DEFAULT

        self.long_lots = max(2, min(long_lots, 4))
        self.target_net_delta = target_net_delta
        self.long_target_delta = long_target_delta
        self.long_min_dte = long_min_dte
        self.long_max_dte = long_max_dte
        self.long_roll_dte = long_roll_dte

        self.short_target_delta = short_target_delta
        self.short_min_dte = short_min_dte
        self.short_max_dte = short_max_dte
        self.short_roll_dte = short_roll_dte
        self.short_roll_delta = short_roll_delta
        self.short_profit_pct = short_profit_pct

        self.capital = capital
        self.daily_loss_pct = daily_loss_pct
        self.drawdown_halve_pct = drawdown_halve_pct
        self.drawdown_exit_pct = drawdown_exit_pct
        self.target_profit_spec = target_profit
        self.stop_loss_spec = stop_loss
        self.target_profit_rs = self._resolve_target_amount(target_profit)
        self.stop_loss_rs = self._resolve_target_amount(stop_loss)

        self.start_time = start_time
        self.rebalance_times = [t.strip() for t in rebalance_times.split(",") if t.strip()]
        self.max_short_ratio = max_short_ratio
        self.min_gamma_limit = min_gamma_limit

        self.status = "WAITING"
        self.position_open = False
        self.long_leg: Optional[Dict] = None
        self.short_leg: Optional[Dict] = None
        self.realized_pnl = 0.0
        self.daily_start_pnl = 0.0
        self.peak_pnl = 0.0
        self.last_rebalance_minute = ""
        self.drawdown_halved = False
        self.session_date = date.today().isoformat()
        self.last_phantom_check = 0.0

        # Initialize Dhan client and helper (or use injected helper for testing)
        if helper is not None:
            self.helper = helper
            self.dhan = getattr(helper, "dhan", None)
            self.broker = ExecutionBroker.create("dhan", self.helper, underlying=UNDERLYING, log=logger.info) if ExecutionBroker else None
        else:
            if get_dhan_client is None:
                raise RuntimeError("Dhan SDK / login module not found.")
            self.dhan = get_dhan_client()
            if not self.dhan:
                logger.error("Failed to authenticate with Dhan.")
                sys.exit(1)
            self.helper = DhanHelper(self.dhan)

            # Initialize ExecutionBroker
            try:
                self.broker = ExecutionBroker.create(self.broker_name, self.helper, underlying=UNDERLYING, log=logger.info)
            except ExecutionBrokerError as e:
                logger.error(f"Could not initialize {self.broker_name} execution broker: {e}")
                sys.exit(1)

        # Dynamic lot size
        self.lot_size = self.helper.get_lot_size(UNDERLYING)
        logger.info(
            f"Initialized {self.state_key} | Mode: {'LIVE' if self.live else 'DRY RUN'} | "
            f"Broker: {self.broker_name} | Lot Size: {self.lot_size} | "
            f"Target Profit: ₹{self.target_profit_rs:,.2f} | Stop Loss: ₹{self.stop_loss_rs:,.2f}"
        )

        # Start WebSocket feed for Nifty spot
        try:
            self.helper.start_websocket([("IDX_I", INDEX_ID, 15)])
            time.sleep(1.5)
        except Exception as e:
            logger.warning(f"Could not start index WebSocket: {e}")

        self.position_path = os.path.join(debug_dir, f"{self.state_key}_position.json")
        self.load_position()

    def _resolve_target_amount(self, raw_spec: Optional[str]) -> Optional[float]:
        """Resolves target profit or stop loss in rupees from either INR amount ('5000') or percent ('10%')."""
        if not raw_spec:
            return None
        try:
            val, is_pct = parse_target_spec(str(raw_spec).strip())
            return (val / 100.0) * self.capital if is_pct else float(val)
        except Exception as e:
            logger.warning(f"Could not parse target/stop spec '{raw_spec}': {e}")
            return None

    # ── PERSISTENCE & BROKER RECONCILIATION ────────────────────────────────────

    def save_position(self):
        """Atomic write of the active portfolio state to prevent torn file corruption."""
        payload = {
            "version": 1,
            "dry_run": self.dry_run,
            "position_open": self.position_open,
            "status": self.status,
            "long_leg": self.long_leg,
            "short_leg": self.short_leg,
            "realized_pnl": self.realized_pnl,
            "peak_pnl": self.peak_pnl,
            "daily_start_pnl": self.daily_start_pnl,
            "session_date": self.session_date,
            "drawdown_halved": self.drawdown_halved,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        os.makedirs(debug_dir, exist_ok=True)
        tmp = self.position_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, self.position_path)

    def load_position(self):
        """Restores position truth across script restarts and reconciles with broker."""
        if not os.path.exists(self.position_path):
            logger.info("No prior position state found on disk. Starting flat.")
            return

        try:
            with open(self.position_path, "r") as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"FATAL: Could not parse position file {self.position_path}: {e}")
            raise

        if not data.get("position_open", False):
            self.realized_pnl = float(data.get("realized_pnl", 0.0))
            return

        if bool(data.get("dry_run")) != self.dry_run:
            logger.error(
                f"FATAL: {self.position_path} holds a {'PAPER' if data.get('dry_run') else 'LIVE'} position "
                f"but this run is {'DRY' if self.dry_run else 'LIVE'}. Move the file aside after checking broker."
            )
            sys.exit(1)

        self.position_open = True
        self.status = data.get("status", "RUNNING")
        self.long_leg = data.get("long_leg")
        self.short_leg = data.get("short_leg")
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.peak_pnl = float(data.get("peak_pnl", 0.0))
        self.daily_start_pnl = float(data.get("daily_start_pnl", 0.0))
        self.session_date = data.get("session_date", date.today().isoformat())
        self.drawdown_halved = bool(data.get("drawdown_halved", False))

        logger.info(
            f"Restored open position: Long={self.long_leg.get('strike') if self.long_leg else None} CE "
            f"({self.long_leg.get('lots') if self.long_leg else 0} lots) | "
            f"Short={self.short_leg.get('strike') if self.short_leg else None} CE "
            f"({self.short_leg.get('lots') if self.short_leg else 0} lots) | "
            f"Realized P&L: ₹{self.realized_pnl:+.2f}"
        )

        # Resubscribe live market feed for recovered legs
        sub_list = []
        for leg in [self.long_leg, self.short_leg]:
            if leg and leg.get("security_id"):
                sub_list.append(("NSE_FNO", str(leg["security_id"]), 15))
        if sub_list:
            try:
                self.helper.subscribe_instruments(sub_list)
            except Exception as e:
                logger.warning(f"Could not resubscribe instruments: {e}")

        self._reconcile_broker()

    def _reconcile_broker(self):
        """Cross-checks loaded legs with broker truth. Dry-run skips reconciliation."""
        if self.dry_run:
            return
        logger.info(f"Reconciling open position against {self.broker_name} broker...")
        for name, leg in [("Long", self.long_leg), ("Short", self.short_leg)]:
            if leg and leg.get("strike") and leg.get("expiry"):
                net_qty = self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], "CE")
                expected_qty = leg["lots"] * self.lot_size * (1 if name == "Long" else -1)
                logger.info(f"Broker check {name} Leg ({leg['strike']} CE {leg['expiry']}): Expected {expected_qty}, Broker shows {net_qty}")
                if name == "Long" and net_qty <= 0:
                    logger.error(f"FATAL: Long call leg missing at broker on restart (net {net_qty})! Manual intervention needed.")

    # ── MULTI-BROKER ORDER & FILL HELPERS ───────────────────────────────────────

    def _get_broker_net(self, strike: float, expiry: str, opt_type: str = "CE") -> int:
        """Returns the broker's current net quantity for this contract (non-Dhan brokers)."""
        if self.dry_run or self.broker_name == "dhan":
            return 0
        try:
            return int(self.broker.get_owned_net_qty(strike, expiry, opt_type))
        except Exception:
            return 0

    def _wait_for_fill(
        self,
        oid: Optional[str],
        strike: float,
        expiry: str,
        opt_type: str,
        signed_qty: int,
        net_before: int,
        timeout: int = 15,
    ) -> bool:
        """True only when the order is confirmed filled across all brokers.

        - Dhan: uses helper.wait_for_fill(oid) via order update WS / REST.
        - Zerodha/Kotak: order IDs are not Dhan IDs, so polls broker's own net qty
          until it moves by signed_qty (accounting for positions held by sibling strategies).
        """
        if self.dry_run:
            return True
        if not oid:
            return False
        if self.broker_name == "dhan":
            return bool(self.helper.wait_for_fill(oid, timeout=timeout))

        expected = net_before + signed_qty
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(1)
            try:
                curr_net = self.broker.get_owned_net_qty(strike, expiry, opt_type)
                if curr_net == expected:
                    return True
            except Exception:
                continue
        logger.warning(
            f"Timeout waiting for {self.broker_name} fill on {opt_type} {strike} {expiry}: "
            f"expected net {expected}, timed out after {timeout}s"
        )
        return False

    def _get_fill_price(self, order_id: Optional[str], fallback_ltp: float = 0.0) -> float:
        """Safely retrieves the filled average execution price of an order.

        Prioritizes the WebSocket order update cache first (0 REST latency).
        Falls back to REST get_order_by_id(), then to fallback_ltp.
        Non-Dhan brokers (Zerodha/Kotak) return fallback_ltp immediately.
        """
        if not order_id or self.dry_run:
            return fallback_ltp
        if self.broker_name != "dhan":
            return fallback_ltp
        try:
            upd = self.helper.get_order_update(str(order_id))
            if isinstance(upd, dict):
                px = float(upd.get("tradedPrice") or upd.get("price") or upd.get("averageTradedPrice") or 0.0)
                if px > 0.0:
                    return px
            od = self.helper.get_order_by_id(str(order_id))
            if isinstance(od, dict):
                px = float(od.get("tradedPrice") or od.get("averageTradedPrice") or od.get("price") or 0.0)
                if px > 0.0:
                    return px
        except Exception as e:
            logger.warning(f"Could not read fill price for order {order_id}: {e}")
        return fallback_ltp

    def _get_current_iv(self) -> float:
        """Fetches dynamic IV estimate via India VIX (security ID 21), defaulting to 0.14."""
        try:
            vix_ltp = self.helper.get_ltp("21", exchange="IDX_I", instrument="INDEX")
            if vix_ltp > 0.0:
                return max(0.08, min(0.40, round(vix_ltp / 100.0, 4)))
        except Exception:
            pass
        return 0.14

    # ── OPTION SELECTION LOGIC ────────────────────────────────────────────────

    def _get_sorted_expiries(self) -> List[str]:
        """Fetches and sorts available NIFTY option expiries."""
        try:
            expiries = self.helper.get_expiries(UNDERLYING)
            today_str = date.today().strftime("%Y-%m-%d")
            valid = [e for e in expiries if e >= today_str]
            return sorted(valid)
        except Exception as e:
            logger.error(f"Error fetching expiries: {e}")
            return []

    def _compute_dte(self, expiry_str: str) -> float:
        try:
            exp_date = datetime.strptime(expiry_str, "%Y-%m-%d").date()
            diff = (exp_date - date.today()).days
            return max(0.5, float(diff))
        except Exception:
            return 30.0

    def select_long_call(self, spot: float) -> Optional[Dict]:
        """Selects ATM / slightly ITM call with 60–120 DTE and target delta ~0.55–0.65."""
        expiries = self._get_sorted_expiries()
        candidate_expiries = [
            e for e in expiries if self.long_min_dte <= self._compute_dte(e) <= self.long_max_dte
        ]
        if not candidate_expiries:
            # Fallback: closest expiry with DTE >= 45
            candidate_expiries = [e for e in expiries if self._compute_dte(e) >= 45]
            if not candidate_expiries:
                logger.error("No valid long-call expiries found in target range 60–120 DTE.")
                return None

        # Choose the candidate expiry closest to mid-range (~90 DTE)
        best_expiry = min(candidate_expiries, key=lambda e: abs(self._compute_dte(e) - 90))
        dte = self._compute_dte(best_expiry)

        df = self.helper._master_list
        matches = df[
            (df["UNDERLYING_SYMBOL"] == UNDERLYING)
            & (df["SM_EXPIRY_DATE"] == best_expiry)
            & (df["OPTION_TYPE"] == "CE")
        ]
        if matches.empty:
            logger.error(f"No CE options found in master list for expiry {best_expiry}")
            return None

        best_diff = 999.0
        best_strike = None
        best_sec_id = None
        best_delta = 0.60

        iv = self._get_current_iv()
        for _, row in matches.iterrows():
            k = float(row["STRIKE_PRICE"])
            sec_id = str(row["SECURITY_ID"])
            greeks = compute_bs_greeks(spot, k, dte, iv=iv, r=0.07, opt_type="CE")
            delta = greeks["delta"]
            diff = abs(delta - self.long_target_delta)
            if diff < best_diff:
                best_diff = diff
                best_strike = int(k)
                best_sec_id = sec_id
                best_delta = delta

        if not best_strike:
            return None

        ltp = self.helper.get_ltp(best_sec_id, exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0.0:
            ltp = max(50.0, spot - best_strike + 150.0)

        return {
            "security_id": best_sec_id,
            "strike": best_strike,
            "expiry": best_expiry,
            "dte": dte,
            "delta": round(best_delta, 2),
            "opt_type": "CE",
            "side": "BUY",
            "lots": self.long_lots,
            "entry_price": round(ltp, 2),
            "iv": iv,
        }

    def select_short_call(self, spot: float, long_delta_shares: float) -> Optional[Dict]:
        """Selects 25–45 DTE call with 0.15–0.22 delta that MAXIMIZES Score = Theta / |Gamma|."""
        expiries = self._get_sorted_expiries()
        candidate_expiries = [
            e for e in expiries if self.short_min_dte <= self._compute_dte(e) <= self.short_max_dte
        ]
        if not candidate_expiries:
            candidate_expiries = [e for e in expiries if self._compute_dte(e) >= 20]
            if not candidate_expiries:
                logger.error("No valid short-call expiries found in target range 25–45 DTE.")
                return None

        best_expiry = candidate_expiries[0]
        dte = self._compute_dte(best_expiry)

        df = self.helper._master_list
        matches = df[
            (df["UNDERLYING_SYMBOL"] == UNDERLYING)
            & (df["SM_EXPIRY_DATE"] == best_expiry)
            & (df["OPTION_TYPE"] == "CE")
        ]
        if matches.empty:
            logger.error(f"No CE options found in master list for expiry {best_expiry}")
            return None

        iv = self._get_current_iv()
        scored_candidates = []
        for _, row in matches.iterrows():
            k = float(row["STRIKE_PRICE"])
            sec_id = str(row["SECURITY_ID"])
            g = compute_bs_greeks(spot, k, dte, iv=iv, r=0.07, opt_type="CE")
            delta = g["delta"]
            if 0.14 <= delta <= 0.23:
                score = score_short_call(g["theta_day"], g["gamma"])
                scored_candidates.append({
                    "security_id": sec_id,
                    "strike": int(k),
                    "expiry": best_expiry,
                    "dte": dte,
                    "delta": delta,
                    "gamma": g["gamma"],
                    "theta_day": g["theta_day"],
                    "score": score,
                })

        if not scored_candidates:
            for _, row in matches.iterrows():
                k = float(row["STRIKE_PRICE"])
                sec_id = str(row["SECURITY_ID"])
                g = compute_bs_greeks(spot, k, dte, iv=iv, r=0.07, opt_type="CE")
                scored_candidates.append({
                    "security_id": sec_id,
                    "strike": int(k),
                    "expiry": best_expiry,
                    "dte": dte,
                    "delta": g["delta"],
                    "gamma": g["gamma"],
                    "theta_day": g["theta_day"],
                    "score": score_short_call(g["theta_day"], g["gamma"]),
                    "diff": abs(g["delta"] - self.short_target_delta),
                })
            scored_candidates.sort(key=lambda x: x.get("diff", 999.0))
            best = scored_candidates[0]
        else:
            scored_candidates.sort(key=lambda x: x["score"], reverse=True)
            best = scored_candidates[0]

        short_delta = best["delta"]
        short_lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=self.target_net_delta,
            short_call_delta=short_delta,
            lot_size=self.lot_size,
            max_short_ratio=self.max_short_ratio,
        )

        ltp = self.helper.get_ltp(best["security_id"], exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0.0:
            ltp = max(10.0, 50.0 - abs(spot - best["strike"]) * 0.05)

        logger.info(
            f"Selected Short Call: {best['strike']} CE | Expiry: {best_expiry} ({dte:.0f} DTE) | "
            f"Delta: {short_delta:.2f} | Score (Theta/|Gamma|): {best['score']:.1f} | Sized Lots: {short_lots}"
        )

        return {
            "security_id": best["security_id"],
            "strike": best["strike"],
            "expiry": best_expiry,
            "dte": dte,
            "delta": round(short_delta, 2),
            "opt_type": "CE",
            "side": "SELL",
            "lots": short_lots,
            "entry_price": round(ltp, 2),
            "iv": iv,
            "score": round(best["score"], 1),
        }

    # ── POSITION ENTRY & ORDER EXECUTION ──────────────────────────────────────

    def enter_cycle(self, spot: float):
        """Enters the diagonal covered call: long leg is bought FIRST, then short leg is sized and sold."""
        logger.info(f"--- Initiating New Diagonal Covered Call Entry at Spot {spot:.2f} ---")
        long_candidate = self.select_long_call(spot)
        if not long_candidate:
            logger.error("Could not find suitable long call contract. Aborting entry.")
            return

        long_qty = long_candidate["lots"] * self.lot_size
        long_delta_shares = long_qty * long_candidate["delta"]

        # Pre-validate candidate short leg before submitting live long order
        short_candidate = self.select_short_call(spot, long_delta_shares)
        if not short_candidate:
            logger.error("Could not find suitable short call contract. Aborting entry before buying long leg.")
            return

        if short_candidate["strike"] <= long_candidate["strike"]:
            logger.error(
                f"Inverted strike selection: short {short_candidate['strike']} <= long {long_candidate['strike']}. Aborting entry."
            )
            return

        logger.info(
            f"1. Entering Long Leg: {long_candidate['strike']} CE ({long_candidate['expiry']}) x {long_qty} units"
        )

        # 1. Place Long Buy Order
        if self.live:
            net_before = self._get_broker_net(long_candidate["strike"], long_candidate["expiry"], "CE")
            oid = self.broker.buy(
                strike=long_candidate["strike"],
                expiry=long_candidate["expiry"],
                opt_type="CE",
                qty=long_qty,
                product=PRODUCT,
            )
            if not oid:
                logger.error("Failed to place long buy order. Aborting.")
                return
            if not self._wait_for_fill(oid, long_candidate["strike"], long_candidate["expiry"], "CE", +long_qty, net_before, timeout=15):
                logger.error("Long buy order not confirmed filled within timeout. Aborting entry.")
                return
            fill_px = self._get_fill_price(oid, fallback_ltp=long_candidate["entry_price"])
            long_candidate["entry_price"] = fill_px

        self.long_leg = long_candidate
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(long_candidate["security_id"]), 15)])
        except Exception as e:
            logger.warning(f"Could not subscribe long leg: {e}")

        logger.info(f"Long Leg Filled at ₹{self.long_leg['entry_price']:.2f}. Total Long Delta: {long_delta_shares:.1f} shares.")

        # 2. Sizing and Entering Short Leg
        short_qty = short_candidate["lots"] * self.lot_size
        logger.info(
            f"2. Entering Short Leg: {short_candidate['strike']} CE ({short_candidate['expiry']}) x {short_qty} units"
        )

        if self.live:
            net_before = self._get_broker_net(short_candidate["strike"], short_candidate["expiry"], "CE")
            oid = self.broker.sell(
                strike=short_candidate["strike"],
                expiry=short_candidate["expiry"],
                opt_type="CE",
                qty=short_qty,
                product=PRODUCT,
            )
            if not oid:
                logger.error("Failed to place short sell order. Unwinding long leg.")
                self.exit_all(reason="SHORT_SELL_ORDER_FAILED")
                return
            if not self._wait_for_fill(oid, short_candidate["strike"], short_candidate["expiry"], "CE", -short_qty, net_before, timeout=15):
                logger.error("Short sell order not confirmed filled within timeout. Unwinding long leg.")
                self.exit_all(reason="SHORT_FILL_TIMEOUT")
                return
            fill_px = self._get_fill_price(oid, fallback_ltp=short_candidate["entry_price"])
            short_candidate["entry_price"] = fill_px

        self.short_leg = short_candidate
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(short_candidate["security_id"]), 15)])
        except Exception as e:
            logger.warning(f"Could not subscribe short leg: {e}")

        self.position_open = True
        self.status = "RUNNING"
        self.save_position()
        self._publish_state(spot)

        notify(
            f"[{self.state_key}] Position Entered:\n"
            f"Long: {self.long_leg['strike']} CE ({self.long_leg['lots']}L) @ ₹{self.long_leg['entry_price']:.1f}\n"
            f"Short: {self.short_leg['strike']} CE ({self.short_leg['lots']}L) @ ₹{self.short_leg['entry_price']:.1f}"
        )

    # ── ROLLS & DEFENSIVE ADJUSTMENTS ─────────────────────────────────────────

    def roll_short_leg(self, spot: float, reason: str):
        """Buys back current short call and rolls into a new 25–45 DTE call with optimal Theta/|Gamma|."""
        if not self.short_leg or not self.position_open:
            return

        logger.info(f"=== Rolling Short Call Leg | Reason: {reason} ===")
        old_leg = self.short_leg
        close_qty = old_leg["lots"] * self.lot_size

        # Resolve safe broker exit quantity
        if self.live:
            safe_qty, _ = resolve_exit_qty_broker(
                self.broker, old_leg["strike"], old_leg["expiry"], "CE", close_qty, side="BUY", log=logger
            )
            if safe_qty > 0:
                net_before = self._get_broker_net(old_leg["strike"], old_leg["expiry"], "CE")
                oid = self.broker.buy(
                    strike=old_leg["strike"],
                    expiry=old_leg["expiry"],
                    opt_type="CE",
                    qty=safe_qty,
                    product=PRODUCT,
                )
                if oid and self._wait_for_fill(oid, old_leg["strike"], old_leg["expiry"], "CE", +safe_qty, net_before, timeout=15):
                    fill_px = self._get_fill_price(oid, fallback_ltp=old_leg.get("current_ltp", old_leg["entry_price"]))
                else:
                    logger.error("Could not place or confirm buyback order for short leg roll.")
                    return
            else:
                fill_px = old_leg.get("current_ltp", old_leg["entry_price"])
        else:
            fill_px = old_leg.get("current_ltp", old_leg["entry_price"])

        closed_pnl = (old_leg["entry_price"] - fill_px) * close_qty
        self.realized_pnl += closed_pnl
        logger.info(f"Closed old short {old_leg['strike']} CE @ ₹{fill_px:.2f} | Leg P&L: ₹{closed_pnl:+.2f} | Cumulative Realized: ₹{self.realized_pnl:+.2f}")

        # Sizing and entering new short leg
        long_delta_shares = (self.long_leg["lots"] * self.lot_size * self.long_leg["delta"]) if self.long_leg else 0.0
        new_short = self.select_short_call(spot, long_delta_shares)
        if not new_short:
            logger.error("Could not select fresh short leg contract. Remaining in Long-Only position.")
            self.short_leg = None
            self.save_position()
            return

        new_qty = new_short["lots"] * self.lot_size
        logger.info(f"Opening fresh short leg: {new_short['strike']} CE ({new_short['expiry']}) x {new_qty} units")

        if self.live:
            net_before = self._get_broker_net(new_short["strike"], new_short["expiry"], "CE")
            oid = self.broker.sell(
                strike=new_short["strike"],
                expiry=new_short["expiry"],
                opt_type="CE",
                qty=new_qty,
                product=PRODUCT,
            )
            if oid and self._wait_for_fill(oid, new_short["strike"], new_short["expiry"], "CE", -new_qty, net_before, timeout=15):
                new_fill = self._get_fill_price(oid, fallback_ltp=new_short["entry_price"])
                new_short["entry_price"] = new_fill
            else:
                logger.error("Failed to place or confirm fresh short sell order. Remaining in Long-Only mode.")
                self.short_leg = None
                self.save_position()
                return

        self.short_leg = new_short
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(new_short["security_id"]), 15)])
        except Exception:
            pass

        self.save_position()
        self._publish_state(spot)
        notify(f"[{self.state_key}] Short Leg Rolled: {new_short['strike']} CE ({new_short['lots']}L). Realized: ₹{self.realized_pnl:+.2f}")

    def roll_long_leg(self, spot: float, reason: str):
        """Sells current long call and rolls into a new 60–120 DTE call with 0.55–0.65 delta."""
        if not self.long_leg or not self.position_open:
            return

        logger.info(f"=== Rolling Long Call Leg | Reason: {reason} ===")
        # Pre-validate candidate long call before closing existing long
        new_long = self.select_long_call(spot)
        if not new_long:
            logger.error("Could not find candidate long call for roll. Retaining current long position.")
            return

        old_leg = self.long_leg
        close_qty = old_leg["lots"] * self.lot_size

        if self.live:
            safe_qty, _ = resolve_exit_qty_broker(
                self.broker, old_leg["strike"], old_leg["expiry"], "CE", close_qty, side="SELL", log=logger
            )
            if safe_qty > 0:
                net_before = self._get_broker_net(old_leg["strike"], old_leg["expiry"], "CE")
                oid = self.broker.sell(
                    strike=old_leg["strike"],
                    expiry=old_leg["expiry"],
                    opt_type="CE",
                    qty=safe_qty,
                    product=PRODUCT,
                )
                if oid and self._wait_for_fill(oid, old_leg["strike"], old_leg["expiry"], "CE", -safe_qty, net_before, timeout=15):
                    fill_px = self._get_fill_price(oid, fallback_ltp=old_leg.get("current_ltp", old_leg["entry_price"]))
                else:
                    logger.error("Could not place or confirm sell order for long leg roll.")
                    return
            else:
                fill_px = old_leg.get("current_ltp", old_leg["entry_price"])
        else:
            fill_px = old_leg.get("current_ltp", old_leg["entry_price"])

        closed_pnl = (fill_px - old_leg["entry_price"]) * close_qty
        self.realized_pnl += closed_pnl
        logger.info(f"Closed old long {old_leg['strike']} CE @ ₹{fill_px:.2f} | Leg P&L: ₹{closed_pnl:+.2f}")

        # Enter fresh long call
        new_qty = new_long["lots"] * self.lot_size
        if self.live:
            net_before = self._get_broker_net(new_long["strike"], new_long["expiry"], "CE")
            oid = self.broker.buy(
                strike=new_long["strike"],
                expiry=new_long["expiry"],
                opt_type="CE",
                qty=new_qty,
                product=PRODUCT,
            )
            if oid and self._wait_for_fill(oid, new_long["strike"], new_long["expiry"], "CE", +new_qty, net_before, timeout=15):
                new_fill = self._get_fill_price(oid, fallback_ltp=new_long["entry_price"])
                new_long["entry_price"] = new_fill
            else:
                logger.error("Failed to buy new long call during roll. Unwinding short leg for safety.")
                self.exit_all(reason="NEW_LONG_ENTRY_FAILED_POST_ROLL")
                return

        self.long_leg = new_long
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(new_long["security_id"]), 15)])
        except Exception:
            pass

        self.save_position()
        self._publish_state(spot)
        notify(f"[{self.state_key}] Long Leg Rolled: {new_long['strike']} CE ({new_long['lots']}L).")

    def halve_short_position(self, spot: float, reason: str):
        """Halves short lots when drawdown reaches 5%."""
        if not self.short_leg or self.short_leg["lots"] <= 1 or self.drawdown_halved:
            return
        logger.info(f"--- Drawdown Protection: Halving Short Position ({reason}) ---")
        reduce_lots = max(1, self.short_leg["lots"] // 2)
        reduce_qty = reduce_lots * self.lot_size
        strike = self.short_leg["strike"]
        expiry = self.short_leg["expiry"]

        if self.live:
            safe_qty, _ = resolve_exit_qty_broker(
                self.broker, strike, expiry, "CE", reduce_qty, side="BUY", log=logger
            )
            if safe_qty > 0:
                net_before = self._get_broker_net(strike, expiry, "CE")
                oid = self.broker.buy(strike=strike, expiry=expiry, opt_type="CE", qty=safe_qty, product=PRODUCT)
                if oid and self._wait_for_fill(oid, strike, expiry, "CE", +safe_qty, net_before, timeout=15):
                    fill_px = self._get_fill_price(oid, fallback_ltp=self.short_leg.get("current_ltp", self.short_leg["entry_price"]))
                    self.realized_pnl += (self.short_leg["entry_price"] - fill_px) * safe_qty

        self.short_leg["lots"] -= reduce_lots
        self.drawdown_halved = True
        self.save_position()
        logger.info(f"Short position halved to {self.short_leg['lots']} lots.")

    def exit_all(self, reason: str = "MANUAL_STOP"):
        """Gracefully closes all legs (short leg first, then long leg) using safe exit sizing."""
        logger.info(f"=== SQUARING OFF ALL POSITIONS ({reason}) ===")
        self.status = "UNWINDING"
        exit_incomplete = False

        # 1. Close Short Leg First
        if self.short_leg and self.short_leg.get("lots", 0) > 0:
            qty = self.short_leg["lots"] * self.lot_size
            strike = self.short_leg["strike"]
            expiry = self.short_leg["expiry"]
            ltp = self.short_leg.get("current_ltp", self.short_leg["entry_price"])
            if self.live:
                safe_qty, _ = resolve_exit_qty_broker(self.broker, strike, expiry, "CE", qty, side="BUY", log=logger)
                if safe_qty > 0:
                    net_before = self._get_broker_net(strike, expiry, "CE")
                    oid = self.broker.buy(strike=strike, expiry=expiry, opt_type="CE", qty=safe_qty, product=PRODUCT)
                    if oid and self._wait_for_fill(oid, strike, expiry, "CE", +safe_qty, net_before, timeout=15):
                        ltp = self._get_fill_price(oid, fallback_ltp=ltp)
                    else:
                        logger.error("Could not confirm short leg close order.")
                        exit_incomplete = True
            self.realized_pnl += (self.short_leg["entry_price"] - ltp) * qty
            self.short_leg = None

        # 2. Close Long Leg Second
        if self.long_leg and self.long_leg.get("lots", 0) > 0:
            qty = self.long_leg["lots"] * self.lot_size
            strike = self.long_leg["strike"]
            expiry = self.long_leg["expiry"]
            ltp = self.long_leg.get("current_ltp", self.long_leg["entry_price"])
            if self.live:
                safe_qty, _ = resolve_exit_qty_broker(self.broker, strike, expiry, "CE", qty, side="SELL", log=logger)
                if safe_qty > 0:
                    net_before = self._get_broker_net(strike, expiry, "CE")
                    oid = self.broker.sell(strike=strike, expiry=expiry, opt_type="CE", qty=safe_qty, product=PRODUCT)
                    if oid and self._wait_for_fill(oid, strike, expiry, "CE", -safe_qty, net_before, timeout=15):
                        ltp = self._get_fill_price(oid, fallback_ltp=ltp)
                    else:
                        logger.error("Could not confirm long leg close order.")
                        exit_incomplete = True
            self.realized_pnl += (ltp - self.long_leg["entry_price"]) * qty
            self.long_leg = None

        self.position_open = False
        self.status = "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)" if exit_incomplete else "STOPPED"
        self.save_position()
        self._publish_state(0.0)
        notify(f"[{self.state_key}] Position Squared Off: {reason}. Status: {self.status}. Total Realized P&L: ₹{self.realized_pnl:+.2f}")

    # ── STATE PUBLISHING ──────────────────────────────────────────────────────

    def _publish_state(self, spot: float):
        """Publishes the state file for Next.js dashboard visibility."""
        unrealized = 0.0
        if self.long_leg and "current_ltp" in self.long_leg:
            unrealized += (self.long_leg["current_ltp"] - self.long_leg["entry_price"]) * (
                self.long_leg["lots"] * self.lot_size
            )
        if self.short_leg and "current_ltp" in self.short_leg:
            unrealized += (self.short_leg["entry_price"] - self.short_leg["current_ltp"]) * (
                self.short_leg["lots"] * self.lot_size
            )

        total_pnl = self.realized_pnl + unrealized
        greeks = calculate_portfolio_greeks(self.long_leg, self.short_leg, spot, self.lot_size)

        legs_data = {}
        if self.long_leg:
            legs_data["long_call"] = {
                "strike": self.long_leg["strike"],
                "expiry": self.long_leg["expiry"],
                "side": "BUY",
                "lots": self.long_leg["lots"],
                "entry_price": self.long_leg["entry_price"],
                "ltp": self.long_leg.get("current_ltp", self.long_leg["entry_price"]),
                "delta": self.long_leg.get("delta", 0.60),
                "dte": self.long_leg.get("dte", 90),
            }
        if self.short_leg:
            legs_data["short_call"] = {
                "strike": self.short_leg["strike"],
                "expiry": self.short_leg["expiry"],
                "side": "SELL",
                "lots": self.short_leg["lots"],
                "entry_price": self.short_leg["entry_price"],
                "ltp": self.short_leg.get("current_ltp", self.short_leg["entry_price"]),
                "delta": self.short_leg.get("delta", 0.18),
                "dte": self.short_leg.get("dte", 30),
            }

        state_payload = {
            "strategy": self.state_key,
            "status": self.status,
            "dry_run": self.dry_run,
            "broker": self.broker_name,
            "spot": spot,
            "total_pnl": round(total_pnl, 2),
            "realized_pnl": round(self.realized_pnl, 2),
            "unrealized_pnl": round(unrealized, 2),
            "lots": self.long_lots,
            "lot_size": self.lot_size,
            "greeks": greeks,
            "legs": legs_data,
            "capital": self.capital,
            "target_profit": self.target_profit_spec,
            "stop_loss": self.stop_loss_spec,
        }
        save_strategy_state(self.state_key, state_payload)

    # ── MAIN ENGINE LOOP ──────────────────────────────────────────────────────

    def run(self):
        logger.info(f"=== Starting Engine: {self.state_key} | Positional Diagonal Covered Call ===")
        exit_if_market_closed(self.helper, self.dry_run)

        while True:
            try:
                # 1. Check Graceful Dashboard Shutdown Trigger
                if check_shutdown_trigger(self.state_key):
                    logger.info("Shutdown trigger detected from dashboard. Closing positions and exiting.")
                    self.exit_all(reason="DASHBOARD_SHUTDOWN_TRIGGER")
                    break

                now = datetime.now()
                now_str = now.strftime("%H:%M")
                today_str = date.today().isoformat()

                # Session rollover check for daily loss baseline
                if today_str != self.session_date:
                    logger.info(f"New session date: {today_str}. Rolling over daily P&L baseline.")
                    self.session_date = today_str
                    self.daily_start_pnl = self.realized_pnl
                    self.save_position()

                # 2. Overnight Handling: After 15:25 IST, transition to HOLDING OVERNIGHT
                if now_str >= "15:25" or now_str < "09:15":
                    if self.position_open and self.status != "HOLDING OVERNIGHT":
                        self.status = "HOLDING OVERNIGHT"
                        logger.info("Market session closed. Transitioning to HOLDING OVERNIGHT.")
                        self._publish_state(0.0)

                    # Sleep through post-market with responsive shutdown check
                    for _ in range(30):
                        if check_shutdown_trigger(self.state_key):
                            logger.info("Shutdown trigger detected during overnight hold. Squaring off and exiting.")
                            self.exit_all(reason="DASHBOARD_SHUTDOWN_TRIGGER")
                            return
                        time.sleep(1)
                    continue

                # 3. Fetch Nifty Spot
                spot = self.helper.get_ltp(UNDERLYING, instrument="INDEX", exchange="IDX_I")
                if spot <= 0.0:
                    time.sleep(1)
                    continue

                # 4. Flat State & Entry Gate (No entries before 09:30 AM)
                if not self.position_open:
                    if now_str < self.start_time:
                        self.status = "WAITING"
                        self._publish_state(spot)
                        time.sleep(2)
                        continue
                    # Enter fresh cycle
                    self.enter_cycle(spot)
                    time.sleep(2)
                    continue

                # 5. Active Position Management: Fetch LTPs & Greeks
                curr_iv = self._get_current_iv()
                if self.long_leg:
                    sec_id = str(self.long_leg["security_id"])
                    ltp = self.helper.get_ltp(sec_id, exchange="NSE_FNO", instrument="OPTIDX")
                    if ltp > 0:
                        self.long_leg["current_ltp"] = ltp
                    dte = self._compute_dte(self.long_leg["expiry"])
                    self.long_leg["dte"] = dte
                    self.long_leg["iv"] = curr_iv
                    g = compute_bs_greeks(spot, float(self.long_leg["strike"]), dte, iv=curr_iv, r=0.07, opt_type="CE")
                    self.long_leg["delta"] = round(g["delta"], 2)

                if self.short_leg:
                    sec_id = str(self.short_leg["security_id"])
                    ltp = self.helper.get_ltp(sec_id, exchange="NSE_FNO", instrument="OPTIDX")
                    if ltp > 0:
                        self.short_leg["current_ltp"] = ltp
                    dte = self._compute_dte(self.short_leg["expiry"])
                    self.short_leg["dte"] = dte
                    self.short_leg["iv"] = curr_iv
                    g = compute_bs_greeks(spot, float(self.short_leg["strike"]), dte, iv=curr_iv, r=0.07, opt_type="CE")
                    self.short_leg["delta"] = round(g["delta"], 2)

                # 6. Phantom Leg Detection (Incident 2026-07-30 prevention)
                if not self.dry_run and time.time() - self.last_phantom_check >= 30.0:
                    self.last_phantom_check = time.time()
                    if self.long_leg:
                        is_phantom = detect_phantom_leg_broker(
                            self.broker,
                            self.long_leg["strike"],
                            self.long_leg["expiry"],
                            "CE",
                            self.long_leg["lots"] * self.lot_size,
                            side="BUY",
                            log=logger,
                        )
                        if is_phantom:
                            logger.error("FATAL: Long call leg vanished at broker! Emergency flattening short call to prevent naked risk.")
                            self.exit_all(reason="PHANTOM_LONG_LEG_DETECTED")
                            break

                # 7. Aggregate portfolio Greeks & P&L
                greeks = calculate_portfolio_greeks(self.long_leg, self.short_leg, spot, self.lot_size)
                unrealized = 0.0
                if self.long_leg and "current_ltp" in self.long_leg:
                    unrealized += (self.long_leg["current_ltp"] - self.long_leg["entry_price"]) * (
                        self.long_leg["lots"] * self.lot_size
                    )
                if self.short_leg and "current_ltp" in self.short_leg:
                    unrealized += (self.short_leg["entry_price"] - self.short_leg["current_ltp"]) * (
                        self.short_leg["lots"] * self.lot_size
                    )
                total_pnl = self.realized_pnl + unrealized
                self.peak_pnl = max(self.peak_pnl, total_pnl)

                # 8. Check Target Profit & Stop Loss
                if self.target_profit_rs and total_pnl >= self.target_profit_rs:
                    logger.info(f"Target Profit Reached: ₹{total_pnl:,.2f} >= ₹{self.target_profit_rs:,.2f}. Exiting.")
                    self.exit_all(reason="TARGET_PROFIT_REACHED")
                    break

                if self.stop_loss_rs and total_pnl <= -abs(self.stop_loss_rs):
                    logger.warning(f"Stop Loss Hit: ₹{total_pnl:,.2f} <= -₹{abs(self.stop_loss_rs):,.2f}. Exiting.")
                    self.exit_all(reason="STOP_LOSS_HIT")
                    break

                # 9. Portfolio Risk Checks & Strategy Drawdowns
                drawdown_rs = self.peak_pnl - total_pnl
                drawdown_pct = (drawdown_rs / self.capital) * 100.0 if self.capital > 0 else 0.0

                # Check Max Strategy Drawdown (8% hard exit)
                if drawdown_pct >= self.drawdown_exit_pct:
                    logger.warning(f"Strategy Max Drawdown Breached: {drawdown_pct:.1f}% >= {self.drawdown_exit_pct}%. Halting.")
                    self.exit_all(reason=f"MAX_DRAWDOWN_EXIT ({drawdown_pct:.1f}%)")
                    break

                # Check 5% Drawdown Halving
                if drawdown_pct >= self.drawdown_halve_pct and not self.drawdown_halved:
                    self.halve_short_position(spot, reason=f"DRAWDOWN_{drawdown_pct:.1f}%")

                # Daily Loss Limit Check
                daily_pnl = total_pnl - self.daily_start_pnl
                max_daily_loss = -(self.daily_loss_pct / 100.0) * self.capital
                if daily_pnl <= max_daily_loss:
                    logger.warning(f"Daily loss limit hit: ₹{daily_pnl:.2f} <= ₹{max_daily_loss:.2f}. Suspending adjustments.")

                # 10. Emergency Triggers Evaluation (Evaluated on every tick)
                if self.short_leg:
                    short_ltp = self.short_leg.get("current_ltp", self.short_leg["entry_price"])
                    short_delta = self.short_leg.get("delta", 0.18)
                    should_roll, roll_reason = check_short_roll_triggers(
                        self.short_leg,
                        current_short_ltp=short_ltp,
                        current_short_delta=short_delta,
                        net_delta_shares=greeks["net_delta_shares"],
                        portfolio_gamma=greeks["portfolio_gamma"],
                        short_roll_dte=self.short_roll_dte,
                        short_roll_delta=self.short_roll_delta,
                        short_profit_pct=self.short_profit_pct,
                        min_gamma_limit=self.min_gamma_limit,
                    )
                    if should_roll:
                        self.roll_short_leg(spot, reason=roll_reason)
                        continue

                # 11. Long Leg Roll Evaluation
                if self.long_leg:
                    should_roll_long, long_reason = check_long_roll_triggers(self.long_leg, self.long_roll_dte)
                    if should_roll_long:
                        self.roll_long_leg(spot, reason=long_reason)
                        continue

                # 12. Scheduled Rebalance Windows (10:00, 12:00, 14:00)
                current_hm = now.strftime("%H:%M")
                if current_hm in self.rebalance_times and current_hm != self.last_rebalance_minute:
                    self.last_rebalance_minute = current_hm
                    logger.info(f"--- Rebalance Window Check at {current_hm} | Net Delta: {greeks['net_delta_shares']:.1f} ({greeks['delta_zone']}) ---")
                    if greeks["delta_zone"] == "DEFENSIVE":
                        self.roll_short_leg(spot, reason=f"SCHEDULED_REBALANCE_DEFENSIVE (Delta {greeks['net_delta_shares']:.1f})")
                    elif greeks["delta_zone"] == "TOO_BULLISH" and greeks["portfolio_gamma"] > self.min_gamma_limit:
                        logger.info("Delta is too bullish (> +30). Rebalancing short exposure to target.")
                        self.roll_short_leg(spot, reason="SCHEDULED_REBALANCE_BULLISH_EXPOSURE")

                self._publish_state(spot)
                time.sleep(1.5)

            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received. Squaring off and exiting.")
                self.exit_all(reason="KEYBOARD_INTERRUPT")
                break
            except Exception as e:
                logger.error(f"Error in strategy loop: {e}", exc_info=True)
                time.sleep(3)


# ── CLI & SCRIPT ENTRYPOINT ───────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description="Nifty Delta-Controlled, Low-Gamma Diagonal Covered-Call Strategy.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry-run with default parameters:
  python strategies/diagonal_call/nifty_diagonal_call.py

  # Live execution with 3 long lots, 13 net delta units, Dhan broker:
  python strategies/diagonal_call/nifty_diagonal_call.py --live --broker dhan --long-lots 3 --target-net-delta 13.0
""",
    )
    parser.add_argument("--live", action="store_true", default=False, help="Place real broker orders (default: dry run paper).")
    parser.add_argument("--broker", type=str, default="dhan", choices=["dhan", "zerodha", "kotak"], help="Execution broker (default: dhan).")
    parser.add_argument("--instance-id", type=str, default="", help="Unique instance ID for multi-process isolation.")
    parser.add_argument("--long-lots", type=int, default=3, help="Core long call lots (default: 3, range 2-4).")
    parser.add_argument("--target-net-delta", type=float, default=13.0, help="Target portfolio net delta in shares/units (default: 13.0, approx +0.20 lots).")
    parser.add_argument("--long-target-delta", type=float, default=0.60, help="Target delta for long calls (default: 0.60, range 0.55-0.65).")
    parser.add_argument("--long-min-dte", type=int, default=60, help="Minimum DTE for long calls (default: 60).")
    parser.add_argument("--long-max-dte", type=int, default=120, help="Maximum DTE for long calls (default: 120).")
    parser.add_argument("--long-roll-dte", type=int, default=35, help="Roll long call when DTE falls below this (default: 35).")
    parser.add_argument("--short-target-delta", type=float, default=0.18, help="Target delta for short calls (default: 0.18, range 0.15-0.22).")
    parser.add_argument("--short-min-dte", type=int, default=25, help="Minimum DTE for short calls (default: 25).")
    parser.add_argument("--short-max-dte", type=int, default=45, help="Maximum DTE for short calls (default: 45).")
    parser.add_argument("--short-roll-dte", type=int, default=14, help="Roll short call when DTE falls below this (default: 14).")
    parser.add_argument("--short-roll-delta", type=float, default=0.35, help="Roll short call when its delta exceeds this (default: 0.35).")
    parser.add_argument("--short-profit-pct", type=float, default=65.0, help="Book profit on short call when decay reaches this %% (default: 65.0).")
    parser.add_argument("--capital", type=float, default=500000.0, help="Strategy capital allocation in INR (default: 500000.0).")
    parser.add_argument("--daily-loss-pct", type=float, default=1.5, help="Daily loss halt limit as %% of capital (default: 1.5%%).")
    parser.add_argument("--drawdown-halve-pct", type=float, default=5.0, help="Halve short lots at this %% drawdown (default: 5.0%%).")
    parser.add_argument("--drawdown-exit-pct", type=float, default=8.0, help="Hard exit strategy at this %% drawdown (default: 8.0%%).")
    parser.add_argument("--target-profit", type=str, default="10%", help="Target profit in INR or %% (default: 10%%).")
    parser.add_argument("--stop-loss", type=str, default="8%", help="Stop loss in INR or %% (default: 8%%).")
    parser.add_argument("--start-time", type=str, default="09:30", help="Session start time in HH:MM IST (default: 09:30).")
    parser.add_argument("--rebalance-times", type=str, default="10:00,12:00,14:00", help="Comma-separated rebalance times (default: 10:00,12:00,14:00).")
    parser.add_argument("--max-short-ratio", type=float, default=1.25, help="Max ratio of short delta to long delta (default: 1.25).")
    parser.add_argument("--min-gamma-limit", type=float, default=-0.20, help="Emergency negative gamma floor (default: -0.20).")
    args = parser.parse_args()

    # Post-parse validation with error collection (dhan-new-strategy rule)
    _errors = []
    if args.long_lots < 2 or args.long_lots > 4:
        _errors.append(f"--long-lots ({args.long_lots}) must be between 2 and 4.")
    if args.long_min_dte >= args.long_max_dte:
        _errors.append(f"--long-min-dte ({args.long_min_dte}) must be less than --long-max-dte ({args.long_max_dte}).")
    if args.short_min_dte >= args.short_max_dte:
        _errors.append(f"--short-min-dte ({args.short_min_dte}) must be less than --short-max-dte ({args.short_max_dte}).")
    if args.capital <= 0:
        _errors.append(f"--capital ({args.capital}) must be greater than 0.")
    if args.daily_loss_pct <= 0:
        _errors.append(f"--daily-loss-pct ({args.daily_loss_pct}) must be greater than 0.")
    if args.drawdown_halve_pct >= args.drawdown_exit_pct:
        _errors.append(f"--drawdown-halve-pct ({args.drawdown_halve_pct}) must be less than --drawdown-exit-pct ({args.drawdown_exit_pct}).")
    if args.min_gamma_limit >= 0:
        _errors.append(f"--min-gamma-limit ({args.min_gamma_limit}) must be negative (e.g. -0.20).")

    if _errors:
        for err in _errors:
            logger.error(f"[CONFIG ERROR] {err}")
        sys.exit(1)

    return args


if __name__ == "__main__":
    args = parse_args()
    strategy = NiftyDiagonalCallStrategy(
        live=args.live,
        broker=args.broker,
        instance_id=args.instance_id,
        long_lots=args.long_lots,
        target_net_delta=args.target_net_delta,
        long_target_delta=args.long_target_delta,
        long_min_dte=args.long_min_dte,
        long_max_dte=args.long_max_dte,
        long_roll_dte=args.long_roll_dte,
        short_target_delta=args.short_target_delta,
        short_min_dte=args.short_min_dte,
        short_max_dte=args.short_max_dte,
        short_roll_dte=args.short_roll_dte,
        short_roll_delta=args.short_roll_delta,
        short_profit_pct=args.short_profit_pct,
        capital=args.capital,
        daily_loss_pct=args.daily_loss_pct,
        drawdown_halve_pct=args.drawdown_halve_pct,
        drawdown_exit_pct=args.drawdown_exit_pct,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
        start_time=args.start_time,
        rebalance_times=args.rebalance_times,
        max_short_ratio=args.max_short_ratio,
        min_gamma_limit=args.min_gamma_limit,
    )
    strategy.run()
