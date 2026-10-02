"""Live global-market quotes from Yahoo Finance (1-min bars): DXY, US 10Y / 30Y yields, US, Asia and Europe equity indices, WTI / Brent crude.

Prints one JSON line: {KEY: {ltp, prev_close, day_high, day_low, ts}, ...}
(ts = last bar, epoch ms); keys that fail are omitted. Yields are in percent.
Called by rs_dashboard/app/api/markets/global/route.ts.
"""
import json
import warnings
from concurrent.futures import ThreadPoolExecutor

warnings.filterwarnings("ignore")
import yfinance as yf

TICKERS = {
    "DXY": "DX-Y.NYB", "US10Y": "^TNX", "US30Y": "^TYX",
    "DJI": "^DJI", "NASDAQ": "^IXIC", "SPX": "^GSPC",
    "N225": "^N225", "HSI": "^HSI", "SSEC": "000001.SS", "KS11": "^KS11", "AXJO": "^AXJO",
    "FTSE": "^FTSE", "GDAXI": "^GDAXI", "FCHI": "^FCHI", "STOXX50E": "^STOXX50E",
    "WTI": "CL=F", "BRENT": "BZ=F",
}


# Local regular-session close (HH:MM, exchange time) per key. Yahoo's index bars lag
# 15-20 min, so "last bar is old" can't tell a trading market from a closed one;
# a last bar at/after the close means the session is over. 24h/unknown keys omitted.
SESSION_CLOSE = {
    "N225": "15:30", "HSI": "16:00", "SSEC": "15:00", "KS11": "15:30", "AXJO": "16:00",
    "FTSE": "16:30", "GDAXI": "17:30", "FCHI": "17:30", "STOXX50E": "17:30",
    "DJI": "16:00", "NASDAQ": "16:00", "SPX": "16:00",
}


def session_over(key: str, last_bar) -> bool:
    close = SESSION_CLOSE.get(key)
    if not close:
        return False
    hh, mm = map(int, close.split(":"))
    # last_bar is tz-aware in the exchange's own zone, so .hour/.minute are local.
    return last_bar.hour * 60 + last_bar.minute >= hh * 60 + mm - 3


def quote(ticker: str, key: str = "") -> dict:
    t = yf.Ticker(ticker)
    h = t.history(period="1d", interval="1m")
    h = h[h["Close"] > 0]
    if h.empty:
        raise RuntimeError("no 1m bars")
    # Previous close = last completed daily bar before the session holding the latest
    # tick. Taken from the daily series (the same one the history columns use), not
    # fast_info["previous_close"], which flips between values for futures.
    prev = None
    d = t.history(period="10d", interval="1d")
    d = d[d["Close"] > 0]
    last_day = h.index[-1].date()
    before = d[[i.date() < last_day for i in d.index]]
    if not before.empty:
        prev = float(before["Close"].iloc[-1])
    if not prev:
        try:
            prev = float(t.fast_info["previous_close"])
        except Exception:
            raise RuntimeError("no previous close")
    return {
        "ltp": round(float(h["Close"].iloc[-1]), 3),
        "prev_close": round(prev, 3),
        "day_high": round(float(h["High"].max()), 3),
        "day_low": round(float(h["Low"].min()), 3),
        "ts": int(h.index[-1].timestamp() * 1000),
        "closed": session_over(key, h.index[-1]),
    }


def main():
    def safe(item):
        try:
            return item[0], quote(item[1], item[0])
        except Exception:
            return item[0], None

    with ThreadPoolExecutor(max_workers=8) as pool:
        out = {k: q for k, q in pool.map(safe, TICKERS.items()) if q}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
