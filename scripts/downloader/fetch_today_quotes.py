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
RATE_DELAY   = 2.0   # seconds between batches — 0.35s was too short, causing alternating batch failures due to rate limiting

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


def _parse_segment_response(res: dict, segment: str, sid_to_symbol: dict[int, str]) -> dict[str, dict]:
    """Parse an ohlc_data/quote_data response and return {symbol: ohlcv}."""
    if not isinstance(res, dict) or res.get("status") != "success":
        return {}

    raw = res.get("data", {})
    if isinstance(raw, dict) and "data" in raw:
        raw = raw["data"]

    segment_data = raw.get(segment, raw) if isinstance(raw, dict) else {}
    if not isinstance(segment_data, dict):
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


def fetch_batch(helper, symbol_to_sid: dict[str, int]) -> dict[str, dict]:
    """
    Fetch ohlc_data for one batch of ≤100 NSE_EQ securities.
    Returns {symbol: {open, high, low, close, volume}} where close = LTP.
    Falls back to quote_data if ohlc_data fails.
    """
    sid_to_symbol = {v: k for k, v in symbol_to_sid.items()}
    sids = list(symbol_to_sid.values())

    # Try ohlc_data first (lighter endpoint, higher reliability)
    try:
        res = helper.dhan.ohlc_data(securities={"NSE_EQ": sids})
        if isinstance(res, dict) and res.get("status") == "success":
            result = _parse_segment_response(res, "NSE_EQ", sid_to_symbol)
            if result:
                return result
        else:
            print(f"  [WARN] ohlc_data non-success: {res} — trying quote_data fallback")
    except Exception as e:
        print(f"  [WARN] ohlc_data call failed: {e} — trying quote_data fallback")

    # Fallback: quote_data
    try:
        res = helper.dhan.quote_data(securities={"NSE_EQ": sids})
        if isinstance(res, dict) and res.get("status") == "success":
            return _parse_segment_response(res, "NSE_EQ", sid_to_symbol)
        else:
            print(f"  [ERROR] quote_data non-success: {res}")
    except Exception as e:
        print(f"  [ERROR] quote_data call failed: {e}")

    # Last resort: split batch in half and retry each sub-batch
    if len(sids) > 1:
        print(f"  [RETRY] Splitting batch of {len(sids)} into halves...")
        mid = len(sids) // 2
        half1 = {sym: sid for sym, sid in symbol_to_sid.items() if sid in sids[:mid]}
        half2 = {sym: sid for sym, sid in symbol_to_sid.items() if sid in sids[mid:]}
        result = {}
        for half in (half1, half2):
            if not half:
                continue
            try:
                r = helper.dhan.ohlc_data(securities={"NSE_EQ": list(half.values())})
                if isinstance(r, dict) and r.get("status") == "success":
                    result.update(_parse_segment_response(r, "NSE_EQ", {v: k for k, v in half.items()}))
            except Exception:
                pass
            time.sleep(RATE_DELAY)
        return result

    return {}


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

    # Map index key in today_quotes.json to security ID in Dhan
    INDEX_MAP = {
        "_NIFTY50_INDEX": 13,
        "_NIFTY500_INDEX": 19,
        "NIFTY_100": 17,
        "NIFTY_200": 18,
        "NIFTY_NEXT50": 38,
        "NIFTY_MIDCAP100": 37,
        "NIFTY_SMALLCAP100": 5,
        "BANKNIFTY": 25,
        "FINNIFTY": 27,
        "NIFTYIT": 29,
        "NIFTY_AUTO": 14,
        "NIFTY_PHARMA": 32,
        "NIFTY_FMCG": 28,
        "NIFTY_METAL": 31,
        "NIFTY_ENERGY": 42,
        "NIFTY_INFRA": 43,
        "NIFTY_REALTY": 34,
        "NIFTY_PSU_BANK": 33,
        "NIFTY_PVT_BANK": 15,
        "NIFTY_MEDIA": 30,
        "NIFTY_HEALTHCARE": 447,
        "NIFTY_CONSR_DURBL": 466,
        "NIFTY_FINSRV25_50": 469,
        "NIFTY_OIL_GAS": 470,
        "NIFTY_MIDSML_HLTH": 471,
        "NIFTY_FINSEREXBNK": 495,
        "NIFTY_MS_FIN": 819,
        "NIFTY_MS_IT_TELCM": 821,
    }

    # Map index key in today_quotes.json to (CSV file path, label)
    INDEX_CSV_MAP = {
        "_NIFTY50_INDEX": (os.path.join(HIST_DIR, "NIFTY_50_Daily_1Y.csv"), "Nifty 50 (1Y)"),
        "_NIFTY50_INDEX_5Y": (NIFTY50_CSV, "Nifty 50 (5Y)"),
        "_NIFTY500_INDEX": (NIFTY500_CSV, "Nifty 500"),
        "NIFTY_100": (os.path.join(HIST_DIR, "Indices", "NIFTY_100.csv"), "Nifty 100"),
        "NIFTY_200": (os.path.join(HIST_DIR, "Indices", "NIFTY_200.csv"), "Nifty 200"),
        "NIFTY_NEXT50": (os.path.join(HIST_DIR, "Indices", "NIFTY_NEXT50.csv"), "Nifty Next 50"),
        "NIFTY_MIDCAP100": (os.path.join(HIST_DIR, "Indices", "NIFTY_MIDCAP100.csv"), "Nifty Midcap 100"),
        "NIFTY_SMALLCAP100": (os.path.join(HIST_DIR, "Indices", "NIFTY_SMALLCAP100.csv"), "Nifty Smallcap 100"),
        "BANKNIFTY": (os.path.join(HIST_DIR, "Indices", "BANKNIFTY.csv"), "Bank Nifty"),
        "FINNIFTY": (os.path.join(HIST_DIR, "Indices", "FINNIFTY.csv"), "Fin Nifty"),
        "NIFTYIT": (os.path.join(HIST_DIR, "Indices", "NIFTYIT.csv"), "Nifty IT"),
        "NIFTY_AUTO": (os.path.join(HIST_DIR, "Indices", "NIFTY_AUTO.csv"), "Nifty Auto"),
        "NIFTY_PHARMA": (os.path.join(HIST_DIR, "Indices", "NIFTY_PHARMA.csv"), "Nifty Pharma"),
        "NIFTY_FMCG": (os.path.join(HIST_DIR, "Indices", "NIFTY_FMCG.csv"), "Nifty FMCG"),
        "NIFTY_METAL": (os.path.join(HIST_DIR, "Indices", "NIFTY_METAL.csv"), "Nifty Metal"),
        "NIFTY_ENERGY": (os.path.join(HIST_DIR, "Indices", "NIFTY_ENERGY.csv"), "Nifty Energy"),
        "NIFTY_INFRA": (os.path.join(HIST_DIR, "Indices", "NIFTY_INFRA.csv"), "Nifty Infra"),
        "NIFTY_REALTY": (os.path.join(HIST_DIR, "Indices", "NIFTY_REALTY.csv"), "Nifty Realty"),
        "NIFTY_PSU_BANK": (os.path.join(HIST_DIR, "Indices", "NIFTY_PSU_BANK.csv"), "Nifty PSU Bank"),
        "NIFTY_PVT_BANK": (os.path.join(HIST_DIR, "Indices", "NIFTY_PVT_BANK.csv"), "Nifty Pvt Bank"),
        "NIFTY_MEDIA": (os.path.join(HIST_DIR, "Indices", "NIFTY_MEDIA.csv"), "Nifty Media"),
        "NIFTY_HEALTHCARE": (os.path.join(HIST_DIR, "Indices", "NIFTY_HEALTHCARE.csv"), "Nifty Healthcare"),
        "NIFTY_CONSR_DURBL": (os.path.join(HIST_DIR, "Indices", "NIFTY_CONSR_DURBL.csv"), "Nifty Consumer Durables"),
        "NIFTY_FINSRV25_50": (os.path.join(HIST_DIR, "Indices", "NIFTY_FINSRV25_50.csv"), "Nifty Fin Services 25/50"),
        "NIFTY_OIL_GAS": (os.path.join(HIST_DIR, "Indices", "NIFTY_OIL_GAS.csv"), "Nifty Oil and Gas"),
        "NIFTY_MIDSML_HLTH": (os.path.join(HIST_DIR, "Indices", "NIFTY_MIDSML_HLTH.csv"), "Nifty MidSmall Healthcare"),
        "NIFTY_FINSEREXBNK": (os.path.join(HIST_DIR, "Indices", "NIFTY_FINSEREXBNK.csv"), "Nifty Fin Services Ex-Bank"),
        "NIFTY_MS_FIN": (os.path.join(HIST_DIR, "Indices", "NIFTY_MS_FIN.csv"), "Nifty MidSmall Fin Services"),
        "NIFTY_MS_IT_TELCM": (os.path.join(HIST_DIR, "Indices", "NIFTY_MS_IT_TELCM.csv"), "Nifty MidSmall IT & Telecom"),
    }

    # Fetch Nifty 50 index quote (security_id=13, segment=IDX_I)
    print("  Fetching index quotes...")
    sids = list(INDEX_MAP.values())

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

    def _fetch_index_quotes_batch(method_name: str, sids: list[int]) -> dict | None:
        """Try ohlc_data/quote_data/ticker_data for IDX_I indices. Returns raw idx_data dict or None."""
        try:
            method = getattr(helper.dhan, method_name)
            res = method(securities={"IDX_I": sids})
            if not isinstance(res, dict) or res.get("status") != "success":
                return None
            raw = res.get("data", {})
            if isinstance(raw, dict) and "data" in raw:
                raw = raw["data"]
            return raw.get("IDX_I", raw) if isinstance(raw, dict) else None
        except Exception:
            return None

    def _ltp_to_ohlcv(ltp: float) -> dict:
        return {"open": ltp, "high": ltp, "low": ltp, "close": ltp, "volume": 0}

    try:
        # Try batch REST endpoints in order of reliability
        idx_data = (
            _fetch_index_quotes_batch("ohlc_data", sids)
            or _fetch_index_quotes_batch("quote_data", sids)
            or _fetch_index_quotes_batch("ticker_data", sids)
        )

        if isinstance(idx_data, dict):
            for today_key, sid in INDEX_MAP.items():
                t = idx_data.get(str(sid)) or idx_data.get(sid)
                if t:
                    ohlcv = _parse_idx(t)
                    if ohlcv:
                        all_quotes[today_key] = ohlcv

        # Fallback for any missing indices: use DhanHelper.get_ltp()
        GET_LTP_SYMBOL_MAP = {
            "_NIFTY50_INDEX": ("NIFTY", "IDX_I"),
            "_NIFTY500_INDEX": ("NIFTY 500", "IDX_I"),
            "NIFTY_100": ("NIFTY 100", "NSE"),
            "NIFTY_200": ("NIFTY 200", "NSE"),
            "NIFTY_NEXT50": ("NIFTY NEXT 50", "NSE"),
            "NIFTY_MIDCAP100": ("NIFTY MID100 FREE", "NSE"),
            "NIFTY_SMALLCAP100": ("NIFTY SMALLCAP 100", "NSE"),
            "BANKNIFTY": ("BANKNIFTY", "IDX_I"),
            "FINNIFTY": ("FINNIFTY", "IDX_I"),
            "NIFTYIT": ("NIFTYIT", "NSE"),
            "NIFTY_AUTO": ("NIFTY AUTO", "NSE"),
            "NIFTY_PHARMA": ("NIFTY PHARMA", "NSE"),
            "NIFTY_FMCG": ("NIFTY FMCG", "NSE"),
            "NIFTY_METAL": ("NIFTY METAL", "NSE"),
            "NIFTY_ENERGY": ("NIFTY ENERGY", "NSE"),
            "NIFTY_INFRA": ("NIFTYINFRA", "NSE"),
            "NIFTY_REALTY": ("NIFTY REALTY", "NSE"),
            "NIFTY_PSU_BANK": ("NIFTY PSU BANK", "NSE"),
            "NIFTY_PVT_BANK": ("NIFTY PVT BANK", "NSE"),
            "NIFTY_MEDIA": ("NIFTY MEDIA", "NSE"),
            "NIFTY_HEALTHCARE": ("NIFTY HEALTHCARE", "NSE"),
            "NIFTY_CONSR_DURBL": ("NIFTY CONSR DURBL", "NSE"),
            "NIFTY_FINSRV25_50": ("NIFTY FINSRV25 50", "NSE"),
            "NIFTY_OIL_GAS": ("NIFTY OIL AND GAS", "NSE"),
            "NIFTY_MIDSML_HLTH": ("NIFTY MIDSML HLTH", "NSE"),
            "NIFTY_FINSEREXBNK": ("NIFTY FINSEREXBNK", "NSE"),
            "NIFTY_MS_FIN": ("Nifty MS Fin Serv", "NSE"),
            "NIFTY_MS_IT_TELCM": ("Nifty MS IT Telcm", "NSE"),
        }

        for today_key, (symbol, exch) in GET_LTP_SYMBOL_MAP.items():
            if today_key not in all_quotes:
                try:
                    ltp = helper.get_ltp(symbol, exchange=exch, instrument="INDEX")
                    if ltp and ltp > 0:
                        all_quotes[today_key] = _ltp_to_ohlcv(float(ltp))
                        print(f"    [INFO] {today_key} LTP via helper.get_ltp() ({symbol})")
                except Exception as e:
                    print(f"    [WARN] helper.get_ltp {symbol} ({exch}) failed: {e}")

        # Print all indices fetched
        print(f"  Indices fetched successfully: {len(all_quotes)} / {len(INDEX_MAP)}")

    except Exception as e:
        print(f"    -> Index fetch failed: {e}")

    # ── Write today's row into each stock CSV ────────────────────────────────
    print(f"\n  Updating stock CSVs...")
    appended, updated, errors = update_stock_csvs(all_quotes, today)
    print(f"  OK Stocks: {appended} appended, {updated} updated, {errors} errors")

    # ── Write today's row into index EOD CSVs ────────────────────────────────
    print(f"\n  Updating index CSVs...")
    for today_key, ohlcv in all_quotes.items():
        if today_key == "_NIFTY50_INDEX":
            # Nifty 50 has two CSVs to update (1Y and 5Y)
            p1, l1 = INDEX_CSV_MAP["_NIFTY50_INDEX"]
            p2, l2 = INDEX_CSV_MAP["_NIFTY50_INDEX_5Y"]
            update_index_csv(p1, l1, ohlcv, today)
            update_index_csv(p2, l2, ohlcv, today)
        elif today_key in INDEX_CSV_MAP:
            p, l = INDEX_CSV_MAP[today_key]
            update_index_csv(p, l, ohlcv, today)

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
