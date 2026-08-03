"""One-off helper for the Next.js "live options charts" feature (straddle / rolling straddle /
strangle / custom strategy) to fetch combined CE+PE premium candles via Python.

Ported from C:\\dhanHQ_skills\\dashboard\\backend\\app\\services\\{straddle,rolling_straddle,
strangle,strategy}_data.py, adapted to call this project's lib/dhan_helper.py (DhanHelper)
instead of the skill's standalone dhan_helpers.py functions, and to print one JSON line to
stdout per call (matching scripts/tools/options_data_fetch.py's dispatcher convention) instead
of running as a persistent FastAPI service.

Usage:
    python options_chart_fetch.py expiries         --underlying NIFTY
    python options_chart_fetch.py strikes           --underlying NIFTY --expiry 2026-06-25
    python options_chart_fetch.py straddle          --underlying NIFTY --expiry 2026-06-25 --strike 25000 --interval 1 --days 2
    python options_chart_fetch.py rolling-straddle  --underlying NIFTY --expiry 2026-06-25 --interval 1 --days 2
    python options_chart_fetch.py strangle          --underlying NIFTY --expiry 2026-06-25 --ce-strike 25200 --pe-strike 24800 --ce-lots 1 --pe-lots 1
    python options_chart_fetch.py strategy          --underlying NIFTY --expiry 2026-06-25 --legs '[{"option_type":"CE","action":"SELL","strike":25200,"lots":1},{"option_type":"PE","action":"SELL","strike":24800,"lots":1}]'

Prints a single JSON line to stdout. Logs go to stderr.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = ZoneInfo("Asia/Kolkata")

# Same underlyings options_data_fetch.py already supports for the options-chain views.
UNDERLYING_IDS = {"NIFTY": 13, "BANKNIFTY": 25, "FINNIFTY": 27, "SENSEX": 51}
INDEX_SEGMENT = {"NIFTY": "IDX_I", "BANKNIFTY": "IDX_I", "FINNIFTY": "IDX_I", "SENSEX": "BSE_IDX"}
INDEX_EXCHANGE = {"NIFTY": "NSE", "BANKNIFTY": "NSE", "FINNIFTY": "NSE", "SENSEX": "BSE"}
OPTION_SEGMENT = {"NIFTY": "NSE_FNO", "BANKNIFTY": "NSE_FNO", "FINNIFTY": "NSE_FNO", "SENSEX": "BSE_FNO"}

MIN_LOTS = 1
MAX_LOTS = 10
MAX_LEGS = 6
VALID_INTERVALS = ("1", "2", "3", "5")

DEFAULT_INDICATORS = [
    {"type": "ema", "params": {"period": 20}},
    {"type": "vwap", "params": {}},
]

_option_chain_cache: dict[str, dict] = {}
_CHAIN_CACHE_TTL_SECONDS = 5.0


def _err(message: str):
    print(json.dumps({"error": message}))
    sys.exit(0)


def _resolve_underlying(helper: DhanHelper, underlying: str) -> dict:
    """Returns {security_id, exchange_segment, instrument_type} for the underlying's OWN
    intraday spot series (not the option legs)."""
    under = underlying.upper()
    if under in UNDERLYING_IDS:
        return {
            "security_id": UNDERLYING_IDS[under],
            "exchange_segment": INDEX_SEGMENT[under],
            "instrument_type": "INDEX",
        }
    eq = helper.find_equity(under)
    if not eq:
        raise ValueError(f"unknown underlying: {underlying}")
    return {"security_id": int(eq["SECURITY_ID"]), "exchange_segment": "NSE_EQ", "instrument_type": "EQUITY"}


def _option_leg_segment(underlying: str) -> tuple[str, str]:
    """Returns (exchange_segment, instrument_type) for CE/PE legs of `underlying`."""
    under = underlying.upper()
    if under in OPTION_SEGMENT:
        return OPTION_SEGMENT[under], "OPTIDX"
    return "NSE_FNO", "OPTSTK"


# --- Option chain (cached per underlying+expiry, mirrors straddle_data.get_chain_df) ---


def get_chain_df(helper: DhanHelper, underlying: str, expiry: str) -> tuple[pd.DataFrame, float]:
    cache_key = f"{underlying.upper()}|{expiry}"
    cached = _option_chain_cache.get(cache_key)
    if cached is not None and (time.time() - cached["fetched_at"]) < _CHAIN_CACHE_TTL_SECONDS:
        return cached["df"], cached["spot"]

    df = None
    for backoff in (0, 3.5, 5.0):
        if backoff:
            time.sleep(backoff)
        df = helper.get_option_chain_df(underlying, expiry)
        if not df.empty:
            break

    if df is None or df.empty:
        if cached is not None:
            return cached["df"], cached["spot"]
        return pd.DataFrame(), 0.0

    spot = float(df.attrs.get("underlying_ltp", 0) or 0.0)
    _option_chain_cache[cache_key] = {"df": df, "spot": spot, "fetched_at": time.time()}
    return df, spot


def list_strikes(helper: DhanHelper, underlying: str, expiry: str) -> dict:
    df, spot = get_chain_df(helper, underlying, expiry)
    if df.empty or "ce_security_id" not in df.columns or "pe_security_id" not in df.columns:
        return {"spot": spot, "strikes": []}

    strikes_idx = df.index.to_series().astype(float)
    atm_strike = float(strikes_idx.iloc[(strikes_idx - spot).abs().argsort().iloc[0]]) if spot else None
    strikes = [
        {
            "strike": float(strike),
            # Dhan's chain response carries these as numeric (float64 via pandas) - Dhan's
            # intraday API rejects a "65891.0"-shaped security_id with DH-905, so normalize
            # to a plain int string here once rather than at every call site.
            "ce_security_id": str(int(row["ce_security_id"])),
            "pe_security_id": str(int(row["pe_security_id"])),
            "is_atm": atm_strike is not None and float(strike) == atm_strike,
        }
        for strike, row in df.iterrows()
        if row.get("ce_security_id") and row.get("pe_security_id")
    ]
    return {"spot": spot, "strikes": strikes}


def _calendar_days_for(days: int) -> int:
    return max(days * 2 + 5, 7)


# --- Intraday fetch (paced by DhanHelper's own 429 backoff — no extra pacing needed here) ---


_last_intraday_call = 0.0


def _fetch_intraday(helper: DhanHelper, security_id, exchange_segment: str, instrument_type: str, to_dt: datetime, calendar_days: int) -> pd.DataFrame:
    # Dhan's intraday_minute_data rejects a same-day-only or time-qualified range with
    # DH-905 ("bad values for parameters") — it wants plain YYYY-MM-DD dates spanning at
    # least two calendar days (see nifty_vwap_1min_straddle.py's _fetch_option_candles).
    from_dt = to_dt - timedelta(days=max(calendar_days, 2))

    # A rolling-straddle/strategy chart fetches one leg per unique strike touched (plus the
    # spot series) in a tight loop. Empirically probed against the live account (see
    # conversation history): 12-14 sequential intraday_minute_data calls at 0.3-0.5s apart
    # complete with zero DH-904s, while <0.1s apart reliably trips it after ~5 calls. 0.35s
    # keeps a safety margin over the observed floor without the ~3x latency hit an earlier,
    # over-cautious 1.2s gate cost every leg fetch.
    global _last_intraday_call
    elapsed = time.time() - _last_intraday_call
    if elapsed < 0.35:
        time.sleep(0.35 - elapsed)
    _last_intraday_call = time.time()

    df = helper.get_intraday_minute_data(
        security_id=security_id,
        exchange_segment=exchange_segment,
        instrument_type=instrument_type,
        interval="1",
        from_date=from_dt.strftime("%Y-%m-%d"),
        to_date=to_dt.strftime("%Y-%m-%d"),
    )
    if df.empty and helper.last_api_error and "904" in str(helper.last_api_error.get("code", "")) + str(helper.last_api_error.get("message", "")):
        time.sleep(1.0)
        _last_intraday_call = time.time()
        df = helper.get_intraday_minute_data(
            security_id=security_id,
            exchange_segment=exchange_segment,
            instrument_type=instrument_type,
            interval="1",
            from_date=from_dt.strftime("%Y-%m-%d"),
            to_date=to_dt.strftime("%Y-%m-%d"),
        )
    if df.empty or "timestamp" not in df.columns:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
    out = pd.DataFrame(
        {
            # df["timestamp"] is a Series (not a plain list), so to_datetime(...) returns a
            # Series whose own .tz_convert() would act on ITS index, not its values - use the
            # .dt accessor to convert the datetime *values* to IST instead.
            "time": pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST),
            "open": df["open"],
            "high": df["high"],
            "low": df["low"],
            "close": df["close"],
            "volume": df["volume"],
        }
    )
    return out.sort_values("time").reset_index(drop=True)


def _spot_series(helper: DhanHelper, underlying: str, to_dt: datetime, interval: str, days: int) -> list[dict]:
    resolved = _resolve_underlying(helper, underlying)
    spot_df = _fetch_intraday(helper, resolved["security_id"], resolved["exchange_segment"], resolved["instrument_type"], to_dt, _calendar_days_for(days))
    if spot_df.empty:
        return []
    trading_dates = sorted(spot_df["time"].dt.date.unique())
    keep_dates = set(trading_dates[-days:])
    spot_df = spot_df[spot_df["time"].dt.date.isin(keep_dates)][["time", "close"]]
    if spot_df.empty:
        return []

    if interval != "1":
        spot_df = (
            spot_df.set_index("time")["close"]
            .resample(f"{interval}min", origin="start", label="left", closed="left")
            .last()
            .dropna()
            .reset_index()
        )
    return [{"time": t.isoformat(), "value": float(v)} for t, v in zip(spot_df["time"], spot_df["close"])]


# --- Combined-leg OHLC merge (ported verbatim from straddle_data.combine_legs_ohlc — pure
# pandas, no Dhan dependency; see that module's docstring for why high/low are NOT a naive
# sum-of-independent-extremes) ---


def combine_legs_ohlc(leg_dfs: list[tuple[pd.DataFrame, float, str]]) -> pd.DataFrame:
    merged = None
    for i, (df, _weight, _otype) in enumerate(leg_dfs):
        renamed = df.rename(columns={c: f"{c}_{i}" for c in ("open", "high", "low", "close", "volume")})
        merged = renamed if merged is None else pd.merge(merged, renamed, on="time")
    if merged is None or merged.empty:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    open_ = sum(merged[f"open_{i}"] * w for i, (_, w, _o) in enumerate(leg_dfs))
    close_ = sum(merged[f"close_{i}"] * w for i, (_, w, _o) in enumerate(leg_dfs))
    scenario_up = sum(merged[f"high_{i}" if otype == "CE" else f"low_{i}"] * w for i, (_, w, otype) in enumerate(leg_dfs))
    scenario_down = sum(merged[f"low_{i}" if otype == "CE" else f"high_{i}"] * w for i, (_, w, otype) in enumerate(leg_dfs))
    bounds = pd.concat([scenario_up, scenario_down, open_, close_], axis=1)
    high_ = bounds.max(axis=1)
    low_ = bounds.min(axis=1)
    volume_ = sum(merged[f"volume_{i}"] * abs(w) for i, (_, w, _o) in enumerate(leg_dfs))

    return pd.DataFrame({"time": merged["time"], "open": open_, "high": high_, "low": low_, "close": close_, "volume": volume_}).sort_values("time").reset_index(drop=True)


def _resample_ohlcv(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    parts = []
    for _, day_df in df.groupby(df["time"].dt.date):
        bucketed = (
            day_df.set_index("time")
            .resample(f"{minutes}min", origin="start", label="left", closed="left")
            .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
            .dropna(subset=["open"])
        )
        parts.append(bucketed.reset_index())
    return pd.concat(parts, ignore_index=True).sort_values("time").reset_index(drop=True)


def _resample_last(df: pd.DataFrame, minutes: int, columns: list[str]) -> pd.DataFrame:
    parts = []
    for _, day_df in df.groupby(df["time"].dt.date):
        bucketed = day_df.set_index("time")[columns].resample(f"{minutes}min", origin="start", label="left", closed="left").last()
        parts.append(bucketed.reset_index())
    return pd.concat(parts, ignore_index=True).sort_values("time").reset_index(drop=True)


# --- Indicators (EMA/SMA/BBands via pandas, VWAP session-anchored via pandas, Supertrend via
# pandas_ta — already a project dependency, see lib/dhan_helper.py's calculate_ta_indicators) ---


def _vwap(df: pd.DataFrame) -> pd.Series:
    typical = (df["high"] + df["low"] + df["close"]) / 3
    session = df["time"].dt.date
    cum_pv = (typical * df["volume"]).groupby(session).cumsum()
    cum_vol = df["volume"].groupby(session).cumsum()
    return cum_pv / cum_vol.replace(0, pd.NA)


def _supertrend(high: pd.Series, low: pd.Series, close: pd.Series, period: int, multiplier: float) -> pd.Series:
    import pandas_ta as ta

    st = ta.supertrend(high=high, low=low, close=close, length=period, multiplier=multiplier)
    if st is None or st.empty:
        return pd.Series(index=close.index, dtype=float)
    col = next((c for c in st.columns if c.startswith("SUPERT_") and not c.startswith(("SUPERTd_", "SUPERTl_", "SUPERTs_"))), None)
    return st[col] if col is not None else pd.Series(index=close.index, dtype=float)


def _compute_indicators(df: pd.DataFrame, requests: list[dict]) -> list[dict]:
    close, high, low = df["close"], df["high"], df["low"]
    out: list[dict] = []

    for req in requests:
        itype = req.get("type")
        params = req.get("params") or {}

        if itype == "ema":
            period = int(params.get("period", 20))
            series = close.ewm(span=period, adjust=False).mean()
            out.append({"id": f"ema_{period}", "group": f"ema_{period}", "type": "ema", "label": f"EMA {period}", "series": series})

        elif itype == "sma":
            period = int(params.get("period", 20))
            series = close.rolling(period).mean()
            out.append({"id": f"sma_{period}", "group": f"sma_{period}", "type": "sma", "label": f"SMA {period}", "series": series})

        elif itype == "vwap":
            series = _vwap(df)
            out.append({"id": "vwap", "group": "vwap", "type": "vwap", "label": "VWAP", "series": series})

        elif itype == "bbands":
            period = int(params.get("period", 20))
            std_dev = float(params.get("std_dev", 2.0))
            mid = close.rolling(period).mean()
            std = close.rolling(period).std(ddof=0)
            upper, lower = mid + std_dev * std, mid - std_dev * std
            group = f"bbands_{period}_{std_dev}"
            out.append({"id": f"{group}_upper", "group": group, "type": "bbands", "label": f"BB Upper ({period},{std_dev:g})", "series": upper})
            out.append({"id": f"{group}_mid", "group": group, "type": "bbands", "label": f"BB Mid ({period})", "series": mid})
            out.append({"id": f"{group}_lower", "group": group, "type": "bbands", "label": f"BB Lower ({period},{std_dev:g})", "series": lower})

        elif itype == "supertrend":
            period = int(params.get("period", 10))
            multiplier = float(params.get("multiplier", 3.0))
            series = _supertrend(high, low, close, period, multiplier)
            group = f"supertrend_{period}_{multiplier}"
            out.append({"id": group, "group": group, "type": "supertrend", "label": f"Supertrend ({period},{multiplier:g})", "series": series})

        else:
            raise ValueError(f"Unknown indicator type: {itype}")

    return out


def _serialize_indicators(df: pd.DataFrame, computed: list[dict]) -> list[dict]:
    return [
        {
            "id": ind["id"],
            "group": ind["group"],
            "type": ind["type"],
            "label": ind["label"],
            "series": [{"time": t.isoformat(), "value": float(v)} for t, v in zip(df["time"], ind["series"]) if pd.notna(v)],
            "last_value": (float(valid.iloc[-1]) if len(valid := ind["series"].dropna()) else None),
        }
        for ind in computed
    ]


# --- Straddle (single ATM/chosen strike, CE+PE combined) ---


def _fetch_leg_intraday(helper: DhanHelper, underlying: str, security_id, to_dt: datetime, calendar_days: int) -> pd.DataFrame:
    seg, itype = _option_leg_segment(underlying)
    return _fetch_intraday(helper, security_id, seg, itype, to_dt, calendar_days)


def get_straddle_chart(helper: DhanHelper, underlying: str, expiry: str, strike: float, interval: str = "1", indicators: list[dict] | None = None, days: int = 2, include_spot: bool = False) -> dict:
    strikes_info = list_strikes(helper, underlying, expiry)
    match = next((s for s in strikes_info["strikes"] if s["strike"] == strike), None)
    if match is None:
        raise ValueError(f"Strike {strike} not found for {underlying} expiry {expiry}.")

    to_dt = datetime.now(IST)
    calendar_days = _calendar_days_for(days)
    ce_df = _fetch_leg_intraday(helper, underlying, str(match["ce_security_id"]), to_dt, calendar_days)
    pe_df = _fetch_leg_intraday(helper, underlying, str(match["pe_security_id"]), to_dt, calendar_days)
    if ce_df.empty or pe_df.empty:
        raise ValueError(f"No intraday data available yet for {underlying} {strike} straddle ({expiry}).")

    trading_dates = sorted(set(ce_df["time"].dt.date.unique()) & set(pe_df["time"].dt.date.unique()))
    keep_dates = set(trading_dates[-days:])
    ce_df = ce_df[ce_df["time"].dt.date.isin(keep_dates)]
    pe_df = pe_df[pe_df["time"].dt.date.isin(keep_dates)]

    df = combine_legs_ohlc([(ce_df, 1.0, "CE"), (pe_df, 1.0, "PE")])
    legs = pd.merge(ce_df[["time", "close"]], pe_df[["time", "close"]], on="time", suffixes=("_ce", "_pe"))
    df = df.merge(legs.rename(columns={"close_ce": "ce", "close_pe": "pe"}), on="time", how="left")
    if df.empty:
        raise ValueError(f"No intraday data available yet for {underlying} {strike} straddle ({expiry}).")

    # Only fetched when the frontend's "Spot" overlay toggle is on - otherwise this would be an
    # extra intraday_minute_data call (the underlying's own series) on every poll for a line
    # nobody's displaying.
    spot_series = _spot_series(helper, underlying, to_dt, str(interval), days) if include_spot else []

    if interval != "1":
        resampled = _resample_ohlcv(df, int(interval))
        legs_r = _resample_last(df, int(interval), ["ce", "pe"])
        df = resampled.merge(legs_r, on="time", how="left")

    computed = _compute_indicators(df, indicators or DEFAULT_INDICATORS)

    return {
        "expiry": expiry,
        "strike": strike,
        "spot": strikes_info["spot"],
        "interval": str(interval),
        "spot_series": spot_series,
        "candles": [
            {
                "time": t.isoformat(), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v),
                "ce": None if pd.isna(ce) else float(ce), "pe": None if pd.isna(pe) else float(pe),
            }
            for t, o, h, l, c, v, ce, pe in zip(df["time"], df["open"], df["high"], df["low"], df["close"], df["volume"], df["ce"], df["pe"])
        ],
        "indicators": _serialize_indicators(df, computed),
        "coverage_note": f"{len(df)} x {interval}-min straddle bars across {df['time'].dt.date.nunique()} trading day(s) for {underlying} {strike} ({expiry}).",
    }


# --- Rolling straddle (re-anchors to whichever strike is ATM at each point in the session) ---


def _strike_step(strikes: list[float]) -> float:
    ordered = sorted(set(strikes))
    diffs = [b - a for a, b in zip(ordered, ordered[1:]) if b - a > 0]
    return min(diffs) if diffs else 50.0


def _nearest_strike(spot: float, strikes: list[float]) -> float:
    return min(strikes, key=lambda s: abs(s - spot))


def _strike_segments(spot_df: pd.DataFrame, keep_dates: set, strikes: list[float]) -> list[dict]:
    day_df = spot_df[spot_df["time"].dt.date.isin(keep_dates)]
    if day_df.empty or not strikes:
        return []

    segments: list[dict] = []
    current_strike = None
    current_start = None
    for _, row in day_df.iterrows():
        strike = _nearest_strike(float(row["close"]), strikes)
        if strike != current_strike:
            if current_strike is not None:
                segments.append({"strike": current_strike, "start": current_start, "end": row["time"]})
            current_strike = strike
            current_start = row["time"]
    if current_strike is not None:
        segments.append({"strike": current_strike, "start": current_start, "end": None})
    return segments


def get_rolling_straddle_chart(helper: DhanHelper, underlying: str, expiry: str, interval: str = "1", indicators: list[dict] | None = None, days: int = 2) -> dict:
    chain_df, spot = get_chain_df(helper, underlying, expiry)
    if chain_df.empty:
        raise ValueError(f"No option chain available yet for {underlying} expiry {expiry}.")

    strike_by_value = {
        float(strike): (str(int(row["ce_security_id"])), str(int(row["pe_security_id"])))
        for strike, row in chain_df.iterrows()
        if row.get("ce_security_id") and row.get("pe_security_id")
    }
    strikes = list(strike_by_value.keys())
    if not strikes:
        raise ValueError(f"No tradable strikes found for {underlying} expiry {expiry}.")

    to_dt = datetime.now(IST)
    calendar_days = _calendar_days_for(days)
    resolved = _resolve_underlying(helper, underlying)
    spot_df = _fetch_intraday(helper, resolved["security_id"], resolved["exchange_segment"], resolved["instrument_type"], to_dt, calendar_days)
    if spot_df.empty:
        raise ValueError(f"No intraday data available yet for {underlying} ({expiry}).")
    trading_dates = sorted(spot_df["time"].dt.date.unique())
    keep_dates = set(trading_dates[-days:])

    segments = _strike_segments(spot_df, keep_dates, strikes)
    if not segments:
        raise ValueError(f"No intraday data available yet for {underlying} ({expiry}).")

    combined_by_strike: dict[float, pd.DataFrame] = {}
    for strike in {seg["strike"] for seg in segments}:
        ce_id, pe_id = strike_by_value[strike]
        ce_df = _fetch_leg_intraday(helper, underlying, ce_id, to_dt, calendar_days)
        pe_df = _fetch_leg_intraday(helper, underlying, pe_id, to_dt, calendar_days)
        if ce_df.empty or pe_df.empty:
            continue
        ce_df = ce_df[ce_df["time"].dt.date.isin(keep_dates)]
        pe_df = pe_df[pe_df["time"].dt.date.isin(keep_dates)]
        merged = pd.merge(ce_df[["time", "close"]], pe_df[["time", "close"]], on="time", suffixes=("_ce", "_pe"))
        combined = combine_legs_ohlc([(ce_df, 1.0, "CE"), (pe_df, 1.0, "PE")])
        combined_by_strike[strike] = combined.merge(merged, on="time", how="left")

    rows: list[pd.DataFrame] = []
    switches: list[dict] = []
    prev_strike: float | None = None
    for seg in segments:
        strike = seg["strike"]
        combined = combined_by_strike.get(strike)
        if combined is None or combined.empty:
            continue
        mask = combined["time"] >= seg["start"]
        if seg["end"] is not None:
            mask &= combined["time"] < seg["end"]
        slice_df = combined[mask].copy()
        if slice_df.empty:
            continue
        slice_df["strike"] = strike
        rows.append(slice_df)

        first = slice_df.iloc[0]
        spot_at_switch = float(spot_df.loc[(spot_df["time"] - first["time"]).abs().idxmin(), "close"]) if not spot_df.empty else spot
        switches.append({
            "time": first["time"], "from_strike": prev_strike, "to_strike": strike,
            "straddle_price": float(first["close"]), "ce": float(first["close_ce"]), "pe": float(first["close_pe"]),
            "synthetic_fut": float(first["close_ce"] - first["close_pe"] + strike), "spot": spot_at_switch,
        })
        prev_strike = strike

    if not rows:
        raise ValueError(f"No intraday data available yet for {underlying} rolling straddle ({expiry}).")

    df = pd.concat(rows, ignore_index=True).sort_values("time").reset_index(drop=True)
    df["synthetic_fut"] = df["close_ce"] - df["close_pe"] + df["strike"]
    # spot_df carries full OHLCV (same shared _fetch_intraday as the legs) - only its
    # time/close are wanted here (as "spot"), else the other columns collide with df's own
    # open/high/low/volume and pandas silently suffixes both copies away (_x/_y).
    df = df.merge(spot_df[["time", "close"]].rename(columns={"close": "spot"}), on="time", how="left")
    df["spot"] = df["spot"].ffill().bfill()

    if interval != "1":
        first_bar_time = df["time"].min()
        step = timedelta(minutes=int(interval))
        for s in switches:
            offset = (s["time"] - first_bar_time) // step
            s["time"] = first_bar_time + offset * step

        base = _resample_ohlcv(df[["time", "open", "high", "low", "close", "volume"]], int(interval))
        extras = (
            df.set_index("time")[["strike", "close_ce", "close_pe", "synthetic_fut", "spot"]]
            .resample(f"{interval}min", origin="start", label="left", closed="left")
            .last()
            .reset_index()
        )
        df = base.merge(extras, on="time", how="left")

    computed = _compute_indicators(df, indicators or DEFAULT_INDICATORS)

    return {
        "expiry": expiry,
        "spot": spot,
        "interval": str(interval),
        "candles": [
            {
                "time": t.isoformat(), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v),
                "strike": float(strike), "ce": float(ce), "pe": float(pe), "spot": float(sp), "synthetic_fut": float(sf),
            }
            for t, o, h, l, c, v, strike, ce, pe, sp, sf in zip(
                df["time"], df["open"], df["high"], df["low"], df["close"], df["volume"],
                df["strike"], df["close_ce"], df["close_pe"], df["spot"], df["synthetic_fut"],
            )
        ],
        "switches": [
            {"time": s["time"].isoformat(), "from_strike": s["from_strike"], "to_strike": s["to_strike"], "straddle_price": s["straddle_price"], "ce": s["ce"], "pe": s["pe"], "synthetic_fut": s["synthetic_fut"], "spot": s["spot"]}
            for s in switches
        ],
        "indicators": _serialize_indicators(df, computed),
        "coverage_note": f"{len(df)} x {interval}-min rolling straddle bars across {df['time'].dt.date.nunique()} trading day(s) for {underlying} ({expiry}), {len(switches)} strike switch(es).",
    }


# --- Strangle (independent CE/PE strikes, each lot-weighted) ---


def _validate_lots(label: str, lots: int) -> None:
    if not (MIN_LOTS <= lots <= MAX_LOTS):
        raise ValueError(f"{label} must be between {MIN_LOTS} and {MAX_LOTS}.")


def get_strangle_chart(helper: DhanHelper, underlying: str, expiry: str, ce_strike: float, pe_strike: float, ce_lots: int = 1, pe_lots: int = 1, interval: str = "1", indicators: list[dict] | None = None, days: int = 2, include_spot: bool = False) -> dict:
    _validate_lots("ce_lots", ce_lots)
    _validate_lots("pe_lots", pe_lots)

    strikes_info = list_strikes(helper, underlying, expiry)
    ce_match = next((s for s in strikes_info["strikes"] if s["strike"] == ce_strike), None)
    if ce_match is None:
        raise ValueError(f"CE strike {ce_strike} not found for {underlying} expiry {expiry}.")
    pe_match = next((s for s in strikes_info["strikes"] if s["strike"] == pe_strike), None)
    if pe_match is None:
        raise ValueError(f"PE strike {pe_strike} not found for {underlying} expiry {expiry}.")

    to_dt = datetime.now(IST)
    calendar_days = _calendar_days_for(days)
    ce_df = _fetch_leg_intraday(helper, underlying, str(ce_match["ce_security_id"]), to_dt, calendar_days)
    pe_df = _fetch_leg_intraday(helper, underlying, str(pe_match["pe_security_id"]), to_dt, calendar_days)
    if ce_df.empty or pe_df.empty:
        raise ValueError(f"No intraday data available yet for {underlying} {ce_strike}CE x{ce_lots} + {pe_strike}PE x{pe_lots} strangle ({expiry}).")

    trading_dates = sorted(set(ce_df["time"].dt.date.unique()) & set(pe_df["time"].dt.date.unique()))
    keep_dates = set(trading_dates[-days:])
    ce_df = ce_df[ce_df["time"].dt.date.isin(keep_dates)]
    pe_df = pe_df[pe_df["time"].dt.date.isin(keep_dates)]
    df = combine_legs_ohlc([(ce_df, float(ce_lots), "CE"), (pe_df, float(pe_lots), "PE")])
    if df.empty:
        raise ValueError(f"No intraday data available yet for {underlying} {ce_strike}CE x{ce_lots} + {pe_strike}PE x{pe_lots} strangle ({expiry}).")

    spot_series = _spot_series(helper, underlying, to_dt, str(interval), days) if include_spot else []

    if interval != "1":
        df = _resample_ohlcv(df, int(interval))

    computed = _compute_indicators(df, indicators or DEFAULT_INDICATORS)

    return {
        "expiry": expiry, "ce_strike": ce_strike, "pe_strike": pe_strike, "ce_lots": ce_lots, "pe_lots": pe_lots,
        "spot": strikes_info["spot"], "interval": str(interval), "spot_series": spot_series,
        "candles": [
            {"time": t.isoformat(), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v)}
            for t, o, h, l, c, v in zip(df["time"], df["open"], df["high"], df["low"], df["close"], df["volume"])
        ],
        "indicators": _serialize_indicators(df, computed),
        "coverage_note": f"{len(df)} x {interval}-min strangle bars across {df['time'].dt.date.nunique()} trading day(s) for {underlying} {ce_strike}CE x{ce_lots} + {pe_strike}PE x{pe_lots} ({expiry}).",
    }


# --- Custom strategy (arbitrary N legs, each BUY/SELL + lot-weighted) ---


def _validate_leg(index: int, leg: dict) -> None:
    lots = leg.get("lots", 1)
    if not (MIN_LOTS <= lots <= MAX_LOTS):
        raise ValueError(f"Leg {index + 1} lots must be between {MIN_LOTS} and {MAX_LOTS}.")
    if leg.get("option_type") not in ("CE", "PE"):
        raise ValueError(f"Leg {index + 1} option_type must be CE or PE.")
    if leg.get("action") not in ("BUY", "SELL"):
        raise ValueError(f"Leg {index + 1} action must be BUY or SELL.")


def get_strategy_chart(helper: DhanHelper, underlying: str, expiry: str, legs: list[dict], interval: str = "1", indicators: list[dict] | None = None, days: int = 2, include_spot: bool = False) -> dict:
    if not (1 <= len(legs) <= MAX_LEGS):
        raise ValueError(f"legs must contain between 1 and {MAX_LEGS} entries.")
    for i, leg in enumerate(legs):
        _validate_leg(i, leg)

    strikes_info = list_strikes(helper, underlying, expiry)

    def resolve_security_id(strike: float, option_type: str) -> str:
        match = next((s for s in strikes_info["strikes"] if s["strike"] == strike), None)
        if match is None:
            raise ValueError(f"Strike {strike} not found for {underlying} expiry {expiry}.")
        return str(match["ce_security_id"] if option_type == "CE" else match["pe_security_id"])

    to_dt = datetime.now(IST)
    calendar_days = _calendar_days_for(days)

    leg_frames = []
    for leg in legs:
        security_id = resolve_security_id(leg["strike"], leg["option_type"])
        weight = leg.get("lots", 1) * (1 if leg["action"] == "BUY" else -1)
        df = _fetch_leg_intraday(helper, underlying, security_id, to_dt, calendar_days)
        if df.empty:
            raise ValueError(f"No intraday data available yet for this {underlying} strategy ({expiry}).")
        leg_frames.append((df, weight, leg["option_type"]))

    common_dates = set(leg_frames[0][0]["time"].dt.date.unique())
    for df, _weight, _otype in leg_frames[1:]:
        common_dates &= set(df["time"].dt.date.unique())
    trading_dates = sorted(common_dates)
    keep_dates = set(trading_dates[-days:])

    leg_dfs = [(df[df["time"].dt.date.isin(keep_dates)], weight, option_type) for df, weight, option_type in leg_frames]
    df = combine_legs_ohlc(leg_dfs)
    if df.empty:
        raise ValueError(f"No intraday data available yet for this {underlying} strategy ({expiry}).")

    spot_series = _spot_series(helper, underlying, to_dt, str(interval), days) if include_spot else []

    # A strategy netting to a credit at open reads as a negative combined premium under the raw
    # +1 BUY / -1 SELL weighting - flip the whole day's sign once (anchored to the first bar) so
    # it reads as "premium available" decaying toward zero, same as straddle/strangle (BUY-only).
    net_credit = bool(df["close"].iloc[0] < 0)
    if net_credit:
        df = df.copy()
        df["open"], df["close"] = -df["open"], -df["close"]
        df["high"], df["low"] = -df["low"], -df["high"]

    if interval != "1":
        df = _resample_ohlcv(df, int(interval))

    computed = _compute_indicators(df, indicators or DEFAULT_INDICATORS)

    return {
        "expiry": expiry, "legs": legs, "spot": strikes_info["spot"], "interval": str(interval), "net_credit": net_credit,
        "spot_series": spot_series,
        "candles": [
            {"time": t.isoformat(), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v)}
            for t, o, h, l, c, v in zip(df["time"], df["open"], df["high"], df["low"], df["close"], df["volume"])
        ],
        "indicators": _serialize_indicators(df, computed),
        "coverage_note": f"{len(df)} x {interval}-min bars across {df['time'].dt.date.nunique()} trading day(s) for a {len(legs)}-leg {underlying} strategy ({expiry}).",
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    p_exp = sub.add_parser("expiries")
    p_exp.add_argument("--underlying", default="NIFTY")

    p_strikes = sub.add_parser("strikes")
    p_strikes.add_argument("--underlying", default="NIFTY")
    p_strikes.add_argument("--expiry", required=True)

    p_straddle = sub.add_parser("straddle")
    p_straddle.add_argument("--underlying", default="NIFTY")
    p_straddle.add_argument("--expiry", required=True)
    p_straddle.add_argument("--strike", required=True, type=float)
    p_straddle.add_argument("--interval", default="1", choices=VALID_INTERVALS)
    p_straddle.add_argument("--days", default=2, type=int)
    p_straddle.add_argument("--indicators", default=None)
    p_straddle.add_argument("--include-spot", action="store_true")

    p_rolling = sub.add_parser("rolling-straddle")
    p_rolling.add_argument("--underlying", default="NIFTY")
    p_rolling.add_argument("--expiry", required=True)
    p_rolling.add_argument("--interval", default="1", choices=VALID_INTERVALS)
    p_rolling.add_argument("--days", default=2, type=int)
    p_rolling.add_argument("--indicators", default=None)

    p_strangle = sub.add_parser("strangle")
    p_strangle.add_argument("--underlying", default="NIFTY")
    p_strangle.add_argument("--expiry", required=True)
    p_strangle.add_argument("--ce-strike", required=True, type=float)
    p_strangle.add_argument("--pe-strike", required=True, type=float)
    p_strangle.add_argument("--ce-lots", default=1, type=int)
    p_strangle.add_argument("--pe-lots", default=1, type=int)
    p_strangle.add_argument("--interval", default="1", choices=VALID_INTERVALS)
    p_strangle.add_argument("--days", default=2, type=int)
    p_strangle.add_argument("--indicators", default=None)
    p_strangle.add_argument("--include-spot", action="store_true")

    p_strategy = sub.add_parser("strategy")
    p_strategy.add_argument("--underlying", default="NIFTY")
    p_strategy.add_argument("--expiry", required=True)
    p_strategy.add_argument("--legs", required=True)
    p_strategy.add_argument("--interval", default="1", choices=VALID_INTERVALS)
    p_strategy.add_argument("--days", default=2, type=int)
    p_strategy.add_argument("--indicators", default=None)
    p_strategy.add_argument("--include-spot", action="store_true")

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        _err("auth_failed — run login.py to refresh the access token")
    helper = DhanHelper(dhan)

    indicators = json.loads(args.indicators) if getattr(args, "indicators", None) else None

    try:
        if args.cmd == "expiries":
            expiries = helper.get_expiries(args.underlying)
            print(json.dumps({"expiries": expiries}))

        elif args.cmd == "strikes":
            result = list_strikes(helper, args.underlying, args.expiry)
            print(json.dumps({
                "spot": result["spot"],
                "strikes": [{"strike": s["strike"], "is_atm": s["is_atm"]} for s in result["strikes"]],
            }))

        elif args.cmd == "straddle":
            print(json.dumps(get_straddle_chart(helper, args.underlying, args.expiry, args.strike, args.interval, indicators, args.days, args.include_spot)))

        elif args.cmd == "rolling-straddle":
            print(json.dumps(get_rolling_straddle_chart(helper, args.underlying, args.expiry, args.interval, indicators, args.days)))

        elif args.cmd == "strangle":
            print(json.dumps(get_strangle_chart(helper, args.underlying, args.expiry, args.ce_strike, args.pe_strike, args.ce_lots, args.pe_lots, args.interval, indicators, args.days, args.include_spot)))

        elif args.cmd == "strategy":
            legs = json.loads(args.legs)
            print(json.dumps(get_strategy_chart(helper, args.underlying, args.expiry, legs, args.interval, indicators, args.days, args.include_spot)))

        else:
            _err("unknown command")
    except ValueError as exc:
        _err(str(exc))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
