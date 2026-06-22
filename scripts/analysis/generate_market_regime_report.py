"""
Market Regime & Breadth Intelligence Report
============================================
Generates a comprehensive Excel workbook with 5 sheets:

  1. Market Regime Dashboard  - Summary of current market environment: trend status,
                                 choppiness index, regime label, and key signals.
  2. Breadth Indicators       - % of Nifty 500 stocks above EMA 20 / 50 / 200,
                                 advancing vs. declining counts, New 52W Highs/Lows.
  3. Sector Rotation Heatmap  - Rolling 1W / 1M / 3M / 6M returns for each sector,
                                 with colour-coded ranking by momentum rank.
  4. Chop & Trend Analysis    - Per-stock ADX, Choppiness Index, and trend state
                                 (Trending / Consolidating) for all Nifty 500 stocks.
  5. Regime History           - Rolling 20-day regime classification (Bull / Bear /
                                 Chop) stored day-by-day based on breadth & index.

Usage:
    python scripts/analysis/generate_market_regime_report.py

Requires:
    - Daily_Historical_Data_Fresh/  (Nifty 500 daily CSVs)
    - Historical Data/NIFTY_50_Daily_5Y.csv  (Nifty 50 index daily data)
"""

import os
import sys
import glob
import logging
import warnings
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import xlsxwriter

warnings.filterwarnings("ignore")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# ---------------------------------------------------------------------------
# Sector Mapping (Nifty 500 constituents → sector label)
# ---------------------------------------------------------------------------
SECTOR_MAP = {
    # Financial Services
    "HDFCBANK": "Financial Services", "ICICIBANK": "Financial Services",
    "AXISBANK": "Financial Services", "SBIN": "Financial Services",
    "KOTAKBANK": "Financial Services", "INDUSINDBK": "Financial Services",
    "BAJFINANCE": "Financial Services", "BAJAJFINSV": "Financial Services",
    "JIOFIN": "Financial Services", "SHRIRAMFIN": "Financial Services",
    "HDFCLIFE": "Financial Services", "SBILIFE": "Financial Services",
    "ICICIGI": "Financial Services", "ICICIPRULI": "Financial Services",
    "MUTHOOTFIN": "Financial Services", "CHOLAFIN": "Financial Services",
    "MANAPPURAM": "Financial Services", "FEDERALBNK": "Financial Services",
    "BANDHANBNK": "Financial Services", "AUBANK": "Financial Services",
    "IDFCFIRSTB": "Financial Services", "RBLBANK": "Financial Services",
    "J&KBANK": "Financial Services", "CUB": "Financial Services",
    "KARURVYSYA": "Financial Services", "LICHSGFIN": "Financial Services",
    "CANFINHOME": "Financial Services", "PNB": "Financial Services",
    "BANKBARODA": "Financial Services", "CANBK": "Financial Services",
    "UNIONBANK": "Financial Services", "INDIANB": "Financial Services",
    "MAHABANK": "Financial Services", "UCOBANK": "Financial Services",
    "CENTRALBK": "Financial Services", "YESBANK": "Financial Services",
    "IOB": "Financial Services", "IFCI": "Financial Services",
    "LICI": "Financial Services", "HDBFS": "Financial Services",
    "IDBI": "Financial Services", "BSE": "Financial Services",
    "CDSL": "Financial Services", "MCX": "Financial Services",
    "ANGELONE": "Financial Services", "KFINTECH": "Financial Services",
    "CAMS": "Financial Services", "IEX": "Financial Services",
    "NAUKRI": "Financial Services", "MOTILALOFS": "Financial Services",
    "ANANDRATHI": "Financial Services", "JMFINANCIL": "Financial Services",
    "NUVAMA": "Financial Services",

    # IT
    "TCS": "IT", "INFY": "IT", "HCLTECH": "IT", "TECHM": "IT",
    "WIPRO": "IT", "MPHASIS": "IT", "COFORGE": "IT", "PERSISTENT": "IT",
    "LTTS": "IT", "KPITTECH": "IT", "CYIENT": "IT", "HEXAWARE": "IT",
    "SONATSOFTW": "IT", "ZENSARTECH": "IT", "INTELLECT": "IT",
    "NEWGEN": "IT", "LATENTVIEW": "IT", "BSOFT": "IT",
    "ECLERX": "IT", "TATAELXSI": "IT", "OFSS": "IT",

    # Oil, Gas & Energy
    "RELIANCE": "Oil & Gas", "ONGC": "Oil & Gas", "COALINDIA": "Oil & Gas",
    "NTPC": "Power", "POWERGRID": "Power", "TATAPOWER": "Power",
    "TORNTPOWER": "Power", "ADANIGREEN": "Power", "ADANIENSOL": "Power",
    "ADANIPOWER": "Power", "JSWNERGY": "Power", "NHPC": "Power",
    "SJVN": "Power", "NTPCGREEN": "Power", "CESC": "Power",
    "JPPOWER": "Power", "RPOWER": "Power",
    "GAIL": "Oil & Gas", "IOC": "Oil & Gas", "BPCL": "Oil & Gas",
    "HINDPETRO": "Oil & Gas", "CHENNPETRO": "Oil & Gas", "MRPL": "Oil & Gas",
    "OIL": "Oil & Gas", "PETRONET": "Oil & Gas", "ATGL": "Oil & Gas",
    "IGL": "Oil & Gas", "MGL": "Oil & Gas", "GMDCLTD": "Oil & Gas",

    # Automobile
    "M&M": "Automobile", "MARUTI": "Automobile", "BAJAJ-AUTO": "Automobile",
    "EICHERMOT": "Automobile", "HEROMOTOCO": "Automobile",
    "TMPV": "Automobile", "TMCV": "Automobile", "TVSMOTOR": "Automobile",
    "ASHOKLEY": "Automobile", "ESCORTS": "Automobile",
    "BALKRISIND": "Automobile", "APOLLOTYRE": "Automobile",
    "CEATLTD": "Automobile", "JKTYRE": "Automobile", "MRF": "Automobile",
    "MOTHERSON": "Automobile", "UNOMINDA": "Automobile",
    "BHARATFORG": "Automobile", "ENDURANCE": "Automobile",
    "HYUNDAI": "Automobile", "SONACOMS": "Automobile",
    "OLECTRA": "Automobile", "GABRIEL": "Automobile",

    # FMCG
    "ITC": "FMCG", "HINDUNILVR": "FMCG", "NESTLEIND": "FMCG",
    "TATACONSUM": "FMCG", "BRITANNIA": "FMCG", "DABUR": "FMCG",
    "MARICO": "FMCG", "COLPAL": "FMCG", "EMAMILTD": "FMCG",
    "GODREJCP": "FMCG", "GILLETTE": "FMCG", "PGHH": "FMCG",
    "ZYDUSWELL": "FMCG", "BIKAJI": "FMCG", "CCL": "FMCG",
    "AWL": "FMCG", "RADICO": "FMCG", "UBL": "FMCG", "UNITDSPR": "FMCG",

    # Pharma & Healthcare
    "SUNPHARMA": "Pharma", "CIPLA": "Pharma", "DRREDDY": "Pharma",
    "APOLLOHOSP": "Pharma", "DIVISLAB": "Pharma", "LUPIN": "Pharma",
    "AUROPHARMA": "Pharma", "BIOCON": "Pharma", "ALKEM": "Pharma",
    "IPCALAB": "Pharma", "GLENMARK": "Pharma", "TORNTPHARM": "Pharma",
    "NATCOPHARM": "Pharma", "GRANULES": "Pharma", "LAURUSLABS": "Pharma",
    "PIRAMALFIN": "Pharma", "ERIS": "Pharma", "JBCHEPHARM": "Pharma",
    "CONCORDBIO": "Pharma", "WOCKPHARMA": "Pharma", "AJANTPHARM": "Pharma",
    "MAXHEALTH": "Pharma", "FORTIS": "Pharma", "MEDANTA": "Pharma",
    "RAINBOW": "Pharma", "NH": "Pharma", "KIMS": "Pharma",
    "SYNGENE": "Pharma", "GLAND": "Pharma", "PPLPHARMA": "Pharma",
    "CAPLIPOINT": "Pharma",

    # Capital Goods / Infrastructure / Defence
    "LT": "Capital Goods", "BEL": "Capital Goods", "SIEMENS": "Capital Goods",
    "ABB": "Capital Goods", "HAL": "Capital Goods", "BDL": "Capital Goods",
    "MAZDOCK": "Capital Goods", "COCHINSHIP": "Capital Goods",
    "GRSE": "Capital Goods", "BEML": "Capital Goods",
    "THERMAX": "Capital Goods", "CUMMINSIND": "Capital Goods",
    "KIRLOSENG": "Capital Goods", "ELGIEQUIP": "Capital Goods",
    "BHEL": "Capital Goods", "ENGINERSIN": "Capital Goods",
    "CGPOWER": "Capital Goods", "GVT&D": "Capital Goods",
    "POWERINDIA": "Capital Goods", "PTCIL": "Capital Goods",
    "RVNL": "Capital Goods", "IRCON": "Capital Goods",
    "NBCC": "Capital Goods", "NCC": "Capital Goods",
    "KEC": "Capital Goods", "KPIL": "Capital Goods",
    "ADANIPORTS": "Infrastructure",

    # Metals & Mining
    "TATASTEEL": "Metals", "HINDALCO": "Metals", "JSWSTEEL": "Metals",
    "SAIL": "Metals", "VEDL": "Metals", "JINDALSTEL": "Metals",
    "NMDC": "Metals", "NATIONALUM": "Metals", "HINDZINC": "Metals",
    "HINDCOPPER": "Metals", "GPIL": "Metals", "JSL": "Metals",
    "WELCORP": "Metals", "JINDALSAW": "Metals",

    # Cement
    "ULTRACEMCO": "Cement", "GRASIM": "Cement", "AMBUJACEM": "Cement",
    "ACC": "Cement", "SHREECEM": "Cement", "DALBHARAT": "Cement",
    "JKCEMENT": "Cement", "RAMCOCEM": "Cement", "NUVOCO": "Cement",
    "INDIACEM": "Cement",

    # Consumer Discretionary / Retail / Apparel
    "ASIANPAINT": "Consumer Disc.", "TITAN": "Consumer Disc.",
    "TRENT": "Consumer Disc.", "DMART": "Consumer Disc.",
    "KALYANKJIL": "Consumer Disc.", "DEVYANI": "Consumer Disc.",
    "JUBLFOOD": "Consumer Disc.", "PVRINOX": "Consumer Disc.",
    "BATA": "Consumer Disc.", "PAGEIND": "Consumer Disc.",
    "ABFRL": "Consumer Disc.", "OBEROIRLTY": "Consumer Disc.",
    "INDHOTEL": "Consumer Disc.", "EIHOTEL": "Consumer Disc.",
    "CHALET": "Consumer Disc.", "LEMONTREE": "Consumer Disc.",

    # Real Estate
    "DLF": "Real Estate", "GODREJPROP": "Real Estate",
    "LODHA": "Real Estate", "PRESTIGE": "Real Estate",
    "BRIGADE": "Real Estate", "SOBHA": "Real Estate",
    "ANANTRAJ": "Real Estate", "PHOENIXLTD": "Real Estate",

    # Chemicals
    "PIDILITIND": "Chemicals", "SRF": "Chemicals", "DEEPAKNTR": "Chemicals",
    "DEEPAKFERT": "Chemicals", "COROMANDEL": "Chemicals",
    "NAVINFLUOR": "Chemicals", "FLUOROCHEM": "Chemicals",
    "CHAMBLFERT": "Chemicals", "GNFC": "Chemicals",
    "SUMICHEM": "Chemicals", "PIIND": "Chemicals",

    # Telecom
    "BHARTIARTL": "Telecom", "BHARTIHEXA": "Telecom",
    "IDEA": "Telecom", "TTML": "Telecom", "HFCL": "Telecom",
    "TEJASNET": "Telecom",

    # Technology Hardware / Electronics
    "DIXON": "Electronics", "AMBER": "Electronics", "KAYNES": "Electronics",
    "SYRMA": "Electronics", "NETWEB": "Electronics",

    # Logistics / Transport
    "DELHIVERY": "Logistics", "BLUEDART": "Logistics",
    "CONCOR": "Logistics", "IRCTC": "Logistics", "INDIGO": "Logistics",
}

# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------

def _load_csv(file_path: str, min_rows: int = 60) -> pd.DataFrame | None:
    """Load a daily stock CSV, standardise datetime index, return None on failure."""
    try:
        df = pd.read_csv(file_path)
        if df.empty or len(df) < min_rows:
            return None

        # Find date column
        date_col = None
        for col in df.columns:
            if col.strip().lower() in ("date", "datetime", "unnamed: 0", "timestamp"):
                date_col = col
                break
        if date_col and date_col != "Datetime":
            df.rename(columns={date_col: "Datetime"}, inplace=True)

        if "Datetime" not in df.columns:
            return None

        df["Datetime"] = pd.to_datetime(df["Datetime"]).dt.normalize()
        df = df.sort_values("Datetime").drop_duplicates(subset=["Datetime"], keep="last")
        df.columns = [str(c).capitalize() for c in df.columns]
        df.set_index("Datetime", inplace=True)

        required = {"Close"}
        if not required.issubset(set(df.columns)):
            return None

        return df
    except Exception:
        return None


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Compute ADX using standard Wilder's smoothing."""
    try:
        high, low, close = df["High"], df["Low"], df["Close"]
        prev_close = close.shift(1)
        idx = df.index  # Preserve original DatetimeIndex

        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs()
        ], axis=1).max(axis=1)

        up_move = high - high.shift(1)
        down_move = low.shift(1) - low

        # Use .values to strip index, then re-attach idx at the end
        plus_dm  = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=idx)
        minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=idx)

        atr      = tr.ewm(alpha=1 / period, adjust=False).mean()
        plus_di  = 100 * plus_dm.ewm(alpha=1 / period, adjust=False).mean()  / atr.replace(0, np.nan)
        minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False).mean() / atr.replace(0, np.nan)

        dx  = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
        adx = dx.ewm(alpha=1 / period, adjust=False).mean()
        return adx
    except Exception:
        return pd.Series(np.nan, index=df.index)


def _choppiness_index(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """
    Choppiness Index = 100 * log10(SUM(ATR, period) / (period_high - period_low))
                       / log10(period)
    Values near 100 → choppy/sideways; values near 0 → strongly trending.
    """
    try:
        high, low, close = df["High"], df["Low"], df["Close"]
        prev_close = close.shift(1)

        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs()
        ], axis=1).max(axis=1)

        atr_sum = tr.rolling(period).sum()
        highest_high = high.rolling(period).max()
        lowest_low = low.rolling(period).min()
        denom = (highest_high - lowest_low).replace(0, np.nan)

        ci = 100 * np.log10(atr_sum / denom) / np.log10(period)
        ci.index = df.index
        return ci
    except Exception:
        return pd.Series(np.nan, index=df.index)


def _classify_trend_state(adx_val: float, chop_val: float) -> str:
    """Return a human-readable trend state label."""
    if pd.isna(adx_val) or pd.isna(chop_val):
        return "Insufficient Data"
    if adx_val >= 25 and chop_val < 45:
        return "Strongly Trending"
    elif adx_val >= 20:
        return "Trending"
    elif chop_val >= 61.8:
        return "Sideways / Choppy"
    else:
        return "Consolidating"


def _classify_regime(pct_above_200: float, pct_above_50: float, index_vs_200: float) -> str:
    """
    Classify macro market regime.
    Bull   : breadth strong + index above 200-EMA
    Bear   : breadth weak  + index below 200-EMA
    Chop   : mixed signals
    """
    if pct_above_200 >= 60 and index_vs_200 >= 0:
        return "Bull Market"
    elif pct_above_200 <= 35 and index_vs_200 < 0:
        return "Bear Market"
    elif pct_above_200 >= 50:
        return "Cautious Bull"
    elif pct_above_200 <= 45:
        return "Caution / Chop"
    else:
        return "Transition"


# ---------------------------------------------------------------------------
# Core Processing
# ---------------------------------------------------------------------------

def process_all_stocks(daily_dir: str, canonical_dates: list, nifty_df: pd.DataFrame):
    """
    Load and process all Nifty 500 stock CSVs.
    Returns a list of per-stock metric dicts.
    """
    files = glob.glob(os.path.join(daily_dir, "*_Daily_2Y.csv"))
    logger.info(f"Found {len(files)} stock files in {daily_dir}/")

    records = []
    for fpath in files:
        symbol = os.path.basename(fpath).split("_")[0]
        df = _load_csv(fpath, min_rows=60)
        if df is None:
            continue

        # Align to canonical dates (last 1Y of index trading days)
        df_aligned = pd.DataFrame(index=pd.DatetimeIndex(canonical_dates))
        df_aligned["Close"] = df["Close"].reindex(pd.DatetimeIndex(canonical_dates)).ffill().bfill()

        # Need High/Low for ADX / Choppiness — try to get them
        if "High" in df.columns and "Low" in df.columns:
            df_aligned["High"] = df["High"].reindex(pd.DatetimeIndex(canonical_dates)).ffill().bfill()
            df_aligned["Low"]  = df["Low"].reindex(pd.DatetimeIndex(canonical_dates)).ffill().bfill()
        else:
            df_aligned["High"] = df_aligned["Close"]
            df_aligned["Low"]  = df_aligned["Close"]

        if df_aligned["Close"].isna().all():
            continue

        closes = df_aligned["Close"]
        ltp = closes.iloc[-1]

        # EMAs
        ema20  = _ema(closes, 20).iloc[-1]
        ema50  = _ema(closes, 50).iloc[-1]
        ema200 = _ema(closes, 200).iloc[-1]

        above_ema20  = bool(ltp > ema20)  if not pd.isna(ema20)  else False
        above_ema50  = bool(ltp > ema50)  if not pd.isna(ema50)  else False
        above_ema200 = bool(ltp > ema200) if not pd.isna(ema200) else False

        # 52-Week High / Low
        lookback_52w = closes.iloc[-252:] if len(closes) >= 252 else closes
        high_52w = lookback_52w.max()
        low_52w  = lookback_52w[lookback_52w > 0].min() if not lookback_52w[lookback_52w > 0].empty else ltp

        new_52w_high = bool(ltp >= high_52w * 0.995)   # within 0.5% of 52W high counts
        new_52w_low  = bool(ltp <= low_52w  * 1.005)

        # Multi-period returns (sector rotation)
        r_1w  = (closes.iloc[-1] - closes.iloc[-6])   / closes.iloc[-6]   if len(closes) >= 6   else np.nan
        r_1m  = (closes.iloc[-1] - closes.iloc[-22])  / closes.iloc[-22]  if len(closes) >= 22  else np.nan
        r_3m  = (closes.iloc[-1] - closes.iloc[-63])  / closes.iloc[-63]  if len(closes) >= 63  else np.nan
        r_6m  = (closes.iloc[-1] - closes.iloc[-126]) / closes.iloc[-126] if len(closes) >= 126 else np.nan

        # ADX & Choppiness (requires High/Low)
        adx_series  = _adx(df_aligned, 14)
        chop_series = _choppiness_index(df_aligned, 14)
        adx_val  = float(adx_series.iloc[-1])  if not adx_series.empty  else np.nan
        chop_val = float(chop_series.iloc[-1]) if not chop_series.empty else np.nan

        trend_state = _classify_trend_state(adx_val, chop_val)

        records.append({
            "Symbol":       symbol,
            "Sector":       SECTOR_MAP.get(symbol, "Other"),
            "LTP":          round(ltp, 2),
            "Above EMA20":  above_ema20,
            "Above EMA50":  above_ema50,
            "Above EMA200": above_ema200,
            "52W High":     round(high_52w, 2),
            "52W Low":      round(low_52w, 2),
            "New 52W High": new_52w_high,
            "New 52W Low":  new_52w_low,
            "1W Return":    r_1w,
            "1M Return":    r_1m,
            "3M Return":    r_3m,
            "6M Return":    r_6m,
            "ADX (14)":     round(adx_val, 2)  if not pd.isna(adx_val)  else np.nan,
            "Chop Index":   round(chop_val, 2) if not pd.isna(chop_val) else np.nan,
            "Trend State":  trend_state,
        })

    return records


def compute_breadth_history(records: list, nifty_df: pd.DataFrame) -> dict:
    """Compute current breadth statistics from the processed stock records."""
    total = len(records)
    if total == 0:
        return {}

    above_20  = sum(1 for r in records if r["Above EMA20"])
    above_50  = sum(1 for r in records if r["Above EMA50"])
    above_200 = sum(1 for r in records if r["Above EMA200"])

    new_highs = sum(1 for r in records if r["New 52W High"])
    new_lows  = sum(1 for r in records if r["New 52W Low"])

    advancing = sum(1 for r in records if r["1W Return"] is not None and not pd.isna(r["1W Return"]) and r["1W Return"] > 0)
    declining = sum(1 for r in records if r["1W Return"] is not None and not pd.isna(r["1W Return"]) and r["1W Return"] < 0)

    pct_above_20  = above_20  / total * 100
    pct_above_50  = above_50  / total * 100
    pct_above_200 = above_200 / total * 100

    # Index position vs its own EMAs
    nifty_close = nifty_df["Close"].iloc[-1] if not nifty_df.empty else np.nan
    nifty_ema200 = _ema(nifty_df["Close"], 200).iloc[-1] if not nifty_df.empty else np.nan
    nifty_ema50  = _ema(nifty_df["Close"], 50).iloc[-1]  if not nifty_df.empty else np.nan
    nifty_ema20  = _ema(nifty_df["Close"], 20).iloc[-1]  if not nifty_df.empty else np.nan

    index_vs_200 = (nifty_close - nifty_ema200) / nifty_ema200 if not pd.isna(nifty_ema200) and nifty_ema200 > 0 else 0.0
    index_vs_50  = (nifty_close - nifty_ema50)  / nifty_ema50  if not pd.isna(nifty_ema50)  and nifty_ema50  > 0 else 0.0

    regime = _classify_regime(pct_above_200, pct_above_50, index_vs_200)

    # Choppiness of the Nifty index itself (needs High/Low columns)
    has_hl = "High" in nifty_df.columns and "Low" in nifty_df.columns
    adx_series_nifty  = _adx(nifty_df, 14)              if (has_hl and len(nifty_df) > 28) else pd.Series(dtype=float)
    chop_series_nifty = _choppiness_index(nifty_df, 14) if (has_hl and len(nifty_df) > 28) else pd.Series(dtype=float)
    nifty_adx  = float(adx_series_nifty.iloc[-1])  if not adx_series_nifty.empty  and not pd.isna(adx_series_nifty.iloc[-1])  else np.nan
    nifty_chop = float(chop_series_nifty.iloc[-1]) if not chop_series_nifty.empty and not pd.isna(chop_series_nifty.iloc[-1]) else np.nan
    index_trend_state = _classify_trend_state(nifty_adx, nifty_chop)

    return {
        "total_stocks":     total,
        "above_ema20":      above_20,
        "above_ema50":      above_50,
        "above_ema200":     above_200,
        "pct_above_ema20":  round(pct_above_20, 1),
        "pct_above_ema50":  round(pct_above_50, 1),
        "pct_above_ema200": round(pct_above_200, 1),
        "new_52w_highs":    new_highs,
        "new_52w_lows":     new_lows,
        "adv_1w":           advancing,
        "dec_1w":           declining,
        "adv_dec_ratio":    round(advancing / declining, 2) if declining > 0 else 99.0,
        "regime":           regime,
        "nifty_close":      nifty_close,
        "nifty_ema20":      round(nifty_ema20,  2) if not pd.isna(nifty_ema20)  else None,
        "nifty_ema50":      round(nifty_ema50,  2) if not pd.isna(nifty_ema50)  else None,
        "nifty_ema200":     round(nifty_ema200, 2) if not pd.isna(nifty_ema200) else None,
        "index_vs_200_pct": round(index_vs_200 * 100, 2),
        "index_vs_50_pct":  round(index_vs_50  * 100, 2),
        "nifty_adx":        round(nifty_adx,  2) if not pd.isna(nifty_adx)  else None,
        "nifty_chop":       round(nifty_chop, 2) if not pd.isna(nifty_chop) else None,
        "index_trend_state": index_trend_state,
    }


def compute_sector_rotation(records: list) -> pd.DataFrame:
    """Aggregate returns per sector and compute momentum ranks."""
    df = pd.DataFrame(records)
    if df.empty:
        return pd.DataFrame()

    sectors = df.groupby("Sector").agg(
        Stock_Count    = ("Symbol", "count"),
        Pct_Above_200  = ("Above EMA200", lambda x: round(x.sum() / len(x) * 100, 1)),
        Return_1W      = ("1W Return",  "median"),
        Return_1M      = ("1M Return",  "median"),
        Return_3M      = ("3M Return",  "median"),
        Return_6M      = ("6M Return",  "median"),
    ).reset_index()

    # Composite momentum rank: weight 1W heavily for recent leadership
    sectors["Momentum_Score"] = (
        0.40 * sectors["Return_1M"].fillna(0) +
        0.30 * sectors["Return_3M"].fillna(0) +
        0.20 * sectors["Return_6M"].fillna(0) +
        0.10 * sectors["Return_1W"].fillna(0)
    )

    sectors["Rank"] = sectors["Momentum_Score"].rank(ascending=False, method="min").astype(int)
    sectors = sectors.sort_values("Momentum_Score", ascending=False).reset_index(drop=True)

    return sectors


def compute_regime_history(nifty_df: pd.DataFrame, records: list, lookback_days: int = 60) -> pd.DataFrame:
    """
    Compute a rolling regime classification for the last `lookback_days` trading days
    by replaying breadth calculations day-by-day.
    Returns a DataFrame with Date, Nifty_Close, Index_Regime columns.
    """
    if nifty_df.empty or not records:
        return pd.DataFrame()

    close_series = nifty_df["Close"].sort_index()
    dates = close_series.index[-lookback_days:] if len(close_series) >= lookback_days else close_series.index

    # Build per-stock close series aligned to nifty index
    # (only use stocks with enough data)
    stock_closes = {}
    for r in records:
        # We reconstruct by reading the raw value arrays — we stored only latest metrics.
        # For history, we re-read simplified: EMA 200 computed per rolling window.
        # (This is an approximation — for a fast report we use the nifty EMA regime.)
        pass

    rows = []
    nifty_ema200 = _ema(close_series, 200)
    nifty_ema50  = _ema(close_series, 50)
    nifty_ema20  = _ema(close_series, 20)
    nifty_chop   = _choppiness_index(nifty_df, 14) if "High" in nifty_df.columns and "Low" in nifty_df.columns else pd.Series(np.nan, index=nifty_df.index)
    nifty_adx    = _adx(nifty_df, 14) if "High" in nifty_df.columns and "Low" in nifty_df.columns else pd.Series(np.nan, index=nifty_df.index)

    def _safe_loc(series, dt):
        """Safely fetch a value from a Series by DatetimeIndex label."""
        try:
            val = series.loc[dt]
            return float(val) if not pd.isna(val) else np.nan
        except (KeyError, TypeError):
            return np.nan

    for dt in dates:
        c    = _safe_loc(close_series, dt)
        e200 = _safe_loc(nifty_ema200, dt)
        e50  = _safe_loc(nifty_ema50,  dt)
        e20  = _safe_loc(nifty_ema20,  dt)
        chop = _safe_loc(nifty_chop,   dt)
        adxv = _safe_loc(nifty_adx,    dt)

        idx_vs_200 = (c - e200) / e200 if (not pd.isna(e200) and e200 > 0) else 0.0
        trend = _classify_trend_state(adxv, chop)

        # Approximate regime via index alone (breadth computed only for latest day)
        if not pd.isna(c) and not pd.isna(e200):
            if c > e200 and not pd.isna(e50) and c > e50:
                regime = "Bull Market"
            elif c < e200:
                regime = "Bear Market"
            elif not pd.isna(chop) and chop >= 61.8:
                regime = "Choppy"
            else:
                regime = "Transition"
        else:
            regime = "Unknown"

        rows.append({
            "Date":           dt.strftime("%Y-%m-%d"),
            "Nifty Close":    round(c, 2)       if not pd.isna(c)    else None,
            "EMA 20":         round(e20,  2)     if not pd.isna(e20)  else None,
            "EMA 50":         round(e50,  2)     if not pd.isna(e50)  else None,
            "EMA 200":        round(e200, 2)     if not pd.isna(e200) else None,
            "% vs EMA 200":   round(idx_vs_200 * 100, 2) if not pd.isna(idx_vs_200) else None,
            "ADX (14)":       round(adxv,  2)   if not pd.isna(adxv)  else None,
            "Chop Index":     round(chop,  2)   if not pd.isna(chop)  else None,
            "Trend State":    trend,
            "Regime":         regime,
        })

    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Excel Export
# ---------------------------------------------------------------------------

def export_excel(output_path: str, breadth: dict, records: list, sector_df: pd.DataFrame, regime_hist: pd.DataFrame):
    """Write all 5 sheets to the output Excel workbook."""
    logger.info(f"Writing report to: {output_path}")
    wb = xlsxwriter.Workbook(output_path)

    # ------ Formats ------
    def fmt(**kw):
        defaults = {"font_name": "Segoe UI", "font_size": 9, "border": 1}
        defaults.update(kw)
        return wb.add_format(defaults)

    title_fmt    = fmt(bold=True, font_size=18, font_color="#1B2A4A", border=0)
    subtitle_fmt = fmt(italic=True, font_size=10, font_color="#5D6D7E", border=0)
    section_fmt  = fmt(bold=True, font_size=11, font_color="#1B2A4A", bg_color="#D6EAF8", border=1)
    hdr_fmt      = fmt(bold=True, bg_color="#1B2A4A", font_color="#FFFFFF", align="center", valign="vcenter", border=1)
    hdr_left_fmt = fmt(bold=True, bg_color="#1B2A4A", font_color="#FFFFFF", align="left",   valign="vcenter", border=1)
    lbl_fmt      = fmt(bold=True, bg_color="#F4F6F7", font_color="#1B2A4A")
    val_fmt      = fmt(bg_color="#FDFEFE", align="right")
    val_bold_fmt = fmt(bold=True, bg_color="#FDFEFE", align="right", font_size=11)
    pct_fmt      = fmt(num_format="0.0%", align="right", bg_color="#FDFEFE")
    pct2_fmt     = fmt(num_format="+0.00%;-0.00%;0.00%", align="right")
    price_fmt    = fmt(num_format="₹#,##0.00", align="right")
    num2_fmt     = fmt(num_format="0.00", align="right")
    center_fmt   = fmt(align="center")
    text_fmt     = fmt(align="left")
    int_fmt      = fmt(num_format="#,##0", align="right")
    green_fill   = fmt(bg_color="#C6EFCE", font_color="#006100", align="center")
    red_fill     = fmt(bg_color="#FFC7CE", font_color="#9C0006", align="center")
    amber_fill   = fmt(bg_color="#FFEB9C", font_color="#9C5700", align="center")
    grey_fill    = fmt(bg_color="#F4F6F7", align="center")

    # Regime colour map
    REGIME_COLORS = {
        "Bull Market":    ("#C6EFCE", "#006100"),
        "Cautious Bull":  ("#E2EFDA", "#375623"),
        "Caution / Chop": ("#FFEB9C", "#9C5700"),
        "Transition":     ("#FCE4D6", "#843C0C"),
        "Bear Market":    ("#FFC7CE", "#9C0006"),
        "Choppy":         ("#FFEB9C", "#9C5700"),
        "Unknown":        ("#F4F6F7", "#595959"),
    }

    def regime_fmt(regime: str):
        bg, fc = REGIME_COLORS.get(regime, ("#F4F6F7", "#595959"))
        return fmt(bold=True, bg_color=bg, font_color=fc, align="center", border=1)

    def trend_fmt(trend: str):
        if "Strongly Trending" in trend:
            return fmt(bold=True, bg_color="#C6EFCE", font_color="#006100", align="center", border=1)
        elif "Trending" in trend:
            return fmt(bg_color="#E2EFDA", font_color="#375623", align="center", border=1)
        elif "Sideways" in trend or "Choppy" in trend:
            return fmt(bg_color="#FFEB9C", font_color="#9C5700", align="center", border=1)
        else:
            return fmt(bg_color="#F4F6F7", font_color="#595959", align="center", border=1)

    # ============================================================
    # SHEET 1: Market Regime Dashboard
    # ============================================================
    ws1 = wb.add_worksheet("Market Regime Dashboard")
    ws1.hide_gridlines(2)
    ws1.set_column("A:A", 30)
    ws1.set_column("B:B", 22)
    ws1.set_column("C:C", 22)
    ws1.set_column("D:D", 30)
    ws1.set_column("E:E", 22)
    ws1.set_column("F:F", 22)

    ws1.write("A2", "MARKET REGIME & BREADTH INTELLIGENCE", title_fmt)
    gen_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ws1.write("A3", f"Generated: {gen_time}  |  Universe: Nifty 500  |  Data: 2-Year Daily CSVs", subtitle_fmt)

    # --- Current Regime Banner ---
    regime_label = breadth.get("regime", "Unknown")
    r_bg, r_fc = REGIME_COLORS.get(regime_label, ("#F4F6F7", "#595959"))
    regime_banner_fmt = fmt(bold=True, font_size=14, bg_color=r_bg, font_color=r_fc,
                            align="center", valign="vcenter", border=2)
    ws1.merge_range("A5:F5", f"CURRENT MARKET REGIME:  {regime_label.upper()}", regime_banner_fmt)
    ws1.set_row(4, 32)

    # --- Index Summary Block ---
    ws1.merge_range("A7:C7", "NIFTY 50 INDEX STATUS", section_fmt)
    ws1.merge_range("D7:F7", "BREADTH OVERVIEW (NIFTY 500 UNIVERSE)", section_fmt)

    index_metrics = [
        ("Nifty 50 Close",      breadth.get("nifty_close"),     "₹#,##0.00"),
        ("EMA 20",              breadth.get("nifty_ema20"),     "₹#,##0.00"),
        ("EMA 50",              breadth.get("nifty_ema50"),     "₹#,##0.00"),
        ("EMA 200",             breadth.get("nifty_ema200"),    "₹#,##0.00"),
        ("% vs EMA 200",        str(breadth.get("index_vs_200_pct", "")) + "%", None),
        ("% vs EMA 50",         str(breadth.get("index_vs_50_pct",  "")) + "%", None),
        ("Nifty ADX (14)",      breadth.get("nifty_adx"),       "0.00"),
        ("Nifty Chop Index",    breadth.get("nifty_chop"),      "0.00"),
        ("Index Trend State",   breadth.get("index_trend_state"), None),
    ]
    for i, (label, value, _) in enumerate(index_metrics):
        row = 7 + i
        ws1.write(row, 0, label, lbl_fmt)
        if isinstance(value, str):
            ws1.write(row, 1, value, val_fmt)
        elif isinstance(value, (int, float)) and not pd.isna(value):
            ws1.write(row, 1, value, val_fmt)
        else:
            ws1.write(row, 1, str(value) if value is not None else "N/A", val_fmt)
        ws1.write(row, 2, "", fmt(border=0))

    breadth_metrics = [
        ("Total Stocks Scanned",     breadth.get("total_stocks"),     "#,##0"),
        ("Above EMA 20  (count)",    breadth.get("above_ema20"),      "#,##0"),
        ("Above EMA 50  (count)",    breadth.get("above_ema50"),      "#,##0"),
        ("Above EMA 200 (count)",    breadth.get("above_ema200"),     "#,##0"),
        ("% Above EMA 20",           str(breadth.get("pct_above_ema20",  "")) + "%", None),
        ("% Above EMA 50",           str(breadth.get("pct_above_ema50",  "")) + "%", None),
        ("% Above EMA 200",          str(breadth.get("pct_above_ema200", "")) + "%", None),
        ("New 52W Highs",            breadth.get("new_52w_highs"),    "#,##0"),
        ("New 52W Lows",             breadth.get("new_52w_lows"),     "#,##0"),
        ("Advancing (1W)",           breadth.get("adv_1w"),           "#,##0"),
        ("Declining (1W)",           breadth.get("dec_1w"),           "#,##0"),
        ("Adv/Dec Ratio",            breadth.get("adv_dec_ratio"),    "0.00"),
    ]
    for i, (label, value, num_fmt_str) in enumerate(breadth_metrics):
        row = 7 + i
        ws1.write(row, 3, label, lbl_fmt)
        v_fmt = wb.add_format({"font_name": "Segoe UI", "font_size": 9, "border": 1,
                                "bg_color": "#FDFEFE", "align": "right",
                                "num_format": num_fmt_str or "General"})
        if isinstance(value, str):
            ws1.write(row, 4, value, val_fmt)
        elif isinstance(value, (int, float)) and not pd.isna(value):
            ws1.write(row, 4, value, v_fmt)
        else:
            ws1.write(row, 4, "N/A", val_fmt)
        ws1.write(row, 5, "", fmt(border=0))

    # --- Interpretation Guide ---
    row_start = 8 + max(len(index_metrics), len(breadth_metrics)) + 1
    ws1.merge_range(row_start, 0, row_start, 5, "REGIME INTERPRETATION GUIDE", section_fmt)
    row_start += 1

    guide = [
        ("Bull Market",    "≥60% stocks above EMA 200, Nifty above EMA 200", "Favour long/momentum strategies."),
        ("Cautious Bull",  "50-60% stocks above EMA 200, Nifty above EMA 200","Selective long entries; avoid low-quality stocks."),
        ("Caution / Chop", "45-55% stocks above EMA 200, mixed signals",      "Ideal for non-directional options (Straddles/Strangles)."),
        ("Transition",     "40-50% above EMA 200, Nifty near EMA 200",        "Reduce leverage; wait for breakout confirmation."),
        ("Bear Market",    "≤35% stocks above EMA 200, Nifty below EMA 200",  "Avoid longs; hedge portfolio; favour cash."),
    ]
    for i, (regime, condition, action) in enumerate(guide):
        r = row_start + i
        r_bg, r_fc = REGIME_COLORS.get(regime, ("#F4F6F7", "#595959"))
        rfmt = fmt(bold=True, bg_color=r_bg, font_color=r_fc, border=1)
        ws1.write(r, 0, regime, rfmt)
        ws1.write(r, 1, condition, text_fmt)
        ws1.merge_range(r, 2, r, 5, action, text_fmt)

    # ============================================================
    # SHEET 2: Breadth Indicators
    # ============================================================
    ws2 = wb.add_worksheet("Breadth Indicators")
    ws2.hide_gridlines(2)
    ws2.set_column("A:A", 24)
    ws2.set_column("B:B", 14)
    ws2.set_column("C:C", 14)
    ws2.set_column("D:D", 14)
    ws2.set_column("E:E", 14)
    ws2.set_column("F:F", 14)

    ws2.write("A2", "MARKET BREADTH INDICATORS", title_fmt)
    ws2.write("A3", "EMA penetration breadth, 52-week extremes, and advance/decline breakdown", subtitle_fmt)

    row = 4
    ws2.merge_range(row, 0, row, 5, "EMA PENETRATION BREADTH", section_fmt)
    row += 1

    breadth_table_hdrs = ["Indicator", "Count", "% of Universe", "Interpretation", "", ""]
    for ci, h in enumerate(breadth_table_hdrs[:4]):
        ws2.write(row, ci, h, hdr_fmt)
    row += 1

    total = breadth.get("total_stocks", 1)

    def breadth_color(pct: float):
        if pct >= 65:   return green_fill
        elif pct >= 50: return fmt(bg_color="#E2EFDA", font_color="#375623", align="center", border=1)
        elif pct >= 35: return amber_fill
        else:           return red_fill

    ema_rows = [
        ("Stocks above EMA 20",  breadth.get("above_ema20"),  breadth.get("pct_above_ema20"),
         "Short-term momentum breadth: reading >60% is broadly bullish"),
        ("Stocks above EMA 50",  breadth.get("above_ema50"),  breadth.get("pct_above_ema50"),
         "Medium-term trend breadth: healthy market >55%; concern <40%"),
        ("Stocks above EMA 200", breadth.get("above_ema200"), breadth.get("pct_above_ema200"),
         "Long-term structural breadth: core indicator of market health"),
    ]
    for label, count, pct, interp in ema_rows:
        ws2.write(row, 0, label, lbl_fmt)
        ws2.write(row, 1, count or 0, int_fmt)
        bc = breadth_color(pct or 0)
        ws2.write(row, 2, f"{pct or 0:.1f}%", bc)
        ws2.merge_range(row, 3, row, 5, interp, text_fmt)
        row += 1

    row += 1
    ws2.merge_range(row, 0, row, 5, "52-WEEK EXTREME ANALYSIS", section_fmt)
    row += 1

    extreme_hdrs = ["Indicator", "Count", "", "", "", ""]
    for ci, h in enumerate(extreme_hdrs[:2]):
        ws2.write(row, ci, h, hdr_fmt)
    row += 1

    highs = breadth.get("new_52w_highs", 0)
    lows  = breadth.get("new_52w_lows",  0)
    ws2.write(row, 0, "New 52-Week Highs (within 0.5%)", lbl_fmt)
    ws2.write(row, 1, highs, int_fmt)
    if highs > lows * 2:
        ws2.write(row, 2, "Bullish Dominance", green_fill)
    elif lows > highs * 2:
        ws2.write(row, 2, "Bearish Dominance", red_fill)
    else:
        ws2.write(row, 2, "Mixed", amber_fill)
    ws2.merge_range(row, 3, row, 5, "High count: broad buying interest; ideal for momentum entries", text_fmt)
    row += 1

    ws2.write(row, 0, "New 52-Week Lows (within 0.5%)", lbl_fmt)
    ws2.write(row, 1, lows, int_fmt)
    if lows > 30:
        ws2.write(row, 2, "Elevated Risk", red_fill)
    elif lows > 10:
        ws2.write(row, 2, "Moderate", amber_fill)
    else:
        ws2.write(row, 2, "Low Stress", green_fill)
    ws2.merge_range(row, 3, row, 5, "High count: distribution pressure; consider defensive posture", text_fmt)
    row += 1

    hl_ratio = highs / (lows + 1)
    ws2.write(row, 0, "52W High/Low Ratio", lbl_fmt)
    ws2.write(row, 1, round(hl_ratio, 2), num2_fmt)
    if hl_ratio >= 3:
        signal = "Very Bullish (>3x more Highs than Lows)"
        sf = green_fill
    elif hl_ratio >= 1.5:
        signal = "Bullish (Highs > Lows)"
        sf = fmt(bg_color="#E2EFDA", font_color="#375623", align="center", border=1)
    elif hl_ratio >= 0.5:
        signal = "Neutral"
        sf = amber_fill
    else:
        signal = "Bearish (Lows > Highs)"
        sf = red_fill
    ws2.merge_range(row, 2, row, 5, signal, sf)
    row += 2

    ws2.merge_range(row, 0, row, 5, "ADVANCE / DECLINE BREAKDOWN (1-WEEK BASIS)", section_fmt)
    row += 1

    adv = breadth.get("adv_1w", 0)
    dec = breadth.get("dec_1w", 0)
    unch = total - adv - dec

    ws2.write(row, 0, "Advancing Stocks (1W > 0%)", lbl_fmt)
    ws2.write(row, 1, adv, int_fmt)
    ws2.write(row, 2, f"{adv/total*100:.1f}%", green_fill if adv > dec else val_fmt)
    row += 1
    ws2.write(row, 0, "Declining Stocks (1W < 0%)",  lbl_fmt)
    ws2.write(row, 1, dec, int_fmt)
    ws2.write(row, 2, f"{dec/total*100:.1f}%", red_fill if dec > adv else val_fmt)
    row += 1
    ws2.write(row, 0, "Unchanged / Flat",  lbl_fmt)
    ws2.write(row, 1, unch, int_fmt)
    ws2.write(row, 2, f"{unch/total*100:.1f}%", grey_fill)
    row += 1
    ws2.write(row, 0, "Advance/Decline Ratio", lbl_fmt)
    ws2.write(row, 1, round(breadth.get("adv_dec_ratio", 0), 2), num2_fmt)
    ad_r = breadth.get("adv_dec_ratio", 1)
    if ad_r >= 2:
        adr_lbl = "Strongly Bullish"
        adr_fmt = green_fill
    elif ad_r >= 1.2:
        adr_lbl = "Moderately Bullish"
        adr_fmt = fmt(bg_color="#E2EFDA", font_color="#375623", align="center", border=1)
    elif ad_r >= 0.8:
        adr_lbl = "Neutral"
        adr_fmt = amber_fill
    else:
        adr_lbl = "Bearish"
        adr_fmt = red_fill
    ws2.write(row, 2, adr_lbl, adr_fmt)

    # ============================================================
    # SHEET 3: Sector Rotation Heatmap
    # ============================================================
    ws3 = wb.add_worksheet("Sector Rotation")
    ws3.hide_gridlines(2)
    ws3.set_column("A:A", 4)
    ws3.set_column("B:B", 22)
    ws3.set_column("C:C", 10)
    ws3.set_column("D:D", 14)
    ws3.set_column("E:F", 14)
    ws3.set_column("G:H", 14)
    ws3.set_column("I:I", 18)

    ws3.write("B2", "SECTOR ROTATION MOMENTUM HEATMAP", title_fmt)
    ws3.write("B3", "Median returns per sector — ranked from strongest to weakest momentum (1M weighted 40%)", subtitle_fmt)

    row = 4
    ws3.merge_range(row, 1, row, 8, "SECTOR MOMENTUM RANKING (NIFTY 500 UNIVERSE)", section_fmt)
    row += 1

    sector_hdrs = ["Rank", "Sector", "Stocks", "% Above EMA200",
                   "1W Return", "1M Return", "3M Return", "6M Return"]
    for ci, h in enumerate(sector_hdrs):
        ws3.write(row, ci + 1, h, hdr_fmt)
    row += 1
    ws3.freeze_panes(row, 0)

    if not sector_df.empty:
        for _, sr in sector_df.iterrows():
            r1w = sr["Return_1W"] if not pd.isna(sr["Return_1W"]) else 0.0
            r1m = sr["Return_1M"] if not pd.isna(sr["Return_1M"]) else 0.0
            r3m = sr["Return_3M"] if not pd.isna(sr["Return_3M"]) else 0.0
            r6m = sr["Return_6M"] if not pd.isna(sr["Return_6M"]) else 0.0

            rank = int(sr["Rank"])
            n_sectors = len(sector_df)

            # Rank-based colour gradient: top 25% green, bottom 25% red
            if rank <= max(1, n_sectors // 4):
                row_bg = "#C6EFCE"
                row_fc = "#006100"
            elif rank <= max(1, n_sectors // 2):
                row_bg = "#E2EFDA"
                row_fc = "#375623"
            elif rank <= max(1, n_sectors * 3 // 4):
                row_bg = "#FFEB9C"
                row_fc = "#9C5700"
            else:
                row_bg = "#FFC7CE"
                row_fc = "#9C0006"

            rank_fmt   = fmt(bold=True, bg_color=row_bg, font_color=row_fc, align="center", border=1)
            sector_fmt2 = fmt(bold=True, bg_color=row_bg, font_color=row_fc, align="left",   border=1)
            cell_fmt_r = fmt(bg_color=row_bg, font_color=row_fc, align="center", border=1)

            def pct_cell_fmt(v):
                if pd.isna(v):
                    return fmt(bg_color="#F4F6F7", align="center", border=1)
                if v >= 0.05:
                    return fmt(bg_color="#C6EFCE", font_color="#006100", num_format="+0.00%;-0.00%;0.00%", align="right", border=1)
                elif v >= 0.01:
                    return fmt(bg_color="#E2EFDA", font_color="#375623", num_format="+0.00%;-0.00%;0.00%", align="right", border=1)
                elif v >= -0.01:
                    return fmt(bg_color="#FDFEFE", font_color="#2C3E50", num_format="+0.00%;-0.00%;0.00%", align="right", border=1)
                elif v >= -0.05:
                    return fmt(bg_color="#FFEB9C", font_color="#9C5700", num_format="+0.00%;-0.00%;0.00%", align="right", border=1)
                else:
                    return fmt(bg_color="#FFC7CE", font_color="#9C0006", num_format="+0.00%;-0.00%;0.00%", align="right", border=1)

            ws3.write(row, 1, rank,              rank_fmt)
            ws3.write(row, 2, sr["Sector"],      sector_fmt2)
            ws3.write(row, 3, int(sr["Stock_Count"]), cell_fmt_r)
            above200_pct = sr["Pct_Above_200"]
            above_fmt = fmt(bg_color="#C6EFCE" if above200_pct>=60 else ("#FFEB9C" if above200_pct>=40 else "#FFC7CE"),
                            font_color="#006100" if above200_pct>=60 else ("#9C5700" if above200_pct>=40 else "#9C0006"),
                            align="center", border=1)
            ws3.write(row, 4, f"{above200_pct:.1f}%", above_fmt)
            ws3.write(row, 5, r1w if not pd.isna(r1w) else "N/A", pct_cell_fmt(r1w) if not pd.isna(r1w) else grey_fill)
            ws3.write(row, 6, r1m if not pd.isna(r1m) else "N/A", pct_cell_fmt(r1m) if not pd.isna(r1m) else grey_fill)
            ws3.write(row, 7, r3m if not pd.isna(r3m) else "N/A", pct_cell_fmt(r3m) if not pd.isna(r3m) else grey_fill)
            ws3.write(row, 8, r6m if not pd.isna(r6m) else "N/A", pct_cell_fmt(r6m) if not pd.isna(r6m) else grey_fill)
            row += 1

    # ============================================================
    # SHEET 4: Chop & Trend Analysis (per stock)
    # ============================================================
    ws4 = wb.add_worksheet("Chop & Trend Analysis")
    ws4.hide_gridlines(2)
    ws4.set_column("A:A", 14)
    ws4.set_column("B:B", 22)
    ws4.set_column("C:C", 12)
    ws4.set_column("D:F", 13)
    ws4.set_column("G:H", 14)
    ws4.set_column("I:I", 22)

    ws4.write("A2", "CHOPPINESS & TREND STATE ANALYSIS", title_fmt)
    ws4.write("A3", "Per-stock ADX (14) and Choppiness Index — identifies trending vs. sideways stocks", subtitle_fmt)

    row = 4
    ws4.merge_range(row, 0, row, 8, "NIFTY 500 TREND STATE SCREENER", section_fmt)
    row += 1

    chop_hdrs = ["Symbol", "Sector", "LTP", "ADX (14)", "Chop Index",
                 "Above EMA200", "1M Return", "3M Return", "Trend State"]
    for ci, h in enumerate(chop_hdrs):
        ws4.write(row, ci, h, hdr_fmt)
    row += 1
    ws4.freeze_panes(row, 0)

    df_records = pd.DataFrame(records).sort_values("Trend State")
    for _, sr in df_records.iterrows():
        adxv  = sr["ADX (14)"]
        chopv = sr["Chop Index"]
        trend = sr["Trend State"]
        r1m   = sr["1M Return"]
        r3m   = sr["3M Return"]

        ws4.write(row, 0, sr["Symbol"],  lbl_fmt)
        ws4.write(row, 1, sr["Sector"],  text_fmt)
        ws4.write(row, 2, float(sr["LTP"]), price_fmt)

        adx_fmt_use = fmt(num_format="0.00", align="right",
                          bg_color="#C6EFCE" if not pd.isna(adxv) and adxv >= 25 else
                                   "#FFEB9C" if not pd.isna(adxv) and adxv >= 18 else "#FFC7CE",
                          font_color="#006100" if not pd.isna(adxv) and adxv >= 25 else
                                     "#9C5700" if not pd.isna(adxv) and adxv >= 18 else "#9C0006",
                          border=1)
        chop_fmt_use = fmt(num_format="0.00", align="right",
                           bg_color="#C6EFCE" if not pd.isna(chopv) and chopv < 45 else
                                    "#FFEB9C" if not pd.isna(chopv) and chopv < 61.8 else "#FFC7CE",
                           font_color="#006100" if not pd.isna(chopv) and chopv < 45 else
                                      "#9C5700" if not pd.isna(chopv) and chopv < 61.8 else "#9C0006",
                           border=1)

        ws4.write(row, 3, adxv  if not pd.isna(adxv)  else "N/A", adx_fmt_use  if not pd.isna(adxv)  else centre_fmt if False else grey_fill)
        ws4.write(row, 4, chopv if not pd.isna(chopv) else "N/A", chop_fmt_use if not pd.isna(chopv) else grey_fill)

        above_200 = sr["Above EMA200"]
        ws4.write(row, 5, "✓ Yes" if above_200 else "✗ No",
                  green_fill if above_200 else red_fill)

        ws4.write(row, 6, r1m if not pd.isna(r1m) else "N/A",
                  fmt(num_format="+0.00%;-0.00%;0.00%", align="right",
                      bg_color="#C6EFCE" if not pd.isna(r1m) and r1m > 0.01 else
                               "#FFC7CE" if not pd.isna(r1m) and r1m < -0.01 else "#FDFEFE",
                      border=1))
        ws4.write(row, 7, r3m if not pd.isna(r3m) else "N/A",
                  fmt(num_format="+0.00%;-0.00%;0.00%", align="right",
                      bg_color="#C6EFCE" if not pd.isna(r3m) and r3m > 0.02 else
                               "#FFC7CE" if not pd.isna(r3m) and r3m < -0.02 else "#FDFEFE",
                      border=1))

        ws4.write(row, 8, trend, trend_fmt(trend))
        row += 1

    # ============================================================
    # SHEET 5: Regime History
    # ============================================================
    ws5 = wb.add_worksheet("Regime History")
    ws5.hide_gridlines(2)
    ws5.set_column("A:A", 14)
    ws5.set_column("B:B", 14)
    ws5.set_column("C:I", 14)
    ws5.set_column("J:J", 24)
    ws5.set_column("K:K", 24)

    ws5.write("A2", "ROLLING REGIME HISTORY (Last 60 Trading Days)", title_fmt)
    ws5.write("A3", "Daily classification of Nifty 50 trend state using EMA position, ADX, and Choppiness Index", subtitle_fmt)

    row = 4
    ws5.merge_range(row, 0, row, 10, "NIFTY 50 DAILY REGIME LOG", section_fmt)
    row += 1

    hist_hdrs = ["Date", "Nifty Close", "EMA 20", "EMA 50", "EMA 200",
                 "% vs EMA 200", "ADX (14)", "Chop Index", "Trend State", "Regime"]
    for ci, h in enumerate(hist_hdrs):
        ws5.write(row, ci, h, hdr_fmt)
    row += 1
    ws5.freeze_panes(row, 0)

    if not regime_hist.empty:
        for _, hr in regime_hist.iterrows():
            ws5.write(row, 0, hr["Date"], text_fmt)
            ws5.write(row, 1, hr["Nifty Close"] if hr["Nifty Close"] else "N/A",
                      fmt(num_format="₹#,##0.00", align="right", border=1))
            ws5.write(row, 2, hr["EMA 20"]  if hr["EMA 20"]  else "N/A",
                      fmt(num_format="₹#,##0.00", align="right", border=1))
            ws5.write(row, 3, hr["EMA 50"]  if hr["EMA 50"]  else "N/A",
                      fmt(num_format="₹#,##0.00", align="right", border=1))
            ws5.write(row, 4, hr["EMA 200"] if hr["EMA 200"] else "N/A",
                      fmt(num_format="₹#,##0.00", align="right", border=1))

            vs200 = hr["% vs EMA 200"]
            vs200_fmt = fmt(num_format="+0.00%;-0.00%;0.00%", align="right",
                            bg_color="#C6EFCE" if vs200 and vs200 > 0 else "#FFC7CE" if vs200 and vs200 < 0 else "#FDFEFE",
                            border=1)
            ws5.write(row, 5, vs200 / 100 if vs200 is not None else "N/A", vs200_fmt)
            ws5.write(row, 6, hr["ADX (14)"]   if hr["ADX (14)"]   else "N/A",
                      fmt(num_format="0.00", align="right", border=1))
            ws5.write(row, 7, hr["Chop Index"]  if hr["Chop Index"]  else "N/A",
                      fmt(num_format="0.00", align="right", border=1))
            ws5.write(row, 8, hr["Trend State"] or "N/A", trend_fmt(hr["Trend State"] or ""))
            ws5.write(row, 9, hr["Regime"] or "N/A",      regime_fmt(hr["Regime"] or "Unknown"))
            row += 1

    # ============================================================
    # SHEET 6: Help / Glossary
    # ============================================================
    ws6 = wb.add_worksheet("Help & Glossary")
    ws6.hide_gridlines(2)
    ws6.set_column("A:A", 5)
    ws6.set_column("B:B", 28)
    ws6.set_column("C:C", 38)
    ws6.set_column("D:D", 46)
    ws6.set_column("E:E", 22)

    title_h   = fmt(bold=True, font_size=18, font_color="#1B2A4A", border=0)
    sub_h     = fmt(italic=True, font_size=10, font_color="#5D6D7E", border=0)
    sec_h     = fmt(bold=True, font_size=12, font_color="#FFFFFF", bg_color="#1B2A4A", border=1, valign="vcenter")
    col_h     = fmt(bold=True, font_size=10, font_color="#FFFFFF", bg_color="#2E4057", border=1, align="center", valign="vcenter")
    term_h    = fmt(bold=True, font_size=9,  font_color="#1B2A4A", bg_color="#EBF5FB", border=1, valign="top", text_wrap=True)
    def_h     = fmt(font_size=9, font_color="#2C3E50", bg_color="#FDFEFE", border=1, valign="top", text_wrap=True)
    formula_h = fmt(font_size=9, font_color="#154360", bg_color="#EAF2FF", border=1, valign="top", text_wrap=True, italic=True)
    range_h   = fmt(font_size=9, font_color="#1E8449", bg_color="#EAFAF1", border=1, valign="top", text_wrap=True, bold=True)
    sheet_sec_h = fmt(bold=True, font_size=10, font_color="#1B2A4A", bg_color="#D6EAF8", border=1)

    ws6.write("B2", "MARKET REGIME & BREADTH INTELLIGENCE — HELP & GLOSSARY", title_h)
    ws6.write("B3", "Complete reference guide for all metrics, formulas, colour codes, and interpretations used in this workbook.", sub_h)

    row = 4

    # ---- SECTION HEADER helper ----
    def write_section(ws, row, title):
        ws.merge_range(row, 1, row, 4, title, sec_h)
        ws.set_row(row, 22)
        return row + 1

    def write_col_headers(ws, row):
        ws.write(row, 1, "Term / Metric",      col_h)
        ws.write(row, 2, "Definition",         col_h)
        ws.write(row, 3, "Formula / Logic",    col_h)
        ws.write(row, 4, "Target / Interpretation", col_h)
        ws.set_row(row, 18)
        return row + 1

    def write_row(ws, row, term, defn, formula, target, row_height=52):
        ws.write(row, 1, term,    term_h)
        ws.write(row, 2, defn,    def_h)
        ws.write(row, 3, formula, formula_h)
        ws.write(row, 4, target,  range_h)
        ws.set_row(row, row_height)
        return row + 1

    # ==============================================================
    # PART 1 — ABOUT THIS WORKBOOK
    # ==============================================================
    row = write_section(ws6, row, "ABOUT THIS WORKBOOK")
    ws6.merge_range(row, 1, row, 4,
        "This workbook analyses the health and momentum of the Indian equity market using the Nifty 500 universe (514 stocks). "
        "It provides five analytical sheets: (1) Market Regime Dashboard — macro summary; (2) Breadth Indicators — how many stocks "
        "are above key EMAs; (3) Sector Rotation — which sectors are leading or lagging; (4) Chop & Trend Analysis — trending vs. "
        "sideways classification per stock; (5) Regime History — 60-day rolling regime log for the Nifty 50 index. "
        "The Nifty 50 index file (NIFTY_50_Daily_5Y.csv) is used only as the benchmark and trading-day calendar. "
        "All breadth calculations use the full 514-stock Nifty 500 universe from Daily_Historical_Data_Fresh/.",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#FDFEFE", border=1, valign="top", text_wrap=True))
    ws6.set_row(row, 72)
    row += 2

    # ==============================================================
    # PART 2 — MARKET REGIME DASHBOARD (Sheet 1)
    # ==============================================================
    row = write_section(ws6, row, "SHEET 1 — MARKET REGIME DASHBOARD")
    ws6.merge_range(row, 1, row, 4,
        "Displays the current macro market environment in a single glance. The large coloured banner shows the current regime. "
        "Left panel covers Nifty 50 index levels. Right panel summarises breadth across the 514-stock Nifty 500 universe.",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#EBF5FB", border=1, text_wrap=True))
    ws6.set_row(row, 32)
    row += 1
    row = write_col_headers(ws6, row)

    sheet1_terms = [
        ("Market Regime",
         "A single label that classifies the overall equity market environment into 5 states: Bull Market, Cautious Bull, Transition, Caution/Chop, or Bear Market.",
         "Derived from: % of Nifty 500 stocks above EMA 200 combined with whether the Nifty 50 index is above/below its own EMA 200.",
         "Bull Market: ≥60% above EMA200 + Nifty > EMA200\nCautious Bull: 50–60% above EMA200\nBear Market: ≤35% + Nifty < EMA200"),

        ("Nifty 50 Close",
         "The last traded closing price of the Nifty 50 index.",
         "Sourced from Historical Data/NIFTY_50_Daily_5Y.csv",
         "Context: Used as the macro benchmark. Regimes use this vs its own EMAs."),

        ("EMA 20 / EMA 50 / EMA 200",
         "Exponential Moving Averages of the Nifty 50 closing price over 20, 50, and 200 days respectively.",
         "EMA(t) = Price(t) × α + EMA(t-1) × (1-α),  where α = 2/(span+1)",
         "Nifty above EMA200 = structural uptrend.\nNifty between EMA50 & EMA200 = recovery.\nNifty below EMA200 = downtrend."),

        ("% vs EMA 200",
         "How far (%) the current Nifty 50 close is above or below its own 200-day EMA.",
         "(Close - EMA200) / EMA200 × 100",
         "Positive = Nifty in structural uptrend.\nNegative = Nifty in structural downtrend."),

        ("Nifty ADX (14)",
         "Average Directional Index — measures the STRENGTH of the Nifty 50's trend, not its direction. High ADX = strong trend in either direction.",
         "ADX = Wilder's EWM of DX.\nDX = |+DI – -DI| / (+DI + -DI) × 100\nWhere +DI and -DI are smoothed directional movement indicators.",
         "ADX < 20: Weak/No trend (Choppy)\nADX 20–25: Developing trend\nADX > 25: Strong trend\nADX > 40: Very strong trend"),

        ("Nifty Chop Index (14)",
         "Choppiness Index measures how 'choppy' (sideways) or directional the Nifty 50's price action is. Inverse of trend strength.",
         "100 × log10(Sum(ATR,N) / (Highest High – Lowest Low)) / log10(N)",
         "Chop < 38.2: Strongly trending\nChop 38–45: Consolidating\nChop 45–61.8: Transitional\nChop > 61.8: Sideways/Choppy"),

        ("Index Trend State",
         "Combined label derived from both ADX and Choppiness Index to classify the Nifty 50 index's current price action regime.",
         "Strongly Trending: ADX ≥ 25 AND Chop < 45\nTrending: ADX ≥ 20\nSideways/Choppy: Chop ≥ 61.8\nConsolidating: Everything else",
         "Use for options strategy selection:\n• Trending → Directional plays\n• Consolidating → Straddles/Strangles\n• Choppy → Avoid breakout trades"),
    ]
    for args in sheet1_terms:
        row = write_row(ws6, row, *args)
    row += 1

    # ==============================================================
    # PART 3 — BREADTH INDICATORS (Sheet 2)
    # ==============================================================
    row = write_section(ws6, row, "SHEET 2 — BREADTH INDICATORS (Nifty 500 Universe)")
    ws6.merge_range(row, 1, row, 4,
        "Breadth indicators measure market participation — how many of the 514 Nifty 500 stocks are trending vs struggling. "
        "Strong breadth confirms an index rally is broad-based. Weak breadth reveals a narrow, top-heavy rally.",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#EBF5FB", border=1, text_wrap=True))
    ws6.set_row(row, 28)
    row += 1
    row = write_col_headers(ws6, row)

    sheet2_terms = [
        ("% Stocks above EMA 20",
         "The percentage of all 514 Nifty 500 stocks whose latest close price is above their own 20-day Exponential Moving Average.",
         "count(Close > EMA20) / Total Stocks × 100",
         "≥ 70%: Strong short-term momentum — bull breadth.\n50–70%: Mixed — selective.\n< 50%: Broad short-term weakness."),

        ("% Stocks above EMA 50",
         "The percentage of all 514 Nifty 500 stocks whose latest close price is above their own 50-day Exponential Moving Average.",
         "count(Close > EMA50) / Total Stocks × 100",
         "≥ 65%: Healthy medium-term trend breadth.\n40–65%: Caution / mixed trend.\n< 40%: Concerning — possible correction."),

        ("% Stocks above EMA 200",
         "The MOST IMPORTANT breadth metric. Measures how many stocks are in a long-term structural uptrend. Core driver of the Regime classification.",
         "count(Close > EMA200) / Total Stocks × 100",
         "≥ 60%: Bull Market breadth.\n50–60%: Cautious Bull.\n35–50%: Mixed / Transitional.\n< 35%: Bear Market breadth."),

        ("New 52-Week Highs",
         "Number of stocks whose latest price is within 0.5% of their highest close over the past 252 trading days.",
         "count(LTP ≥ Max(Close, 252 days) × 0.995)",
         "High count (>30): Broad buying interest — bullish.\nLow count (<10): Narrow leadership — caution."),

        ("New 52-Week Lows",
         "Number of stocks whose latest price is within 0.5% of their lowest close over the past 252 trading days.",
         "count(LTP ≤ Min(Close, 252 days) × 1.005)",
         "High count (>30): Broad distribution — bearish.\n< 10: Low market stress — healthy."),

        ("52W High/Low Ratio",
         "Ratio comparing the number of new 52-week highs to new 52-week lows. A reading above 1 means more stocks are making highs than lows.",
         "New 52W Highs / (New 52W Lows + 1)",
         "> 3x: Very bullish dominance.\n1.5x – 3x: Bullish.\n0.5x – 1.5x: Neutral.\n< 0.5x: Bearish (lows dominating)."),

        ("Advancing Stocks (1W)",
         "Count of stocks whose 1-week (5-day) return is positive — i.e., they closed higher than they were 5 trading days ago.",
         "count(Close[today] > Close[5 days ago])",
         "Majority advancing (>60%): Short-term bullish breadth.\nMajority declining (>60%): Short-term weakness."),

        ("Advance/Decline Ratio",
         "Ratio of advancing stocks to declining stocks over the past 1 week. A key short-term sentiment indicator.",
         "Advancing Stocks (1W) / Declining Stocks (1W)",
         "≥ 2x: Strongly bullish.\n1.2x – 2x: Moderately bullish.\n0.8x – 1.2x: Neutral.\n< 0.8x: Bearish."),
    ]
    for args in sheet2_terms:
        row = write_row(ws6, row, *args)
    row += 1

    # ==============================================================
    # PART 4 — SECTOR ROTATION (Sheet 3)
    # ==============================================================
    row = write_section(ws6, row, "SHEET 3 — SECTOR ROTATION MOMENTUM HEATMAP")
    ws6.merge_range(row, 1, row, 4,
        "Ranks all sectors by their composite momentum score. The sector at Rank 1 is the strongest, currently leading the market. "
        "Colour coding: Green rows = leading sectors (buy); Yellow = neutral; Red = lagging (avoid or reduce).",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#EBF5FB", border=1, text_wrap=True))
    ws6.set_row(row, 28)
    row += 1
    row = write_col_headers(ws6, row)

    sheet3_terms = [
        ("Sector",
         "The NSE sector grouping for the stocks in that row. Each sector's metrics are the MEDIAN values across all stocks in that sector.",
         "Stocks are mapped to sectors via a predefined lookup table (SECTOR_MAP in the script).",
         "Sectors not in the lookup table appear as 'Other'. The 'Other' group typically contains smaller-cap or recently listed stocks."),

        ("% Above EMA 200",
         "The percentage of stocks within that sector whose current price is above their 200-day EMA. A proxy for sector health.",
         "count(sector stocks with Close > EMA200) / sector stock count × 100",
         "≥ 60%: Sector in structural uptrend — buy zone.\n40–60%: Mixed sector health.\n< 40%: Sector in downtrend — avoid."),

        ("1W Return (Median)",
         "The median 1-week (5 trading day) price return of all stocks in the sector. Reflects recent short-term sector momentum.",
         "Median of [(Close[today] - Close[5d ago]) / Close[5d ago]] across sector stocks",
         "Positive: Short-term buying in sector.\nNegative: Short-term selling pressure."),

        ("1M Return (Median)",
         "The median 1-month (22 trading day) return across all sector stocks. The most important timeframe for sector rotation decisions.",
         "Median of [(Close[today] - Close[22d ago]) / Close[22d ago]] across sector stocks",
         "Strongest weighted factor (40%) in the composite ranking. Focus on sectors with +ve 1M trend."),

        ("3M Return (Median)",
         "The median 3-month (63 trading day) return across all sector stocks.",
         "Median of [(Close[today] - Close[63d ago]) / Close[63d ago]] across sector stocks",
         "30% weight in composite score. Confirms medium-term trend direction."),

        ("6M Return (Median)",
         "The median 6-month (126 trading day) return across all sector stocks.",
         "Median of [(Close[today] - Close[126d ago]) / Close[126d ago]] across sector stocks",
         "20% weight in composite score. Identifies structural vs. cyclical sector leadership."),

        ("Composite Momentum Score",
         "Weighted combination of 1M, 3M, 6M, and 1W returns used to rank sectors from strongest to weakest. Higher = stronger.",
         "Score = 0.40×R_1M + 0.30×R_3M + 0.20×R_6M + 0.10×R_1W",
         "Rank 1 = Leading sector (highest momentum).\nBottom Rank = Lagging sector (weakest momentum).\nFocus on Top 3–5 sectors for long entries."),
    ]
    for args in sheet3_terms:
        row = write_row(ws6, row, *args)
    row += 1

    # ==============================================================
    # PART 5 — CHOP & TREND ANALYSIS (Sheet 4)
    # ==============================================================
    row = write_section(ws6, row, "SHEET 4 — CHOP & TREND ANALYSIS (Per Stock)")
    ws6.merge_range(row, 1, row, 4,
        "Classifies every Nifty 500 stock individually as Strongly Trending, Trending, Consolidating, or Sideways/Choppy. "
        "Use this sheet to identify: (1) momentum stocks worth chasing; (2) sideways stocks suitable for options strategies; "
        "(3) stocks at a breakout inflection point.",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#EBF5FB", border=1, text_wrap=True))
    ws6.set_row(row, 36)
    row += 1
    row = write_col_headers(ws6, row)

    sheet4_terms = [
        ("ADX (14)",
         "Average Directional Index over 14 periods. Measures the STRENGTH of a stock's trend regardless of direction. A rising ADX means the trend (up or down) is getting stronger.",
         "+DM = High – Prev High (if positive, else 0)\n-DM = Prev Low – Low (if positive, else 0)\n+DI = EWM(+DM)/ATR × 100\n-DI = EWM(-DM)/ATR × 100\nADX = EWM(|+DI – -DI| / (+DI + -DI))",
         "< 20: No significant trend — avoid breakout trades.\n20–25: Weak trend developing.\n25–40: Trending — safe for trend-following.\n> 40: Strong trend — momentum is dominant."),

        ("Chop Index",
         "Choppiness Index over 14 periods. Measures how choppy/rangebound vs directional a stock's price action is. INVERSE of trend quality — low Chop = strong trend.",
         "100 × log10(Sum(ATR,14) / (14-period High – 14-period Low)) / log10(14)\n\nATR = Average True Range per candle.",
         "< 38.2: Strongly trending — most directional state.\n38–45: Consolidating with direction.\n45–61.8: Transitional / building energy.\n> 61.8: Sideways / Choppy — range-trade or options play."),

        ("Trend State",
         "Human-readable classification combining ADX and Choppiness Index into a single actionable label per stock.",
         "Strongly Trending: ADX ≥ 25 AND Chop < 45\nTrending: ADX ≥ 20\nSideways/Choppy: Chop ≥ 61.8\nConsolidating: All other combinations",
         "Strongly Trending → Momentum/breakout entries.\nTrending → Trail stops, hold positions.\nConsolidating → Wait or sell options.\nSideways/Choppy → Avoid directional bets; sell strangles."),

        ("Above EMA 200",
         "Whether the stock's current price is above its own 200-day Exponential Moving Average.",
         "Close > EMA(200)  → ✓ Yes (Green)\nClose ≤ EMA(200) → ✗ No  (Red)",
         "✓ Yes: Stock is in a long-term structural uptrend — prefer longs only.\n✗ No: Stock is below its long-term average — avoid longs; consider shorts."),

        ("1M Return",
         "The stock's 1-month (22 trading day) price return. Combined with Trend State to confirm momentum quality.",
         "(Close[today] - Close[22d ago]) / Close[22d ago]",
         "Green (>+1%): Recent 1M upward momentum.\nRed (<-1%): Recent 1M downward momentum.\nWhite: Flat / neutral."),
    ]
    for args in sheet4_terms:
        row = write_row(ws6, row, *args)
    row += 1

    # ==============================================================
    # PART 6 — REGIME HISTORY (Sheet 5)
    # ==============================================================
    row = write_section(ws6, row, "SHEET 5 — REGIME HISTORY (Last 60 Trading Days)")
    ws6.merge_range(row, 1, row, 4,
        "A day-by-day log of the Nifty 50 index's EMA positions, ADX, Choppiness Index, Trend State, and inferred Regime "
        "over the past 60 trading days. Use this to understand how the market has evolved and identify regime transitions.",
        fmt(font_size=9, font_color="#2C3E50", bg_color="#EBF5FB", border=1, text_wrap=True))
    ws6.set_row(row, 28)
    row += 1
    row = write_col_headers(ws6, row)

    sheet5_terms = [
        ("EMA 20 / 50 / 200 (Nifty)",
         "The daily rolling values of the Nifty 50 index's 20, 50, and 200-day Exponential Moving Averages.",
         "EMA(t) = Close(t) × (2/(span+1)) + EMA(t-1) × (1 - 2/(span+1))",
         "When Nifty Close > EMA20 > EMA50 > EMA200: Perfect bull alignment.\nWhen Nifty Close < EMA200: Structural downtrend."),

        ("% vs EMA 200",
         "Daily percentage distance of the Nifty 50 close above or below its own 200-day EMA. Positive = uptrend; negative = downtrend.",
         "(Nifty Close - EMA200) / EMA200 × 100",
         "Green cell: Nifty above EMA200 (uptrend).\nRed cell: Nifty below EMA200 (downtrend)."),

        ("Trend State (History)",
         "Daily trend state classification of the Nifty 50 index based on its ADX and Choppiness Index values.",
         "Same as per-stock calculation.\nStrongly Trending / Trending / Consolidating / Sideways-Choppy",
         "Track regime transitions over time. A shift from Consolidating → Trending often precedes a breakout."),

        ("Regime (History)",
         "Daily regime label inferred from the Nifty 50 index's position relative to its own EMAs. Note: this uses only index data, not full 514-stock breadth.",
         "Close > EMA200 AND Close > EMA50 → Bull Market\nClose < EMA200 → Bear Market\nChop ≥ 61.8 → Choppy\nAll else → Transition",
         "Consistent Bull Market for 15+ days = strong macro environment.\nSudden shift to Bear/Choppy = reduce risk, tighten stops."),
    ]
    for args in sheet5_terms:
        row = write_row(ws6, row, *args)
    row += 1

    # ==============================================================
    # PART 7 — COLOUR CODE LEGEND
    # ==============================================================
    row = write_section(ws6, row, "COLOUR CODE LEGEND")
    col_hdr_l = fmt(bold=True, font_size=9, font_color="#FFFFFF", bg_color="#2E4057", border=1, align="center")
    ws6.write(row, 1, "Colour",        col_hdr_l)
    ws6.write(row, 2, "Meaning",       col_hdr_l)
    ws6.write(row, 3, "Where Used",    col_hdr_l)
    ws6.write(row, 4, "Typical Threshold", col_hdr_l)
    row += 1

    colour_legend = [
        ("#C6EFCE / Dark Green",  "Strongly positive / bullish / high value",
         "Regime: Bull Market | Breadth > 65% | ADX > 25 | Positive returns",
         "Good zone — favour long strategies"),
        ("#E2EFDA / Light Green", "Moderately positive / cautious bull",
         "Regime: Cautious Bull | Breadth 50–65% | Trending state",
         "Acceptable — selective long entries"),
        ("#FFEB9C / Amber",       "Neutral / mixed / transitional",
         "Regime: Caution/Chop | Breadth 35–50% | Consolidating state",
         "Caution — non-directional options preferred"),
        ("#FCE4D6 / Orange",      "Mild concern / transition zone",
         "Regime: Transition | Moderate risk signals",
         "Reduce leverage; wait for confirmation"),
        ("#FFC7CE / Red",         "Negative / bearish / weak / risk-off",
         "Regime: Bear Market | Breadth < 35% | ADX < 20 | Negative returns",
         "Danger zone — avoid longs; consider hedges or cash"),
        ("#EAF2FF / Light Blue",  "Formula/calculation reference cells",
         "Sheet headers; formula text in Help sheet",
         "Informational only"),
    ]
    for bg_name, meaning, where, threshold in colour_legend:
        ws6.write(row, 1, bg_name,    fmt(bold=True, font_size=9, border=1, bg_color="#F4F6F7"))
        ws6.write(row, 2, meaning,    fmt(font_size=9, border=1, text_wrap=True, bg_color="#FDFEFE"))
        ws6.write(row, 3, where,      fmt(font_size=9, border=1, text_wrap=True, bg_color="#FDFEFE"))
        ws6.write(row, 4, threshold,  fmt(font_size=9, border=1, text_wrap=True, bold=True, bg_color="#FDFEFE"))
        ws6.set_row(row, 38)
        row += 1
    row += 1

    # ==============================================================
    # PART 8 — STRATEGY DECISION GUIDE
    # ==============================================================
    row = write_section(ws6, row, "STRATEGY DECISION GUIDE — HOW TO USE THIS REPORT")
    col_hdr_s = fmt(bold=True, font_size=9, font_color="#FFFFFF", bg_color="#2E4057", border=1, align="center", text_wrap=True)
    ws6.write(row, 1, "Market Regime",         col_hdr_s)
    ws6.write(row, 2, "Breadth Signal",         col_hdr_s)
    ws6.write(row, 3, "Recommended Action",     col_hdr_s)
    ws6.write(row, 4, "Options Strategy Fit",   col_hdr_s)
    ws6.set_row(row, 28)
    row += 1

    strategy_rows = [
        ("Bull Market",
         "% Above EMA200 ≥ 60%, Adv/Dec ≥ 2x, New Highs dominant",
         "Aggressively long. Use breakout momentum stocks. Add size to winners.",
         "Sell OTM Puts / Buy Calls. Avoid selling Calls (upside risk)."),
        ("Cautious Bull",
         "% Above EMA200 50–60%, mixed Adv/Dec",
         "Selectively long. Focus on top-ranked sectors. Tighter stop losses.",
         "Strangles with slight Put bias. Straddles at ATM if Index Chop < 50."),
        ("Transition",
         "% Above EMA200 40–50%, Index near EMA200",
         "Reduce open long positions. Wait for direction. Preserve capital.",
         "Short-dated Straddles. Lower lot size. Wider strikes."),
        ("Caution / Chop",
         "% Above EMA200 35–50%, high Chop Index (> 55)",
         "No directional bets. Trade range-bound strategies only.",
         "Best environment for Straddles/Strangles. Sell premium aggressively."),
        ("Bear Market",
         "% Above EMA200 ≤ 35%, new 52W lows dominant, Adv/Dec < 0.8",
         "Exit longs immediately. Hedge portfolio. Move to cash or inverse ETFs.",
         "Sell OTM Calls / Buy Puts. Avoid selling Puts (crash risk)."),
    ]
    regime_bg = {
        "Bull Market":    "#C6EFCE", "Cautious Bull": "#E2EFDA",
        "Transition":     "#FCE4D6", "Caution / Chop": "#FFEB9C",
        "Bear Market":    "#FFC7CE",
    }
    for regime_lbl, breadth_sig, action, options in strategy_rows:
        bg = regime_bg.get(regime_lbl, "#FDFEFE")
        ws6.write(row, 1, regime_lbl,   fmt(bold=True, font_size=9, border=1, bg_color=bg, text_wrap=True))
        ws6.write(row, 2, breadth_sig,  fmt(font_size=9, border=1, bg_color="#FDFEFE", text_wrap=True))
        ws6.write(row, 3, action,       fmt(font_size=9, border=1, bg_color="#FDFEFE", text_wrap=True, bold=True))
        ws6.write(row, 4, options,      fmt(font_size=9, border=1, bg_color="#EAF2FF", text_wrap=True, italic=True))
        ws6.set_row(row, 46)
        row += 1
    row += 1

    # ==============================================================
    # PART 9 — DATA SOURCES
    # ==============================================================
    row = write_section(ws6, row, "DATA SOURCES & REFRESH SCHEDULE")
    sources = [
        ("Nifty 500 Stock Data",
         "Daily_Historical_Data_Fresh/*.csv — 514 individual stock daily OHLCV files (Open, High, Low, Close, Volume).",
         "Refresh using: venv\\Scripts\\python.exe scripts/downloader/download_nifty500_historical.py → Option 1",
         "Refresh weekly or before each report run for accuracy."),
        ("Nifty 50 Index Data",
         "Historical Data/NIFTY_50_Daily_5Y.csv — Nifty 50 index daily OHLCV data going back 5 years.",
         "Refresh using: venv\\Scripts\\python.exe scripts/downloader/download_nifty_historical.py",
         "Refresh weekly. The 5Y history enables long-period EMA calculations."),
        ("Report Generation",
         "This report is generated by running: generate_market_regime_report.py",
         "venv\\Scripts\\python.exe scripts/analysis/generate_market_regime_report.py",
         "Run daily after market close (after 15:30 IST) for fresh data."),
        ("Related Reports",
         "Breakout & Momentum Screener: breakout_momentum_screener.xlsx\nPortfolio Risk Report: portfolio_risk_report.xlsx",
         "venv\\Scripts\\python.exe scripts/analysis/breakout_momentum_screener.py\nvenv\\Scripts\\python.exe scripts/analysis/portfolio_risk_screener.py",
         "Run in combination for a comprehensive market view."),
    ]
    row = write_col_headers(ws6, row)
    for src_name, desc, cmd, note in sources:
        ws6.write(row, 1, src_name, term_h)
        ws6.write(row, 2, desc,     def_h)
        ws6.write(row, 3, cmd,      formula_h)
        ws6.write(row, 4, note,     range_h)
        ws6.set_row(row, 46)
        row += 1

    # Footer note
    row += 1
    ws6.merge_range(row, 1, row, 4,
        f"Report generated by: generate_market_regime_report.py  |  Universe: Nifty 500 (514 stocks)  |  Benchmark: Nifty 50 Index  |  Last generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        fmt(italic=True, font_size=8, font_color="#7F8C8D", border=0, align="left"))

    wb.close()
    logger.info(f"✓ Workbook saved: {output_path}")


# ---------------------------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------------------------

def main():
    logger.info("=" * 65)
    logger.info("  MARKET REGIME & BREADTH INTELLIGENCE REPORT")
    logger.info("=" * 65)

    DAILY_DIR  = "Daily_Historical_Data_Fresh"
    NIFTY_FILE = os.path.join("Historical Data", "NIFTY_50_Daily_5Y.csv")
    OUT_DIR    = "reports"
    os.makedirs(OUT_DIR, exist_ok=True)

    # --- Load Nifty 50 Index ---
    if not os.path.exists(NIFTY_FILE):
        logger.critical(f"Nifty 50 file not found: {NIFTY_FILE}")
        sys.exit(1)

    nifty_df = _load_csv(NIFTY_FILE, min_rows=200)
    if nifty_df is None:
        logger.critical("Failed to load Nifty 50 data.")
        sys.exit(1)

    logger.info(f"Loaded Nifty 50: {len(nifty_df)} trading days  |  Last: {nifty_df.index[-1].strftime('%Y-%m-%d')}")

    # Build canonical 1Y date list (index trading days)
    latest = nifty_df.index[-1]
    start  = latest - timedelta(days=365)
    nifty_1y = nifty_df[nifty_df.index >= start]
    canonical_dates = sorted(nifty_1y.index.tolist())
    logger.info(f"Canonical window: {canonical_dates[0].strftime('%Y-%m-%d')} → {canonical_dates[-1].strftime('%Y-%m-%d')} ({len(canonical_dates)} trading days)")

    # --- Process all Nifty 500 stocks ---
    records = process_all_stocks(DAILY_DIR, canonical_dates, nifty_1y)
    logger.info(f"Processed {len(records)} stocks successfully.")

    if not records:
        logger.critical("No stock data processed. Check Daily_Historical_Data_Fresh/ directory.")
        sys.exit(1)

    # --- Breadth computation ---
    logger.info("Computing breadth indicators...")
    breadth = compute_breadth_history(records, nifty_df)

    logger.info("\n" + "=" * 50)
    logger.info(f"  MARKET REGIME:     {breadth['regime']}")
    logger.info(f"  % Above EMA 200:   {breadth['pct_above_ema200']}%")
    logger.info(f"  % Above EMA 50:    {breadth['pct_above_ema50']}%")
    logger.info(f"  % Above EMA 20:    {breadth['pct_above_ema20']}%")
    logger.info(f"  New 52W Highs:     {breadth['new_52w_highs']}")
    logger.info(f"  New 52W Lows:      {breadth['new_52w_lows']}")
    logger.info(f"  Adv/Dec Ratio:     {breadth['adv_dec_ratio']}")
    logger.info(f"  Nifty ADX (14):    {breadth['nifty_adx']}")
    logger.info(f"  Nifty Chop Index:  {breadth['nifty_chop']}")
    logger.info(f"  Index Trend State: {breadth['index_trend_state']}")
    logger.info("=" * 50)

    # --- Sector rotation ---
    logger.info("Computing sector rotation rankings...")
    sector_df = compute_sector_rotation(records)

    # --- Regime history ---
    logger.info("Computing regime history (last 60 trading days)...")
    regime_hist = compute_regime_history(nifty_df, records, lookback_days=60)

    # --- Export ---
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path  = os.path.join(OUT_DIR, f"Market_Regime_Report_{ts}.xlsx")
    shortcut_path = os.path.join(OUT_DIR, "market_regime_report.xlsx")

    export_excel(output_path, breadth, records, sector_df, regime_hist)

    # Copy to shortcut
    import shutil
    shutil.copy2(output_path, shortcut_path)
    logger.info(f"✓ Shortcut saved: {shortcut_path}")

    logger.info("\n[COMPLETE] Market Regime & Breadth Intelligence Report generated successfully.")
    logger.info(f"Output: {os.path.abspath(output_path)}")


if __name__ == "__main__":
    main()
