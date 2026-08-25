import time
import sys
import argparse
import json
import os
import re
import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import pandas as pd

# Adjust path to project root (two levels up from strategies/crudeoil/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, instance_log_suffix
from lib.trade_stops import ratchet_stop, stop_hit

# --- Constants ---
STRATEGY_KEY = "crudeoilm_vwap_supertrend"
SYMBOL = "CRUDEOILM"
EXCHANGE = "MCX"        # find_future() exchange
INSTRUMENT = "FUTCOM"   # find_future() / get_ltp() instrument
SEGMENT = "MCX_COMM"    # get_ltp() / websocket segment

# --- Logging Setup ---
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "crudeoil_vwap")
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

def desired_direction(price: float, st_val: float, vwap_val: float, current: str, min_distance: float = 0.0) -> str:
    """Always-on with hysteresis: enter or flip only when price clears BOTH bands.

    Above Supertrend AND above VWAP  -> LONG
    Below Supertrend AND below VWAP  -> SHORT
    Anything in between (the "mixed zone") returns `current`, so an open
    position is HELD through mixed signals and a flat book stays flat.

    `min_distance` (default 0, byte-identical to the old any-clearance rule) requires
    price to clear both bands by at least this many points — pass an ATR-scaled value
    to stop a flip/entry from firing on a hairline clearance when ST and VWAP nearly
    coincide.
    """
    if price <= 0 or st_val <= 0 or vwap_val <= 0:
        return current  # indicators/price not ready — never act on a partial view
    if price > st_val + min_distance and price > vwap_val + min_distance:
        return "LONG"
    if price < st_val - min_distance and price < vwap_val - min_distance:
        return "SHORT"
    return current


# Extra choppiness the index must climb ABOVE (on top of --chop-max) before a live
# TREND regime is given up. Pairs with --adx-exit to make the regime two-sided; a
# single threshold in both directions would just move the chop from the price rule
# into the filter and flatten/re-enter on every recompute.
CHOP_EXIT_BUFFER = 5.0

# Sentinel for "this gate's indicator column was missing or NaN". Both ADX and the
# Choppiness Index are non-negative, so a negative value can only mean no data.
NO_DATA = -1.0


def advance_regime(
    current_regime: str,
    streak: int,
    adx: float,
    chop: float,
    *,
    adx_enter: float,
    adx_exit: float,
    chop_max: float,
    confirm: int,
) -> Tuple[str, int, str]:
    """Two-sided, streak-confirmed trend/chop regime. Pure — unit-testable.

    Returns ``(regime, streak, reason)``. Call once per CONFIRMED candle, never on a
    live tick: the whole point is to be slower than price.

    * TREND requires ``adx >= adx_enter`` AND ``chop <= chop_max``.
    * CHOP requires ``adx < adx_exit`` OR ``chop > chop_max + CHOP_EXIT_BUFFER``.
    * Between those two bands the current regime is HELD (hysteresis), so a market
      sitting at the threshold does not flap.
    * A flip must survive ``confirm`` consecutive candles before it is adopted.

    Missing indicator data fails CLOSED — straight to CHOP with no streak wait. A
    filter that silently disappears is worse than one that blocks.
    """
    if adx < 0 or chop < 0:
        return "CHOP", 0, "regime data unavailable (ADX/CHOP column missing) — failing closed"

    if adx >= adx_enter and chop <= chop_max:
        candidate = "TREND"
        why = f"ADX {adx:.1f} >= {adx_enter:.0f} and CHOP {chop:.1f} <= {chop_max:.0f}"
    elif adx < adx_exit or chop > chop_max + CHOP_EXIT_BUFFER:
        candidate = "CHOP"
        why = f"ADX {adx:.1f} < {adx_exit:.0f}" if adx < adx_exit else               f"CHOP {chop:.1f} > {chop_max + CHOP_EXIT_BUFFER:.0f}"
    else:
        # Neutral band: hold whatever we already are.
        return current_regime, 0, (
            f"holding {current_regime}: ADX {adx:.1f} in [{adx_exit:.0f}, {adx_enter:.0f}), "
            f"CHOP {chop:.1f}"
        )

    if candidate == current_regime:
        return current_regime, 0, why

    streak += 1
    if streak >= confirm:
        return candidate, 0, f"{current_regime} -> {candidate}: {why}"
    return current_regime, streak, (
        f"{candidate} pending {streak}/{confirm} candles: {why}"
    )


def compute_oi_bias(diff_history) -> Tuple[str, str]:
    """OI buildup direction from a short history of (CE OI sum - PE OI sum).

    Ported from strategies/oi_directional/nifty_oi_directional.py's _compute_direction:
    CE OI dominant AND still growing away from zero means resistance is building
    overhead -> BEARISH; PE OI dominant and growing means support is building
    underneath -> BULLISH. A single snapshot is not a signal — OI has to be
    *expanding* in one direction, not just non-zero, so this needs at least two
    points and compares only the last two.

    Pure — unit-testable without a broker or an option chain.
    """
    if len(diff_history) < 2:
        return "UNAVAILABLE", "not enough OI history yet"
    prev, curr = diff_history[-2], diff_history[-1]
    if curr < 0 and curr < prev:
        return "BULLISH", f"PE OI dominant and growing (diff {curr:+.0f}, was {prev:+.0f})"
    if curr > 0 and curr > prev:
        return "BEARISH", f"CE OI dominant and growing (diff {curr:+.0f}, was {prev:+.0f})"
    return "NEUTRAL", f"no clear OI buildup (diff {curr:+.0f}, was {prev:+.0f})"


def entry_allowed(
    want: str,
    *,
    regime: str,
    htf_dir: int,
    st_val: float,
    vwap_val: float,
    atr_val: float,
    min_band_gap_atr: float,
    use_regime: bool,
    use_htf: bool,
    oi_bias: str = "UNAVAILABLE",
    use_oi: bool = False,
) -> Tuple[bool, str]:
    """Gate a NEW entry (or the entry leg of a flip). Pure — unit-testable.

    Holding an existing position is deliberately NOT routed through here: once in a
    trade the exit rules own it. Returns ``(allowed, reason)``; ``reason`` is non-empty
    only when blocked, and is surfaced to the dashboard as ``blocked_reason`` so a
    strategy sitting flat does not look hung.
    """
    if want not in ("LONG", "SHORT"):
        return False, ""

    if use_regime and regime != "TREND":
        return False, f"regime is {regime}"

    if use_htf:
        if htf_dir == 0:
            return False, "higher-timeframe Supertrend unavailable — failing closed"
        wanted_dir = 1 if want == "LONG" else -1
        if htf_dir != wanted_dir:
            return False, (
                f"higher-timeframe Supertrend is {'bullish' if htf_dir > 0 else 'bearish'}, "
                f"{want} disagrees"
            )

    if min_band_gap_atr > 0:
        if atr_val <= 0:
            return False, "ATR unavailable — cannot measure the band gap"
        gap = abs(st_val - vwap_val)
        need = atr_val * min_band_gap_atr
        if gap < need:
            # The bands collapsing onto each other IS the chop condition for this
            # strategy: the hold-zone shrinks to a point and every tick flips.
            return False, f"band gap {gap:.2f} < {need:.2f} ({min_band_gap_atr}x ATR)"

    if use_oi:
        # Confirmation, not just "not disagreeing": NEUTRAL/UNAVAILABLE also block,
        # the same fail-closed stance as the higher-timeframe gate above. A gate that
        # only rejects outright disagreement would wave an unconfirmed trade through.
        wanted_bias = "BULLISH" if want == "LONG" else "BEARISH"
        if oi_bias != wanted_bias:
            return False, f"OI bias is {oi_bias}, {want} needs {wanted_bias}"

    return True, ""


class Snapshot(NamedTuple):
    """One confirmed-candle view. A NamedTuple, not a bare tuple: this is unpacked in
    half a dozen places and positional growth is how those get silently mismatched."""
    close: float
    st: float
    vwap: float
    candle_ts: str
    atr: float
    adx: float
    chop: float
    htf_dir: int          # +1 bullish / -1 bearish / 0 unknown
    regime: str           # "TREND" / "CHOP"
    regime_reason: str
    oi_bias: str           # "BULLISH" / "BEARISH" / "NEUTRAL" / "UNAVAILABLE"
    oi_reason: str
    oi_diff: float         # sum(CE OI) - sum(PE OI) over the watched strikes


class CrudeOilMVwapSupertrendStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 5,
        contract_size: int = 10,
        interval: str = "5",
        supertrend_period: int = 7,
        supertrend_multiplier: float = 2.0,
        vwap_anchor: str = "D",
        target_profit: float = 5000.0,
        stop_loss: float = 5000.0,
        start_time: str = "09:00",
        eod_time: str = "23:30",
        poll_seconds: int = 15,
        days: int = 3,
        allow_reverse: bool = True,
        exit_on_close: bool = False,
        flip_cooldown: int = 60,
        min_flip_atr_mult: float = 0.35,
        # --- regime gate ---
        adx_period: int = 14,
        adx_enter: float = 22.0,
        adx_exit: float = 18.0,
        chop_length: int = 14,
        chop_max: float = 55.0,
        regime_confirm_candles: int = 2,
        htf_interval: str = "15",
        htf_refresh_seconds: int = 60,
        use_regime_filter: bool = True,
        use_htf_filter: bool = True,
        min_band_gap_atr: float = 0.5,
        # --- per-trade risk ---
        atr_stop_mult: float = 1.5,
        trail_trigger_atr: float = 1.0,
        # --- churn brakes ---
        max_trades_per_day: int = 6,
        cooldown_candles: int = 1,
        loss_streak_pause: int = 2,
        loss_streak_pause_minutes: int = 30,
        # --- OI confirmation (off by default -- see strategy.md) ---
        oi_symbol: str = "CRUDEOIL",
        oi_strike_range: float = 250.0,
        oi_strike_step: float = 50.0,
        oi_expansion_window: int = 3,
        oi_refresh_seconds: int = 45,
        require_oi_confirmation: bool = False,
        collect_oi: bool = True,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.contract_size = contract_size
        self.interval = interval
        self.supertrend_period = supertrend_period
        self.supertrend_multiplier = supertrend_multiplier
        self.vwap_anchor = vwap_anchor
        self.target_profit = target_profit
        self.stop_loss = abs(stop_loss)
        self.start_time = start_time
        self.eod_time = eod_time
        self.poll_seconds = poll_seconds
        self.days = days
        self.allow_reverse = allow_reverse
        self.exit_on_close = exit_on_close
        self.flip_cooldown = flip_cooldown
        self.min_flip_atr_mult = min_flip_atr_mult
        self.adx_period = adx_period
        self.adx_enter = adx_enter
        self.adx_exit = adx_exit
        self.chop_length = chop_length
        self.chop_max = chop_max
        self.regime_confirm_candles = regime_confirm_candles
        self.htf_interval = htf_interval
        self.htf_refresh_seconds = htf_refresh_seconds
        self.use_regime_filter = use_regime_filter
        self.use_htf_filter = use_htf_filter
        self.min_band_gap_atr = min_band_gap_atr
        self.atr_stop_mult = atr_stop_mult
        self.trail_trigger_atr = trail_trigger_atr
        self.max_trades_per_day = max_trades_per_day
        self.cooldown_candles = cooldown_candles
        self.loss_streak_pause = loss_streak_pause
        self.loss_streak_pause_minutes = loss_streak_pause_minutes
        self.oi_symbol = oi_symbol
        self.oi_strike_range = oi_strike_range
        self.oi_strike_step = oi_strike_step
        self.oi_expansion_window = oi_expansion_window
        self.oi_refresh_seconds = oi_refresh_seconds
        self.require_oi_confirmation = require_oi_confirmation
        # Computed on its own cadence for TELEMETRY even when the gate is off, the same
        # convention as the regime/HTF filters (--no-regime-filter disables the BLOCK,
        # not the computation) -- this is what lets --require-oi-confirmation be turned
        # on later from evidence instead of a guess.
        self.collect_oi = collect_oi and bool(oi_symbol)
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

        # Regime state — starts CHOP so nothing trades until a trend is PROVEN.
        self.regime: str = "CHOP"
        self._regime_streak: int = 0
        self._regime_candle: str = ""       # candle the regime was last advanced on
        self.regime_reason: str = "not evaluated yet"
        self.blocked_reason: str = ""       # why we are flat despite a live signal

        # Higher-timeframe Supertrend direction, refreshed on its own cadence so the
        # poller does not double its API load every poll_seconds.
        self._htf_dir: int = 0              # +1 / -1 / 0 (unknown)
        self._htf_last_fetch: float = 0.0
        self._htf_warned: bool = False

        # OI bias — CE-OI-minus-PE-OI over a window of ATM strikes, on the CRUDEOIL
        # (not CRUDEOILM) chain: see strategy.md for why. Only ever fetched by the
        # poller thread, same as the HTF Supertrend above.
        self._oi_expiry: str = ""           # resolved once at startup
        self._oi_diff_history: List[float] = []
        self._oi_bias: str = "UNAVAILABLE"
        self._oi_reason: str = "not evaluated yet"
        self._oi_diff: float = 0.0
        self._oi_last_fetch: float = 0.0
        self._oi_warned: bool = False

        # Per-trade stop
        self.stop_level: float = 0.0
        self.stop_source: str = ""          # "ATR" | "SUPERTREND"

        # Churn brakes
        self.trades_today: int = 0
        self.loss_streak: int = 0
        self.paused_until: float = 0.0      # epoch seconds; 0 = not paused
        self.exit_candle_time: str = ""     # candle of the last flat-going exit

        # Latest confirmed-candle snapshot, written by the poller thread only
        self._snap_lock = threading.Lock()
        self._snapshot = None  # (close, st_val, vwap_val, candle_ts)
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
        """Daemon thread: refresh the Supertrend/VWAP snapshot every poll_seconds.

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
                target=self._poller_loop, daemon=True, name="vwap-st-poller"
            )
            self._poll_thread.start()
            logger.info("Background Supertrend/VWAP poller started (every %ds).", self.poll_seconds)

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

    def _refresh_htf_dir(self) -> None:
        """Refresh the higher-timeframe Supertrend direction, on its own cadence.

        Only the poller thread calls this. On any failure the direction is reset to 0
        (unknown), which `entry_allowed()` treats as a BLOCK — a stale higher-timeframe
        bias is exactly the thing that would wave a counter-trend entry through.
        """
        if not self.use_htf_filter:
            return
        if time.time() - self._htf_last_fetch < self.htf_refresh_seconds:
            return
        self._htf_last_fetch = time.time()
        try:
            df = self.helper.get_indicators_ta(
                symbol=SYMBOL,
                interval=self.htf_interval,
                indicators=[{"kind": "supertrend",
                             "length": self.supertrend_period,
                             "multiplier": self.supertrend_multiplier}],
                days=max(self.days, 5),
            )
            if df is None or df.empty or len(df) < 2:
                raise ValueError("no candles returned")
            direction, found = self._pick(df, df.iloc[-2], prefix="SUPERTd_")
            if not found:
                raise ValueError("SUPERTd_ column missing (have %s)" % df.columns.tolist())
            new_dir = 1 if direction > 0 else -1
            if new_dir != self._htf_dir:
                logger.info(
                    "[HTF] %sm Supertrend direction -> %s",
                    self.htf_interval, "BULLISH" if new_dir > 0 else "BEARISH",
                )
            self._htf_dir = new_dir
            self._htf_warned = False
        except Exception as e:
            self._htf_dir = 0
            if not self._htf_warned:
                logger.warning(
                    "Higher-timeframe (%sm) Supertrend unavailable — new entries are "
                    "BLOCKED until it returns: %s", self.htf_interval, e
                )
                self._htf_warned = True

    def _resolve_oi_expiry(self) -> Optional[str]:
        """Resolve the CRUDEOIL options expiry once and cache it.

        Keyed on THIS strategy's own futures contract id (self.security_id), not by
        re-resolving CRUDEOIL from scratch, so the expiry list is anchored to the same
        contract the strategy is already trading. Options on MCX commodities expire a
        few days BEFORE the futures contract itself — get_expiry_list returning a date
        earlier than self.expiry is expected, not a mismatch to fix.
        """
        if self._oi_expiry:
            return self._oi_expiry
        if not self.security_id:
            return None
        try:
            # get_expiry_list fails SILENTLY (empty list, no exception) on a string
            # security id -- self.security_id is stored as str for the order/quote
            # calls, so it must be cast back to int here specifically.
            expiries = self.helper.get_expiry_list(
                under_security_id=int(self.security_id), under_exchange_segment=SEGMENT
            )
            if not expiries:
                raise ValueError("empty expiry list")
            self._oi_expiry = expiries[0]
            if self.expiry and self._oi_expiry != self.expiry:
                logger.info(
                    "OI options expiry %s differs from the futures contract expiry %s "
                    "(expected — commodity options expire before the future).",
                    self._oi_expiry, self.expiry
                )
            return self._oi_expiry
        except Exception as e:
            logger.warning("Could not resolve a CRUDEOIL options expiry: %s", e)
            return None

    def _refresh_oi_bias(self) -> None:
        """Refresh the CE/PE OI-buildup bias, on its own cadence.

        Deliberately reads the CRUDEOIL (not CRUDEOILM) chain — CRUDEOILM has no
        options of its own; CRUDEOILM and CRUDEOIL share the same per-barrel price, so
        CRUDEOIL's chain is the only source of real crude OI. Pattern (ATM-window CE-OI
        minus PE-OI, expansion over the last 2 snapshots) ported from
        strategies/oi_directional/nifty_oi_directional.py. Only the poller thread calls
        this. On any failure the bias resets to UNAVAILABLE, which entry_allowed()
        treats as a BLOCK when --require-oi-confirmation is set — a stale OI read must
        not silently wave a trade through.
        """
        if not self.collect_oi:
            return
        if time.time() - self._oi_last_fetch < self.oi_refresh_seconds:
            return
        self._oi_last_fetch = time.time()
        try:
            expiry = self._resolve_oi_expiry()
            if not expiry:
                raise ValueError("no options expiry resolved yet")
            df = self.helper.get_option_chain_df(
                self.oi_symbol, expiry, exchange_segment=SEGMENT
            )
            if df is None or df.empty:
                raise ValueError(
                    self.helper.last_api_error or "empty option chain returned"
                )
            underlying_ltp = float(df.attrs.get("underlying_ltp", 0) or 0)
            if underlying_ltp <= 0:
                underlying_ltp = self.ltp if self.ltp > 0 else 0.0
            if underlying_ltp <= 0:
                raise ValueError("no underlying LTP to center the strike window on")

            window = [s for s in df.index if abs(s - underlying_ltp) <= self.oi_strike_range]
            if not window:
                raise ValueError(f"no strikes within {self.oi_strike_range} of {underlying_ltp:.0f}")
            ce_oi = float(df.loc[window, "ce_oi"].fillna(0).sum())
            pe_oi = float(df.loc[window, "pe_oi"].fillna(0).sum())
            diff = ce_oi - pe_oi

            self._oi_diff_history.append(diff)
            # Bounded history: compute_oi_bias only ever looks at the last two entries.
            del self._oi_diff_history[:-max(2, self.oi_expansion_window)]
            bias, reason = compute_oi_bias(self._oi_diff_history)
            if bias != self._oi_bias:
                logger.info("[OI] Bias %s -> %s (%s)", self._oi_bias, bias, reason)
            self._oi_bias = bias
            self._oi_reason = reason
            self._oi_diff = diff
            self._oi_warned = False
        except Exception as e:
            self._oi_bias = "UNAVAILABLE"
            self._oi_reason = f"OI fetch failed: {e}"
            if not self._oi_warned:
                logger.warning(
                    "OI bias unavailable — new entries needing OI confirmation are "
                    "BLOCKED until it returns: %s", e
                )
                self._oi_warned = True

    def compute_snapshot(self) -> Optional[Snapshot]:
        """Fetch candles and read the last CONFIRMED candle's bands + regime inputs."""
        indicators = [
            {"kind": "supertrend", "length": self.supertrend_period, "multiplier": self.supertrend_multiplier},
            {"kind": "vwap", "anchor": self.vwap_anchor},
            {"kind": "atr", "length": self.supertrend_period},
            {"kind": "adx", "length": self.adx_period},
            {"kind": "chop", "length": self.chop_length},
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

        vwap_val, _ = self._pick(df, row, prefix="VWAP")
        if not any(c.startswith("VWAP") for c in df.columns):
            logger.error("VWAP column missing. Available: %s", df.columns.tolist())
            return None

        atr_val, _ = self._pick(df, row, prefix="ATR")
        # ADX_<n> only — "ADXR_<n>_<m>" is a different indicator and would gate on the
        # wrong series. CHOP's suffix is float-formatted ("CHOP_14_1_100.0"), so match
        # on the prefix rather than reconstructing the name.
        adx_val, adx_ok = self._pick(df, row, prefix="ADX_")
        chop_val, chop_ok = self._pick(df, row, prefix="CHOP")
        adx_val = adx_val if adx_ok else NO_DATA
        chop_val = chop_val if chop_ok else NO_DATA

        self._refresh_htf_dir()
        self._refresh_oi_bias()

        candle_ts = str(df.index[-2])

        # Regime advances ONCE PER CONFIRMED CANDLE. Advancing it on every poll would
        # let a 2-candle confirmation be satisfied in 30 seconds.
        if candle_ts != self._regime_candle:
            self.regime, self._regime_streak, self.regime_reason = advance_regime(
                self.regime, self._regime_streak, adx_val, chop_val,
                adx_enter=self.adx_enter, adx_exit=self.adx_exit,
                chop_max=self.chop_max, confirm=self.regime_confirm_candles,
            )
            self._regime_candle = candle_ts

        snap = Snapshot(
            close=close, st=st_val, vwap=vwap_val, candle_ts=candle_ts, atr=atr_val,
            adx=adx_val, chop=chop_val, htf_dir=self._htf_dir,
            regime=self.regime, regime_reason=self.regime_reason,
            oi_bias=self._oi_bias, oi_reason=self._oi_reason, oi_diff=self._oi_diff,
        )
        with self._snap_lock:
            self._snapshot = snap

        if candle_ts != self.last_processed_candle_time:
            zone = "ABOVE BOTH" if (close > st_val > 0 and close > vwap_val > 0) else \
                   "BELOW BOTH" if (0 < st_val and close < st_val and 0 < vwap_val and close < vwap_val) else "MIXED"
            logger.info(
                "[SIGNAL] Candle: %s | Close: %.2f | ST: %.2f | VWAP: %.2f | ATR: %.2f | "
                "Zone: %s | ADX: %.1f | CHOP: %.1f | HTF: %s | Regime: %s (%s) | OI: %s%s",
                candle_ts, close, st_val, vwap_val, atr_val, zone,
                adx_val, chop_val,
                {1: "BULL", -1: "BEAR", 0: "?"}[snap.htf_dir],
                snap.regime, snap.regime_reason,
                snap.oi_bias, f" ({snap.oi_reason})" if self.require_oi_confirmation else "",
            )
            self.last_processed_candle_time = candle_ts
            self._log_decision(snap)
        return snap

    def _read_snapshot(self):
        with self._snap_lock:
            return self._snapshot

    def desired(self) -> str:
        """Direction the strategy wants right now, per the hybrid price rule.

        Flat  -> decided on the last CONFIRMED candle close (no intra-candle churn),
                 then run through the regime / higher-timeframe / band-gap gates.
        In a position -> decided on the live LTP unless --exit-on-close. HOLDING is
                 deliberately NOT re-gated: once in a trade the exit rules own it.
        """
        snap = self._read_snapshot()
        if snap is None:
            return self.direction
        min_distance = snap.atr * self.min_flip_atr_mult

        if self.direction != "NONE":
            price = snap.close if self.exit_on_close else (self.ltp if self.ltp > 0 else snap.close)
            want = desired_direction(price, snap.st, snap.vwap, self.direction, min_distance)
            if want == self.direction:
                return want
            # A flip's ENTRY leg has to pass the same gates a fresh entry does,
            # otherwise every filter is bypassed by simply already being in a trade.
            ok, why = self._entry_gate(want, snap)
            if not ok:
                # Signal says get out, filters say do not get in -> go flat.
                self.blocked_reason = why
                return "NONE"
            self.blocked_reason = ""
            return want

        want = desired_direction(snap.close, snap.st, snap.vwap, "NONE", min_distance)
        if want == "NONE":
            self.blocked_reason = ""
            return "NONE"

        blocked = self._flat_brakes(snap)
        if blocked:
            self.blocked_reason = blocked
            return "NONE"

        ok, why = self._entry_gate(want, snap)
        if not ok:
            self.blocked_reason = why
            return "NONE"
        self.blocked_reason = ""
        return want

    def _entry_gate(self, want: str, snap: Snapshot) -> Tuple[bool, str]:
        """Regime / higher-timeframe / band-gap / OI gates for a new entry leg."""
        return entry_allowed(
            want,
            regime=snap.regime, htf_dir=snap.htf_dir,
            st_val=snap.st, vwap_val=snap.vwap, atr_val=snap.atr,
            min_band_gap_atr=self.min_band_gap_atr,
            use_regime=self.use_regime_filter, use_htf=self.use_htf_filter,
            oi_bias=snap.oi_bias, use_oi=self.require_oi_confirmation,
        )

    def _flat_brakes(self, snap: Snapshot) -> str:
        """Churn brakes that apply only while flat. Returns a block reason, or "".

        These are P&L- and count-based rather than indicator-based: a losing streak in
        a directional strategy IS a chop reading, arriving before the indicators agree.
        """
        if self.max_trades_per_day > 0 and self.trades_today >= self.max_trades_per_day:
            return "daily trade cap reached (%d/%d)" % (self.trades_today, self.max_trades_per_day)
        if self.paused_until and time.time() < self.paused_until:
            mins = (self.paused_until - time.time()) / 60.0
            return "paused after %d consecutive losses (%.0f min left)" % (self.loss_streak, mins)
        elapsed = self._candles_since_exit(snap.candle_ts)
        if elapsed < self.cooldown_candles:
            return "re-entry cooldown %d/%d candles since exit" % (elapsed, self.cooldown_candles)
        return ""

    def _candles_since_exit(self, candle_ts: str) -> int:
        """Confirmed candles elapsed since the last flat-going exit.

        Counted from candle timestamps rather than wall clock so the cooldown means the
        same thing on a 1m and on a 15m interval.
        """
        if not self.exit_candle_time:
            return 10 ** 6  # no exit yet — never blocked
        try:
            exited = pd.to_datetime(self.exit_candle_time)
            now_c = pd.to_datetime(candle_ts)
        except Exception:
            return 10 ** 6
        minutes = max(1, int(self.interval))
        return max(0, int((now_c - exited).total_seconds() // (minutes * 60)))

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
            "Entered %s @ %.2f | Qty: %d lot(s) = %d barrels | ST: %.2f | VWAP: %.2f | "
            "Stop: %.2f (%s) | Trade %d%s | Expiry: %s",
            direction, self.entry_price, self.qty, self.exposure,
            snap.st if snap else 0.0, snap.vwap if snap else 0.0,
            self.stop_level, self.stop_source or "none", self.trades_today,
            "/%d" % self.max_trades_per_day if self.max_trades_per_day > 0 else "",
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

        # A run of losers is a chop reading that arrives before the indicators agree.
        if realized_pnl < 0:
            self.loss_streak += 1
            if self.loss_streak_pause > 0 and self.loss_streak >= self.loss_streak_pause:
                self.paused_until = time.time() + self.loss_streak_pause_minutes * 60
                logger.warning(
                    "%d consecutive losing trades — pausing new entries for %d minutes.",
                    self.loss_streak, self.loss_streak_pause_minutes
                )
        elif realized_pnl > 0:
            self.loss_streak = 0

        snap = self._read_snapshot()
        self.exit_candle_time = snap.candle_ts if snap else ""

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
        bands = f"ST {snap.st:.2f} / VWAP {snap.vwap:.2f}" if snap else "bands unavailable"
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
            "direction": self.direction,
            "entry_price": round(self.entry_price, 2),
            "ltp": round(self.ltp, 2),
            "st_level": round(snap.st, 2) if snap else 0.0,
            "vwap": round(snap.vwap, 2) if snap else 0.0,
            "signal_close": round(snap.close, 2) if snap else 0.0,
            "atr": round(snap.atr, 2) if snap else 0.0,
            "min_flip_atr_mult": self.min_flip_atr_mult,
            # --- regime gate ---
            "regime": self.regime,
            "regime_reason": self.regime_reason,
            "adx": round(snap.adx, 1) if snap else 0.0,
            "chop": round(snap.chop, 1) if snap else 0.0,
            "htf_st_dir": snap.htf_dir if snap else 0,
            "htf_interval": self.htf_interval,
            "band_gap": round(abs(snap.st - snap.vwap), 2) if snap else 0.0,
            "min_band_gap_atr": self.min_band_gap_atr,
            "adx_enter": self.adx_enter,
            "adx_exit": self.adx_exit,
            "chop_max": self.chop_max,
            "use_regime_filter": self.use_regime_filter,
            "use_htf_filter": self.use_htf_filter,
            # Why we are flat despite a live signal -- without this the dashboard
            # cannot tell "filtered out" from "hung".
            "blocked_reason": self.blocked_reason,
            # --- per-trade risk ---
            "stop_level": round(self.stop_level, 2),
            "stop_source": self.stop_source,
            "atr_stop_mult": self.atr_stop_mult,
            "trail_trigger_atr": self.trail_trigger_atr,
            # --- churn brakes ---
            "trades_today": self.trades_today,
            "max_trades_per_day": self.max_trades_per_day,
            "loss_streak": self.loss_streak,
            "paused_until": round(self.paused_until, 0),
            "cooldown_candles": self.cooldown_candles,
            "exit_candle_time": self.exit_candle_time,
            # --- OI confirmation ---
            "oi_bias": snap.oi_bias if snap else self._oi_bias,
            "oi_reason": snap.oi_reason if snap else self._oi_reason,
            "oi_diff": round(snap.oi_diff, 0) if snap else round(self._oi_diff, 0),
            "oi_symbol": self.oi_symbol,
            "oi_expiry": self._oi_expiry,
            "require_oi_confirmation": self.require_oi_confirmation,
            "collect_oi": self.collect_oi,
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
        """Restore today's P&L AND the churn brakes from the state file on restart.

        Restoring only the P&L would let a restart reset the daily trade cap and the
        loss-streak pause — turning a crash-loop into an unlimited-trade day, which is
        the exact failure this change exists to prevent.
        """
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
            self.loss_streak = int(saved.get("loss_streak", 0))
            self.paused_until = float(saved.get("paused_until", 0.0))
            self.exit_candle_time = str(saved.get("exit_candle_time", ""))
            if self.trades_today or self.loss_streak or self.paused_until > time.time():
                logger.info(
                    "Restored churn brakes: trades_today=%d loss_streak=%d%s",
                    self.trades_today, self.loss_streak,
                    ", paused for %.0f more min" % ((self.paused_until - time.time()) / 60.0)
                    if self.paused_until > time.time() else ""
                )
        except Exception as e:
            logger.warning("Could not restore daily state from state file: %s", e)

    # ------------------------------------------------------------------
    # Decision telemetry
    # ------------------------------------------------------------------

    def _log_decision(self, snap: Snapshot) -> None:
        """Append one JSON line per confirmed candle to debug/<key>_signals.jsonl.

        This is the evidence trail that replaces a backtest: every threshold in the
        regime gate ships as a convention, and this file is what lets them be retuned
        from what actually happened. ~170 lines per 5-minute session — negligible.
        """
        try:
            min_distance = snap.atr * self.min_flip_atr_mult
            raw = desired_direction(snap.close, snap.st, snap.vwap, "NONE", min_distance)
            gate_ok, gate_why = self._entry_gate(raw, snap) if raw != "NONE" else (False, "")
            brake_why = self._flat_brakes(snap) if raw != "NONE" else ""
            record: Dict[str, Any] = {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "candle": snap.candle_ts,
                "close": round(snap.close, 2),
                "st": round(snap.st, 2),
                "vwap": round(snap.vwap, 2),
                "atr": round(snap.atr, 2),
                "adx": round(snap.adx, 1),
                "chop": round(snap.chop, 1),
                "htf_dir": snap.htf_dir,
                "band_gap": round(abs(snap.st - snap.vwap), 2),
                "regime": snap.regime,
                "regime_reason": snap.regime_reason,
                "oi_bias": snap.oi_bias,
                "oi_reason": snap.oi_reason,
                "oi_diff": round(snap.oi_diff, 0),
                "raw_signal": raw,          # what the ORIGINAL rule would have done
                "gate_passed": bool(raw != "NONE" and gate_ok and not brake_why),
                "blocked_by": brake_why or gate_why,
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
            # Modal spacing, so a session boundary gap cannot skew the answer.
            deltas = df.index.to_series().diff().dropna()
            if deltas.empty:
                return 0
            return int(deltas.mode().iloc[0].total_seconds() // 60)
        except Exception as e:
            logger.warning("Interval probe for %sm failed: %s", interval, e)
            return 0

    def _verify_intervals(self) -> None:
        """Verify the signal interval and resolve/verify the higher-timeframe one.

        A wrong signal interval is FATAL: get_latest_candles returns an empty frame
        rather than an error, so the strategy would sit in SCANNING all session with
        nothing in the log to say why.
        """
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

        if not self.use_htf_filter:
            return

        if str(self.htf_interval).lower() == "auto":
            # First candidate strictly above the signal interval that Dhan really
            # serves. Deliberately ordered, not computed: 2x the signal interval is
            # often not a supported value.
            candidates = [c for c in (15, 25, 60, 5) if c > want]
            for cand in candidates:
                if self._probe_interval(str(cand)) == cand:
                    self.htf_interval = str(cand)
                    logger.info("Higher-timeframe interval auto-resolved to %dm.", cand)
                    break
            else:
                logger.warning(
                    "No usable higher timeframe above %dm — the HTF Supertrend filter is "
                    "DISABLED for this run. The regime and band-gap gates still apply.", want
                )
                self.use_htf_filter = False
            return

        got_htf = self._probe_interval(self.htf_interval)
        if got_htf != int(self.htf_interval):
            logger.critical(
                "Requested a %sm higher timeframe but Dhan returned %s. Pass "
                "--htf-interval auto, or a value Dhan actually serves.",
                self.htf_interval, f"{got_htf}m candles" if got_htf else "no candles"
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
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        mode = "LIVE" if not self.dry_run else "DRY RUN"
        print(
            f"\n{'='*66}\n"
            f"  CrudeOilM VWAP + Supertrend Always-On Strategy\n"
            f"  Mode        : {mode}\n"
            f"  Candles     : {self.interval}m\n"
            f"  Supertrend  : ({self.supertrend_period}, {self.supertrend_multiplier})\n"
            f"  VWAP anchor : {self.vwap_anchor}\n"
            f"  Rule        : LONG above BOTH | SHORT below BOTH | hold in between\n"
            f"  On flip     : {'stop-and-reverse' if self.allow_reverse else 'exit to flat (--no-reverse)'}"
            f" (min {self.flip_cooldown}s between flips"
            + (f", min clearance {self.min_flip_atr_mult}x ATR" if self.min_flip_atr_mult > 0 else "")
            + f")\n"
            f"  Exit price  : {'confirmed close' if self.exit_on_close else 'live LTP'}\n"
            f"  Regime gate : "
            + (f"ADX in/out {self.adx_enter:.0f}/{self.adx_exit:.0f}, CHOP <= {self.chop_max:.0f}, "
               f"confirm {self.regime_confirm_candles} candle(s)" if self.use_regime_filter else "DISABLED")
            + f"\n"
            f"  HTF filter  : "
            + (f"{self.htf_interval}m Supertrend must agree" if self.use_htf_filter else "DISABLED")
            + f"\n"
            f"  Band gap    : min {self.min_band_gap_atr}x ATR between ST and VWAP to enter\n"
            f"  Trade stop  : "
            + (f"{self.atr_stop_mult}x ATR, trails the Supertrend band after "
               f"{self.trail_trigger_atr}x ATR of profit" if self.atr_stop_mult > 0 else "none")
            + f"\n"
            f"  Churn brakes: max {self.max_trades_per_day or 'unlimited'} trades/day, "
            f"{self.cooldown_candles} candle re-entry cooldown, pause {self.loss_streak_pause_minutes}m "
            f"after {self.loss_streak_pause} straight losses\n"
            f"  OI gate     : "
            + (f"tracking {self.oi_symbol} chain, {'BLOCKING' if self.require_oi_confirmation else 'telemetry only'}"
               if self.collect_oi else "DISABLED")
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

        self._verify_intervals()
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

                # 6. Regime turned choppy -> flatten and stand aside. Only ever acts on
                # a CONFIRMED candle (advance_regime is called once per candle), so this
                # cannot fire mid-candle on a tick.
                snap = self._read_snapshot()
                if (self.use_regime_filter and self.direction != "NONE"
                        and snap is not None and snap.regime == "CHOP"):
                    self._flatten(f"Regime turned CHOP: {snap.regime_reason}")
                    self.exit_candle_time = snap.candle_ts
                    self.last_flip_ts = time.time()
                    self.blocked_reason = f"regime is CHOP ({snap.regime_reason})"
                    self.save_state(status="SCANNING")
                    time.sleep(1)
                    continue

                # 7. Signal dispatch
                if snap is None:
                    if time.time() - last_wait_log_time >= self.poll_seconds:
                        logger.info("Waiting for the first Supertrend/VWAP snapshot...")
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
                elif want == "NONE":
                    # desired() returns NONE from inside a position only when the price
                    # rule wants a flip but the entry gates reject the new side. Take
                    # the exit half of the flip and stand aside.
                    self._flatten(f"Signal left {self.direction} but the new side is "
                                  f"blocked ({self.blocked_reason or 'filtered'})")
                    self.exit_candle_time = snap.candle_ts
                    self.last_flip_ts = now_s
                elif want != self.direction:
                    # Supertrend and VWAP cross each other regularly. When they nearly
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
                        self.exit_candle_time = snap.candle_ts
                        self.last_flip_ts = now_s

                self.save_state(status="RUNNING" if self.direction != "NONE" else "SCANNING")

                now_ts = time.time()
                if now_ts - last_log_time >= 30:
                    logger.info(
                        "[MONITOR] Dir: %s | Entry: %.2f | LTP: %.2f | Stop: %.2f (%s) | "
                        "ST: %.2f | VWAP: %.2f | ATR: %.2f | ADX: %.1f | CHOP: %.1f | "
                        "Regime: %s | Trades: %d | Pos P&L: %.2f | Day P&L: %.2f (T:+%.0f/S:-%.0f)%s",
                        self.direction, self.entry_price, self.ltp,
                        self.stop_level, self.stop_source or "-",
                        snap.st, snap.vwap, snap.atr, snap.adx, snap.chop,
                        snap.regime, self.trades_today,
                        self.position_pnl, self.cumulative_pnl + self.position_pnl,
                        self.target_profit, self.stop_loss,
                        " | BLOCKED: %s" % self.blocked_reason if self.blocked_reason else "",
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
        description="MCX CrudeOilM VWAP + Supertrend Always-On Futures Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Rule:
  LONG   when price is above BOTH the Supertrend and VWAP
  SHORT  when price is below BOTH
  HOLD   the current position while price sits between them (hysteresis)

Regime gate (this is what keeps it out of range-bound sessions):
  A new position is only opened while the market is in a TREND regime --
  ADX above --adx-enter AND the Choppiness Index below --chop-max, confirmed
  over --regime-confirm-candles candles, with the --htf-interval Supertrend
  agreeing and the ST/VWAP bands at least --min-band-gap-atr ATRs apart.
  The regime only reverts to CHOP once ADX drops below the SEPARATE, lower
  --adx-exit; that two-sided hysteresis is what stops the filter itself from
  flapping. Turning CHOP flattens any open position and stands aside.

Examples:
  # Dry run (default), 5 lots, Supertrend(7,2) on 5-min candles
  python strategies/crudeoil/crudeoilm_vwap_supertrend.py

  # Live trading, 5 lots, +/- 10000 INR daily caps
  python strategies/crudeoil/crudeoilm_vwap_supertrend.py --live --lots 5 --target-profit 10000 --stop-loss 10000

  # Exit to flat on a flip instead of reversing, using confirmed closes only
  python strategies/crudeoil/crudeoilm_vwap_supertrend.py --no-reverse --exit-on-close
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
    parser.add_argument("--vwap-anchor", type=str, default="D",
                        help="VWAP anchor period passed to pandas_ta (default: D)")
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
                             "tick-level thrash when the Supertrend and VWAP nearly coincide")
    parser.add_argument("--min-flip-atr-mult", type=float, default=0.35,
                        help="Minimum ATR multiple a flip/entry must clear both ST and VWAP by, on "
                             "top of the time-based --flip-cooldown (default: 0.35; 0 disables, "
                             "which was the pre-2026-08 default)")
    # --- regime gate ---
    parser.add_argument("--adx-period", type=int, default=14,
                        help="ADX length on the signal timeframe (default: 14)")
    parser.add_argument("--adx-enter", type=float, default=22.0,
                        help="ADX at or above which the regime becomes TREND (default: 22)")
    parser.add_argument("--adx-exit", type=float, default=18.0,
                        help="ADX below which a TREND regime reverts to CHOP (default: 18). "
                             "Must be lower than --adx-enter: the gap is the hysteresis that "
                             "stops the regime flapping at the threshold")
    parser.add_argument("--chop-length", type=int, default=14,
                        help="Choppiness Index length (default: 14)")
    parser.add_argument("--chop-max", type=float, default=55.0,
                        help="Choppiness Index at or below which TREND is allowed (default: 55). "
                             f"Reverting to CHOP needs this + {CHOP_EXIT_BUFFER:.0f}")
    parser.add_argument("--regime-confirm-candles", type=int, default=2,
                        help="Consecutive confirmed candles a regime flip must survive (default: 2)")
    parser.add_argument("--htf-interval", type=str, default="auto",
                        help="Higher-timeframe Supertrend confirmation interval in minutes, or "
                             "'auto' (default) to pick the first candidate above --interval that "
                             "Dhan actually serves. Any explicit value is VERIFIED against the "
                             "returned candle spacing at startup -- Dhan silently answers a "
                             "request for 30 with 15-minute candles, and returns nothing at all "
                             "for 60 on CRUDEOILM")
    parser.add_argument("--htf-refresh-seconds", type=int, default=60,
                        help="How often to refresh the higher-timeframe Supertrend (default: 60)")
    parser.add_argument("--no-regime-filter", action="store_true", default=False,
                        help="Disable the ADX/Choppiness regime gate entirely (restores the old "
                             "always-on behaviour)")
    parser.add_argument("--no-htf-filter", action="store_true", default=False,
                        help="Disable the higher-timeframe Supertrend agreement filter")
    parser.add_argument("--min-band-gap-atr", type=float, default=0.5,
                        help="Minimum ATR multiple between the Supertrend and VWAP for a NEW "
                             "entry (default: 0.5). The bands collapsing onto each other IS the "
                             "chop condition for this strategy; 0 disables")
    # --- per-trade risk ---
    parser.add_argument("--atr-stop-mult", type=float, default=1.5,
                        help="Initial per-trade stop, in ATRs from the entry (default: 1.5; "
                             "0 disables the stop and the trail)")
    parser.add_argument("--trail-trigger-atr", type=float, default=1.0,
                        help="ATRs of open profit before the stop hands over to the Supertrend "
                             "band and starts ratcheting (default: 1.0)")
    # --- churn brakes ---
    parser.add_argument("--max-trades-per-day", type=int, default=6,
                        help="Cap on entries per day, reversal legs included (default: 6; 0 = "
                             "unlimited). Survives a process restart")
    parser.add_argument("--cooldown-candles", type=int, default=1,
                        help="Confirmed candles to wait after any flat-going exit (default: 1)")
    parser.add_argument("--loss-streak-pause", type=int, default=2,
                        help="Consecutive losing trades before new entries pause (default: 2; "
                             "0 disables)")
    parser.add_argument("--loss-streak-pause-minutes", type=int, default=30,
                        help="How long that pause lasts, minutes (default: 30)")
    # --- OI confirmation ---
    parser.add_argument("--oi-symbol", type=str, default="CRUDEOIL",
                        help="Option-chain underlying symbol for the OI gate (default: "
                             "CRUDEOIL). CRUDEOILM has no options of its own; CRUDEOIL "
                             "shares the same per-barrel price so its chain is the real "
                             "OI source. Pass '' to disable OI collection entirely")
    parser.add_argument("--oi-strike-range", type=float, default=250.0,
                        help="Strikes within this many points of the underlying LTP are "
                             "summed for the OI bias (default: 250)")
    parser.add_argument("--oi-strike-step", type=float, default=50.0,
                        help="Strike spacing, points (default: 50; informational only, "
                             "the chain's own strikes are used as-is)")
    parser.add_argument("--oi-expansion-window", type=int, default=3,
                        help="OI snapshots kept for the expansion check (default: 3; the "
                             "bias itself only compares the latest two)")
    parser.add_argument("--oi-refresh-seconds", type=int, default=45,
                        help="OI chain refresh cadence, seconds (default: 45). Dhan's "
                             "option-chain endpoint enforces a ~3s minimum call spacing "
                             "and a 5s response cache; do not go far below that")
    parser.add_argument("--require-oi-confirmation", action="store_true", default=False,
                        help="BLOCK new entries unless CE/PE OI buildup agrees with the "
                             "side being opened (default: off). OI is always fetched and "
                             "logged to the decision telemetry regardless of this flag "
                             "-- there is no historical crude OI in this repo to validate "
                             "against, so review the telemetry before turning this on")
    parser.add_argument("--no-oi-tracking", action="store_true", default=False,
                        help="Disable the OI chain fetch entirely (no telemetry, no "
                             "gate). Use if crude options access is unreliable on your "
                             "account or you want zero extra option-chain API load")
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
    if args.poll_seconds < 1:
        problems.append("--poll-seconds must be at least 1")
    if args.days < 1:
        problems.append("--days must be at least 1")
    if args.flip_cooldown < 0:
        problems.append("--flip-cooldown cannot be negative")
    if args.min_flip_atr_mult < 0:
        problems.append("--min-flip-atr-mult cannot be negative")
    if args.min_band_gap_atr < 0:
        problems.append("--min-band-gap-atr cannot be negative")
    if args.atr_stop_mult < 0:
        problems.append("--atr-stop-mult cannot be negative")
    if args.trail_trigger_atr < 0:
        problems.append("--trail-trigger-atr cannot be negative")
    if args.adx_period < 2:
        problems.append("--adx-period must be at least 2")
    if args.chop_length < 2:
        problems.append("--chop-length must be at least 2")
    if args.adx_exit >= args.adx_enter:
        problems.append(
            f"--adx-exit ({args.adx_exit}) must be strictly LOWER than --adx-enter "
            f"({args.adx_enter}) -- equal thresholds remove the hysteresis and the regime "
            f"flaps candle to candle"
        )
    if not 0 < args.chop_max < 100:
        problems.append("--chop-max must be between 0 and 100 (the Choppiness Index is 0-100)")
    if args.regime_confirm_candles < 1:
        problems.append("--regime-confirm-candles must be at least 1")
    if args.htf_refresh_seconds < 1:
        problems.append("--htf-refresh-seconds must be at least 1")
    if args.max_trades_per_day < 0:
        problems.append("--max-trades-per-day cannot be negative (0 = unlimited)")
    if args.cooldown_candles < 0:
        problems.append("--cooldown-candles cannot be negative")
    if args.loss_streak_pause < 0:
        problems.append("--loss-streak-pause cannot be negative (0 disables)")
    if args.loss_streak_pause_minutes < 0:
        problems.append("--loss-streak-pause-minutes cannot be negative")
    if args.oi_strike_range <= 0:
        problems.append("--oi-strike-range must be greater than 0")
    if args.oi_expansion_window < 2:
        problems.append("--oi-expansion-window must be at least 2 (a bias needs two "
                         "snapshots to compare)")
    if args.oi_refresh_seconds < 5:
        problems.append("--oi-refresh-seconds must be at least 5 (Dhan's option-chain "
                         "cache is 5s; anything faster just re-reads the same cache)")
    if args.require_oi_confirmation and args.no_oi_tracking:
        problems.append("--require-oi-confirmation needs OI data; it cannot be combined "
                         "with --no-oi-tracking")
    if not str(args.interval).isdigit() or int(args.interval) < 1:
        problems.append("--interval must be a positive whole number of minutes")
    # Which intervals Dhan actually serves is NOT a fixed list and is not worth
    # guessing: measured against CRUDEOILM on 2026-08-24, "3" works, "30" silently
    # returns 15-minute candles, and "60" returns nothing at all. So argparse only
    # checks the arithmetic; the real interval is VERIFIED against the candle spacing
    # at startup by _probe_interval().
    if not args.no_htf_filter and str(args.htf_interval).lower() != "auto":
        if not str(args.htf_interval).isdigit() or int(args.htf_interval) < 1:
            problems.append("--htf-interval must be a positive whole number of minutes, or 'auto'")
        elif str(args.interval).isdigit() and int(args.htf_interval) <= int(args.interval):
            problems.append(
                f"--htf-interval ({args.htf_interval}) must be strictly greater than "
                f"--interval ({args.interval}) to be a HIGHER timeframe"
            )
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

    strat = CrudeOilMVwapSupertrendStrategy(
        dry_run=not args.live,
        lots=args.lots,
        contract_size=args.contract_size,
        interval=args.interval,
        supertrend_period=args.supertrend_period,
        supertrend_multiplier=args.supertrend_multiplier,
        vwap_anchor=args.vwap_anchor,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
        start_time=args.start_time,
        eod_time=args.eod_time,
        poll_seconds=args.poll_seconds,
        days=args.days,
        allow_reverse=not args.no_reverse,
        exit_on_close=args.exit_on_close,
        flip_cooldown=args.flip_cooldown,
        min_flip_atr_mult=args.min_flip_atr_mult,
        adx_period=args.adx_period,
        adx_enter=args.adx_enter,
        adx_exit=args.adx_exit,
        chop_length=args.chop_length,
        chop_max=args.chop_max,
        regime_confirm_candles=args.regime_confirm_candles,
        htf_interval=args.htf_interval,
        htf_refresh_seconds=args.htf_refresh_seconds,
        use_regime_filter=not args.no_regime_filter,
        use_htf_filter=not args.no_htf_filter,
        min_band_gap_atr=args.min_band_gap_atr,
        atr_stop_mult=args.atr_stop_mult,
        trail_trigger_atr=args.trail_trigger_atr,
        max_trades_per_day=args.max_trades_per_day,
        cooldown_candles=args.cooldown_candles,
        loss_streak_pause=args.loss_streak_pause,
        loss_streak_pause_minutes=args.loss_streak_pause_minutes,
        oi_symbol="" if args.no_oi_tracking else args.oi_symbol,
        oi_strike_range=args.oi_strike_range,
        oi_strike_step=args.oi_strike_step,
        oi_expansion_window=args.oi_expansion_window,
        oi_refresh_seconds=args.oi_refresh_seconds,
        require_oi_confirmation=args.require_oi_confirmation,
        collect_oi=not args.no_oi_tracking,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt. Exiting cleanly.")
        strat._flatten("KeyboardInterrupt / Manual Stop")
        strat.save_state(status="STOPPED")
        sys.exit(0)
