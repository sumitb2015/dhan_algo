import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime, timedelta
from typing import Optional, Tuple

# Adjust path to parent dir
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec, instance_log_suffix

STRATEGY_KEY = "nifty_st_oi_bearcall"

# Configure Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "st_oi_bearcall")
os.makedirs(log_dir, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        # encoding is REQUIRED: this file logs P&L with the ₹ glyph, and FileHandler
        # otherwise opens with the system ANSI codepage (cp1252 on Windows). Every line
        # containing ₹ then fails to encode and is silently dropped from the log while
        # the ASCII lines around it are written — so the log looks intact but the P&L
        # lines are missing exactly when you need them.
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        )
    ],
    force=True
)
logger = logging.getLogger(__name__)


class NiftySTOIBearCallStrategy:
    """
    Bear Call Spread entered only when three bearish confirmations align:
      1. The index's own 3-min chart is below Supertrend(index_st_period, index_st_multiplier).
      2. The candidate OTM CE's own 3-min chart is also below its Supertrend
         (option_st_period, option_st_multiplier) -- checked only after #1 holds; if not yet
         true we keep polling rather than entering.
      3. The index is re-confirmed bearish at the moment the option's Supertrend flips (time has
         passed while waiting).
      4. (Optional, off by default) The candidate CE shows a short buildup: price down + OI up
         vs previous day's close/OI. Enable with --require-short-buildup; when disabled, entry
         proceeds as soon as #1-#3 hold.

    State machine: IDLE -> WATCHING -> ENTERED -> (exit) -> IDLE.
    Dhan's intraday API only supports 1/5/15/25/60-minute candles, so the "3-minute" chart is
    built by fetching 1-minute candles and resampling with pandas before computing Supertrend.
    """

    def __init__(self, dry_run=True, symbol="NIFTY",
                 index_interval="3", index_st_period=10, index_st_multiplier=2.0,
                 option_interval="3", option_st_period=10, option_st_multiplier=2.0,
                 ce_offset=100, spread_width=100,
                 require_short_buildup=False, min_price_drop_pct=-0.5, min_oi_rise_pct=5.0,
                 poll_interval=30, max_wait_minutes=45,
                 lots=1, target_profit=2000.0, target_profit_is_pct=False,
                 stop_loss=2000.0, stop_loss_is_pct=False,
                 exit_on_signal_flip=True, exit_on_option_st_flip=True,
                 eod_time="15:15", cooldown_minutes=5, min_hold_minutes=5,
                 product_type="INTRADAY", broker="dhan"):
        self.dry_run = dry_run
        self.symbol = symbol.upper()
        self.index_interval = index_interval
        self.index_st_period = index_st_period
        self.index_st_multiplier = float(index_st_multiplier)
        self.option_interval = option_interval
        self.option_st_period = option_st_period
        self.option_st_multiplier = float(option_st_multiplier)
        self.ce_offset = ce_offset
        self.spread_width = spread_width
        self.require_short_buildup = require_short_buildup
        self.min_price_drop_pct = min_price_drop_pct
        self.min_oi_rise_pct = min_oi_rise_pct
        self.poll_interval = poll_interval
        self.max_wait_minutes = max_wait_minutes
        self.lots = lots
        # Target/SL may be an absolute INR amount or a percentage of entry net
        # credit (resolved once the position is actually entered, see below).
        self.target_is_pct = target_profit_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = target_profit if target_profit_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.target_profit = None if target_profit_is_pct else target_profit
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure SL is a negative number
        self.exit_on_signal_flip = exit_on_signal_flip
        self.exit_on_option_st_flip = exit_on_option_st_flip
        self.eod_time = eod_time
        self.cooldown_minutes = cooldown_minutes
        self.min_hold_minutes = min_hold_minutes
        self.product_type = product_type

        # Sanity checks (log-only; don't block startup) -----------------------
        try:
            option_interval_min = int(self.option_interval)
        except ValueError:
            option_interval_min = 3
        required_warmup_minutes = (self.option_st_period + 2) * option_interval_min
        if self.max_wait_minutes < required_warmup_minutes:
            logger.warning(
                f"--max-wait-minutes ({self.max_wait_minutes}) is less than the ~{required_warmup_minutes} minutes "
                f"of same-day candles needed before the candidate option's own Supertrend({self.option_st_period},"
                f"{self.option_st_multiplier}) can be computed (candles are session-filtered to today only). "
                f"A bearish index signal near market open may always time out in WATCHING before the option ST is "
                f"ready. Consider raising --max-wait-minutes to at least {required_warmup_minutes} or lowering "
                f"--option-st-period."
            )
        if self.require_short_buildup and self.min_price_drop_pct > 0:
            logger.warning(
                f"--min-price-drop-pct is {self.min_price_drop_pct} (positive). The short-buildup check requires "
                f"ce_price_change_pct <= min_price_drop_pct, so a positive threshold will almost always pass and "
                f"effectively disables the intended filter. Did you mean a negative value (e.g. -{self.min_price_drop_pct})?"
            )

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

        self.broker_name = broker
        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying=self.symbol, log=logger.info)
        except ExecutionBrokerError as e:
            raise RuntimeError(f"Could not start {broker} execution: {e}") from e

        # Dynamic strike rounding step
        self.strike_step = 100 if self.symbol == "BANKNIFTY" else 50

        # Start websocket for spot index
        logger.info(f"Resolving symbol ID for {self.symbol}...")
        sec_info = self.helper.get_index_id(self.symbol)
        if not sec_info:
            sec_info = self.helper.get_security_id(self.symbol, instrument="INDEX")
        if not sec_info:
            raise Exception(f"Could not resolve index security ID for {self.symbol}")

        self.index_security_id = str(sec_info['SECURITY_ID'])
        self.index_segment = self.helper._auto_detect_segment(sec_info)

        logger.info(f"Starting WebSocket for {self.symbol} (ID: {self.index_security_id}, Segment: {self.index_segment})...")
        self.helper.start_websocket([(self.index_segment, self.index_security_id, 15)])
        time.sleep(2)

        self.lot_size = self.helper.get_lot_size(self.symbol)
        logger.info(f"Symbol: {self.symbol} | Index ID: {self.index_security_id} | Lot Size: {self.lot_size}")

        # Phase state machine: IDLE -> WATCHING -> ENTERED
        self.phase = "IDLE"
        self.expiry = None

        # WATCHING-phase candidate tracking
        self.candidate_strike: Optional[int] = None
        self.candidate_id = None
        self.candidate_symbol = None
        self.watching_since: Optional[datetime] = None
        self.index_st_dir: Optional[float] = None
        self.option_st_dir: Optional[float] = None
        self.last_ce_price_change_pct: Optional[float] = None
        self.last_ce_oi_change_pct: Optional[float] = None

        # ENTERED-phase position state
        self.short_id = None
        self.short_strike = None
        self.short_symbol = None
        self.short_entry_price = 0.0
        self.long_id = None
        self.long_strike = None
        self.long_symbol = None
        self.long_entry_price = 0.0
        self.entry_time: Optional[datetime] = None

        self.last_close_time: Optional[datetime] = None  # cooldown tracker

        # Session-cumulative realized P&L across all closed spreads. --target-profit /
        # --stop-loss are documented as DAILY caps, so they must be evaluated against
        # realized + open, not against the current spread alone — otherwise the same
        # "daily" stop can be hit an unlimited number of times in one session.
        self.realized_pnl = 0.0

    # --- Candle fetch helpers ------------------------------------------------

    def _get_index_candles(self) -> pd.DataFrame:
        return self.helper.get_latest_candles(self.symbol, interval="1", days=5)

    def _fetch_option_candles(self, security_id: str) -> pd.DataFrame:
        """Fetch 1-min intraday candles for an option contract, normalised and filtered to today's session."""
        try:
            today = datetime.now().date()
            from_date = (today - timedelta(days=2)).isoformat()
            to_date = today.isoformat()

            raw = self.helper.get_intraday_minute_data(
                security_id=security_id,
                exchange_segment="NSE_FNO",
                instrument_type="OPTIDX",
                interval="1",
                from_date=from_date,
                to_date=to_date,
            )
            if raw.empty:
                return pd.DataFrame()

            rename_map = {
                "start_time": "Datetime", "start_Time": "Datetime",
                "kline_time": "Datetime", "timestamp": "Datetime",
                "open": "Open", "high": "High", "low": "Low",
                "close": "Close", "volume": "Volume",
            }
            new_map = {c: rename_map[c.lower()] for c in raw.columns if c.lower() in rename_map}
            df = raw.rename(columns=new_map)
            df = df[[c for c in ["Datetime", "Open", "High", "Low", "Close", "Volume"] if c in df.columns]]

            if "Datetime" in df.columns:
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

            today_mask = df.index.date == today
            session_mask = df.index.strftime("%H:%M") >= "09:15"
            return df[today_mask & session_mask]

        except Exception as e:
            logger.error(f"Error fetching option candles for {security_id}: {e}")
            return pd.DataFrame()

    def _resample_and_supertrend(self, candles_1m: pd.DataFrame, st_period: int, st_multiplier: float,
                                  interval_minutes: str) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Resample 1-min OHLC candles to `interval_minutes`-min bars (Dhan's intraday API only
        supports 1/5/15/25/60m natively) and compute Supertrend on the resampled series.
        Returns (direction, level, close) from the last COMPLETED bar, or (None, None, None).
        """
        if candles_1m.empty:
            return None, None, None
        try:
            resample_rule = f"{interval_minutes}min"
            agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
            df = candles_1m.resample(resample_rule).agg(agg).dropna(subset=["Close"])
            if len(df) < st_period + 2:
                return None, None, None

            st_ind = [{"kind": "supertrend", "length": st_period, "multiplier": st_multiplier}]
            df_ta = self.helper.calculate_ta_indicators(df.copy(), st_ind)

            dir_cols = [c for c in df_ta.columns if c.startswith("SUPERTd_")]
            level_cols = [
                c for c in df_ta.columns
                if c.startswith("SUPERT_") and not any(c.startswith(p) for p in ("SUPERTd_", "SUPERTl_", "SUPERTs_"))
            ]
            if not dir_cols or not level_cols:
                return None, None, None

            row = df_ta.iloc[-2]  # last completed bar (last row may still be forming)
            direction = float(row[dir_cols[0]])
            level = float(row[level_cols[0]])
            close = float(row["Close"])
            if pd.isna(direction) or pd.isna(level):
                return None, None, None
            return direction, level, close
        except Exception as e:
            logger.error(f"Supertrend resample error: {e}")
            return None, None, None

    def _check_index_bearish(self) -> Tuple[bool, Optional[float], Optional[float]]:
        df = self._get_index_candles()
        if df.empty:
            return False, None, None
        direction, level, close = self._resample_and_supertrend(
            df, self.index_st_period, self.index_st_multiplier, self.index_interval
        )
        self.index_st_dir = direction
        return (direction == -1), level, close

    def _check_option_bearish(self, security_id: str) -> Tuple[bool, Optional[float], Optional[float]]:
        df = self._fetch_option_candles(security_id)
        if df.empty:
            return False, None, None
        direction, level, close = self._resample_and_supertrend(
            df, self.option_st_period, self.option_st_multiplier, self.option_interval
        )
        self.option_st_dir = direction
        return (direction == -1), level, close

    # --- Quote helpers (mirrors strategies/spread_trend) ---------------------

    def is_quote_invalid(self, q):
        if not q:
            return True
        if not isinstance(q, dict) or 'CONTRACT_INFO' not in q:
            return True
        return float(q.get('last_price', 0) or q.get('LTP', 0)) == 0

    def _extract_quote_fields(self, quote, strike, option_type):
        if not quote:
            return None, 0.0, None, self.lot_size, None
        if isinstance(quote, dict) and 'CONTRACT_INFO' in quote:
            ci = quote['CONTRACT_INFO']
            return (
                int(ci['SECURITY_ID']),
                float(quote.get('last_price', 0.0) or quote.get('LTP', 0.0)),
                ci.get('SM_EXPIRY_DATE') or self.expiry,
                int(ci.get('LOT_SIZE', self.lot_size)),
                ci.get('SYMBOL_NAME', f"{self.symbol}-{strike}-{option_type}")
            )
        return None, 0.0, None, self.lot_size, None

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        if not order_id:
            return fallback_price
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(
                    order_details.get('averageTradedPrice', 0.0)
                    or order_details.get('avgFilledPrice', 0.0)
                    or order_details.get('price', 0.0)
                )
                if fill_price > 0:
                    logger.info(f"Order {order_id} execution price confirmed: {fill_price:.2f}")
                    return fill_price
        return fallback_price

    def fetch_ltps(self):
        ltps = self.helper.get_ltps([
            ("NSE_FNO", self.short_id),
            ("NSE_FNO", self.long_id),
            (self.index_segment, self.index_security_id),
        ])
        return (
            ltps.get(str(self.short_id), 0.0),
            ltps.get(str(self.long_id), 0.0),
            ltps.get(str(self.index_security_id), 0.0),
        )

    # --- State bridge ----------------------------------------------------------

    def save_state(self, status="RUNNING", spot=0.0, short_ltp=0.0, long_ltp=0.0, total_pnl=0.0):
        state_dict = {
            "strategy": STRATEGY_KEY,
            "status": status,
            "dry_run": self.dry_run,
            "symbol": self.symbol,
            "phase": self.phase,
            "index_interval": self.index_interval,
            "option_interval": self.option_interval,
            "index_st_period": self.index_st_period,
            "index_st_multiplier": self.index_st_multiplier,
            "option_st_period": self.option_st_period,
            "option_st_multiplier": self.option_st_multiplier,
            "candidate_strike": self.candidate_strike,
            "candidate_symbol": self.candidate_symbol,
            "watching_since": self.watching_since.strftime("%H:%M:%S") if self.watching_since else None,
            "index_st_dir": self.index_st_dir,
            "option_st_dir": self.option_st_dir,
            "require_short_buildup": self.require_short_buildup,
            "ce_price_change_pct": round(self.last_ce_price_change_pct, 2) if self.last_ce_price_change_pct is not None else None,
            "ce_oi_change_pct": round(self.last_ce_oi_change_pct, 2) if self.last_ce_oi_change_pct is not None else None,
            "min_price_drop_pct": self.min_price_drop_pct,
            "min_oi_rise_pct": self.min_oi_rise_pct,
            "lots": self.lots,
            "short_strike": self.short_strike,
            "long_strike": self.long_strike,
            "short_symbol": self.short_symbol,
            "long_symbol": self.long_symbol,
            "short_entry_price": self.short_entry_price,
            "long_entry_price": self.long_entry_price,
            "short_ltp": short_ltp,
            "long_ltp": long_ltp,
            "realized_pnl": round(self.realized_pnl, 2),
            "total_pnl": total_pnl,
            "spot": spot,
            "profit_target": self.target_profit,
            "stop_loss": self.stop_loss,
            "eod_time": self.eod_time,
            "broker": self.broker_name,
        }
        save_strategy_state(STRATEGY_KEY, state_dict)

    # --- WATCHING phase ----------------------------------------------------------

    def _enter_watching(self, spot: float):
        self.expiry = self.helper.get_nearest_expiry(self.symbol)
        if not self.expiry:
            logger.error("Could not determine nearest expiry date. Staying IDLE.")
            return

        atm_strike = int(round(spot / self.strike_step) * self.strike_step)
        candidate_strike = int(round((atm_strike + self.ce_offset) / self.strike_step) * self.strike_step)

        quote = self.helper.option(self.symbol, candidate_strike, "CE")
        if self.is_quote_invalid(quote):
            logger.warning(f"Invalid quote for candidate strike {candidate_strike}CE. Staying IDLE.")
            return

        cid, _, _, _, csym = self._extract_quote_fields(quote, candidate_strike, "CE")
        if not cid:
            logger.warning("Failed to extract candidate security id. Staying IDLE.")
            return

        self.candidate_strike = candidate_strike
        self.candidate_id = cid
        self.candidate_symbol = csym
        self.watching_since = datetime.now()
        self.phase = "WATCHING"
        logger.info(
            f"Index bearish (Spot {spot:.2f}, ATM {atm_strike}). "
            f"Watching candidate {csym} (Strike {candidate_strike}CE) for its own Supertrend + short-buildup confirmation."
        )

    def _abandon_watch(self, reason: str):
        logger.info(f"Abandoning watch cycle on {self.candidate_symbol}: {reason}")
        self.phase = "IDLE"
        self.candidate_strike = None
        self.candidate_id = None
        self.candidate_symbol = None
        self.watching_since = None
        # Clear candidate-specific readings so the dashboard doesn't show a stale
        # signal from this abandoned candidate once a new one is picked.
        self.option_st_dir = None
        self.last_ce_price_change_pct = None
        self.last_ce_oi_change_pct = None
        self.last_close_time = datetime.now()

    def _watching_tick(self):
        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        bearish, _, spot_close = self._check_index_bearish()
        if not bearish:
            self._abandon_watch("Index flipped bullish/neutral while watching.")
            return

        elapsed_min = (datetime.now() - self.watching_since).total_seconds() / 60.0
        if elapsed_min > self.max_wait_minutes:
            self._abandon_watch(f"Max wait ({self.max_wait_minutes}m) exceeded without entry.")
            return

        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        option_bearish, _, _ = self._check_option_bearish(str(self.candidate_id))
        self.save_state(status="WATCHING", spot=spot_close or 0.0)
        if not option_bearish:
            logger.info(f"[WATCHING] {self.candidate_symbol} not yet below its own Supertrend. Waiting...")
            return

        # Re-confirm index is STILL bearish right before acting (time has passed while waiting)
        bearish_recheck, _, spot_close = self._check_index_bearish()
        if not bearish_recheck:
            self._abandon_watch("Index flipped just as option Supertrend turned bearish.")
            return

        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        if not self.require_short_buildup:
            logger.info(
                f"Short-buildup filter disabled. Entering Bear Call Spread on {self.candidate_symbol} "
                f"(index + option Supertrend confirmed bearish)."
            )
            self.enter_spread(spot_close, self.candidate_strike)
            return

        chain_df = self.helper.get_option_chain_df(self.symbol, self.expiry)
        if chain_df.empty or self.candidate_strike not in chain_df.index:
            logger.warning("Option chain snapshot unavailable for short-buildup check. Continue watching.")
            return

        row = chain_df.loc[self.candidate_strike]
        price_chg = float(row.get("ce_price_change_pct", 0.0) or 0.0)
        oi_chg = float(row.get("ce_oi_change_pct", 0.0) or 0.0)
        self.last_ce_price_change_pct = price_chg
        self.last_ce_oi_change_pct = oi_chg

        if price_chg <= self.min_price_drop_pct and oi_chg >= self.min_oi_rise_pct:
            logger.info(
                f"Short buildup confirmed on {self.candidate_symbol}: "
                f"price {price_chg:.2f}% (<= {self.min_price_drop_pct}%), OI {oi_chg:+.2f}% (>= {self.min_oi_rise_pct}%). "
                f"Entering Bear Call Spread."
            )
            self.enter_spread(spot_close, self.candidate_strike)
        else:
            logger.info(
                f"[WATCHING] {self.candidate_symbol} Supertrend bearish but short-buildup not yet confirmed "
                f"(price {price_chg:.2f}% / OI {oi_chg:+.2f}%). Continue watching."
            )

    # --- Entry / Exit --------------------------------------------------------

    def enter_spread(self, spot: float, short_strike: int):
        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        long_strike = int(round((short_strike + self.spread_width) / self.strike_step) * self.strike_step)
        logger.info(f"Spread Strike Selection -> Short Strike: {short_strike} | Long Strike: {long_strike}")

        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        short_quote = self.helper.option(self.symbol, short_strike, "CE")
        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)
        long_quote = self.helper.option(self.symbol, long_strike, "CE")
        if check_shutdown_trigger(STRATEGY_KEY):
            self.save_state(status="STOPPED")
            sys.exit(0)

        if self.is_quote_invalid(short_quote) or self.is_quote_invalid(long_quote):
            logger.error(f"Failed to fetch valid quotes for spread legs. Short: {short_strike}CE, Long: {long_strike}CE. Staying WATCHING.")
            return

        self.short_id, self.short_entry_price, _, _, self.short_symbol = \
            self._extract_quote_fields(short_quote, short_strike, "CE")
        self.long_id, self.long_entry_price, _, _, self.long_symbol = \
            self._extract_quote_fields(long_quote, long_strike, "CE")

        if not self.short_id or not self.long_id:
            logger.error("Failed to extract security IDs from quotes. Staying WATCHING.")
            return

        self.short_strike = short_strike
        self.long_strike = long_strike
        total_qty = self.lot_size * self.lots
        logger.info(f"Entry Quotes -> Short: {self.short_symbol} (ID: {self.short_id}) @ {self.short_entry_price:.2f}")
        logger.info(f"Entry Quotes -> Long: {self.long_symbol} (ID: {self.long_id}) @ {self.long_entry_price:.2f}")
        logger.info(f"Expected Spread Credit: {self.short_entry_price - self.long_entry_price:.2f} points | Total Qty: {total_qty} ({self.lots} lots)")

        logger.info(f"Subscribing to WebSocket for options: {self.short_symbol} & {self.long_symbol}")
        try:
            self.helper.subscribe_instruments([
                ("NSE_FNO", str(self.short_id), 15),
                ("NSE_FNO", str(self.long_id), 15)
            ])
            time.sleep(2)
        except Exception as e:
            logger.error(f"WebSocket subscription failed: {e}")

        if not self.dry_run:
            logger.info("PLACING LIVE ENTRY ORDERS...")
            # 1. Buy Long Leg (Hedge) first
            long_oid = self.broker.buy(self.long_strike, self.expiry, "CE", total_qty, product=self.product_type)
            if not long_oid:
                logger.error("Failed to place Buy (Long Hedge) order. Aborting entry.")
                self._reset_position_state()
                return

            self.long_entry_price = self.get_execution_price(long_oid, 0.0)
            if self.long_entry_price == 0.0:
                logger.error("Long Hedge order was not filled within timeout. Cancelling order and aborting entry.")
                try:
                    self.helper.cancel_order(long_oid)
                except Exception as cancel_err:
                    logger.error(f"Failed to cancel unfilled Long Hedge order: {cancel_err}")
                self._reset_position_state()
                return

            # 2. Sell Short Leg
            short_oid = self.broker.sell(self.short_strike, self.expiry, "CE", total_qty, product=self.product_type)
            if not short_oid:
                logger.error("Failed to place Sell (Short) order. Rolling back Long Hedge order immediately to prevent naked long.")
                try:
                    self.broker.sell(self.long_strike, self.expiry, "CE", total_qty, product=self.product_type)
                except Exception as rollback_err:
                    logger.critical(f"Failed to sell-close Long Hedge order during rollback: {rollback_err}")
                self._reset_position_state()
                return

            self.short_entry_price = self.get_execution_price(short_oid, 0.0)
            if self.short_entry_price == 0.0:
                logger.error("Short Leg order was not filled within timeout. Cancelling Short Leg and rolling back Long Leg.")
                try:
                    self.helper.cancel_order(short_oid)
                except Exception as cancel_err:
                    logger.error(f"Failed to cancel unfilled Short Leg order: {cancel_err}")
                try:
                    self.broker.sell(self.long_strike, self.expiry, "CE", total_qty, product=self.product_type)
                except Exception as rollback_err:
                    logger.critical(f"Failed to sell-close Long Hedge order during rollback: {rollback_err}")
                self._reset_position_state()
                return

            logger.info(f"Position Entered. Short ID: {short_oid} (avg price: {self.short_entry_price:.2f}) | Long ID: {long_oid} (avg price: {self.long_entry_price:.2f})")
        else:
            logger.info("[DRY RUN] Simulating Position Entry.")

        if self.target_is_pct or self.stop_is_pct:
            entry_value = (self.short_entry_price - self.long_entry_price) * total_qty
            if self.target_is_pct:
                self.target_profit = entry_value * self.target_pct / 100.0
                logger.info(f"Resolved profit target: {self.target_pct}% of entry credit INR{entry_value:.0f} = INR{self.target_profit:.0f}")
            if self.stop_is_pct:
                self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                logger.info(f"Resolved stop loss: {self.stop_pct}% of entry credit INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

        self.phase = "ENTERED"
        self.entry_time = datetime.now()
        self.candidate_strike = None
        self.candidate_id = None
        self.candidate_symbol = None
        self.watching_since = None

    def _reset_position_state(self):
        self.short_id = None
        self.short_strike = None
        self.short_symbol = None
        self.short_entry_price = 0.0
        self.long_id = None
        self.long_strike = None
        self.long_symbol = None
        self.long_entry_price = 0.0
        self.phase = "WATCHING"  # keep candidate + watching_since; retry next tick

    def monitor_position(self):
        last_log_time = 0
        total_qty = self.lot_size * self.lots
        last_indicator_minute = ""
        last_index_check = 0.0
        # _check_index_bearish() pulls 5 days of 1-min index candles and resamples them.
        # The Supertrend direction only changes on a completed --index-interval bar, so
        # polling it every second is pure API burn and drives the data endpoint into 429
        # backoff. Re-check at most once per index bar (floored at 60s).
        try:
            index_check_period = max(60, int(self.index_interval) * 60)
        except (TypeError, ValueError):
            index_check_period = 60

        while self.phase == "ENTERED":
            time.sleep(1)

            current_minute = datetime.now().strftime("%H:%M")
            if current_minute != last_indicator_minute:
                self._check_option_bearish(str(self.short_id))
                last_indicator_minute = current_minute

            if check_shutdown_trigger(STRATEGY_KEY):
                s_ltp, l_ltp, spot_price = self.fetch_ltps()
                short_ltp_val = s_ltp if s_ltp > 0 else self.short_entry_price
                long_ltp_val = l_ltp if l_ltp > 0 else self.long_entry_price
                total_pnl = self.realized_pnl + (
                    self.short_entry_price - short_ltp_val + long_ltp_val - self.long_entry_price
                ) * total_qty
                self.exit_positions("UI Shutdown Request")
                self.save_state(status="STOPPED", spot=spot_price, short_ltp=short_ltp_val, long_ltp=long_ltp_val, total_pnl=total_pnl)
                sys.exit(0)

            short_ltp, long_ltp, spot_price = self.fetch_ltps()
            if short_ltp <= 0 or long_ltp <= 0:
                continue

            short_pnl = (self.short_entry_price - short_ltp) * total_qty
            long_pnl = (long_ltp - self.long_entry_price) * total_qty
            position_pnl = short_pnl + long_pnl
            # Daily caps are evaluated against the session total, not this spread alone.
            total_pnl = self.realized_pnl + position_pnl

            self.save_state(status="RUNNING", spot=spot_price, short_ltp=short_ltp, long_ltp=long_ltp, total_pnl=total_pnl)

            now = datetime.now()
            current_time_str = now.strftime("%H:%M")

            if time.time() - last_log_time >= 30:
                logger.info(
                    f"[MONITOR] Bear Call | Short: {short_ltp:.2f} (Entry: {self.short_entry_price:.2f}) | "
                    f"Long: {long_ltp:.2f} (Entry: {self.long_entry_price:.2f}) | "
                    f"PnL: ₹{position_pnl:.2f} (session ₹{total_pnl:.2f}, realized ₹{self.realized_pnl:.2f}) | "
                    f"Option ST dir: {self.option_st_dir}"
                )
                last_log_time = time.time()

            # 1. EOD Auto-Exit (hard backstop at 15:17 regardless of configured eod_time)
            if current_time_str >= self.eod_time or current_time_str >= "15:17":
                self.exit_positions(f"Intraday Auto-Exit at {current_time_str}")
                break

            # 2. Market Close
            if not self.helper.is_market_open() and not self.dry_run:
                self.exit_positions("Market Closed")
                break

            # 3. Daily Profit Target
            if total_pnl >= self.target_profit:
                self.exit_positions(f"Profit Target Reached: ₹{total_pnl:.2f} (Target: ₹{self.target_profit:.2f})")
                break

            # 4. Daily Stop Loss
            if total_pnl <= self.stop_loss:
                self.exit_positions(f"Global Stop Loss Hit: ₹{total_pnl:.2f} (Limit: -₹{abs(self.stop_loss):.2f})")
                break

            hold_elapsed = (datetime.now() - self.entry_time).total_seconds() / 60 if self.entry_time else 0
            if hold_elapsed >= self.min_hold_minutes:
                # 5. Option's own Supertrend flips back bullish (short leg trend reversed against us)
                if self.exit_on_option_st_flip and self.option_st_dir == 1:
                    self.exit_positions(f"Short option ({self.short_symbol}) Supertrend flipped bullish")
                    break

                # 6. Index Supertrend flips back bullish (early exit on trend reversal)
                if self.exit_on_signal_flip and (time.time() - last_index_check) >= index_check_period:
                    last_index_check = time.time()
                    index_bearish, _, _ = self._check_index_bearish()
                    if not index_bearish:
                        self.exit_positions("Index Supertrend flipped bullish (trend reversal)", bypass_cooldown=True)
                        break

    def _halt(self, detail: str):
        """Publish a final HALTED state, then stop the process.

        These halts happen with a hedge leg still open on purpose (closing it while
        the short is stuck would leave a naked short). Exiting silently left the
        dashboard showing the last RUNNING snapshot, so an operator had no signal
        that manual intervention was needed on a live position.
        """
        logger.critical(f"HALTING STRATEGY: {detail}")
        try:
            self.save_state(status="HALTED", total_pnl=self.realized_pnl)
        except Exception as save_err:
            logger.error(f"Could not publish HALTED state: {save_err}")
        sys.exit(1)

    def exit_positions(self, reason: str, bypass_cooldown: bool = False):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        total_qty = self.lot_size * self.lots

        # Snapshot the closing marks BEFORE the state reset below, so this spread's
        # result can be banked into the session total. Without this the closed spread's
        # P&L was silently dropped and the "daily" target/stop restarted from zero.
        was_entered = self.phase == "ENTERED"
        exit_short_ltp, exit_long_ltp, _ = self.fetch_ltps()
        if exit_short_ltp <= 0:
            exit_short_ltp = self.short_entry_price
        if exit_long_ltp <= 0:
            exit_long_ltp = self.long_entry_price

        short_closed = False
        if not self.dry_run:
            if self.short_id and self.short_strike:
                try:
                    short_exit_oid = self.broker.buy(self.short_strike, self.expiry, "CE", total_qty, product=self.product_type)
                    if not short_exit_oid:
                        self._halt(f"Failed to place buy-to-close order for Short Leg {self.short_symbol} (ID: {self.short_id}). Hedge leg retained to prevent naked risk.")
                    else:
                        logger.info(f"Short Leg buy-to-close order placed: {short_exit_oid}")
                        if self.helper.wait_for_fill(short_exit_oid, timeout=10):
                            short_closed = True
                            logger.info("Short Leg close order filled.")
                        else:
                            ord_details = self.helper.get_order_by_id(short_exit_oid)
                            if ord_details and ord_details.get('orderStatus') == 'TRADED':
                                short_closed = True
                                logger.info("Short Leg close order confirmed filled via order status check.")
                            else:
                                self._halt("Short Leg close order did not fill. Hedge leg retained to prevent naked risk.")
                except Exception as e:
                    self._halt(f"Error closing Short Leg: {e}")
            else:
                short_closed = True

            if self.long_id and self.long_strike and short_closed:
                try:
                    long_exit_oid = self.broker.sell(self.long_strike, self.expiry, "CE", total_qty, product=self.product_type)
                    if not long_exit_oid:
                        self._halt(f"Failed to place sell-to-close order for Long Leg {self.long_symbol} (ID: {self.long_id}).")
                    else:
                        logger.info(f"Long Leg sell-to-close order placed: {long_exit_oid}")
                        self.helper.wait_for_fill(long_exit_oid, timeout=5)
                except Exception as e:
                    self._halt(f"Error closing Long Leg: {e}")
        else:
            logger.info("[DRY RUN] Simulating Position Exit.")

        if self.short_id and self.long_id:
            logger.info(f"Unsubscribing from WebSocket for options: {self.short_id}, {self.long_id}")
            try:
                self.helper.unsubscribe_instruments([
                    ("NSE_FNO", str(self.short_id), 15),
                    ("NSE_FNO", str(self.long_id), 15)
                ])
            except Exception as e:
                logger.error(f"Failed to unsubscribe options: {e}")

        # Bank this spread's result into the session total before clearing the legs.
        if was_entered:
            closed_pnl = (
                (self.short_entry_price - exit_short_ltp) + (exit_long_ltp - self.long_entry_price)
            ) * total_qty
            self.realized_pnl += closed_pnl
            logger.info(
                f"Spread closed at short {exit_short_ltp:.2f} / long {exit_long_ltp:.2f} | "
                f"Cycle P&L: ₹{closed_pnl:+.0f} | Session realized: ₹{self.realized_pnl:+.0f}"
            )

        self.phase = "IDLE"
        self.short_id = None
        self.short_strike = None
        self.short_symbol = None
        self.short_entry_price = 0.0
        self.long_id = None
        self.long_strike = None
        self.long_symbol = None
        self.long_entry_price = 0.0
        self.option_st_dir = None
        self.entry_time = None

        if bypass_cooldown:
            self.last_close_time = None
            logger.info("Position exit complete. Reversal detected: bypassing cooldown for immediate re-scan.")
        else:
            self.last_close_time = datetime.now()
            logger.info(f"Position exit complete. Cooldown started at {self.last_close_time.strftime('%H:%M:%S')} for {self.cooldown_minutes}m.")

    # --- Main loop -------------------------------------------------------------

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting {self.symbol} ST+OI Bear Call Spread Strategy (Dry Run: {self.dry_run})")

        while True:
            if check_shutdown_trigger(STRATEGY_KEY):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(status="STOPPED")
                sys.exit(0)

            try:
                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                if current_time_str >= self.eod_time and self.phase != "ENTERED":
                    logger.info(f"Current time ({current_time_str}) is past EOD time ({self.eod_time}). Closing execution as we are in non-market hours.")
                    break

                self.helper.wait_for_market_open(
                    self.dry_run, eod_time=self.eod_time,
                    shutdown_check=lambda: check_shutdown_trigger(STRATEGY_KEY)
                )

                # Cooldown check
                if self.last_close_time is not None:
                    elapsed = (datetime.now() - self.last_close_time).total_seconds() / 60.0
                    if elapsed < self.cooldown_minutes:
                        self.save_state(status="SCANNING")
                        time.sleep(10)
                        continue
                    else:
                        self.last_close_time = None

                if self.phase == "IDLE":
                    bearish, _, spot_close = self._check_index_bearish()
                    self.save_state(status="SCANNING", spot=spot_close or 0.0)
                    if spot_close is None:
                        logger.error("Could not fetch index candles. Retrying in 10s...")
                        time.sleep(10)
                        continue
                    if bearish:
                        self._enter_watching(spot_close)
                    else:
                        time.sleep(10 if self.dry_run else 30)
                    continue

                if self.phase == "WATCHING":
                    self._watching_tick()
                    if self.phase == "WATCHING":
                        time.sleep(self.poll_interval)
                    continue

                if self.phase == "ENTERED":
                    self.monitor_position()
                    continue

            except Exception as e:
                logger.error(f"Error in main strategy execution: {e}")
                import traceback
                logger.debug(traceback.format_exc())
                time.sleep(10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Supertrend + OI Short-Buildup Bear Call Spread Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default), 1 lot, standard Nifty setup
  python strategies/st_oi_bearcall/nifty_st_oi_bearcall.py

  # Live run, 2 lots, wider OTM offset and tighter buildup thresholds
  python strategies/st_oi_bearcall/nifty_st_oi_bearcall.py --live --lots 2 --ce-offset 150 --min-price-drop-pct -1.0 --min-oi-rise-pct 8.0
"""
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    parser.add_argument("--symbol", type=str, default="NIFTY",
                        help="Symbol to trade (default: NIFTY)")

    parser.add_argument("--index-interval", type=str, default="3",
                        help="Index candle timeframe in minutes, resampled from 1-min candles (default: 3)")
    parser.add_argument("--index-st-period", type=int, default=10,
                        help="Index Supertrend period/length (default: 10)")
    parser.add_argument("--index-st-multiplier", type=float, default=2.0,
                        help="Index Supertrend multiplier (default: 2.0)")

    parser.add_argument("--option-interval", type=str, default="3",
                        help="Candidate option candle timeframe in minutes, resampled from 1-min candles (default: 3)")
    parser.add_argument("--option-st-period", type=int, default=10,
                        help="Option Supertrend period/length (default: 10)")
    parser.add_argument("--option-st-multiplier", type=float, default=2.0,
                        help="Option Supertrend multiplier (default: 2.0)")

    parser.add_argument("--ce-offset", type=int, default=100,
                        help="Fixed OTM offset in points above ATM for the candidate/short Call strike (default: 100)")
    parser.add_argument("--spread-width", type=int, default=100,
                        help="Width of the bear call spread in points (default: 100)")

    parser.add_argument("--require-short-buildup", action="store_true", default=False,
                        help="Also require a short-buildup on the candidate CE (price down + OI up vs previous day) before entry (default: disabled -- entry relies on the dual Supertrend confirmation only)")
    parser.add_argument("--min-price-drop-pct", type=float, default=-0.5,
                        help="Short-buildup filter (only applies with --require-short-buildup): candidate CE price change vs previous day close must be <= this (default: -0.5)")
    parser.add_argument("--min-oi-rise-pct", type=float, default=5.0,
                        help="Short-buildup filter (only applies with --require-short-buildup): candidate CE OI change vs previous day OI must be >= this (default: 5.0)")

    parser.add_argument("--poll-interval", type=int, default=30,
                        help="Seconds between checks while WATCHING for confirmation (default: 30)")
    parser.add_argument("--max-wait-minutes", type=int, default=45,
                        help="Abandon a watch cycle and return to scanning if not entered within this many minutes (default: 45 -- "
                             "keep this above (option-st-period + 2) * option-interval minutes, since the candidate option's own "
                             "Supertrend needs that much same-day history before it can be computed; a lower value can make "
                             "signals right after market open impossible to act on)")

    parser.add_argument("--lots", type=int, default=1,
                        help="Number of lots to trade per spread leg (default: 1)")

    parser.add_argument("--target-profit", "--total-profit", type=str, default="2000",
                        help="Global daily profit target in INR, or a percentage of entry net credit "
                             "e.g. '20%%' (default: 2000)")
    parser.add_argument("--stop-loss", "--total-loss", type=str, default="2000",
                        help="Global daily stop loss in INR, or a percentage of entry net credit "
                             "e.g. '20%%' (default: 2000)")

    parser.add_argument("--no-exit-on-signal-flip", action="store_false", dest="exit_on_signal_flip",
                        default=True, help="Do not exit position early if the index Supertrend flips bullish (hold until SL/Target/EOD)")
    parser.add_argument("--no-exit-on-option-st-flip", action="store_false", dest="exit_on_option_st_flip",
                        default=True, help="Do not exit position early if the short option's own Supertrend flips bullish")

    parser.add_argument("--eod-time", type=str, default="15:15",
                        help="End of day square-off time in HH:MM (default: 15:15)")
    parser.add_argument("--cooldown-minutes", type=int, default=5,
                        help="Cooldown period in minutes after closing a position, or abandoning a watch cycle, before scanning resumes (default: 5)")
    parser.add_argument("--min-hold-minutes", type=int, default=5,
                        help="Minimum hold time in minutes before the ST-flip exits can trigger (default: 5)")
    parser.add_argument("--product-type", type=str, default="INTRADAY", choices=["INTRADAY", "MARGIN", "CNC"],
                        help="Order product type (default: INTRADAY)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")
    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
             "broker-side stop order)."
    )

    args = parser.parse_args()
    if args.instance_id:
        STRATEGY_KEY = f"{STRATEGY_KEY}_{args.instance_id}"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    mode_label = "LIVE" if args.live else "DRY"
    target_label = f"{target_val:.0f}%" if target_is_pct else f"₹{target_val:.0f}"
    stop_label = f"-{abs(stop_val):.0f}%" if stop_is_pct else f"-₹{abs(stop_val):.0f}"
    logger.info("=" * 60)
    logger.info(f"LAUNCHING NIFTY ST+OI BEAR CALL SPREAD STRATEGY IN {mode_label} MODE")
    logger.info(f"Underlying: {args.symbol} | Index ST({args.index_st_period},{args.index_st_multiplier}) @{args.index_interval}m | Option ST({args.option_st_period},{args.option_st_multiplier}) @{args.option_interval}m")
    buildup_label = f"price<={args.min_price_drop_pct}% & OI>={args.min_oi_rise_pct}%" if args.require_short_buildup else "DISABLED"
    logger.info(f"CE Offset: +{args.ce_offset} | Spread Width: {args.spread_width} | Short-Buildup Filter: {buildup_label}")
    logger.info(f"Lots: {args.lots} | Target Profit: {target_label} | Stop Loss: {stop_label}")
    logger.info(f"Poll Interval: {args.poll_interval}s | Max Wait: {args.max_wait_minutes}m | Cooldown: {args.cooldown_minutes}m | Min Hold: {args.min_hold_minutes}m")
    logger.info(f"Exit on Index ST Flip: {args.exit_on_signal_flip} | Exit on Option ST Flip: {args.exit_on_option_st_flip} | EOD: {args.eod_time}")
    logger.info(f"Execution Broker: {args.broker}")
    logger.info("=" * 60)

    strat = NiftySTOIBearCallStrategy(
        dry_run=not args.live,
        symbol=args.symbol,
        index_interval=args.index_interval,
        index_st_period=args.index_st_period,
        index_st_multiplier=args.index_st_multiplier,
        option_interval=args.option_interval,
        option_st_period=args.option_st_period,
        option_st_multiplier=args.option_st_multiplier,
        ce_offset=args.ce_offset,
        spread_width=args.spread_width,
        require_short_buildup=args.require_short_buildup,
        min_price_drop_pct=args.min_price_drop_pct,
        min_oi_rise_pct=args.min_oi_rise_pct,
        poll_interval=args.poll_interval,
        max_wait_minutes=args.max_wait_minutes,
        lots=args.lots,
        target_profit=target_val,
        target_profit_is_pct=target_is_pct,
        stop_loss=stop_val,
        stop_loss_is_pct=stop_is_pct,
        exit_on_signal_flip=args.exit_on_signal_flip,
        exit_on_option_st_flip=args.exit_on_option_st_flip,
        eod_time=args.eod_time,
        cooldown_minutes=args.cooldown_minutes,
        min_hold_minutes=args.min_hold_minutes,
        product_type=args.product_type,
        broker=args.broker,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        if strat.phase == "ENTERED":
            strat.exit_positions("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
