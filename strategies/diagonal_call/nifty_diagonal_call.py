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
from datetime import date, datetime, timedelta
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
except ImportError as _import_exc:
    # Stubs exist only so the pure functions stay importable for unit tests; a real run must not
    # trade on them (exit sizing would return 0, shutdown trigger would be a no-op).
    _IMPORT_ERROR = _import_exc
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

_IMPORT_ERROR = globals().get("_IMPORT_ERROR")

STRATEGY_KEY_DEFAULT = "nifty_diagonal_call"
LOG_FOLDER = "diagonal_call"
UNDERLYING = "NIFTY"
INDEX_ID = "13"
PRODUCT = "MARGIN"  # carry-forward positional hold
NON_DHAN_GRACE_POLLS = 30       # 1s polls waiting for an uncancellable (Zerodha/Kotak) order to show up
UNKNOWN_EXIT_RETRY_SEC = 60     # exit retry spacing after an UNKNOWN close, so a late fill cannot be doubled
ROLL_COOLDOWN_SEC = 120         # pause before retrying a roll whose order failed (stops per-tick order spam)
ENTRY_MAX_ATTEMPTS = 5          # consecutive failed entries before entries halt (needs manual restart)
ENTRY_BACKOFF_BASE_SEC = 60     # 60s, 120s, 240s ... capped at ENTRY_BACKOFF_MAX_SEC
ENTRY_BACKOFF_MAX_SEC = 900
EXIT_NOTIFY_MIN_GAP_SEC = 300   # an incomplete exit alerts at most this often (the retry loop runs every few seconds)
EXIT_RETRY_SEC = 5              # pause between retries of an incomplete exit
# Short-roll reasons that stay allowed after the daily loss halt: they are maintenance /
# safety rolls (expiry proximity, runaway delta), not discretionary adjustments.
HALT_ALLOWED_ROLL_PREFIXES = ("DTE_THRESHOLD", "CRITICAL_SHORT_DELTA")
# Portfolio-level rolls: a roll re-sizes into the gamma budget, so repeating it back to back is churn.
ADJUST_ROLL_PREFIXES = ("GAMMA_LIMIT_BREACH", "PORTFOLIO_DELTA_DEFENSIVE", "SCHEDULED_REBALANCE")
ADJUST_COOLDOWN_SEC = 1800
LCR_DISPLAY_CAP_PCT = 999.9     # a long rolled at a big profit shrinks the debit; keep the displayed LCR sane
FREE_LCR_ENTER_PCT = 100.0      # "Free Long Call" regime starts here ...
FREE_LCR_EXIT_PCT = 90.0        # ... and only ends below this (hysteresis: unrealized gains evaporate)
GAMMA_FIT_FRACTION = 0.75       # size new shorts to <= 75% of the gamma floor so they do not re-breach it
SHORT_WINDOW_EXTENSION_DAYS = 14   # used only when no monthly expiry fits the short DTE window
FREE_SHORT_TARGET_DELTA = 0.115  # midpoint of the 0.08-0.15 band used in the Free Long Call regime


def monthly_expiries(expiries: List[str]) -> set:
    """The monthly series = the latest listed expiry in each calendar month.

    Preferred over the weekday heuristic below because it survives holiday-shifted expiries
    (a monthly moved off the last Tuesday is still the month's last listed expiry).
    """
    last: Dict[Tuple[str, str], str] = {}
    for e in expiries:
        key = (e[:4], e[5:7])
        if key not in last or e > last[key]:
            last[key] = e
    return set(last.values())


def is_monthly_expiry(expiry_str: str) -> bool:
    """Weekday heuristic: True when the expiry is the last occurrence of its weekday in its month.

    Fallback only (needs no expiry list); it misreads a holiday-shifted monthly, so the strategy
    uses monthly_expiries() on the listed expiries instead.
    """
    try:
        d = datetime.strptime(expiry_str, "%Y-%m-%d").date()
    except Exception:
        return False
    return (d + timedelta(days=7)).month != d.month

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
    max_short_lots: int = 6,
) -> int:
    """Calculates required short call lots based on delta:

    Formula:
      Target Short Delta = Long Delta - Target Net Delta
      Short Lots = Target Short Delta / (short_call_delta * lot_size)
      Clamped by: Total Short Delta <= max_short_ratio * Long Delta
      AND clamped by: Short Lots <= max_short_lots (hard margin risk ceiling)
    """
    if short_call_delta <= 0.001 or lot_size <= 0:
        return 0

    target_short_delta = max(0.0, long_delta_shares - target_net_delta_shares)
    raw_lots = int(round(target_short_delta / (short_call_delta * lot_size)))

    # Hard risk limit: Total short delta <= max_short_ratio * total long delta
    max_short_delta = long_delta_shares * max_short_ratio
    delta_capped_lots = max(1, int(max_short_delta / (short_call_delta * lot_size)))

    # Hard margin ceiling: clamp to max_short_lots
    ceiling = max(1, max_short_lots)
    short_lots = max(1, min(raw_lots, delta_capped_lots, ceiling))
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
        target_profit: str = "",
        stop_loss: str = "",
        start_time: str = "09:30",
        rebalance_times: str = "10:00,12:00,14:00",
        max_short_ratio: float = 1.25,
        max_short_lots: int = 6,
        min_gamma_limit: float = -0.20,
        min_iv: float = 0.10,
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
        self.max_short_lots = max(1, max_short_lots)
        self.min_gamma_limit = min_gamma_limit
        self.min_iv = min_iv

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
        self.last_spot = 0.0
        self.last_total_pnl = 0.0
        self.daily_halt_date = ""            # session date on which the daily loss limit latched
        self.pending_exit_reason: Optional[str] = None   # set while an exit is incomplete; retried by run()
        self.entry_attempts = 0
        self.next_entry_at = 0.0
        self.entry_halted = False
        self.roll_cooldown_until = 0.0
        self._expiry_cache: Tuple[float, List[str]] = (0.0, [])
        self.last_exit_notify = 0.0
        self.exit_retry_sleep = float(EXIT_RETRY_SEC)
        self._gamma_dormant_logged = False
        self.adjust_cooldown_until = 0.0
        self.short_resell_blocked = False    # set when a short vanished at the broker; do not fight a manual exit

        # Long Cost Recovery (LCR) & Free Long Call Engine
        self.initial_long_debit: float = 0.0
        self.cumulative_short_premium: float = 0.0
        self.lcr_pct: float = 0.0
        self.is_free_long_call: bool = False

        # Initialize Dhan client and helper (or use injected helper for testing)
        if helper is not None:
            self.helper = helper
            self.dhan = getattr(helper, "dhan", None)
            self.broker = ExecutionBroker.create("dhan", self.helper, underlying=UNDERLYING, log=logger.info) if ExecutionBroker else None  # test injection: never opens a Zerodha/Kotak session
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
            f"Target Profit: {f'₹{self.target_profit_rs:,.2f}' if self.target_profit_rs else 'off'} | "
            f"Stop Loss: {f'₹{self.stop_loss_rs:,.2f}' if self.stop_loss_rs else 'off'}"
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

    def compute_lcr(self) -> Tuple[float, float, bool]:
        """Computes Long Cost Recovery (LCR) metric:

        LCR = (Cumulative Net Short Premium / Initial Long Option Debit) * 100%

        Stages:
          0–25%: Early stage
          25–50%: Good progress
          50–75%: Significant cost recovered
          75–100%: Long option mostly funded
          >=100%: 'FREE LONG CALL' achieved! Long option completely funded by short decay.

        Returns:
            Tuple of (lcr_pct, total_net_short_premium, is_free_long_call)
        """
        if self.initial_long_debit <= 0.0:
            if self.long_leg and self.long_leg.get("entry_price", 0.0) > 0:
                self.initial_long_debit = float(self.long_leg["entry_price"]) * (
                    self.long_leg.get("lots", self.long_lots) * self.lot_size
                )
        if self.initial_long_debit <= 0.0:
            return 0.0, 0.0, False

        unrealized_short = 0.0
        if self.short_leg and "current_ltp" in self.short_leg:
            unrealized_short = (self.short_leg["entry_price"] - self.short_leg["current_ltp"]) * (
                self.short_leg["lots"] * self.lot_size
            )

        total_short_premium = self.cumulative_short_premium + unrealized_short
        lcr_pct = min(LCR_DISPLAY_CAP_PCT, (total_short_premium / self.initial_long_debit) * 100.0)
        is_free = lcr_pct >= FREE_LCR_ENTER_PCT or (self.is_free_long_call and lcr_pct >= FREE_LCR_EXIT_PCT)
        self.lcr_pct = round(lcr_pct, 1)
        self.is_free_long_call = is_free
        return self.lcr_pct, round(total_short_premium, 2), is_free

    def save_position(self):
        """Atomic write of the active portfolio state to prevent torn file corruption."""
        self.compute_lcr()
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
            "last_total_pnl": round(self.last_total_pnl, 2),
            "daily_halt_date": self.daily_halt_date,
            "short_resell_blocked": self.short_resell_blocked,
            "initial_long_debit": round(self.initial_long_debit, 2),
            "cumulative_short_premium": round(self.cumulative_short_premium, 2),
            "lcr_pct": self.lcr_pct,
            "is_free_long_call": self.is_free_long_call,
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
            self.cumulative_short_premium = float(data.get("cumulative_short_premium", 0.0))
            self.initial_long_debit = float(data.get("initial_long_debit", 0.0))
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
        self.last_total_pnl = float(data.get("last_total_pnl", self.realized_pnl))
        self.daily_halt_date = str(data.get("daily_halt_date", ""))
        self.short_resell_blocked = bool(data.get("short_resell_blocked", False))
        if self.status == "EXIT_PENDING":
            # Process died mid-exit: finish unwinding whatever legs are still recorded.
            self.pending_exit_reason = "RESTART_RESUME_EXIT"
        self.initial_long_debit = float(data.get("initial_long_debit", 0.0))
        self.cumulative_short_premium = float(data.get("cumulative_short_premium", 0.0))
        self.lcr_pct = float(data.get("lcr_pct", 0.0))
        self.is_free_long_call = bool(data.get("is_free_long_call", False))

        if self.initial_long_debit <= 0.0 and self.long_leg and self.long_leg.get("entry_price", 0.0) > 0:
            self.initial_long_debit = float(self.long_leg["entry_price"]) * (
                self.long_leg.get("lots", self.long_lots) * self.lot_size
            )

        self.compute_lcr()

        logger.info(
            f"Restored open position: Long={self.long_leg.get('strike') if self.long_leg else None} CE "
            f"({self.long_leg.get('lots') if self.long_leg else 0} lots) | "
            f"Short={self.short_leg.get('strike') if self.short_leg else None} CE "
            f"({self.short_leg.get('lots') if self.short_leg else 0} lots) | "
            f"Realized P&L: ₹{self.realized_pnl:+.2f} | Long Cost Recovery (LCR): {self.lcr_pct:.1f}% "
            f"({'FREE LONG CALL' if self.is_free_long_call else 'RECOVERY IN PROGRESS'})"
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
        """Cross-checks loaded legs with broker truth. Dry-run skips reconciliation.

        Only the dangerous mismatch is acted on: a short with no long behind it is unwound.
        A missing short is left to the periodic phantom check (an unresolvable contract also
        reads as 0, so dropping a short here could hide a real one).
        """
        if self.dry_run:
            return
        logger.info(f"Reconciling open position against {self.broker_name} broker...")
        for name, leg in [("Long", self.long_leg), ("Short", self.short_leg)]:
            if leg and leg.get("strike") and leg.get("expiry"):
                net_qty = self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], "CE")
                expected_qty = leg["lots"] * self.lot_size * (1 if name == "Long" else -1)
                logger.info(f"Broker check {name} Leg ({leg['strike']} CE {leg['expiry']}): Expected {expected_qty}, Broker shows {net_qty}")
                if name == "Long" and net_qty <= 0:
                    logger.error(f"FATAL: Long call leg missing at broker on restart (net {net_qty})!")
                    if self.short_leg:
                        logger.error("Short is uncovered - queueing an immediate unwind.")
                        notify(f"[{self.state_key}] Long leg missing at broker on restart; unwinding the short.")
                        self.pending_exit_reason = "RECONCILE_LONG_MISSING"
                elif name == "Short" and net_qty >= 0:
                    logger.error("Short leg not visible at broker on restart; leaving it to the phantom check. Verify manually.")
                    notify(f"[{self.state_key}] Short leg not visible at broker on restart - verify manually.")

    # ── MULTI-BROKER ORDER & FILL HELPERS ───────────────────────────────────────

    def _get_broker_net(self, strike: float, expiry: str, opt_type: str = "CE") -> int:
        """Returns the broker's current net quantity for this contract (0 in dry run; raises on lookup failure)."""
        if self.dry_run:
            return 0
        try:
            return int(self.broker.get_owned_net_qty(strike, expiry, opt_type))
        except Exception as e:
            # A fake 0 would corrupt the fill check against sibling positions. Raising here is safe:
            # every caller reads this BEFORE placing its order, and run() retries on the next tick.
            raise RuntimeError(f"Broker net-qty lookup failed for {opt_type} {strike} {expiry}: {e}") from e

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

    def _confirm_fill_or_cancel(
        self, oid, strike, expiry, opt_type, signed_qty, net_before, timeout: int = 15
    ) -> Tuple[str, Optional[int]]:
        """Confirm an order filled; on timeout cancel it and re-read the broker position.

        Returns (status, moved_qty): status is FILLED, NOT_FILLED or PARTIAL (partial or unknown),
        moved_qty is the signed qty the broker position actually moved (None if unreadable).
        A timeout alone never proves the order is dead, so the caller must not retry on NOT_FILLED
        without this cancel+re-read — otherwise a late fill is bought twice.
        """
        if self._wait_for_fill(oid, strike, expiry, opt_type, signed_qty, net_before, timeout=timeout):
            return "FILLED", signed_qty
        if self.dry_run:
            return "NOT_FILLED", 0
        if self.broker_name == "dhan":
            try:
                self.helper.cancel_order(str(oid))
            except Exception as e:
                logger.warning(f"Could not cancel unconfirmed order {oid}: {e}")
            time.sleep(1.0)
            grace = 1
        else:
            # Zerodha/Kotak orders cannot be cancelled from here, so "no position change yet" does NOT mean
            # "not filled": the market order may still land. Give it a long grace window, and if the position
            # still has not moved report the outcome as UNKNOWN (PARTIAL with moved=None) so the caller halts
            # instead of retrying into a duplicate.
            grace = NON_DHAN_GRACE_POLLS
        moved: Optional[int] = None
        for i in range(grace):
            try:
                moved = int(self.broker.get_owned_net_qty(strike, expiry, opt_type)) - net_before
            except Exception as e:
                logger.error(f"Could not re-read broker position after unconfirmed order {oid}: {e}")
                return "PARTIAL", None
            if moved == signed_qty:
                return "FILLED", moved
            if i < grace - 1:
                time.sleep(1.0)
        if moved == 0:
            if self.broker_name == "dhan":
                return "NOT_FILLED", 0
            logger.error(f"{self.broker_name} order {oid} unconfirmed after {grace}s and cannot be cancelled: outcome UNKNOWN.")
            return "PARTIAL", None
        return "PARTIAL", moved

    def _close_leg(self, leg: Dict, closing_side: str) -> Tuple[bool, float, int]:
        """Closes one leg using own-quantity sizing. closing_side: 'BUY' for a short, 'SELL' for a long.

        Returns (closed, fill_px, done_qty). closed is True only when the broker confirms the leg
        flat (or it is already flat / dry run). On a partial or unconfirmed close, done_qty is the
        quantity that did trade so the caller can book it and shrink the leg.
        """
        qty = leg["lots"] * self.lot_size
        ltp = leg.get("current_ltp", leg["entry_price"])
        if not self.live:
            return True, ltp, qty
        strike, expiry = leg["strike"], leg["expiry"]
        safe_qty, _ = resolve_exit_qty_broker(self.broker, strike, expiry, "CE", qty, side=closing_side, log=logger)
        if safe_qty <= 0:
            return True, ltp, 0  # broker already shows the leg flat (closed elsewhere): nothing to book
        signed = safe_qty if closing_side == "BUY" else -safe_qty
        net_before = self._get_broker_net(strike, expiry, "CE")
        place = self.broker.buy if closing_side == "BUY" else self.broker.sell
        oid = place(strike=strike, expiry=expiry, opt_type="CE", qty=safe_qty, product=PRODUCT)
        if not oid:
            logger.error(f"{closing_side} order for {strike} CE {expiry} was not placed.")
            return False, ltp, 0
        status, moved = self._confirm_fill_or_cancel(oid, strike, expiry, "CE", signed, net_before)
        if status == "FILLED":
            # safe_qty < qty means the remainder was already closed elsewhere: the leg is flat either way.
            return True, self._get_fill_price(oid, fallback_ltp=ltp), safe_qty
        if moved is None:
            self.exit_retry_sleep = float(UNKNOWN_EXIT_RETRY_SEC)  # outcome unknown: wait before any retry
        done = abs(moved) if moved else 0
        logger.error(f"{closing_side} close of {strike} CE {expiry} {status}: {done} of {safe_qty} units traded.")
        return False, ltp, done

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
        """Fetches and sorts available NIFTY option expiries (cached for 60s: one selection reads it several times)."""
        today_str = date.today().strftime("%Y-%m-%d")
        cached_at, cached = self._expiry_cache
        if cached and time.time() - cached_at < 60.0 and cached[0] >= today_str:
            return cached
        try:
            expiries = self.helper.get_expiries(UNDERLYING)
            valid = sorted(e for e in expiries if e >= today_str)
            self._expiry_cache = (time.time(), valid)
            return valid
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

    def _monthly_expiries_in_window(self, min_dte: int, max_dte: int) -> List[str]:
        """Monthly (non-weekly) expiries whose DTE lies inside [min_dte, max_dte]. No out-of-range fallback."""
        expiries = self._get_sorted_expiries()
        monthlies = monthly_expiries(expiries)
        return [e for e in expiries if e in monthlies and min_dte <= self._compute_dte(e) <= max_dte]

    def _ce_rows(self, expiry: str):
        df = self.helper._master_list
        return df[
            (df["UNDERLYING_SYMBOL"] == UNDERLYING)
            & (df["SM_EXPIRY_DATE"] == expiry)
            & (df["OPTION_TYPE"] == "CE")
        ]

    def select_long_call(self, spot: float) -> Optional[Dict]:
        """Selects an ATM / slightly ITM call on a monthly expiry, 60-120 DTE, delta nearest the target."""
        candidate_expiries = self._monthly_expiries_in_window(self.long_min_dte, self.long_max_dte)
        if not candidate_expiries:
            logger.error(f"No monthly expiry in the {self.long_min_dte}-{self.long_max_dte} DTE window for the long call.")
            return None

        # Choose the candidate expiry closest to mid-range (~90 DTE)
        best_expiry = min(candidate_expiries, key=lambda e: abs(self._compute_dte(e) - 90))
        dte = self._compute_dte(best_expiry)

        matches = self._ce_rows(best_expiry)
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
            logger.warning(f"No live quote for long {best_strike} CE ({best_expiry}); skipping selection (no synthetic prices).")
            return None

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

    def _effective_max_short_ratio(self) -> float:
        return min(self.max_short_ratio, 0.60) if self.is_free_long_call else self.max_short_ratio

    def _fit_lots_to_gamma(self, long_leg: Optional[Dict], short_proto: Dict, spot: float, lots: int) -> int:
        """Reduce short lots until projected portfolio gamma is back inside the gamma budget.

        Budget = GAMMA_FIT_FRACTION x the emergency floor (-0.15 at the default -0.20): a new short
        sized exactly at the floor would re-trigger the gamma roll on the very next tick.
        """
        if not long_leg:
            return lots
        budget = self.min_gamma_limit * GAMMA_FIT_FRACTION
        while lots > 1:
            proj = calculate_portfolio_greeks(
                long_leg, dict(short_proto, lots=lots), spot, self.lot_size
            )["portfolio_gamma"]
            if proj >= budget:
                break
            lots -= 1
        if not self._gamma_dormant_logged:
            proj = calculate_portfolio_greeks(long_leg, dict(short_proto, lots=lots), spot, self.lot_size)["portfolio_gamma"]
            if proj > budget / 2.0:
                self._gamma_dormant_logged = True
                logger.info(
                    f"Gamma guard note: {lots} short lots project portfolio gamma {proj:.4f}, well inside the "
                    f"{budget:.2f} budget. At this size (max {self.max_short_lots} lots) the gamma trim and the "
                    f"{self.min_gamma_limit:.2f} breach roll are effectively dormant; the delta rules do the work."
                )
        return lots

    def select_short_call(
        self, spot: float, long_delta_shares: float, long_leg: Optional[Dict] = None
    ) -> Optional[Dict]:
        """Selects the short call: monthly expiry, 25-45 DTE, delta in band, expiring before the long.

        Ranking: closest delta to the regime target (0.18, or 0.115 in the Free Long Call regime);
        Theta/|Gamma| only breaks ties within 0.02 delta. Theta/|Gamma| is ~0.5*sigma^2*S^2 for every
        strike, so as the primary key it always drifted to the highest-delta edge of the band.
        Returns None (never an out-of-band strike) when nothing qualifies.
        """
        iv = self._get_current_iv()
        if iv < self.min_iv:
            logger.warning(f"IV {iv:.1%} below --min-iv {self.min_iv:.1%}; not selling a short call now.")
            return None

        long_expiry = (long_leg or self.long_leg or {}).get("expiry")
        def _short_expiries(max_dte: int) -> List[str]:
            return [
                e for e in self._monthly_expiries_in_window(self.short_min_dte, max_dte)
                if not long_expiry or e < long_expiry
            ]

        candidate_expiries = _short_expiries(self.short_max_dte)
        if not candidate_expiries:
            # Monthlies are 4-5 weeks apart, so a 25-45 DTE window can legitimately hold none. Widen the
            # upper bound (never to a weekly) rather than sit long-only for days.
            candidate_expiries = _short_expiries(self.short_max_dte + SHORT_WINDOW_EXTENSION_DAYS)
            if candidate_expiries:
                logger.warning(f"No monthly expiry within {self.short_max_dte} DTE; using the nearest monthly up to {self.short_max_dte + SHORT_WINDOW_EXTENSION_DAYS} DTE.")
        if not candidate_expiries:
            logger.error(
                f"No monthly expiry in the {self.short_min_dte}-{self.short_max_dte} DTE window "
                f"that expires before the long ({long_expiry})."
            )
            return None

        lcr_pct, total_short_px, is_free = self.compute_lcr()
        if is_free:
            logger.info(
                f"*** FREE LONG CALL REGIME ACTIVE (LCR: {lcr_pct:.1f}% >= {FREE_LCR_ENTER_PCT:.0f}%) *** "
                "Defensive posture: targeting low-delta short calls (0.08–0.15) and capping short lots to reduce short gamma."
            )
            min_target_delta, max_target_delta = 0.08, 0.15
            target_delta = FREE_SHORT_TARGET_DELTA
        else:
            min_target_delta, max_target_delta = 0.15, 0.22
            target_delta = self.short_target_delta

        candidates = []
        for expiry in candidate_expiries:
            dte = self._compute_dte(expiry)
            matches = self._ce_rows(expiry)
            for _, row in matches.iterrows():
                k = float(row["STRIKE_PRICE"])
                g = compute_bs_greeks(spot, k, dte, iv=iv, r=0.07, opt_type="CE")
                if min_target_delta <= g["delta"] <= max_target_delta:
                    candidates.append({
                        "security_id": str(row["SECURITY_ID"]),
                        "strike": int(k),
                        "expiry": expiry,
                        "dte": dte,
                        "delta": g["delta"],
                        "diff": abs(g["delta"] - target_delta),
                        "score": score_short_call(g["theta_day"], g["gamma"]),
                    })

        if not candidates:
            logger.error(f"No short call with delta in {min_target_delta:.2f}-{max_target_delta:.2f}; not selling out of band.")
            return None

        closest = min(c["diff"] for c in candidates)
        best = max((c for c in candidates if c["diff"] <= closest + 0.02), key=lambda c: c["score"])

        short_delta = best["delta"]
        short_lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=self.target_net_delta,
            short_call_delta=short_delta,
            lot_size=self.lot_size,
            max_short_ratio=self._effective_max_short_ratio(),
            max_short_lots=self.max_short_lots,
        )
        if self.drawdown_halved:
            short_lots = max(1, short_lots // 2)
        short_lots = self._fit_lots_to_gamma(
            long_leg or self.long_leg, {"strike": best["strike"], "dte": best["dte"], "iv": iv}, spot, short_lots
        )

        ltp = self.helper.get_ltp(best["security_id"], exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0.0:
            logger.warning(f"No live quote for short {best['strike']} CE ({best['expiry']}); skipping selection (no synthetic prices).")
            return None

        logger.info(
            f"Selected Short Call: {best['strike']} CE | Expiry: {best['expiry']} ({best['dte']:.0f} DTE) | "
            f"Delta: {short_delta:.2f} (target {target_delta:.2f}) | Score (Theta/|Gamma|): {best['score']:.1f} | "
            f"Sized Lots: {short_lots} (Regime: {'FREE LONG CALL' if is_free else 'NORMAL RECOVERY'})"
        )

        return {
            "security_id": best["security_id"],
            "strike": best["strike"],
            "expiry": best["expiry"],
            "dte": best["dte"],
            "delta": round(short_delta, 2),
            "opt_type": "CE",
            "side": "SELL",
            "lots": short_lots,
            "entry_price": round(ltp, 2),
            "iv": iv,
            "score": round(best["score"], 1),
            "is_free_long_call": is_free,
        }

    # ── POSITION ENTRY & ORDER EXECUTION ──────────────────────────────────────

    def enter_cycle(self, spot: float) -> bool:
        """Enters the diagonal covered call: long leg is bought FIRST, then short leg is sized and sold.

        Returns True when both legs are open. Any False return is counted by run() as a failed
        attempt (backoff, then halt), so a stuck entry cannot hammer the broker.
        """
        logger.info(f"--- Initiating New Diagonal Covered Call Entry at Spot {spot:.2f} ---")
        long_candidate = self.select_long_call(spot)
        if not long_candidate:
            logger.error("Could not find suitable long call contract. Aborting entry.")
            return False

        long_qty = long_candidate["lots"] * self.lot_size
        long_delta_shares = long_qty * long_candidate["delta"]

        # Pre-validate candidate short leg before submitting live long order
        short_candidate = self.select_short_call(spot, long_delta_shares, long_leg=long_candidate)
        if not short_candidate:
            logger.error("Could not find suitable short call contract. Aborting entry before buying long leg.")
            return False

        if short_candidate["strike"] <= long_candidate["strike"]:
            logger.error(
                f"Inverted strike selection: short {short_candidate['strike']} <= long {long_candidate['strike']}. Aborting entry."
            )
            return False

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
                return False
            status, moved = self._confirm_fill_or_cancel(
                oid, long_candidate["strike"], long_candidate["expiry"], "CE", +long_qty, net_before
            )
            if status == "NOT_FILLED":
                logger.error("Long buy not filled; order cancelled and broker position unchanged. Aborting entry.")
                return False
            if status == "PARTIAL":
                self.entry_halted = True
                logger.error(f"FATAL: long buy ended partial/unknown (moved {moved}). Entries halted - verify the broker position manually.")
                notify(f"[{self.state_key}] Long entry ended PARTIAL/UNKNOWN (moved {moved}). Entries halted - verify broker manually.")
                return False
            fill_px = self._get_fill_price(oid, fallback_ltp=long_candidate["entry_price"])
            long_candidate["entry_price"] = fill_px

        self.long_leg = long_candidate
        long_cost = self.long_leg["entry_price"] * long_qty
        if self.initial_long_debit <= 0.0:
            self.initial_long_debit = long_cost
            logger.info(
                f"Initial Long Call Debit Established: ₹{self.initial_long_debit:,.2f} "
                f"({self.long_leg['lots']} lots @ ₹{self.long_leg['entry_price']:.2f})"
            )

        # Persist the long immediately so a crash before the short fills cannot orphan it.
        self.position_open = True
        self.status = "ENTERING"
        self.save_position()

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
                return False
            status, moved = self._confirm_fill_or_cancel(
                oid, short_candidate["strike"], short_candidate["expiry"], "CE", -short_qty, net_before
            )
            if status == "NOT_FILLED":
                logger.error("Short sell not filled; order cancelled. Unwinding long leg.")
                self.exit_all(reason="SHORT_FILL_TIMEOUT")
                return False
            if status == "PARTIAL":
                self.entry_halted = True
                filled_lots = abs(moved) // self.lot_size if moved else 0
                if filled_lots >= 1:
                    # Record what actually sold so exit_all buys it back BEFORE touching the long.
                    short_candidate["lots"] = filled_lots
                    self.short_leg = short_candidate
                    logger.error(f"Short entry PARTIAL ({filled_lots} lots sold). Unwinding everything.")
                    self.exit_all(reason="SHORT_PARTIAL_FILL")
                else:
                    logger.error("FATAL: short entry state unknown. Not touching the long; verify the broker manually.")
                notify(f"[{self.state_key}] Short entry ended PARTIAL/UNKNOWN (moved {moved}). Entries halted - verify broker.")
                return False
            fill_px = self._get_fill_price(oid, fallback_ltp=short_candidate["entry_price"])
            short_candidate["entry_price"] = fill_px

        self.short_leg = short_candidate
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(short_candidate["security_id"]), 15)])
        except Exception as e:
            logger.warning(f"Could not subscribe short leg: {e}")

        self.position_open = True
        self.status = "RUNNING"
        self.compute_lcr()
        self.save_position()
        self._publish_state(spot)

        notify(
            f"[{self.state_key}] Position Entered:\n"
            f"Long: {self.long_leg['strike']} CE ({self.long_leg['lots']}L) @ ₹{self.long_leg['entry_price']:.1f} [Cost: ₹{self.initial_long_debit:,.0f}]\n"
            f"Short: {self.short_leg['strike']} CE ({self.short_leg['lots']}L) @ ₹{self.short_leg['entry_price']:.1f}\n"
            f"Initial LCR: {self.lcr_pct:.1f}%"
        )
        return True

    # ── ROLLS & DEFENSIVE ADJUSTMENTS ─────────────────────────────────────────

    def _long_delta_shares(self) -> float:
        if not self.long_leg:
            return 0.0
        return self.long_leg["lots"] * self.lot_size * self.long_leg["delta"]

    def _open_new_short(self, spot: float, new_short: Dict) -> bool:
        """Sells `new_short` (already selected) and tracks it. On failure leaves short_leg None."""
        new_qty = new_short["lots"] * self.lot_size
        logger.info(f"Opening fresh short leg: {new_short['strike']} CE ({new_short['expiry']}) x {new_qty} units")

        if self.live:
            net_before = self._get_broker_net(new_short["strike"], new_short["expiry"], "CE")
            oid = self.broker.sell(
                strike=new_short["strike"], expiry=new_short["expiry"], opt_type="CE", qty=new_qty, product=PRODUCT
            )
            if not oid:
                logger.error("Short sell order was not placed. Staying long-only; will retry after cooldown.")
                self.short_leg = None
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                self.save_position()
                return False
            status, moved = self._confirm_fill_or_cancel(
                oid, new_short["strike"], new_short["expiry"], "CE", -new_qty, net_before
            )
            if status == "PARTIAL":
                filled_lots = abs(moved) // self.lot_size if moved else 0
                if filled_lots >= 1:
                    new_short["lots"] = filled_lots  # track what really sold
                    status = "FILLED"
                else:
                    self.short_resell_blocked = True
                    self.short_leg = None
                    logger.error(f"FATAL: short sell ended partial/unknown (moved {moved}). Auto re-sell disabled; verify the broker.")
                    notify(f"[{self.state_key}] Short sell ended PARTIAL/UNKNOWN (moved {moved}). Verify broker manually.")
                    self.save_position()
                    return False
            if status != "FILLED":
                logger.error("Short sell not filled (cancelled). Staying long-only; will retry after cooldown.")
                self.short_leg = None
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                self.save_position()
                return False
            new_short["entry_price"] = self._get_fill_price(oid, fallback_ltp=new_short["entry_price"])

        self.short_leg = new_short
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(new_short["security_id"]), 15)])
        except Exception:
            pass
        self.compute_lcr()
        self.save_position()
        self._publish_state(spot)
        return True

    def roll_short_leg(self, spot: float, reason: str):
        """Rolls the short: select the replacement FIRST, then buy back, then sell the new one.

        Selecting first means a failed selection keeps the existing short instead of leaving the
        position long-only.
        """
        if not self.short_leg or not self.position_open:
            return

        logger.info(f"=== Rolling Short Call Leg | Reason: {reason} ===")
        new_short = self.select_short_call(spot, self._long_delta_shares())
        if not new_short:
            logger.error("Could not select a replacement short; keeping the current short (cooldown).")
            self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
            return

        old_leg = self.short_leg
        closed, fill_px, done_qty = self._close_leg(old_leg, "BUY")
        closed_pnl = (old_leg["entry_price"] - fill_px) * done_qty
        self.realized_pnl += closed_pnl
        self.cumulative_short_premium += closed_pnl
        if not closed:
            # Never sell a new short while the old one may still be open.
            old_leg["lots"] -= done_qty // self.lot_size
            self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
            self.save_position()
            logger.error("Could not confirm buyback of the old short; roll aborted (cooldown).")
            return
        lcr_pct, total_short_px, is_free = self.compute_lcr()
        logger.info(
            f"Closed old short {old_leg['strike']} CE @ ₹{fill_px:.2f} | Leg P&L: ₹{closed_pnl:+.2f} | "
            f"Cumulative Net Short Premium: ₹{self.cumulative_short_premium:,.2f} | LCR: {lcr_pct:.1f}% "
            f"({'FREE LONG CALL' if is_free else 'RECOVERY IN PROGRESS'})"
        )
        # The regime may have flipped on the buyback; the selection above used the pre-close LCR, so
        # re-selecting is only needed if it changed.
        if is_free != bool(new_short.get("is_free_long_call")):
            reselected = self.select_short_call(spot, self._long_delta_shares())
            if reselected:
                new_short = reselected

        self.short_leg = None
        if not self._open_new_short(spot, new_short):
            return
        if reason.startswith(ADJUST_ROLL_PREFIXES):
            self.adjust_cooldown_until = time.time() + ADJUST_COOLDOWN_SEC
        notify(
            f"[{self.state_key}] Short Leg Rolled: {new_short['strike']} CE ({new_short['lots']}L). "
            f"LCR: {self.lcr_pct:.1f}% ({'FREE LONG CALL' if self.is_free_long_call else 'FINANCING'})"
        )

    def restore_short_leg(self, spot: float):
        """Re-sells a short when the position is long-only (after a failed roll, halving, etc.)."""
        if self.short_leg or not self.long_leg or not self.position_open:
            return
        new_short = self.select_short_call(spot, self._long_delta_shares())
        if not new_short:
            self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
            return
        logger.info("Long-only position: re-establishing the short leg.")
        if self._open_new_short(spot, new_short):
            notify(f"[{self.state_key}] Short leg re-established: {new_short['strike']} CE ({new_short['lots']}L).")

    def add_short_lots(self, spot: float) -> bool:
        """Net delta too bullish: sell ADDITIONAL lots of the existing short up to the sizing target.

        Does nothing when the lot ceiling / ratio cap / gamma budget leave no room, so a position pinned
        at its ceiling is not rolled over and over (rolling cannot add lots the caps forbid).
        """
        sl, ll = self.short_leg, self.long_leg
        if not sl or not ll:
            return False
        target = calculate_required_short_lots(
            long_delta_shares=self._long_delta_shares(),
            target_net_delta_shares=self.target_net_delta,
            short_call_delta=max(0.001, float(sl.get("delta", 0.18))),
            lot_size=self.lot_size,
            max_short_ratio=self._effective_max_short_ratio(),
            max_short_lots=self.max_short_lots,
        )
        if self.drawdown_halved:
            target = max(1, target // 2)
        target = self._fit_lots_to_gamma(ll, sl, spot, target)
        extra = target - sl["lots"]
        if extra < 1:
            logger.info(f"Delta above band but short already at its cap ({sl['lots']} lots, target {target}); nothing to add.")
            return False

        qty = extra * self.lot_size
        fill_px = sl.get("current_ltp", sl["entry_price"])
        added_qty = qty
        if self.live:
            net_before = self._get_broker_net(sl["strike"], sl["expiry"], "CE")
            oid = self.broker.sell(strike=sl["strike"], expiry=sl["expiry"], opt_type="CE", qty=qty, product=PRODUCT)
            if not oid:
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                return False
            status, moved = self._confirm_fill_or_cancel(oid, sl["strike"], sl["expiry"], "CE", -qty, net_before)
            if status == "PARTIAL":
                added_qty = abs(moved) if moved else 0
                if added_qty < self.lot_size:
                    self.roll_cooldown_until = float("inf")
                    notify(f"[{self.state_key}] Add-short ended PARTIAL/UNKNOWN (moved {moved}). Verify broker manually.")
                    return False
            elif status != "FILLED":
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                return False
            fill_px = self._get_fill_price(oid, fallback_ltp=fill_px)
        added_lots = added_qty // self.lot_size
        new_total = sl["lots"] + added_lots
        sl["entry_price"] = round((sl["entry_price"] * sl["lots"] + fill_px * added_lots) / new_total, 2)
        sl["lots"] = new_total
        logger.info(f"Added {added_lots} short lot(s) @ ₹{fill_px:.2f}; short now {new_total} lots (avg ₹{sl['entry_price']:.2f}).")
        self.compute_lcr()
        self.save_position()
        return True

    def roll_long_leg(self, spot: float, reason: str):
        """Rolls the long call: buy the NEW long first, only then sell the old one.

        Buying first keeps the short covered at every instant; the reverse order left it naked
        between the two orders (and permanently so if the new buy failed).
        """
        if not self.long_leg or not self.position_open:
            return

        logger.info(f"=== Rolling Long Call Leg | Reason: {reason} ===")
        new_long = self.select_long_call(spot)
        if not new_long:
            logger.error("Could not find candidate long call for roll. Retaining current long position.")
            self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
            return

        old_leg = self.long_leg
        new_qty = new_long["lots"] * self.lot_size

        # 1. Buy the replacement long
        if self.live:
            net_before = self._get_broker_net(new_long["strike"], new_long["expiry"], "CE")
            oid = self.broker.buy(
                strike=new_long["strike"], expiry=new_long["expiry"], opt_type="CE", qty=new_qty, product=PRODUCT
            )
            if not oid:
                logger.error("Could not place buy for the new long. Retaining current long (cooldown).")
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                return
            status, moved = self._confirm_fill_or_cancel(
                oid, new_long["strike"], new_long["expiry"], "CE", +new_qty, net_before
            )
            if status == "NOT_FILLED":
                logger.error("New long not filled; cancelled. Retaining current long (cooldown).")
                self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
                return
            if status == "PARTIAL":
                self.roll_cooldown_until = float("inf")
                logger.error(f"FATAL: new long ended partial/unknown (moved {moved}); long rolls disabled until restart.")
                notify(f"[{self.state_key}] Long roll ended PARTIAL/UNKNOWN (moved {moved}). Old long kept; verify broker manually.")
                return
            new_long["entry_price"] = self._get_fill_price(oid, fallback_ltp=new_long["entry_price"])

        # 2. Sell the old long. Track the new one first so state is right even if this fails.
        self.long_leg = new_long
        closed, fill_px, done_qty = self._close_leg(old_leg, "SELL")
        closed_pnl = (fill_px - old_leg["entry_price"]) * done_qty
        self.realized_pnl += closed_pnl
        # A realised loss on the old long is part of what the shorts must recover (a gain reduces it).
        self.initial_long_debit = max(0.01 * self.initial_long_debit, self.initial_long_debit - closed_pnl)
        if closed:
            logger.info(f"Closed old long {old_leg['strike']} CE @ ₹{fill_px:.2f} | Leg P&L: ₹{closed_pnl:+.2f}")
        else:
            # Extra long exposure is not naked risk, but it must not be forgotten.
            logger.error("Old long close not confirmed; holding BOTH longs. Close the old one manually.")
            notify(f"[{self.state_key}] Long roll: old long {old_leg['strike']} CE close unconfirmed - verify broker manually.")

        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(new_long["security_id"]), 15)])
        except Exception:
            pass

        self.compute_lcr()
        self.save_position()
        self._publish_state(spot)
        notify(f"[{self.state_key}] Long Leg Rolled: {new_long['strike']} CE ({new_long['lots']}L).")

    def halve_short_position(self, spot: float, reason: str):
        """Halves short lots when drawdown reaches 5%. State only changes for lots that really closed."""
        if not self.short_leg or self.short_leg["lots"] <= 1 or self.drawdown_halved:
            return
        logger.info(f"--- Drawdown Protection: Halving Short Position ({reason}) ---")
        reduce_lots = max(1, self.short_leg["lots"] // 2)
        part = dict(self.short_leg, lots=reduce_lots)
        closed, fill_px, done_qty = self._close_leg(part, "BUY")
        if done_qty <= 0:
            self.roll_cooldown_until = time.time() + ROLL_COOLDOWN_SEC
            logger.error("Halving buyback not confirmed; short position unchanged (cooldown).")
            return
        closed_pnl = (self.short_leg["entry_price"] - fill_px) * done_qty
        self.realized_pnl += closed_pnl
        self.cumulative_short_premium += closed_pnl
        self.short_leg["lots"] -= done_qty // self.lot_size
        self.drawdown_halved = closed
        self.compute_lcr()
        self.save_position()
        logger.info(f"Short position now {self.short_leg['lots']} lots (halving {'complete' if closed else 'partial'}). LCR: {self.lcr_pct:.1f}%")

    def exit_all(self, reason: str = "MANUAL_STOP") -> bool:
        """Closes all legs, short first. Returns True only when every leg is confirmed closed.

        The long is never sold while a short is still open: a naked short is the one state this
        strategy must not reach. An incomplete exit keeps the unclosed legs in state, leaves
        position_open=True and sets pending_exit_reason so run() retries (also across restarts).
        """
        logger.info(f"=== SQUARING OFF ALL POSITIONS ({reason}) ===")
        self.status = "UNWINDING"

        if self.short_leg and self.short_leg.get("lots", 0) > 0:
            closed, fill_px, done_qty = self._close_leg(self.short_leg, "BUY")
            closed_pnl = (self.short_leg["entry_price"] - fill_px) * done_qty
            self.realized_pnl += closed_pnl
            self.cumulative_short_premium += closed_pnl
            if closed:
                self.short_leg = None
            else:
                self.short_leg["lots"] -= done_qty // self.lot_size

        if self.short_leg and self.short_leg.get("lots", 0) > 0:
            logger.error("Short leg still open - NOT selling the long (would leave a naked short). Will retry.")
        elif self.long_leg and self.long_leg.get("lots", 0) > 0:
            closed, fill_px, done_qty = self._close_leg(self.long_leg, "SELL")
            self.realized_pnl += (fill_px - self.long_leg["entry_price"]) * done_qty
            if closed:
                self.long_leg = None
            else:
                self.long_leg["lots"] -= done_qty // self.lot_size

        complete = not (self.short_leg and self.short_leg.get("lots", 0) > 0) and not (
            self.long_leg and self.long_leg.get("lots", 0) > 0
        )
        self.compute_lcr()
        if complete:
            self.position_open = False
            self.pending_exit_reason = None
            self.status = "STOPPED"
        else:
            self.position_open = True
            self.pending_exit_reason = reason
            self.status = "EXIT_PENDING"
        self.save_position()
        self._publish_state(self.last_spot)
        if complete or time.time() - self.last_exit_notify >= EXIT_NOTIFY_MIN_GAP_SEC:
            self.last_exit_notify = time.time()
            notify(
                f"[{self.state_key}] Square-off {'complete' if complete else 'INCOMPLETE - retrying'}: {reason}. "
                f"Status: {self.status}. Total Realized P&L: ₹{self.realized_pnl:+.2f} | Final LCR: {self.lcr_pct:.1f}%"
            )
        if complete:
            self.exit_retry_sleep = float(EXIT_RETRY_SEC)
        return complete

    # ── STATE PUBLISHING ──────────────────────────────────────────────────────

    def _publish_state(self, spot: float):
        """Publishes the state file for Next.js dashboard visibility."""
        if spot > 0:
            self.last_spot = spot
        else:
            spot = self.last_spot  # overnight / exit: reuse the last spot so Greeks are not all zero
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
        lcr_pct, total_short_premium, is_free = self.compute_lcr()

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
            "initial_long_debit": round(self.initial_long_debit, 2),
            "cumulative_short_premium": round(total_short_premium, 2),
            "lcr_pct": lcr_pct,
            "is_free_long_call": is_free,
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
        if not self.position_open:
            # A restored open position must be manageable (and exit-able) even when restarted off-hours.
            exit_if_market_closed(self.helper, self.dry_run)

        while True:
            try:
                # 1. Check Graceful Dashboard Shutdown Trigger
                if check_shutdown_trigger(self.state_key):
                    logger.info("Shutdown trigger detected from dashboard. Closing positions and exiting.")
                    self.pending_exit_reason = "DASHBOARD_SHUTDOWN_TRIGGER"

                now = datetime.now()
                now_str = now.strftime("%H:%M")
                today_str = date.today().isoformat()
                in_session = "09:15" <= now_str < "15:25"

                # Session rollover check for daily loss baseline (baseline = total P&L, incl. unrealized carry)
                if today_str != self.session_date:
                    logger.info(f"New session date: {today_str}. Rolling over daily P&L baseline.")
                    self.session_date = today_str
                    self.daily_start_pnl = self.last_total_pnl
                    self.save_position()

                # 1b. Pending exit (dashboard stop, risk exit, or an earlier incomplete unwind): retry until
                # every leg is confirmed closed. Never `break` on an incomplete exit.
                holds_legs = bool(self.long_leg or self.short_leg)
                if self.pending_exit_reason and (in_session or self.dry_run or not holds_legs):
                    if self.exit_all(reason=self.pending_exit_reason):
                        break
                    time.sleep(self.exit_retry_sleep)
                    continue

                # 2. Overnight Handling: After 15:25 IST, transition to HOLDING OVERNIGHT
                if now_str >= "15:25" or now_str < "09:15":
                    if self.position_open and self.status != "HOLDING OVERNIGHT":
                        self.status = "HOLDING OVERNIGHT"
                        logger.info("Market session closed. Transitioning to HOLDING OVERNIGHT.")
                        self._publish_state(0.0)

                    # Sleep through post-market with responsive shutdown check
                    for _ in range(30):
                        if check_shutdown_trigger(self.state_key):
                            logger.info("Shutdown trigger detected outside market hours. Exit queued for the next session open.")
                            self.pending_exit_reason = "DASHBOARD_SHUTDOWN_TRIGGER"
                            break
                        time.sleep(1)
                    continue

                if self.position_open and self.status not in ("RUNNING", "EXIT_PENDING"):
                    self.status = "RUNNING"  # leaves HOLDING OVERNIGHT / ENTERING once the session is live

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
                    if self.entry_halted or self.entry_attempts >= ENTRY_MAX_ATTEMPTS:
                        if not self.entry_halted:
                            self.entry_halted = True
                            logger.error(f"Entry halted after {self.entry_attempts} failed attempts. Restart to retry.")
                            notify(f"[{self.state_key}] Entry halted after {self.entry_attempts} failed attempts.")
                        self.status = "ENTRY_HALTED"
                        self._publish_state(spot)
                        time.sleep(5)
                        continue
                    if time.time() < self.next_entry_at:
                        time.sleep(2)
                        continue
                    # Enter fresh cycle
                    if self.enter_cycle(spot):
                        self.entry_attempts = 0
                    else:
                        self.entry_attempts += 1
                        backoff = min(ENTRY_BACKOFF_MAX_SEC, ENTRY_BACKOFF_BASE_SEC * 2 ** (self.entry_attempts - 1))
                        self.next_entry_at = time.time() + backoff
                        logger.warning(f"Entry attempt {self.entry_attempts}/{ENTRY_MAX_ATTEMPTS} failed. Next try in {backoff}s.")
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
                            side="SELL",
                            log=logger,
                        )
                        if is_phantom:
                            logger.error("FATAL: Long call leg vanished at broker! Emergency flattening short call to prevent naked risk.")
                            self.pending_exit_reason = "PHANTOM_LONG_LEG_DETECTED"
                            continue
                    if self.short_leg:
                        is_short_phantom = detect_phantom_leg_broker(
                            self.broker,
                            self.short_leg["strike"],
                            self.short_leg["expiry"],
                            "CE",
                            self.short_leg["lots"] * self.lot_size,
                            side="BUY",
                            log=logger,
                        )
                        if is_short_phantom:
                            logger.warning("Short call leg vanished at broker (closed elsewhere). Marking short leg flat; auto re-sell disabled.")
                            self.short_leg = None
                            self.short_resell_blocked = True
                            self.compute_lcr()
                            self.save_position()

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
                self.last_total_pnl = total_pnl

                # 8. Check Target Profit & Stop Loss
                if self.target_profit_rs and total_pnl >= self.target_profit_rs:
                    logger.info(f"Target Profit Reached: ₹{total_pnl:,.2f} >= ₹{self.target_profit_rs:,.2f}. Exiting.")
                    self.pending_exit_reason = "TARGET_PROFIT_REACHED"
                    continue

                if self.stop_loss_rs and total_pnl <= -abs(self.stop_loss_rs):
                    logger.warning(f"Stop Loss Hit: ₹{total_pnl:,.2f} <= -₹{abs(self.stop_loss_rs):,.2f}. Exiting.")
                    self.pending_exit_reason = "STOP_LOSS_HIT"
                    continue

                # 9. Portfolio Risk Checks & Strategy Drawdowns
                drawdown_rs = self.peak_pnl - total_pnl
                drawdown_pct = (drawdown_rs / self.capital) * 100.0 if self.capital > 0 else 0.0

                # Check Max Strategy Drawdown (8% hard exit)
                if drawdown_pct >= self.drawdown_exit_pct:
                    logger.warning(f"Strategy Max Drawdown Breached: {drawdown_pct:.1f}% >= {self.drawdown_exit_pct}%. Halting.")
                    self.pending_exit_reason = f"MAX_DRAWDOWN_EXIT ({drawdown_pct:.1f}%)"
                    continue

                # Check 5% Drawdown Halving
                if drawdown_pct >= self.drawdown_halve_pct and not self.drawdown_halved and time.time() >= self.roll_cooldown_until:
                    self.halve_short_position(spot, reason=f"DRAWDOWN_{drawdown_pct:.1f}%")
                elif self.drawdown_halved and drawdown_pct < self.drawdown_halve_pct / 2.0:
                    self.drawdown_halved = False  # recovered: new shorts may be sized normally again
                    self.save_position()

                # Daily Loss Limit Check
                daily_pnl = total_pnl - self.daily_start_pnl
                max_daily_loss = -(self.daily_loss_pct / 100.0) * self.capital
                if daily_pnl <= max_daily_loss and self.daily_halt_date != today_str:
                    self.daily_halt_date = today_str  # latched for the rest of the session
                    self.save_position()
                    logger.warning(f"Daily loss limit hit: ₹{daily_pnl:.2f} <= ₹{max_daily_loss:.2f}. Suspending discretionary adjustments for the session.")
                    notify(f"[{self.state_key}] Daily loss limit hit (₹{daily_pnl:,.0f}). Discretionary adjustments suspended today.")
                adjustments_suspended = self.daily_halt_date == today_str
                roll_allowed = time.time() >= self.roll_cooldown_until

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
                    if should_roll and adjustments_suspended and not roll_reason.startswith(HALT_ALLOWED_ROLL_PREFIXES):
                        should_roll = False  # discretionary roll held back by the daily loss halt
                    if should_roll and roll_reason.startswith(ADJUST_ROLL_PREFIXES) and time.time() < self.adjust_cooldown_until:
                        should_roll = False  # a portfolio-level roll just happened; let it settle
                    if should_roll and roll_allowed:
                        self.roll_short_leg(spot, reason=roll_reason)
                        continue
                elif (
                    self.long_leg
                    and not self.short_resell_blocked
                    and not adjustments_suspended
                    and roll_allowed
                    and self.status == "RUNNING"
                    and self.start_time <= now_str < "15:15"
                ):
                    self.restore_short_leg(spot)

                # 11. Long Leg Roll Evaluation
                if self.long_leg:
                    should_roll_long, long_reason = check_long_roll_triggers(self.long_leg, self.long_roll_dte)
                    if should_roll_long and roll_allowed:
                        self.roll_long_leg(spot, reason=long_reason)
                        continue

                # 12. Scheduled Rebalance Windows (10:00, 12:00, 14:00)
                current_hm = now.strftime("%H:%M")
                if (
                    current_hm in self.rebalance_times
                    and current_hm != self.last_rebalance_minute
                    and not adjustments_suspended
                    and roll_allowed
                ):
                    self.last_rebalance_minute = current_hm
                    logger.info(f"--- Rebalance Window Check at {current_hm} | Net Delta: {greeks['net_delta_shares']:.1f} ({greeks['delta_zone']}) ---")
                    if greeks["delta_zone"] == "DEFENSIVE":
                        self.roll_short_leg(spot, reason=f"SCHEDULED_REBALANCE_DEFENSIVE (Delta {greeks['net_delta_shares']:.1f})")
                    elif greeks["delta_zone"] == "TOO_BULLISH" and greeks["portfolio_gamma"] > self.min_gamma_limit:
                        logger.info("Delta is too bullish (> +30). Adding short lots toward the sizing target.")
                        self.add_short_lots(spot)

                self._publish_state(spot)
                time.sleep(1.5)

            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received. Squaring off and exiting.")
                try:
                    if not self.exit_all(reason="KEYBOARD_INTERRUPT"):
                        logger.error("Exit INCOMPLETE on interrupt - legs remain open. Verify the broker position manually.")
                except Exception as exit_err:
                    logger.error(f"Exit FAILED on interrupt ({exit_err}) - legs may remain open. Verify the broker position manually.")
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
    parser.add_argument("--i-understand-this-is-unvalidated", action="store_true", default=False,
                        help="Required alongside --live: this strategy has never been forward-tested and its backtest is a "
                             "premium-harvest accounting model, not a validated edge.")
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
    parser.add_argument("--target-profit", type=str, default="", help="Optional cumulative target profit in INR or %% of capital (default: off).")
    parser.add_argument("--stop-loss", type=str, default="", help="Optional cumulative stop loss in INR or %% of capital (default: off; --drawdown-exit-pct is the standing stop).")
    parser.add_argument("--start-time", type=str, default="09:30", help="Session start time in HH:MM IST (default: 09:30).")
    parser.add_argument("--rebalance-times", type=str, default="10:00,12:00,14:00", help="Comma-separated rebalance times (default: 10:00,12:00,14:00).")
    parser.add_argument("--max-short-ratio", type=float, default=1.25, help="Max ratio of short delta to long delta (default: 1.25).")
    parser.add_argument("--max-short-lots", type=int, default=6, help="Hard ceiling on short call lots for margin safety (default: 6).")
    parser.add_argument("--min-iv", type=float, default=0.10, help="Do not sell shorts when India VIX / 100 is below this (default: 0.10).")
    parser.add_argument("--min-gamma-limit", type=float, default=-0.20, help="Emergency negative gamma floor (default: -0.20).")
    args = parser.parse_args()

    # Post-parse validation with error collection (dhan-new-strategy rule)
    _errors = []
    if args.long_lots < 2 or args.long_lots > 4:
        _errors.append(f"--long-lots ({args.long_lots}) must be between 2 and 4.")
    if args.max_short_lots < 1:
        _errors.append(f"--max-short-lots ({args.max_short_lots}) must be at least 1.")
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
    if args.live and not args.i_understand_this_is_unvalidated:
        _errors.append("--live requires --i-understand-this-is-unvalidated: this strategy has never been forward-tested.")
    if not 0.0 <= args.min_iv < 1.0:
        _errors.append(f"--min-iv ({args.min_iv}) must be a fraction between 0 and 1 (e.g. 0.10).")
    if args.min_gamma_limit >= 0:
        _errors.append(f"--min-gamma-limit ({args.min_gamma_limit}) must be negative (e.g. -0.20).")

    if _errors:
        for err in _errors:
            logger.error(f"[CONFIG ERROR] {err}")
        sys.exit(1)

    return args


if __name__ == "__main__":
    if _IMPORT_ERROR is not None:
        raise SystemExit(f"Cannot start: required project modules failed to import ({_IMPORT_ERROR}).")
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
        max_short_lots=args.max_short_lots,
        min_gamma_limit=args.min_gamma_limit,
        min_iv=args.min_iv,
    )
    strategy.run()
