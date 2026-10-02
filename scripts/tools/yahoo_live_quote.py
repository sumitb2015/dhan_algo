"""Live global-market quotes from Yahoo Finance (1-min bars): DXY, US 10Y / 30Y yields, US, Asia and Europe equity indices.

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
}


def quote(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    h = t.history(period="1d", interval="1m")
    h = h[h["Close"] > 0]
    if h.empty:
        raise RuntimeError("no 1m bars")
    prev = None
    try:
        prev = float(t.fast_info["previous_close"])
    except Exception:
        pass
    if not prev or prev != prev:
        # Last completed daily close: the bar before the one holding the latest tick.
        d = t.history(period="5d", interval="1d")
        d = d[d["Close"] > 0]
        last_day = h.index[-1].date()
        before = d[[i.date() < last_day for i in d.index]]
        prev = float(before["Close"].iloc[-1] if not before.empty else d["Close"].iloc[-2])
    return {
        "ltp": round(float(h["Close"].iloc[-1]), 3),
        "prev_close": round(prev, 3),
        "day_high": round(float(h["High"].max()), 3),
        "day_low": round(float(h["Low"].min()), 3),
        "ts": int(h.index[-1].timestamp() * 1000),
    }


def main():
    def safe(item):
        try:
            return item[0], quote(item[1])
        except Exception:
            return item[0], None

    with ThreadPoolExecutor(max_workers=8) as pool:
        out = {k: q for k, q in pool.map(safe, TICKERS.items()) if q}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
