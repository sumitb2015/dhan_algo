"""One-off helper for the Next.js "Level Chart" page: fetches today's 1-minute intraday
candles for a stock / index / CRUDEOIL(M) future and resamples them two ways —

  - to the user's chosen CHART interval, for the candlestick series
  - to the user's chosen LEVEL interval, for per-bucket High / 50% (mid) / Low overlay zones

Both are derived from the same 1-min series so they always agree on session boundaries.
Prints a single JSON line to stdout; logs go to stderr (same convention as
options_chart_fetch.py / normalized_1min_candles.py).

Usage:
    python level_chart_fetch.py --symbol-type equity     --symbol RELIANCE   --chart-interval 5 --level-interval 15
    python level_chart_fetch.py --symbol-type index      --symbol NIFTY     --chart-interval 1 --level-interval 5
    python level_chart_fetch.py --symbol-type index      --symbol SENSEX    --chart-interval 5 --level-interval 30
    python level_chart_fetch.py --symbol-type crudeoilm  --symbol CRUDEOILM --chart-interval 5 --level-interval 15
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = ZoneInfo("Asia/Kolkata")

VALID_INTERVALS = ("1", "5", "15", "30", "60")
SYMBOL_TYPES = ("equity", "index", "crudeoil", "crudeoilm")


def _print_json(payload: dict) -> None:
    print(json.dumps(payload, allow_nan=False))


def _err(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(0)


def _resolve(helper: DhanHelper, symbol_type: str, symbol: str) -> tuple[int, str, str]:
    """Returns (security_id, exchange_segment, instrument_type) for the underlying's OWN
    intraday series. Indices (incl. SENSEX) resolve to their spot id under IDX_I — the
    id-1/BSE_FNO split only applies to the SENSEX *option chain*, not its own candles.
    CRUDEOIL/CRUDEOILM have no spot index; the nearest non-expired FUTCOM contract stands in
    for it, same as options_chart_fetch.py's _mcx_future()."""
    if symbol_type == "equity":
        sec = helper.find_equity(symbol)
        if not sec:
            raise ValueError(f"Unknown equity symbol: {symbol}")
        return int(sec["SECURITY_ID"]), "NSE_EQ", "EQUITY"

    if symbol_type == "index":
        # find_index()'s "IDX_I" branch hardcodes the master-list lookup to EXCH_ID == "NSE"
        # (see lib/dhan_helper.py), so it can never find SENSEX, which is listed under BSE.
        # Passing "BSE" explicitly for SENSEX resolves it to security id 51 — its own intraday
        # series is served under IDX_I regardless of which exchange the master-list row is on.
        lookup_exchange = "BSE" if symbol.upper() == "SENSEX" else "IDX_I"
        sec = helper.find_index(symbol, exchange=lookup_exchange)
        if not sec:
            raise ValueError(f"Unknown index symbol: {symbol}")
        return int(sec["SECURITY_ID"]), "IDX_I", "INDEX"

    if symbol_type in ("crudeoil", "crudeoilm"):
        underlying = "CRUDEOIL" if symbol_type == "crudeoil" else "CRUDEOILM"
        sec = helper.find_future(underlying, exchange="MCX", instrument="FUTCOM")
        if not sec:
            raise ValueError(f"No live {underlying} futures contract found")
        return int(sec["SECURITY_ID"]), "MCX_COMM", "FUTCOM"

    raise ValueError(f"Unknown symbol_type: {symbol_type}")


# Dhan's intraday_minute_data occasionally appends a single spurious post-close bar (same OHLC
# as the last real print, stamped hours after the session ended) — a variant of the documented
# post-close close/prev_close flip. Drop anything past the session end so it can't show up as a
# stray candle (and a degenerate zero-range level bucket) hours after the real chart.
SESSION_END = {"equity": (15, 30), "index": (15, 30), "crudeoil": (23, 30), "crudeoilm": (23, 30)}


def _fetch_recent_1min(helper: DhanHelper, security_id: int, exchange_segment: str, instrument_type: str, symbol_type: str) -> tuple[pd.DataFrame, object | None]:
    """Returns (df, today_date) covering the last two trading days (today + the prior session),
    each trimmed to its own session end. Two days rather than one: EMA/Supertrend need warm-up
    history to produce correct values from the start of today's session — with only today's bars
    Supertrend has no value at all for its first ~length candles, and EMA is biased toward
    today's opening price rather than reflecting a real N-period average. `today_date` is None
    when no data comes back at all."""
    to_dt = datetime.now(IST)
    # Wide enough to comfortably span a long weekend/holiday run and still land on 2 distinct
    # trading dates; Dhan's intraday_minute_data also rejects a same-day-only range with DH-905
    # (see options_chart_fetch.py's _fetch_intraday), which this clears easily too.
    from_dt = to_dt - timedelta(days=8)

    df = helper.get_intraday_minute_data(
        security_id=security_id,
        exchange_segment=exchange_segment,
        instrument_type=instrument_type,
        interval="1",
        from_date=from_dt.strftime("%Y-%m-%d"),
        to_date=to_dt.strftime("%Y-%m-%d"),
    )
    if df.empty or "timestamp" not in df.columns:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"]), None

    out = pd.DataFrame(
        {
            "time": pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST).dt.floor("min"),
            "open": df["open"],
            "high": df["high"],
            "low": df["low"],
            "close": df["close"],
            "volume": df["volume"],
        }
    )
    out = out.sort_values("time").reset_index(drop=True)
    if out.empty:
        return out, None

    trading_dates = sorted(out["time"].dt.date.unique())
    today_date = trading_dates[-1]
    keep_dates = set(trading_dates[-2:])
    out = out[out["time"].dt.date.isin(keep_dates)].reset_index(drop=True)

    # Per-row session end (each row keeps its own date's cutoff, since this now spans 2 dates) —
    # strips Dhan's spurious post-close bar (see SESSION_END's docstring) from both days.
    end_h, end_m = SESSION_END[symbol_type]
    session_end = out["time"].dt.normalize() + pd.Timedelta(hours=end_h, minutes=end_m)
    out = out[out["time"] < session_end].reset_index(drop=True)
    return out, today_date


def _resample_candles(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    # Grouped per calendar day, each with its own origin="start" — a single ungrouped resample
    # across >1 day would anchor bucket boundaries to the very first bar overall, which drifts
    # day 2's grid whenever day 1's first bar isn't exactly on a `minutes` boundary (see
    # options_chart_fetch.py's _resample_ohlcv, same fix for the same reason). A no-op for the
    # single-day case (candles_df/levels_df), needed for the 2-day EMA/Supertrend warm-up series.
    parts = []
    for _, day_df in df.groupby(df["time"].dt.date):
        bucketed = (
            day_df.set_index("time")[["open", "high", "low", "close", "volume"]]
            .resample(f"{minutes}min", origin="start", label="left", closed="left")
            .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
            .dropna(subset=["open"])
        )
        parts.append(bucketed.reset_index())
    return pd.concat(parts, ignore_index=True).sort_values("time").reset_index(drop=True)


def _resample_levels(df: pd.DataFrame, minutes: int, now_ist: datetime) -> pd.DataFrame:
    bucketed = (
        df.set_index("time")[["high", "low"]]
        .resample(f"{minutes}min", origin="start", label="left", closed="left")
        .agg({"high": "max", "low": "min"})
        .dropna(subset=["high"])
        .reset_index()
    )
    bucketed["mid"] = (bucketed["high"] + bucketed["low"]) / 2
    bucketed["end"] = bucketed["time"] + pd.Timedelta(minutes=minutes)
    # A bucket is "closed" once its full time span has elapsed, regardless of whether it's the
    # last row — after market close every bucket (including the day's final one) is closed;
    # intraday, only the still-forming trailing bucket is open. Comparing against wall-clock
    # `now`, not "is this the last row", makes both cases fall out of the same rule.
    bucketed["closed"] = bucketed["end"] <= pd.Timestamp(now_ist)
    return bucketed


# --- Trend overlays (VWAP / EMA / Supertrend), computed on the chart-interval candles so they
# recompute whenever the user switches chart interval — same idiom as options_chart_fetch.py's
# _compute_indicators, trimmed to the four series this page's overlay toggles offer. ---


def _vwap(df: pd.DataFrame) -> pd.Series:
    """Session-anchored cumulative VWAP. `df` already covers a single trading day (see
    _fetch_1min's session filtering), so unlike options_chart_fetch.py's _vwap() this doesn't
    need to reset the cumulative sums per calendar date."""
    typical = (df["high"] + df["low"] + df["close"]) / 3
    cum_pv = (typical * df["volume"]).cumsum()
    cum_vol = df["volume"].cumsum()
    return cum_pv / cum_vol.replace(0, pd.NA)


def _supertrend(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 10, multiplier: float = 3.0) -> tuple[pd.Series, pd.Series]:
    """Returns (value, direction) where direction is 1 while price is in an uptrend and -1
    while in a downtrend, same length/multiplier defaults as before.

    talib has no native SUPERTREND function — only ATR — so this implements the standard
    reference band-flip algorithm (the same one TradingView's built-in Supertrend uses) on top
    of talib.ATR() for the ATR component, rather than pandas_ta's supertrend(). talib's ATR uses
    Wilder's smoothing, the textbook definition; band continuation (a band only ever tightens
    toward price while the trend holds, and only resets on a flip) is applied by hand below."""
    import numpy as np
    import talib

    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    n = len(c)

    atr = talib.ATR(h, l, c, timeperiod=length)
    hl2 = (h + l) / 2
    basic_upper = hl2 + multiplier * atr
    basic_lower = hl2 - multiplier * atr

    final_upper = np.full(n, np.nan)
    final_lower = np.full(n, np.nan)
    direction = np.zeros(n)
    value = np.full(n, np.nan)

    valid = np.flatnonzero(~np.isnan(atr))
    if valid.size == 0:
        return pd.Series(value, index=close.index), pd.Series(direction, index=close.index)
    start = int(valid[0])

    final_upper[start] = basic_upper[start]
    final_lower[start] = basic_lower[start]
    direction[start] = 1
    value[start] = final_lower[start]

    for i in range(start + 1, n):
        final_upper[i] = min(basic_upper[i], final_upper[i - 1]) if c[i - 1] <= final_upper[i - 1] else basic_upper[i]
        final_lower[i] = max(basic_lower[i], final_lower[i - 1]) if c[i - 1] >= final_lower[i - 1] else basic_lower[i]

        if c[i] > final_upper[i - 1]:
            direction[i] = 1
        elif c[i] < final_lower[i - 1]:
            direction[i] = -1
        else:
            direction[i] = direction[i - 1]

        value[i] = final_lower[i] if direction[i] == 1 else final_upper[i]

    return pd.Series(value, index=close.index), pd.Series(direction, index=close.index)


def _serialize_series(time_col: pd.Series, values: pd.Series) -> list[dict]:
    return [{"time": t.isoformat(), "value": float(v)} for t, v in zip(time_col, values) if pd.notna(v)]


def _compute_overlays(candles_df: pd.DataFrame, warm_df: pd.DataFrame, today_date: object, settings: dict) -> dict:
    """VWAP resets every session by definition, so it's computed on `candles_df` (today only —
    no change from before). EMA/Supertrend are computed on `warm_df` (today + the prior trading
    day, same chart interval) so they have real history behind them, then sliced back down to
    just today's rows before returning — the frontend still only ever sees today's chart.
    `settings` carries the user-configurable periods/length/multiplier (see main()'s CLI args).

    Supertrend is returned as ONE series carrying both `value` and `direction` per bar (not
    split into up/down halves) — lightweight-charts' LineSeries does not actually break the
    line at a "whitespace" (value-omitted) point despite that being its documented purpose; it
    silently skips whitespace rows and draws a straight line connecting whatever real points
    remain, which turned every trend flip into a spurious diagonal cutting across the chart
    (confirmed by direct reproduction against lightweight-charts 5.2.0). The frontend instead
    splits this single series into one LineSeries per contiguous same-direction run — genuinely
    separate series can't be bridged by the renderer the way whitespace points were."""
    vwap = _vwap(candles_df)

    ema20_full = warm_df["close"].ewm(span=settings["ema_fast"], adjust=False).mean()
    ema50_full = warm_df["close"].ewm(span=settings["ema_slow"], adjust=False).mean()
    st_value_full, st_dir_full = _supertrend(
        warm_df["high"], warm_df["low"], warm_df["close"],
        length=settings["st_length"], multiplier=settings["st_multiplier"],
    )

    today_mask = warm_df["time"].dt.date == today_date
    today_time = warm_df.loc[today_mask, "time"]
    st_value_today = st_value_full[today_mask]
    st_dir_today = st_dir_full[today_mask]

    return {
        "vwap": _serialize_series(candles_df["time"], vwap),
        "ema20": _serialize_series(today_time, ema20_full[today_mask]),
        "ema50": _serialize_series(today_time, ema50_full[today_mask]),
        "supertrend": [
            {"time": t.isoformat(), "value": float(v), "direction": int(d)}
            for t, v, d in zip(today_time, st_value_today, st_dir_today)
            if pd.notna(v) and d != 0
        ],
    }


# --- Previous Day High/Low/Close. helper.get_prev_day_levels() already handles equities and
# indices (SENSEX included), but has no futures branch — CRUDEOIL/CRUDEOILM need their own daily
# history fetch off the same security already resolved in fetch(). ---


def _prev_day_levels_mcx(helper: DhanHelper, security_id: int, exchange_segment: str, instrument_type: str) -> dict | None:
    today = datetime.now(IST).date()
    hist = helper.get_historical_daily_data(
        security_id=security_id,
        exchange_segment=exchange_segment,
        instrument_type=instrument_type,
        from_date=(today - timedelta(days=10)).strftime("%Y-%m-%d"),
        to_date=today.strftime("%Y-%m-%d"),
    )
    if hist.empty or "timestamp" not in hist.columns:
        return None
    hist = hist.copy()
    hist["date"] = pd.to_datetime(hist["timestamp"], unit="s", utc=True).dt.tz_convert(IST).dt.date
    prior = hist[hist["date"] < today].sort_values("date")
    if prior.empty:
        return None
    last = prior.iloc[-1]
    return {"high": float(last["high"]), "low": float(last["low"]), "close": float(last["close"])}


def _prev_day_levels(helper: DhanHelper, symbol_type: str, symbol: str, security_id: int, exchange_segment: str, instrument_type: str) -> dict | None:
    if symbol_type in ("equity", "index"):
        return helper.get_prev_day_levels(symbol)
    return _prev_day_levels_mcx(helper, security_id, exchange_segment, instrument_type)


def fetch(symbol_type: str, symbol: str, chart_interval: int, level_interval: int, indicator_settings: dict) -> dict:
    dhan = get_dhan_client()
    if not dhan:
        raise ValueError("auth_failed — run login.py to refresh the access token")

    # Spawned fresh per poll (~15s cadence from the API route) — skip the session-validation
    # health check and use the cached master-list parquet sidecar, same trade-off
    # options_chart_fetch.py makes for the same reason.
    helper = DhanHelper(dhan, skip_session_validation=True, master_list_cache=True)

    security_id, exchange_segment, instrument_type = _resolve(helper, symbol_type, symbol)
    df, today_date = _fetch_recent_1min(helper, security_id, exchange_segment, instrument_type, symbol_type)

    if df.empty or today_date is None:
        error = None
        if helper.last_api_error:
            error = helper.last_api_error.get("message") or str(helper.last_api_error)
        raise ValueError(error or f"No intraday data available yet for {symbol}.")

    today_df = df[df["time"].dt.date == today_date].reset_index(drop=True)
    if today_df.empty:
        raise ValueError(f"No intraday data available yet for {symbol}.")

    now_ist = datetime.now(IST)
    candles_df = _resample_candles(today_df, chart_interval)
    levels_df = _resample_levels(today_df, level_interval, now_ist)
    warm_df = _resample_candles(df, chart_interval)

    try:
        prev_day_levels = _prev_day_levels(helper, symbol_type, symbol, security_id, exchange_segment, instrument_type)
    except Exception:
        # PDH/PDL/PDC is a nice-to-have overlay, not core chart data — a daily-history hiccup
        # here shouldn't fail the whole candle fetch.
        prev_day_levels = None

    return {
        "dataDate": str(today_date),
        "candles": [
            {"time": t.isoformat(), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
            for t, o, h, l, c in zip(candles_df["time"], candles_df["open"], candles_df["high"], candles_df["low"], candles_df["close"])
        ],
        "levelBuckets": [
            {"start": s.isoformat(), "end": e.isoformat(), "high": float(h), "low": float(l), "mid": float(m), "closed": bool(closed)}
            for s, e, h, l, m, closed in zip(levels_df["time"], levels_df["end"], levels_df["high"], levels_df["low"], levels_df["mid"], levels_df["closed"])
        ],
        "indicators": _compute_overlays(candles_df, warm_df, today_date, indicator_settings),
        "prevDayLevels": prev_day_levels,
    }


# Bounds for the user-configurable indicator settings — generous enough for any reasonable
# tuning, tight enough that a stray huge value can't make _supertrend's warm-up loop or the ewm
# span pathological.
EMA_PERIOD_RANGE = (2, 200)
ST_LENGTH_RANGE = (2, 50)
ST_MULTIPLIER_RANGE = (0.5, 10.0)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol-type", required=True, choices=SYMBOL_TYPES)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--chart-interval", required=True, type=int, choices=[int(v) for v in VALID_INTERVALS])
    parser.add_argument("--level-interval", required=True, type=int, choices=[int(v) for v in VALID_INTERVALS])
    parser.add_argument("--ema-fast", type=int, default=20)
    parser.add_argument("--ema-slow", type=int, default=50)
    parser.add_argument("--st-length", type=int, default=10)
    parser.add_argument("--st-multiplier", type=float, default=3.0)
    args = parser.parse_args()

    if args.level_interval < args.chart_interval:
        _err("level-interval must be >= chart-interval")

    indicator_settings = {
        "ema_fast": int(_clamp(args.ema_fast, *EMA_PERIOD_RANGE)),
        "ema_slow": int(_clamp(args.ema_slow, *EMA_PERIOD_RANGE)),
        "st_length": int(_clamp(args.st_length, *ST_LENGTH_RANGE)),
        "st_multiplier": _clamp(args.st_multiplier, *ST_MULTIPLIER_RANGE),
    }

    try:
        _print_json(fetch(args.symbol_type, args.symbol, args.chart_interval, args.level_interval, indicator_settings))
    except ValueError as exc:
        _err(str(exc))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
