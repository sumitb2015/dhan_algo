"""
Build OI Snapshots — reconstructs minute-by-minute option chain snapshots (ATM ± wings)
for any underlying (NIFTY, BANKNIFTY, SENSEX, CRUDEOIL) for a specified date and writes
to the debug/ snapshot CSV directory matching the schema used by iv_history.

Usage:
    python scripts/tools/build_oi_snapshots.py --underlying BANKNIFTY --date 2026-09-25
    python scripts/tools/build_oi_snapshots.py --underlying SENSEX --date 2026-09-25
    python scripts/tools/build_oi_snapshots.py --underlying CRUDEOIL --date 2026-09-25
"""

import sys
import os
import argparse
import json
import time
from datetime import datetime, timedelta, date as date_cls
from zoneinfo import ZoneInfo
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from scripts.tools.premarket_data import _find_nearest_future

IST = ZoneInfo("Asia/Kolkata")
DEBUG_DIR = os.path.join(ROOT, "debug")
os.makedirs(DEBUG_DIR, exist_ok=True)

CONFIGS = {
    "NIFTY": {
        "spot_id": "13",
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "leg_seg": "NSE_FNO",
        "leg_inst": "OPTIDX",
        "step": 50,
        "chain_id": "13",
        "chain_seg": "IDX_I",
        "file_prefix": "iv_snapshots_NIFTY_",
        "fallback_prefix": "iv_snapshots_",
    },
    "BANKNIFTY": {
        "spot_id": "25",
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "leg_seg": "NSE_FNO",
        "leg_inst": "OPTIDX",
        "step": 100,
        "chain_id": "25",
        "chain_seg": "IDX_I",
        "file_prefix": "iv_snapshots_BANKNIFTY_",
        "fallback_prefix": "banknifty_oi_snapshots_",
    },
    "SENSEX": {
        "spot_id": "51",
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "leg_seg": "BSE_FNO",
        "leg_inst": "OPTIDX",
        "step": 100,
        "chain_id": "1",
        "chain_seg": "BSE_FNO",
        "file_prefix": "iv_snapshots_SENSEX_",
        "fallback_prefix": "sensex_oi_snapshots_",
    },
    "CRUDEOIL": {
        "spot_seg": "MCX_COMM",
        "spot_inst": "FUTCOM",
        "leg_seg": "MCX_COMM",
        "leg_inst": "OPTFUT",
        "step": 100,
        "chain_seg": "MCX_COMM",
        "file_prefix": "crudeoil_oi_snapshots_",
        "fallback_prefix": "iv_snapshots_CRUDEOIL_",
    },
    "CRUDEOILM": {
        "spot_seg": "MCX_COMM",
        "spot_inst": "FUTCOM",
        "leg_seg": "MCX_COMM",
        "leg_inst": "OPTFUT",
        "step": 100,
        "chain_seg": "MCX_COMM",
        "file_prefix": "crudeoilm_oi_snapshots_",
        "fallback_prefix": "iv_snapshots_CRUDEOILM_",
    },
}

CSV_COLUMNS = [
    "timestamp", "spot", "expiry", "strike",
    "CE_LTP", "CE_IV", "CE_OI", "CE_change_OI", "CE_volume",
    "CE_bid", "CE_ask", "CE_delta", "CE_gamma", "CE_theta", "CE_vega",
    "PE_LTP", "PE_IV", "PE_OI", "PE_change_OI", "PE_volume",
    "PE_bid", "PE_ask", "PE_delta", "PE_gamma", "PE_theta", "PE_vega",
]


def _get_target_csv(underlying: str, date_str: str) -> str:
    cfg = CONFIGS.get(underlying, CONFIGS["NIFTY"])
    return os.path.join(DEBUG_DIR, f"{cfg['file_prefix']}{date_str}.csv")


def _resolve_crude_future(helper: DhanHelper, underlying: str):
    fut = _find_nearest_future(helper, underlying, exchange="MCX", instrument="FUTCOM")
    if not fut:
        fut = _find_nearest_future(helper, "CRUDEOIL", exchange="MCX", instrument="FUTCOM")
    return fut


def build_snapshot(underlying: str, date_str: str, wings: int = 10, force: bool = False):
    underlying = underlying.upper()
    cfg = CONFIGS.get(underlying)
    if not cfg:
        return {"success": False, "error": f"Unsupported underlying: {underlying}"}

    out_file = _get_target_csv(underlying, date_str)
    if os.path.exists(out_file) and os.path.getsize(out_file) > 1000 and not force:
        return {"success": True, "file": out_file, "cached": True}

    dhan = get_dhan_client()
    if not dhan:
        return {"success": False, "error": "Auth failed — check credentials"}
    helper = DhanHelper(dhan)

    # 1. Fetch spot candles for the day
    spot_id = cfg.get("spot_id")
    spot_seg = cfg.get("spot_seg", "IDX_I")
    spot_inst = cfg.get("spot_inst", "INDEX")

    chain_id = cfg.get("chain_id")
    chain_seg = cfg.get("chain_seg", "IDX_I")

    if spot_seg == "MCX_COMM":
        fut = _resolve_crude_future(helper, underlying)
        if not fut:
            return {"success": False, "error": f"Could not find {underlying} future"}
        spot_id = str(fut["SECURITY_ID"])
        chain_id = spot_id

    df_spot = helper.get_historical_data(
        security_id=str(spot_id),
        exchange_segment=spot_seg,
        instrument_type=spot_inst,
        expiry_code=0,
        interval="1",
        from_date=date_str,
        to_date=date_str,
    )

    if df_spot is None or df_spot.empty:
        return {"success": False, "error": f"No spot data for {underlying} on {date_str}"}

    spot_map = {}
    for _, row in df_spot.iterrows():
        ts_val = row["timestamp"]
        if isinstance(ts_val, (int, float)):
            dt = datetime.fromtimestamp(ts_val, tz=IST)
            ts_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        else:
            ts_str = str(ts_val)[:19]
        spot_map[ts_str] = float(row["close"])

    # 2. Determine open spot and ATM strike
    first_spot = float(df_spot.iloc[0]["close"])
    step = cfg["step"]
    atm = int(round(first_spot / step) * step)
    strikes = [atm + i * step for i in range(-wings, wings + 1)]

    # 3. Resolve expiry
    if underlying == "SENSEX":
        expiries = helper.get_expiry_list(under_security_id=1, under_exchange_segment="BSE_FNO")
    elif spot_seg == "MCX_COMM":
        expiries = helper.get_expiry_list(under_security_id=int(chain_id), under_exchange_segment="MCX_COMM")
    else:
        expiries = helper.get_expiries(underlying)

    if not expiries:
        return {"success": False, "error": f"Could not resolve expiry for {underlying}"}
    expiry = expiries[0]

    # 4. Resolve strikes map using get_option_chain_df or find_option
    leg_seg = cfg["leg_seg"]
    leg_inst = cfg["leg_inst"]

    chain_df = helper.get_option_chain_df(str(chain_id), expiry, exchange_segment=chain_seg)
    leg_ids = {}  # strike -> (ce_sid, pe_sid)

    if chain_df is not None and not chain_df.empty:
        for strk_val, row in chain_df.iterrows():
            try:
                s_num = int(float(strk_val))
                ce_s = str(int(row["ce_security_id"])) if "ce_security_id" in row and pd.notna(row["ce_security_id"]) else None
                pe_s = str(int(row["pe_security_id"])) if "pe_security_id" in row and pd.notna(row["pe_security_id"]) else None
                leg_ids[s_num] = (ce_s, pe_s)
            except Exception:
                continue

    # Fallback to find_option if chain_df missed any strikes
    exchange_for_find = "BSE" if underlying == "SENSEX" else "NSE"
    if spot_seg == "MCX_COMM":
        exchange_for_find = "MCX"

    leg_data = {}  # (strike, 'CE'|'PE') -> map of ts_str -> {ltp, oi, vol}

    for strike in strikes:
        ce_sid, pe_sid = leg_ids.get(strike, (None, None))
        if not ce_sid:
            ce_opt = helper.find_option(underlying, expiry, strike, "CE", exchange=exchange_for_find)
            if ce_opt:
                ce_sid = str(ce_opt["SECURITY_ID"])
        if not pe_sid:
            pe_opt = helper.find_option(underlying, expiry, strike, "PE", exchange=exchange_for_find)
            if pe_opt:
                pe_sid = str(pe_opt["SECURITY_ID"])

        for side, sid in (("CE", ce_sid), ("PE", pe_sid)):
            if not sid:
                continue
            time.sleep(0.35)  # Pace to prevent 429
            df_leg = helper.get_historical_data(
                security_id=sid,
                exchange_segment=leg_seg,
                instrument_type=leg_inst,
                expiry_code=0,
                interval="1",
                from_date=date_str,
                to_date=date_str,
                oi=True,
            )
            if df_leg is not None and not df_leg.empty:
                s_map = {}
                for _, r in df_leg.iterrows():
                    ts_v = r["timestamp"]
                    if isinstance(ts_v, (int, float)):
                        d_obj = datetime.fromtimestamp(ts_v, tz=IST)
                        t_s = d_obj.strftime("%Y-%m-%d %H:%M:%S")
                    else:
                        t_s = str(ts_v)[:19]
                    s_map[t_s] = {
                        "ltp": float(r.get("close", 0) or 0),
                        "oi": float(r.get("open_interest", 0) or 0),
                        "volume": float(r.get("volume", 0) or 0),
                    }
                leg_data[(strike, side)] = s_map

    # 5. Build consolidated rows per timestamp
    timestamps = sorted(spot_map.keys())
    if not timestamps:
        return {"success": False, "error": "No common timestamps found"}

    rows = []
    initial_oi = {}

    for ts in timestamps:
        spot_price = spot_map[ts]
        for strike in strikes:
            ce_entry = leg_data.get((strike, "CE"), {}).get(ts, {})
            pe_entry = leg_data.get((strike, "PE"), {}).get(ts, {})

            ce_ltp = ce_entry.get("ltp", 0.0)
            ce_oi = ce_entry.get("oi", 0.0)
            pe_ltp = pe_entry.get("ltp", 0.0)
            pe_oi = pe_entry.get("oi", 0.0)

            if (strike, "CE") not in initial_oi and ce_oi > 0:
                initial_oi[(strike, "CE")] = ce_oi
            if (strike, "PE") not in initial_oi and pe_oi > 0:
                initial_oi[(strike, "PE")] = pe_oi

            ce_base = initial_oi.get((strike, "CE"), ce_oi)
            pe_base = initial_oi.get((strike, "PE"), pe_oi)

            rows.append({
                "timestamp": ts,
                "spot": round(spot_price, 2),
                "expiry": expiry,
                "strike": strike,
                "CE_LTP": ce_ltp,
                "CE_IV": 0.0,
                "CE_OI": int(ce_oi),
                "CE_change_OI": int(ce_oi - ce_base),
                "CE_volume": int(ce_entry.get("volume", 0)),
                "CE_bid": 0.0,
                "CE_ask": 0.0,
                "CE_delta": 0.0,
                "CE_gamma": 0.0,
                "CE_theta": 0.0,
                "CE_vega": 0.0,
                "PE_LTP": pe_ltp,
                "PE_IV": 0.0,
                "PE_OI": int(pe_oi),
                "PE_change_OI": int(pe_oi - pe_base),
                "PE_volume": int(pe_entry.get("volume", 0)),
                "PE_bid": 0.0,
                "PE_ask": 0.0,
                "PE_delta": 0.0,
                "PE_gamma": 0.0,
                "PE_theta": 0.0,
                "PE_vega": 0.0,
            })

    if not rows:
        return {"success": False, "error": "No option rows generated"}

    # Write output CSV
    df_out = pd.DataFrame(rows, columns=CSV_COLUMNS)
    df_out.to_csv(out_file, index=False)

    return {
        "success": True,
        "file": out_file,
        "underlying": underlying,
        "date": date_str,
        "atm": atm,
        "expiry": expiry,
        "rows": len(rows),
        "timestamps": len(timestamps),
    }


def main():
    parser = argparse.ArgumentParser(description="Build OI snapshot CSV for any underlying")
    parser.add_argument("--underlying", default="BANKNIFTY", choices=list(CONFIGS.keys()))
    parser.add_argument("--date", default=None, help="Date in YYYY-MM-DD")
    parser.add_argument("--wings", type=int, default=10, help="ATM ± wings")
    parser.add_argument("--force", action="store_true", help="Overwrite existing CSV")
    args = parser.parse_args()

    date_str = args.date
    if not date_str:
        d = date_cls.today()
        if d.weekday() == 5:
            d = d - timedelta(days=1)
        elif d.weekday() == 6:
            d = d - timedelta(days=2)
        date_str = d.isoformat()

    res = build_snapshot(args.underlying, date_str, wings=args.wings, force=args.force)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
