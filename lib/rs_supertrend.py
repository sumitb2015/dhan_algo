"""
Relative Strength + Supertrend (Vivek Bajaj, Learn2Trade session 19) — shared by the replay simulator and the
comparison backtest. Rules and evidence: Brain vault wiki/strategies/rs-supertrend-session19.md.

The video states the idea, not the numbers; the choices below are this module's and are constants so an
ablation can flip them (see scripts/analysis/backtest_rs_supertrend_ablation.py).

Entry (scanned DAILY on the signal day's close, fills next open in the replay):
  * RS > 0: (stock / stock[N bars]) / (Nifty / Nifty[N bars]) - 1 over RS_LOOKBACK bars (bharatTrader's formula).
  * RS rising: SMA(50) of RS up on each of the last 3 bars (his `ta.rising(sma_res, 3)`).
  * Supertrend (10, 2.0) is green.
  * Close > SMA(50).
  * Liquidity floor: 20-day average traded value >= Rs 2 crore (the video says "volume", unspecified).
Exit:
  * Supertrend turns red (the video's only exit) — EXIT_ON_SUPERTREND.
  * Disaster stop stop_pct below entry, trailing the peak once up 15% (framework default, same as EMA+Supertrend).
Ranking among qualifiers: the replay's composite-RS ranking (strongest first).
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

from lib.intraday_signals import supertrend

RS_LOOKBACK = 123            # bharatTrader's default; 252 did better out of sample in the 2026-11-22 study
RS_MA = 50
RS_RISING_BARS = 3
ST_PERIOD, ST_MULT = 10, 2.0
PRICE_MA = 50
MIN_TURNOVER20 = 2e7
DEFAULT_STOP_PCT = 12.0
TRAIL_ARM_GAIN_PCT = 15.0
EXIT_ON_SUPERTREND = True
REQUIRE_RS = True            # False = ablation: Supertrend + SMA50 only, ranking still by composite RS


def rs_series(close: pd.Series, bench_close: pd.Series, n: int) -> pd.Series:
    """Bar-based relative performance; `bench_close` must share `close`'s index."""
    return (close / close.shift(n)) / (bench_close / bench_close.shift(n)) - 1.0


def rs_rising(rs: pd.Series, ma: int = RS_MA, k: int = RS_RISING_BARS) -> pd.Series:
    sma = rs.rolling(ma, min_periods=ma).mean()
    return (sma > sma.shift(k)) & ((sma.diff() > 0).rolling(k).sum() == k)


def add_tables(price_map: Dict[str, pd.DataFrame], tables: Dict[str, dict], bench: Optional[pd.DataFrame]) -> None:
    """Per symbol: rs, rs_up, st_dir, sma50 as date -> value. `bench` has [date, close]; required."""
    if bench is None:
        raise ValueError("rs_supertrend needs the benchmark frame (relative strength is vs Nifty)")
    bser = pd.Series(bench["close"].to_numpy(dtype=float), index=list(bench["date"]))
    bser = bser[~bser.index.duplicated(keep="last")]
    for sym, df in price_map.items():
        if sym not in tables:
            continue
        dates = list(df["date"])
        close = df["close"].astype(float)
        close.index = dates
        b = bser.reindex(dates).ffill()
        rs = rs_series(close, b, RS_LOOKBACK)
        up = rs_rising(rs)
        sma = close.rolling(PRICE_MA, min_periods=PRICE_MA).mean()
        st_df = pd.DataFrame({"High": df["high"].to_numpy(), "Low": df["low"].to_numpy(),
                              "Close": df["close"].to_numpy()})
        st = supertrend(st_df, period=ST_PERIOD, multiplier=ST_MULT)
        t = tables[sym]
        t["rs"] = dict(zip(dates, rs.to_numpy()))
        t["rs_up"] = dict(zip(dates, up.to_numpy()))
        t["sma50"] = dict(zip(dates, sma.to_numpy()))
        t["st_dir"] = dict(zip(dates, st["st_dir"].to_numpy()))
        t["st_line"] = dict(zip(dates, st["st_line"].to_numpy()))


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and np.isnan(v))


def entry_check(sym: str, tables: dict, d, rs_pct: Optional[Dict[str, float]] = None) -> Tuple[bool, str]:
    """(ok, reason). On rejection `reason` lists EVERY failed rule joined by ' · '. `rs_pct` is unused (kept for the
    shared signature): the RS gate here is the stock's own RS vs Nifty, not a percentile."""
    t = tables.get(sym)
    if not t:
        return False, "no data"
    row = t["px"].get(d)
    if not row:
        return False, "no bar today"
    close = float(row.close)
    rs, up, sma, st_dir = t["rs"].get(d), t["rs_up"].get(d), t["sma50"].get(d), t["st_dir"].get(d)
    if any(_missing(v) for v in (rs, sma, st_dir)):
        return False, "insufficient history"
    fails = []
    if REQUIRE_RS and not rs > 0:
        fails.append(f"RS {rs:+.2f} not above 0")
    if REQUIRE_RS and not bool(up):
        fails.append("RS average not rising")
    if st_dir != 1:
        fails.append("Supertrend is Red")
    if not close > sma:
        fails.append("Close below SMA 50")
    turnover = float(t["turnover20"].get(d, 0.0) or 0.0)
    if turnover < MIN_TURNOVER20:
        fails.append("20d traded value < Rs 2 cr")
    return (False, " · ".join(fails)) if fails else (True, "pass")


def exit_check(pos, close: float, tables: dict, d, stop_pct: float = DEFAULT_STOP_PCT) -> Optional[str]:
    hard_stop = pos.entry_price * (1.0 - stop_pct / 100.0)
    peak = getattr(pos, "peak_close", getattr(pos, "peak_price", pos.entry_price))
    peak = max(peak, close)
    for attr in ("peak_close", "peak_price"):
        if hasattr(pos, attr):
            try:
                setattr(pos, attr, peak)
            except Exception:
                pass
            break
    eff_stop = hard_stop
    if peak >= pos.entry_price * (1.0 + TRAIL_ARM_GAIN_PCT / 100.0):
        eff_stop = max(hard_stop, peak * (1.0 - stop_pct / 100.0))
    if hasattr(pos, "stop_price"):
        try:
            pos.stop_price = max(pos.stop_price, eff_stop)
        except Exception:
            pass
    if close < eff_stop:
        return "stop"
    t = tables.get(pos.symbol)
    if t and EXIT_ON_SUPERTREND and t["st_dir"].get(d) == -1:
        return "Supertrend Bearish (Red)"
    return None
