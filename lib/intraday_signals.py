"""
Intraday equity signal engine — VWAP + trend confluence, gated by relative strength.

This module is PURE: no broker session, no network, no logging side effects. It is
imported by BOTH the backtest and the live strategy so the two cannot drift:

    scripts/analysis/backtest_intraday_vwap_rs.py   (replay)
    strategies/intraday_equity/nifty50_vwap_rs.py   (live)

This mirrors the lib/momentum.py <-> backtest_momentum_portfolio.py precedent. Every
other backtest under scripts/analysis/ is a copy-paste fork, and their hardcoded
NIFTY50 lists have already drifted apart. Do not reimplement any rule below in a
caller — extend it here.

THE NO-LOOKAHEAD CONTRACT
-------------------------
Backtest/live divergence is the failure mode that matters most, and it has exactly
one source: acting on data that was not yet knowable. Two rules, applied everywhere:

  1. 5-minute features are visible only AFTER their bar closes. build_features()
     shifts the 5-min frame by one bar before broadcasting it onto the 1-min index,
     so at 09:37 you see the 5-min bar that closed at 09:35 — which is df5.iloc[-2]
     in live terms.
  2. 1-minute features are read from the last CONFIRMED bar (iloc[-2] live). In the
     backtest, a signal detected on bar i fills at bar i+1's OPEN, never at bar i's
     close.

tests/test_intraday_signals.py enforces rule 1 mechanically via a prefix-invariance
test: build_features(df).iloc[:k] must equal build_features(df.iloc[:k]).

Price levels (stop, target) are the one exception — they are evaluated against the
live LTP, because a stop that only triggers on bar close is not a stop. Everything
else evaluates on confirmed bars. Same hybrid as crudeoilm_vwap_supertrend.py.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, time as dtime
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
import pandas as pd

# ── Paths ─────────────────────────────────────────────────────────────────────
_LIB_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(_LIB_DIR)
STORE_DIR = os.path.join(PROJECT_ROOT, "Intraday_Historical_Data", "1min")
MANIFEST_PATH = os.path.join(PROJECT_ROOT, "Intraday_Historical_Data", "manifest.json")
BENCHMARK_KEY = "NIFTY_50"

SESSION_START = dtime(9, 15)
SESSION_END = dtime(15, 29)

# Single source of truth for the universe. Must stay byte-identical with
# scripts/downloader/refresh_intraday_1min.py, scripts/tools/live_equity_ws.py
# and rs_dashboard/lib/nifty50.ts.
NIFTY50: List[str] = [
    'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
    'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BHARTIARTL', 'BPCL',
    'BRITANNIA', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY',
    'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK',
    'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
    'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'KOTAKBANK',
    'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC',
    'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN',
    'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL',
    'TCS', 'TECHM', 'TITAN', 'TMPV', 'ULTRACEMCO', 'WIPRO',
]

# Sector map for the correlation cap. Three long positions in HDFCBANK +
# ICICIBANK + AXISBANK is one bank-index bet at 3x size, not diversification.
SECTORS: Dict[str, str] = {
    'ADANIENT': 'INFRA', 'ADANIPORTS': 'INFRA', 'APOLLOHOSP': 'PHARMA',
    'ASIANPAINT': 'CONSUMER', 'AXISBANK': 'BANK', 'BAJAJ-AUTO': 'AUTO',
    'BAJFINANCE': 'NBFC', 'BAJAJFINSV': 'NBFC', 'BHARTIARTL': 'TELECOM',
    'BPCL': 'ENERGY', 'BRITANNIA': 'CONSUMER', 'CIPLA': 'PHARMA',
    'COALINDIA': 'ENERGY', 'DIVISLAB': 'PHARMA', 'DRREDDY': 'PHARMA',
    'EICHERMOT': 'AUTO', 'ETERNAL': 'CONSUMER', 'GRASIM': 'MATERIALS',
    'HCLTECH': 'IT', 'HDFCBANK': 'BANK', 'HDFCLIFE': 'INSURANCE',
    'HEROMOTOCO': 'AUTO', 'HINDALCO': 'METALS', 'HINDUNILVR': 'CONSUMER',
    'ICICIBANK': 'BANK', 'INDUSINDBK': 'BANK', 'INFY': 'IT', 'ITC': 'CONSUMER',
    'JIOFIN': 'NBFC', 'KOTAKBANK': 'BANK', 'LT': 'INFRA', 'M&M': 'AUTO',
    'MARUTI': 'AUTO', 'NESTLEIND': 'CONSUMER', 'NTPC': 'POWER',
    'ONGC': 'ENERGY', 'POWERGRID': 'POWER', 'RELIANCE': 'ENERGY',
    'SBILIFE': 'INSURANCE', 'SBIN': 'BANK', 'SHRIRAMFIN': 'NBFC',
    'SUNPHARMA': 'PHARMA', 'TATACONSUM': 'CONSUMER', 'TATASTEEL': 'METALS',
    'TCS': 'IT', 'TECHM': 'IT', 'TITAN': 'CONSUMER', 'TMPV': 'AUTO',
    'ULTRACEMCO': 'MATERIALS', 'WIPRO': 'IT',
}


def sector_of(symbol: str) -> str:
    return SECTORS.get(symbol, "OTHER")


# ── Config ────────────────────────────────────────────────────────────────────
@dataclass
class IntradayConfig:
    """Every tunable in one place, so the backtest and live strategy are
    configured through an identical surface."""

    # Session
    benchmark: str = BENCHMARK_KEY
    entry_start: str = "09:30"      # skip the opening-auction noise
    entry_cutoff: str = "14:45"     # no new entries after this
    square_off: str = "15:17"       # project-wide intraday convention

    # Timeframes (minutes). base_tf is the bar signals are evaluated on and that
    # VWAP/EMA/ATR are computed from; htf is the confirmation frame carrying
    # Supertrend and ADX. Both must divide into the session cleanly — see
    # resample_tf() for the 60-minute caveat.
    # Defaults are 5/30 rather than 1/5 on measured evidence (2026-08-09, 81
    # sessions): expectancy improves monotonically as the clock slows —
    # 1m/5m -0.282R (PF 0.47), 5m/15m -0.160R, 5m/30m -0.127R, 15m/60m -0.092R.
    # 1-minute bars were mostly noise. This is the least-bad known setting, NOT
    # a validated one — every timeframe still loses money.
    base_tf_min: int = 5
    htf_min: int = 30

    # Indicators
    ema_fast: int = 9
    ema_slow: int = 20
    st_period: int = 7              # Supertrend, on the htf frame
    st_multiplier: float = 2.0
    adx_period: int = 14            # on the htf frame
    adx_min: float = 20.0
    atr_period: int = 14            # on the base frame; drives stops and sizing

    # Relative strength gate
    rs_lookback_min: int = 30
    rs_min_day: float = 0.0         # since-open outperformance vs NIFTY
    rs_min_lb: float = 0.0010       # 10 bps outperformance over the lookback

    # Entry quality
    max_vwap_stretch_atr: float = 1.50  # don't chase: |close-vwap| <= this * ATR (widened from 0.60)
    min_vwap_edge_bps: float = 2.0      # require a real edge (2 bps / 0.02%), not noise (adjusted from 5.0)
    vol_surge_mult: float = 1.2         # 1-min volume vs its 20-bar mean

    # Selection
    max_positions: int = 3
    max_per_sector: int = 2
    min_score: float = 60.0
    allow_short: bool = False       # long-only until the rules are validated

    # Churn brakes. These live here rather than in the strategy so the backtest
    # models the same throttling the live bot enforces — otherwise the replay
    # takes trades the live bot would have refused and the two cannot reconcile.
    max_trades_per_day: int = 12
    max_symbol_trades: int = 2      # per symbol per day
    symbol_cooldown_s: int = 900    # no re-entry in a symbol just exited
    entry_spacing_s: int = 60       # don't open several positions on one impulse

    # Risk
    risk_per_trade: float = 2000.0
    atr_stop_mult: float = 1.5
    target_r: float = 2.0
    trail_arm_r: float = 1.0        # start ratcheting once +1R
    trail_atr_mult: float = 1.2
    max_order_value: float = 200_000.0
    max_deployed: float = 600_000.0
    # Off by default: this exit fired on 222 of 338 trades at -0.75R in the
    # original run. On intraday bars price crosses VWAP constantly, so it cut
    # winners before they worked. Disabling it lifted win rate 22.8% -> 37%.
    exit_on_vwap_loss: bool = False
    exit_on_rs_loss: bool = False

    # Costs (backtest only)
    slippage_bps: float = 3.0
    cost_per_order: float = 25.0

    def validate(self) -> None:
        for name in ("ema_fast", "ema_slow", "st_period", "adx_period", "atr_period",
                     "rs_lookback_min", "max_positions", "max_per_sector",
                     "max_trades_per_day", "max_symbol_trades"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be >= 1 (got {getattr(self, name)})")
        for name in ("symbol_cooldown_s", "entry_spacing_s"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be >= 0 (got {getattr(self, name)})")
        if self.ema_fast >= self.ema_slow:
            raise ValueError(f"ema_fast ({self.ema_fast}) must be < ema_slow ({self.ema_slow})")
        for name in ("base_tf_min", "htf_min"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be >= 1 (got {getattr(self, name)})")
        if self.htf_min < self.base_tf_min:
            raise ValueError(
                f"htf_min ({self.htf_min}) must be >= base_tf_min ({self.base_tf_min}) — "
                "the confirmation frame cannot be faster than the signal frame")
        if self.htf_min % self.base_tf_min:
            raise ValueError(
                f"htf_min ({self.htf_min}) must be a multiple of base_tf_min "
                f"({self.base_tf_min}), or the frames do not align on a common grid")
        if self.st_multiplier <= 0:
            raise ValueError("st_multiplier must be > 0")
        if self.risk_per_trade <= 0:
            raise ValueError("risk_per_trade must be > 0")
        if self.atr_stop_mult <= 0:
            raise ValueError("atr_stop_mult must be > 0")
        if self.target_r <= 0:
            raise ValueError("target_r must be > 0")
        if not 0 <= self.min_score <= 100:
            raise ValueError("min_score must be within 0..100")
        if self.max_order_value <= 0 or self.max_deployed <= 0:
            raise ValueError("max_order_value and max_deployed must be > 0")
        for name in ("entry_start", "entry_cutoff", "square_off"):
            parse_hhmm(getattr(self, name))  # raises on malformed input
        if not (self.entry_start < self.entry_cutoff <= self.square_off):
            raise ValueError(
                f"require entry_start < entry_cutoff <= square_off "
                f"(got {self.entry_start} / {self.entry_cutoff} / {self.square_off})"
            )

    def to_dict(self) -> dict:
        return asdict(self)


def parse_hhmm(value: str) -> dtime:
    try:
        hh, mm = str(value).split(":")
        return dtime(int(hh), int(mm))
    except Exception:
        raise ValueError(f"Invalid HH:MM time {value!r}")


# ── Indicators ────────────────────────────────────────────────────────────────
# All Wilder-smoothed to match pandas_ta, so the live strategy can cross-check
# against helper.get_indicators_ta(). tests/test_intraday_signals.py asserts parity.

def ema(s: pd.Series, length: int) -> pd.Series:
    """EMA seeded with an SMA of the first `length` values (TA-Lib convention).

    pandas_ta does this by default (presma=True), and a plain
    ewm(span=length, adjust=False) diverges from it by ~0.2 price points for
    hundreds of bars — enough to flip an ema_stack comparison near a crossover.
    Since the live strategy cross-checks against helper.get_indicators_ta(),
    the seeding has to match exactly.
    """
    out = s.astype("float64").copy()
    if len(out) < length:
        return pd.Series(np.nan, index=s.index, dtype="float64")
    out.iloc[:length - 1] = np.nan
    out.iloc[length - 1] = s.iloc[:length].mean()
    return out.ewm(span=length, adjust=False).mean()


def _rma(s: pd.Series, length: int, offset: int = 0) -> pd.Series:
    """Wilder's smoothing (RMA): SMA seed, then alpha = 1/length.

    `offset` shifts the seeding window forward, which is how TA-Lib handles a
    series whose first element is not meaningful. TA-Lib seeds ATR at index
    `length` from the mean of TR[1..length], skipping TR[0] (computed without a
    previous close) — offset=1 reproduces that bit-exactly.

    This matters because pandas_ta routes through TA-Lib when it is installed
    (it is here, 0.6.8), so seeding one bar earlier drifts ~1.5% through the
    warmup — enough to move a stop, and therefore a position size.
    """
    arr = s.to_numpy(dtype="float64")
    n = len(arr)
    out = np.full(n, np.nan)
    seed_end = offset + length
    if n < seed_end:
        return pd.Series(out, index=s.index)

    seed = np.nanmean(arr[offset:seed_end])
    out[seed_end - 1] = seed
    alpha = 1.0 / length
    prev = seed
    for i in range(seed_end, n):
        val = arr[i]
        if np.isnan(val):
            val = prev
        prev = prev + alpha * (val - prev)
        out[i] = prev
    return pd.Series(out, index=s.index)


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - prev_close).abs(),
        (df["Low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr


def atr(df: pd.DataFrame, length: int = 14) -> pd.Series:
    # offset=1: TR[0] has no previous close, so TA-Lib excludes it from the seed.
    return _rma(true_range(df), length, offset=1)


def adx(df: pd.DataFrame, length: int = 14) -> pd.DataFrame:
    """Wilder ADX with +DI/-DI. Returns columns ['adx', 'plus_di', 'minus_di']."""
    up = df["High"].diff()
    down = -df["Low"].diff()

    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)

    atr_s = _rma(true_range(df), length)
    # Guard against a zero-range window: a flat instrument otherwise yields
    # inf DI and an ADX that passes every trend filter.
    safe_atr = atr_s.replace(0.0, np.nan)

    plus_di = 100 * _rma(plus_dm, length) / safe_atr
    minus_di = 100 * _rma(minus_dm, length) / safe_atr

    denom = (plus_di + minus_di).replace(0.0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / denom
    adx_s = _rma(dx.fillna(0.0), length)

    return pd.DataFrame({"adx": adx_s, "plus_di": plus_di, "minus_di": minus_di},
                        index=df.index)


def supertrend(df: pd.DataFrame, period: int = 7, multiplier: float = 2.0) -> pd.DataFrame:
    """Supertrend matching pandas_ta's SUPERT_<p>_<m> / SUPERTd_<p>_<m>.

    Returns ['st_line', 'st_dir'] where st_dir is +1 (bullish) / -1 (bearish).
    """
    hl2 = (df["High"] + df["Low"]) / 2.0
    atr_s = atr(df, period)
    upper = hl2 + multiplier * atr_s
    lower = hl2 - multiplier * atr_s

    # .copy() is required: pandas 3.0 hands back read-only views, and the band
    # ratchet below writes into these arrays in place.
    close = df["Close"].to_numpy(dtype="float64").copy()
    up_arr = upper.to_numpy(dtype="float64").copy()
    lo_arr = lower.to_numpy(dtype="float64").copy()
    n = len(df)

    line = np.full(n, np.nan)
    direction = np.zeros(n, dtype="int64")

    # pandas_ta starts the trend at the first bar where ATR is defined.
    start = period
    if n <= start:
        return pd.DataFrame({"st_line": line, "st_dir": direction}, index=df.index)

    direction[start] = 1
    line[start] = lo_arr[start]

    for i in range(start + 1, n):
        # Bands only ratchet in the direction of the current trend.
        if close[i] > up_arr[i - 1]:
            direction[i] = 1
        elif close[i] < lo_arr[i - 1]:
            direction[i] = -1
        else:
            direction[i] = direction[i - 1]
            if direction[i] > 0 and lo_arr[i] < lo_arr[i - 1]:
                lo_arr[i] = lo_arr[i - 1]
            if direction[i] < 0 and up_arr[i] > up_arr[i - 1]:
                up_arr[i] = up_arr[i - 1]
        line[i] = lo_arr[i] if direction[i] > 0 else up_arr[i]

    return pd.DataFrame({"st_line": line, "st_dir": direction}, index=df.index)


def session_vwap(df: pd.DataFrame) -> pd.Series:
    """Session-anchored VWAP, reset at each calendar date.

    A cumulative VWAP that does not reset is a multi-day average and would make
    the primary entry gate meaningless on day 2 of any backtest.
    """
    tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
    vol = df["Volume"].astype("float64")
    day = df.index.normalize()

    cum_pv = (tp * vol).groupby(day).cumsum()
    cum_v = vol.groupby(day).cumsum()

    vwap = cum_pv / cum_v.replace(0.0, np.nan)
    # A fully zero-volume session (the index feed does this for stretches of
    # history) falls back to the running mean of typical price rather than NaN,
    # which would blank the gate for the whole day.
    fallback = tp.groupby(day).expanding().mean().reset_index(level=0, drop=True)
    return vwap.fillna(fallback)


# ── Resampling ────────────────────────────────────────────────────────────────
def resample_tf(df1m: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """1-min -> N-min on the NSE grid.

    origin='start_day' puts bucket edges at 09:15/09:20/... because 09:15 is 555
    minutes past midnight, and 555 is divisible by 5, 15 and 3. The default origin
    would bucket from midnight and produce a partial first bar, which quietly
    shifts every higher-timeframe feature.

    CAVEAT for 60-minute bars: 555 is NOT divisible by 60, so hourly buckets start
    at 09:00 and the session's first bar covers only 09:15-09:59. That is a real
    45-minute bar, not a data error, but it makes the first hourly bar of each day
    structurally different from the rest.
    """
    if minutes <= 1:
        return df1m
    out = df1m.resample(f"{minutes}min", label="left", closed="left", origin="start_day").agg({
        "Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum",
    })
    return out.dropna(subset=["Open"])


def resample_5m(df1m: pd.DataFrame) -> pd.DataFrame:
    """Back-compat alias — the 5-minute case of resample_tf."""
    return resample_tf(df1m, 5)


# ── Feature construction ──────────────────────────────────────────────────────
FEATURE_COLUMNS = [
    "Open", "High", "Low", "Close", "Volume",
    "vwap", "vwap_bps", "ema_fast", "ema_slow", "ema_stack",
    "atr", "vol_ratio",
    "st_line_htf", "st_dir_htf", "adx_htf",
    "bench_ret_day", "bench_ret_lb", "rs_day", "rs_lb",
]


def build_features(sym_1m: pd.DataFrame, bench_1m: Optional[pd.DataFrame],
                   cfg: IntradayConfig) -> pd.DataFrame:
    """One row per 1-min bar, vectorized over the whole history.

    The backtest calls this once per symbol; the live poller calls it per cycle
    on ~2 days of bars. Both therefore get bit-identical features.

    Every column here is knowable at that bar's close — see the module docstring.
    """
    if sym_1m is None or len(sym_1m) == 0:
        return pd.DataFrame(columns=FEATURE_COLUMNS)

    # Everything below works on the BASE frame. With base_tf_min=1 this is the
    # raw input; at 5/15 it is a resample, and the feature index (and therefore
    # the backtest's replay grid and the live iloc[-2] bar) follows it.
    df = resample_tf(sym_1m.sort_index(), cfg.base_tf_min).copy()
    if len(df) == 0:
        return pd.DataFrame(columns=FEATURE_COLUMNS)
    day = df.index.normalize()

    out = df[["Open", "High", "Low", "Close", "Volume"]].copy()

    out["vwap"] = session_vwap(df)
    out["vwap_bps"] = (df["Close"] - out["vwap"]) / out["vwap"].replace(0.0, np.nan) * 10_000.0

    out["ema_fast"] = ema(df["Close"], cfg.ema_fast)
    out["ema_slow"] = ema(df["Close"], cfg.ema_slow)
    out["ema_stack"] = np.sign(out["ema_fast"] - out["ema_slow"]).fillna(0).astype("int64")

    out["atr"] = atr(df, cfg.atr_period)

    # Volume participation vs the trailing bars of the SAME session, so the first
    # bars of a day are not compared against yesterday's close-of-day tape. The
    # window shrinks with the timeframe: 20 bars is 20 minutes at 1-min but 5
    # hours at 15-min, which would reach past the whole session.
    bars_per_session = max(1, 375 // max(1, cfg.base_tf_min))
    vol_win = max(3, min(20, bars_per_session // 5))
    vol_mean = (df["Volume"].groupby(day)
                .transform(lambda s: s.rolling(vol_win, min_periods=3).mean()))
    out["vol_ratio"] = df["Volume"] / vol_mean.replace(0.0, np.nan)

    # ── Higher-timeframe features, shifted then broadcast ────────────────────
    df5 = resample_tf(sym_1m, cfg.htf_min)
    if len(df5) > cfg.st_period + 1:
        st5 = supertrend(df5, cfg.st_period, cfg.st_multiplier)
        adx5 = adx(df5, cfg.adx_period)
        feat5 = pd.DataFrame({
            "st_line_htf": st5["st_line"],
            "st_dir_htf": st5["st_dir"],
            "adx_htf": adx5["adx"],
        }, index=df5.index)
        # THE shift. A 5-min bar stamped 09:35 covers 09:35-09:39 and is only
        # complete at 09:40, so its values must not be visible before then.
        # shift(1) moves them onto the NEXT bucket's label, and the ffill
        # reindex then holds them across that bucket's five 1-min bars.
        feat5 = feat5.shift(1)
        broadcast = feat5.reindex(out.index, method="ffill")
    else:
        broadcast = pd.DataFrame(index=out.index,
                                 columns=["st_line_htf", "st_dir_htf", "adx_htf"], dtype="float64")

    out["st_line_htf"] = broadcast["st_line_htf"]
    out["st_dir_htf"] = broadcast["st_dir_htf"].fillna(0)
    out["adx_htf"] = broadcast["adx_htf"]

    # ── Relative strength vs the benchmark ───────────────────────────────────
    # rs_lookback_min is wall-clock MINUTES, so it must become a bar count on the
    # base frame — otherwise a "30-minute" lookback silently becomes 30 bars, i.e.
    # 7.5 hours on a 15-minute frame.
    lb = max(1, int(cfg.rs_lookback_min) // max(1, cfg.base_tf_min))
    sym_open = df["Close"].groupby(day).transform("first")
    sym_ret_day = df["Close"] / sym_open - 1.0
    sym_ret_lb = df["Close"].groupby(day).transform(lambda s: s / s.shift(lb) - 1.0)

    if bench_1m is not None and len(bench_1m):
        b = bench_1m.sort_index()
        bclose = b["Close"].reindex(out.index, method="ffill")
        bday = bclose.index.normalize()
        bopen = bclose.groupby(bday).transform("first")
        bench_ret_day = bclose / bopen - 1.0
        bench_ret_lb = bclose.groupby(bday).transform(lambda s: s / s.shift(lb) - 1.0)
    else:
        bench_ret_day = pd.Series(0.0, index=out.index)
        bench_ret_lb = pd.Series(0.0, index=out.index)

    out["bench_ret_day"] = bench_ret_day
    out["bench_ret_lb"] = bench_ret_lb
    out["rs_day"] = sym_ret_day - bench_ret_day
    out["rs_lb"] = sym_ret_lb - bench_ret_lb

    return out[FEATURE_COLUMNS]


# ── Conditions / scoring ──────────────────────────────────────────────────────
CONDITION_NAMES = ("above_vwap", "ema_stacked", "st_bull_htf", "adx_ok",
                   "rs_day_ok", "rs_lb_ok", "not_stretched", "vol_ok")

# Hard gates must ALL pass for a candidate to be tradeable. The rest only move
# the score, so a name can rank highly without being perfect on every axis.
HARD_GATES = ("above_vwap", "st_bull_htf", "adx_ok", "rs_day_ok", "not_stretched")

# Score legs and their caps. The 0-100 total is a ranking heuristic, not a
# proven quality filter — see strategies/intraday_equity/strategy.md.
SCORE_CAPS: Dict[str, float] = {
    "rs": 30.0, "trend": 20.0, "vwap": 20.0,
    "supertrend": 15.0, "ema": 10.0, "volume": 5.0,
}


@dataclass(frozen=True)
class Conditions:
    above_vwap: bool = False
    ema_stacked: bool = False
    st_bull_htf: bool = False
    adx_ok: bool = False
    rs_day_ok: bool = False
    rs_lb_ok: bool = False
    not_stretched: bool = False
    vol_ok: bool = False

    def passed(self) -> int:
        return sum(getattr(self, n) for n in CONDITION_NAMES)

    def as_dict(self) -> Dict[str, bool]:
        return {n: bool(getattr(self, n)) for n in CONDITION_NAMES}

    def blocked_by(self) -> List[str]:
        return [n for n in HARD_GATES if not getattr(self, n)]


def _f(row: pd.Series, key: str, default: float = float("nan")) -> float:
    try:
        v = float(row[key])
    except (KeyError, TypeError, ValueError):
        return default
    return default if pd.isna(v) else v


def evaluate(row: pd.Series, cfg: IntradayConfig, side: str = "LONG") -> Conditions:
    """Evaluate all eight conditions for one symbol at one confirmed bar."""
    sign = 1.0 if side == "LONG" else -1.0

    close = _f(row, "Close")
    vwap_bps = _f(row, "vwap_bps")
    atr_v = _f(row, "atr")
    vwap = _f(row, "vwap")
    stack = _f(row, "ema_stack", 0.0)
    st_dir = _f(row, "st_dir_htf", 0.0)
    adx_v = _f(row, "adx_htf")
    rs_day = _f(row, "rs_day")
    rs_lb = _f(row, "rs_lb")
    vol_ratio = _f(row, "vol_ratio")

    # An unusable bar must produce all-False, never a lucky default — a NaN
    # comparison is False in Python, but relying on that is how a half-warmed
    # indicator ends up trading.
    if not np.isfinite(close) or not np.isfinite(vwap) or not np.isfinite(atr_v) or atr_v <= 0:
        return Conditions()

    stretch = abs(close - vwap) / atr_v

    return Conditions(
        above_vwap=np.isfinite(vwap_bps) and sign * vwap_bps >= cfg.min_vwap_edge_bps,
        ema_stacked=sign * stack > 0,
        st_bull_htf=sign * st_dir > 0,
        adx_ok=np.isfinite(adx_v) and adx_v >= cfg.adx_min,
        rs_day_ok=np.isfinite(rs_day) and sign * rs_day >= cfg.rs_min_day,
        rs_lb_ok=np.isfinite(rs_lb) and sign * rs_lb >= cfg.rs_min_lb,
        not_stretched=stretch <= cfg.max_vwap_stretch_atr,
        vol_ok=np.isfinite(vol_ratio) and vol_ratio >= cfg.vol_surge_mult,
    )


def is_gated(c: Conditions) -> bool:
    """True when every HARD gate passes, i.e. the name is tradeable."""
    return all(getattr(c, n) for n in HARD_GATES)


def _clamp01(x: float) -> float:
    if not np.isfinite(x):
        return 0.0
    return 0.0 if x < 0 else (1.0 if x > 1 else float(x))


def score(row: pd.Series, cfg: IntradayConfig, side: str = "LONG") -> float:
    """0-100, deterministic and decomposable so the terminal can show WHY a name
    ranks where it does. Weights: RS 30 / trend quality 20 / VWAP edge 20 /
    Supertrend headroom 15 / EMA stack 10 / participation 5."""
    return sum(score_breakdown(row, cfg, side).values())


def score_breakdown(row: pd.Series, cfg: IntradayConfig, side: str = "LONG") -> Dict[str, float]:
    sign = 1.0 if side == "LONG" else -1.0
    atr_v = _f(row, "atr")
    close = _f(row, "Close")
    st_line = _f(row, "st_line_htf")

    rs_lb = _f(row, "rs_lb", 0.0)
    adx_v = _f(row, "adx_htf", 0.0)
    vwap_bps = _f(row, "vwap_bps", 0.0)
    stack = _f(row, "ema_stack", 0.0)
    vol_ratio = _f(row, "vol_ratio", 0.0)

    rs_den = max(cfg.rs_min_lb * 3.0, 1e-9)
    headroom = (abs(close - st_line) / atr_v
                if np.isfinite(st_line) and np.isfinite(atr_v) and atr_v > 0 else 0.0)

    return {
        "rs":         SCORE_CAPS["rs"] * _clamp01(sign * rs_lb / rs_den),
        "trend":      SCORE_CAPS["trend"] * _clamp01((adx_v - cfg.adx_min) / 20.0),
        "vwap":       SCORE_CAPS["vwap"] * _clamp01(sign * vwap_bps / 40.0),
        "supertrend": SCORE_CAPS["supertrend"] * _clamp01(headroom / 2.0),
        "ema":        SCORE_CAPS["ema"] if sign * stack > 0 else 0.0,
        "volume":     SCORE_CAPS["volume"] * _clamp01(vol_ratio / 2.0),
    }


@dataclass
class Candidate:
    symbol: str
    side: str
    score: float
    price: float
    vwap: float
    atr: float
    conditions: Conditions
    gated: bool
    ts: Optional[pd.Timestamp] = None
    breakdown: Dict[str, float] = field(default_factory=dict)

    @property
    def sector(self) -> str:
        return sector_of(self.symbol)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "score": round(float(self.score), 1),
            "price": round(float(self.price), 2),
            "vwap": round(float(self.vwap), 2),
            "atr": round(float(self.atr), 3),
            "sector": self.sector,
            "gated": bool(self.gated),
            "conditions": self.conditions.as_dict(),
            "blocked_by": self.conditions.blocked_by(),
            "score_breakdown": {k: round(float(self.breakdown.get(k, 0.0)), 1) for k in SCORE_CAPS},
            "ts": self.ts.strftime("%Y-%m-%d %H:%M:%S") if self.ts is not None else None,
        }


def build_candidate(symbol: str, row, cfg: IntradayConfig,
                    side: str = "LONG", ts: Optional[pd.Timestamp] = None) -> Candidate:
    """`row` may be a pandas Series OR a plain dict of the same keys.

    The dict form exists because the backtest replays ~1.5M bar-symbol pairs and
    pandas scalar indexing dominates the runtime there; a dict lookup is ~50x
    faster and the field access below is identical for both.
    """
    cond = evaluate(row, cfg, side)
    bd = score_breakdown(row, cfg, side)
    if ts is None:
        name = getattr(row, "name", None)
        ts = name if isinstance(name, pd.Timestamp) else None
    return Candidate(
        symbol=symbol,
        side=side,
        score=sum(bd.values()),
        price=_f(row, "Close", 0.0),
        vwap=_f(row, "vwap", 0.0),
        atr=_f(row, "atr", 0.0),
        conditions=cond,
        gated=is_gated(cond),
        ts=ts,
        breakdown=bd,
    )


def rank_candidates(rows: Dict[str, object], cfg: IntradayConfig,
                    exclude: Optional[Set[str]] = None,
                    include_ungated: bool = False,
                    ts: Optional[pd.Timestamp] = None) -> List[Candidate]:
    """Gate -> score -> min_score -> sort desc.

    include_ungated=True returns every symbol regardless of gating, which is what
    the dashboard needs: showing WHY a name is not trading is the difference
    between a terminal and a black box. Trading callers leave it False.

    Ties break on symbol name so a rerun produces an identical ordering.
    """
    exclude = exclude or set()
    sides = ["LONG", "SHORT"] if cfg.allow_short else ["LONG"]

    out: List[Candidate] = []
    for sym, row in rows.items():
        if sym in exclude:
            continue
        best: Optional[Candidate] = None
        for side in sides:
            c = build_candidate(sym, row, cfg, side, ts=ts)
            if best is None or c.score > best.score:
                best = c
        if best is None:
            continue
        if include_ungated or (best.gated and best.score >= cfg.min_score):
            out.append(best)

    out.sort(key=lambda c: (-c.score, c.symbol))
    return out


def pick_watchlist(candidates: Sequence[Candidate], size: int) -> List[str]:
    """Prefer names that can actually trade, then near-misses, then fill by score.

    Live candle polling is budgeted: only the watchlist is refreshed between
    full-universe sweeps. Ranking the watchlist by ungated score lets a
    high-RS blocked name starve a gated one of updates. `candidates` is
    assumed already score-sorted (as `rank_candidates` returns).
    """
    if size < 1:
        return []
    gated: List[Candidate] = []
    near: List[Candidate] = []
    rest: List[Candidate] = []
    for c in candidates:
        n_block = len(c.conditions.blocked_by())
        if c.gated:
            gated.append(c)
        elif n_block == 1:
            near.append(c)
        else:
            rest.append(c)

    out: List[str] = []
    seen: Set[str] = set()
    for c in (*gated, *near, *rest):
        if c.symbol in seen:
            continue
        seen.add(c.symbol)
        out.append(c.symbol)
        if len(out) >= size:
            break
    return out


def select_new_entries(candidates: Sequence[Candidate], cfg: IntradayConfig,
                       open_positions: Sequence["Position"]) -> List[Candidate]:
    """Apply portfolio-level caps to a ranked list: max_positions and the sector
    cap. Correlation is the risk that max_positions alone does NOT control —
    three banks is one trade at 3x size."""
    slots = cfg.max_positions - len(open_positions)
    if slots <= 0:
        return []

    held = {p.symbol for p in open_positions}
    sector_counts: Dict[str, int] = {}
    for p in open_positions:
        s = sector_of(p.symbol)
        sector_counts[s] = sector_counts.get(s, 0) + 1

    chosen: List[Candidate] = []
    for c in candidates:
        if len(chosen) >= slots:
            break
        if c.symbol in held or not c.gated or c.score < cfg.min_score:
            continue
        sec = c.sector
        if sector_counts.get(sec, 0) >= cfg.max_per_sector:
            continue
        chosen.append(c)
        held.add(c.symbol)
        sector_counts[sec] = sector_counts.get(sec, 0) + 1
    return chosen


# ── Position, sizing, stops, exits ────────────────────────────────────────────
@dataclass
class Position:
    symbol: str
    side: str                       # "LONG" or "SHORT"
    qty: int
    entry_price: float
    stop: float
    target: float
    security_id: str = ""
    entry_ts: Optional[pd.Timestamp] = None
    high_water: float = 0.0         # best price seen in our favour
    entry_score: float = 0.0
    order_id: str = ""
    risk_per_share: float = 0.0

    def __post_init__(self):
        if not self.high_water:
            self.high_water = self.entry_price
        if not self.risk_per_share:
            self.risk_per_share = abs(self.entry_price - self.stop)

    @property
    def sign(self) -> int:
        return 1 if self.side == "LONG" else -1

    @property
    def sector(self) -> str:
        return sector_of(self.symbol)

    def unrealized(self, ltp: float) -> float:
        if not ltp or not np.isfinite(ltp):
            return 0.0
        return (ltp - self.entry_price) * self.sign * self.qty

    def r_multiple(self, ltp: float) -> float:
        if self.risk_per_share <= 0 or not ltp or not np.isfinite(ltp):
            return 0.0
        return (ltp - self.entry_price) * self.sign / self.risk_per_share

    def notional(self) -> float:
        return abs(self.entry_price * self.qty)

    def to_dict(self, ltp: float = 0.0) -> dict:
        px = ltp if ltp else self.entry_price
        return {
            "symbol": self.symbol,
            "security_id": self.security_id,
            "side": self.side,
            "qty": int(self.qty),
            "entry_price": round(float(self.entry_price), 2),
            "entry_ts": self.entry_ts.strftime("%Y-%m-%d %H:%M:%S") if self.entry_ts is not None else None,
            "ltp": round(float(px), 2),
            "stop": round(float(self.stop), 2),
            "target": round(float(self.target), 2),
            "high_water": round(float(self.high_water), 2),
            "r_multiple": round(self.r_multiple(px), 2),
            "pnl": round(self.unrealized(px), 2),
            "entry_score": round(float(self.entry_score), 1),
            "sector": self.sector,
        }


def initial_stop(entry: float, atr_v: float, side: str, cfg: IntradayConfig) -> float:
    dist = cfg.atr_stop_mult * atr_v
    return entry - dist if side == "LONG" else entry + dist


def pivot_stop(tracker, entry: float, side: str, cfg: IntradayConfig) -> Optional[float]:
    """Structural stop from lib/pivots.py PivotTracker, when --use-pivot-stop is on.

    Returns None when no confirmed pivot exists yet or the pivot sits on the wrong
    side of entry — the caller then falls back to the ATR stop rather than trading
    with no stop at all.
    """
    if tracker is None:
        return None
    try:
        piv = tracker.latest_low() if side == "LONG" else tracker.latest_high()
    except Exception:
        return None
    if piv is None:
        return None
    level = float(getattr(piv, "price", piv))
    if side == "LONG" and level < entry:
        return level
    if side == "SHORT" and level > entry:
        return level
    return None


def target_price(entry: float, stop: float, side: str, cfg: IntradayConfig) -> float:
    risk = abs(entry - stop)
    return entry + cfg.target_r * risk if side == "LONG" else entry - cfg.target_r * risk


def position_size(entry: float, stop: float, cfg: IntradayConfig,
                  deployed: float = 0.0) -> int:
    """Shares to trade, clamped by per-order value and remaining deployed headroom.

    Returns 0 when the stop is too wide to size sanely. The caller MUST skip the
    trade on 0 — never fall back to 1 share, which silently converts a rejected
    setup into an unsized one.
    """
    risk_per_share = abs(entry - stop)
    if entry <= 0 or risk_per_share <= 0 or not np.isfinite(risk_per_share):
        return 0

    qty = int(cfg.risk_per_trade // risk_per_share)
    if qty <= 0:
        return 0

    qty = min(qty, int(cfg.max_order_value // entry))
    headroom = cfg.max_deployed - deployed
    if headroom <= 0:
        return 0
    qty = min(qty, int(headroom // entry))
    return max(0, qty)


def trail_stop(pos: Position, row: pd.Series, cfg: IntradayConfig,
               ltp: Optional[float] = None) -> float:
    """Ratchet-only trailing stop. Arms at trail_arm_r, then trails high_water by
    trail_atr_mult ATRs. Never loosens — a stop that can move against you is not
    a stop, and this is asserted in tests."""
    px = ltp if (ltp and np.isfinite(ltp)) else _f(row, "Close")
    atr_v = _f(row, "atr")
    if not np.isfinite(px) or not np.isfinite(atr_v) or atr_v <= 0:
        return pos.stop

    if pos.side == "LONG":
        pos.high_water = max(pos.high_water, px)
    else:
        pos.high_water = min(pos.high_water, px)

    if pos.r_multiple(px) < cfg.trail_arm_r:
        return pos.stop

    if pos.side == "LONG":
        return max(pos.stop, pos.high_water - cfg.trail_atr_mult * atr_v)
    return min(pos.stop, pos.high_water + cfg.trail_atr_mult * atr_v)


def exit_reason(pos: Position, row: pd.Series, cfg: IntradayConfig,
                now_hhmm: str, ltp: Optional[float] = None) -> Optional[str]:
    """First match wins. Returns None to hold.

    SQUARE_OFF/STOP/TARGET are evaluated against the LIVE price because they are
    price levels; the signal-based exits use the CONFIRMED bar. Mixing these up in
    either direction is how a backtest stops matching live.
    """
    if now_hhmm >= cfg.square_off:
        return "SQUARE_OFF"

    px = ltp if (ltp and np.isfinite(ltp)) else _f(row, "Close")
    if not np.isfinite(px):
        return None

    if pos.side == "LONG":
        if px <= pos.stop:
            return "STOP"
        if px >= pos.target:
            return "TARGET"
    else:
        if px >= pos.stop:
            return "STOP"
        if px <= pos.target:
            return "TARGET"

    st_dir = _f(row, "st_dir_htf", 0.0)
    if np.isfinite(st_dir) and st_dir != 0 and st_dir * pos.sign < 0:
        return "ST_FLIP"

    if cfg.exit_on_vwap_loss:
        close = _f(row, "Close")
        vwap = _f(row, "vwap")
        if np.isfinite(close) and np.isfinite(vwap) and (close - vwap) * pos.sign < 0:
            return "VWAP_LOSS"

    if cfg.exit_on_rs_loss:
        rs_day = _f(row, "rs_day")
        if np.isfinite(rs_day) and rs_day * pos.sign < 0:
            return "RS_LOSS"

    return None


# ── Store readers ─────────────────────────────────────────────────────────────
def load_1m(symbol: str, store_dir: Optional[str] = None) -> Optional[pd.DataFrame]:
    path = os.path.join(store_dir or STORE_DIR, f"{symbol}.parquet")
    if not os.path.exists(path):
        return None
    df = pd.read_parquet(path)
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
    return df.sort_index()


def load_benchmark_1m(cfg: IntradayConfig,
                      store_dir: Optional[str] = None) -> Optional[pd.DataFrame]:
    return load_1m(cfg.benchmark, store_dir)


def load_store(symbols: Sequence[str], store_dir: Optional[str] = None
               ) -> Dict[str, pd.DataFrame]:
    out: Dict[str, pd.DataFrame] = {}
    for s in symbols:
        df = load_1m(s, store_dir)
        if df is not None and len(df):
            out[s] = df
    return out


def sessions_in(df: pd.DataFrame) -> List[date]:
    if df is None or len(df) == 0:
        return []
    return sorted({ts.date() for ts in df.index.normalize().unique()})


def slice_session(df: pd.DataFrame, day: date) -> pd.DataFrame:
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=df.columns if df is not None else [])
    mask = df.index.normalize() == pd.Timestamp(day)
    return df[mask]
