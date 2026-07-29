"""
Nifty VIX-Filtered Straddle Strategy

Sells the ATM straddle only while India VIX itself is trending down, on top of
the usual "cheap relative to VWAP" mean-reversion gate:

Entry conditions (all must be true):
  1. Combined straddle premium (CE+PE) is below its own Supertrend(st_period, st_multiplier)
     computed on `st_interval`-minute resampled bars (i.e. the straddle's own short-term
     trend is down -- premium falling).
  2. India VIX is below its own Supertrend(vix_st_period, vix_st_multiplier) computed on
     `vix_st_interval`-minute resampled bars (i.e. VIX itself is trending down).
  3. Combined straddle premium is at or below its intraday VWAP (session cumulative,
     from 1-minute OHLCV candles).

Exit conditions (either triggers):
  1. India VIX crosses back above its Supertrend (VIX trend turns up -- get out before
     premium expansion).
  2. Combined premium rises above VWAP + exit_buffer (configurable points).

Rationale: straddle-selling profits from range-bound/falling IV. Gating entry (and
forcing exit) on VIX's own Supertrend direction keeps the strategy out of the market
while volatility is expanding, even if the straddle premium momentarily looks "cheap"
relative to VWAP.

CLI args:
  --live                     Place real orders (default: dry run)
  --lots N                   Lots per leg (default: 1)
  --start-time HH:MM         Session start (default: 09:20)
  --st-period N              Straddle Supertrend period (default: 10)
  --st-multiplier F          Straddle Supertrend multiplier (default: 2.0)
  --st-interval MIN          Straddle Supertrend candle interval, resampled from 1-min bars (default: 3)
  --vix-st-period N          India VIX Supertrend period (default: 10)
  --vix-st-multiplier F      India VIX Supertrend multiplier (default: 2.0)
  --vix-st-interval MIN      India VIX Supertrend candle interval, resampled from 1-min bars (default: 3)
  --exit-buffer POINTS       Points above VWAP that trigger exit (default: 5)
  --max-premium-diff PCT     Max CE/PE premium difference % (default: 15)
  --vwap-warmup-bars N       Min completed 1-min bars before VWAP is trusted (default: 10)
  --target-profit INR        Global profit target (default: 4000)
  --stop-loss INR            Global stop loss (default: 4000)
  --max-loss-per-trade INR   Hard stop-loss per cycle, independent of VWAP (default: 1500, 0=disabled)
  --max-trades-per-day N     Max entries per session (default: 15, 0=unlimited)
  --cooldown-seconds N       Pause entries for N seconds after a losing cycle (default: 90)
  --max-spread-pct PCT       Max bid-ask spread % per leg to allow entry (default: 8, 0=disabled)
"""

import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime, timedelta
from typing import Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec

# ── Logging setup ────────────────────────────────────────────────────────────
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "vix_straddle")
os.makedirs(log_dir, exist_ok=True)

STRATEGY_KEY = "nifty_vix_straddle"

VIX_SECURITY_ID = "21"  # India VIX, NSE_IDX segment

# Consecutive candle-fetch API failures before escalating to a CRITICAL log
API_ERROR_ALERT_STREAK = 5

# Max leg buy-to-cover attempts before giving up for this tick (retried again next tick)
EXIT_RETRY_ATTEMPTS = 3


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

class NiftyVixStraddle:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        start_time: str = "09:20",
        st_period: int = 10,
        st_multiplier: float = 2.0,
        st_interval: str = "3",
        vix_st_period: int = 10,
        vix_st_multiplier: float = 2.0,
        vix_st_interval: str = "3",
        exit_buffer: float = 5.0,
        max_premium_diff_pct: float = 15.0,
        vwap_warmup_bars: int = 10,
        profit_target: float = 4000.0,
        profit_target_is_pct: bool = False,
        stop_loss: float = 4000.0,
        stop_loss_is_pct: bool = False,
        max_loss_per_trade: float = 1500.0,
        max_trades_per_day: int = 15,
        cooldown_seconds: int = 90,
        max_spread_pct: float = 8.0,
    ):
        self.dry_run = dry_run
        self.lots = lots
        self.start_time = start_time
        self.st_period = st_period
        self.st_multiplier = st_multiplier
        self.st_interval = st_interval
        self.vix_st_period = vix_st_period
        self.vix_st_multiplier = vix_st_multiplier
        self.vix_st_interval = vix_st_interval
        self.exit_buffer = exit_buffer
        self.max_premium_diff_pct = max_premium_diff_pct
        self.vwap_warmup_bars = vwap_warmup_bars
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see below).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)
        self.max_loss_per_trade = max_loss_per_trade
        self.max_trades_per_day = max_trades_per_day
        self.cooldown_seconds = cooldown_seconds
        self.max_spread_pct = max_spread_pct

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise RuntimeError("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        logger.info("Starting WebSocket for NIFTY Index (security ID 13)...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)

        self.lot_size = self.helper.get_lot_size("NIFTY")
        logger.info(f"NIFTY lot size: {self.lot_size}")

        levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_close: float = levels.get("close", 0.0) if levels else 0.0

        # Position state
        self._reset_position()

        # Candle-based VWAP state (refreshed every minute)
        self.candle_vwap: float = 0.0
        self.vwap_bars: int = 0
        self._last_candle_minute: str = ""   # "HH:MM" of last successful candle fetch

        # Supertrend state
        self.straddle_st_dir: Optional[float] = None
        self.vix_st_dir: Optional[float] = None
        self.vix_ltp: float = 0.0
        self._vix_data_date: str = ""  # "YYYY-MM-DD" of the last successful VIX candle fetch

        # Session-level PnL
        self.realized_pnl: float = 0.0
        self.cycle_count: int = 0
        self.trade_count: int = 0

        # Data API health tracking (consecutive candle-fetch failures)
        self._api_error_streak: int = 0

        # Cooldown after a losing cycle
        self._cooldown_until: float = 0.0

        # Per-leg exit tracking (for partial-exit retry on order failure)
        self.ce_closed: bool = True
        self.pe_closed: bool = True

    # ── helpers ──────────────────────────────────────────────────────────────

    def _reset_position(self):
        self.in_position = False
        self.ce_strike: int = 0
        self.pe_strike: int = 0
        self.ce_id: str = ""
        self.pe_id: str = ""
        self.ce_avg: float = 0.0
        self.pe_avg: float = 0.0
        self.entry_combined: float = 0.0
        self.ce_closed = True
        self.pe_closed = True

    def _reset_indicators(self):
        self.candle_vwap = 0.0
        self.vwap_bars = 0
        self._last_candle_minute = ""
        self.straddle_st_dir = None

    def _vwap_ready(self) -> bool:
        if self.vwap_bars <= 0 or self.candle_vwap <= 0:
            return False
        if self.vwap_bars >= self.vwap_warmup_bars:
            return True
        # Warmup only needs to cover the first `vwap_warmup_bars` minutes after
        # session open (09:15) -- once that wall-clock window has passed, VWAP is
        # already mature even if the resampled bar count came back lower than
        # expected (e.g. thin history right after an ATM shift to a freshly
        # selected strike, or a brief candle-fetch gap). Don't keep blocking
        # entries on bar-count alone past that point.
        warmup_deadline = datetime.now().replace(hour=9, minute=15, second=0, microsecond=0) + timedelta(minutes=self.vwap_warmup_bars)
        return datetime.now() >= warmup_deadline

    def _sleep_shutdown_aware(self, seconds: int):
        for _ in range(seconds):
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger detected in cooldown sleep.")
                self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
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
                "candle_vwap": round(self.candle_vwap, 2),
                "vwap_bars": self.vwap_bars,
                "straddle_st_dir": self.straddle_st_dir,
                "vix_st_dir": self.vix_st_dir,
                "vix_ltp": self.vix_ltp,
                "entry_combined": self.entry_combined,
                "realized_pnl": self.realized_pnl,
                "total_pnl": total_pnl,
                "spot": spot,
                "adjustments": self.cycle_count,
                "profit_target": self.profit_target,
                "stop_loss": self.stop_loss,
                "trade_count": self.trade_count,
                "max_trades_per_day": self.max_trades_per_day,
                "max_loss_per_trade": self.max_loss_per_trade,
                "cooldown_active": time.time() < self._cooldown_until,
                "api_error_streak": self._api_error_streak,
            },
        )

    def _ltp(self, security_id: str) -> float:
        return self.helper.get_ltp(security_id, exchange="NSE_FNO", instrument="OPTIDX")

    def _nifty_spot(self) -> float:
        spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
        if spot > 0:
            return spot
        # Fallback 1: option chain underlying LTP
        expiry = self.helper.get_nearest_expiry("NIFTY")
        if expiry:
            chain_df = self.helper.get_option_chain_df("NIFTY", expiry)
            spot = float(chain_df.attrs.get("underlying_ltp", 0)) if not chain_df.empty else 0.0
        if spot > 0:
            logger.warning(f"NIFTY spot via option chain underlying_ltp: {spot:.2f}")
            return spot
        # Fallback 2: previous day close
        if self.prev_day_close > 0:
            logger.warning(f"NIFTY spot fallback to prev day close: {self.prev_day_close:.2f}")
            return self.prev_day_close
        return 0.0

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

    # ── candle fetch helpers ─────────────────────────────────────────────────

    def _fetch_option_candles(self, security_id: str) -> pd.DataFrame:
        """Fetch today's 1-min OHLCV candles for an option security ID."""
        today = datetime.now().strftime("%Y-%m-%d")
        # Use a 2-day window (yesterday -> today) to avoid DH-905 on same-day-only requests
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        df = self.helper.get_intraday_minute_data(
            security_id=security_id,
            exchange_segment="NSE_FNO",
            instrument_type="OPTIDX",
            interval="1",
            from_date=yesterday,
            to_date=today,
        )
        if df.empty:
            err = self.helper.last_api_error
            if err:
                logger.error(
                    f"Candle fetch API error for ID {security_id}: "
                    f"[{err.get('code') or err.get('type')}] {err.get('message')}"
                )
                self._api_error_streak += 1
                if self._api_error_streak == API_ERROR_ALERT_STREAK:
                    logger.critical(
                        f"Data API has failed {self._api_error_streak} consecutive candle fetches "
                        "(check Dhan Data API subscription -- DH-902 lapse or similar). "
                        "VWAP/Supertrend will not refresh until this clears."
                    )
            else:
                logger.warning(f"No candle data returned for ID {security_id} (empty response, no API error).")
            return df
        self._api_error_streak = 0

        df.columns = [c.lower() for c in df.columns]
        ts_col = next(
            (c for c in df.columns if any(k in c for k in ("time", "date", "stamp"))),
            None,
        )
        if ts_col is None:
            logger.warning(f"No timestamp column found in candle data for ID {security_id}. Cols: {list(df.columns)}")
            return pd.DataFrame()

        first_val = df[ts_col].iloc[0]
        if isinstance(first_val, (int, float)):
            df["ts"] = (
                pd.to_datetime(df[ts_col], unit="s")
                .dt.tz_localize("UTC")
                .dt.tz_convert("Asia/Kolkata")
                .dt.tz_localize(None)
            )
        else:
            df["ts"] = pd.to_datetime(df[ts_col])

        session_start = datetime.now().replace(hour=9, minute=15, second=0, microsecond=0)
        df = df[df["ts"] >= session_start].copy()
        df = df.sort_values("ts").reset_index(drop=True)
        return df

    def _fetch_vix_candles(self) -> pd.DataFrame:
        """Fetch today's 1-min OHLC candles for India VIX (security ID 21, NSE_IDX)."""
        today = datetime.now().strftime("%Y-%m-%d")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            raw = self.helper.get_intraday_minute_data(
                security_id=VIX_SECURITY_ID,
                exchange_segment="IDX_I",
                instrument_type="INDEX",
                interval="1",
                from_date=yesterday,
                to_date=today,
            )
        except Exception as e:
            logger.error(f"Error fetching India VIX candles: {e}")
            return pd.DataFrame()

        if raw.empty:
            return raw

        rename_map = {
            "start_time": "Datetime", "start_Time": "Datetime",
            "kline_time": "Datetime", "timestamp": "Datetime",
            "open": "Open", "high": "High", "low": "Low",
            "close": "Close", "volume": "Volume",
        }
        new_map = {c: rename_map[c.lower()] for c in raw.columns if c.lower() in rename_map}
        df = raw.rename(columns=new_map)
        df = df[[c for c in ["Datetime", "Open", "High", "Low", "Close", "Volume"] if c in df.columns]]

        if "Datetime" not in df.columns:
            return pd.DataFrame()

        first_val = df["Datetime"].iloc[0]
        if isinstance(first_val, (int, float)):
            df["Datetime"] = (
                pd.to_datetime(df["Datetime"], unit="s")
                .dt.tz_localize("UTC")
                .dt.tz_convert("Asia/Kolkata")
                .dt.tz_localize(None)
            )
        else:
            df["Datetime"] = pd.to_datetime(df["Datetime"])
        df = df.set_index("Datetime").sort_index()

        today_date = datetime.now().date()
        today_mask = df.index.date == today_date
        session_mask = df.index.strftime("%H:%M") >= "09:15"
        return df[today_mask & session_mask]

    def _resample_and_supertrend(self, candles_1m: pd.DataFrame, st_period: int, st_multiplier: float,
                                  interval_minutes: str) -> Tuple[Optional[float], Optional[float]]:
        """
        Resample 1-min OHLC candles (Datetime-indexed, Title-case columns) to
        `interval_minutes`-min bars and compute Supertrend on the resampled series.
        Returns (direction, close) from the last COMPLETED bar, or (None, None).
        """
        if candles_1m.empty:
            return None, None
        try:
            resample_rule = f"{interval_minutes}min"
            agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last"}
            if "Volume" in candles_1m.columns:
                agg["Volume"] = "sum"
            df = candles_1m.resample(resample_rule).agg(agg).dropna(subset=["Close"])
            if len(df) < st_period + 2:
                return None, None

            st_ind = [{"kind": "supertrend", "length": st_period, "multiplier": st_multiplier}]
            df_ta = self.helper.calculate_ta_indicators(df.copy(), st_ind)

            dir_cols = [c for c in df_ta.columns if c.startswith("SUPERTd_")]
            if not dir_cols:
                return None, None

            row = df_ta.iloc[-2]  # last completed bar (last row may still be forming)
            direction = float(row[dir_cols[0]])
            close = float(row["Close"])
            if pd.isna(direction):
                return None, None
            return direction, close
        except Exception as e:
            logger.error(f"Supertrend resample error: {e}")
            return None, None

    def _refresh_indicators(self) -> bool:
        """
        Re-fetch 1-min candles for CE/PE and India VIX, then:
          - build combined straddle OHLCV, compute cumulative session VWAP
          - resample combined straddle bars to `st_interval`-min and compute Supertrend
          - resample VIX bars to `vix_st_interval`-min and compute Supertrend

        Returns True if at least the VWAP was successfully updated.
        """
        if not self.ce_id or not self.pe_id:
            return False

        ce_df = self._fetch_option_candles(self.ce_id)
        pe_df = self._fetch_option_candles(self.pe_id)

        if ce_df.empty or pe_df.empty:
            logger.warning("Could not fetch 1-min candles for CE or PE; indicators not updated.")
            return False

        required = {"open", "high", "low", "close", "volume"}
        if not required.issubset(ce_df.columns) or not required.issubset(pe_df.columns):
            logger.warning(
                f"Missing OHLCV columns. CE cols: {list(ce_df.columns)}, PE cols: {list(pe_df.columns)}"
            )
            return False

        ce_df["minute"] = ce_df["ts"].dt.floor("min")
        pe_df["minute"] = pe_df["ts"].dt.floor("min")

        merged = pd.merge(
            ce_df[["minute", "open", "high", "low", "close", "volume"]].rename(
                columns={"open": "o_ce", "high": "h_ce", "low": "l_ce", "close": "c_ce", "volume": "v_ce"}
            ),
            pe_df[["minute", "open", "high", "low", "close", "volume"]].rename(
                columns={"open": "o_pe", "high": "h_pe", "low": "l_pe", "close": "c_pe", "volume": "v_pe"}
            ),
            on="minute",
            how="inner",
        ).sort_values("minute").reset_index(drop=True)

        if merged.empty:
            logger.warning("CE/PE candles could not be aligned on timestamp; indicators not updated.")
            return False

        merged["combo_o"] = merged["o_ce"] + merged["o_pe"]
        merged["combo_h"] = merged["h_ce"] + merged["h_pe"]
        merged["combo_l"] = merged["l_ce"] + merged["l_pe"]
        merged["combo_c"] = merged["c_ce"] + merged["c_pe"]

        # Typical price of combined straddle premium per bar
        merged["tp"] = (merged["combo_h"] + merged["combo_l"] + merged["combo_c"]) / 3

        # Volume: average of both legs; NaN or zero -> 1 so quiet bars still count (TWAP-like)
        merged["vol"] = (merged["v_ce"].fillna(0) + merged["v_pe"].fillna(0)) / 2
        merged["vol"] = merged["vol"].replace(0, 1)

        # Cumulative VWAP from session open
        cum_tpv = (merged["tp"] * merged["vol"]).cumsum()
        cum_vol = merged["vol"].cumsum()
        merged["vwap"] = cum_tpv / cum_vol

        self.candle_vwap = float(merged["vwap"].iloc[-1])
        self.vwap_bars = len(merged)

        # Straddle's own Supertrend on resampled combined bars
        combo_df = merged[["minute", "combo_o", "combo_h", "combo_l", "combo_c"]].rename(
            columns={"combo_o": "Open", "combo_h": "High", "combo_l": "Low", "combo_c": "Close"}
        ).set_index("minute")
        st_dir, st_close = self._resample_and_supertrend(combo_df, self.st_period, self.st_multiplier, self.st_interval)
        self.straddle_st_dir = st_dir

        # India VIX's own Supertrend
        vix_df = self._fetch_vix_candles()
        if not vix_df.empty:
            self.vix_ltp = float(vix_df["Close"].iloc[-1])
            vix_dir, _ = self._resample_and_supertrend(vix_df, self.vix_st_period, self.vix_st_multiplier, self.vix_st_interval)
            self.vix_st_dir = vix_dir
            self._vix_data_date = datetime.now().strftime("%Y-%m-%d")
        else:
            logger.warning("Could not fetch India VIX candles; vix_st_dir left stale.")

        logger.info(
            f"[Indicators] VWAP={self.candle_vwap:.2f} ({self.vwap_bars} bars) | "
            f"Straddle ST({self.st_period},{self.st_multiplier})@{self.st_interval}m dir={self.straddle_st_dir} "
            f"(close={st_close if st_close is not None else 'n/a'}) | "
            f"VIX={self.vix_ltp:.2f} ST({self.vix_st_period},{self.vix_st_multiplier})@{self.vix_st_interval}m dir={self.vix_st_dir}"
        )
        return True

    def _maybe_refresh_indicators(self):
        """Refresh VWAP + both Supertrends at most once per completed 1-min bar."""
        current_minute = datetime.now().strftime("%H:%M")
        if current_minute != self._last_candle_minute:
            if self._refresh_indicators():
                self._last_candle_minute = current_minute

    # ── option info ───────────────────────────────────────────────────────────

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

    def _spread_ok(self, ce_id: str, pe_id: str) -> bool:
        """
        Reject entry if either leg's bid-ask spread is too wide (illiquid strike, poor fill risk).
        Fails open (allows entry) with a warning if depth data is missing/malformed, since the
        quote endpoint's depth shape can vary and we don't want a parsing gap to silently disable
        all entries.
        """
        if self.max_spread_pct <= 0:
            return True
        try:
            sids = [int(ce_id), int(pe_id)]
        except (TypeError, ValueError):
            return True
        try:
            quotes = self.helper.get_quote_data({"NSE_FNO": sids})
        except Exception as e:
            logger.warning(f"Spread check: get_quote_data failed ({e}); allowing entry.")
            return True

        leg_data = (quotes or {}).get("NSE_FNO", {})
        for sid, leg in [(ce_id, "CE"), (pe_id, "PE")]:
            entry = leg_data.get(str(int(sid)), {}) if leg_data else {}
            depth = entry.get("depth", {})
            buy_levels = depth.get("buy") or []
            sell_levels = depth.get("sell") or []
            if not buy_levels or not sell_levels:
                logger.warning(f"Spread check: no depth data for {leg} (ID: {sid}); allowing entry.")
                continue
            bid = float(buy_levels[0].get("price", 0) or 0)
            ask = float(sell_levels[0].get("price", 0) or 0)
            if bid <= 0 or ask <= 0:
                logger.warning(f"Spread check: invalid bid/ask for {leg} (ID: {sid}); allowing entry.")
                continue
            mid = (bid + ask) / 2
            spread_pct = (ask - bid) / mid * 100 if mid > 0 else 0.0
            if spread_pct > self.max_spread_pct:
                logger.info(
                    f"Spread check: {leg} (ID: {sid}) spread {spread_pct:.1f}% "
                    f"(bid={bid:.2f} ask={ask:.2f}) exceeds max {self.max_spread_pct:.1f}%."
                )
                return False
        return True

    # ── entry / exit orders ──────────────────────────────────────────────────

    def _enter_straddle(self, ce_id: str, pe_id: str, ce_ltp: float, pe_ltp: float) -> bool:
        qty = self.lots * self.lot_size
        if not self.dry_run:
            ce_oid = self.helper.sell(ce_id, qty)
            if not ce_oid:
                logger.error("CE sell order failed; aborting entry.")
                return False
            pe_oid = self.helper.sell(pe_id, qty)
            if not pe_oid:
                logger.error("PE sell order failed; rolling back CE leg.")
                try:
                    self.helper.buy(ce_id, qty)
                except Exception as rb:
                    logger.error(f"CE rollback failed: {rb}")
                return False
            ce_fill = self._get_fill_price(ce_oid, ce_ltp)
            pe_fill = self._get_fill_price(pe_oid, pe_ltp)
        else:
            ce_fill, pe_fill = ce_ltp, pe_ltp
            logger.info(
                f"[DRY RUN] SELL {self.lots}L CE {self.ce_strike} @ {ce_ltp:.2f}"
                f" | PE {self.pe_strike} @ {pe_ltp:.2f}"
            )

        self.ce_avg = ce_fill
        self.pe_avg = pe_fill
        self.entry_combined = ce_fill + pe_fill

        if self.target_is_pct or self.stop_is_pct:
            entry_value = self.entry_combined * qty
            if self.target_is_pct:
                self.profit_target = entry_value * self.target_pct / 100.0
                logger.info(f"Resolved profit target: {self.target_pct}% of entry premium INR{entry_value:.0f} = INR{self.profit_target:.0f}")
            if self.stop_is_pct:
                self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                logger.info(f"Resolved stop loss: {self.stop_pct}% of entry premium INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

        self.in_position = True
        self.ce_closed = False
        self.pe_closed = False
        self.trade_count += 1
        logger.info(
            f"ENTERED straddle | CE {self.ce_strike} @ {ce_fill:.2f}"
            f" | PE {self.pe_strike} @ {pe_fill:.2f}"
            f" | Combined: {self.entry_combined:.2f}"
            f" | VWAP: {self.candle_vwap:.2f} ({self.vwap_bars} bars)"
            f" | Straddle ST dir={self.straddle_st_dir} | VIX ST dir={self.vix_st_dir} (VIX={self.vix_ltp:.2f})"
        )
        return True

    def _close_leg_with_retry(self, sid: str, qty: int, leg: str, attempts: int = EXIT_RETRY_ATTEMPTS) -> bool:
        """Attempt to buy-to-cover a leg, retrying on failed placement or unfilled order."""
        for attempt in range(1, attempts + 1):
            try:
                oid = self.helper.buy(sid, qty)
            except Exception as e:
                logger.error(f"Exit {leg} error (attempt {attempt}/{attempts}): {e}")
                oid = None
            if oid and self.helper.wait_for_fill(oid, timeout=5):
                return True
            logger.warning(f"Exit attempt {attempt}/{attempts} failed for {leg} (ID: {sid}, order_id={oid}).")
            if attempt < attempts:
                time.sleep(1)
        return False

    def _exit_straddle(self, reason: str) -> bool:
        """
        Attempt to close both legs. Returns True only if both legs are confirmed closed.
        On partial failure, the successfully-closed leg is marked so it isn't re-submitted;
        in_position stays True so the caller retries the remaining leg on the next tick.
        """
        logger.warning(f"EXITING straddle: {reason}")
        qty = self.lots * self.lot_size
        ce_ltp = self._ltp(self.ce_id) or self.ce_avg
        pe_ltp = self._ltp(self.pe_id) or self.pe_avg

        if not self.dry_run:
            for leg, sid, attr in [("CE", self.ce_id, "ce_closed"), ("PE", self.pe_id, "pe_closed")]:
                if getattr(self, attr):
                    continue
                if self._close_leg_with_retry(sid, qty, leg):
                    setattr(self, attr, True)
                else:
                    logger.critical(
                        f"Exit order FAILED for {leg} (ID: {sid}) after {EXIT_RETRY_ATTEMPTS} attempts! "
                        "Leg remains OPEN in the market -- will retry again next tick."
                    )
        else:
            self.ce_closed = True
            self.pe_closed = True
            logger.info(f"[DRY RUN] BUY-TO-COVER | CE @ {ce_ltp:.2f} | PE @ {pe_ltp:.2f}")

        if not (self.ce_closed and self.pe_closed):
            return False

        realized = (self.ce_avg - ce_ltp) * qty + (self.pe_avg - pe_ltp) * qty
        self.realized_pnl += realized
        if realized < 0:
            self._cooldown_until = time.time() + self.cooldown_seconds
        logger.info(
            f"Exit PnL this cycle: {realized:.2f} | Session realized: {self.realized_pnl:.2f}"
        )
        self._reset_position()
        return True

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
        self._reset_indicators()

        self._subscribe(ce_id, pe_id)
        self.cycle_count += 1

        logger.info("Fetching initial 1-min candles to bootstrap VWAP/Supertrend...")
        self._refresh_indicators()
        self._last_candle_minute = datetime.now().strftime("%H:%M")

        logger.info(
            f"ATM Cycle {self.cycle_count}: {atm} CE (ID:{ce_id}) @ {ce_ltp:.2f}"
            f" | PE (ID:{pe_id}) @ {pe_ltp:.2f}"
            f" | Initial VWAP={self.candle_vwap:.2f} ({self.vwap_bars} bars)"
        )
        return ce_id, pe_id, ce_ltp, pe_ltp

    # ── main loop ────────────────────────────────────────────────────────────

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(
            f"NiftyVixStraddle START | dry_run={self.dry_run} | lots={self.lots}"
            f" | straddle_ST({self.st_period},{self.st_multiplier})@{self.st_interval}m"
            f" | vix_ST({self.vix_st_period},{self.vix_st_multiplier})@{self.vix_st_interval}m"
            f" | exit_buffer={self.exit_buffer}pts"
            f" | max_diff={self.max_premium_diff_pct}%"
            f" | warmup={self.vwap_warmup_bars} 1-min bars"
            f" | max_loss_per_trade={self.max_loss_per_trade} | max_trades_per_day={self.max_trades_per_day}"
            f" | cooldown={self.cooldown_seconds}s | max_spread={self.max_spread_pct}%"
        )

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("Shutdown trigger in outer loop.")
                self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
                sys.exit(0)

            self._save_state(0, 0, 0, self.realized_pnl, "INITIALIZING")
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time="15:17", shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY))

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
            last_cap_log_time = 0.0
            last_cooldown_log_time = 0.0
            pending_atm: int = 0

            # ── Inner monitoring loop ──────────────────────────────────────────
            while True:
                if check_shutdown_trigger(STRATEGY_KEY):
                    ce_p = self._ltp(ce_id) or ce_ltp
                    pe_p = self._ltp(pe_id) or pe_ltp
                    if self.in_position:
                        if not self._exit_straddle("UI Shutdown Request"):
                            logger.critical(
                                "Shutdown requested but exit did not fully confirm -- "
                                "a leg may remain OPEN in the market!"
                            )
                    self._save_state(spot, ce_p, pe_p, self.realized_pnl, "STOPPED")
                    sys.exit(0)

                now = datetime.now()
                if now.strftime("%H:%M") >= "15:17":
                    if self.in_position:
                        if not self._exit_straddle("Intraday Auto-Exit 15:17"):
                            time.sleep(1)
                            continue
                    logger.info("Session ended at 15:17. Waiting for next day.")
                    self._unsubscribe(ce_id, pe_id)
                    self._reset_position()
                    break

                # ── Refresh VWAP + Supertrends on each new minute ─────────────
                self._maybe_refresh_indicators()

                # ── Fetch WebSocket LTP ───────────────────────────────────────
                ce_ltp = self._ltp(ce_id)
                pe_ltp = self._ltp(pe_id)
                if ce_ltp <= 0 or pe_ltp <= 0:
                    time.sleep(1)
                    continue

                combined = ce_ltp + pe_ltp

                spot = self._nifty_spot() or spot
                total_pnl = self._total_pnl(ce_ltp, pe_ltp)
                self._save_state(
                    spot, ce_ltp, pe_ltp, total_pnl,
                    "RUNNING" if self.in_position else "MONITORING",
                )

                # ── ATM shift detection ───────────────────────────────────────
                current_atm = self._atm(spot)
                if current_atm != last_atm:
                    if self.in_position:
                        if current_atm != pending_atm:
                            logger.info(
                                f"ATM shifted to {current_atm} (spot {spot:.2f}) while in position. "
                                "Holding until exit, then re-centering."
                            )
                            pending_atm = current_atm
                    else:
                        logger.info(
                            f"ATM shifted: {last_atm} -> {current_atm} (spot {spot:.2f}). Re-centering."
                        )
                        self._unsubscribe(ce_id, pe_id)
                        result = self._setup_atm_cycle(spot)
                        if result is None:
                            time.sleep(30)
                            break
                        ce_id, pe_id, ce_ltp, pe_ltp = result
                        last_atm = current_atm
                        pending_atm = 0
                        time.sleep(1)
                        continue

                # ── Global P&L guards ─────────────────────────────────────────
                # profit_target/stop_loss stay None in percentage mode until the first
                # entry resolves them against actual entry premium -- skip the guard
                # until then (total_pnl is always 0 while flat anyway, so there is
                # nothing to guard against yet).
                if self.profit_target is not None and total_pnl >= self.profit_target:
                    if self.in_position:
                        if not self._exit_straddle(f"Global Profit Target hit: {total_pnl:.2f}"):
                            time.sleep(1)
                            continue
                    logger.info("Profit target reached. Waiting for next session.")
                    self._unsubscribe(ce_id, pe_id)
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)):
                        self._save_state(0, 0, 0, self.realized_pnl, "STOPPED")
                        sys.exit(0)
                    self._reset_position()
                    break

                if self.stop_loss is not None and total_pnl <= self.stop_loss:
                    if self.in_position:
                        if not self._exit_straddle(f"Global Stop Loss hit: {total_pnl:.2f}"):
                            time.sleep(1)
                            continue
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
                    vwap_gap = combined - self.candle_vwap if self._vwap_ready() else float("nan")
                    unrealized = self._unrealized_pnl(ce_ltp, pe_ltp)
                    vwap_status = (
                        f"{self.candle_vwap:.2f} ({self.vwap_bars} bars)"
                        if self._vwap_ready()
                        else f"warming ({self.vwap_bars}/{self.vwap_warmup_bars} bars)"
                    )
                    pos_label = "[IN] " if self.in_position else "[OUT]"
                    entry_info = f" entry={self.entry_combined:.2f}" if self.in_position else ""
                    logger.info(
                        f"{pos_label} ATM:{self.ce_strike}"
                        f" | CE:{ce_ltp:.2f} PE:{pe_ltp:.2f}"
                        f" | Combined:{combined:.2f}{entry_info}"
                        f" | VWAP:{vwap_status} gap={vwap_gap:+.2f}"
                        f" | Straddle ST dir={self.straddle_st_dir} | VIX:{self.vix_ltp:.2f} ST dir={self.vix_st_dir}"
                        f" | Diff:{diff_pct:.1f}%"
                        f" | PnL real={self.realized_pnl:+.0f}"
                        f" unreal={unrealized:+.0f}"
                        f" total={total_pnl:+.0f}"
                    )
                    last_log_time = now_ts

                # ── State-machine logic ───────────────────────────────────────
                if self.in_position:
                    unrealized = self._unrealized_pnl(ce_ltp, pe_ltp)
                    # Hard per-trade stop-loss, independent of VWAP drift
                    if self.max_loss_per_trade > 0 and unrealized <= -self.max_loss_per_trade:
                        self._exit_straddle(
                            f"Per-trade stop-loss hit: unrealized {unrealized:.2f} <= "
                            f"-{self.max_loss_per_trade:.2f}"
                        )
                    # Exit when India VIX crosses back above its own Supertrend
                    elif self.vix_st_dir == 1:
                        self._exit_straddle(
                            f"India VIX ({self.vix_ltp:.2f}) crossed above its Supertrend "
                            f"({self.vix_st_period},{self.vix_st_multiplier})@{self.vix_st_interval}m"
                        )
                    # Exit when combined premium rises above VWAP + exit_buffer
                    elif self._vwap_ready() and combined > self.candle_vwap + self.exit_buffer:
                        self._exit_straddle(
                            f"Combined {combined:.2f} > VWAP({self.candle_vwap:.2f})"
                            f" + buffer({self.exit_buffer})"
                        )
                else:
                    if not self._vwap_ready():
                        time.sleep(1)
                        continue

                    if self.max_trades_per_day > 0 and self.trade_count >= self.max_trades_per_day:
                        if now_ts - last_cap_log_time >= 30:
                            logger.info(
                                f"Daily trade cap reached ({self.trade_count}/{self.max_trades_per_day}). "
                                "No further entries today."
                            )
                            last_cap_log_time = now_ts
                        time.sleep(1)
                        continue

                    if time.time() < self._cooldown_until:
                        remaining = int(self._cooldown_until - time.time())
                        if now_ts - last_cooldown_log_time >= 15:
                            logger.info(f"In post-loss cooldown for {remaining}s more. Skipping entry checks.")
                            last_cooldown_log_time = now_ts
                        time.sleep(1)
                        continue

                    diff_pct = (
                        abs(ce_ltp - pe_ltp) / max(ce_ltp, pe_ltp) * 100
                        if max(ce_ltp, pe_ltp) > 0 else 100.0
                    )
                    price_ok = combined <= self.candle_vwap
                    straddle_st_ok = self.straddle_st_dir == -1
                    # Require the VIX Supertrend reading to be from *today's* session --
                    # if VIX candle fetches have been failing all day (e.g. a data API
                    # outage) while option candles keep succeeding, don't trade on a
                    # leftover direction from a prior session.
                    vix_st_ok = self.vix_st_dir == -1 and self._vix_data_date == datetime.now().strftime("%Y-%m-%d")
                    diff_ok = diff_pct < self.max_premium_diff_pct

                    if price_ok and straddle_st_ok and vix_st_ok and diff_ok:
                        if not self._spread_ok(ce_id, pe_id):
                            logger.info("Entry gates passed but bid-ask spread too wide; skipping entry.")
                        else:
                            logger.info(
                                f"Entry signal: combined {combined:.2f} <= VWAP {self.candle_vwap:.2f}"
                                f" | straddle ST dir={self.straddle_st_dir} (below ST)"
                                f" | VIX {self.vix_ltp:.2f} ST dir={self.vix_st_dir} (below ST)"
                                f" | diff {diff_pct:.1f}% < {self.max_premium_diff_pct}%"
                            )
                            success = self._enter_straddle(ce_id, pe_id, ce_ltp, pe_ltp)
                            if not success:
                                logger.warning("Entry failed; will retry next tick.")
                    elif not vix_st_ok:
                        logger.debug(f"VIX not below its own Supertrend (dir={self.vix_st_dir}). Waiting.")
                    elif not straddle_st_ok:
                        logger.debug(f"Straddle premium not below its own Supertrend (dir={self.straddle_st_dir}). Waiting.")
                    elif price_ok and not diff_ok:
                        logger.debug(
                            f"Price & Supertrend gates OK but diff {diff_pct:.1f}% >= {self.max_premium_diff_pct}%. Waiting."
                        )

                time.sleep(1)


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty VIX-Filtered Straddle Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default)
  python strategies/value_imbalance/nifty_vix_straddle.py

  # Live, 2 lots, tighter exit buffer
  python strategies/value_imbalance/nifty_vix_straddle.py --live --lots 2 --exit-buffer 3

  # Custom Supertrend settings for straddle and VIX
  python strategies/value_imbalance/nifty_vix_straddle.py --st-period 14 --st-multiplier 3 --vix-st-period 7 --vix-st-multiplier 1.5
""",
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Place real orders (default: dry run)")
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Lots per leg (default: 1)")
    parser.add_argument("--start-time", type=str, default="09:20", metavar="HH:MM",
                        help="Session start time IST (default: 09:20)")
    parser.add_argument("--st-period", type=int, default=10, metavar="N",
                        help="Straddle premium Supertrend period (default: 10)")
    parser.add_argument("--st-multiplier", type=float, default=2.0, metavar="F",
                        help="Straddle premium Supertrend multiplier (default: 2.0)")
    parser.add_argument("--st-interval", type=str, default="3", metavar="MIN",
                        help="Straddle Supertrend candle interval in minutes, resampled from 1-min bars (default: 3)")
    parser.add_argument("--vix-st-period", type=int, default=10, metavar="N",
                        help="India VIX Supertrend period (default: 10)")
    parser.add_argument("--vix-st-multiplier", type=float, default=2.0, metavar="F",
                        help="India VIX Supertrend multiplier (default: 2.0)")
    parser.add_argument("--vix-st-interval", type=str, default="3", metavar="MIN",
                        help="India VIX Supertrend candle interval in minutes, resampled from 1-min bars (default: 3)")
    parser.add_argument("--exit-buffer", type=float, default=5.0, metavar="PTS",
                        help="Points above VWAP that trigger exit (default: 5)")
    parser.add_argument("--max-premium-diff", type=float, default=15.0, metavar="PCT",
                        help="Max CE/PE premium difference %% for entry (default: 15)")
    parser.add_argument("--vwap-warmup-bars", type=int, default=10, metavar="N",
                        help="Min completed 1-min bars before VWAP is trusted (default: 10 ~= 10 min)")
    parser.add_argument("--target-profit", type=str, default="4000", metavar="INR",
                        help="Global profit target in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")
    parser.add_argument("--stop-loss", type=str, default="4000", metavar="INR",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")
    parser.add_argument("--max-loss-per-trade", type=float, default=1500.0, metavar="INR",
                        help="Hard stop-loss per cycle, independent of VWAP/Supertrend (default: 1500, 0=disabled)")
    parser.add_argument("--max-trades-per-day", type=int, default=15, metavar="N",
                        help="Max entries per session (default: 15, 0=unlimited)")
    parser.add_argument("--cooldown-seconds", type=int, default=90, metavar="N",
                        help="Pause entries for N seconds after a losing cycle (default: 90)")
    parser.add_argument("--max-spread-pct", type=float, default=8.0, metavar="PCT",
                        help="Max bid-ask spread %% per leg to allow entry (default: 8, 0=disabled)")

    args = parser.parse_args()

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    logger.info(
        f"Config | mode={'LIVE' if args.live else 'DRY'} lots={args.lots}"
        f" start={args.start_time}"
        f" straddle_ST({args.st_period},{args.st_multiplier})@{args.st_interval}m"
        f" vix_ST({args.vix_st_period},{args.vix_st_multiplier})@{args.vix_st_interval}m"
        f" exit_buffer={args.exit_buffer}pts"
        f" max_diff={args.max_premium_diff}% warmup={args.vwap_warmup_bars} bars"
        f" profit={target_val}{'%' if target_is_pct else ''} sl={stop_val}{'%' if stop_is_pct else ''}"
        f" max_loss_per_trade={args.max_loss_per_trade} max_trades_per_day={args.max_trades_per_day}"
        f" cooldown={args.cooldown_seconds}s max_spread={args.max_spread_pct}%"
    )

    try:
        strategy = NiftyVixStraddle(
            dry_run=not args.live,
            lots=args.lots,
            start_time=args.start_time,
            st_period=args.st_period,
            st_multiplier=args.st_multiplier,
            st_interval=args.st_interval,
            vix_st_period=args.vix_st_period,
            vix_st_multiplier=args.vix_st_multiplier,
            vix_st_interval=args.vix_st_interval,
            exit_buffer=args.exit_buffer,
            max_premium_diff_pct=args.max_premium_diff,
            vwap_warmup_bars=args.vwap_warmup_bars,
            profit_target=target_val,
            profit_target_is_pct=target_is_pct,
            stop_loss=stop_val,
            stop_loss_is_pct=stop_is_pct,
            max_loss_per_trade=args.max_loss_per_trade,
            max_trades_per_day=args.max_trades_per_day,
            cooldown_seconds=args.cooldown_seconds,
            max_spread_pct=args.max_spread_pct,
        )
    except Exception as init_err:
        logger.critical(f"Strategy initialisation failed: {init_err}", exc_info=True)
        sys.exit(1)

    try:
        strategy.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt -- squaring off all positions...")
        if strategy.in_position:
            strategy._exit_straddle("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
