import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime, timedelta
from typing import Tuple, Dict, Optional, List

# Adjust path to parent dir
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec, instance_log_suffix

# Configure Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "spread_trend")
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
        FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"))
    ],
    force=True
)
logger = logging.getLogger(__name__)

class NiftySpreadTrendStrategy:
    def __init__(self, dry_run=True, symbol="NIFTY", interval="5",
                 ema_period=20, supertrend_period=7, supertrend_multiplier=3.0,
                 ce_offset=100, pe_offset=100, spread_width=100, lots=1,
                 target_profit=2000.0, target_profit_is_pct=False,
                 stop_loss=2000.0, stop_loss_is_pct=False, exit_on_signal_change=True,
                 eod_time="15:15", cooldown_minutes=5,
                 use_ema=True, use_supertrend=True, min_hold_minutes=5,
                 state_key="nifty_spread_trend"):
        self.state_key = state_key
        self.dry_run = dry_run
        self.symbol = symbol.upper()
        self.interval = interval
        self.ema_period = ema_period
        self.supertrend_period = supertrend_period
        self.supertrend_multiplier = float(supertrend_multiplier)
        self.ce_offset = ce_offset
        self.pe_offset = pe_offset
        self.spread_width = spread_width
        self.lots = lots
        # Target/SL may be an absolute INR amount or a percentage of entry net
        # credit (resolved once the position is actually entered, see below).
        self.target_is_pct = target_profit_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = target_profit if target_profit_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.target_profit = None if target_profit_is_pct else target_profit
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure SL is a negative number
        self.exit_on_signal_change = exit_on_signal_change
        self.eod_time = eod_time
        self.cooldown_minutes = cooldown_minutes
        self.use_ema = use_ema
        self.use_supertrend = use_supertrend
        self.min_hold_minutes = min_hold_minutes

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

        # Dynamic strike rounding steps
        if self.symbol == "BANKNIFTY":
            self.strike_step = 100
        else:
            self.strike_step = 50 # Default NIFTY / FINNIFTY

        # Start websocket for spot index
        logger.info(f"Resolving symbol ID for {self.symbol}...")
        sec_info = self.helper.get_index_id(self.symbol)
        if not sec_info:
            sec_info = self.helper.get_security_id(self.symbol, instrument="INDEX")
        if not sec_info:
            raise Exception(f"Could not resolve index security ID for {self.symbol}")

        self.index_security_id = str(sec_info['SECURITY_ID'])
        self.index_segment = self.helper._auto_detect_segment(sec_info) # e.g. "IDX_I"

        logger.info(f"Starting WebSocket for {self.symbol} (ID: {self.index_security_id}, Segment: {self.index_segment})...")
        self.helper.start_websocket([(self.index_segment, self.index_security_id, 15)])
        time.sleep(2) # wait for first tick

        self.lot_size = self.helper.get_lot_size(self.symbol)
        logger.info(f"Symbol: {self.symbol} | Index ID: {self.index_security_id} | Lot Size: {self.lot_size}")

        # Active position state
        self.active_spread = None # "BULL_PUT", "BEAR_CALL", or None
        self.short_id = None
        self.short_strike = None
        self.short_symbol = None
        self.short_entry_price = 0.0

        self.long_id = None
        self.long_strike = None
        self.long_symbol = None
        self.long_entry_price = 0.0

        self.expiry = None
        self.last_close_time = None # to prevent instant re-entry after cooldown
        self.last_processed_candle_time = None

        # Short-option VWAP + Supertrend exit tracking
        self.option_vwap: float = 0.0
        self.option_st_level: float = 0.0
        self.entry_time: datetime | None = None

    def _fetch_option_candles(self, security_id: str) -> pd.DataFrame:
        """Fetch 1-min intraday candles for the short option, normalised and filtered to today's session."""
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

            # Keep only today's session from 09:15 onwards
            today_mask = df.index.date == today
            session_mask = df.index.strftime("%H:%M") >= "09:15"
            return df[today_mask & session_mask]

        except Exception as e:
            logger.error(f"Error fetching option candles for {security_id}: {e}")
            return pd.DataFrame()

    def _refresh_option_indicators(self) -> None:
        """Recompute session VWAP and Supertrend level for the short option."""
        if not self.short_id:
            return

        df = self._fetch_option_candles(str(self.short_id))
        if df.empty:
            logger.debug("No option candles available yet for VWAP/ST computation.")
            return

        # Session VWAP
        try:
            typical = (df["High"] + df["Low"] + df["Close"]) / 3
            vol = df["Volume"].clip(lower=1)  # avoid division by zero on zero-volume candles
            vwap = float((typical * vol).sum() / vol.sum())
            if vwap > 0:
                self.option_vwap = vwap
        except Exception as e:
            logger.error(f"Option VWAP computation error: {e}")

        # Supertrend level
        try:
            st_ind = [{"kind": "supertrend", "length": self.supertrend_period, "multiplier": self.supertrend_multiplier}]
            df_ta = self.helper.calculate_ta_indicators(df.copy(), st_ind)
            supert_cols = [
                c for c in df_ta.columns
                if c.startswith("SUPERT_") and not any(c.startswith(p) for p in ("SUPERTd_", "SUPERTl_", "SUPERTs_"))
            ]
            if supert_cols:
                st_val = float(df_ta[supert_cols[0]].iloc[-1])
                if not pd.isna(st_val) and st_val > 0:
                    self.option_st_level = st_val
        except Exception as e:
            logger.error(f"Option Supertrend computation error: {e}")

        logger.info(
            f"[OPTION IND] {self.short_symbol} | candles={len(df)}"
            f" | VWAP={self.option_vwap:.2f} | ST={self.option_st_level:.2f}"
        )

    def fetch_ltps(self):
        """Batched short-leg/long-leg/spot LTP fetch — at most one REST call on WebSocket miss."""
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

    def save_state(self, nifty_spot, short_ltp, long_ltp, total_pnl, status="RUNNING"):
        state_dict = {
            "strategy": "nifty_spread_trend",
            "status": status,
            "dry_run": self.dry_run,
            "symbol": self.symbol,
            "interval": self.interval,
            "use_ema": self.use_ema,
            "use_supertrend": self.use_supertrend,
            "lots": self.lots,
            "active_spread": self.active_spread,
            "short_strike": self.short_strike,
            "long_strike": self.long_strike,
            "short_symbol": self.short_symbol,
            "long_symbol": self.long_symbol,
            "short_entry_price": self.short_entry_price,
            "long_entry_price": self.long_entry_price,
            "short_ltp": short_ltp,
            "long_ltp": long_ltp,
            "total_pnl": total_pnl,
            "spot": nifty_spot,
            "profit_target": self.target_profit,
            "stop_loss": self.stop_loss,
            "option_vwap": round(self.option_vwap, 2),
            "option_st_level": round(self.option_st_level, 2),
        }
        save_strategy_state(self.state_key, state_dict)

    def get_signal(self) -> Tuple[str, float]:
        """
        Fetch enabled indicators and determine signal from the last completed candle.
        Returns (signal, spot_close) where signal is "BULLISH", "BEARISH", or "NEUTRAL".
        """
        try:
            if not self.use_ema and not self.use_supertrend:
                logger.warning("No indicators enabled — returning NEUTRAL.")
                return "NEUTRAL", 0.0

            indicators = []
            if self.use_ema:
                indicators.append(f"EMA{self.ema_period}")
            if self.use_supertrend:
                indicators.append({
                    "kind": "supertrend",
                    "length": self.supertrend_period,
                    "multiplier": self.supertrend_multiplier,
                })

            df = self.helper.get_indicators_ta(
                symbol=self.symbol,
                interval=self.interval,
                indicators=indicators,
                days=5,
            )

            if df.empty or len(df) < 2:
                logger.warning("Empty or insufficient data for indicator calculations.")
                return "NEUTRAL", 0.0

            row = df.iloc[-2]
            close = float(row["Close"])

            bullish_votes = []
            bearish_votes = []

            if self.use_ema:
                ema_col = f"EMA_{self.ema_period}"
                if ema_col not in df.columns:
                    ema_cols = [c for c in df.columns if "EMA" in c]
                    if not ema_cols:
                        logger.error(f"EMA column not found. Columns: {df.columns.tolist()}")
                        return "NEUTRAL", 0.0
                    ema_col = ema_cols[0]
                ema_val = float(row[ema_col])
                bullish_votes.append(close > ema_val)
                bearish_votes.append(close < ema_val)

            if self.use_supertrend:
                st_dir_cols = [c for c in df.columns if c.startswith("SUPERTd_")]
                if not st_dir_cols:
                    logger.error(f"Supertrend direction column not found. Columns: {df.columns.tolist()}")
                    return "NEUTRAL", 0.0
                st_dir = float(row[st_dir_cols[0]])
                bullish_votes.append(st_dir == 1)
                bearish_votes.append(st_dir == -1)

            candle_time = row.get("Datetime") or df.index[-2]
            if candle_time != self.last_processed_candle_time:
                active = []
                if self.use_ema:
                    active.append(f"EMA({self.ema_period})={ema_val:.2f}")
                if self.use_supertrend:
                    active.append(f"ST_dir={st_dir:.1f}")
                logger.info(
                    f"[SIGNAL CHECK] Candle: {candle_time} | Close: {close:.2f} | "
                    + " | ".join(active)
                )
                self.last_processed_candle_time = candle_time

            if not bullish_votes:
                return "NEUTRAL", close
            if all(bullish_votes):
                return "BULLISH", close
            if all(bearish_votes):
                return "BEARISH", close
            return "NEUTRAL", close

        except Exception as e:
            logger.error(f"Error checking indicators/signal: {e}")
            return "NEUTRAL", 0.0

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        """Wait for fill and get the average execution price, or return fallback."""
        if not order_id:
            return fallback_price
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(order_details.get('averageTradedPrice', 0.0) or order_details.get('avgFilledPrice', 0.0) or order_details.get('price', 0.0))
                if fill_price > 0:
                    logger.info(f"Order {order_id} execution price confirmed: {fill_price:.2f}")
                    return fill_price
        return fallback_price

    def is_quote_invalid(self, q):
        if not q: return True
        if isinstance(q, dict) and 'CONTRACT_INFO' in q:
            return float(q.get('last_price', 0) or q.get('LTP', 0)) == 0
        return False

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

    def enter_spread(self, spot: float, option_type: str):
        """
        Determines strikes, retrieves quotes, and places orders (Buy hedge first, Sell short second).
        """
        # Check shutdown trigger first
        if check_shutdown_trigger(self.state_key):
            logger.info("UI Shutdown Request during enter_spread startup.")
            self.save_state(spot, 0, 0, 0, status="STOPPED")
            sys.exit(0)

        atm_strike = int(round(spot / self.strike_step) * self.strike_step)
        
        if option_type == "PE":
            self.active_spread = "BULL_PUT"
            short_strike = atm_strike - self.pe_offset
            long_strike = short_strike - self.spread_width
        else:
            self.active_spread = "BEAR_CALL"
            short_strike = atm_strike + self.ce_offset
            long_strike = short_strike + self.spread_width
        self.entry_time = datetime.now()
            
        short_strike = int(round(short_strike / self.strike_step) * self.strike_step)
        long_strike = int(round(long_strike / self.strike_step) * self.strike_step)
        
        logger.info(f"Spread Strike Selection -> ATM: {atm_strike} | Short Strike: {short_strike} | Long Strike: {long_strike}")
        
        self.expiry = self.helper.get_nearest_expiry(self.symbol)
        if not self.expiry:
            logger.error("Could not determine nearest expiry date.")
            self.active_spread = None
            return
            
        # Check shutdown trigger before short quote fetch
        if check_shutdown_trigger(self.state_key):
            logger.info("UI Shutdown Request before short option quote fetch.")
            self.save_state(spot, 0, 0, 0, status="STOPPED")
            sys.exit(0)

        # Get Short Quote
        short_quote = self.helper.option(self.symbol, short_strike, option_type)

        # Check shutdown trigger before long quote fetch
        if check_shutdown_trigger(self.state_key):
            logger.info("UI Shutdown Request before long option quote fetch.")
            self.save_state(spot, 0, 0, 0, status="STOPPED")
            sys.exit(0)

        # Get Long Quote
        long_quote = self.helper.option(self.symbol, long_strike, option_type)

        # Check shutdown trigger after quote fetches
        if check_shutdown_trigger(self.state_key):
            logger.info("UI Shutdown Request after option quote fetches.")
            self.save_state(spot, 0, 0, 0, status="STOPPED")
            sys.exit(0)
        
        if self.is_quote_invalid(short_quote) or self.is_quote_invalid(long_quote):
            logger.error(f"Failed to fetch valid quotes for options. Short: {short_strike} {option_type}, Long: {long_strike} {option_type}. Retrying in next loop.")
            self.active_spread = None
            return
            
        # Extract contract details
        self.short_id, self.short_entry_price, _, _, self.short_symbol = \
            self._extract_quote_fields(short_quote, short_strike, option_type)
            
        self.long_id, self.long_entry_price, _, _, self.long_symbol = \
            self._extract_quote_fields(long_quote, long_strike, option_type)
            
        if not self.short_id or not self.long_id:
            logger.error("Failed to extract security IDs from quotes.")
            self.active_spread = None
            return
            
        total_qty = self.lot_size * self.lots
        logger.info(f"Entry Quotes -> Short: {self.short_symbol} (ID: {self.short_id}) @ {self.short_entry_price:.2f}")
        logger.info(f"Entry Quotes -> Long: {self.long_symbol} (ID: {self.long_id}) @ {self.long_entry_price:.2f}")
        logger.info(f"Expected Spread Credit: {self.short_entry_price - self.long_entry_price:.2f} points | Total Qty: {total_qty} ({self.lots} lots)")
        
        # Subscribe to websocket for live prices
        logger.info(f"Subscribing to WebSocket for options: {self.short_symbol} & {self.long_symbol}")
        try:
            self.helper.subscribe_instruments([
                ("NSE_FNO", str(self.short_id), 15),
                ("NSE_FNO", str(self.long_id), 15)
            ])
            time.sleep(2) # wait for initial ticks
        except Exception as e:
            logger.error(f"WebSocket subscription failed: {e}")
            
        # Place orders (Long Leg first for margin benefit, Short Leg second)
        if not self.dry_run:
            logger.info("PLACING LIVE ENTRY ORDERS...")
            # 1. Buy Long Leg (Hedge)
            long_oid = self.helper.buy(str(self.long_id), total_qty)
            if not long_oid:
                logger.error("Failed to place Buy (Long Hedge) order. Aborting entry.")
                self.active_spread = None
                return
                
            # Wait for fill and confirm execution price (using 0.0 fallback to verify fill)
            self.long_entry_price = self.get_execution_price(long_oid, 0.0)
            if self.long_entry_price == 0.0:
                logger.error("Long Hedge order was not filled within timeout. Cancelling order and aborting entry.")
                try:
                    self.helper.cancel_order(long_oid)
                except Exception as cancel_err:
                    logger.error(f"Failed to cancel unfilled Long Hedge order: {cancel_err}")
                self.active_spread = None
                return
            
            # 2. Sell Short Leg
            short_oid = self.helper.sell(str(self.short_id), total_qty)
            if not short_oid:
                logger.error("Failed to place Sell (Short) order. Rolling back Long Hedge order immediately to prevent naked long.")
                try:
                    self.helper.sell(str(self.long_id), total_qty)
                except Exception as rollback_err:
                    logger.critical(f"Failed to sell-close Long Hedge order during rollback: {rollback_err}")
                self.active_spread = None
                return
                
            # Wait for fill and confirm execution price (using 0.0 fallback to verify fill)
            self.short_entry_price = self.get_execution_price(short_oid, 0.0)
            if self.short_entry_price == 0.0:
                logger.error("Short Leg order was not filled within timeout. Cancelling Short Leg and rolling back Long Leg.")
                try:
                    self.helper.cancel_order(short_oid)
                except Exception as cancel_err:
                    logger.error(f"Failed to cancel unfilled Short Leg order: {cancel_err}")
                try:
                    self.helper.sell(str(self.long_id), total_qty)
                except Exception as rollback_err:
                    logger.critical(f"Failed to sell-close Long Hedge order during rollback: {rollback_err}")
                self.active_spread = None
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

    def monitor_position(self):
        """
        Monitors active positions, updates P&L, checks exit conditions, and handles order closing.
        """
        last_log_time = 0
        total_qty = self.lot_size * self.lots
        last_indicator_minute = ""  # refresh once per 1-min candle boundary

        while self.active_spread is not None:
            time.sleep(1)

            # Refresh short-option VWAP and Supertrend on each new 1-min candle
            current_minute = datetime.now().strftime("%H:%M")
            if current_minute != last_indicator_minute:
                self._refresh_option_indicators()
                last_indicator_minute = current_minute
            
            # Check shutdown trigger first
            if check_shutdown_trigger(self.state_key):
                s_ltp, l_ltp, spot_price = self.fetch_ltps()
                short_ltp_val = s_ltp if s_ltp > 0 else self.short_entry_price
                long_ltp_val = l_ltp if l_ltp > 0 else self.long_entry_price
                total_pnl = (self.short_entry_price - short_ltp_val + long_ltp_val - self.long_entry_price) * total_qty
                self.exit_positions("UI Shutdown Request")
                self.save_state(spot_price, short_ltp_val, long_ltp_val, total_pnl, status="STOPPED")
                sys.exit(0)

            # Fetch current prices + spot in one batched call
            short_ltp, long_ltp, spot_price = self.fetch_ltps()

            if short_ltp <= 0 or long_ltp <= 0:
                continue

            # Save state
            self.save_state(spot_price, short_ltp, long_ltp, (self.short_entry_price - short_ltp + long_ltp - self.long_entry_price) * total_qty, status="RUNNING")
                
            # Spread PnL calculation:
            # Short Leg: (Entry - Current) * Qty (since we are short)
            # Long Leg: (Current - Entry) * Qty (since we are long)
            short_pnl = (self.short_entry_price - short_ltp) * total_qty
            long_pnl = (long_ltp - self.long_entry_price) * total_qty
            total_pnl = short_pnl + long_pnl
            
            now = datetime.now()
            current_time_str = now.strftime("%H:%M")
            
            # Log status every 30 seconds
            if time.time() - last_log_time >= 30:
                vwap_info = f"VWAP={self.option_vwap:.2f} ST={self.option_st_level:.2f}" if self.option_vwap > 0 else "VWAP=—"
                logger.info(
                    f"[MONITOR] {self.active_spread} | Short: {short_ltp:.2f} (Entry: {self.short_entry_price:.2f}) | "
                    f"Long: {long_ltp:.2f} (Entry: {self.long_entry_price:.2f}) | PnL: ₹{total_pnl:.2f} | {vwap_info}"
                )
                last_log_time = time.time()
                
            # Exit Conditions:
            
            # 1. EOD Auto-Exit
            if current_time_str >= self.eod_time:
                self.exit_positions(f"Intraday Auto-Exit at {current_time_str}")
                break
                
            # 2. Market Close
            if not self.helper.is_market_open() and not self.dry_run:
                self.exit_positions("Market Closed")
                break
                
            # 3. Daily Profit Target
            if total_pnl >= self.target_profit:
                self.exit_positions(f"Profit Target Reached: ₹{total_pnl:.2f} (Target: ₹{self.target_profit:.2f})")
                logger.info(f"Profit target hit. Cooling down for {self.cooldown_minutes} minutes before re-scanning...")
                break

            # 4. Daily Stop Loss
            if total_pnl <= self.stop_loss:
                self.exit_positions(f"Global Stop Loss Hit: ₹{total_pnl:.2f} (Limit: -₹{abs(self.stop_loss):.2f})")
                logger.info(f"Stop loss hit. Cooling down for {self.cooldown_minutes} minutes before re-scanning...")
                break

            # 5. Short option above session VWAP and Supertrend
            hold_elapsed = (datetime.now() - self.entry_time).total_seconds() / 60 if self.entry_time else 0
            if (hold_elapsed >= self.min_hold_minutes
                    and self.option_vwap > 0 and self.option_st_level > 0
                    and short_ltp > self.option_vwap
                    and short_ltp > self.option_st_level):
                self.exit_positions(
                    f"Short option LTP {short_ltp:.2f} above VWAP ({self.option_vwap:.2f})"
                    f" and Supertrend ({self.option_st_level:.2f})"
                )
                logger.info(f"Option VWAP/ST exit. Cooling down for {self.cooldown_minutes} minutes.")
                break

            # 6. Signal Reversal (Early exit on trend flip)
            if self.exit_on_signal_change:
                signal, spot = self.get_signal()
                if spot > 0:
                    should_exit = False
                    if self.active_spread == "BULL_PUT" and signal == "BEARISH":
                        should_exit = True
                    elif self.active_spread == "BEAR_CALL" and signal == "BULLISH":
                        should_exit = True
                        
                    if should_exit:
                        self.exit_positions(f"Signal Reversal / Trend Flip (New Signal: {signal}, Spot: {spot:.2f})", bypass_cooldown=True)
                        break

    def exit_positions(self, reason: str, bypass_cooldown: bool = False):
        """
        Exits both positions: Short leg first (buy back), Long hedge leg second (sell).
        """
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        total_qty = self.lot_size * self.lots
        
        short_closed = False
        if not self.dry_run:
            # 1. Buy back Short Leg first (closes short, prevents naked short risk)
            if self.short_id:
                try:
                    short_exit_oid = self.helper.buy(str(self.short_id), total_qty)
                    if not short_exit_oid:
                        logger.critical(f"CRITICAL ERROR: Failed to place buy-to-close order for Short Leg {self.short_symbol} (ID: {self.short_id})! Retaining hedge leg to prevent naked risk. HALTING STRATEGY.")
                        sys.exit(1)
                    else:
                        logger.info(f"Short Leg buy-to-close order placed: {short_exit_oid}")
                        if self.helper.wait_for_fill(short_exit_oid, timeout=10):
                            short_closed = True
                            logger.info("Short Leg close order filled.")
                        else:
                            # Re-check status before halting
                            ord_details = self.helper.get_order_by_id(short_exit_oid)
                            if ord_details and ord_details.get('orderStatus') == 'TRADED':
                                short_closed = True
                                logger.info("Short Leg close order confirmed filled via order status check.")
                            else:
                                logger.critical("CRITICAL ERROR: Short Leg close order did not fill. Retaining hedge leg to prevent naked risk. HALTING STRATEGY.")
                                sys.exit(1)
                except Exception as e:
                    logger.error(f"Error closing Short Leg: {e}")
                    sys.exit(1)
            else:
                short_closed = True
                
            # 2. Sell Long Leg second (closes hedge) - ONLY if short is confirmed closed!
            if self.long_id and short_closed:
                try:
                    long_exit_oid = self.helper.sell(str(self.long_id), total_qty)
                    if not long_exit_oid:
                        logger.critical(f"CRITICAL ERROR: Failed to place sell-to-close order for Long Leg {self.long_symbol} (ID: {self.long_id})! HALTING STRATEGY.")
                        sys.exit(1)
                    else:
                        logger.info(f"Long Leg sell-to-close order placed: {long_exit_oid}")
                        self.helper.wait_for_fill(long_exit_oid, timeout=5)
                except Exception as e:
                    logger.error(f"Error closing Long Leg: {e}")
                    sys.exit(1)
        else:
            logger.info("[DRY RUN] Simulating Position Exit.")
            
        # Unsubscribe WebSocket
        if self.short_id and self.long_id:
            logger.info(f"Unsubscribing from WebSocket for options: {self.short_id}, {self.long_id}")
            try:
                self.helper.unsubscribe_instruments([
                    ("NSE_FNO", str(self.short_id), 15),
                    ("NSE_FNO", str(self.long_id), 15)
                ])
            except Exception as e:
                logger.error(f"Failed to unsubscribe options: {e}")
                
        # Reset State and start cooldown
        self.active_spread = None
        self.short_id = None
        self.short_strike = None
        self.short_symbol = None
        self.short_entry_price = 0.0
        self.long_id = None
        self.long_strike = None
        self.long_symbol = None
        self.long_entry_price = 0.0
        self.option_vwap = 0.0
        self.option_st_level = 0.0
        
        if bypass_cooldown:
            self.last_close_time = None
            logger.info("Position exit complete. Reversal detected: Bypassing cool-down for immediate entry.")
        else:
            self.last_close_time = datetime.now()
            logger.info(f"Position exit complete. Cool-down started at {self.last_close_time.strftime('%H:%M:%S')}.")

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting {self.symbol} Spread Trend Strategy (Dry Run: {self.dry_run})")
        
        while True:
            # Check shutdown trigger
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            self.save_state(0, 0, 0, 0, status="INITIALIZING")

            try:
                # Check if current time is past EOD time (non-market hours check)
                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                if current_time_str >= self.eod_time:
                    logger.info(f"Current time ({current_time_str}) is past EOD time ({self.eod_time}). Closing execution as we are in non-market hours.")
                    break

                # Wait for market open if closed
                self.helper.wait_for_market_open(self.dry_run, eod_time=self.eod_time, shutdown_check=lambda: check_shutdown_trigger(self.state_key))
                
                # Check signal and spot
                signal, spot = self.get_signal()
                
                # Update scanning state
                self.save_state(spot, 0, 0, 0, status="SCANNING")
                
                if spot == 0:
                    logger.error("Could not fetch index spot price. Retrying in 10s...")
                    time.sleep(10)
                    continue

                # Cooldown check
                if self.last_close_time is not None:
                    elapsed = (datetime.now() - self.last_close_time).total_seconds() / 60.0
                    if elapsed < self.cooldown_minutes:
                        logger.info(f"In cool-down period. {self.cooldown_minutes - elapsed:.1f} minutes remaining. Skipping entries...")
                        time.sleep(10)
                        continue
                    else:
                        logger.info("Cool-down period completed. Resetting cooldown tracker.")
                        self.last_close_time = None
                
                # Entry Logic
                if signal == "BULLISH":
                    logger.info(f"Bullish Trend detected (Spot: {spot:.2f}). Entering Bull Put Spread.")
                    self.enter_spread(spot, "PE")
                elif signal == "BEARISH":
                    logger.info(f"Bearish Trend detected (Spot: {spot:.2f}). Entering Bear Call Spread.")
                    self.enter_spread(spot, "CE")
                else:
                    logger.info(f"Market Trend is Neutral. Waiting for trend confirmation (Spot: {spot:.2f})...")
                    time.sleep(10 if self.dry_run else 30) # Poll signal faster in dry run for testing
                    continue
                
                # Monitoring loop for active position
                self.monitor_position()
                
            except Exception as e:
                logger.error(f"Error in main strategy execution: {e}")
                import traceback
                logger.debug(traceback.format_exc())
                time.sleep(10)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Spread Trend-Following Option Selling Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default), 1 lot, standard Nifty setup
  python strategies/nifty_spread_trend.py

  # Live run, 2 lots, custom offsets and daily targets
  python strategies/nifty_spread_trend.py --live --lots 2 --ce-offset 100 --pe-offset 100 --target-profit 3000 --stop-loss 1500
""")

    # Execution Mode
    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    # Underlying & Timeframe
    parser.add_argument("--symbol", type=str, default="NIFTY",
                        help="Symbol to trade (default: NIFTY)")
    parser.add_argument("--interval", type=str, default="5",
                        help="Candle timeframe interval in minutes: 1, 3, 5 (default: 5)")

    # Technical Indicators Parameters
    parser.add_argument("--ema-period", type=int, default=20,
                        help="EMA period (default: 20)")
    parser.add_argument("--supertrend-period", type=int, default=7,
                        help="Supertrend period/length (default: 7)")
    parser.add_argument("--supertrend-multiplier", type=float, default=3.0,
                        help="Supertrend multiplier (default: 3.0)")
    parser.add_argument(
        "--no-ema",
        action="store_false",
        dest="use_ema",
        default=True,
        help="Disable the EMA filter (default: enabled)",
    )
    parser.add_argument(
        "--no-supertrend",
        action="store_false",
        dest="use_supertrend",
        default=True,
        help="Disable the Supertrend filter (default: enabled)",
    )

    # Spread Configuration
    parser.add_argument("--ce-offset", type=int, default=100,
                        help="Offset in points above spot for Short Call strike in Bear Call Spread (default: 100)")
    parser.add_argument("--pe-offset", type=int, default=100,
                        help="Offset in points below spot for Short Put strike in Bull Put Spread (default: 100)")
    parser.add_argument("--spread-width", type=int, default=100,
                        help="Width of the option spread in points (default: 100)")

    # Position sizing
    parser.add_argument("--lots", type=int, default=1,
                        help="Number of lots to trade per spread leg (default: 1)")

    # Risk Management Target & Stop Loss
    parser.add_argument("--target-profit", "--total-profit", type=str, default="2000",
                        help="Global daily profit target in INR, or a percentage of entry net credit "
                             "e.g. '20%%' (default: 2000)")
    parser.add_argument("--stop-loss", "--total-loss", type=str, default="2000",
                        help="Global daily stop loss in INR, or a percentage of entry net credit "
                             "e.g. '20%%' (default: 2000)")

    # Signals & Cooldown
    parser.add_argument("--no-exit-on-signal-change", action="store_false", dest="exit_on_signal_change",
                        help="Do not exit position early if indicator trend reverses (hold until SL/Target/EOD)")
    parser.add_argument("--eod-time", type=str, default="15:15",
                        help="End of day square-off time in HH:MM (default: 15:15)")
    parser.add_argument("--cooldown-minutes", type=int, default=5,
                        help="Cooldown period in minutes after closing a position before scan resumes (default: 5)")
    parser.add_argument("--min-hold-minutes", type=int, default=5,
                        help="Minimum hold time in minutes before the VWAP/ST exit can trigger (default: 5)")

    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    args = parser.parse_args()
    STATE_KEY = f"nifty_spread_trend_{args.instance_id}" if args.instance_id else "nifty_spread_trend"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    mode_label = "LIVE" if args.live else "DRY"
    active_indicators = []
    if args.use_ema:
        active_indicators.append(f"EMA({args.ema_period})")
    if args.use_supertrend:
        active_indicators.append(f"Supertrend({args.supertrend_period}, {args.supertrend_multiplier})")
    target_label = f"{target_val:.0f}%" if target_is_pct else f"₹{target_val:.0f}"
    stop_label = f"-{abs(stop_val):.0f}%" if stop_is_pct else f"-₹{abs(stop_val):.0f}"
    logger.info("=" * 60)
    logger.info(f"LAUNCHING NIFTY SPREAD TREND STRATEGY IN {mode_label} MODE")
    logger.info(f"Underlying: {args.symbol} | Interval: {args.interval}m")
    logger.info(f"Indicators: {' + '.join(active_indicators) if active_indicators else 'NONE (will not trade)'}")
    logger.info(f"Spread Config: CE Offset +{args.ce_offset} | PE Offset -{args.pe_offset} | Width: {args.spread_width}")
    logger.info(f"Lots: {args.lots} | Target Profit: {target_label} | Stop Loss: {stop_label}")
    logger.info(f"Exit on Trend Reversal: {args.exit_on_signal_change} | Cooldown: {args.cooldown_minutes}m | Min Hold: {args.min_hold_minutes}m")
    logger.info("=" * 60)

    strat = NiftySpreadTrendStrategy(
        dry_run=not args.live,
        symbol=args.symbol,
        interval=args.interval,
        ema_period=args.ema_period,
        supertrend_period=args.supertrend_period,
        supertrend_multiplier=args.supertrend_multiplier,
        ce_offset=args.ce_offset,
        pe_offset=args.pe_offset,
        spread_width=args.spread_width,
        lots=args.lots,
        target_profit=target_val,
        target_profit_is_pct=target_is_pct,
        stop_loss=stop_val,
        stop_loss_is_pct=stop_is_pct,
        exit_on_signal_change=args.exit_on_signal_change,
        eod_time=args.eod_time,
        cooldown_minutes=args.cooldown_minutes,
        use_ema=args.use_ema,
        use_supertrend=args.use_supertrend,
        min_hold_minutes=args.min_hold_minutes,
        state_key=STATE_KEY,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        strat.exit_positions("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
