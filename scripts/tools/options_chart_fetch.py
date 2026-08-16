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

--underlying also takes BANKNIFTY, FINNIFTY, SENSEX and CRUDEOIL (see UNDERLYINGS below):
    python options_chart_fetch.py expiries          --underlying SENSEX
    python options_chart_fetch.py straddle          --underlying CRUDEOIL --expiry 2026-08-17 --strike 7250 --interval 5 --days 1 --include-spot

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

# Per-underlying instrument resolution. Three things vary and they are NOT interchangeable:
#   chain_id / chain_seg  - what the option-chain and expiry-list APIs key on
#   leg_seg  / leg_inst   - the CE/PE contracts' own segment + instrument type
#   spot_*                - the underlying's own intraday series, drawn as the Spot overlay
#
# Two of these were wrong before and are probe-verified against the live API:
#   - SENSEX's option chain keys on security id 1, NOT the index's 51 (the same split NIFTY has
#     between 26000 and 13). Id 51 returns an empty expiry list and an empty chain, and passing
#     the bare symbol "SENSEX" resolves to 51 through the master list, so the id must be passed
#     explicitly. SENSEX index intraday is also served under IDX_I - BSE_IDX returns DH-905.
#   - CRUDEOIL legs are MCX_COMM/OPTFUT. The old NSE_FNO/OPTSTK fallback returned zero bars, so
#     every crude chart failed with "No intraday data available yet".
#
# CRUDEOIL has no spot index at all: both its chain id and its spot series come from the nearest
# non-expired FUTCOM contract, resolved at runtime (see _mcx_future).
UNDERLYINGS: dict[str, dict] = {
    "NIFTY":     {"chain_id": 13, "chain_seg": "IDX_I",   "leg_seg": "NSE_FNO", "leg_inst": "OPTIDX",
                  "spot_id": 13,  "spot_seg": "IDX_I",    "spot_inst": "INDEX",  "spot_label": "Spot"},
    "BANKNIFTY": {"chain_id": 25, "chain_seg": "IDX_I",   "leg_seg": "NSE_FNO", "leg_inst": "OPTIDX",
                  "spot_id": 25,  "spot_seg": "IDX_I",    "spot_inst": "INDEX",  "spot_label": "Spot"},
    "FINNIFTY":  {"chain_id": 27, "chain_seg": "IDX_I",   "leg_seg": "NSE_FNO", "leg_inst": "OPTIDX",
                  "spot_id": 27,  "spot_seg": "IDX_I",    "spot_inst": "INDEX",  "spot_label": "Spot"},
    "SENSEX":    {"chain_id": 1,  "chain_seg": "BSE_FNO", "leg_seg": "BSE_FNO", "leg_inst": "OPTIDX",
                  "spot_id": 51,  "spot_seg": "IDX_I",    "spot_inst": "INDEX",  "spot_label": "Spot"},
    "CRUDEOIL":  {"mcx": True,    "chain_seg": "MCX_COMM", "leg_seg": "MCX_COMM", "leg_inst": "OPTFUT",
                  "spot_seg": "MCX_COMM", "spot_inst": "FUTCOM", "spot_label": "Futures"},
}

MIN_LOTS = 1
MAX_LOTS = 10
MAX_LEGS = 6
MAX_DAYS = 10
VALID_INTERVALS = ("1", "2", "3", "5")

DEFAULT_INDICATORS = [
    {"type": "ema", "params": {"period": 20}},
    {"type": "vwap", "params": {}},
]

_option_chain_cache: dict[str, dict] = {}
_CHAIN_CACHE_TTL_SECONDS = 5.0


def _print_json(payload: dict) -> None:
    """allow_nan=False so a NaN/Inf that slipped through a resample-merge fails loudly here
    rather than printing a bare `NaN` token — that is invalid JSON, and the dashboard's
    runPythonJson() would blow up on JSON.parse with no clue where it came from."""
    print(json.dumps(payload, allow_nan=False))


def _err(message: str):
    print(json.dumps({"error": message}))
    sys.exit(0)


_mcx_future_cache: dict[str, dict] = {}


def _mcx_future(helper: DhanHelper, underlying: str) -> dict:
    """Nearest non-expired MCX futures contract for an MCX underlying — it stands in for both the
    chain id and the spot series, since commodities have no spot index.

    Same resolution options_data_fetch.py uses for the crude chain, so the charts and the
    options-chain page can never diverge after a contract rolls over. Cached per process only,
    and this process is spawned fresh per request, so a rollover is picked up on the next poll."""
    under = underlying.upper()
    cached = _mcx_future_cache.get(under)
    if cached is not None:
        return cached
    from scripts.tools.premarket_data import _find_nearest_future

    fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
    if not fut:
        raise ValueError(f"{under} futures contract not found")
    _mcx_future_cache[under] = fut
    return fut


def _chain_target(helper: DhanHelper, underlying: str) -> tuple[str, str | None]:
    """Returns (symbol, exchange_segment) to pass to get_option_chain_df(). Indices and MCX pass a
    numeric security id plus an explicit segment (their chain id differs from what the master-list
    symbol lookup would resolve); equities pass the bare symbol and let the helper auto-resolve."""
    under = underlying.upper()
    meta = UNDERLYINGS.get(under)
    if meta is None:
        return under, None
    if meta.get("mcx"):
        return str(int(_mcx_future(helper, under)["SECURITY_ID"])), meta["chain_seg"]
    return str(meta["chain_id"]), meta["chain_seg"]


def _resolve_underlying(helper: DhanHelper, underlying: str) -> dict:
    """Returns {security_id, exchange_segment, instrument_type} for the underlying's OWN
    intraday spot series (not the option legs)."""
    under = underlying.upper()
    meta = UNDERLYINGS.get(under)
    if meta is not None:
        security_id = int(_mcx_future(helper, under)["SECURITY_ID"]) if meta.get("mcx") else meta["spot_id"]
        return {
            "security_id": security_id,
            "exchange_segment": meta["spot_seg"],
            "instrument_type": meta["spot_inst"],
        }
    eq = helper.find_equity(under)
    if not eq:
        raise ValueError(f"unknown underlying: {underlying}")
    return {"security_id": int(eq["SECURITY_ID"]), "exchange_segment": "NSE_EQ", "instrument_type": "EQUITY"}


def _option_leg_segment(underlying: str) -> tuple[str, str]:
    """Returns (exchange_segment, instrument_type) for CE/PE legs of `underlying`."""
    meta = UNDERLYINGS.get(underlying.upper())
    if meta is not None:
        return meta["leg_seg"], meta["leg_inst"]
    return "NSE_FNO", "OPTSTK"


def _is_mcx(underlying: str) -> bool:
    return bool(UNDERLYINGS.get(underlying.upper(), {}).get("mcx"))


# --- Option chain (cached per underlying+expiry, mirrors straddle_data.get_chain_df) ---


def get_chain_df(helper: DhanHelper, underlying: str, expiry: str) -> tuple[pd.DataFrame, float]:
    cache_key = f"{underlying.upper()}|{expiry}"
    cached = _option_chain_cache.get(cache_key)
    if cached is not None and (time.time() - cached["fetched_at"]) < _CHAIN_CACHE_TTL_SECONDS:
        return cached["df"], cached["spot"]

    chain_symbol, chain_seg = _chain_target(helper, underlying)

    df = None
    for backoff in (0, 3.5, 5.0):
        if backoff:
            time.sleep(backoff)
        df = helper.get_option_chain_df(chain_symbol, expiry, exchange_segment=chain_seg)
        if not df.empty:
            break

    if df is None or df.empty:
        if cached is not None:
            return cached["df"], cached["spot"]
        return pd.DataFrame(), 0.0

    spot = float(df.attrs.get("underlying_ltp", 0) or 0.0)
    _option_chain_cache[cache_key] = {"df": df, "spot": spot, "fetched_at": time.time()}
    return df, spot


def _has_leg_ids(row) -> bool:
    """Both leg security ids present and usable. NOT `if row.get(...)` — a missing id arrives
    from pandas as float NaN, which is *truthy*, so a bare truth test lets it through and the
    downstream int(NaN) raises a cryptic 'cannot convert float NaN to integer' at the user."""
    for col in ("ce_security_id", "pe_security_id"):
        value = row.get(col)
        if value is None or pd.isna(value) or not value:
            return False
    return True


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
        if _has_leg_ids(row)
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
            # Floor to the minute: Dhan sometimes returns timestamps with a non-zero second
            # component (e.g. 13:31:30 vs 13:31:00) for the same 1-min bar depending on which
            # leg is fetched. Without flooring, the inner merge in combine_legs_ohlc drops any
            # bar where CE and PE have different second offsets, creating visible chart gaps.
            "time": pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST).dt.floor("min"),
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

    # A cleared period box in the frontend picker posts 0; pandas' ewm(span=0)/rolling(0) raise,
    # which surfaced as a bare "span must satisfy: span >= 1" error banner. Clamp instead.
    def _period(params: dict, default: int) -> int:
        try:
            return max(1, int(params.get("period", default)))
        except (TypeError, ValueError):
            return default

    for req in requests:
        itype = req.get("type")
        params = req.get("params") or {}

        if itype == "ema":
            period = _period(params, 20)
            series = close.ewm(span=period, adjust=False).mean()
            out.append({"id": f"ema_{period}", "group": f"ema_{period}", "type": "ema", "label": f"EMA {period}", "series": series})

        elif itype == "sma":
            period = _period(params, 20)
            series = close.rolling(period).mean()
            out.append({"id": f"sma_{period}", "group": f"sma_{period}", "type": "sma", "label": f"SMA {period}", "series": series})

        elif itype == "vwap":
            series = _vwap(df)
            out.append({"id": "vwap", "group": "vwap", "type": "vwap", "label": "VWAP", "series": series})

        elif itype == "bbands":
            period = _period(params, 20)
            std_dev = float(params.get("std_dev", 2.0) or 2.0)
            mid = close.rolling(period).mean()
            std = close.rolling(period).std(ddof=0)
            upper, lower = mid + std_dev * std, mid - std_dev * std
            group = f"bbands_{period}_{std_dev}"
            out.append({"id": f"{group}_upper", "group": group, "type": "bbands", "label": f"BB Upper ({period},{std_dev:g})", "series": upper})
            out.append({"id": f"{group}_mid", "group": group, "type": "bbands", "label": f"BB Mid ({period})", "series": mid})
            out.append({"id": f"{group}_lower", "group": group, "type": "bbands", "label": f"BB Lower ({period},{std_dev:g})", "series": lower})

        elif itype == "supertrend":
            period = _period(params, 10)
            multiplier = float(params.get("multiplier", 3.0) or 3.0)
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


def _nearest_strike(spot: float, strikes: list[float]) -> float:
    return min(strikes, key=lambda s: abs(s - spot))


def _strike_segments(spot_df: pd.DataFrame, keep_dates: set, strikes: list[float]) -> list[dict]:
    day_df = spot_df[spot_df["time"].dt.date.isin(keep_dates)]
    if day_df.empty or not strikes:
        return []

    sorted_strikes = sorted(strikes)
    diffs = [b - a for a, b in zip(sorted_strikes, sorted_strikes[1:]) if b > a]
    strike_step = min(diffs) if diffs else 50.0
    buffer = 0.25 * strike_step  # 25% hysteresis buffer beyond midpoint

    segments: list[dict] = []
    current_strike = None
    current_start = None
    current_last: pd.Timestamp | None = None
    current_date = None

    for _, row in day_df.iterrows():
        row_time = row["time"]
        row_date = row_time.date()
        spot_val = float(row["close"])

        # Re-anchor ATM at the start of each new trading session
        if current_strike is None or row_date != current_date:
            if current_strike is not None:
                segments.append({"strike": current_strike, "start": current_start, "end": current_last})
            current_strike = _nearest_strike(spot_val, sorted_strikes)
            current_start = row_time
            current_date = row_date
        else:
            # Only switch strike when spot decisively crosses beyond the midpoint + hysteresis buffer.
            # Without this buffer, whenever spot oscillates around the midpoint (e.g. 24325), the
            # strike flips back and forth every 1-2 minutes, creating chopped floating fragments.
            upper_trigger = current_strike + (strike_step / 2.0) + buffer
            lower_trigger = current_strike - (strike_step / 2.0) - buffer
            if spot_val >= upper_trigger or spot_val <= lower_trigger:
                new_strike = _nearest_strike(spot_val, sorted_strikes)
                if new_strike != current_strike:
                    segments.append({"strike": current_strike, "start": current_start, "end": current_last})
                    current_strike = new_strike
                    current_start = row_time

        current_last = row_time

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
        if _has_leg_ids(row)
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
            # Inclusive end: the last bar of this segment IS included.  `end` is now the
            # last timestamp owned by this segment (not the first of the next), so <= is
            # correct and won't double-count — the next segment's start > this end.
            mask &= combined["time"] <= seg["end"]
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
        step = timedelta(minutes=int(interval))
        # Both the candles and the switch markers must land on the SAME bucket grid that
        # _resample_ohlcv produces - and that anchors origin="start" *per trading day*. A single
        # global anchor (the whole frame's first bar) only coincides with it when every day
        # starts at the same clock time; one day whose first candle is 09:16 instead of 09:15
        # shifts the whole grid by a minute, and the left-merge below then leaves NaN in every
        # extras column for that day (which used to reach json.dumps as a bare NaN token).
        extra_cols = ["strike", "close_ce", "close_pe", "synthetic_fut", "spot"]
        base = _resample_ohlcv(df[["time", "open", "high", "low", "close", "volume"]], int(interval))
        extras = _resample_last(df, int(interval), extra_cols)

        first_bar_by_day = df.groupby(df["time"].dt.date)["time"].min().to_dict()
        for s in switches:
            anchor = first_bar_by_day.get(s["time"].date())
            if anchor is not None:
                s["time"] = anchor + ((s["time"] - anchor) // step) * step

        df = base.merge(extras, on="time", how="left")
        # Belt-and-braces: these are all last-value series, so a bucket the merge couldn't fill
        # carries forward rather than emitting a non-finite value.
        df[extra_cols] = df[extra_cols].ffill().bfill()

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
    # This process is spawned fresh per chart request (polled every ~10s), so it pays
    # DhanHelper's constructor costs on every poll rather than once at startup like a strategy:
    #  - skip_session_validation: drops the get_holdings() health check (~0.5s network round
    #    trip, irrelevant to chart data); a dead token still surfaces as a clear error on the
    #    first real data call below.
    #  - master_list_cache: reads master_list.csv via a parquet sidecar (~0.75s -> ~0.05s). The
    #    list itself is still needed - get_expiries()/get_option_chain() resolve their symbol
    #    through it - so this makes the load cheap rather than skipping it.
    # Both are opt-in and default off, so no strategy or other script is affected.
    helper = DhanHelper(dhan, skip_session_validation=True, master_list_cache=True)

    indicators = json.loads(args.indicators) if getattr(args, "indicators", None) else None
    # `days` drives the intraday lookback window (see _calendar_days_for) - clamp so a stray
    # ?days=9999 can't ask Dhan for a 20000-day range.
    days = min(MAX_DAYS, max(1, getattr(args, "days", 2) or 2))
    # MCX runs 09:00-23:30 (~870 one-minute bars a day vs NSE's 375), and a rolling straddle
    # fetches one leg pair per strike the underlying touches across the window. A multi-day crude
    # window means more sequential 0.35s-paced leg fetches than the API route's 60s timeout
    # allows, so cap it at a single session.
    if args.cmd == "rolling-straddle" and _is_mcx(args.underlying):
        days = 1

    try:
        if args.cmd == "expiries":
            # Explicit id + segment rather than helper.get_expiries(symbol): that resolves the
            # symbol through the master list, which lands on SENSEX's index id 51 (empty list) and
            # on an arbitrary CRUDEOIL futures row rather than the nearest non-expired one.
            under = args.underlying.upper()
            meta = UNDERLYINGS.get(under)
            if meta is None:
                expiries = helper.get_expiries(args.underlying)
            else:
                chain_symbol, chain_seg = _chain_target(helper, under)
                expiries = helper.get_expiry_list(
                    under_security_id=int(chain_symbol),
                    under_exchange_segment=chain_seg,
                )
            _print_json({"expiries": expiries})

        elif args.cmd == "strikes":
            result = list_strikes(helper, args.underlying, args.expiry)
            _print_json({
                "spot": result["spot"],
                "strikes": [{"strike": s["strike"], "is_atm": s["is_atm"]} for s in result["strikes"]],
            })

        elif args.cmd == "straddle":
            _print_json(get_straddle_chart(helper, args.underlying, args.expiry, args.strike, args.interval, indicators, days, args.include_spot))

        elif args.cmd == "rolling-straddle":
            _print_json(get_rolling_straddle_chart(helper, args.underlying, args.expiry, args.interval, indicators, days))

        elif args.cmd == "strangle":
            _print_json(get_strangle_chart(helper, args.underlying, args.expiry, args.ce_strike, args.pe_strike, args.ce_lots, args.pe_lots, args.interval, indicators, days, args.include_spot))

        elif args.cmd == "strategy":
            legs = json.loads(args.legs)
            _print_json(get_strategy_chart(helper, args.underlying, args.expiry, legs, args.interval, indicators, days, args.include_spot))

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
