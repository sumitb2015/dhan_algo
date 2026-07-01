import pandas as pd
import logging
import os
import io
import requests
from typing import Optional, Dict, List, Any, Tuple, Union, Callable
from dhanhq import dhanhq
from dhanhq.marketfeed import MarketFeed
from dhanhq.orderupdate import OrderUpdate
from datetime import datetime, timedelta
import time
import threading
try:
    import talib
    HAS_TALIB = True
except ImportError:
    HAS_TALIB = False
# logging.basicConfig is configured by the main strategy application
logger = logging.getLogger(__name__)

class DhanHelper:
    def __init__(self, dhan_client: dhanhq):
        """
        Initialize the Helper with an active Dhan SDK client.
        """
        self.dhan = dhan_client
        self.live_data = {} # Shared store for latest WebSocket ticks
        # Constants mapping for easier access
        self.NSE = "NSE_EQ"
        self.BSE = "BSE_EQ"
        self.NSE_FNO = "NSE_FNO"
        self.BSE_FNO = "BSE_FNO"
        self.MCX = "MCX_COMM"
        self.BUY = "BUY"
        self.SELL = "SELL"
        self.MARKET = "MARKET"
        self.LIMIT = "LIMIT"
        self.INTRA = "INTRADAY" 
        self.CNC = "CNC"
        self.MARGIN = "MARGIN"
        self.CO = "CO"
        self.BO = "BO"
        self.MTF = "MTF"
        self.SL = "STOP_LOSS"
        self.SLM = "STOP_LOSS_MARKET"
        
        # Cache for performance
        self._master_list = None
        # Path absolute relative to the project root (parent of lib/)
        lib_dir = os.path.dirname(os.path.abspath(__file__))
        self._master_list_path = os.path.abspath(os.path.join(os.path.dirname(lib_dir), "master_list.csv"))
        logger.info(f"Resolved Master List Path: {self._master_list_path}")
        
        self._symbol_map = {} # SYMBOL_NAME -> Records for O(1) lookup
        self._resolution_cache = {} # Cache for _resolve_symbol
        self._ltp_cache = {} # Cache for LTP: {sid: (price, timestamp)}
        self._expiry_cache = {} # Cache for expiries: {sid: (list, timestamp)}
        self._option_chain_cache = {} # Cache for option chains: {(sid, expiry): (data, timestamp)}
        self._option_chain_last_call = 0.0 # Tracks last API call time for 3s rate limit
        
        # Pre-load master list during initialization for better performance
        self._load_master_list()

        # Check if master list is empty and fetch if needed
        if self._master_list.empty:
            logger.warning("Master list not found or empty. Attempting to download...")
            if self.fetch_security_list():
                logger.info("Master list downloaded successfully. Reloading...")
                self._load_master_list(reload=True)
            else:
                logger.error("Failed to download master list.")
        
        # WebSocket management
        self.ws_thread = None
        self._ws_stop_flag = False
        self._ws_lock = threading.Lock()
        self.ws_instruments = []
        self.user_on_message = None

        # Order Update WebSocket
        self.order_updates: Dict[str, dict] = {}  # order_id -> latest update payload
        self._ou_thread = None
        self._ou_stop_flag = False
        self._ou_lock = threading.Lock()
        self.user_on_order_update: Optional[Callable] = None

        # Validate session on init
        self.validate_session()

    def validate_session(self) -> bool:
        """
        Verify if the Dhan client session is still active and valid.
        Fetches holdings as a lightweight health check.
        """
        try:
            res = self.dhan.get_holdings()
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.debug("Dhan session validated successfully.")
                return True
            else:
                # Handle different error formats from SDK
                err_details = res if isinstance(res, dict) else {'error': 'Response format error'}
                logger.error(f"Dhan session validation failed: {err_details}")
                
                error_str = str(err_details).lower()
                if "unauthorized" in error_str or "invalid" in error_str or "expired" in error_str:
                    logger.warning("CRITICAL: Access Token is stale or invalid. Run login.py manually or restart script to trigger re-login.")
                return False
        except Exception as e:
            logger.error(f"Error during session validation: {e}")
            return False

    # --- SECURITY ID LOOKUP ---
    def _load_master_list(self, reload: bool = False) -> pd.DataFrame:
        """
        Load master security list from CSV with caching and specialized indexing.
        First load takes a few seconds, subsequent calls are instant.
        """
        if self._master_list is None or reload:
            try:
                logger.info(f"Loading master list from {self._master_list_path}...")
                self._master_list = pd.read_csv(
                    self._master_list_path,
                    low_memory=False
                )
                
                if not self._master_list.empty:
                    # Clean data types for faster exact matching
                    self._master_list['SYMBOL_NAME'] = self._master_list['SYMBOL_NAME'].astype(str).str.upper()
                    self._master_list['UNDERLYING_SYMBOL'] = self._master_list['UNDERLYING_SYMBOL'].astype(str).str.upper()
                    self._master_list['INSTRUMENT'] = self._master_list['INSTRUMENT'].astype(str).str.upper()
                    self._master_list['OPTION_TYPE'] = self._master_list['OPTION_TYPE'].astype(str).str.upper()
                    self._master_list['SM_EXPIRY_DATE'] = self._master_list['SM_EXPIRY_DATE'].astype(str)
                    
                    # Ensure STRIKE_PRICE is float for precise numeric comparisons
                    if 'STRIKE_PRICE' in self._master_list.columns:
                        self._master_list['STRIKE_PRICE'] = pd.to_numeric(self._master_list['STRIKE_PRICE'], errors='coerce').fillna(0.0)

                    logger.info(f"Master list loaded: {len(self._master_list)} records")
                    
                    # Specialized Optimization Map for Symbol Lookups
                    # OPTIMIZATION: Groupby iteration on 170k rows is slow. Disabling pre-caching.
                    # self._symbol_map = {}
                    # for symbol, group in self._master_list.groupby('SYMBOL_NAME'):
                    #     self._symbol_map[str(symbol)] = group
                    
                    logger.info("Master list loaded (Indexing skipped for performance)")
                else:
                    logger.warning(f"Master list loaded but is EMPTY. Check file content: {self._master_list_path}")
                
            except FileNotFoundError:
                logger.error(f"Master list file not found: {self._master_list_path}")
                self._master_list = pd.DataFrame()
            except Exception as e:
                logger.error(f"CRITICAL: Failed to load master list: {e}")
                import traceback
                logger.debug(traceback.format_exc())
                self._master_list = pd.DataFrame()
        return self._master_list

    # --- FAST INSTRUMENT LOOKUPS (Exact Match) ---

    def find_equity(self, symbol: str, exchange: str = "NSE") -> Optional[Dict]:
        """
        Fast lookup for Equity instruments.
        """
        df = self._load_master_list()
        symbol = symbol.upper()
        
        # Explicit lookup
        mask = (df['EXCH_ID'] == exchange) & \
               (df['INSTRUMENT'] == 'EQUITY') & \
               ((df['UNDERLYING_SYMBOL'] == symbol) | (df['SYMBOL_NAME'] == symbol))
        
        res = df[mask]
        return res.iloc[0].to_dict() if not res.empty else None

    def find_index(self, symbol: str, exchange: str = "NSE") -> Optional[Dict]:
        """
        Fast lookup for Index instruments.
        """
        df = self._load_master_list()
        symbol = symbol.upper()
        
        # Mapping for common aliases
        alias_map = {
            "NIFTY 50": "NIFTY",
            "NIFTY50": "NIFTY",
            "NIFTY BANK": "BANKNIFTY",
            "BANK NIFTY": "BANKNIFTY"
        }
        search_symbol = alias_map.get(symbol, symbol)
        
        lookup_exch = "NSE" if exchange.upper() == "IDX_I" else exchange.upper()
        
        # Explicit lookup
        mask = (df['EXCH_ID'] == lookup_exch) & \
               (df['INSTRUMENT'] == 'INDEX') & \
               (df['SYMBOL_NAME'] == search_symbol)
        
        res = df[mask]
        return res.iloc[0].to_dict() if not res.empty else None

    def find_future(self, underlying: str, expiry: Optional[str] = None, exchange: str = "NSE", instrument: str = "FUTIDX") -> Optional[Dict]:
        """
        Fast lookup for Futures.
        """
        df = self._load_master_list()
        underlying = underlying.upper()
        
        # Explicit lookup
        mask = (df['EXCH_ID'] == exchange) & \
               (df['INSTRUMENT'] == instrument) & \
               (df['UNDERLYING_SYMBOL'] == underlying)
        
        res = df[mask]
        if res.empty: return None
        
        # Sort by expiry to handle "nearest" logic
        res = res.sort_values(by='SM_EXPIRY_DATE')
        
        if expiry:
            match = res[res['SM_EXPIRY_DATE'] == expiry]
            return match.iloc[0].to_dict() if not match.empty else None
        
        return res.iloc[0].to_dict()

    def find_option(self, underlying: str, expiry: str, strike: float, option_type: str, exchange: str = "NSE", instrument: str = "OPTIDX") -> Optional[Dict]:
        """
        Fast lookup for Options.
        """
        df = self._load_master_list()
        underlying = underlying.upper()
        option_type = option_type.upper()
        
        # Explicit lookup
        mask = (df['EXCH_ID'] == exchange) & \
               (df['INSTRUMENT'] == instrument) & \
               (df['UNDERLYING_SYMBOL'] == underlying) & \
               (df['SM_EXPIRY_DATE'] == expiry) & \
               (df['STRIKE_PRICE'] == float(strike)) & \
               (df['OPTION_TYPE'] == option_type)
        
        res = df[mask]
        return res.iloc[0].to_dict() if not res.empty else None

    # --- EXPLICIT FETCHERS (LTP) ---

    def fetch_equity_ltp(self, symbol: str) -> float:
        """Fetch LTP for an equity symbol using fast lookup."""
        return self.get_ltp(symbol)

    def fetch_index_ltp(self, symbol: str) -> float:
        """Fetch LTP for an index symbol using fast lookup."""
        return self.get_ltp(symbol)

    def fetch_future_ltp(self, underlying: str, expiry: Optional[str] = None) -> float:
        """Fetch LTP for a future contract."""
        sec = self.find_future(underlying, expiry)
        if sec:
            return self.get_ltp(sec['SECURITY_ID'], sec['SEGMENT'])
        return 0.0

    def fetch_option_ltp(self, underlying: str, expiry: str, strike: float, option_type: str) -> float:
        """Fetch LTP for an option contract."""
        sec = self.find_option(underlying, expiry, strike, option_type)
        if sec:
            return self.get_ltp(sec['SECURITY_ID'], sec['SEGMENT'])
        return 0.0

    def get_security_id(
        self,
        symbol: Optional[str] = None,
        exchange: Optional[str] = None,
        segment: Optional[str] = None,
        instrument: Optional[str] = None,
        strike: Optional[float] = None,
        option_type: Optional[str] = None,
        expiry: Optional[str] = None,
        underlying_symbol: Optional[str] = None,
        return_multiple: bool = False,
        quiet: bool = False
    ) -> Optional[Dict | List[Dict]]:
        """
        Find security ID(s) from master list based on search criteria.
        
        Args:
            symbol: Symbol name or pattern (case-insensitive, partial match)
            exchange: Exchange code ("NSE", "BSE")
            segment: Segment code ("E", "D", "C", etc.)
            instrument: Instrument type ("EQUITY", "INDEX", "OPTIDX", "FUTIDX", etc.)
            strike: Strike price for options/futures
            option_type: Option type ("CE", "PE")
            expiry: Expiry date in "YYYY-MM-DD" format
            underlying_symbol: Underlying symbol for F&O contracts
            return_multiple: If True, return all matches; if False, return first match
            
        Returns:
            Dict with security details if found (or List of Dicts if return_multiple=True)
            None if no match found (or empty list if return_multiple=True)
        """
        df = self._load_master_list()
        
        if df.empty:
            logger.warning(f"Master list is empty. Path tried: {self._master_list_path}")
            return [] if return_multiple else None
        
        if symbol:
            symbol_str = str(symbol)
            symbol_up = symbol_str.upper()
            
            if symbol_str.isdigit():
                exact_match = df[df['SECURITY_ID'] == int(symbol_str)]
            elif symbol_up in self._symbol_map:
                exact_match = self._symbol_map[symbol_up]
            else:
                # 1. Try Exact Match First (Whole Dataframe) - includes UNDERLYING and DISPLAY
                exact_match = df[
                    (df['SYMBOL_NAME'].str.upper() == symbol_up) | 
                    (df['UNDERLYING_SYMBOL'].str.upper() == symbol_up) |
                    (df['DISPLAY_NAME'].str.upper() == symbol_up)
                ]
            
            if not exact_match.empty:
                # Prioritize EQUITY if available
                eq_match = exact_match[exact_match['INSTRUMENT'] == 'EQUITY']
                if not eq_match.empty:
                    result = eq_match
                else:
                    # For Indices, prioritize ID 13 (Nifty) and 25 (BankNifty)
                    if symbol_up in ["NIFTY 50", "NIFTY", "NIFTY50"]:
                        idx_match = exact_match[exact_match['SECURITY_ID'] == 13]
                        result = idx_match if not idx_match.empty else exact_match
                    elif symbol_up in ["BANKNIFTY", "NIFTY BANK", "BANK NIFTY"]:
                        idx_match = exact_match[exact_match['SECURITY_ID'] == 25]
                        result = idx_match if not idx_match.empty else exact_match
                    else:
                        result = exact_match
            else:
                # 2. Try partial match
                result = df[
                    df['SYMBOL_NAME'].str.contains(symbol, case=False, na=False) |
                    df['DISPLAY_NAME'].str.contains(symbol, case=False, na=False) |
                    df['UNDERLYING_SYMBOL'].str.contains(symbol, case=False, na=False)
                ]
        else:
            result = df.copy()
        
        # Apply other filters on top of result - Optimized Order
        if exchange:
            result = result[result['EXCH_ID'].str.upper() == exchange.upper()]
        
        if instrument:
            result = result[result['INSTRUMENT'].str.upper() == instrument.upper()]

        if underlying_symbol:
            # Prioritize exact match for underlying
            underlying_up = underlying_symbol.upper()
            exact_underlying = result[result['UNDERLYING_SYMBOL'].str.upper() == underlying_up]
            if not exact_underlying.empty:
                result = exact_underlying
            else:
                result = result[result['UNDERLYING_SYMBOL'].str.contains(underlying_symbol, case=False, na=False)]

        if expiry:
            result = result[result['SM_EXPIRY_DATE'] == expiry]

        if segment:
            result = result[result['SEGMENT'].str.upper() == segment.upper()]
        
        if strike is not None:
            result = result[result['STRIKE_PRICE'] == strike]
        
        if option_type:
            result = result[result['OPTION_TYPE'].str.upper() == option_type.upper()]
        
        # Return results
        if result.empty:
            if not quiet:
                search_desc = symbol or underlying_symbol or "criteria"
                logger.info(f"No matches found for: {search_desc}")
            return [] if return_multiple else None
        
        if not quiet:
            logger.info(f"Found {len(result)} match(es)")
        
        if return_multiple:
            return result.to_dict('records')
        else:
            return result.iloc[0].to_dict()

    def get_equity_id(
        self,
        symbol: str,
        exchange: str = "NSE",
        return_multiple: bool = False,
        quiet: bool = False
    ) -> Optional[Dict | List[Dict]]:
        """
        Quick lookup for equity securities.
        """
        return self.get_security_id(
            symbol=symbol,
            exchange=exchange,
            instrument="EQUITY",
            return_multiple=return_multiple,
            quiet=quiet
        )

    def get_index_id(
        self,
        symbol: str,
        exchange: str = "NSE",
        return_multiple: bool = False,
        quiet: bool = False
    ) -> Optional[Dict | List[Dict]]:
        """
        Quick lookup for index securities.
        """
        return self.get_security_id(
            symbol=symbol,
            exchange=exchange,
            instrument="INDEX",
            return_multiple=return_multiple,
            quiet=quiet
        )

    def get_option_id(
        self,
        underlying: str,
        strike: float,
        option_type: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "OPTIDX"
    ) -> Optional[Dict]:
        """
        Lookup option contract by strike and expiry.
        
        Args:
            underlying: Underlying symbol (e.g., "NIFTY", "BANKNIFTY")
            strike: Strike price
            option_type: "CE" for Call, "PE" for Put
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "OPTIDX" for index options, "OPTST K" for stock options
            
        Returns:
            Dict with option contract details or None
        """
        return self.get_security_id(
            underlying_symbol=underlying,
            strike=strike,
            option_type=option_type,
            expiry=expiry,
            exchange=exchange,
            instrument=instrument,
            return_multiple=False
        )

    def get_future_id(
        self,
        underlying: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "FUTIDX"
    ) -> Optional[Dict]:
        """
        Lookup future contract by expiry.
        
        Args:
            underlying: Underlying symbol (e.g., "NIFTY", "BANKNIFTY")
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "FUTIDX" for index futures, "FUTST K" for stock futures
            
        Returns:
            Dict with future contract details or None
        """
        return self.get_security_id(
            underlying_symbol=underlying,
            expiry=expiry,
            exchange=exchange,
            instrument=instrument,
            return_multiple=False
        )

    def search_symbols(
        self,
        pattern: str,
        limit: int = 10,
        exchange: Optional[str] = None,
        instrument: Optional[str] = None
    ) -> List[Dict]:
        """
        Fuzzy search for symbols matching a pattern.
        
        Args:
            pattern: Search pattern (case-insensitive)
            limit: Maximum number of results, default 10
            exchange: Optional exchange filter
            instrument: Optional instrument filter
            
        Returns:
            List of matching securities (up to limit)
        """
        results = self.get_security_id(
            symbol=pattern,
            exchange=exchange,
            instrument=instrument,
            return_multiple=True
        )
        
        if isinstance(results, list):
            return results[:limit]
        return []

    # --- CONVENIENCE WRAPPERS FOR F&O ---
    def get_option_quote(
        self,
        underlying: str,
        strike: float,
        option_type: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "OPTIDX"
    ) -> Optional[Dict]:
        """
        Get quote data for an option contract (combines lookup + quote fetch).
        
        Args:
            underlying: Underlying symbol (e.g., "NIFTY", "BANKNIFTY")
            strike: Strike price
            option_type: "CE" or "PE"
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "OPTIDX" for index options, "OPTSTK" for stock options
            
        Returns:
            Dict with quote data or None
        """
        # Find the option contract
        option = self.get_option_id(underlying, strike, option_type, expiry, exchange, instrument)
        
        if not option:
            logger.warning(f"Option not found: {underlying} {strike} {option_type} {expiry}")
            return None
        
        security_id = int(option['SECURITY_ID'])
        
        # Determine exchange segment for quote
        exchange_segment = "NSE_FNO" if exchange == "NSE" else "BSE_FNO"
        
        # Fetch quote
        try:
            res = self.dhan.quote_data(securities={exchange_segment: [security_id]})
        except Exception as e:
            logger.error(f"Exception fetching option quote: {e}")
            res = None

        quote = self._parse_market_data(res, exchange_segment, security_id)
        
        if quote:
            # Add contract details to quote
            quote['CONTRACT_INFO'] = {
                'SYMBOL': option['SYMBOL_NAME'],
                'STRIKE': strike,
                'OPTION_TYPE': option_type,
                'EXPIRY': expiry,
                'LOT_SIZE': option.get('LOT_SIZE')
            }
            return quote
        
        return None

    def get_option_ltp(
        self,
        underlying: str,
        strike: float,
        option_type: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "OPTIDX"
    ) -> float:
        """
        Get LTP for an option contract (combines lookup + LTP fetch).
        
        Args:
            underlying: Underlying symbol
            strike: Strike price
            option_type: "CE" or "PE"
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "OPTIDX" or "OPTSTK"
            
        Returns:
            LTP as float, 0.0 if not found
        """
        quote = self.get_option_quote(underlying, strike, option_type, expiry, exchange, instrument)
        if quote:
            return float(quote.get('LTP', 0) or quote.get('last_price', 0))
        return 0.0

    def get_future_quote(
        self,
        underlying: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "FUTIDX"
    ) -> Optional[Dict]:
        """
        Get quote data for a future contract (combines lookup + quote fetch).
        
        Args:
            underlying: Underlying symbol (e.g., "NIFTY", "BANKNIFTY")
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "FUTIDX" for index futures, "FUTSTK" for stock futures
            
        Returns:
            Dict with quote data or None
        """
        # Find the future contract
        future = self.get_future_id(underlying, expiry, exchange, instrument)
        
        if not future:
            logger.warning(f"Future not found: {underlying} {expiry}")
            return None
        
        security_id = int(future['SECURITY_ID'])
        
        # Determine exchange segment for quote
        exchange_segment = "NSE_FNO" if exchange == "NSE" else "BSE_FNO"
        
        # Fetch quote
        try:
            res = self.dhan.quote_data(securities={exchange_segment: [security_id]})
        except Exception as e:
            logger.error(f"Exception fetching future quote: {e}")
            res = None

        quote = self._parse_market_data(res, exchange_segment, security_id)
        
        if quote:
            # Add contract details to quote
            quote['CONTRACT_INFO'] = {
                'SYMBOL': future['SYMBOL_NAME'],
                'EXPIRY': expiry,
                'LOT_SIZE': future.get('LOT_SIZE')
            }
            return quote
            
        return None

    def get_future_ltp(
        self,
        underlying: str,
        expiry: str,
        exchange: str = "NSE",
        instrument: str = "FUTIDX"
    ) -> float:
        """
        Get LTP for a future contract (combines lookup + LTP fetch).
        
        Args:
            underlying: Underlying symbol
            expiry: Expiry date "YYYY-MM-DD"
            exchange: Exchange, default "NSE"
            instrument: "FUTIDX" or "FUTSTK"
            
        Returns:
            LTP as float, 0.0 if not found
        """
        quote = self.get_future_quote(underlying, expiry, exchange, instrument)
        if quote:
            return float(quote.get('LTP', 0) or quote.get('last_price', 0))
        return 0.0


    # --- SIMPLIFIED API FOR STRATEGY CODE ---
    
    def _resolve_symbol(self, symbol: str, instrument_hint: Optional[str] = None) -> Optional[Dict]:
        """
        Internal: Resolve symbol to security info with smart detection.
        """
        cache_key = f"{symbol}:{instrument_hint}"
        if cache_key in self._resolution_cache:
            return self._resolution_cache[cache_key]
            
        # Try exact match first (quietly)
        # Try equity first
        if not instrument_hint or instrument_hint == "EQUITY":
            result = self.get_equity_id(symbol, return_multiple=False, quiet=True)
            if result: 
                self._resolution_cache[cache_key] = result
                return result
        
        # Try index
        if not instrument_hint or instrument_hint == "INDEX":
            result = self.get_index_id(symbol, return_multiple=False, quiet=True)
            if result:
                self._resolution_cache[cache_key] = result
                return result
        
        # Fallback to general search (not quiet, so we know if it truly fails)
        result = self.get_security_id(symbol, instrument=instrument_hint, return_multiple=False)
        if result:
            self._resolution_cache[cache_key] = result
        return result
    
    def get_lot_size(self, symbol: str) -> int:
        """
        Fetch the lot size for a given symbol (Index/Equity/Derivative).
        
        Args:
            symbol: Symbol name (e.g., "NIFTY 50", "RELIANCE")
            
        Returns:
            Lot size as integer (defaults to 1 for Equities)
        """
        sec = self._resolve_symbol(symbol)
        if sec:
            instrument = sec.get('INSTRUMENT', '')
            if instrument == 'INDEX':
                underlying = sec.get('SYMBOL_NAME', symbol).upper()
                df = self._load_master_list()
                fo_contracts = df[
                    (df['UNDERLYING_SYMBOL'] == underlying) & 
                    (df['INSTRUMENT'].isin(['OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK']))
                ]
                if not fo_contracts.empty:
                    try:
                        return int(fo_contracts.iloc[0].get('LOT_SIZE', 1))
                    except:
                        pass
            try:
                return int(sec.get('LOT_SIZE', 1))
            except:
                return 1
        return 1
    
    def _auto_detect_segment(self, security_info: Dict) -> str:
        """
        Internal: Auto-detect exchange segment from security info.
        
        Args:
            security_info: Security information dict
            
        Returns:
            Exchange segment string (e.g., "NSE_EQ", "NSE_FNO")
        """
        instrument = security_info.get('INSTRUMENT', '')
        exchange = security_info.get('EXCH_ID', 'NSE')

        # MCX commodity instruments always use MCX_COMM
        if exchange == 'MCX':
            return 'MCX_COMM'

        # F&O instruments
        if instrument in ['OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK', 'OPTFUT', 'FUTCUR', 'OPTCUR']:
            return f"{exchange}_FNO"
        
        # Equity
        if instrument == 'EQUITY':
            return f"{exchange}_EQ"
        
        # Index
        if instrument == 'INDEX':
            if exchange == "NSE": return "IDX_I"
            if exchange == "BSE": return "BSE_IDX"
        
        # Default fallback
        return f"{exchange}_EQ"
    
    def _get_nearest_expiry(self, underlying_id: int, exchange_segment: str = "IDX_I") -> Optional[str]:
        """
        Internal: Get nearest expiry for an underlying.
        
        Args:
            underlying_id: Underlying security ID
            exchange_segment: Exchange segment
            
        Returns:
            Nearest expiry date string or None
        """
        expiries = self.get_expiry_list(underlying_id, exchange_segment)
        return expiries[0] if expiries else None
    
    # --- SIMPLIFIED METHODS ---
    
    def ltp(self, symbol_or_id: Any, exchange_segment: Optional[str] = None) -> float:
        """
        Simplified LTP call. Alias for get_ltp.
        """
        if exchange_segment:
             # If exact segment provided, we might want to pass it? 
             # But get_ltp expects 'exchange' (NSE/BSE).
             # If user passes "NSE_EQ", we should extract "NSE".
             exchange = exchange_segment.split('_')[0] if '_' in exchange_segment else "NSE"
             return self.get_ltp(symbol_or_id, exchange=exchange)
        return self.get_ltp(symbol_or_id)

    def bulk_ltp(self, symbols: List[str]) -> Dict[str, float]:
        """
        Fetch LTP for multiple symbols in a single API call.
        
        Args:
            symbols: List of symbols (e.g., ["TCS", "NIFTY 50", "RELIANCE"])
            
        Returns:
            Dict mapping symbol name to LTP float
        """
        mapping = {}
        securities_to_fetch = {}
        
        for sym in symbols:
            # Try fast lookup
            sec = self.find_equity(sym)
            if not sec:
                sec = self.get_security_id(sym, return_multiple=False) # Helper method handles fuzzy/index
                
            if sec:
                seg = sec['SEGMENT']
                sid = int(sec['SECURITY_ID'])
                
                # Correction: Map CSV Segment 'E' to API 'NSE_EQ' if needed
                # Same logic as get_latest_candles
                exch_id = sec.get('EXCH_ID', 'NSE')
                instr = sec.get('INSTRUMENT', 'EQUITY')
                api_seg = "NSE_EQ"
                if exch_id == "NSE":
                    if instr == "INDEX": api_seg = "IDX_I"
                    elif instr == "EQUITY": api_seg = "NSE_EQ"
                    else: api_seg = "NSE_FNO"
                elif exch_id == "BSE":
                    if instr == "EQUITY": api_seg = "BSE_EQ"
                    else: api_seg = "BSE_FNO"
                elif exch_id == "MCX": api_seg = "MCX_COMM"
                
                if api_seg not in securities_to_fetch:
                    securities_to_fetch[api_seg] = []
                securities_to_fetch[api_seg].append(sid)
                mapping[str(sid)] = sym
        
        if not securities_to_fetch:
            return {}
            
        if not securities_to_fetch:
            return {}
            
        results = {sym: 0.0 for sym in symbols}
            
        # Try ohlc_data first (Proven more reliable for Equities)
        try:
            res = self.dhan.ohlc_data(securities=securities_to_fetch)
        except Exception as e:
            logger.warning(f"Bulk ohlc_data raised an exception: {e}, falling back to sequential...")
            res = None
        
        # If bulk fails, fallback to sequential fetch to save what we can
        if not isinstance(res, dict) or res.get('status') != 'success':
            logger.warning("Bulk ohlc_data failed, trying individual fetches...")
            for sym in symbols:
                # Use simplified ltp() call which handles lookup & fetch
                 try:
                     val = self.ltp(sym)
                     if val > 0:
                         results[sym] = val
                 except: pass
            return results
        
        # Robust parsing for bulk data
        data = res.get('data', {})
        if isinstance(data, dict) and 'data' in data:
            data = data['data']
        
        # If data is not a dict (e.g. empty string on failure), return zeros
        if not isinstance(data, dict):
            logger.error(f"Bulk fetch failed parsing. Data: {data}")
            return results
            
        for segment, segment_data in data.items():
            if not isinstance(segment_data, dict): continue
            for sid, ticker in segment_data.items():
                if not isinstance(ticker, dict): continue
                sym_name = mapping.get(str(sid))
                if sym_name:
                    # ohlc_data returns 'close' or 'last_price' inside 'ohlc' dict sometimes?
                    # structure: {'last_price': ..., 'ohlc': {...}}
                    lp = float(ticker.get('last_price', 0))
                    if lp == 0 and 'ohlc' in ticker:
                         lp = float(ticker['ohlc'].get('close', 0))
                    results[sym_name] = lp
                    
        return results
    
    def ohlc(self, symbol_or_id: Any, exchange_segment: Optional[str] = None) -> Dict:
        """
        Simplified OHLC call. Alias for get_ohlc.
        """
        # Smart resolution if string symbol passed without explicit segment
        if not exchange_segment and isinstance(symbol_or_id, str) and not symbol_or_id.isdigit():
             sec = self._resolve_symbol(symbol_or_id)
             if sec:
                 return self.get_ohlc(
                     symbol=sec['SECURITY_ID'],
                     exchange=sec.get('EXCH_ID', 'NSE'),
                     instrument=sec.get('INSTRUMENT', 'EQUITY')
                 )

        if exchange_segment:
             exchange = exchange_segment.split('_')[0] if '_' in exchange_segment else "NSE"
             return self.get_ohlc(symbol_or_id, exchange=exchange)
        return self.get_ohlc(symbol_or_id)
    
    def option(
        self,
        underlying: str,
        strike: float,
        option_type: str,
        expiry_index: int = 0,
        exchange: str = "NSE"
    ) -> Optional[Dict]:
        """
        Get option quote with smart defaults (uses nearest expiry by default).
        """
        # Resolve underlying info to get segments and expiries
        und = self.find_equity(underlying)
        if not und:
            und = self.get_security_id(underlying, quiet=True)
            
        if not und:
            logger.warning(f"Underlying not found: {underlying}")
            return None
            
        api_seg = self._auto_detect_segment(und)
        expiries = self.get_expiry_list(int(und['SECURITY_ID']), api_seg)
        if not expiries or expiry_index >= len(expiries):
            logger.warning(f"No expiry available at index {expiry_index}")
            return None
            
        expiry = expiries[expiry_index]
        
        # Fast option lookup
        sec = self.find_option(underlying, expiry, strike, option_type)
        if not sec:
            # Fallback (rarely needed if master list is good)
            sec = self.get_option_id(underlying, strike, option_type, expiry)
            
        if not sec:
            return None
            
        res = self.get_ohlc(
            symbol=int(sec['SECURITY_ID']),
            exchange=sec.get('EXCH_ID', 'NSE'),
            instrument=sec.get('INSTRUMENT', 'OPTIDX')
        )
        if res:
            res['CONTRACT_INFO'] = sec.to_dict() if hasattr(sec, 'to_dict') else dict(sec)
        return res
    
    def future(
        self,
        underlying: str,
        expiry_index: int = 0,
        exchange: str = "NSE"
    ) -> Optional[Dict]:
        """
        Get future quote with smart defaults (uses nearest expiry by default).
        """
        # Resolve underlying info
        und = self.find_equity(underlying)
        if not und:
            und = self.get_security_id(underlying, quiet=True)
            
        if not und:
            logger.warning(f"Underlying not found: {underlying}")
            return None
            
        api_seg = self._auto_detect_segment(und)
        expiries = self.get_expiry_list(int(und['SECURITY_ID']), api_seg)
        if not expiries or expiry_index >= len(expiries):
            logger.warning(f"No expiry available at index {expiry_index}")
            return None
            
        expiry = expiries[expiry_index]
        
        # Fast future lookup
        sec = self.find_future(underlying, expiry)
        if not sec:
            # Fallback
            sec = self.get_future_id(underlying, expiry)
            
        if not sec:
            return None
            
        res = self.get_ohlc(
            symbol=int(sec['SECURITY_ID']),
            exchange=sec.get('EXCH_ID', 'NSE'),
            instrument=sec.get('INSTRUMENT', 'FUTIDX')
        )
        if res:
            res['CONTRACT_INFO'] = sec.to_dict() if hasattr(sec, 'to_dict') else dict(sec)
        return res
    
    def buy(self, symbol: str, qty: int, price: Optional[float] = None, product: str = "INTRADAY") -> Optional[str]:
        """
        Place a BUY order. If price is None, it's a MARKET order.
        Accepts numeric security-ID strings (e.g. "56384") as well as symbol names.
        """
        sec = self.get_security_id(symbol, quiet=True)

        if not sec:
            logger.error(f"Could not resolve symbol for buy order: {symbol}")
            return None

        # _auto_detect_segment maps raw SEGMENT codes (D/E/I) -> NSE_FNO / NSE_EQ etc.
        exch_seg = self._auto_detect_segment(sec)
        return self.place_order(
            security_id=int(sec['SECURITY_ID']),
            exchange_segment=exch_seg,
            transaction_type=self.BUY,
            quantity=qty,
            order_type=self.LIMIT if price else self.MARKET,
            product_type=product,
            price=price or 0.0
        )

    def sell(self, symbol: str, qty: int, price: Optional[float] = None, product: str = "INTRADAY") -> Optional[str]:
        """
        Place a SELL order. If price is None, it's a MARKET order.
        Accepts numeric security-ID strings (e.g. "56384") as well as symbol names.
        """
        sec = self.get_security_id(symbol, quiet=True)

        if not sec:
            logger.error(f"Could not resolve symbol for sell order: {symbol}")
            return None

        # _auto_detect_segment maps raw SEGMENT codes (D/E/I) -> NSE_FNO / NSE_EQ etc.
        exch_seg = self._auto_detect_segment(sec)
        return self.place_order(
            security_id=int(sec['SECURITY_ID']),
            exchange_segment=exch_seg,
            transaction_type=self.SELL,
            quantity=qty,
            order_type=self.LIMIT if price else self.MARKET,
            product_type=product,
            price=price or 0.0
        )
    
    def positions(self) -> pd.DataFrame:
        """
        Get current positions (simplified, no parameters needed).
        
        Returns:
            DataFrame with positions
            
        Example:
            >>> positions = helper.positions()
            >>> print(positions[['tradingSymbol', 'netQty', 'realizedProfit']])
        """
        return self.get_positions()
    
    def holdings(self) -> pd.DataFrame:
        """
        Get current holdings (simplified, no parameters needed).
        
        Returns:
            DataFrame with holdings
            
        Example:
            >>> holdings = helper.holdings()
            >>> print(holdings[['tradingSymbol', 'totalQty', 'avgCostPrice']])
        """
        return self.get_holdings()
    
    def funds(self) -> float:
        """
        Get available funds (simplified, returns just the number).
        
        Returns:
            Available funds as float
            
        Example:
            >>> balance = helper.funds()
            >>> print(f"Available: Rs. {balance}")
        """
        return self.get_available_funds()



    # --- FUND MANAGEMENT ---
    def get_fund_details(self) -> Dict:
        """
        Fetch complete fund limits from the account.

        Returns all fields from the /fundlimit API response:
            availabelBalance, sodLimit, collateralAmount, receiveableAmount,
            utilizedAmount, blockedPayoutAmount, withdrawableBalance.
        """
        try:
            res = self.dhan.get_fund_limits()
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data') or {}
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch fund details: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_fund_details: {e}")
        return {}

    def get_available_funds(self) -> float:
        """Fetch available margin in the account."""
        data = self.get_fund_details()
        # Handle misspelled API field and standard fallbacks
        funds = data.get('availabelBalance') or data.get('availableBalance') or data.get('availabelMargin') or 0.0
        return float(funds)

    def get_margin_required(self, symbol: str, quantity: int, direction: str,
                          order_type: str = "MARKET", product_type: str = "MARGIN",
                          price: float = 0.0, trigger_price: float = 0.0) -> Dict:
        """
        Calculate required margin for a trade.
        
        Args:
            symbol: Trading symbol (e.g., 'RELIANCE', 'NIFTY 50')
            quantity: Quantity to trade
            direction: 'BUY' or 'SELL'
            order_type: 'MARKET', 'LIMIT', etc.
            product_type: 'CNC', 'MARGIN', 'INTRADAY', etc.
            price: Order price (if 0.0, uses current LTP)
            trigger_price: Trigger price for SL orders
            
        Returns:
            Dictionary with margin details or empty dict on failure.
        """
        try:
            sec = self._resolve_symbol(symbol)
            if not sec:
                logger.error(f"Symbol not found for margin calculation: {symbol}")
                return {}
            
            # If market order and price is 0, fetch LTP
            calc_price = price
            if calc_price == 0.0:
                calc_price = self.get_ltp(symbol)
                
            # Detect segment (API format like NSE_EQ)
            segment = self._auto_detect_segment(sec)
            
            # Correct SDK signature: (security_id, exchange_segment, transaction_type, quantity, product_type, price, trigger_price=0)
            res = self.dhan.margin_calculator(
                security_id=str(sec['SECURITY_ID']),
                exchange_segment=segment,
                transaction_type=direction.upper(),
                quantity=int(quantity),
                product_type=product_type.upper(),
                price=float(calc_price),
                trigger_price=float(trigger_price)
            )
            
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', {})
            
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Margin calculation failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_margin_required: {e}")
        return {}

    def get_margin_calculator_multi(
        self,
        scripts: List[Dict],
        include_position: bool = True,
        include_orders: bool = True
    ) -> Dict:
        """
        Calculate combined margin for multiple orders in a single API call.
        Uses POST /margincalculator/multi.

        Args:
            scripts: List of order dicts, each with keys:
                exchangeSegment (str), transactionType (str), quantity (int),
                productType (str), securityId (str), price (float),
                triggerPrice (float, optional)
            include_position: Include existing positions in margin calculation.
            include_orders:   Include open orders in margin calculation.

        Returns:
            Dict with keys: total_margin, span_margin, exposure_margin,
            equity_margin, fo_margin, commodity_margin, currency, hedge_benefit.
            Empty dict on failure.

        Example::

            scripts = [
                {"exchangeSegment": "NSE_FNO", "transactionType": "SELL",
                 "quantity": 75, "productType": "MARGIN",
                 "securityId": "52175", "price": 200.0},
            ]
            margin = helper.get_margin_calculator_multi(scripts)
            print(f"Total margin required: {margin.get('total_margin')}")
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("get_margin_calculator_multi: dhan_http not accessible.")
                return {}

            # SDK _send_request auto-injects dhanClientId on every POST — no need to set it here.
            # Key is "scripList" per Dhan API curl examples (consistent with their "availabelBalance" style).
            payload = {
                "includePosition": include_position,
                "includeOrders": include_orders,
                "scripList": scripts,
            }

            time.sleep(1)  # Rate limit protection (consistent with other API calls in this file)
            res = dhan_http.post('/margincalculator/multi', payload)

            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data') or {}

            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Multi-margin calculation failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_margin_calculator_multi: {e}")
        return {}

    # --- PORTFOLIO ---
    def get_positions(self) -> pd.DataFrame:
        """Fetch current day positions as a Pandas DataFrame."""
        try:
            res = self.dhan.get_positions()
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', [])
                return pd.DataFrame(data)
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch positions: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_positions: {e}")
        return pd.DataFrame()

    def get_holdings(self) -> pd.DataFrame:
        """Fetch current holdings as a Pandas DataFrame."""
        try:
            res = self.dhan.get_holdings()
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', [])
                return pd.DataFrame(data)
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch holdings: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_holdings: {e}")
        return pd.DataFrame()

    def convert_position(
        self,
        security_id: str,
        trading_symbol: str,
        exchange_segment: str,
        position_type: str,
        convert_qty: int,
        from_product_type: str,
        to_product_type: str,
    ) -> bool:
        """
        Convert a position between product types (e.g. INTRADAY ↔ CNC/MARGIN).
        Maps to POST /positions/convert.

        Args:
            security_id:       Security ID of the position.
            trading_symbol:    Trading symbol (e.g. "RELIANCE-EQ").
            exchange_segment:  e.g. "NSE_EQ", "NSE_FNO".
            position_type:     "LONG" or "SHORT".
            convert_qty:       Number of shares/lots to convert.
            from_product_type: Current product type ("INTRADAY", "CNC", "MARGIN").
            to_product_type:   Target product type ("INTRADAY", "CNC", "MARGIN").

        Returns:
            True if conversion was accepted (HTTP 202), False otherwise.
        """
        try:
            res = self.dhan.convert_position(
                security_id=str(security_id),
                trading_symbol=trading_symbol,
                exchange_segment=exchange_segment,
                position_type=position_type.upper(),
                convert_qty=int(convert_qty),
                from_product_type=from_product_type.upper(),
                to_product_type=to_product_type.upper(),
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(
                    f"Position converted: {trading_symbol} {convert_qty} qty "
                    f"{from_product_type} → {to_product_type}"
                )
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Position conversion failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in convert_position: {e}")
        return False

    def exit_all_positions(self) -> bool:
        """
        Liquidate all active positions and cancel all pending orders in one API call.
        Maps to DELETE /positions.

        Returns:
            True if the request was accepted, False otherwise.

        Note:
            This is an atomic broker-side liquidation. For granular control (e.g.
            closing individual legs), use close_all_positions() instead which places
            individual market orders per position.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("exit_all_positions: dhan_http not accessible.")
                return False
            res = dhan_http.delete('/positions')
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.warning("exit_all_positions: All positions liquidated and pending orders cancelled.")
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"exit_all_positions failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in exit_all_positions: {e}")
        return False

    # --- ORDER MANAGEMENT ---
    def place_order(self,
                    security_id: str, 
                    exchange_segment: Any, 
                    transaction_type: Any, 
                    quantity: int, 
                    order_type: Any = None, 
                    product_type: Any = None, 
                    price: float = 0, 
                    trigger_price: float = 0,
                    **kwargs) -> Optional[str]:
        """
        Generalized order placement helper.
        Returns order_id if successful, None otherwise.
        Accepts extra kwargs (e.g. after_market_order=True, amo_time='OPEN')
        
        NOTE: Manually handling AMO due to bug in current dhanhq SDK where amoTime is dropped.
        """
        order_type = order_type or self.MARKET
        product_type = product_type or self.INTRA
        
        # Normalize product_type in case 'INTRA' is passed
        if isinstance(product_type, str) and product_type.upper() == "INTRA":
            product_type = "INTRADAY"
        
        try:
            # Check for AMO parameters in kwargs
            after_market_order = kwargs.get('after_market_order', False) or kwargs.get('afterMarketOrder', False)
            
            if after_market_order:
                # SDK BUG WORKAROUND: Construct payload manually
                amo_time = kwargs.get('amo_time', 'OPEN')
                validity = kwargs.get('validity', 'DAY')
                disclosed_quantity = kwargs.get('disclosed_quantity', 0)
                tag = kwargs.get('tag', '')
                
                payload = {
                    "transactionType": transaction_type.upper(),
                    "exchangeSegment": exchange_segment.upper(),
                    "productType": product_type.upper(),
                    "orderType": order_type.upper(),
                    "validity": validity.upper(),
                    "securityId": str(security_id),
                    "quantity": int(quantity),
                    "disclosedQuantity": int(disclosed_quantity),
                    "price": float(price),
                    "afterMarketOrder": True,
                    "amoTime": amo_time,
                    "triggerPrice": float(trigger_price)
                }
                
                # Optional fields
                if kwargs.get('bo_profit_value'): payload["boProfitValue"] = kwargs.get('bo_profit_value')
                if kwargs.get('bo_stop_loss_Value'): payload["boStopLossValue"] = kwargs.get('bo_stop_loss_Value')
                if tag: payload["correlationId"] = tag
                    
                logger.debug(f"Placing AMO with Manual Payload: {payload}")
                res = self.dhan.dhan_http.post('/orders', payload)
            else:
                # Normal path
                res = self.dhan.place_order(
                    security_id=str(security_id),
                    exchange_segment=exchange_segment,
                    transaction_type=transaction_type,
                    quantity=quantity,
                    order_type=order_type,
                    product_type=product_type,
                    price=price,
                    trigger_price=trigger_price,
                    **kwargs
                )

            if isinstance(res, dict) and res.get('status') == 'success':
                order_id = res.get('data', {}).get('orderId')
                logger.info(f"Order Placed Successfully! Order ID: {order_id}")
                return order_id
            else:
                error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
                logger.error(f"Order Placement Failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in place_order: {e}")
        return None

    def get_order_status(self, order_id: str) -> Optional[str]:
        """Fetch status of a specific order."""
        try:
            # SDK Quirks: Sometimes returns a list of results, or throws an error on non-existent IDs
            try:
                res = self.dhan.get_order_by_id(order_id)
            except Exception:
                # Any SDK internal failure here implies order likely not found or API error
                return None
            
            # Handle list response if SDK returns it
            if isinstance(res, list) and len(res) > 0:
                res = res[0]
                
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                # Handle list format in data returned by Dhan API for get_order_by_id
                if isinstance(data, list):
                    if len(data) > 0:
                        return data[0].get('orderStatus')
                    return None # Empty list indicates order not found
                elif isinstance(data, dict):
                    return data.get('orderStatus')
                return None # data is [], meaning not found
            
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch order status for {order_id}: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_order_status for {order_id}: {e}")
        return None

    def is_order_filled(self, order_id: str) -> bool:
        """Non-blocking: Check if an order is fully executed."""
        status = self.get_order_status(order_id)
        # Dhan statuses: TRADED, PART_TRADED, PENDING, TRANSIT, CANCELLED, REJECTED, EXPIRED
        return status == "TRADED"

    def wait_for_fill(self, order_id: str, timeout: int = 30, poll_interval: float = 0.5) -> bool:
        """Blocking: Wait until the order is filled or timeout reached."""
        start_time = time.time()
        logger.info(f"Waiting for order {order_id} to fill (Max {timeout}s)...")

        while time.time() - start_time < timeout:
            status = self.get_order_status(order_id)
            if status == "TRADED":
                logger.info(f"Order {order_id} filled.")
                return True
            if status in ["CANCELLED", "REJECTED", "EXPIRED"]:
                logger.warning(f"Order {order_id} terminated with status: {status}")
                return False

            time.sleep(poll_interval)

        logger.warning(f"Timeout reached while waiting for order {order_id} to fill.")
        return False

    def modify_order(self,
                    order_id: str,
                    quantity: int,
                    order_type: Any,
                    price: float = 0,
                    trigger_price: float = 0,
                    leg_name: str = 'ENTRY_LEG',
                    validity: str = 'DAY',
                    disclosed_quantity: int = 0) -> bool:
        """Modify an existing pending order. leg_name: 'ENTRY_LEG' (default), 'TARGET_LEG', or 'STOP_LOSS_LEG' for BO/CO orders."""
        try:
            res = self.dhan.modify_order(
                order_id=order_id,
                order_type=order_type,
                leg_name=leg_name,
                quantity=quantity,
                price=price,
                trigger_price=trigger_price,
                disclosed_quantity=disclosed_quantity,
                validity=validity,
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Order {order_id} modified successfully.")
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Order modification failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in modify_order: {e}")
        return False

    # --- MARKET DATA ---
    def _parse_market_data(self, response: Dict, segment: str, security_id: Any) -> Dict:
        """Helper to parse triple-nested data from Dhan response."""
        if not isinstance(response, dict):
            logger.error(f"API Response is not a dict: {response}")
            return {}
        if response.get('status') != 'success':
            logger.error(f"API Response Failure: {response.get('remarks')}")
            return {}
        
        # Handle triple nesting: res['data']['data'][segment][id]
        data = response.get('data', {})
        if isinstance(data, dict) and 'data' in data:
            data = data['data']
        
        segment_data = data.get(segment, {})
        if not segment_data:
            logger.warning(f"No data for segment: {segment}. Available: {list(data.keys())}")
            return {}
            
        ticker = segment_data.get(str(security_id)) or segment_data.get(int(security_id))
        if not ticker:
            logger.warning(f"No data for ID: {security_id} in segment {segment}. Available IDs: {list(segment_data.keys())}")
            return {}
            
        # Flatten OHLC if present
        if 'ohlc' in ticker and isinstance(ticker['ohlc'], dict):
            ticker.update(ticker['ohlc'])
            
        return ticker

    def get_ltp(self, symbol: Any, exchange: str = "NSE", instrument: str = "EQUITY", expiry: Optional[str] = None, strike: Optional[float] = None, option_type: Optional[str] = None) -> float:
        """
        Get Last Traded Price with explicit lookup parameters.
        Priority:
        1. live_data (WebSocket)
        2. _ltp_cache (1-second memory cache)
        3. API (ohlc_data -> quote_data)
        """
        # --- PHASE 0: Resolve SID ---
        try:
            if str(symbol).isdigit():
                sid = int(symbol)
            else:
                sec = None
                if instrument == "INDEX":
                    sec = self.find_index(symbol, exchange)
                elif instrument == "EQUITY":
                    sec = self.find_equity(symbol, exchange)
                elif instrument in ["FUTIDX", "FUTSTK"]:
                    sec = self.find_future(symbol, expiry, exchange, instrument)
                elif instrument in ["OPTIDX", "OPTSTK"]:
                    if strike is None or option_type is None:
                        logger.error("Strike and Option Type required for Options")
                        return 0.0
                    sec = self.find_option(symbol, expiry, strike, option_type, exchange, instrument)
                else:
                    logger.warning(f"Unknown instrument type: {instrument}")
                    return 0.0

                if not sec:
                    logger.warning(f"Security not found for {symbol} ({instrument})")
                    return 0.0
                sid = int(sec['SECURITY_ID'])

            # --- PHASE 1: Priority Check (Live & Cache) ---
            sid_str = str(sid)
            
            # 1. WebSocket Priority (Check live_data for ANY segment)
            if sid_str in self.live_data:
                live = self.live_data[sid_str]
                # MarketFeed v2 uses 'LTP' or 'last_price' depending on request code
                price = float(live.get('last_price') or live.get('LTP') or 0.0)
                if price > 0:
                    return price

            # 2. Memory Cache (1 second)
            if sid in self._ltp_cache:
                cached_price, cached_time = self._ltp_cache[sid]
                if time.time() - cached_time < 1.0:
                    return cached_price

            # --- PHASE 2: API Call (Rate Limited Safety) ---
            # If we reach here, WebSocket is either not used for this SID or disconnected.
            # We add a mandatory sleep to avoid hitting Dhan's 120-250 calls/min limit.
            time.sleep(2) 
            
            # Derive API segment
            api_seg = exchange # Default to what user passed
            if exchange == "NSE":
                if instrument == "INDEX": api_seg = "IDX_I"
                elif instrument == "EQUITY": api_seg = "NSE_EQ"
                else: api_seg = "NSE_FNO"
            elif exchange == "BSE":
                if instrument == "EQUITY": api_seg = "BSE_EQ"
                else: api_seg = "BSE_FNO"
            elif exchange == "MCX":
                api_seg = "MCX_COMM"
            
            # If exchange already contains segment suffix, trust it
            if "_" in str(exchange) or str(exchange) == "IDX_I":
                api_seg = exchange

            instruments = {api_seg: [sid]}
            
            # Use ohlc_data as primary source
            res = self.dhan.ohlc_data(securities=instruments)
            ticker_data = self._parse_market_data(res, api_seg, sid)
            price = float(ticker_data.get('last_price', 0))
            
            if not isinstance(res, dict) or res.get('status') != 'success' or price == 0.0:
                 # Fallback to quote_data
                 logger.debug(f"ohlc_data failed or empty for {instruments}, trying quote_data...")
                 try:
                     res = self.dhan.quote_data(securities=instruments)
                 except Exception as e:
                     logger.error(f"Exception fetching quote in get_ltp fallback: {e}")
                     res = None
                 ticker_data = self._parse_market_data(res, api_seg, sid)
                 price = float(ticker_data.get('last_price', 0))
            
            if price > 0:
                self._ltp_cache[sid] = (price, time.time())
                return price
            
            if not isinstance(res, dict) or res.get('status') != 'success':
                logger.error(f"API Response Failure for {instruments}: {res}")
                return 0.0
            
            return price
        except Exception as e:
            logger.error(f"Exception in get_ltp: {e}")
        return 0.0

    def get_ohlc(self, symbol: Any, exchange: str = "NSE", instrument: str = "EQUITY", expiry: Optional[str] = None, strike: Optional[float] = None, option_type: Optional[str] = None) -> Dict:
        """
        Get OHLC with explicit lookup parameters.
        """
        time.sleep(1)
        try:
            # Case 1: Direct Security ID
            if str(symbol).isdigit():
                sid = int(symbol)
                # seg = exchange # Legacy usage
            else:
                # Case 2: Explicit Lookup
                sec = None
                
                if instrument == "INDEX":
                    sec = self.find_index(symbol, exchange)
                elif instrument == "EQUITY":
                    sec = self.find_equity(symbol, exchange)
                elif instrument in ["FUTIDX", "FUTSTK"]:
                    sec = self.find_future(symbol, expiry, exchange, instrument)
                elif instrument in ["OPTIDX", "OPTSTK"]:
                    if strike is None or option_type is None:
                        logger.error("Strike and Option Type required for Options")
                        return {}
                    sec = self.find_option(symbol, expiry, strike, option_type, exchange, instrument)
                
                if not sec:
                    logger.warning(f"Security not found for {symbol} ({instrument})")
                    return {}
                
                sid = int(sec['SECURITY_ID'])
            
            # Derive API segment
            api_seg = exchange # Default to what user passed
            if exchange == "NSE":
                if instrument == "INDEX": api_seg = "IDX_I"
                elif instrument == "EQUITY": api_seg = "NSE_EQ"
                else: api_seg = "NSE_FNO"
            elif exchange == "BSE":
                if instrument == "EQUITY": api_seg = "BSE_EQ"
                else: api_seg = "BSE_FNO"
            elif exchange == "MCX":
                api_seg = "MCX_COMM"
            
            # If exchange already contains segment suffix, trust it
            if "_" in str(exchange):
                api_seg = exchange

            instruments = {api_seg: [sid]}
            
            # Use ohlc_data as primary source (Verified working for NSE_EQ)
            try:
                res = self.dhan.ohlc_data(securities=instruments)
            except Exception as e:
                logger.error(f"Exception calling ohlc_data in get_ohlc: {e}")
                res = None
            
            if not isinstance(res, dict) or res.get('status') != 'success':
                 # Fallback
                 logger.debug(f"ohlc_data failed or empty for {instruments}, trying quote_data in get_ohlc...")
                 try:
                     res = self.dhan.quote_data(securities=instruments)
                 except Exception as e:
                     logger.error(f"Exception calling quote_data fallback in get_ohlc: {e}")
                     res = None
                 
            return self._parse_market_data(res, api_seg, sid)
        except Exception as e:
            logger.error(f"Exception in get_ohlc: {e}")
        return {}

    def get_historical_data(self, 
                            security_id: str, 
                            exchange_segment: str, 
                            instrument_type: str, 
                            from_date: str, 
                            to_date: str, 
                            interval: str = "DAILY",
                            oi: bool = False,
                            expiry_code: int = 0) -> pd.DataFrame:
        """
        Fetch historical data.
        interval: "DAILY" or minute intervals (e.g., "1", "5", "15", "60")
        """
        try:
            if interval.upper() == "DAILY":
                res = self.dhan.historical_daily_data(
                    security_id=str(security_id),
                    exchange_segment=exchange_segment,
                    instrument_type=instrument_type,
                    from_date=from_date,
                    to_date=to_date,
                    expiry_code=expiry_code,
                    oi=oi
                )
            else:
                res = self.dhan.intraday_minute_data(
                    security_id=str(security_id),
                    exchange_segment=exchange_segment,
                    instrument_type=instrument_type,
                    interval=interval,
                    from_date=from_date,
                    to_date=to_date,
                    oi=oi
                )
            
            if isinstance(res, dict) and res.get('status') == 'success':
                return pd.DataFrame(res.get('data', []))
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Historical data fetch failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_historical_data: {e}")
        return pd.DataFrame()

    def get_prev_day_levels(self, symbol: str = "NIFTY", days_back: int = 5) -> Optional[Dict[str, float]]:
        """
        Fetch the previous trading day's High (PDH), Low (PDL), and Close (PDC)
        for any index or equity symbol.

        Automatically resolves the symbol to its security_id, exchange_segment,
        and instrument_type using the master list, then fetches daily OHLC data
        and returns the most recent completed day's values.

        Args:
            symbol:    Symbol name as it appears in the master list.
                       - For Nifty 50 index: "NIFTY"
                       - For BankNifty index: "BANKNIFTY"
                       - For stocks: "RELIANCE", "TCS", etc.
            days_back: How many calendar days to look back when fetching history
                       to ensure at least 2 trading days of data are returned.
                       Default is 5 (handles long weekends & exchange holidays).

        Returns:
            Dict with keys 'high', 'low', 'close' as floats if successful.
            Returns None if data cannot be fetched (e.g., bad symbol, API error).

        Example::

            levels = helper.get_prev_day_levels("NIFTY")
            if levels:
                print(f"PDH: {levels['high']}, PDL: {levels['low']}, PDC: {levels['close']}")

            # For BankNifty
            bn_levels = helper.get_prev_day_levels("BANKNIFTY")

            # For equities
            rel_levels = helper.get_prev_day_levels("RELIANCE")
        """
        from datetime import timedelta

        try:
            # --- 1. Resolve symbol to security info ---
            sec = None
            symbol_up = symbol.upper()

            # Try index first (covers NIFTY, BANKNIFTY, etc.)
            sec = self.find_index(symbol_up, exchange="IDX_I")
            if sec:
                exchange_segment = "IDX_I"
                instrument_type  = "INDEX"
            else:
                # Try equity
                sec = self.find_equity(symbol_up)
                if sec:
                    exchange_segment = "NSE_EQ"
                    instrument_type  = "EQUITY"
                else:
                    logger.warning(f"get_prev_day_levels: Symbol '{symbol}' not found in master list.")
                    return None

            security_id = str(int(sec.get("SECURITY_ID", 0)))
            if security_id == "0":
                logger.warning(f"get_prev_day_levels: Could not resolve SECURITY_ID for '{symbol}'.")
                return None

            # --- 2. Build date range ---
            today     = datetime.now().date()
            from_date = (today - timedelta(days=days_back)).strftime("%Y-%m-%d")
            to_date   = today.strftime("%Y-%m-%d")

            logger.info(f"Fetching previous day OHLC for {symbol_up} (ID: {security_id}) ...")
            hist_df = self.get_historical_data(
                security_id      = security_id,
                exchange_segment = exchange_segment,
                instrument_type  = instrument_type,
                from_date        = from_date,
                to_date          = to_date,
                interval         = "DAILY"
            )

            if hist_df.empty or len(hist_df) < 2:
                logger.warning(
                    f"get_prev_day_levels: Not enough historical rows for '{symbol}' "
                    f"({len(hist_df)} row(s) returned). Need at least 2."
                )
                return None

            # --- 3. Normalise column names (API may return 'high'/'h', 'low'/'l', 'close'/'c') ---
            col_map = {}
            for col in hist_df.columns:
                col_lower = col.lower()
                if col_lower in ("high",  "h"): col_map[col] = "high"
                elif col_lower in ("low",  "l"): col_map[col] = "low"
                elif col_lower in ("close","c"): col_map[col] = "close"
            hist_df = hist_df.rename(columns=col_map)

            if not all(k in hist_df.columns for k in ("high", "low", "close")):
                logger.warning(
                    f"get_prev_day_levels: Unexpected columns in history response: {list(hist_df.columns)}"
                )
                return None

            # The last row is today's partial/ongoing candle; second-to-last is previous day
            prev_row = hist_df.iloc[-2]
            levels = {
                "high":  float(prev_row["high"]),
                "low":   float(prev_row["low"]),
                "close": float(prev_row["close"]),
            }

            # --- 4. Log a clean banner ---
            separator = "=" * 60
            logger.info(separator)
            logger.info(f"        {symbol_up} — PREVIOUS DAY KEY LEVELS")
            logger.info(separator)
            logger.info(f"  PDH  (Previous Day High)  : {levels['high']:.2f}")
            logger.info(f"  PDL  (Previous Day Low)   : {levels['low']:.2f}")
            logger.info(f"  PDC  (Previous Day Close) : {levels['close']:.2f}")
            logger.info(separator)

            return levels

        except Exception as e:
            logger.error(f"get_prev_day_levels: Exception for '{symbol}': {e}")
            return None

    # --- BULK OPERATIONS ---
    def cancel_all_orders(self) -> int:
        """Cancel all pending orders. Returns count of successfully cancelled orders."""
        cancelled_count = 0
        try:
            res = self.dhan.get_order_list()
            if isinstance(res, dict) and res.get('status') == 'success':
                orders = res.get('data', [])
                for order in orders:
                    if order.get('orderStatus') in ['PENDING', 'TRANSIT']:
                        cancel_res = self.dhan.cancel_order(order.get('orderId'))
                        if isinstance(cancel_res, dict) and cancel_res.get('status') == 'success':
                            cancelled_count += 1
            else:
                error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
                logger.error(f"Failed to fetch order list for cancellation: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in cancel_all_orders: {e}")
        return cancelled_count

    def close_all_positions(self) -> int:
        """
        Close all open positions by placing market orders of opposite transaction type.
        Returns count of positions successfully closed (orders placed).
        """
        closed_count = 0
        try:
            positions = self.get_positions()
            if positions.empty:
                return 0
            
            for _, pos in positions.iterrows():
                net_qty = int(pos.get('netQty', 0))
                if net_qty == 0:
                    continue
                
                # Opposite transaction type
                tx_type = self.SELL if net_qty > 0 else self.BUY
                order_id = self.place_order(
                    security_id=pos.get('securityId'),
                    exchange_segment=pos.get('exchangeSegment'),
                    transaction_type=tx_type,
                    quantity=abs(net_qty),
                    order_type=self.MARKET,
                    product_type=pos.get('productType')
                )
                if order_id:
                    closed_count += 1
        except Exception as e:
            logger.error(f"Exception in close_all_positions: {e}")
        return closed_count

    # --- TRADER'S CONTROL (KILL SWITCH) ---
    def get_kill_switch_status(self) -> str:
        """
        Check if the Kill Switch is active for the account.
        Returns 'ACTIVATE' or 'DEACTIVATE' status message.
        """
        try:
            res = self.dhan.status_kill_switch()
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', {}).get('killSwitchStatus', 'Unknown')
            return f"Error: {res.get('remarks')}" if isinstance(res, dict) else str(res)
        except Exception as e:
            logger.error(f"Error fetching kill switch status: {e}")
            return "ERROR"

    def toggle_kill_switch(self, activate: bool = True) -> bool:
        """
        Enable or Disable the Kill Switch.
        Note: Activating Kill Switch disables trading for the current day.
        You must close all positions and cancel all orders before activating.
        """
        action = "ACTIVATE" if activate else "DEACTIVATE"
        try:
            res = self.dhan.kill_switch(action)
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Kill Switch {action} successfully.")
                return True
            
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to {action} Kill Switch: {error_msg}")
        except Exception as e:
            logger.error(f"Exception while toggling Kill Switch: {e}")
        return False

    def emergency_stop(self) -> bool:
        """
        The 'Ultimate Nuclear Option':
        1. Cancels all pending orders.
        2. Closes all open positions.
        3. Activates the Account Kill Switch (disables trading for the day).
        Returns True if the final Kill Switch was successfully activated.
        """
        logger.warning("EMERGENCY STOP INITIATED!")
        
        # 1. Cancel all pending orders
        c_count = self.cancel_all_orders()
        logger.info(f"Phase 1: Cancelled {c_count} pending orders.")
        
        # 2. Close all positions
        p_count = self.close_all_positions()
        logger.info(f"Phase 2: Placed market orders to close {p_count} positions.")
        
        # Give a small buffer for orders to process
        if p_count > 0:
            logger.info("Waiting 2 seconds for position closing orders to process...")
            time.sleep(2)
            
        # 3. Activate Kill Switch
        success = self.toggle_kill_switch(activate=True)
        if success:
            logger.warning("EMERGENCY STOP COMPLETE: Kill Switch Activated. Trading disabled for today.")
        else:
            logger.error("EMERGENCY STOP FAILED: Could not activate Kill Switch (Check for remaining positions/orders).")
            
        return success

    def get_pnl_exit(self) -> dict | None:
        """
        Retrieve the current P&L exit configuration for the trading day.
        Returns the data dict on success, or None on failure.
        """
        dhan_http = getattr(self.dhan, 'dhan_http', None)
        if not dhan_http:
            logger.error("get_pnl_exit: dhan_http not accessible.")
            return None
        try:
            res = dhan_http.get('/pnlExit')
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', {})
            logger.error(f"get_pnl_exit failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in get_pnl_exit: {e}")
        return None

    def set_pnl_exit(self, profit_value: float, loss_value: float,
                     product_types: list, enable_kill_switch: bool) -> bool:
        """
        Configure P&L-based automatic exit. The broker exits all matching positions
        when profit_value or loss_value thresholds are breached.
        product_types: list of 'INTRADAY' and/or 'DELIVERY'.
        """
        dhan_http = getattr(self.dhan, 'dhan_http', None)
        if not dhan_http:
            logger.error("set_pnl_exit: dhan_http not accessible.")
            return False
        try:
            payload = {
                "profitValue": profit_value,
                "lossValue": loss_value,
                "productType": product_types,
                "enableKillSwitch": enable_kill_switch,
            }
            res = dhan_http.post('/pnlExit', payload)
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"P&L exit configured: profit={profit_value}, loss={loss_value}, types={product_types}")
                return True
            logger.error(f"set_pnl_exit failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in set_pnl_exit: {e}")
        return False

    def delete_pnl_exit(self) -> bool:
        """Disable active P&L exit configuration for the current day."""
        dhan_http = getattr(self.dhan, 'dhan_http', None)
        if not dhan_http:
            logger.error("delete_pnl_exit: dhan_http not accessible.")
            return False
        try:
            res = dhan_http.delete('/pnlExit')
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info("P&L exit disabled.")
                return True
            logger.error(f"delete_pnl_exit failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in delete_pnl_exit: {e}")
        return False

    # --- UTILS ---
    def epoch_to_datetime(self, epoch: int) -> str:
        """Convert Dhan's epoch time to human-readable format."""
        try:
            # Workaround for SDK bug where convert_to_date_time is decorated as staticmethod but accepts self
            try:
                dt = self.dhan.convert_to_date_time(None, epoch)
            except TypeError:
                dt = self.dhan.convert_to_date_time(epoch)
            
            if isinstance(dt, datetime):
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            return str(dt)
        except Exception:
            return str(epoch)

    # --- OPTION CHAIN ---


    def get_expiry_list(self, under_security_id: int, under_exchange_segment: str = "IDX_I") -> List[str]:
        """Fetch available expiry dates for an underlying with caching."""
        # Check cache (1 hour)
        if under_security_id in self._expiry_cache:
            data, timestamp = self._expiry_cache[under_security_id]
            if time.time() - timestamp < 3600:
                return data

        try:
            elapsed = time.time() - self._option_chain_last_call
            if elapsed < 3.0:
                time.sleep(3.0 - elapsed)
            self._option_chain_last_call = time.time()
            res = self.dhan.expiry_list(
                under_security_id=under_security_id,
                under_exchange_segment=under_exchange_segment
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                # Dhan nesting varies: res['data'] or res['data']['data'] or res['data']['data']['data']
                data = res.get('data', {})
                
                # Check for triple/double nesting
                if isinstance(data, dict) and 'data' in data:
                    data = data['data']
                if isinstance(data, dict) and 'data' in data:
                    data = data['data']
                
                expiries = []
                if isinstance(data, list):
                    expiries = data
                elif isinstance(data, dict):
                    expiries = data.get('data', [])
                    
                # Sort to ensure they are chronological
                if expiries:
                    try:
                        expiries.sort(key=lambda x: datetime.strptime(x, "%Y-%m-%d"))
                    except: pass
                
                if expiries:
                    self._expiry_cache[under_security_id] = (expiries, time.time())
                return expiries
            else:
                logger.error(f"Failed to fetch expiry list: {res.get('remarks')}")
        except Exception as e:
            logger.error(f"Exception in get_expiry_list: {e}")
        return []
    # --- FOREVER ORDERS (GTT) ---
    def place_forever_order(self,
                             security_id: str,
                             exchange_segment: Any,
                             transaction_type: Any,
                             quantity: int,
                             price: float,
                             trigger_price: float,
                             order_type: Any = None,
                             product_type: Any = None,
                             order_flag: str = "SINGLE",
                             disclosed_quantity: int = 0,
                             validity: str = "DAY",
                             price1: float = 0,
                             trigger_price1: float = 0,
                             quantity1: int = 0,
                             tag: str = None) -> Optional[str]:
        """Place a Forever (GTT) order. order_flag='OCO' enables One-Cancels-Other with price1/trigger_price1/quantity1 as the target leg."""
        order_type = order_type or self.LIMIT
        product_type = product_type or self.CNC
        try:
            res = self.dhan.place_forever(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                transaction_type=transaction_type,
                quantity=quantity,
                order_type=order_type,
                product_type=product_type,
                price=price,
                trigger_Price=trigger_price,
                order_flag=order_flag,
                disclosed_quantity=disclosed_quantity,
                validity=validity,
                price1=price1,
                trigger_Price1=trigger_price1,
                quantity1=quantity1,
                tag=tag,
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                order_id = (res.get('data') or {}).get('orderId')
                logger.info(f"Forever order placed [{order_flag}]: {order_id}")
                return order_id
            logger.error(f"place_forever_order failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in place_forever_order: {e}")
        return None

    def modify_forever_order(self,
                              order_id: str,
                              order_flag: str,
                              order_type: Any,
                              leg_name: str,
                              quantity: int,
                              price: float,
                              trigger_price: float,
                              disclosed_quantity: int = 0,
                              validity: str = "DAY") -> bool:
        """Modify an existing Forever order. leg_name: 'TARGET_LEG' or 'STOP_LOSS_LEG'."""
        try:
            res = self.dhan.modify_forever(
                order_id=order_id,
                order_flag=order_flag,
                order_type=order_type,
                leg_name=leg_name,
                quantity=quantity,
                price=price,
                trigger_price=trigger_price,
                disclosed_quantity=disclosed_quantity,
                validity=validity,
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Forever order modified: {order_id}")
                return True
            logger.error(f"modify_forever_order failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in modify_forever_order: {e}")
        return False

    def cancel_forever_order(self, order_id: str) -> bool:
        """Cancel a Forever order by order_id."""
        try:
            res = self.dhan.cancel_forever(order_id)
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Forever order cancelled: {order_id}")
                return True
            logger.error(f"cancel_forever_order failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in cancel_forever_order: {e}")
        return False

    def get_forever_orders(self) -> List[Dict]:
        """Retrieve all active Forever orders."""
        try:
            res = self.dhan.get_forever()
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', [])
                return data if isinstance(data, list) else []
            logger.error(f"get_forever_orders failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in get_forever_orders: {e}")
        return []

    def place_forever(self,
                      symbol: str,
                      quantity: int,
                      transaction_type: Any,
                      price: float,
                      trigger_price: float,
                      order_type: Any = None,
                      product_type: Any = None,
                      order_flag: str = "SINGLE",
                      disclosed_quantity: int = 0,
                      validity: str = "DAY",
                      price1: float = 0,
                      trigger_price1: float = 0,
                      quantity1: int = 0,
                      tag: str = None,
                      instrument: str = None) -> Optional[str]:
        """Symbol-based convenience wrapper for place_forever_order(). Resolves symbol to security_id + exchange_segment automatically."""
        try:
            sec = self._resolve_symbol(symbol, instrument_hint=instrument)
            if not sec:
                logger.error(f"Symbol not found for Forever order: {symbol}")
                return None
            segment = self._auto_detect_segment(sec)
            return self.place_forever_order(
                security_id=str(sec['SECURITY_ID']),
                exchange_segment=segment,
                transaction_type=transaction_type,
                quantity=quantity,
                price=price,
                trigger_price=trigger_price,
                order_type=order_type,
                product_type=product_type,
                order_flag=order_flag,
                disclosed_quantity=disclosed_quantity,
                validity=validity,
                price1=price1,
                trigger_price1=trigger_price1,
                quantity1=quantity1,
                tag=tag,
            )
        except Exception as e:
            logger.error(f"Exception in place_forever for {symbol}: {e}")
        return None

    # --- CONDITIONAL TRIGGERS (ALERTS) ---

    def place_conditional_trigger(
        self,
        condition: Dict,
        orders: List[Dict],
    ) -> Optional[str]:
        """
        Create a conditional trigger that places orders when a market condition is met.
        Maps to POST /alerts/orders.

        Args:
            condition: Trigger condition dict. Keys:
                comparisonType (str)      — e.g. "TECHNICAL_WITH_VALUE"
                exchangeSegment (str)     — "NSE_EQ", "BSE_EQ", or "IDX_I"
                securityId (str)          — security ID string
                indicatorName (str|None)  — e.g. "SMA_5"; None for raw price
                timeFrame (str)           — "DATE", "ONE_MIN", "FIVE_MIN", "FIFTEEN_MIN"
                operator (str)            — e.g. "CROSSING_UP", "CROSSING_DOWN"
                comparingValue (float)    — price/indicator level to compare against
                expDate (str)             — expiry date "YYYY-MM-DD"
                frequency (str)           — "ONCE"
                userNote (str)            — optional label
            orders: List of order dicts to execute when condition fires. Each dict keys:
                transactionType, exchangeSegment, productType, orderType,
                securityId, quantity, validity, price, discQuantity, triggerPrice

        Returns:
            alertId string on success, None on failure.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("place_conditional_trigger: dhan_http not accessible.")
                return None
            payload = {"condition": condition, "orders": orders}
            res = dhan_http.post('/alerts/orders', payload)
            if isinstance(res, dict) and res.get('status') == 'success':
                alert_id = str((res.get('data') or {}).get('alertId', ''))
                logger.info(f"Conditional trigger created. alertId: {alert_id}")
                return alert_id or None
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"place_conditional_trigger failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in place_conditional_trigger: {e}")
        return None

    def modify_conditional_trigger(
        self,
        alert_id: str,
        condition: Dict,
        orders: List[Dict],
    ) -> bool:
        """
        Update an existing conditional trigger.
        Maps to PUT /alerts/orders/{alertId}.

        Args:
            alert_id:  ID of the trigger to update (returned by place_conditional_trigger).
            condition: Updated condition dict (same schema as place_conditional_trigger).
            orders:    Updated orders list (same schema as place_conditional_trigger).

        Returns:
            True if update was accepted, False otherwise.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("modify_conditional_trigger: dhan_http not accessible.")
                return False
            payload = {"condition": condition, "orders": orders}
            res = dhan_http.put(f'/alerts/orders/{alert_id}', payload)
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Conditional trigger {alert_id} updated.")
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"modify_conditional_trigger failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in modify_conditional_trigger: {e}")
        return False

    def cancel_conditional_trigger(self, alert_id: str) -> bool:
        """
        Cancel (delete) a conditional trigger.
        Maps to DELETE /alerts/orders/{alertId}.

        Args:
            alert_id: ID of the trigger to cancel.

        Returns:
            True if cancellation was accepted, False otherwise.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("cancel_conditional_trigger: dhan_http not accessible.")
                return False
            res = dhan_http.delete(f'/alerts/orders/{alert_id}')
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Conditional trigger {alert_id} cancelled.")
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"cancel_conditional_trigger failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in cancel_conditional_trigger: {e}")
        return False

    def get_conditional_trigger(self, alert_id: str) -> Dict:
        """
        Retrieve details of a specific conditional trigger.
        Maps to GET /alerts/orders/{alertId}.

        Args:
            alert_id: ID of the trigger to retrieve.

        Returns:
            Dict with alertId, alertStatus, condition, orders, timestamps, etc.
            Empty dict on failure.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("get_conditional_trigger: dhan_http not accessible.")
                return {}
            res = dhan_http.get(f'/alerts/orders/{alert_id}')
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data') or {}
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"get_conditional_trigger failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_conditional_trigger: {e}")
        return {}

    def get_all_conditional_triggers(self) -> List[Dict]:
        """
        List all conditional triggers for the account.
        Maps to GET /alerts/orders.

        Returns:
            List of trigger dicts, empty list on failure.
        """
        try:
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("get_all_conditional_triggers: dhan_http not accessible.")
                return []
            res = dhan_http.get('/alerts/orders')
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', [])
                return data if isinstance(data, list) else []
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"get_all_conditional_triggers failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_all_conditional_triggers: {e}")
        return []

    def create_price_trigger(
        self,
        symbol: str,
        operator: str,
        comparing_value: float,
        transaction_type: str,
        quantity: int,
        order_type: str,
        price: float,
        product_type: str = "CNC",
        validity: str = "DAY",
        trigger_price: float = 0.0,
        time_frame: str = "ONE_MIN",
        exp_date: Optional[str] = None,
        user_note: str = "",
    ) -> Optional[str]:
        """
        High-level helper: create a price-based conditional trigger for a symbol.
        Resolves the symbol to its security_id automatically.

        Only Equities and Indices are supported by the Dhan API.

        Args:
            symbol:            Symbol name, e.g. "RELIANCE", "NIFTY".
            operator:          Comparison operator, e.g. "CROSSING_UP", "CROSSING_DOWN".
            comparing_value:   Price level that triggers the condition.
            transaction_type:  "BUY" or "SELL".
            quantity:          Number of shares/units.
            order_type:        "LIMIT", "MARKET", "STOP_LOSS", "STOP_LOSS_MARKET".
            price:             Order price (use 0.0 for MARKET orders).
            product_type:      "CNC", "INTRADAY", "MARGIN", or "MTF". Default "CNC".
            validity:          "DAY" or "IOC". Default "DAY".
            trigger_price:     SL trigger price (required for STOP_LOSS orders).
            time_frame:        Candle timeframe for condition evaluation.
                               "DATE", "ONE_MIN", "FIVE_MIN", "FIFTEEN_MIN". Default "ONE_MIN".
            exp_date:          Condition expiry date "YYYY-MM-DD". Defaults to 1 year from today.
            user_note:         Optional label stored with the trigger.

        Returns:
            alertId string on success, None on failure.

        Example::

            alert_id = helper.create_price_trigger(
                symbol="RELIANCE",
                operator="CROSSING_UP",
                comparing_value=1500.0,
                transaction_type="BUY",
                quantity=1,
                order_type="LIMIT",
                price=1501.0,
            )
        """
        sec = self._resolve_symbol(symbol)
        if not sec:
            sec = self.find_index(symbol)
        if not sec:
            logger.error(f"create_price_trigger: Symbol '{symbol}' not found.")
            return None

        instrument = sec.get('INSTRUMENT', '')
        if instrument not in ('EQUITY', 'INDEX'):
            logger.error(
                f"create_price_trigger: Conditional triggers only support Equities and Indices. "
                f"'{symbol}' resolved as '{instrument}'."
            )
            return None

        security_id = str(int(sec['SECURITY_ID']))
        exchange = sec.get('EXCH_ID', 'NSE')
        # Not using _auto_detect_segment() here: the Alerts API only accepts IDX_I/NSE_EQ/BSE_EQ.
        # _auto_detect_segment returns BSE_IDX for BSE Index instruments, which the API rejects.
        if instrument == 'INDEX':
            exchange_segment = 'IDX_I'
        elif exchange == 'BSE':
            exchange_segment = 'BSE_EQ'
        else:
            exchange_segment = 'NSE_EQ'

        if not exp_date:
            exp_date = (datetime.now() + timedelta(days=365)).strftime('%Y-%m-%d')

        condition = {
            'comparisonType': 'TECHNICAL_WITH_VALUE',
            'exchangeSegment': exchange_segment,
            'securityId': security_id,
            'timeFrame': time_frame,
            'operator': operator.upper(),
            'comparingValue': float(comparing_value),
            'expDate': exp_date,
            'frequency': 'ONCE',
            'userNote': user_note,
        }

        orders = [{
            'transactionType': transaction_type.upper(),
            'exchangeSegment': exchange_segment,
            'productType': product_type.upper(),
            'orderType': order_type.upper(),
            'securityId': security_id,
            'quantity': int(quantity),
            'validity': validity.upper(),
            'price': str(float(price)),
            'discQuantity': '0',
            'triggerPrice': str(float(trigger_price)),
        }]

        return self.place_conditional_trigger(condition, orders)

    # --- EDIS / TPIN ---
    def generate_tpin(self) -> bool:
        """Trigger TPIN generation request from CDSL."""
        try:
            res = self.dhan.generate_tpin()
            return isinstance(res, dict) and res.get('status') == 'success'
        except Exception as e:
            logger.error(f"Exception in generate_tpin: {e}")
        return False

    def get_edis_status(self, isin: str = None) -> Dict:
        """
        Check status of eDIS authorizations.
        isin: Optional ISIN code to check specific security status
        """
        try:
            if isin:
                res = self.dhan.edis_inquiry(isin)
            else:
                # Get all eDIS status - may require specific implementation
                logger.warning("get_edis_status requires an ISIN parameter")
                return {}
            
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', {})
        except Exception as e:
            logger.error(f"Exception in get_edis_status: {e}")
        return {}

    def open_browser_for_tpin(self, isin: str, qty: int, exchange: str = 'NSE') -> bool:
        """Open browser for TPIN entry in eDIS form."""
        try:
            res = self.dhan.open_browser_for_tpin(isin=isin, qty=qty, exchange=exchange)
            return isinstance(res, dict) and res.get('status') == 'success'
        except Exception as e:
            logger.error(f"Exception in open_browser_for_tpin: {e}")
        return False

    # --- ORDER BOOK & TRADE BOOK ---
    def get_order_list(self) -> List[Dict]:
        """Fetch all orders for the day."""
        try:
            res = self.dhan.get_order_list()
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', [])
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch order list: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_order_list: {e}")
        return []

    def get_order_by_id(self, order_id: str) -> Optional[Dict]:
        """Fetch details of a specific order by order ID."""
        try:
            res = self.dhan.get_order_by_id(order_id)
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, list):
                    if len(data) > 0:
                        return data[0]
                    return {}
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch order by ID: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_order_by_id: {e}")
        return None

    def get_order_by_correlation_id(self, correlation_id: str) -> Optional[Dict]:
        """Fetch order details by correlation ID."""
        try:
            res = self.dhan.get_order_by_correlationID(correlation_id)
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, list):
                    if len(data) > 0:
                        return data[0]
                    return {}
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch order by correlation ID: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_order_by_correlation_id: {e}")
        return None

    def cancel_order(self, order_id: str) -> bool:
        """Cancel a pending order."""
        try:
            res = self.dhan.cancel_order(order_id)
            if isinstance(res, dict) and res.get('status') == 'success':
                logger.info(f"Order {order_id} cancelled successfully.")
                return True
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Order cancellation failed: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in cancel_order: {e}")
        return False

    def place_slice_order(self,
                          security_id: str,
                          exchange_segment: Any,
                          transaction_type: Any,
                          quantity: int,
                          order_type: Any = None,
                          product_type: Any = None,
                          price: float = 0,
                          trigger_price: float = 0,
                          disclosed_quantity: int = 0,
                          validity: str = 'DAY',
                          tag: str = None) -> Optional[str]:
        """Place a sliced order for F&O instruments that exceed the exchange freeze quantity limit. Automatically splits into multiple orders via /orders/slicing."""
        order_type = order_type or self.LIMIT
        product_type = product_type or self.MARGIN
        try:
            res = self.dhan.place_slice_order(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                transaction_type=transaction_type,
                quantity=quantity,
                order_type=order_type,
                product_type=product_type,
                price=price,
                trigger_price=trigger_price,
                disclosed_quantity=disclosed_quantity,
                validity=validity,
                tag=tag,
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                order_id = res.get('data', {}).get('orderId')
                logger.info(f"Slice order placed: {order_id}")
                return order_id
            logger.error(f"place_slice_order failed: {res.get('remarks') if isinstance(res, dict) else res}")
        except Exception as e:
            logger.error(f"Exception in place_slice_order: {e}")
        return None

    def get_trade_book(self, order_id: str = None) -> List[Dict]:
        """
        Fetch trade book. If order_id is provided, fetches trades for that order.
        Otherwise, fetches all trades for the day.
        """
        try:
            res = self.dhan.get_trade_book(order_id) if order_id else self.dhan.get_trade_book()
            if isinstance(res, dict) and res.get('status') == 'success':
                return res.get('data', [])
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch trade book: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_trade_book: {e}")
        return []

    def get_trade_history(self, from_date: str, to_date: str, page_number: int = 0) -> pd.DataFrame:
        """
        Fetch trade history for a date range.
        from_date, to_date: Format 'YYYY-MM-DD'
        page_number: Pagination (default 0)
        """
        try:
            res = self.dhan.get_trade_history(from_date, to_date, page_number)
            if isinstance(res, dict) and res.get('status') == 'success':
                return pd.DataFrame(res.get('data', []))
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch trade history: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_trade_history: {e}")
        return pd.DataFrame()

    def get_ledger_report(self, from_date: str, to_date: str) -> pd.DataFrame:
        """
        Fetch ledger report for a date range.
        from_date, to_date: Format 'YYYY-MM-DD'
        Returns DataFrame with columns: dhanClientId, narration, voucherdate,
        exchange, voucherdesc, vouchernumber, debit, credit, runbal
        """
        try:
            res = self.dhan.ledger_report(from_date, to_date)
            if isinstance(res, dict) and res.get('status') == 'success':
                return pd.DataFrame(res.get('data', []))
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch ledger report: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_ledger_report: {e}")
        return pd.DataFrame()

    # --- SECURITY / INSTRUMENT LIST ---
    def fetch_security_list(self, segments: List[str] = ['NSE_EQ', 'NSE_FNO', 'BSE_EQ', 'BSE_FNO', 'MCX_COMM']) -> bool:
        """
        Fetch and combine security lists for specific segments using authenticated API.
        Default: Equity (E) and Derivatives (D) for both NSE and BSE.
        API Endpoint: https://api.dhan.co/v2/instrument/{SEGMENT}
        """
        try:
            logger.info(f"Downloading compact master list for segments: {segments}...")
            dfs = []
            
            # Extract credentials from dhanhq client
            dhan_http = getattr(self.dhan, 'dhan_http', None)
            if not dhan_http:
                logger.error("Could not access dhan_http for credentials.")
                return False
                
            client_id = getattr(dhan_http, 'client_id', None)
            access_token = getattr(dhan_http, 'access_token', None)
            
            # Fallback if attributes are missing or named differently (robustness)
            if not client_id: client_id = os.getenv("client_id")
            # If access_token missing, we might need to read file, but usually it's there.
            
            headers = {
                "access-token": access_token,
                "client-id": client_id,
                "Content-Type": "application/json"
            }
            
            for seg in segments:
                url = f"https://api.dhan.co/v2/instrument/{seg}"
                # logger.info(f"Downloading {seg} from {url}...")
                try:
                    resp = requests.get(url, headers=headers)
                    if resp.status_code == 200:
                        # API returns CSV content directly
                        df = pd.read_csv(io.StringIO(resp.text), low_memory=False)
                        dfs.append(df)
                        # logger.info(f"Downloaded {seg}: {len(df)} records")
                    else:
                        logger.error(f"Failed to download {seg}: {resp.status_code} - {resp.text[:100]}")
                except Exception as e:
                    logger.error(f"Exception downloading {seg}: {e}")
            
            if not dfs:
                logger.error("No segments downloaded successfully.")
                return False
                
            # Combine all segments
            full_df = pd.concat(dfs, ignore_index=True)
            
            # Save to disk
            full_df.to_csv(self._master_list_path, index=False)
            logger.info(f"Saved compact master list to {self._master_list_path} ({len(full_df)} records)")
            
            # Reload in memory
            self._load_master_list()
            return True
            
        except Exception as e:
            logger.error(f"Exception in fetch_security_list: {e}")
            return False

    # --- ADVANCED MARKET DATA ---
    def get_ticker_data(self, securities: Dict[str, List[int]]) -> Dict:
        """
        POST /marketfeed/ltp — LTP for up to 1000 instruments (1 req/s).
        securities: {"NSE_EQ": [1333, 11915], "NSE_FNO": [52175]}
        Returns: {"NSE_EQ": {"1333": {"last_price": ...}}, ...}
        """
        try:
            res = self.dhan.ticker_data(securities)
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, dict) and 'data' in data:
                    return data['data']
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch ticker data: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_ticker_data: {e}")
        return {}

    def get_ohlc_data(self, securities: Dict[str, List[int]]) -> Dict:
        """
        POST /marketfeed/ohlc — OHLC + LTP for up to 1000 instruments (1 req/s).
        securities: {"NSE_EQ": [1333, 11915], "NSE_FNO": [52175]}
        Returns: {"NSE_EQ": {"1333": {"last_price": ..., "ohlc": {"open": ..., "high": ..., "low": ..., "close": ...}}}, ...}
        """
        try:
            res = self.dhan.ohlc_data(securities=securities)
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, dict) and 'data' in data:
                    return data['data']
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch OHLC data: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_ohlc_data: {e}")
        return {}

    def get_quote_data(self, securities: Dict[str, List[int]]) -> Dict:
        """
        POST /marketfeed/quote — Full market depth (L2) + OHLC + OI + volume + circuit limits (1 req/s).
        securities: {"NSE_FNO": [49081]}
        Returns: {"NSE_FNO": {"49081": {"last_price": ..., "depth": {"buy": [...], "sell": [...]}, "oi": ..., ...}}}
        """
        try:
            res = self.dhan.quote_data(securities=securities)
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, dict) and 'data' in data:
                    return data['data']
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch quote data: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_quote_data: {e}")
        return {}

    def get_expired_options_data(self, 
                               security_id: int,
                               exchange_segment: str,
                               instrument_type: str,
                               expiry_flag: str,
                               expiry_code: int,
                               strike: Union[str, float, int],
                               drv_option_type: str,
                               required_data: List[str],
                               from_date: str,
                               to_date: str,
                               interval: int = 1) -> pd.DataFrame:
        """
        Fetch historical data for expired options using the SDK's native method.
        """
        try:
            logger.info(f"Fetching Expired Options Data for ID {security_id} ({from_date} to {to_date})")
            
            res = self.dhan.expired_options_data(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                instrument_type=instrument_type,
                expiry_flag=expiry_flag,
                expiry_code=int(expiry_code),
                strike=str(strike),
                drv_option_type=drv_option_type.upper(),
                required_data=required_data,
                from_date=from_date,
                to_date=to_date,
                interval=interval
            )
            
            if isinstance(res, dict) and res.get('status') == 'success':
                res_json = res.get('data', {})
                # Note: The raw API response is in res_json. The SDK wraps it in {'status': 'success', 'data': res_json, 'remarks': ''}
                if isinstance(res_json, dict) and (res_json.get('status') == 'success' or 'data' in res_json):
                    data = res_json.get('data', {})
                    
                    # The response structure is { "data": { "ce": { ... }, "pe": { ... } } } or direct nesting
                    if isinstance(data, dict) and 'data' in data and isinstance(data['data'], dict):
                        data = data['data']
                    
                    target_key = "ce" if drv_option_type.upper() == "CALL" else "pe"
                    inner_data = data.get(target_key) if isinstance(data, dict) else None
                    
                    if inner_data and isinstance(inner_data, dict):
                        # Filter out empty lists to prevent "All arrays must be of the same length" error
                        clean_inner = {k: v for k, v in inner_data.items() if isinstance(v, list) and len(v) > 0}
                        if clean_inner:
                            df = pd.DataFrame(clean_inner)
                            # Add option type column
                            df['option_type'] = drv_option_type.upper()
                            # Convert timestamp if present
                            if 'timestamp' in df.columns:
                                # Convert Epoch UTC to IST (UTC+5:30)
                                df['datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                            return df
                    
                    logger.warning(f"No {target_key} data found in response.")
                else:
                    error_res_json = res_json.get('remarks') if isinstance(res_json, dict) else str(res_json)
                    logger.error(f"API Error: {error_res_json} | Response: {res_json}")
            else:
                error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
                logger.error(f"SDK Error: {error_msg}")
                
        except Exception as e:
            logger.error(f"Exception in get_expired_options_data: {e}")
            
        return pd.DataFrame()
            
        return pd.DataFrame()

    # --- FUTURES LOOKUP ---
    def find_current_month_future(self, symbol: str) -> Optional[Dict]:
        """
        Find the current month future contract for a given symbol (Index or Stock).
        Returns the record from master list or None.
        """
        if self._master_list is None or self._master_list.empty:
            logger.warning("Master list is empty, cannot find future.")
            return None
            
        symbol_upper = symbol.upper()
        today = datetime.now().date()
        
        # Determine Instrument Type based on symbol
        # Indices: NIFTY, BANKNIFTY, FINNIFTY
        is_index = symbol_upper in ['NIFTY', 'BANKNIFTY', 'FINNIFTY']
        instrument_type = 'FUTIDX' if is_index else 'FUTSTK'
        
        # Filter Master List
        # 1. Match Symbol (UNDERLYING_SYMBOL for Derivatives)
        # 2. Match Instrument Type (FUTIDX or FUTSTK)
        # 3. Expiry >= Today
        
        try:
            mask = (
                (self._master_list['UNDERLYING_SYMBOL'] == symbol_upper) & 
                (self._master_list['INSTRUMENT'] == instrument_type) &
                (self._master_list['SM_EXPIRY_DATE'] >= str(today))
            )
            
            futures = self._master_list[mask].copy()
            
            if futures.empty:
                logger.warning(f"No futures found for {symbol_upper}")
                return None
                
            # Sort by Expiry Date to get nearest
            futures.sort_values(by='SM_EXPIRY_DATE', inplace=True)
            
            # Return the first one (Nearest Expiry)
            return futures.iloc[0].to_dict()
            
        except Exception as e:
            logger.error(f"Error finding future for {symbol}: {e}")
            return None

    # --- OPTION CHAIN ---
    def get_expiries(self, symbol: str) -> List[str]:
        """
        Fetch expiry list for a symbol (Equity/Index).
        """
        sec = self._resolve_symbol(symbol)
        if not sec:
            logger.error(f"Symbol not found for Expiry List: {symbol}")
            return []
            
        sid = int(sec['SECURITY_ID'])
        # Map Segment to API format
        seg = "IDX_I" if sec['INSTRUMENT'] == "INDEX" else "NSE_EQ"
        
        return self.get_expiry_list(sid, seg)



    def get_nearest_expiry(self, symbol: str) -> Optional[str]:
        """Get the closest upcoming expiry date for a symbol."""
        expiries = self.get_expiries(symbol)
        return expiries[0] if expiries else None

    def days_to_expiry(self, symbol: str) -> Optional[int]:
        """Returns number of days until the nearest expiry. 0 means today is expiry."""
        expiry_str = self.get_nearest_expiry(symbol)
        if not expiry_str:
            return None
        
        try:
            # Assumes system time is IST or UTC relative for the same day calculation
            expiry_date = datetime.strptime(expiry_str, "%Y-%m-%d").date()
            today = datetime.now().date()
            diff = (expiry_date - today).days
            return diff
        except Exception as e:
            logger.error(f"Error calculating days to expiry for {symbol}: {e}")
            return None

    # --- STRIKE ARITHMETIC ---
    def select_strike(self, ltp: float, offset: int = 0, step: int = 50) -> float:
        """
        Calculate a strike price based on LTP and offset.
        offset: Positive for OTM Calls / ITM Puts, Negative for ITM Calls / OTM Puts.
        step: Strike interval (e.g., 50 for Nifty, 100 for BankNifty).
        """
        atm = round(ltp / step) * step
        return float(atm + (offset * step))

    def get_option_chain(self, symbol: str, expiry: str, exchange_segment: str = None) -> Dict:
        """
        Fetch Option Chain for a symbol (Equity/Index) with caching.
        Auto-resolves symbol to Security ID.
        """
        try:
            sec = self._resolve_symbol(symbol)
            if not sec:
                # If symbol is already an ID (int/str numeric), trust caller
                if str(symbol).isdigit():
                    security_id = int(symbol)
                    # If segment not provided, guess? Hard to guess without lookup.
                    if not exchange_segment:
                        logger.error("Exchange Segment required when passing Security ID directly.")
                        return {}
                else:
                    logger.error(f"Symbol not found for Option Chain: {symbol}")
                    return {}
            else:
                security_id = int(sec['SECURITY_ID'])
                # If segment not provided, derive it
                if not exchange_segment:
                     exchange_segment = "IDX_I" if sec['INSTRUMENT'] == "INDEX" else "NSE_EQ"
            
            # Check cache (5 seconds)
            cache_key = (security_id, expiry)
            if cache_key in self._option_chain_cache:
                data, timestamp = self._option_chain_cache[cache_key]
                if time.time() - timestamp < 5.0:
                    return data

            logger.info(f"Fetching Option Chain for {symbol} ({security_id}) [{exchange_segment}] Expiry: {expiry}")

            elapsed = time.time() - self._option_chain_last_call
            if elapsed < 3.0:
                time.sleep(3.0 - elapsed)
            self._option_chain_last_call = time.time()
            res = self.dhan.option_chain(
                under_security_id=security_id,
                under_exchange_segment=exchange_segment,
                expiry=expiry
            )
            
            if isinstance(res, dict) and res.get('status') == 'success':
                data = res.get('data', {})
                if isinstance(data, dict) and 'data' in data and isinstance(data['data'], dict):
                     data = data.get('data', {})
                
                if data:
                    self._option_chain_cache[cache_key] = (data, time.time())
                return data
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch option chain: {error_msg}")
            
        except Exception as e:
            logger.error(f"Error fetching option chain: {e}")
        
        return {}

    def get_option_chain_df(self, symbol: str, expiry: str) -> pd.DataFrame:
        """
        Fetch Option Chain and return as a flattened DataFrame.
        Columns: Strike, ce_last_price, ce_oi, ce_delta, ..., pe_last_price, ...
        """
        try:
            chain_data = self.get_option_chain(symbol, expiry)
            if not chain_data:
                return pd.DataFrame()

            oc_data = chain_data.get('oc', {})
            if not oc_data:
                logger.warning(f"No 'oc' key in chain data for {symbol}")
                return pd.DataFrame()

            rows = []
            for strike, data in oc_data.items():
                row = {'Strike': float(strike)}
                
                # Flatten CE
                ce = data.get('ce', {})
                for k, v in ce.items():
                    if isinstance(v, dict):
                        for sub_k, sub_v in v.items():
                            # Handle nested greeks or other dicts
                            prefix = f"ce_{k}_" if k != 'greeks' else "ce_"
                            row[f"{prefix}{sub_k}"] = sub_v
                    else:
                        row[f'ce_{k}'] = v
                        
                # Flatten PE
                pe = data.get('pe', {})
                for k, v in pe.items():
                    if isinstance(v, dict):
                        for sub_k, sub_v in v.items():
                            prefix = f"pe_{k}_" if k != 'greeks' else "pe_"
                            row[f"{prefix}{sub_k}"] = sub_v
                    else:
                        row[f'pe_{k}'] = v
                
                rows.append(row)

            df = pd.DataFrame(rows)
            if not df.empty:
                df.set_index('Strike', inplace=True)
                df.sort_index(inplace=True)
                
                # --- NEW: Calculate Percentage Changes ---
                # Calculations: (Current - Previous) / Previous * 100
                # Handle division by zero by filling with 0.0 or keeping Inf (usually 0 is safer for logic)
                
                # CE Columns
                if 'ce_previous_close_price' in df.columns:
                    df['ce_price_change_pct'] = ((df['ce_last_price'] - df['ce_previous_close_price']) / 
                                                 df['ce_previous_close_price'].replace(0, float('inf'))) * 100
                    df['ce_price_change_pct'] = df['ce_price_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)
                
                if 'ce_previous_oi' in df.columns:
                    df['ce_oi_change_pct'] = ((df['ce_oi'] - df['ce_previous_oi']) / 
                                              df['ce_previous_oi'].replace(0, float('inf'))) * 100
                    df['ce_oi_change_pct'] = df['ce_oi_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)
                    
                if 'ce_previous_volume' in df.columns:
                    df['ce_vol_change_pct'] = ((df['ce_volume'] - df['ce_previous_volume']) / 
                                               df['ce_previous_volume'].replace(0, float('inf'))) * 100
                    df['ce_vol_change_pct'] = df['ce_vol_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)

                # PE Columns
                if 'pe_previous_close_price' in df.columns:
                    df['pe_price_change_pct'] = ((df['pe_last_price'] - df['pe_previous_close_price']) / 
                                                 df['pe_previous_close_price'].replace(0, float('inf'))) * 100
                    df['pe_price_change_pct'] = df['pe_price_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)
                
                if 'pe_previous_oi' in df.columns:
                    df['pe_oi_change_pct'] = ((df['pe_oi'] - df['pe_previous_oi']) / 
                                              df['pe_previous_oi'].replace(0, float('inf'))) * 100
                    df['pe_oi_change_pct'] = df['pe_oi_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)
                    
                if 'pe_previous_volume' in df.columns:
                    df['pe_vol_change_pct'] = ((df['pe_volume'] - df['pe_previous_volume']) / 
                                               df['pe_previous_volume'].replace(0, float('inf'))) * 100
                    df['pe_vol_change_pct'] = df['pe_vol_change_pct'].replace([float('inf'), -float('inf')], 0.0).fillna(0.0)
                
            # Add underlying_ltp as an attribute to the DF for convenience
            df.attrs['underlying_ltp'] = chain_data.get('last_price', 0)
            
            return df

        except Exception as e:
            logger.error(f"Error generating Option Chain DF for {symbol}: {e}")
            return pd.DataFrame()

    def get_atm_strike(self, df: pd.DataFrame, underlying_ltp: float = None) -> float:
        """
        Find the ATM strike from the Option Chain DataFrame.
        """
        if df.empty:
            return 0.0
            
        ltp = underlying_ltp or df.attrs.get('underlying_ltp', 0)
        
        # Fallback: if LTP is missing in DF attrs, try to guess or use 0
        if ltp == 0:
            logger.warning("Underlying LTP is 0 or missing. Cannot determine ATM strike.")
            return 0.0
            
        strikes = df.index.to_series()
        try:
            return float(strikes.iloc[(strikes - ltp).abs().argmin()])
        except Exception as e:
            logger.error(f"Error finding ATM strike: {e}")
            return 0.0

    def get_atm_row(self, df: pd.DataFrame, underlying_ltp: float = None) -> pd.Series:
        """
        Get the entire row for the ATM strike.
        """
        if df.empty:
            return pd.Series()
            
        atm_strike = self.get_atm_strike(df, underlying_ltp)
        if atm_strike == 0:
            return pd.Series()
            
        try:
            return df.loc[atm_strike]
        except KeyError:
            logger.error(f"ATM Strike {atm_strike} not found in index.")
            return pd.Series()
        
    def poll_option_chain(self, symbol: str, expiry: str, interval: int = 5, callback: Callable = None):
        """
        Poll option chain every 'interval' seconds.
        Implements adaptive backoff on failures.
        """
        logger.info(f"Starting {interval}s polling for {symbol} ({expiry})")
        
        current_interval = interval
        consecutive_failures = 0
        
        try:
            while True:
                df = self.get_option_chain_df(symbol, expiry)
                
                if not df.empty:
                    # Success
                    if consecutive_failures > 0:
                        logger.info("Polling recovered.")
                        consecutive_failures = 0
                        current_interval = interval # Reset to baseline
                    
                    if callback:
                        callback(df)
                else:
                    # Failure
                    consecutive_failures += 1
                    # backoff: interval + (failures * 2), capped at 30s
                    backoff = min(current_interval + (consecutive_failures * 2), 30)
                    logger.warning(f"Polling failed (Attempt {consecutive_failures}). Retrying in {backoff}s...")
                    time.sleep(backoff)
                    continue

                time.sleep(current_interval)
                
        except KeyboardInterrupt:
            logger.info("Polling stopped by user.")
        except Exception as e:
            logger.error(f"Polling error: {e}")
        
    def get_pcr_data(self, df: pd.DataFrame, window: int = 10) -> Dict:
        """
        Calculate OI PCR and Volume PCR for a given window around ATM.
        window: Number of strikes above and below ATM to include (total window*2 + 1)
        """
        try:
            if df.empty:
                return {}
                
            ltp = df.attrs.get('underlying_ltp', 0)
            if ltp == 0:
                return {}
            
            # Find ATM Strike
            strikes = df.index.to_series()
            atm_idx = (strikes - ltp).abs().argmin()
            
            # Define range
            start_pos = max(0, atm_idx - window)
            end_pos = min(len(df), atm_idx + window + 1)
            
            subset = df.iloc[start_pos:end_pos]
            
            # OI PCR
            sum_ce_oi = subset['ce_oi'].sum()
            sum_pe_oi = subset['pe_oi'].sum()
            oi_pcr = round(sum_pe_oi / sum_ce_oi, 2) if sum_ce_oi > 0 else 0
            
            # Volume PCR
            sum_ce_vol = subset['ce_volume'].sum()
            sum_pe_vol = subset['pe_volume'].sum()
            vol_pcr = round(sum_pe_vol / sum_ce_vol, 2) if sum_ce_vol > 0 else 0
            
            return {
                'atm_strike': float(strikes.iloc[atm_idx]),
                'underlying_ltp': ltp,
                'oi_pcr': oi_pcr,
                'vol_pcr': vol_pcr,
                'ce_oi_total': int(sum_ce_oi),
                'pe_oi_total': int(sum_pe_oi),
                'ce_vol_total': int(sum_ce_vol),
                'pe_vol_total': int(sum_pe_vol),
                'strikes_count': len(subset)
            }
        except Exception as e:
            logger.error(f"Error calculating PCR: {e}")
            return {}

    # --- INTRADAY MINUTE DATA (with interval support) ---
    def get_intraday_minute_data(self,
                                   security_id: Union[str, int],
                                   exchange_segment: str,
                                   instrument_type: str,
                                   interval: str,
                                   from_date: str,
                                   to_date: str,
                                   oi: bool = False) -> pd.DataFrame:
        """
        Fetch intraday minute data with specific interval.
        interval: "1", "5", "15", "25", "60"
        """
        try:
            res = self.dhan.intraday_minute_data(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                instrument_type=instrument_type,
                interval=interval,
                from_date=from_date,
                to_date=to_date,
                oi=oi
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                return pd.DataFrame(res.get('data', []))
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch intraday minute data: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_intraday_minute_data: {e}")
        return pd.DataFrame()

    def get_historical_daily_data(self,
                                    security_id: Union[str, int],
                                    exchange_segment: str,
                                    instrument_type: str,
                                    from_date: str,
                                    to_date: str,
                                    expiry_code: int = 0,
                                    oi: bool = False) -> pd.DataFrame:
        """Fetch historical daily OHLC data."""
        try:
            res = self.dhan.historical_daily_data(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                instrument_type=instrument_type,
                from_date=from_date,
                to_date=to_date,
                expiry_code=expiry_code,
                oi=oi
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                return pd.DataFrame(res.get('data', []))
            error_msg = res.get('remarks') if isinstance(res, dict) else str(res)
            logger.error(f"Failed to fetch historical daily data: {error_msg}")
        except Exception as e:
            logger.error(f"Exception in get_historical_daily_data: {e}")
        return pd.DataFrame()

    def get_historical_minute_data_long(self,
                                         symbol: str,
                                         from_date: str,
                                         to_date: str,
                                         interval: str = "1") -> pd.DataFrame:
        """
        Fetch intraday minute data for a long period by chunking requests.
        Bypasses the 90-day API limit by using 85-day chunks.
        Standardizes to IST and renames columns to standard format.
        """
        try:
            sec = self._resolve_symbol(symbol)
            if not sec:
                logger.error(f"Could not resolve symbol {symbol} for long history.")
                return pd.DataFrame()

            security_id = int(sec['SECURITY_ID'])
            # Derive segment details for raw API
            exch_id = sec.get('EXCH_ID', 'NSE')
            instr = sec.get('INSTRUMENT', 'EQUITY')
            
            segment = "NSE_EQ"
            if exch_id == "NSE":
                if instr == "INDEX": segment = "IDX_I"
                elif instr == "EQUITY": segment = "NSE_EQ"
                else: segment = "NSE_FNO"
            
            start_total = datetime.strptime(from_date, "%Y-%m-%d")
            end_total = datetime.strptime(to_date, "%Y-%m-%d")
            
            current_start = start_total
            all_chunks = []
            chunk_days = 30 # Reduced for better reliability across all asset classes
            
            print(f">>> Fetching Long History for {symbol} ({from_date} to {to_date})...")
            
            while current_start <= end_total:
                current_end = min(current_start + timedelta(days=chunk_days), end_total)
                
                chunk_from = current_start.strftime("%Y-%m-%d")
                chunk_to = current_end.strftime("%Y-%m-%d")
                
                logger.info(f"Fetching chunk: {chunk_from} to {chunk_to}")
                
                df_chunk = self.get_intraday_minute_data(
                    security_id=security_id,
                    exchange_segment=segment,
                    instrument_type=instr,
                    interval=interval,
                    from_date=chunk_from,
                    to_date=chunk_to
                )
                
                if not df_chunk.empty:
                    # Normalize using internal logic (duplicated here for independence)
                    rename_map = {
                        "start_time": "Datetime", "start_Time": "Datetime", "kline_time": "Datetime",
                        "timestamp": "Datetime", "open": "Open", "high": "High", "low": "Low", 
                        "close": "Close", "volume": "Volume"
                    }
                    df_chunk = df_chunk.rename(columns={c: rename_map[c.lower()] for c in df_chunk.columns if c.lower() in rename_map})
                    
                    if "Datetime" in df_chunk.columns:
                        # Convert to IST
                        df_chunk["Datetime"] = pd.to_datetime(df_chunk["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                        df_chunk = df_chunk.set_index("Datetime").sort_index()
                    
                    # Filter standard columns
                    desired = ["Open", "High", "Low", "Close", "Volume"]
                    df_chunk = df_chunk[[c for c in desired if c in df_chunk.columns]]
                    
                    all_chunks.append(df_chunk)
                
                current_start = current_end + timedelta(days=1)
                time.sleep(0.5) # Rate limit respect
            
            if all_chunks:
                final_df = pd.concat(all_chunks)
                final_df = final_df[~final_df.index.duplicated(keep='first')].sort_index()
                return final_df
                
        except Exception as e:
            logger.error(f"Error in get_historical_minute_data_long: {e}")
            
        return pd.DataFrame()

    # --- WEBSOCKET / LIVE FEED ---

    def start_websocket(self, 
                       instruments: List[Tuple[Any, str, int]], 
                       on_message: Optional[Callable] = None):
        """
        Start WebSocket in a background thread with auto-reconnection and rate-limit handling.
        """
        with self._ws_lock:
            if self.ws_thread and self.ws_thread.is_alive():
                logger.info("WebSocket thread already running. Updating instruments...")
                self.subscribe_instruments(instruments)
                return

            self.ws_instruments = instruments 
            self.user_on_message = on_message
            self._ws_stop_flag = False

            def run_ws():
                retry_delay = 10
                while not self._ws_stop_flag:
                    try:
                        logger.info("Starting WebSocket connection...")
                        
                        class DhanContextAdapter:
                            def __init__(self, dhan_client):
                                self.client = dhan_client
                            def get_client_id(self):
                                return getattr(self.client.dhan_http, 'client_id', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'client_id', "")
                            def get_access_token(self):
                                return getattr(self.client.dhan_http, 'access_token', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'access_token', "")

                        context_adapter = DhanContextAdapter(self.dhan)

                        self.feed = MarketFeed(
                            dhan_context=context_adapter,
                            instruments=self.ws_instruments,
                            on_connect=self._on_ws_connect,
                            on_message=self._on_ws_message,
                            on_close=self._on_ws_close,
                            on_error=self._on_ws_error
                        )
                        
                        # Reset delay on successful start attempt (actual connection check is in on_connect)
                        self.feed.run()

                    except Exception as e:
                        err_str = str(e)
                        if "429" in err_str:
                            retry_delay = 30 # Aggressive backoff for rate limits
                            logger.error(f"WebSocket Rate Limited (429). Waiting {retry_delay}s before retry...")
                        else:
                            retry_delay = 10
                            logger.error(f"WebSocket execution failed: {e}. Retrying in {retry_delay}s...")
                        
                        if hasattr(self, 'feed') and self.feed:
                            try: self.feed.close_connection()
                            except: pass

                    if not self._ws_stop_flag:
                        time.sleep(retry_delay)

            self.ws_thread = threading.Thread(target=run_ws, daemon=True)
            self.ws_thread.start()
            logger.info("WebSocket manager started in background thread.")

    def _on_ws_connect(self, instance):
        logger.info("WebSocket Connected Successfully")

    def _on_ws_close(self, instance):
        logger.warning("WebSocket closed by server (disconnect packet received). Outer loop will reconnect.")

    def _on_ws_error(self, instance, error):
        logger.error(f"WebSocket Error Observed: {error}")

    # --- ORDER UPDATE WEBSOCKET ---

    def start_order_update_websocket(self, on_update: Optional[Callable] = None):
        """
        Start the Dhan order-update WebSocket in a background thread.

        Connects to wss://api-order-update.dhan.co and receives real-time
        order status changes (fills, rejections, cancellations, etc.).
        Stores each update in self.order_updates[order_id] and optionally
        calls on_update(payload) for every incoming message.
        """
        with self._ou_lock:
            if on_update is not None:
                self.user_on_order_update = on_update

            if self._ou_thread and self._ou_thread.is_alive():
                logger.info("Order Update WebSocket already running. Callback updated.")
                return

            self._ou_stop_flag = False

            def _handle_order_update(payload: dict):
                data = payload.get('Data', {})
                order_id = data.get('orderNo') or data.get('OrderNo')
                if order_id:
                    self.order_updates[str(order_id)] = payload
                status = data.get('status') or data.get('Status', '')
                logger.info(f"Order update: id={order_id} status={status}")
                if self.user_on_order_update and callable(self.user_on_order_update):
                    self.user_on_order_update(payload)

            def run_ou():
                retry_delay = 10
                while not self._ou_stop_flag:
                    try:
                        logger.info("Starting Order Update WebSocket connection...")

                        class DhanContextAdapter:
                            def __init__(self, dhan_client):
                                self.client = dhan_client
                            def get_client_id(self):
                                return getattr(self.client.dhan_http, 'client_id', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'client_id', "")
                            def get_access_token(self):
                                return getattr(self.client.dhan_http, 'access_token', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'access_token', "")

                        context_adapter = DhanContextAdapter(self.dhan)
                        ou = OrderUpdate(context_adapter)
                        ou.on_update = _handle_order_update
                        ou.connect_to_dhan_websocket_sync()

                    except Exception as e:
                        logger.error(f"Order Update WebSocket failed: {e}. Retrying in {retry_delay}s...")

                    if not self._ou_stop_flag:
                        time.sleep(retry_delay)

            self._ou_thread = threading.Thread(target=run_ou, daemon=True, name="order-update-ws")
            self._ou_thread.start()
            logger.info("Order Update WebSocket manager started in background thread.")

    def stop_order_update_websocket(self):
        """Stop the order-update WebSocket background thread."""
        self._ou_stop_flag = True
        logger.info("Order Update WebSocket stop requested.")

    def get_order_update(self, order_id: str) -> Optional[dict]:
        """Return the latest order-update payload for the given order_id, or None."""
        return self.order_updates.get(str(order_id))

    def _on_ws_message(self, instance, message):
        """Internal callback to update live_data cache."""
        try:
            if isinstance(message, dict):
                sid = str(message.get('security_id')) or str(message.get('SecurityId'))
                if sid and sid != 'None':
                    # MERGE into existing entry instead of replacing it.
                    # The SDK sends several binary packets per instrument per tick
                    # (e.g. Full packet + OI packet + Prev-Close packet). Each is a
                    # separate dict. If we replace the whole entry the later OI-only
                    # packet would wipe out LTP / OHLC data from the earlier Full
                    # packet — that is why the sheet showed only OI.
                    if sid in self.live_data:
                        self.live_data[sid].update(message)
                    else:
                        self.live_data[sid] = dict(message)

                if self.user_on_message:
                    self.user_on_message(instance, message)
        except Exception as e:
            logger.error(f"Error in WebSocket handler: {e}")

    def subscribe_instruments(self, instruments: List[Tuple[Any, str, int]]):
        """
        Subscribe to additional instruments on an active WebSocket connection.
        """
        # Add to the master list so reconnection includes these
        for inst in instruments:
            if inst not in self.ws_instruments:
                self.ws_instruments.append(inst)

        if hasattr(self, 'feed') and self.feed:
            try:
                self.feed.subscribe_symbols(instruments)
                logger.info(f"Subscribed to {len(instruments)} new instruments.")
                return True
            except Exception as e:
                logger.error(f"Error checking subscription: {e}")
        return False

    def unsubscribe_instruments(self, instruments: List[Tuple[Any, str, int]]):
        """
        Unsubscribe from instruments on an active WebSocket connection.
        instruments: List of tuples (Exchange, SecurityID, RequestCode)
        """
        if hasattr(self, 'feed') and self.feed:
            try:
                logger.info(f"Unsubscribing from {len(instruments)} instruments...")
                self.feed.unsubscribe_symbols(instruments)
                
                # Optional: Cleanup local cache (live_data)
                # Note: We might want to keep last known price, or remove it. 
                # For now, we keep it to avoid KeyErrors in other threads, but one could remove it:
                # for _, sid, _ in instruments:
                #     self.live_data.pop(str(sid), None)
                
                return True
            except Exception as e:
                logger.error(f"Error unsubscribing: {e}")
        else:
            logger.warning("WebSocket feed not active. Cannot unsubscribe.")
        return False


    def _resolve_symbols_to_instruments(self, symbols: List[str], request_code: int = 15) -> List[Tuple[Any, str, int]]:
        """
        Internal helper to resolve a list of symbols to instrument tuples.
        request_code: 15=Ticker, 17=Quote, 21=Full (Depth)
        """
        instruments = []
        resolved_names = []
        
        for sym in symbols:
            # Try Index first
            idx = self.find_index(sym)
            if idx:
                # Tuples: (Exchange, SecurityID, RequestCode)
                instruments.append((self.dhan.INDEX, str(idx['SECURITY_ID']), request_code))
                resolved_names.append(f"{sym} (IDX)")
                continue
                
            # Try Equity
            eq = self.find_equity(sym)
            if eq:
                instruments.append((self.dhan.NSE, str(eq['SECURITY_ID']), request_code))
                resolved_names.append(f"{sym} (EQ)")
                continue
            
            logger.warning(f"Could not resolve symbol: {sym}")
            
        if not instruments:
            logger.error("No valid instruments resolved.")
            return []
            
        logger.info(f"Connecting WebSocket (Code {request_code}) for: {resolved_names}")
        return instruments

    def connect_ticker(self, symbols: List[str], on_tick: Callable) -> Any:
        """Subscribe to Ticker (LTP) Data."""
        instruments = self._resolve_symbols_to_instruments(symbols, request_code=15)
        if not instruments: return None
        return self.start_websocket(instruments, on_message=on_tick)

    def connect_quote(self, symbols: List[str], on_tick: Callable) -> Any:
        """Subscribe to Quote (OHLC + LTP) Data."""
        instruments = self._resolve_symbols_to_instruments(symbols, request_code=17)
        if not instruments: return None
        return self.start_websocket(instruments, on_message=on_tick)

    def connect_full(self, symbols: List[str], on_tick: Callable) -> Any:
        """Subscribe to Full Data (Depth + OI + OHLC)."""
        instruments = self._resolve_symbols_to_instruments(symbols, request_code=21)
        if not instruments: return None
        return self.start_websocket(instruments, on_message=on_tick)

    # ============================================================================
    # HIGH-LEVEL STRATEGY ABSTRACTIONS
    # ============================================================================

    # --- POSITION MANAGEMENT ---

    def get_net_quantity(self, symbol: str) -> int:
        """
        Get net quantity for a symbol. Positive = Long, Negative = Short.
        Handles symbol resolution automatically.
        """
        try:
            # Resolve symbol to get security ID
            sec = self._resolve_symbol(symbol)
            if not sec:
                logger.error(f"Symbol not found for Position check: {symbol}")
                return 0
                
            security_id = str(sec['SECURITY_ID'])
            
            # Fetch all positions
            res = self.dhan.get_positions()
            if not isinstance(res, dict) or res.get('status') != 'success':
                # Log only if not successful (to avoid spamming logs on empty positions if API behaves that way)
                # Some APIs return success with empty data, some fail. Robust handle:
                return 0
                
            data = res.get('data', [])
            net_qty = 0
            
            for pos in data:
                # Check for matching Security ID
                if str(pos.get('securityId')) == security_id:
                    # 'netQty' is usually reliable for total open qty
                    net_qty += int(pos.get('netQty', 0))
            
            return net_qty
            
        except Exception as e:
            logger.error(f"Error getting net quantity for {symbol}: {e}")
            return 0

    def close_position(self, symbol: str) -> bool:
        """
        Close any open position for the symbol immediately.
        Safely handles multiple product types (e.g. closing both INTRA and MARGIN if they exist).
        """
        try:
            sec = self._resolve_symbol(symbol)
            if not sec: 
                logger.error(f"Symbol not found for Close Position: {symbol}")
                return False
            
            security_id = str(sec['SECURITY_ID'])
            exchange_segment = sec['SEGMENT']

            res = self.dhan.get_positions()
            if not isinstance(res, dict) or res.get('status') != 'success':
                return True # No positions to close implies success in "being flat"
                
            data = res.get('data', [])
            closed_any = False
            
            for pos in data:
                if str(pos.get('securityId')) == security_id:
                    net_qty = int(pos.get('netQty', 0))
                    if net_qty != 0:
                        # Close this specific position chunk
                        t_type = self.SELL if net_qty > 0 else self.BUY
                        qty_to_close = abs(net_qty)
                        prod_type = pos.get('productType')
                        
                        logger.info(f"Closing {symbol} ({prod_type}): {qty_to_close} qty")
                        
                        self.place_order(
                            security_id=security_id,
                            exchange_segment=exchange_segment,
                            transaction_type=t_type,
                            quantity=qty_to_close,
                            order_type=self.MARKET,
                            product_type=prod_type
                        )
                        closed_any = True
            
            if not closed_any:
                logger.info(f"No open position found to close for {symbol}.")
                
            return True
            
        except Exception as e:
            logger.error(f"Error closing position for {symbol}: {e}")
            return False

    # --- ORDER MANAGEMENT ---

    def place_entry(self, symbol: str, quantity: int, direction: str, 
                   order_type: str = "MARKET", price: float = 0.0, trigger_price: float = 0.0,
                   product_type: str = "MARGIN", after_market_order: bool = False, **kwargs) -> Optional[str]:
        """
        Unified entry point for placing orders.
        direction: "BUY" or "SELL"
        """
        try:
            sec = self._resolve_symbol(symbol)
            if not sec:
                logger.error(f"Symbol not found for Order: {symbol}")
                return None
            
            txn_type = self.BUY if direction.upper() == "BUY" else self.SELL
            
            # Resolve segment to full API format (NSE_EQ, NSE_FNO, etc.)
            segment = self._auto_detect_segment(sec)
            
            return self.place_order(
                security_id=str(sec['SECURITY_ID']),
                exchange_segment=segment,
                transaction_type=txn_type,
                quantity=quantity,
                order_type=order_type,
                price=price,
                trigger_price=trigger_price,
                product_type=product_type,
                after_market_order=after_market_order,
                **kwargs
            )
        except Exception as e:
            logger.error(f"Error placing entry for {symbol}: {e}")
            return None

    def place_exi_limit(self, symbol: str, quantity: int, price: float, direction: str, product_type: str = "MARGIN") -> Optional[str]:
        """
        Place a Limit Exit order (Target).
        """
        return self.place_entry(
            symbol=symbol,
            quantity=quantity,
            direction=direction,
            order_type=self.LIMIT,
            price=price,
            product_type=product_type
        )

    def place_sl_limit(self, symbol: str, quantity: int, trigger_price: float, limit_price: float, direction: str, product_type: str = "MARGIN") -> Optional[str]:
        """
        Place a Stop Loss Limit (SL-L) order.
        """
        SL_TYPE = getattr(self.dhan, 'SL', 'STOP_LOSS')
        
        logger.info(f"place_sl_limit: Placing SL-L order. Symbol: {symbol} | Trigger: {trigger_price:.2f} | Limit: {limit_price:.2f} | Direction: {direction}")
        
        return self.place_entry(
            symbol=symbol,
            quantity=quantity,
            direction=direction,
            order_type=SL_TYPE,
            price=limit_price,
            trigger_price=trigger_price,
            product_type=product_type
        )

    def place_sl_market(self, symbol: str, quantity: int, trigger_price: float, direction: str, product_type: str = "MARGIN") -> Optional[str]:
        """
        Place a Stop Loss Market order (SL-M).
        NOTE: Since Dhan/exchanges do not support SL-M for Options F&O, this falls back to
        placing a Stop Loss Limit (SL-L) order with a 5% price cushion.
        """
        if direction.upper() == "BUY":
            limit_price = round(trigger_price * 1.05 * 20) / 20
        else:
            limit_price = round(trigger_price * 0.95 * 20) / 20
            
        return self.place_sl_limit(symbol, quantity, trigger_price, limit_price, direction, product_type)

    def update_trailing_sl(self, symbol: str, current_sl_id: str, new_trigger_price: float, quantity: int, direction: str, product_type: str = "MARGIN") -> Optional[str]:
        """
        Updates a trailing SL by cancelling the old one and placing a new one.
        Returns the new order_id.
        """
        try:
            # 1. Cancel existing
            if current_sl_id:
                self.cancel_order(current_sl_id)
            
            # 2. Place new
            return self.place_sl_market(symbol, quantity, new_trigger_price, direction, product_type)
        except Exception as e:
            logger.error(f"Error in update_trailing_sl for {symbol}: {e}")
            return None

    def place_spread(self, leg1: Dict, leg2: Dict) -> Dict[str, Optional[str]]:
        """
        Place two orders rapidly (e.g., for a spread).
        leg1/leg2 format: {'symbol': '...', 'quantity': ..., 'direction': '...', 'order_type': '...', 'price': ...}
        """
        results = {}
        try:
            logger.info("Placing Spread Strategy legs...")
            results['leg1'] = self.place_entry(**leg1)
            results['leg2'] = self.place_entry(**leg2)
            return results
        except Exception as e:
            logger.error(f"Error placing spread: {e}")
            return results
        

    # --- DATA HELPERS ---

    def get_latest_candles(self, symbol: str, interval: str = "5", days: int = 5) -> pd.DataFrame:
        """
        Fetch historical/intraday candles and return a clean DataFrame.
        interval: "1", "5", "15", "30", "60", "D" (Daily)
        Returns DF with index=Datetime, columns=[Open, High, Low, Close, Volume]
        """
        sec = self._resolve_symbol(symbol)
        if not sec: return pd.DataFrame()
        
        security_id = int(sec['SECURITY_ID'])
        # exchange_segment = sec['SEGMENT'] # Raw CSV value "E" causes DH-905
        
        # Derive correct API Exchange Segment
        exch_id = sec.get('EXCH_ID', 'NSE')
        instr = sec.get('INSTRUMENT', 'EQUITY')
        
        exchange_segment = "NSE_EQ" # Default
        if exch_id == "NSE":
            if instr == "INDEX": exchange_segment = "IDX_I"
            elif instr == "EQUITY": exchange_segment = "NSE_EQ"
            else: exchange_segment = "NSE_FNO"
        elif exch_id == "BSE":
            if instr == "INDEX": exchange_segment = "BSE_IDX" 
            elif instr == "EQUITY": exchange_segment = "BSE_EQ"
            else: exchange_segment = "BSE_FNO"
        elif exch_id == "MCX":
            exchange_segment = "MCX_COMM"
            
        instrument_type = sec['INSTRUMENT']
        
        to_date_obj = datetime.now()
        # Enforce a minimum lookback of 5 days to avoid empty ranges and DH-905 errors on weekends/holidays
        effective_days = max(days, 5)
        from_date_obj = to_date_obj - timedelta(days=effective_days)
        
        to_date = to_date_obj.strftime("%Y-%m-%d")
        from_date = from_date_obj.strftime("%Y-%m-%d")
        
        # Determine strict interval for minute API
        # If user asks for "30", we might need to use "15" and resample, OR just pass "25" if supported? 
        # Dhan supports 1, 5, 15, 25, 60.
        api_interval = interval
        if interval == "30": api_interval = "15" # Fallback to 15 to allow resampling later if needed (simple fallback for now)
        
        if interval.upper() in ["D", "1D", "DAILY"]:
            df = self.get_historical_daily_data(
                security_id, exchange_segment, instrument_type, from_date, to_date
            )
        else:
            df = self.get_intraday_minute_data(
                security_id, exchange_segment, instrument_type, api_interval, from_date, to_date
            )
            
        if df.empty: return df
        
        # Normalize Data
        # Typical Dhan keys: "start_Time", "open", "high", "low", "close", "volume" (case varies)
        # We rename to Title Case standard
        
        # 1. Convert specific keys
        rename_map = {
            "start_time": "Datetime", "start_Time": "Datetime", "kline_time": "Datetime",
            "timestamp": "Datetime",
            "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"
        }
        # Check current columns to handle case sensitivity
        cols = df.columns
        new_map = {}
        for c in cols:
            low_c = c.lower()
            if low_c in rename_map:
                new_map[c] = rename_map[low_c]
        
        df = df.rename(columns=new_map)
        
        # Filter strictly standard columns
        desired_cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
        available_cols = [c for c in desired_cols if c in df.columns]
        df = df[available_cols]
        
        # 2. Convert Datetime to Object/Index (Standardize to IST)
        if "Datetime" in df.columns:
            # Helper to convert epoch or string
            first_val = df["Datetime"].iloc[0]
            if isinstance(first_val, (int, float)): # likely epoch
                # Dhan returns UTC Epoch. We localize to UTC then convert to Asia/Kolkata
                df["Datetime"] = pd.to_datetime(df["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
            else:
                # For string formats, ensure it's converted to datetime object
                df["Datetime"] = pd.to_datetime(df["Datetime"])
            
            df = df.set_index("Datetime")
            df = df.sort_index()
            
        # Check and append today's daily candle if missing
        if interval.upper() in ["D", "1D", "DAILY"]:
            today = datetime.now().date()
            if today not in df.index.date:
                # Fetch today's 1m intraday data to construct daily candle
                today_str = datetime.now().strftime("%Y-%m-%d")
                logger.info(f"Today ({today}) missing from daily history. Fetching intraday to construct daily candle...")
                today_df = self.get_intraday_minute_data(
                    security_id, exchange_segment, instrument_type, "1", today_str, today_str
                )
                if not today_df.empty:
                    cols_today = today_df.columns
                    today_map = {}
                    for c in cols_today:
                        low_c = c.lower()
                        if low_c in rename_map:
                            today_map[c] = rename_map[low_c]
                    today_df = today_df.rename(columns=today_map)
                    
                    if "Datetime" in today_df.columns:
                        first_val = today_df["Datetime"].iloc[0]
                        if isinstance(first_val, (int, float)):
                            today_df["Datetime"] = pd.to_datetime(today_df["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                        else:
                            today_df["Datetime"] = pd.to_datetime(today_df["Datetime"])
                        
                        today_df = today_df.sort_values("Datetime")
                        
                        t_open = today_df["Open"].iloc[0]
                        t_high = today_df["High"].max()
                        t_low = today_df["Low"].min()
                        t_close = today_df["Close"].iloc[-1]
                        t_vol = today_df["Volume"].sum() if "Volume" in today_df.columns else 0.0
                        
                        today_midnight = pd.Timestamp(today)
                        today_row = pd.DataFrame([{
                            "Open": float(t_open),
                            "High": float(t_high),
                            "Low": float(t_low),
                            "Close": float(t_close),
                            "Volume": float(t_vol)
                        }], index=[today_midnight])
                        
                        df = pd.concat([df, today_row])
            
        return df

    def get_indicators(self, symbol: str, interval: str = "5", indicators: List[str] = ['EMA20', 'RSI14'], days: int = 5) -> pd.DataFrame:
        """
        Fetch candles and calculate requested technical indicators.
        Returns the DataFrame with indicator columns added.
        """
        df = self.get_latest_candles(symbol, interval, days)
        if df.empty:
            return df
            
        for ind in indicators:
            ind_upper = ind.upper()
            try:
                # 1. EMA (Exponential Moving Average) - Format: EMA20, EMA50
                if ind_upper.startswith('EMA'):
                    period = int(ind_upper.replace('EMA', ''))
                    if HAS_TALIB:
                        df[ind_upper] = talib.EMA(df['Close'], timeperiod=period)
                    else:
                        df[ind_upper] = df['Close'].ewm(span=period, adjust=False).mean()
                
                # 2. SMA (Simple Moving Average) - Format: SMA20, SMA200
                elif ind_upper.startswith('SMA'):
                    period = int(ind_upper.replace('SMA', ''))
                    if HAS_TALIB:
                        df[ind_upper] = talib.SMA(df['Close'], timeperiod=period)
                    else:
                        df[ind_upper] = df['Close'].rolling(window=period).mean()
                
                # 3. RSI (Relative Strength Index) - Format: RSI14
                elif ind_upper.startswith('RSI'):
                    period = int(ind_upper.replace('RSI', ''))
                    if HAS_TALIB:
                        df[ind_upper] = talib.RSI(df['Close'], timeperiod=period)
                    else:
                        delta = df['Close'].diff()
                        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
                        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
                        rs = gain / loss
                        df[ind_upper] = 100 - (100 / (1 + rs))
                
                # 4. ATR (Average True Range) - Format: ATR14
                elif ind_upper.startswith('ATR'):
                    period = int(ind_upper.replace('ATR', ''))
                    if HAS_TALIB:
                        df[ind_upper] = talib.ATR(df['High'], df['Low'], df['Close'], timeperiod=period)
                    else:
                        high_low = df['High'] - df['Low']
                        high_cp = (df['High'] - df['Close'].shift()).abs()
                        low_cp = (df['Low'] - df['Close'].shift()).abs()
                        tr = pd.concat([high_low, high_cp, low_cp], axis=1).max(axis=1)
                        df[ind_upper] = tr.rolling(window=period).mean()
            
            except Exception as e:
                logger.error(f"Error calculating indicator {ind} for {symbol}: {e}")
                
        return df

    def calculate_ta_indicators(self, df: pd.DataFrame, indicators: List[Union[str, Dict[str, Any]]]) -> pd.DataFrame:
        """
        Calculate indicators on a DataFrame using pandas_ta.
        Supports string shortcuts (e.g., 'EMA20', 'RSI14', 'MACD', 'BBANDS') 
        or detailed dict configurations.
        
        Args:
            df: DataFrame containing at least Open, High, Low, Close, and Volume.
            indicators: List of indicators to calculate. Example:
                        ['EMA20', 'RSI14', {'kind': 'macd', 'fast': 12, 'slow': 26}]
                        
        Returns:
            DataFrame with indicator columns appended.
        """
        if df.empty:
            return df
            
        import pandas_ta as ta  # Import here to keep it localized
        
        df_ta = df.copy()
        
        # Ensure standard column names are lowercase so pandas_ta can auto-detect them.
        rename_map = {
            'Open': 'open', 'High': 'high', 'Low': 'low', 'Close': 'close', 'Volume': 'volume'
        }
        for col in rename_map:
            if col in df_ta.columns and rename_map[col] not in df_ta.columns:
                df_ta[rename_map[col]] = df_ta[col]

        for ind in indicators:
            try:
                if isinstance(ind, str):
                    ind_upper = ind.upper()
                    
                    if ind_upper.startswith('EMA'):
                        length = int(ind_upper.replace('EMA', '') or 20)
                        df_ta.ta.ema(length=length, append=True)
                        
                    elif ind_upper.startswith('SMA'):
                        length = int(ind_upper.replace('SMA', '') or 20)
                        df_ta.ta.sma(length=length, append=True)
                        
                    elif ind_upper.startswith('RSI'):
                        length = int(ind_upper.replace('RSI', '') or 14)
                        df_ta.ta.rsi(length=length, append=True)
                        
                    elif ind_upper.startswith('ATR'):
                        length = int(ind_upper.replace('ATR', '') or 14)
                        df_ta.ta.atr(length=length, append=True)
                        
                    elif ind_upper.startswith('ADX'):
                        length = int(ind_upper.replace('ADX', '') or 14)
                        df_ta.ta.adx(length=length, append=True)
                        
                    elif ind_upper == 'MACD':
                        df_ta.ta.macd(fast=12, slow=26, signal=9, append=True)
                        
                    elif ind_upper in ['BBANDS', 'BB']:
                        df_ta.ta.bbands(length=20, std=2, append=True)
                        
                    elif ind_upper == 'VWAP':
                        df_ta.ta.vwap(append=True)
                        
                    elif ind_upper == 'SUPERTREND':
                        df_ta.ta.supertrend(append=True)
                        
                    else:
                        method_name = ind.lower()
                        if hasattr(df_ta.ta, method_name):
                            getattr(df_ta.ta, method_name)(append=True)
                        else:
                            logger.warning(f"Unknown pandas_ta indicator: {ind}")
                            
                elif isinstance(ind, dict):
                    kind = ind.get('kind', '').lower()
                    params = {k: v for k, v in ind.items() if k != 'kind'}
                    if hasattr(df_ta.ta, kind):
                        getattr(df_ta.ta, kind)(append=True, **params)
                    else:
                        logger.warning(f"Unknown pandas_ta method in dict: {kind}")
                        
            except Exception as e:
                logger.error(f"Error calculating pandas_ta indicator {ind}: {e}")
                
        # Drop temporary lowercase columns to keep the DataFrame clean
        for col in rename_map.values():
            if col in df_ta.columns and col not in df.columns:
                df_ta.drop(columns=[col], inplace=True)
                
        return df_ta

    def get_indicators_ta(self, symbol: str, interval: str = "5", indicators: List[Union[str, Dict[str, Any]]] = ['EMA20', 'RSI14'], days: int = 5) -> pd.DataFrame:
        """
        Fetch candles and calculate requested indicators using pandas_ta.
        
        Args:
            symbol: Symbol name (e.g. 'RELIANCE')
            interval: Candle interval (e.g. '5', '15', 'DAILY')
            indicators: List of indicators.
            days: Days back to fetch history.
            
        Returns:
            DataFrame with candles and indicators.
        """
        df = self.get_latest_candles(symbol, interval, days)
        return self.calculate_ta_indicators(df, indicators)

    # --- UTILITIES ---

    # NSE Holidays (2024-2026) - needed for correct market hour checks and calculations
    NSE_HOLIDAYS = {
        # 2024
        "2024-01-26", "2024-03-08", "2024-03-25", "2024-03-29", "2024-04-10", "2024-04-17",
        "2024-05-01", "2024-06-17", "2024-07-17", "2024-08-15", "2024-10-02", "2024-11-01",
        "2024-11-15", "2024-12-25",
        # 2025
        "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18",
        "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-12-25",
        # 2026
        "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14",
        "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20",
        "2026-11-10", "2026-11-24", "2026-12-25"
    }

    def is_market_open(self, start_time: str = "09:15", eod_time: str = "15:30") -> bool:
        """
        Check if Indian Equity Market is open (start_time - eod_time IST, Mon-Fri, not holiday).
        """
        now = datetime.now() # System time (Assuming IST system based on user instructions)
        
        # Weekend Check
        if now.weekday() >= 5: # 5=Sat, 6=Sun
            return False
            
        # Holiday Check
        if now.strftime("%Y-%m-%d") in self.NSE_HOLIDAYS:
            return False
            
        # Time Check
        current_time = now.time()
        start = datetime.strptime(start_time, "%H:%M").time()
        end = datetime.strptime(eod_time, "%H:%M").time()
        
        return start <= current_time <= end

    def get_next_market_open(self, start_from: datetime, start_time: str = "09:15") -> datetime:
        """
        Calculates the next market open datetime starting from `start_from` using custom start_time,
        skipping weekends and NSE holidays.
        """
        t = datetime.strptime(start_time, "%H:%M").time()
        if start_from.time() < t:
            candidate = start_from.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        else:
            candidate = (start_from + timedelta(days=1)).replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
            
        while True:
            # Check if weekend
            if candidate.weekday() >= 5: # 5=Sat, 6=Sun
                candidate = (candidate + timedelta(days=1)).replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
                continue
            # Check if holiday
            date_str = candidate.strftime("%Y-%m-%d")
            if date_str in self.NSE_HOLIDAYS:
                logger.info(f"Skipping holiday: {date_str}")
                candidate = (candidate + timedelta(days=1)).replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
                continue
            # Found valid weekday and not a holiday
            break
            
        return candidate

    def wait_for_market_open(self, dry_run: bool = False, sleep_chunk: int = 3600, start_time: str = "09:15", eod_time: str = "15:30", shutdown_check=None) -> None:
        """
        Blocks until the market opens and the configured start time is reached.
        If dry_run is True, it bypasses the wait so that simulation can run immediately.
        shutdown_check: optional callable returning True when a shutdown is requested.
        """
        if dry_run:
            logger.info("[DRY RUN] Bypassing market hour check for simulation.")
            return

        while not self.is_market_open(start_time, eod_time):
            now = datetime.now()
            next_open = self.get_next_market_open(now, start_time)
            time_diff = (next_open - now).total_seconds()

            logger.info(f"Market is closed or start time not reached. Next open: {next_open.strftime('%Y-%m-%d %H:%M')}. Sleeping for {int(time_diff)} seconds...")

            slept = 0
            while slept < time_diff:
                if self.is_market_open(start_time, eod_time):
                    break
                if shutdown_check and shutdown_check():
                    logger.info("Shutdown requested during market-open wait. Exiting.")
                    return
                time.sleep(1)
                slept += 1

            if self.is_market_open(start_time, eod_time):
                break

    def wait_for_next_day_market_open(self, dry_run: bool = False, sleep_chunk: int = 3600, start_time: str = "09:15", shutdown_check=None) -> bool:
        """
        Blocks until the next trading day's market open / custom start_time.
        Useful when a strategy finishes its daily target/SL and wants to wait for the next session.
        shutdown_check: optional callable returning True when a shutdown is requested.
        Returns True if wait completed normally, False if interrupted by shutdown.
        """
        if dry_run:
            logger.info("[DRY RUN] Bypassing forced next-day sleep for simulation.")
            return True

        now = datetime.now()
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        next_open = self.get_next_market_open(tomorrow, start_time)
        time_diff = (next_open - now).total_seconds()

        logger.info(f"Daily Target/SL reached. Waiting for next trading session at: {next_open.strftime('%Y-%m-%d %H:%M')}. Sleeping for {int(time_diff)} seconds...")

        slept = 0
        while slept < time_diff:
            if shutdown_check and shutdown_check():
                logger.info("Shutdown requested during next-day wait. Exiting.")
                return False
            time.sleep(1)
            slept += 1
        return True


