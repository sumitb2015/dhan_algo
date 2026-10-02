"""Live US Dollar Index (DX-Y.NYB) quote from Yahoo Finance (1-min bars).

Prints one JSON line: {ltp, prev_close, day_high, day_low, ts} (ts = last bar, epoch ms).
Called by rs_dashboard/app/api/markets/dxy/route.ts.
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import yfinance as yf


def main():
    t = yf.Ticker("DX-Y.NYB")
    h = t.history(period="1d", interval="1m")
    h = h[h["Close"] > 0]
    if h.empty:
        raise RuntimeError("no 1m bars")
    fi = t.fast_info
    print(json.dumps({
        "ltp": round(float(h["Close"].iloc[-1]), 3),
        "prev_close": round(float(fi["previous_close"]), 3),
        "day_high": round(float(max(h["High"].max(), 0)), 3),
        "day_low": round(float(h["Low"].min()), 3),
        "ts": int(h.index[-1].timestamp() * 1000),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)[:200]}))
        sys.exit(1)
