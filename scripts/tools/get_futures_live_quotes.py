"""
One-shot REST fetch of live LTP for every near-month FUTSTK contract.

The FUTSTK_OI_Snapshot.csv that feeds the /futures OI-buildup table is EOD-only
(it needs two settled daily bars to compute OI change), so its Price column can
lag the real market by up to a day between EOD refreshes. This script gives the
dashboard a way to overlay a live price on top of that EOD row without needing
a persistent WebSocket bridge — it's called on demand (deduped + short-TTL
cached in rs_dashboard/lib/futuresLiveQuotes.ts), not run as a background loop.

Prints a single JSON line to stdout: {"updated_at": "...", "quotes": {"SYM": ltp}}
"""
import sys
import os
import json
import time
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)
sys.path.insert(0, os.path.join(PROJECT_ROOT, "scripts", "downloader"))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from download_futures_manual import select_near_month_futstk

BATCH_SIZE = 100


def fetch_quotes(helper: DhanHelper, near_month) -> dict[str, float]:
    quotes: dict[str, float] = {}

    for segment in ("NSE_FNO", "BSE_FNO"):
        seg_rows = near_month[near_month["EXCH_ID"].str.upper() == segment.split("_")[0]]
        if seg_rows.empty:
            continue
        sid_to_symbol = dict(zip(seg_rows["SECURITY_ID"].astype(int), seg_rows["UNDERLYING_SYMBOL"]))
        sids = list(sid_to_symbol.keys())

        for i in range(0, len(sids), BATCH_SIZE):
            batch = sids[i:i + BATCH_SIZE]
            try:
                res = helper.dhan.ohlc_data(securities={segment: batch})
            except Exception:
                continue
            if not isinstance(res, dict) or res.get("status") != "success":
                continue
            raw = res.get("data", {})
            if isinstance(raw, dict) and "data" in raw:
                raw = raw["data"]
            seg_data = raw.get(segment, raw) if isinstance(raw, dict) else {}
            if not isinstance(seg_data, dict):
                continue
            for sid_str, ticker in seg_data.items():
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
                if ltp > 0:
                    quotes[sym] = ltp

            time.sleep(1.2)

    return quotes


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Dhan auth failed"}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    df_master = helper._load_master_list()
    near_month = select_near_month_futstk(df_master)

    quotes = fetch_quotes(helper, near_month)

    print(json.dumps({
        "success": True,
        "updated_at": datetime.now().isoformat(),
        "quotes": quotes,
    }))


if __name__ == "__main__":
    main()
