"""
Fetch live intraday OHLCV snapshot for all dashboard stocks using Dhan quote_data.

Writes debug/today_quotes.json, which dataLoader.ts reads to patch the
missing today-row when daily CSVs haven't been refreshed yet.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/fetch_today_quotes.py
    venv\\Scripts\\python.exe scripts/downloader/fetch_today_quotes.py --symbols RELIANCE INFY TCS
"""
import sys, os, json, time, argparse
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

STOCKS_DIR   = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
N500_LIST    = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")
OUTPUT_FILE  = os.path.join(DEBUG_DIR, "today_quotes.json")
MASTER_LIST  = os.path.join(PROJECT_ROOT, "master_list.csv")

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

        # Filter to NSE equities in EQ series
        eq = df[
            (df["EXCH_ID"] == "NSE") &
            (df["INSTRUMENT"] == "EQUITY") &
            (df["SERIES"] == "EQ")
        ][["SYMBOL_NAME", "SECURITY_ID"]].copy()

        eq["SYMBOL_NAME"] = eq["SYMBOL_NAME"].astype(str).str.strip()
        eq["SECURITY_ID"] = pd.to_numeric(eq["SECURITY_ID"], errors="coerce")
        eq = eq.dropna(subset=["SECURITY_ID"])

        mapping = dict(zip(eq["SYMBOL_NAME"], eq["SECURITY_ID"].astype(int)))

        # Build lookup for requested symbols
        result = {}
        for sym in symbols:
            sid = mapping.get(sym)
            if sid:
                result[sym] = sid
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

    # Fetch in batches
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
        print(f"    → {len(quotes)} quotes received")
        if batch_num < total_batches:
            time.sleep(RATE_DELAY)

    print(f"\n  Total quotes fetched: {len(all_quotes)}")

    # Also fetch Nifty 50 index quote so dataLoader.ts can use a real close
    # for the benchmark instead of carrying forward yesterday's value.
    # Nifty 50 index: security_id=13, segment=IDX_I.
    print("  Fetching Nifty 50 index quote...")
    try:
        res = helper.dhan.quote_data(securities={"IDX_I": [13]})
        raw = res.get("data", {}) if isinstance(res, dict) else {}
        if isinstance(raw, dict) and "data" in raw:
            raw = raw["data"]
        idx_data = raw.get("IDX_I", raw) if isinstance(raw, dict) else {}
        ticker = idx_data.get("13", idx_data.get(13)) if isinstance(idx_data, dict) else None
        if ticker and isinstance(ticker, dict):
            ltp = float(ticker.get("last_price", 0) or ticker.get("LTP", 0))
            ohlc = ticker.get("ohlc", {}) or {}
            o = float(ticker.get("open", 0) or ohlc.get("open", 0) or 0)
            h = float(ticker.get("high", 0) or ohlc.get("high", 0) or 0)
            l = float(ticker.get("low", 0) or ohlc.get("low", 0) or 0)
            v = int(ticker.get("volume", 0) or 0)
            if ltp > 0:
                all_quotes["_NIFTY50_INDEX"] = {"open": o, "high": h, "low": l, "close": ltp, "volume": v}
                print(f"    → Nifty 50 LTP: {ltp}")
            else:
                print("    → No valid LTP received for Nifty 50 index")
        else:
            print(f"    → Unexpected response shape for IDX_I: {type(idx_data)}")
    except Exception as e:
        print(f"    → Nifty 50 index fetch failed: {e}")

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
