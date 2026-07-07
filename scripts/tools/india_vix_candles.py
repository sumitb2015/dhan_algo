"""
Fetch today's 1-min intraday candles for India VIX and print JSON to stdout.

Prints a single JSON line. All logs go to stderr.
Security ID 21 = India VIX on Dhan NSE_IDX segment.
"""
import sys
import os
import json
import urllib.request
from datetime import date, timedelta, datetime, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

VIX_SECURITY_ID   = "21"
NIFTY_SECURITY_ID = "13"
VIX_CSV  = os.path.join(ROOT, "Historical Data", "Indices", "INDIA_VIX.csv")
OHLC_URL = "https://api.dhan.co/v2/marketfeed/ohlc"


def _fetch_prev_closes(dhan) -> dict:
    """Fetch previous-session closes for both India VIX and Nifty."""
    closes = {VIX_SECURITY_ID: 0.0, NIFTY_SECURITY_ID: 0.0}
    try:
        token     = dhan.dhan_http.access_token
        client_id = dhan.dhan_http.client_id
        body = json.dumps({"NSE_IDX": [int(VIX_SECURITY_ID), int(NIFTY_SECURITY_ID)]}).encode()
        req  = urllib.request.Request(
            OHLC_URL, data=body, method="POST",
            headers={
                "access-token":  token,
                "client-id":     client_id,
                "Content-Type":  "application/json",
                "Accept":        "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            res = json.loads(resp.read())
        if res.get("status") == "success":
            data = res.get("data", {}) or {}
            idx_data = data.get("NSE_IDX", {}) or {}
            for sid in (VIX_SECURITY_ID, NIFTY_SECURITY_ID):
                entry = idx_data.get(sid, {}) or {}
                ohlc  = entry.get("ohlc") or {}
                val   = float(ohlc.get("close") or 0)
                if val > 0:
                    closes[sid] = round(val, 2)
    except Exception as e:
        print(f"WARN: prev_closes fetch failed: {e}", file=sys.stderr)
    return closes


def _prev_close_from_csv() -> float:
    """Return last row's Close from daily INDIA_VIX.csv as prev close (CSV fallback only)."""
    try:
        with open(VIX_CSV, encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        if len(lines) < 3:  # header + at least 2 rows
            return 0.0
        last_row = lines[-1].split(",")
        return float(last_row[4])  # close is index 4
    except Exception:
        return 0.0


def _prev_day_close_from_intraday(raw_df, today_date_str: str) -> float:
    """
    From the multi-day intraday DataFrame, return the last close of the most
    recent trading day before today_date_str. More reliable than the CSV when
    the daily CSV has not been refreshed.
    """
    try:
        import pandas as pd
        if raw_df is None or raw_df.empty:
            return 0.0
        tc = _col(raw_df, "start_Time", "timestamp", "time", "date")
        col = raw_df[tc]
        dates = (pd.to_datetime(col, unit="s").dt.date
                 if col.dtype in ("int64", "float64")
                 else pd.to_datetime(col, errors="coerce").dt.date)
        prev_days = sorted(d for d in dates.unique() if str(d) < today_date_str)
        if not prev_days:
            return 0.0
        prev_day = prev_days[-1]
        prev_df = raw_df[dates == prev_day]
        close_col = _col(prev_df, "close", "Close", "c")
        return round(float(prev_df[close_col].iloc[-1]), 2)
    except Exception:
        return 0.0


def _to_hhmm(raw) -> str:
    """Convert Dhan timestamp (unix seconds, unix ms, or ISO string) to HH:MM IST."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:  # milliseconds
            val /= 1000
        dt = datetime.fromtimestamp(val, tz=_IST)
        return dt.strftime("%H:%M")
    except (ValueError, TypeError, OSError):
        pass
    s = str(raw).replace("T", " ")
    return s[11:16] if len(s) > 10 else s


def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return df.columns[0]


def main():
    today = date.today()
    today_str = today.strftime("%Y-%m-%d")
    lookback_str = (today - timedelta(days=5)).strftime("%Y-%m-%d")

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return

    helper = DhanHelper(dhan)

    import pandas as pd

    def _fetch(security_id):
        return helper.get_intraday_minute_data(
            security_id=security_id,
            exchange_segment="IDX_I",
            instrument_type="INDEX",
            interval="1",
            from_date=lookback_str,
            to_date=today_str,
        )

    def _filter_last_day(raw_df):
        if raw_df is None or raw_df.empty:
            return raw_df, None
        tc = _col(raw_df, "start_Time", "timestamp", "time", "date")
        col = raw_df[tc]
        dates = pd.to_datetime(col, unit="s").dt.date if col.dtype in ("int64", "float64") else pd.to_datetime(col, errors="coerce").dt.date
        last = dates.max()
        return raw_df[dates == last].copy(), str(last)

    raw_vix_df = _fetch(VIX_SECURITY_ID)
    df, data_date = _filter_last_day(raw_vix_df)
    if df is None or df.empty:
        print(json.dumps({"error": "No intraday data returned for India VIX — check auth token"}))
        return

    is_today = data_date == today_str

    # Nifty candles — build time→close map for overlay (best-effort; missing = null)
    nifty_df, _ = _filter_last_day(_fetch(NIFTY_SECURITY_ID))
    nifty_map: dict = {}
    if nifty_df is not None and not nifty_df.empty:
        n_ts  = _col(nifty_df, "start_Time", "timestamp", "time", "date")
        n_cls = _col(nifty_df, "close", "Close", "c")
        for _, row in nifty_df.iterrows():
            nifty_map[_to_hhmm(row[n_ts])] = round(float(row[n_cls]), 2)

    ts_col = _col(df, "start_Time", "timestamp", "time", "date")

    open_col  = _col(df, "open",  "Open",  "o")
    high_col  = _col(df, "high",  "High",  "h")
    low_col   = _col(df, "low",   "Low",   "l")
    close_col = _col(df, "close", "Close", "c")

    closes = df[close_col].astype(float).tolist()
    opens  = df[open_col].astype(float).tolist()
    highs  = df[high_col].astype(float).tolist()
    lows   = df[low_col].astype(float).tolist()
    times  = [_to_hhmm(row[ts_col]) for _, row in df.iterrows()]

    # 5-min ROC: roc5[i] = (close[i] - close[i-5]) / close[i-5] * 100
    roc5 = [None] * 5
    for i in range(5, len(closes)):
        base = closes[i - 5]
        roc5.append(round((closes[i] - base) / base * 100, 4) if base != 0 else None)

    candles = []
    for i, t in enumerate(times):
        candles.append({
            "time":  t,
            "open":  round(opens[i],  2),
            "high":  round(highs[i],  2),
            "low":   round(lows[i],   2),
            "close": round(closes[i], 2),
            "roc5":  roc5[i],
            "nifty": nifty_map.get(t),  # None if no matching Nifty candle
        })

    spot      = round(closes[-1], 2) if closes else 0.0
    day_open  = round(opens[0],   2) if opens  else 0.0
    day_high  = round(max(highs),  2) if highs  else 0.0
    day_low   = round(min(lows),   2) if lows   else 0.0

    closes_data = _fetch_prev_closes(dhan)
    vix_prev = closes_data.get(VIX_SECURITY_ID, 0.0)
    nifty_prev = closes_data.get(NIFTY_SECURITY_ID, 0.0)

    prev_close = (vix_prev
                  or _prev_day_close_from_intraday(raw_vix_df, data_date)
                  or _prev_close_from_csv())

    nifty_spot = 0.0
    if nifty_df is not None and not nifty_df.empty:
        n_cls = _col(nifty_df, "close", "Close", "c")
        nifty_spot = round(float(nifty_df[n_cls].iloc[-1]), 2)

    nifty_change = round(nifty_spot - nifty_prev, 2) if (nifty_spot > 0 and nifty_prev > 0) else 0.0
    nifty_change_pct = round(nifty_change / nifty_prev * 100, 4) if nifty_prev > 0 else 0.0

    print(json.dumps({
        "candles":    candles,
        "spot":       spot,
        "day_open":   day_open,
        "day_high":   day_high,
        "day_low":    day_low,
        "prev_close": prev_close,
        "data_date":  data_date,
        "is_today":   is_today,
        "nifty_spot":       nifty_spot,
        "nifty_prev_close": nifty_prev,
        "nifty_change":     nifty_change,
        "nifty_change_pct": nifty_change_pct,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
