"""
Fetch today's 1-min intraday candles for India VIX and print JSON to stdout.

Prints a single JSON line. All logs go to stderr.
Security ID 21 = India VIX on Dhan NSE_IDX segment.
"""
import sys
import os
import json
from datetime import date, timedelta, datetime, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

VIX_SECURITY_ID = "21"
VIX_CSV = os.path.join(ROOT, "Historical Data", "Indices", "INDIA_VIX.csv")


def _prev_close_from_csv() -> float:
    """Return last row's Close from daily INDIA_VIX.csv as prev close."""
    try:
        with open(VIX_CSV, encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        if len(lines) < 3:  # header + at least 2 rows
            return 0.0
        last_row = lines[-1].split(",")
        return float(last_row[4])  # close is index 4
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

    df = helper.get_intraday_minute_data(
        security_id=VIX_SECURITY_ID,
        exchange_segment="IDX_I",
        instrument_type="INDEX",
        interval="1",
        from_date=lookback_str,
        to_date=today_str,
    )

    if df is None or df.empty:
        print(json.dumps({"error": "No intraday data returned for India VIX — check auth token"}))
        return

    # Keep only most recent trading day
    import pandas as pd
    ts_col = _col(df, "start_Time", "timestamp", "time", "date")
    col = df[ts_col]
    if col.dtype in ("int64", "float64"):
        dates = pd.to_datetime(col, unit="s").dt.date
    else:
        dates = pd.to_datetime(col, errors="coerce").dt.date
    last_day = dates.max()
    df = df[dates == last_day].copy()
    data_date = str(last_day)
    is_today = data_date == today_str

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
        })

    spot      = round(closes[-1], 2) if closes else 0.0
    day_open  = round(opens[0],   2) if opens  else 0.0
    day_high  = round(max(highs),  2) if highs  else 0.0
    day_low   = round(min(lows),   2) if lows   else 0.0
    prev_close = _prev_close_from_csv()

    print(json.dumps({
        "candles":    candles,
        "spot":       spot,
        "day_open":   day_open,
        "day_high":   day_high,
        "day_low":    day_low,
        "prev_close": prev_close,
        "data_date":  data_date,
        "is_today":   is_today,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
