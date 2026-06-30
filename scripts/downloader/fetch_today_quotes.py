"""
Fetch live intraday OHLCV snapshot for all dashboard stocks using Dhan quote_data,
then append/update today's row directly in each stock CSV and both index CSVs.

Also writes debug/today_quotes.json for the in-memory patch in dataLoader.ts.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/fetch_today_quotes.py
    venv\\Scripts\\python.exe scripts/downloader/fetch_today_quotes.py --symbols RELIANCE INFY TCS
"""
import sys, os, json, time, argparse
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

STOCKS_DIR     = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
HIST_DIR       = os.path.join(PROJECT_ROOT, "Historical Data")
DEBUG_DIR      = os.path.join(PROJECT_ROOT, "debug")
N500_LIST      = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")
OUTPUT_FILE    = os.path.join(DEBUG_DIR, "today_quotes.json")
MASTER_LIST    = os.path.join(PROJECT_ROOT, "master_list.csv")
NIFTY50_CSV    = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
NIFTY500_CSV   = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")

BATCH_SIZE   = 100   # Dhan API limit per quote_data call
RATE_DELAY   = 0.35  # seconds between batches

os.makedirs(DEBUG_DIR, exist_ok=True)


def load_symbols(cli_symbols: list[str] | None) -> list[str]:
    if cli_symbols:
        return [s.upper().strip() for s in cli_symbols if s.strip()]

    # From Nifty 500 watchlist CSV
    if os.path.exists(N500_LIST):
        try:
            import pandas as pd
            df = pd.read_csv(N500_LIST)
            syms = df.iloc[:, 0].astype(str).str.strip().tolist()
            syms = [s for s in syms if s and s != "NIFTY 500" and not s.startswith("Note") and s != "nan"]
            if syms:
                return syms
        except Exception:
            pass

    # Fall back to all available stock CSVs
    try:
        files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
        return sorted(f.replace("_Daily_2Y.csv", "") for f in files)
    except Exception:
        return []


def build_security_id_map(symbols: list[str]) -> dict[str, int]:
    """
    Read master_list.csv and return {SYMBOL: SECURITY_ID} for NSE EQUITY symbols.
    """
    print(f"  Loading master list...")
    try:
        import pandas as pd
        df = pd.read_csv(MASTER_LIST, low_memory=False)
        df.columns = [c.strip() for c in df.columns]

        # Filter to NSE equities in EQ series; use UNDERLYING_SYMBOL as the ticker key
        eq = df[
            (df["EXCH_ID"] == "NSE") &
            (df["INSTRUMENT"] == "EQUITY") &
            (df["SERIES"] == "EQ")
        ][["UNDERLYING_SYMBOL", "SECURITY_ID"]].copy()

        eq["UNDERLYING_SYMBOL"] = eq["UNDERLYING_SYMBOL"].astype(str).str.strip()
        eq["SECURITY_ID"] = pd.to_numeric(eq["SECURITY_ID"], errors="coerce")
        eq = eq.dropna(subset=["SECURITY_ID"])

        mapping = dict(zip(eq["UNDERLYING_SYMBOL"], eq["SECURITY_ID"].astype(int)))

        # Build lookup for requested symbols
        result = {}
        for sym in symbols:
            sid = mapping.get(sym)
            if sid:
                result[sym] = int(sid)
            else:
                print(f"  [SKIP] {sym}: not found in master list")
        return result
    except Exception as e:
        print(f"  [ERROR] Could not load master list: {e}")
        return {}


def fetch_batch(helper, symbol_to_sid: dict[str, int]) -> dict[str, dict]:
    """
    Fetch quote_data for one batch of ≤100 NSE_EQ securities.
    Returns {symbol: {open, high, low, close, volume}} where close = LTP.
    """
    sid_to_symbol = {v: k for k, v in symbol_to_sid.items()}
    sids = list(symbol_to_sid.values())

    try:
        res = helper.dhan.quote_data(securities={"NSE_EQ": sids})
    except Exception as e:
        print(f"  [ERROR] quote_data call failed: {e}")
        return {}

    if not isinstance(res, dict) or res.get("status") != "success":
        print(f"  [ERROR] quote_data non-success: {res}")
        return {}

    # Navigate nested data — response may be data.data or just data
    raw = res.get("data", {})
    if isinstance(raw, dict) and "data" in raw:
        raw = raw["data"]

    segment_data = raw.get("NSE_EQ", raw) if isinstance(raw, dict) else {}
    if not isinstance(segment_data, dict):
        print(f"  [WARN] Unexpected segment_data shape: {type(segment_data)}")
        return {}

    quotes = {}
    for sid_str, ticker in segment_data.items():
        if not isinstance(ticker, dict):
            continue
        try:
            sid = int(sid_str)
        except ValueError:
            continue
        sym = sid_to_symbol.get(sid)
        if not sym:
            continue

        ltp = float(ticker.get("last_price", 0) or ticker.get("LTP", 0))
        ohlc = ticker.get("ohlc", {}) or {}
        o = float(ticker.get("open", 0) or ohlc.get("open", 0) or 0)
        h = float(ticker.get("high", 0) or ohlc.get("high", 0) or 0)
        l = float(ticker.get("low",  0) or ohlc.get("low",  0) or 0)
        v = int(ticker.get("volume", 0) or 0)

        if ltp > 0:
            quotes[sym] = {"open": o, "high": h, "low": l, "close": ltp, "volume": v}

    return quotes


# ── CSV upsert ────────────────────────────────────────────────────────────────

def upsert_today_row(csv_path: str, today: str, ohlcv: dict, has_timestamp_col: bool = False) -> str:
    """
    Append today's OHLCV row to csv_path, or replace it if already present as
    the last row (handles repeated intraday runs updating live prices).

    Returns one of: 'appended', 'updated', 'skipped', 'error:<msg>'.
    """
    if not os.path.exists(csv_path):
        return "skipped"

    o = ohlcv["open"]
    h = ohlcv["high"]
    l = ohlcv["low"]
    c = ohlcv["close"]
    v = ohlcv["volume"]
    ts = int(time.time())

    today_line = (
        f"{today},{o},{h},{l},{c},{v},{ts}\n" if has_timestamp_col
        else f"{today},{o},{h},{l},{c},{v}\n"
    )

    try:
        # Peek at the last data line without reading the whole file
        with open(csv_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size < 2:
                return "skipped"
            f.seek(max(0, size - 512))
            tail_bytes = f.read()

        tail = tail_bytes.decode("utf-8", errors="replace")
        data_lines = [ln for ln in tail.splitlines() if ln.strip()]
        if not data_lines:
            return "skipped"

        last_date = data_lines[-1].split(",")[0].strip()[:10]

        if last_date == today:
            # Replace the last line in-place
            with open(csv_path, "r", encoding="utf-8") as f:
                all_lines = f.readlines()
            for i in range(len(all_lines) - 1, -1, -1):
                if all_lines[i].strip():
                    all_lines[i] = today_line
                    break
            with open(csv_path, "w", encoding="utf-8", newline="") as f:
                f.writelines(all_lines)
            return "updated"

        elif last_date < today:
            with open(csv_path, "a", encoding="utf-8", newline="") as f:
                if tail and not tail.endswith("\n"):
                    f.write("\n")
                f.write(today_line)
            return "appended"

        else:
            return "skipped"  # CSV already has newer data

    except Exception as e:
        return f"error: {e}"


def update_stock_csvs(all_quotes: dict[str, dict], today: str) -> tuple[int, int, int]:
    """Write today's row into each stock's CSV. Returns (appended, updated, errors)."""
    appended = updated = errors = 0
    for sym, ohlcv in all_quotes.items():
        if sym.startswith("_"):
            continue  # skip pseudo-symbols like _NIFTY50_INDEX
        csv_path = os.path.join(STOCKS_DIR, f"{sym}_Daily_2Y.csv")
        result = upsert_today_row(csv_path, today, ohlcv, has_timestamp_col=True)
        if result == "appended":
            appended += 1
        elif result == "updated":
            updated += 1
        elif result.startswith("error"):
            errors += 1
            print(f"  [WARN] {sym}: {result}")
    return appended, updated, errors


def update_index_csv(csv_path: str, name: str, ohlcv: dict, today: str):
    """Write today's row into an index CSV (no Timestamp column)."""
    result = upsert_today_row(csv_path, today, ohlcv, has_timestamp_col=False)
    if result in ("appended", "updated"):
        print(f"  OK {name} index CSV {result}: {ohlcv['close']:.2f}")
    elif result.startswith("error"):
        print(f"  [WARN] {name} index CSV: {result}")
    else:
        print(f"  {name} index CSV: {result}")


def main():
    parser = argparse.ArgumentParser(description="Fetch live OHLCV quotes for all dashboard stocks")
    parser.add_argument("--symbols", nargs="*", help="Specific symbols to fetch (default: all)")
    args = parser.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    print(f"=== fetch_today_quotes.py  {today} ===")

    symbols = load_symbols(args.symbols)
    if not symbols:
        print("[ERROR] No symbols found — check STOCKS_DIR or N500_LIST.")
        return

    print(f"  {len(symbols)} symbols to fetch")

    sid_map = build_security_id_map(symbols)
    if not sid_map:
        print("[ERROR] No security IDs resolved — aborting.")
        return

    print(f"  {len(sid_map)}/{len(symbols)} symbols resolved to security IDs")

    # Authenticate
    try:
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper
        dhan = get_dhan_client()
        if not dhan:
            print("[ERROR] Dhan auth failed — run login.py first.")
            return
        helper = DhanHelper(dhan)
        print("  Dhan client ready")
    except Exception as e:
        print(f"[ERROR] Auth error: {e}")
        return

    # Fetch stock quotes in batches
    all_syms = list(sid_map.keys())
    all_quotes: dict[str, dict] = {}
    total_batches = (len(all_syms) + BATCH_SIZE - 1) // BATCH_SIZE

    for i in range(0, len(all_syms), BATCH_SIZE):
        batch_syms = all_syms[i : i + BATCH_SIZE]
        batch_map = {s: sid_map[s] for s in batch_syms}
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{total_batches}: {len(batch_syms)} securities...")
        quotes = fetch_batch(helper, batch_map)
        all_quotes.update(quotes)
        print(f"    -> {len(quotes)} quotes received")
        if batch_num < total_batches:
            time.sleep(RATE_DELAY)

    print(f"\n  Total quotes fetched: {len(all_quotes)}")

    # Fetch Nifty 50 index quote (security_id=13, segment=IDX_I)
    print("  Fetching index quotes (Nifty 50 + Nifty 500)...")
    nifty50_ohlcv = None
    nifty500_ohlcv = None
    try:
        res = helper.dhan.quote_data(securities={"IDX_I": [13, 19]})
        raw = res.get("data", {}) if isinstance(res, dict) else {}
        if isinstance(raw, dict) and "data" in raw:
            raw = raw["data"]
        idx_data = raw.get("IDX_I", raw) if isinstance(raw, dict) else {}

        def _parse_idx(ticker) -> dict | None:
            if not isinstance(ticker, dict):
                return None
            ltp = float(ticker.get("last_price", 0) or ticker.get("LTP", 0))
            if ltp <= 0:
                return None
            ohlc = ticker.get("ohlc", {}) or {}
            return {
                "open":   float(ticker.get("open", 0) or ohlc.get("open", 0) or ltp),
                "high":   float(ticker.get("high", 0) or ohlc.get("high", 0) or ltp),
                "low":    float(ticker.get("low",  0) or ohlc.get("low",  0) or ltp),
                "close":  ltp,
                "volume": int(ticker.get("volume", 0) or 0),
            }

        for key in ("13", 13):
            t = idx_data.get(key) if isinstance(idx_data, dict) else None
            if t:
                nifty50_ohlcv = _parse_idx(t)
                break

        for key in ("19", 19):
            t = idx_data.get(key) if isinstance(idx_data, dict) else None
            if t:
                nifty500_ohlcv = _parse_idx(t)
                break

        if nifty50_ohlcv:
            all_quotes["_NIFTY50_INDEX"] = nifty50_ohlcv
            print(f"    -> Nifty 50  LTP: {nifty50_ohlcv['close']}")
        else:
            print("    -> No valid LTP for Nifty 50 index")

        if nifty500_ohlcv:
            all_quotes["_NIFTY500_INDEX"] = nifty500_ohlcv
            print(f"    -> Nifty 500 LTP: {nifty500_ohlcv['close']}")
        else:
            print("    -> No valid LTP for Nifty 500 index")

    except Exception as e:
        print(f"    -> Index fetch failed: {e}")

    # ── Write today's row into each stock CSV ────────────────────────────────
    print(f"\n  Updating stock CSVs...")
    appended, updated, errors = update_stock_csvs(all_quotes, today)
    print(f"  OK Stocks: {appended} appended, {updated} updated, {errors} errors")

    # ── Write today's row into index CSVs ────────────────────────────────────
    if nifty50_ohlcv:
        update_index_csv(NIFTY50_CSV, "Nifty 50", nifty50_ohlcv, today)
    if nifty500_ohlcv:
        update_index_csv(NIFTY500_CSV, "Nifty 500", nifty500_ohlcv, today)

    # ── Write today_quotes.json (used by dataLoader.ts in-memory patch) ──────
    output = {
        "date": today,
        "updated_at": datetime.now().isoformat(),
        "count": len(all_quotes),
        "quotes": all_quotes,
    }
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f)

    print(f"  Written to {OUTPUT_FILE}")
    print("=== Done ===")


if __name__ == "__main__":
    main()
