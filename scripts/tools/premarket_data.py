"""
Premarket data aggregator for the Next.js dashboard.

Fetches:
  - NIFTY current-month futures LTP + prev close
  - MCX Gold, Silver, CrudeOil nearest futures LTP + prev close
  - NIFTY options chain nearest expiry → ATM IV, PCR, max OI strikes

Prints a single JSON line to stdout. All logs go to stderr.
Usage:
    pythonw.exe scripts/tools/premarket_data.py
"""
import sys
import os
import json
import logging
from datetime import datetime, date, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
logger = logging.getLogger(__name__)

# Dhan OHLC API segment names (differ from master_list SEGMENT column codes)
SEG_NSE_FNO  = "NSE_FNO"
SEG_MCX_COMM = "MCX_COMM"


def _find_nearest_future(helper, symbol, exchange="NSE", instrument="FUTIDX"):
    """
    Find nearest non-expired future for a symbol.
    DhanHelper.find_future picks the lowest expiry date without filtering past dates,
    so we need to explicitly skip expired contracts.
    """
    today = date.today().isoformat()          # "2026-07-06"
    df = helper._load_master_list()
    symbol_upper = symbol.upper()
    mask = (
        (df["EXCH_ID"] == exchange) &
        (df["INSTRUMENT"] == instrument) &
        (df["UNDERLYING_SYMBOL"] == symbol_upper) &
        (df["SM_EXPIRY_DATE"] >= today)
    )
    res = df[mask]
    if res.empty:
        return None
    res = res.sort_values("SM_EXPIRY_DATE")
    return res.iloc[0].to_dict()


def get_all_market_data(helper):
    """
    Fetch NIFTY futures + MCX commodities in ONE OHLC call to respect the 1 req/s limit.
    Returns (nifty_entry, nifty_expiry, commodity_entries) where each *_entry is the
    raw OHLC dict or None.
    """
    today = date.today().isoformat()

    # --- Nifty futures ---
    nifty_fut = _find_nearest_future(helper, "NIFTY", exchange="NSE", instrument="FUTIDX")
    nifty_sid    = int(nifty_fut["SECURITY_ID"]) if nifty_fut else None
    nifty_expiry = str(nifty_fut.get("SM_EXPIRY_DATE", ""))  if nifty_fut else ""

    # --- MCX commodities ---
    mcx_specs = [
        ("GOLD",     "MCX Gold"),
        ("SILVER",   "MCX Silver"),
        ("CRUDEOIL", "MCX CrudeOil"),
    ]
    mcx_found = []
    mcx_sids  = []
    for symbol, display_name in mcx_specs:
        fut = _find_nearest_future(helper, symbol, exchange="MCX", instrument="FUTCOM")
        if fut:
            sid = int(fut["SECURITY_ID"])
            mcx_sids.append(sid)
            mcx_found.append((symbol, display_name, sid))
        else:
            logger.warning(f"MCX {symbol}: no non-expired future in master_list")
            mcx_found.append((symbol, display_name, None))

    # --- Single batched OHLC request ---
    securities = {}
    if nifty_sid:
        securities[SEG_NSE_FNO] = [nifty_sid]
    if mcx_sids:
        securities[SEG_MCX_COMM] = mcx_sids

    ohlc_raw = {}
    if securities:
        try:
            ohlc_raw = helper.get_ohlc_data(securities) or {}
        except Exception as e:
            logger.error(f"OHLC batch fetch failed: {e}")

    return nifty_sid, nifty_expiry, mcx_found, ohlc_raw


def build_futures(nifty_sid, nifty_expiry, ohlc_raw):
    """Extract Nifty futures data from OHLC raw result."""
    if not nifty_sid:
        return None
    entry = (ohlc_raw.get(SEG_NSE_FNO) or {}).get(str(nifty_sid))
    if not entry:
        logger.warning(f"No OHLC entry for NIFTY future sid={nifty_sid}")
        return None
    ltp  = entry.get("last_price") or 0
    prev = (entry.get("ohlc") or {}).get("close") or 0
    if not ltp:
        return None
    return {"ltp": ltp, "prevClose": prev, "expiry": nifty_expiry}


def build_commodities(mcx_found, ohlc_raw):
    """Build commodity list from OHLC raw result."""
    results = []
    mcx_seg = ohlc_raw.get(SEG_MCX_COMM) or {}
    for symbol, display_name, sid in mcx_found:
        if sid is None:
            results.append({"name": display_name, "ltp": 0, "prevClose": 0, "pctChange": 0.0})
            continue
        entry = mcx_seg.get(str(sid))
        if entry:
            ltp  = entry.get("last_price") or 0
            prev = (entry.get("ohlc") or {}).get("close") or 0
        else:
            ltp, prev = 0, 0
            logger.warning(f"No OHLC entry for {display_name} sid={sid}")
        pct = round((ltp - prev) / prev * 100, 2) if prev > 0 else 0.0
        results.append({
            "name":      display_name,
            "ltp":       ltp,
            "prevClose": prev,
            "pctChange": pct,
        })
    return results


def get_options_data(helper):
    """Nearest expiry chain → ATM IV, PCR, max OI strikes."""
    try:
        expiry = helper.get_nearest_expiry("NIFTY")
        if not expiry:
            return None

        spot       = helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX") or 0
        chain_data = helper.get_option_chain("NIFTY", expiry)
        oc         = (chain_data or {}).get("oc", {})
        if not oc:
            return None

        # ATM strike
        strikes = []
        for k in oc.keys():
            try:
                strikes.append(float(k))
            except ValueError:
                pass
        if not strikes:
            return None

        atm       = min(strikes, key=lambda s: abs(s - spot))
        atm_entry = oc.get(str(int(atm)), {})
        ce_iv     = (atm_entry.get("ce") or {}).get("implied_volatility") or 0
        pe_iv     = (atm_entry.get("pe") or {}).get("implied_volatility") or 0
        if ce_iv > 0 and pe_iv > 0:
            atm_iv = (ce_iv + pe_iv) / 2
        else:
            atm_iv = max(ce_iv, pe_iv)

        # PCR and max OI
        total_ce_oi = total_pe_oi = 0
        max_ce_oi   = max_pe_oi   = 0
        max_ce_strike = max_pe_strike = 0.0
        for strike_str, entry in oc.items():
            ce_oi = (entry.get("ce") or {}).get("oi") or 0
            pe_oi = (entry.get("pe") or {}).get("oi") or 0
            total_ce_oi += ce_oi
            total_pe_oi += pe_oi
            try:
                s = float(strike_str)
            except ValueError:
                continue
            if ce_oi > max_ce_oi:
                max_ce_oi     = ce_oi
                max_ce_strike = s
            if pe_oi > max_pe_oi:
                max_pe_oi     = pe_oi
                max_pe_strike = s

        pcr        = round(total_pe_oi / total_ce_oi, 3) if total_ce_oi > 0 else 1.0
        fetched_at = datetime.now(timezone.utc).isoformat()

        return {
            "expiry":       expiry,
            "atmIV":        round(atm_iv, 2),
            "pcr":          pcr,
            "maxCeOiStrike": int(max_ce_strike),
            "maxPeOiStrike": int(max_pe_strike),
            "chainFetchedAt": fetched_at,
        }
    except Exception as e:
        logger.error(f"Options chain failed: {e}")
        return None


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py"}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    # Gracefully degrade: if market data fetch fails, other sections proceed independently
    try:
        nifty_sid, nifty_expiry, mcx_found, ohlc_raw = get_all_market_data(helper)
    except Exception as e:
        logger.error(f"get_all_market_data failed: {e}")
        nifty_sid, nifty_expiry, mcx_found, ohlc_raw = None, None, [], {}

    result = {
        "futures":     build_futures(nifty_sid, nifty_expiry, ohlc_raw),
        "commodities": build_commodities(mcx_found, ohlc_raw),
        "options":     get_options_data(helper),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
