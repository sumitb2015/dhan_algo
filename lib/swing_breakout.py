"""
Swing breakout — simple trend-following rules on DAILY bars.

Design brief: keep the rule set small and mechanical (Supertrend + N-day breakout),
screen the portfolio on daily charts, and hold for days/weeks. This is deliberately
simpler than lib/momentum.py, which layers composite RS ranking, a weekly regime
calendar, rank-rotation exits and several confirmation gates on top of its breakout.

Pure module: no broker session, no network, no I/O beyond the daily-CSV loaders it
borrows from lib.momentum. Imported by BOTH the backtest and (eventually) the live
strategy, per the lib/momentum.py precedent — never reimplement a rule in a caller.

Indicators are reused from lib.intraday_signals (supertrend/atr/adx/ema). Those are
timeframe-agnostic pure functions over an OHLCV frame, so they apply to daily bars
unchanged and stay bit-identical with what the intraday side uses.

READ BEFORE TRUSTING A RESULT
-----------------------------
The daily universe is TODAY'S Nifty 500 (ind_nifty500list.csv). Names dropped from the
index between 2019 and now are absent from the data entirely, and names added after a
big run are present during that run. Measured on the existing momentum system, this
matters enormously: its top 10 trades were 96% of all P&L, and dropping the top 3 put
it below the index. Any backtest built on this module MUST report the drop-top-N
robustness curve and the Nifty-50 comparison, or it is reporting an upper bound as if
it were an expectation. `report_robustness()` below exists so callers cannot skip it.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, asdict
from datetime import date
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

_LIB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_LIB))

from lib.intraday_signals import adx, atr, ema, supertrend  # noqa: E402


# ── Config ────────────────────────────────────────────────────────────────────
@dataclass
class SwingConfig:
    """Every tunable in one place, so backtest and live share one surface."""

    # Universe / liquidity
    universe: str = "nifty500"
    min_history_bars: int = 220     # drop recent listings that break fixed lookbacks
    min_price: float = 50.0
    min_turnover: float = 5e7       # 20d avg close*volume, Rs 5 crore

    # ── Screen (daily) ───────────────────────────────────────────────────────
    breakout_days: int = 50         # close at a new N-day high
    st_period: int = 10             # daily Supertrend
    st_multiplier: float = 3.0
    require_supertrend: bool = True
    require_ema_stack: bool = True  # close > EMA50 > EMA200
    ema_fast: int = 50
    ema_slow: int = 200
    require_volume: bool = True
    vol_mult: float = 1.5           # today's volume vs its 20d average
    adx_period: int = 14
    adx_min: float = 0.0            # 0 disables the ADX gate
    rs_min: float = 0.0             # 60d return minus benchmark's, 0 = must merely match

    # ── Market regime ────────────────────────────────────────────────────────
    regime_enabled: bool = True
    regime_sma: int = 200           # benchmark daily close vs this SMA
    regime_exit: bool = False       # liquidate the book when regime flips off

    # ── Portfolio ────────────────────────────────────────────────────────────
    slots: int = 10
    sector_cap: int = 2
    max_new_per_day: int = 3
    capital: float = 500_000.0

    # ── Exits ────────────────────────────────────────────────────────────────
    # Supertrend IS the trailing stop — that is the whole point of a trend-following
    # exit, and the ATR chandelier is off by default because it actively destroyed the
    # edge. Measured over 7.6 years / Nifty 500: a 3-ATR trail gave -5.67% CAGR (749 of
    # 751 exits were trail-stops, average win +10.5% vs average loss -7.1%), a 6-ATR
    # trail +12.54%, and letting Supertrend do the work +18.95%. Tightening the trail
    # cuts winners while losers still run the full stop distance.
    atr_period: int = 14
    atr_stop_mult: float = 6.0      # wide disaster stop only; never the primary exit
    atr_trail_enabled: bool = False  # True restores the (harmful) chandelier trail
    trail_atr_mult: float = 6.0     # only used when atr_trail_enabled
    exit_on_st_flip: bool = True    # the real exit
    max_hold_days: int = 0          # 0 = no time stop
    min_hold_days: int = 0

    # ── Costs ────────────────────────────────────────────────────────────────
    cost_pct: float = 0.12          # round-trip %, brokerage+STT+stamp+GST proxy
    slippage_pct: float = 0.10      # each side

    def validate(self) -> None:
        for name in ("breakout_days", "st_period", "atr_period", "slots",
                     "sector_cap", "max_new_per_day", "min_history_bars"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be >= 1 (got {getattr(self, name)})")
        if self.ema_fast >= self.ema_slow:
            raise ValueError("ema_fast must be < ema_slow")
        if self.st_multiplier <= 0 or self.atr_stop_mult <= 0:
            raise ValueError("st_multiplier and atr_stop_mult must be > 0")
        if self.capital <= 0:
            raise ValueError("capital must be > 0")
        if self.min_hold_days and self.max_hold_days and self.min_hold_days > self.max_hold_days:
            raise ValueError("min_hold_days cannot exceed max_hold_days")

    def to_dict(self) -> dict:
        return asdict(self)


# ── Per-symbol indicator tables ───────────────────────────────────────────────
def build_indicators(df: pd.DataFrame, cfg: SwingConfig) -> Optional[pd.DataFrame]:
    """Daily indicator frame for one symbol.

    Input is lib.momentum's loader shape (lowercase columns + a `date` column); the
    shared indicator functions expect Title-case OHLCV, so it is renamed once here.

    EVERY column is shifted where needed so a row only ever contains information
    knowable at that bar's CLOSE. The breakout high in particular EXCLUDES today,
    or "today closed at a new 50-day high" would be trivially true by construction.
    """
    if df is None or len(df) < max(cfg.min_history_bars, cfg.ema_slow + 5):
        return None

    d = df.copy()
    if "date" in d.columns:
        d = d.set_index(pd.to_datetime(d["date"]))
    d = d.rename(columns={"open": "Open", "high": "High", "low": "Low",
                          "close": "Close", "volume": "Volume"})
    keep = ["Open", "High", "Low", "Close", "Volume"]
    if not all(c in d.columns for c in keep):
        return None
    d = d[keep].sort_index()

    out = d.copy()
    # Prior N-day high, TODAY EXCLUDED — this is the breakout level to clear.
    out["breakout_level"] = d["High"].rolling(cfg.breakout_days).max().shift(1)
    out["is_breakout"] = d["Close"] > out["breakout_level"]

    st = supertrend(d, cfg.st_period, cfg.st_multiplier)
    out["st_line"] = st["st_line"]
    out["st_dir"] = st["st_dir"]

    out["ema_fast"] = ema(d["Close"], cfg.ema_fast)
    out["ema_slow"] = ema(d["Close"], cfg.ema_slow)
    out["ema_stacked"] = (d["Close"] > out["ema_fast"]) & (out["ema_fast"] > out["ema_slow"])

    out["atr"] = atr(d, cfg.atr_period)
    out["adx"] = adx(d, cfg.adx_period)["adx"]

    vol20 = d["Volume"].rolling(20).mean()
    out["vol_ratio"] = d["Volume"] / vol20.replace(0.0, np.nan)
    out["turnover"] = (d["Close"] * d["Volume"]).rolling(20).mean()
    out["ret_60"] = d["Close"] / d["Close"].shift(60) - 1.0

    return out


def build_regime(bench: pd.DataFrame, cfg: SwingConfig) -> pd.Series:
    """Daily market-regime switch: benchmark close above its SMA.

    Shifted by one bar — today's regime is decided by yesterday's close, so the
    screen never consults a value that was not yet final when it ran.
    """
    b = bench.copy()
    if "date" in b.columns:
        b = b.set_index(pd.to_datetime(b["date"]))
    close = b["close"] if "close" in b.columns else b["Close"]
    close = close.sort_index()
    on = (close > close.rolling(cfg.regime_sma).mean()).shift(1).fillna(False)
    return on.astype(bool)


def benchmark_ret60(bench: pd.DataFrame) -> pd.Series:
    b = bench.copy()
    if "date" in b.columns:
        b = b.set_index(pd.to_datetime(b["date"]))
    close = (b["close"] if "close" in b.columns else b["Close"]).sort_index()
    return close / close.shift(60) - 1.0


# ── Screen ────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ScreenResult:
    passed: bool
    reasons: Tuple[str, ...]        # which gates FAILED, for diagnostics
    strength: float                 # ranking key among passers


def screen(row: pd.Series, cfg: SwingConfig, bench_ret60: float = 0.0) -> ScreenResult:
    """Apply the daily gates to one symbol on one bar."""
    fails: List[str] = []

    close = float(row.get("Close", np.nan))
    atr_v = float(row.get("atr", np.nan))
    if not np.isfinite(close) or not np.isfinite(atr_v) or atr_v <= 0:
        return ScreenResult(False, ("no_data",), 0.0)

    if close < cfg.min_price:
        fails.append("min_price")
    if float(row.get("turnover", 0) or 0) < cfg.min_turnover:
        fails.append("turnover")
    if not bool(row.get("is_breakout", False)):
        fails.append("breakout")
    if cfg.require_supertrend and float(row.get("st_dir", 0) or 0) <= 0:
        fails.append("supertrend")
    if cfg.require_ema_stack and not bool(row.get("ema_stacked", False)):
        fails.append("ema_stack")
    if cfg.require_volume and not (float(row.get("vol_ratio", 0) or 0) >= cfg.vol_mult):
        fails.append("volume")
    if cfg.adx_min > 0 and not (float(row.get("adx", 0) or 0) >= cfg.adx_min):
        fails.append("adx")

    rs = float(row.get("ret_60", np.nan))
    if cfg.rs_min > 0 or cfg.rs_min == 0:
        rel = (rs - bench_ret60) if np.isfinite(rs) else -np.inf
        if rel < cfg.rs_min:
            fails.append("rel_strength")

    # Rank passers by relative strength — among equally valid breakouts, prefer the
    # one leading the market by the widest margin.
    strength = ((rs - bench_ret60) if np.isfinite(rs) else 0.0)
    return ScreenResult(not fails, tuple(fails), strength)


# ── Position / exits ──────────────────────────────────────────────────────────
@dataclass
class SwingPosition:
    symbol: str
    industry: str
    qty: int
    entry_price: float
    entry_date: date
    stop: float
    high_water: float
    entry_strength: float = 0.0

    def unrealized(self, px: float) -> float:
        return (px - self.entry_price) * self.qty

    def notional(self) -> float:
        return self.entry_price * self.qty


def initial_stop(entry: float, atr_v: float, cfg: SwingConfig) -> float:
    return entry - cfg.atr_stop_mult * atr_v


def trail_stop(pos: SwingPosition, row: pd.Series, cfg: SwingConfig) -> float:
    """Chandelier trail from the run-up high. Ratchet-only — never loosens.

    Disabled by default: see the note on atr_trail_enabled. high_water is still
    tracked when it is off, so diagnostics and any live trailing display stay
    correct and enabling the trail mid-life does not start from a stale high.
    """
    high = float(row.get("High", np.nan))
    atr_v = float(row.get("atr", np.nan))
    if not np.isfinite(high) or not np.isfinite(atr_v) or atr_v <= 0:
        return pos.stop
    pos.high_water = max(pos.high_water, high)
    if not cfg.atr_trail_enabled:
        return pos.stop
    return max(pos.stop, pos.high_water - cfg.trail_atr_mult * atr_v)


def exit_reason(pos: SwingPosition, row: pd.Series, cfg: SwingConfig,
                held_days: int, regime_on: bool) -> Optional[str]:
    """First match wins; None holds.

    The stop is checked against the bar's LOW, not its close — a stop that only
    triggers on closing prices is not a stop and would flatter every result.
    """
    if cfg.min_hold_days and held_days < cfg.min_hold_days:
        return None
    low = float(row.get("Low", np.nan))
    if np.isfinite(low) and low <= pos.stop:
        return "STOP"
    if cfg.exit_on_st_flip and float(row.get("st_dir", 0) or 0) < 0:
        return "ST_FLIP"
    if cfg.regime_enabled and cfg.regime_exit and not regime_on:
        return "REGIME"
    if cfg.max_hold_days and held_days >= cfg.max_hold_days:
        return "TIME"
    return None


def position_size(entry: float, equity: float, cfg: SwingConfig) -> int:
    """Equal-weight by slot. Returns 0 when a slot cannot buy a single share."""
    if entry <= 0 or equity <= 0:
        return 0
    return int((equity / cfg.slots) // entry)


# ── Robustness reporting (deliberately not optional) ──────────────────────────
def drop_top_n_curve(pnls: Sequence[float], capital: float, years: float,
                     ns: Sequence[int] = (0, 1, 3, 5, 10, 20)) -> pd.DataFrame:
    """CAGR after removing the N best trades.

    Exists because the existing momentum system looked strong on headline stats
    (PF 1.97, Sharpe 1.17) while 96% of its P&L came from 10 of 294 trades —
    dropping the top 3 put it below the index. A strategy whose result survives
    only with its best handful of trades has not been validated, it has been
    described.
    """
    s = pd.Series(list(pnls)).sort_values(ascending=False)
    rows = []
    for n in ns:
        rem = float(s.iloc[n:].sum()) if n < len(s) else 0.0
        mult = (capital + rem) / capital
        # mult <= 0 means the account was wiped out; a CAGR is undefined there, so
        # report -100% (total loss) rather than a NaN that reads as "no data".
        if years <= 0:
            cagr = float("nan")
        elif mult <= 0:
            cagr = -100.0
        else:
            cagr = (mult ** (1 / years) - 1) * 100
        rows.append({"dropped": n, "pnl": round(rem, 0), "cagr_pct": round(cagr, 2)})
    return pd.DataFrame(rows)


def concentration(pnls: Sequence[float], top: int = 10) -> float:
    """Share of total P&L contributed by the best `top` trades (percent).

    Only meaningful when total P&L is POSITIVE. Dividing by a negative total
    produces a negative "share" that reads as nonsense (a losing run reported
    "top 10 = -98.9% of P&L"), so that case returns NaN and callers should
    suppress the metric rather than print it.
    """
    s = pd.Series(list(pnls))
    tot = float(s.sum())
    if tot <= 0:
        return float("nan")
    return float(s.nlargest(top).sum() / tot * 100)
