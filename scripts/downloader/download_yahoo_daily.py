"""
Yahoo Finance Daily EOD Data Downloader & Backup Engine.

Downloads daily OHLCV historical data for Nifty 500 stocks and indices from Yahoo Finance.
Can operate standalone, save to a dedicated backup directory, or patch directly into
Daily_Historical_Data_Fresh when Dhan API is unavailable or missing data.

Usage:
    # Download 1-year historical data for all Nifty 500 stocks
    venv/bin/python scripts/downloader/download_yahoo_daily.py --target stocks --period 1y

    # Download Nifty 50 and Nifty 500 indices
    venv/bin/python scripts/downloader/download_yahoo_daily.py --target nifty50
    venv/bin/python scripts/downloader/download_yahoo_daily.py --target nifty500-index

    # Download everything
    venv/bin/python scripts/downloader/download_yahoo_daily.py --target all --period 1y

    # Sync / patch directly into Daily_Historical_Data_Fresh as Dhan backup
    venv/bin/python scripts/downloader/download_yahoo_daily.py --target stocks --sync-to-fresh
"""

import os
import sys
import time
import json
import argparse
import warnings
from datetime import datetime, timedelta
import pandas as pd
import yfinance as yf

warnings.filterwarnings("ignore")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

HIST_DIR     = os.path.join(PROJECT_ROOT, "Historical Data")
YAHOO_DIR    = os.path.join(HIST_DIR, "Yahoo_Daily_1Y")
STOCKS_DIR   = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "yahoo_refresh_status.json")
STOP_FILE    = os.path.join(DEBUG_DIR, "yahoo_refresh_stop.trigger")
GLOBAL_STOP  = os.path.join(DEBUG_DIR, "refresh_stop.trigger")
N500_LIST    = os.path.join(PROJECT_ROOT, "ind_nifty500list.csv")
NIFTY50_CSV  = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
N500IDX_CSV  = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")

os.makedirs(DEBUG_DIR, exist_ok=True)
os.makedirs(HIST_DIR, exist_ok=True)
os.makedirs(YAHOO_DIR, exist_ok=True)
os.makedirs(STOCKS_DIR, exist_ok=True)

# ── Status Writer ─────────────────────────────────────────────────────────────
_log_lines: list[str] = []

def write_status(phase: str, message: str, current: int = 0, total: int = 0,
                 done: bool = False, error: str = None):
    _log_lines.append(message)
    if len(_log_lines) > 200:
        _log_lines.pop(0)

    payload = {
        "pid": os.getpid(),
        "phase": phase,
        "message": message,
        "current": current,
        "total": total,
        "done": done,
        "error": error,
        "log": _log_lines[-60:],
        "updated_at": datetime.now().isoformat(),
    }
    try:
        with open(STATUS_FILE, "w") as f:
            json.dump(payload, f, indent=2)
    except Exception:
        pass

    try:
        print(message, flush=True)
    except (UnicodeEncodeError, OSError):
        pass


def should_stop() -> bool:
    return os.path.exists(STOP_FILE) or os.path.exists(GLOBAL_STOP)


# ── Symbol Parsing ────────────────────────────────────────────────────────────
def get_nifty500_symbols() -> list[str]:
    """Return all 500 stock symbols from CSV list or existing data directory."""
    if os.path.exists(N500_LIST):
        try:
            df = pd.read_csv(N500_LIST)
            col = next((c for c in df.columns if str(c).strip().upper() == "SYMBOL"), None)
            if col:
                symbols = df[col].astype(str).str.strip().tolist()
                valid = [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note") and s != "nan"]
                if len(valid) >= 400:
                    return sorted(valid)
        except Exception:
            pass

    # Fall back to existing stock CSVs
    files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
    return sorted([f.replace("_Daily_2Y.csv", "") for f in files])


def to_yahoo_ticker(symbol: str) -> str:
    """Map NSE stock symbol to Yahoo Finance ticker."""
    return f"{symbol.strip()}.NS"


# ── OHLCV Extraction ──────────────────────────────────────────────────────────
def extract_ohlcv_from_yf(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """
    Extract a single clean OHLCV DataFrame from yfinance download output.
    Supports both MultiIndex (batch) and single-index structures.
    """
    if df is None or df.empty:
        return pd.DataFrame()

    sub = None
    if isinstance(df.columns, pd.MultiIndex):
        # Case A: Ticker in level 0
        if ticker in df.columns.levels[0]:
            try:
                sub = df[ticker].copy()
            except Exception:
                pass
        # Case B: Ticker in level 1
        if sub is None and len(df.columns.levels) > 1 and ticker in df.columns.levels[1]:
            try:
                sub = df.xs(ticker, level=1, axis=1).copy()
            except Exception:
                pass
    else:
        sub = df.copy()

    if sub is None or sub.empty:
        return pd.DataFrame()

    sub = sub.dropna(how="all")
    if sub.empty:
        return pd.DataFrame()

    col_map = {str(c).lower(): c for c in sub.columns}
    needed = ["open", "high", "low", "close", "volume"]
    if not all(k in col_map for k in needed):
        return pd.DataFrame()

    dates = [pd.to_datetime(d).strftime("%Y-%m-%d") for d in sub.index]

    out = pd.DataFrame({
        "Datetime": dates,
        "Open": sub[col_map["open"]].astype(float).round(2),
        "High": sub[col_map["high"]].astype(float).round(2),
        "Low": sub[col_map["low"]].astype(float).round(2),
        "Close": sub[col_map["close"]].astype(float).round(2),
        "Volume": sub[col_map["volume"]].fillna(0).astype(float),
    })

    # Drop non-trading weekend days
    out["dt_obj"] = pd.to_datetime(out["Datetime"])
    out = out[out["dt_obj"].dt.dayofweek < 5].drop(columns=["dt_obj"])
    out = out.drop_duplicates(subset=["Datetime"], keep="last").sort_values("Datetime")
    out = out[out["Close"] > 0]
    return out.reset_index(drop=True)


# ── Stock Batch Downloader ────────────────────────────────────────────────────
def download_yahoo_stocks(symbols: list[str], period: str = "1y", batch_size: int = 50,
                          out_dir: str = YAHOO_DIR, sync_to_fresh: bool = False):
    total = len(symbols)
    write_status("yahoo_stocks", f"▶ Downloading {total} Nifty 500 stocks from Yahoo Finance ({period})...",
                 current=0, total=total)

    success = 0
    failed_symbols = []

    for idx in range(0, total, batch_size):
        if should_stop():
            write_status("yahoo_stocks", f"⏹ Stopped by user at [{idx}/{total}]",
                         current=idx, total=total, done=True)
            return success, failed_symbols

        chunk = symbols[idx : idx + batch_size]
        chunk_tickers = [to_yahoo_ticker(s) for s in chunk]

        write_status(
            "yahoo_stocks",
            f"  Batch [{idx+1}-{min(idx+batch_size, total)}/{total}]: fetching {len(chunk)} tickers...",
            current=idx,
            total=total,
        )

        try:
            batch_df = yf.download(
                chunk_tickers,
                period=period,
                auto_adjust=False,
                group_by="ticker",
                threads=True,
                progress=False,
            )
        except Exception as e:
            write_status("yahoo_stocks", f"  ⚠ Batch fetch warning: {e}. Retrying individually...", current=idx, total=total)
            batch_df = pd.DataFrame()

        for sym in chunk:
            ticker = to_yahoo_ticker(sym)
            df_sym = extract_ohlcv_from_yf(batch_df, ticker)

            # Retry individually if batch extraction returned empty
            if df_sym.empty:
                try:
                    single_df = yf.download(ticker, period=period, auto_adjust=False, progress=False)
                    df_sym = extract_ohlcv_from_yf(single_df, ticker)
                except Exception:
                    df_sym = pd.DataFrame()

            if not df_sym.empty:
                # Save to Yahoo directory
                target_csv = os.path.join(out_dir, f"{sym}_Daily_2Y.csv")
                df_sym.to_csv(target_csv, index=False)

                # If requested, sync / patch directly into Daily_Historical_Data_Fresh
                if sync_to_fresh:
                    fresh_csv = os.path.join(STOCKS_DIR, f"{sym}_Daily_2Y.csv")
                    if os.path.exists(fresh_csv):
                        try:
                            # Load existing without crashing on extra fields
                            with open(fresh_csv, "r") as f:
                                lines = [ln.strip() for ln in f if ln.strip()]
                            if lines:
                                header = lines[0].split(",")[:6]
                                rows = [ln.split(",")[:6] for ln in lines[1:] if len(ln.split(",")) >= 5]
                                old_df = pd.DataFrame(rows, columns=header[:len(rows[0])]) if rows else pd.DataFrame()
                                if not old_df.empty:
                                    old_df["Datetime"] = old_df["Datetime"].astype(str)
                                    combined = pd.concat([old_df, df_sym]).drop_duplicates(subset=["Datetime"], keep="last")
                                    combined = combined.sort_values("Datetime")
                                    combined.to_csv(fresh_csv, index=False)
                                else:
                                    df_sym.to_csv(fresh_csv, index=False)
                        except Exception:
                            df_sym.to_csv(fresh_csv, index=False)
                    else:
                        df_sym.to_csv(fresh_csv, index=False)

                success += 1
            else:
                failed_symbols.append(sym)

        time.sleep(0.4)

    msg = f"✓ Yahoo Finance stocks download complete: {success}/{total} succeeded"
    if failed_symbols:
        msg += f" ({len(failed_symbols)} failed: {', '.join(failed_symbols[:10])})"
    write_status("yahoo_stocks", msg, current=total, total=total, done=True)
    return success, failed_symbols


# ── Index Downloader ──────────────────────────────────────────────────────────
def download_yahoo_index(target: str, period: str = "1y", out_csv: str = None):
    """Download index OHLCV from Yahoo Finance."""
    name_map = {
        "nifty50": ("^NSEI", NIFTY50_CSV, "Nifty 50"),
        "nifty500-index": ("^CRSLDX", N500IDX_CSV, "Nifty 500"),
    }
    if target not in name_map:
        return False

    ticker, default_csv, label = name_map[target]
    csv_path = out_csv or default_csv
    write_status(target, f"▶ Downloading {label} index from Yahoo Finance ({ticker})...")

    try:
        raw_df = yf.download(ticker, period=period, auto_adjust=False, progress=False)
        df = extract_ohlcv_from_yf(raw_df, ticker)
        if df.empty:
            write_status(target, f"  ✗ Could not extract OHLCV for {label}", done=True, error="Empty DF")
            return False

        # Save to dedicated Yahoo backup copy as well
        backup_csv = os.path.join(YAHOO_DIR, f"{target.upper().replace('-', '_')}.csv")
        df.to_csv(backup_csv, index=False)

        # Merge with existing index CSV if present
        if os.path.exists(csv_path):
            try:
                old = pd.read_csv(csv_path)
                dcol = "Datetime" if "Datetime" in old.columns else old.columns[0]
                old = old.rename(columns={dcol: "Datetime"})
                combined = pd.concat([old, df]).drop_duplicates(subset=["Datetime"], keep="last").sort_values("Datetime")
                combined.to_csv(csv_path, index=False)
            except Exception:
                df.to_csv(csv_path, index=False)
        else:
            df.to_csv(csv_path, index=False)

        write_status(target, f"  ✓ {label} updated from Yahoo Finance: {len(df)} bars (saved to {os.path.basename(csv_path)})", done=True)
        return True
    except Exception as e:
        write_status(target, f"  ✗ Error downloading {label}: {e}", done=True, error=str(e))
        return False


# ── Main Entrypoint ───────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Yahoo Finance EOD Data Downloader & Backup Engine")
    parser.add_argument("--target", choices=["stocks", "nifty50", "nifty500-index", "all"], default="stocks",
                        help="Target dataset to download")
    parser.add_argument("--period", default="1y", help="Historical period: 1mo, 3mo, 6mo, 1y, 2y, max")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch download chunk size (default: 50)")
    parser.add_argument("--output-dir", default=YAHOO_DIR, help="Directory to save downloaded CSVs")
    parser.add_argument("--sync-to-fresh", action="store_true",
                        help="Sync downloaded data into Daily_Historical_Data_Fresh as a backup source")
    args = parser.parse_args()

    # Clear previous stop triggers
    if os.path.exists(STOP_FILE):
        os.remove(STOP_FILE)

    write_status("init", f"🚀 Starting Yahoo Finance download engine (target={args.target}, period={args.period})...")

    if args.target in ("nifty50", "all"):
        download_yahoo_index("nifty50", period=args.period)

    if args.target in ("nifty500-index", "all"):
        download_yahoo_index("nifty500-index", period=args.period)

    if args.target in ("stocks", "all"):
        symbols = get_nifty500_symbols()
        download_yahoo_stocks(
            symbols,
            period=args.period,
            batch_size=args.batch_size,
            out_dir=args.output_dir,
            sync_to_fresh=args.sync_to_fresh,
        )

    write_status("done", "✅ All Yahoo Finance downloads completed successfully!", done=True)


if __name__ == "__main__":
    main()
