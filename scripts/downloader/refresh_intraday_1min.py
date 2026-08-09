"""
Incremental 1-minute intraday bar store for the Nifty 50 universe.

Builds and maintains Intraday_Historical_Data/1min/<SYMBOL>.parquet, the data
foundation for the intraday VWAP+RS signal engine (lib/intraday_signals.py),
its backtest (scripts/analysis/backtest_intraday_vwap_rs.py) and the live
strategy (strategies/intraday_equity/nifty50_vwap_rs.py).

Why this exists: Daily_Historical_Data_Fresh/ is daily bars only, and the only
1-minute data in the repo is for the NIFTY index and index futures. There is no
intraday equity history at all, so no intraday equity strategy can be validated
without building this first.

IMPORTANT — this is an APPEND-ONLY ARCHIVE. Dhan serves a limited trailing
window of 1-minute data (~81 sessions measured 2026-08-09). History beyond that
window is unrecoverable once it ages out, so the store only deepens if this
script runs regularly. Schedule it daily after the close (~15:45 IST).

Usage:
    venv\\Scripts\\python.exe scripts/downloader/refresh_intraday_1min.py
    venv\\Scripts\\python.exe scripts/downloader/refresh_intraday_1min.py --symbols RELIANCE,INFY --days 30
    venv\\Scripts\\python.exe scripts/downloader/refresh_intraday_1min.py --full
    venv\\Scripts\\python.exe scripts/downloader/refresh_intraday_1min.py --benchmark-only

Stop gracefully by writing debug/intraday_refresh_stop.trigger.
Progress is written to debug/intraday_refresh_status.json for dashboard polling.
"""
import os
import sys
import json
import time
import argparse
from datetime import datetime, timedelta, date, time as dtime

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# ── Paths ─────────────────────────────────────────────────────────────────────
STORE_ROOT   = os.path.join(ROOT, "Intraday_Historical_Data")
STORE_DIR    = os.path.join(STORE_ROOT, "1min")
MANIFEST     = os.path.join(STORE_ROOT, "manifest.json")
DEBUG_DIR    = os.path.join(ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "intraday_refresh_status.json")
STOP_FILE    = os.path.join(DEBUG_DIR, "intraday_refresh_stop.trigger")
BENCH_SEED   = os.path.join(ROOT, "Historical Data", "NIFTY_50_1Min_3Y.csv")

# ── Session window ────────────────────────────────────────────────────────────
# NSE equity continuous session. Bars are stamped at their OPEN, so the last
# bar of the day opens at 15:29. The probe found 6 out-of-session bars and
# sessions with up to 382 bars (>375), so this filter is load-bearing, not
# defensive decoration.
SESSION_START = dtime(9, 15)
SESSION_END   = dtime(15, 29)

BENCHMARK_KEY = "NIFTY_50"

# Single source of truth for the universe. Must stay byte-identical with
# scripts/tools/live_equity_ws.py and rs_dashboard/lib/nifty50.ts.
NIFTY50_SYMBOLS = [
    'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
    'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BHARTIARTL', 'BPCL',
    'BRITANNIA', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY',
    'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK',
    'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
    'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'KOTAKBANK',
    'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC',
    'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN',
    'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL',
    'TCS', 'TECHM', 'TITAN', 'TMPV', 'ULTRACEMCO', 'WIPRO',
]

_log_lines: list[str] = []


# ── Status / stop plumbing (mirrors refresh_dashboard_data.py) ────────────────
def write_status(phase: str, message: str, current: int = 0, total: int = 0,
                 done: bool = False, error: str | None = None, symbol: str = ""):
    _log_lines.append(message)
    if len(_log_lines) > 200:
        _log_lines.pop(0)

    payload = {
        "pid":        os.getpid(),
        "phase":      phase,
        "message":    message,
        "symbol":     symbol,
        "current":    current,
        "total":      total,
        "done":       done,
        "error":      error,
        "log":        _log_lines[-60:],
        "updated_at": datetime.now().isoformat(),
    }
    os.makedirs(DEBUG_DIR, exist_ok=True)
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, STATUS_FILE)
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, OSError):
        pass


def should_stop() -> bool:
    return os.path.exists(STOP_FILE)


def clear_stop_trigger():
    """Consume a leftover trigger so the next run isn't killed at startup."""
    if os.path.exists(STOP_FILE):
        try:
            os.remove(STOP_FILE)
        except OSError:
            pass


def mark_error(msg: str):
    write_status("error", msg, done=True, error=msg)


# ── Manifest ──────────────────────────────────────────────────────────────────
def load_manifest() -> dict:
    if not os.path.exists(MANIFEST):
        return {}
    try:
        with open(MANIFEST) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_manifest(m: dict):
    os.makedirs(STORE_ROOT, exist_ok=True)
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=2, sort_keys=True)
    os.replace(tmp, MANIFEST)


def store_path(symbol: str) -> str:
    # '&' and '-' are legal in Windows filenames, so M&M / BAJAJ-AUTO map
    # straight through and the filename stays greppable against the universe.
    return os.path.join(STORE_DIR, f"{symbol}.parquet")


# ── Bar hygiene ───────────────────────────────────────────────────────────────
def normalize_bars(df: pd.DataFrame, is_index: bool = False) -> pd.DataFrame:
    """Drop out-of-session rows, duplicate timestamps and unusable bars.

    The raw API response is not clean: the Phase-0 probe on RELIANCE found 6
    bars outside 09:15-15:29 and sessions carrying up to 382 bars against a
    375-bar full session. Left in, those bars corrupt session VWAP (which
    anchors on the first bar of the day) and shift the 5-minute resample grid.

    is_index: the NIFTY index reports Volume=0 for large stretches of history,
    which is legitimate — zero-volume rows are only dropped for equities.
    """
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])

    out = df.copy()
    if not isinstance(out.index, pd.DatetimeIndex):
        out.index = pd.to_datetime(out.index)
    out.index.name = "Datetime"

    # Drop tz info: the whole store is IST-naive, and mixing naive/aware
    # timestamps makes every downstream .loc[] comparison raise.
    if out.index.tz is not None:
        out.index = out.index.tz_localize(None)

    keep = [c for c in ("Open", "High", "Low", "Close", "Volume") if c in out.columns]
    out = out[keep]
    for c in keep:
        out[c] = pd.to_numeric(out[c], errors="coerce")

    t = out.index.time
    out = out[(t >= SESSION_START) & (t <= SESSION_END)]
    out = out[out.index.dayofweek < 5]

    out = out.dropna(subset=[c for c in ("Open", "High", "Low", "Close") if c in out.columns])
    out = out[out["Close"] > 0]
    if not is_index and "Volume" in out.columns:
        out = out[out["Volume"] > 0]

    out = out[~out.index.duplicated(keep="last")]
    return out.sort_index()


def summarize(df: pd.DataFrame) -> dict:
    if len(df) == 0:
        return {"first": None, "last": None, "sessions": 0, "rows": 0}
    return {
        "first":    df.index.min().strftime("%Y-%m-%d"),
        "last":     df.index.max().strftime("%Y-%m-%d"),
        "sessions": int(df.index.normalize().nunique()),
        "rows":     int(len(df)),
    }


# ── Fetch / merge ─────────────────────────────────────────────────────────────
def fetch_symbol(helper, symbol: str, from_date: str, to_date: str,
                 max_retries: int = 3) -> pd.DataFrame | None:
    """Fetch 1-min bars with backoff. Returns None on hard failure, empty frame
    when the API genuinely has nothing (weekend/holiday window)."""
    delay = 2.0
    for attempt in range(1, max_retries + 1):
        if should_stop():
            return None
        try:
            df = helper.get_historical_minute_data_long(symbol, from_date, to_date, "1")
            if df is not None and len(df) > 0:
                return df
            # Empty is not automatically an error: a 2-day incremental window
            # over a weekend legitimately has no bars. Only an API error is one.
            err = getattr(helper, "last_api_error", None)
            if not err:
                return pd.DataFrame()
            write_status("fetch", f"  {symbol}: API error ({err}) — attempt {attempt}/{max_retries}",
                         symbol=symbol)
        except Exception as e:
            write_status("fetch", f"  {symbol}: {type(e).__name__}: {e} — attempt {attempt}/{max_retries}",
                         symbol=symbol)
        if attempt < max_retries:
            time.sleep(delay)
            delay *= 2
    return None


def merge_and_write(symbol: str, new_df: pd.DataFrame, is_index: bool = False) -> dict:
    """Union new bars into the existing parquet, newest wins on collision."""
    os.makedirs(STORE_DIR, exist_ok=True)
    path = store_path(symbol)
    clean = normalize_bars(new_df, is_index=is_index)

    if os.path.exists(path):
        try:
            existing = pd.read_parquet(path)
            if len(clean):
                # keep='last' means the freshly fetched bar wins, which is what
                # the 2-day incremental overlap is for: it heals a session that
                # was captured mid-flight by an earlier run.
                clean = pd.concat([existing, clean])
                clean = clean[~clean.index.duplicated(keep="last")].sort_index()
            else:
                clean = existing
        except Exception as e:
            write_status("merge", f"  {symbol}: could not read existing parquet ({e}) — rewriting",
                         symbol=symbol)

    if len(clean) == 0:
        return {"first": None, "last": None, "sessions": 0, "rows": 0}

    clean.to_parquet(path, compression="snappy")
    info = summarize(clean)
    info["updated_at"] = datetime.now().isoformat()
    return info


# ── Benchmark ─────────────────────────────────────────────────────────────────
def seed_benchmark() -> int:
    """One-time seed of the NIFTY benchmark from the existing 3-year CSV.

    That CSV carries Volume=0 on older rows and out-of-session junk (its last
    row is stamped 18:35), so it goes through normalize_bars like everything
    else. Returns rows seeded, 0 if the store already exists or the CSV is absent.
    """
    path = store_path(BENCHMARK_KEY)
    if os.path.exists(path):
        return 0
    if not os.path.exists(BENCH_SEED):
        write_status("benchmark", f"  seed CSV not found: {BENCH_SEED}")
        return 0
    write_status("benchmark", f"  seeding {BENCHMARK_KEY} from NIFTY_50_1Min_3Y.csv…")
    df = pd.read_csv(BENCH_SEED)
    dt_col = next((c for c in df.columns if c.lower() in ("datetime", "date", "timestamp")), df.columns[0])
    df[dt_col] = pd.to_datetime(df[dt_col], errors="coerce")
    df = df.dropna(subset=[dt_col]).set_index(dt_col)
    df.columns = [c.capitalize() if c.lower() in ("open", "high", "low", "close", "volume") else c
                  for c in df.columns]
    info = merge_and_write(BENCHMARK_KEY, df, is_index=True)
    write_status("benchmark", f"  seeded {info['rows']} rows / {info['sessions']} sessions")
    return info["rows"]


def refresh_benchmark(helper, manifest: dict, days: int, full: bool) -> dict:
    """Top up the NIFTY benchmark from the API (index segment, not equity)."""
    seed_benchmark()
    from_date, to_date = window_for(manifest, BENCHMARK_KEY, days, full)
    write_status("benchmark", f"NIFTY benchmark: {from_date} -> {to_date}", symbol=BENCHMARK_KEY)
    df = fetch_symbol(helper, "NIFTY", from_date, to_date)
    if df is None:
        write_status("benchmark", "  benchmark fetch failed — store left as-is", symbol=BENCHMARK_KEY)
        return manifest.get(BENCHMARK_KEY, {})
    info = merge_and_write(BENCHMARK_KEY, df, is_index=True)
    write_status("benchmark",
                 f"  {BENCHMARK_KEY}: {info['rows']} rows, {info['sessions']} sessions "
                 f"({info['first']} -> {info['last']})", symbol=BENCHMARK_KEY)
    return info


# ── Windows ───────────────────────────────────────────────────────────────────
def window_for(manifest: dict, symbol: str, days: int, full: bool) -> tuple[str, str]:
    """Date window to request. Incremental runs re-fetch the last 2 days so a
    session captured mid-flight by an earlier run gets completed."""
    today = date.today()
    if full or symbol not in manifest or not manifest[symbol].get("last"):
        return (today - timedelta(days=days)).isoformat(), today.isoformat()
    last = datetime.strptime(manifest[symbol]["last"], "%Y-%m-%d").date()
    start = min(last - timedelta(days=2), today)
    return start.isoformat(), today.isoformat()


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Build/refresh the Nifty-50 1-minute intraday bar store.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  refresh_intraday_1min.py                          # incremental, all 50 + benchmark\n"
            "  refresh_intraday_1min.py --full --days 90         # rebuild the full window\n"
            "  refresh_intraday_1min.py --symbols RELIANCE,INFY  # a subset\n"
            "  refresh_intraday_1min.py --benchmark-only         # just NIFTY\n"
        ),
    )
    parser.add_argument("--symbols", default="", help="Comma-separated subset (default: all 50)")
    parser.add_argument("--days", type=int, default=90, help="Lookback for a full pull (default: 90)")
    parser.add_argument("--full", action="store_true", help="Ignore the manifest and re-pull the window")
    parser.add_argument("--pace", type=float, default=1.2, help="Seconds between symbols (default: 1.2)")
    parser.add_argument("--benchmark-only", action="store_true", help="Refresh only the NIFTY benchmark")
    parser.add_argument("--skip-benchmark", action="store_true", help="Skip the benchmark refresh")
    args = parser.parse_args()

    if args.days < 1:
        parser.error("--days must be >= 1")
    if args.pace < 0:
        parser.error("--pace must be >= 0")

    os.makedirs(STORE_DIR, exist_ok=True)
    clear_stop_trigger()

    symbols = ([s.strip().upper() for s in args.symbols.split(",") if s.strip()]
               if args.symbols else list(NIFTY50_SYMBOLS))
    if args.benchmark_only:
        symbols = []

    write_status("init", f"Intraday 1-min refresh starting — {len(symbols)} symbols, "
                         f"{'FULL' if args.full else 'incremental'}")

    dhan = get_dhan_client()
    if not dhan:
        mark_error("Authentication failed — run login.py")
        sys.exit(1)
    helper = DhanHelper(dhan)

    manifest = load_manifest()

    if not args.skip_benchmark:
        info = refresh_benchmark(helper, manifest, args.days, args.full)
        if info:
            manifest[BENCHMARK_KEY] = info
            save_manifest(manifest)

    total = len(symbols)
    ok = failed = 0
    failed_symbols: list[str] = []

    for i, sym in enumerate(symbols, 1):
        if should_stop():
            write_status("stopped", f"Stop trigger detected — halting after {i-1}/{total} symbols",
                         current=i - 1, total=total, done=True)
            clear_stop_trigger()
            save_manifest(manifest)
            return

        from_date, to_date = window_for(manifest, sym, args.days, args.full)
        write_status("fetch", f"[{i}/{total}] {sym}: {from_date} -> {to_date}",
                     current=i, total=total, symbol=sym)

        df = fetch_symbol(helper, sym, from_date, to_date)
        if df is None:
            failed += 1
            failed_symbols.append(sym)
            write_status("fetch", f"  {sym}: FAILED after retries", current=i, total=total, symbol=sym)
        else:
            info = merge_and_write(sym, df)
            if info["rows"]:
                manifest[sym] = info
                ok += 1
                write_status("fetch",
                             f"  {sym}: {info['rows']} rows, {info['sessions']} sessions "
                             f"({info['first']} -> {info['last']})",
                             current=i, total=total, symbol=sym)
            else:
                failed += 1
                failed_symbols.append(sym)
                write_status("fetch", f"  {sym}: no usable bars", current=i, total=total, symbol=sym)
            save_manifest(manifest)

        if args.pace and i < total:
            time.sleep(args.pace)

    save_manifest(manifest)

    sessions = [m.get("sessions", 0) for k, m in manifest.items() if k != BENCHMARK_KEY]
    depth = min(sessions) if sessions else 0
    summary = (f"Done — {ok} ok, {failed} failed. "
               f"Shallowest symbol has {depth} sessions.")
    if failed_symbols:
        summary += f" Failed: {', '.join(failed_symbols)}"
    write_status("done", summary, current=total, total=total, done=True)


if __name__ == "__main__":
    main()
