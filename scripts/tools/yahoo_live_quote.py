"""Live global-market quotes from Yahoo Finance (1-min bars): DXY, US 10Y / 30Y yields.

Prints one JSON line: {KEY: {ltp, prev_close, day_high, day_low, ts}, ...}
(ts = last bar, epoch ms); keys that fail are omitted. Yields are in percent.
Called by rs_dashboard/app/api/markets/global/route.ts.
"""
import json
import warnings

warnings.filterwarnings("ignore")
import yfinance as yf

TICKERS = {"DXY": "DX-Y.NYB", "US10Y": "^TNX", "US30Y": "^TYX"}


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
    out = {}
    for key, ticker in TICKERS.items():
        try:
            out[key] = quote(ticker)
        except Exception:
            pass
    print(json.dumps(out))


if __name__ == "__main__":
    main()
