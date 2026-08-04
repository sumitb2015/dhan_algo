"""
Momentum investing engine — shared ranking, regime, filter and exit logic.

This module is the single source of truth for the momentum portfolio system. Both the
backtest (scripts/analysis/backtest_momentum_portfolio.py) and the live strategy
(strategies/momentum_investing/nifty500_momentum.py) import from here, so the system that
gets validated on history is provably the same system that trades.

Nothing in this module touches Dhan, places orders, or writes files — it is pure data in,
decisions out. Keep it that way: it is what makes the backtest trustworthy.

The ranking math (composite RS, weekly 200-SMA regime, stacked-EMA + 55-day breakout entry)
is lifted from scripts/analysis/backtest_nifty50_rs_v9.py, which is the most evolved of the
ten one-off backtests in scripts/analysis/. The exit ladder is v4/v6's percentage ladder
rather than v9's ATR Chandelier — see the Position class.
"""

from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STOCK_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
INDEX_DIR = os.path.join(ROOT, "Historical Data")
UNIVERSE_CSV = os.path.join(ROOT, "ind_nifty500list.csv")

# Composite RS lookbacks in trading days and their weights. Mid-weighted: the 63-day
# (~3 month) term dominates, which is the classic momentum sweet spot — short enough to
# catch rotation, long enough to ignore noise. Weights must sum to 1.0.
RS_WEIGHTS: List[Tuple[int, float]] = [(10, 0.10), (21, 0.20), (63, 0.40), (126, 0.30)]


# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class MomentumConfig:
    """Every tunable of the strategy, in one place.

    The backtest sweeps these; the live strategy builds one from its CLI args. If you add
    a knob, add it here rather than as a module constant, or the two will drift.
    """

    # Universe
    universe: str = "nifty500"          # "nifty500" | "nifty50"
    min_history_bars: int = 250         # drop recent listings that break fixed lookbacks
    min_price: float = 50.0
    min_avg_turnover: float = 5e7       # 20d avg close*volume, Rs. 5 crore
    sector_cap: int = 2                 # max concurrent positions per Industry

    # Ranking
    rs_weights: List[Tuple[int, float]] = field(default_factory=lambda: list(RS_WEIGHTS))

    # Regime
    regime_enabled: bool = True         # False = always ON, i.e. no market filter at all
    regime_sma: int = 200               # weekly Nifty close vs this SMA
    regime_exit: bool = True            # liquidate the book when regime flips off

    # Entry
    buy_rank_limit: int = 20
    breakout_days: int = 55
    breakout_confirm: bool = True       # require 2 consecutive closes at new highs
    require_stacked_ema: bool = True    # Close > EMA20 > EMA50 > EMA200
    require_volume: bool = True         # today's volume > 20d average
    # None == no cap beyond the number of free slots. A cap of 2/review left the book
    # permanently under-filled (slots=15 backtested identically to slots=10, i.e. ten slots
    # were never all occupied) and cost ~4 points of CAGR in idle cash.
    max_new_per_review: Optional[int] = None
    cooldown_days: int = 10             # after a stop-out, before the symbol is eligible again

    # Exit ladder (all percentages, e.g. 30.0 == +30%).
    #
    # target_pct is None by design: a fixed profit target caps exactly the right tail that
    # momentum depends on. Backtested 2019-2026 on the Nifty 500, +30% target => 9.00% CAGR,
    # +60% => 9.69%, none => 11.54%, and widening the trail from there reached 14.20%.
    # Set a number here only if you want a hard profit cap and accept the drag.
    target_pct: Optional[float] = None
    stop_pct: float = 12.0              # -10% sat inside normal Nifty 500 noise
    breakeven_trigger_pct: float = 15.0
    trail_trigger_pct: float = 25.0
    trail_pct: float = 25.0             # distance below the running peak close

    # Rank rotation (weekly review only)
    sell_rank_limit: int = 25
    sell_rank_strikes: int = 2          # consecutive reviews above sell_rank_limit
    min_hold_days: int = 7

    # Sizing. Weights are DERIVED from `slots` so the book always commits ~100% of capital.
    # They used to be the hardcoded pair (0.1143, 0.0857), which is exactly right at 10 slots
    # and wrong everywhere else: --slots 8 left 17% of capital permanently idle and
    # --slots 15 committed 143%, so the last few slots silently failed to fund. That made
    # `slots` look like it barely affected returns when the sizing was simply broken.
    slots: int = 10
    capital: float = 175_000.0
    top_tier_slots: int = 5             # ranks 1..N get the larger allocation
    top_tier_ratio: float = 4.0 / 3.0   # top slot : lower slot (i.e. the old 20k : 15k)

    # Costs (backtest only; live gets real fills). Indian delivery-equity model taken from
    # the DhanHQ skill's backtests (C:\dhanHQ_skills\backtesting\*): 0.111% statutory per
    # side, Rs 20 per order, 0.05% slippage. The fixed leg matters at this position size —
    # Rs 20 on a Rs 15,000 slot is another 0.13%, which a pure-percentage model hides.
    fee_pct: float = 0.111              # STT + exchange + GST + stamp, per side
    fixed_fee: float = 20.0             # per order, per side
    slippage_pct: float = 0.05          # per side

    def trade_cost(self, value: float) -> float:
        """Total cost of one side of a trade on `value` rupees of stock."""
        return abs(value) * (self.fee_pct + self.slippage_pct) / 100.0 + self.fixed_fee

    def tier_weights(self) -> Tuple[float, float]:
        """(top-tier weight, lower-tier weight) as fractions of capital, summing to 1.0
        across all `slots`. At the defaults (10 slots, 5 top, 4:3) this reproduces the
        original 0.1143 / 0.0857 exactly."""
        n_top = min(self.top_tier_slots, self.slots)
        n_rest = max(self.slots - n_top, 0)
        denom = n_top * self.top_tier_ratio + n_rest
        if denom <= 0:
            return 0.0, 0.0
        w_rest = 1.0 / denom
        return self.top_tier_ratio * w_rest, w_rest

    def allocation_for_rank(self, rank: int) -> float:
        """Rupee allocation for a slot filled at this RS rank (1-based)."""
        w_top, w_rest = self.tier_weights()
        return self.capital * (w_top if rank <= self.top_tier_slots else w_rest)

    def validate(self) -> None:
        total = sum(w for _, w in self.rs_weights)
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"rs_weights must sum to 1.0, got {total}")
        if self.trail_trigger_pct < self.breakeven_trigger_pct:
            raise ValueError("trail_trigger_pct must be >= breakeven_trigger_pct")
        if self.target_pct is not None and self.target_pct <= self.trail_trigger_pct:
            raise ValueError("target_pct must exceed trail_trigger_pct or the trail never arms")
        if self.slots < 1:
            raise ValueError("slots must be >= 1")
        if self.max_new_per_review is not None and self.max_new_per_review < 1:
            raise ValueError("max_new_per_review must be >= 1 or None for no cap")
        if not 0 < self.stop_pct < 100:
            raise ValueError("stop_pct must be between 0 and 100")
        if not 0 < self.trail_pct < 100:
            raise ValueError("trail_pct must be between 0 and 100")
        if self.capital <= 0:
            raise ValueError("capital must be > 0")
        if self.sector_cap < 1:
            raise ValueError("sector_cap must be >= 1")
        if self.top_tier_ratio <= 0:
            raise ValueError("top_tier_ratio must be > 0")

    def to_dict(self) -> dict:
        return asdict(self)


# ──────────────────────────────────────────────────────────────────────────────
# Data loading
# ──────────────────────────────────────────────────────────────────────────────

# Nifty 50 constituents, for --universe nifty50 (parity checks against backtest v9).
NIFTY50: List[str] = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BEL", "BHARTIARTL",
    "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL",
    "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO",
    "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY",
    "ITC", "JIOFIN", "KOTAKBANK", "LT", "M&M",
    "MARUTI", "NESTLEIND", "NTPC", "ONGC", "POWERGRID",
    "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN", "SUNPHARMA",
    "TATACONSUM", "TATASTEEL", "TCS", "TECHM", "TITAN",
    "TMCV", "TMPV", "TRENT", "ULTRACEMCO", "WIPRO",
]

# The CSV writer in scripts/downloader/fetch_today_quotes.py upserts today's row with a
# trailing epoch-ms field, so the last line has 7 fields where the header declares 6, and a
# plain pd.read_csv raises "Expected 6 fields, saw 7". Supplying a 7th throwaway name is not
# enough on its own — with a header row present pandas still sizes the table from the header,
# so the header must be skipped outright (header=None + skiprows=1) for the wider names to
# take effect.
_STOCK_COLS = ["Datetime", "Open", "High", "Low", "Close", "Volume", "_extra"]


def _read_ohlcv(path: str) -> Optional[pd.DataFrame]:
    """Read one of the repo's daily OHLCV CSVs defensively.

    Returns a frame with lowercase columns [date, open, high, low, close, volume], sorted
    by date, weekend rows dropped, duplicate dates collapsed to the last occurrence.
    Volume of 0 becomes NaN — the intraday quote patcher writes 0 for today's row, and a
    literal zero would silently fail every volume filter.
    """
    if not os.path.exists(path):
        return None
    try:
        df = pd.read_csv(path, header=None, skiprows=1, names=_STOCK_COLS, engine="c")
    except Exception:
        # Wider than 7 fields, or otherwise malformed: drop the offending rows rather than
        # lose the whole symbol.
        try:
            df = pd.read_csv(path, header=None, skiprows=1, names=_STOCK_COLS,
                             engine="python", on_bad_lines="skip")
        except Exception:
            return None
    if df.empty:
        return None

    df = df.drop(columns=["_extra"], errors="ignore")
    df["Datetime"] = pd.to_datetime(df["Datetime"], errors="coerce")
    df = df.dropna(subset=["Datetime"])
    for col in ("Open", "High", "Low", "Close", "Volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["Close"])
    if df.empty:
        return None

    df = df[df["Datetime"].dt.dayofweek < 5]                  # weekend rows do occur
    df["date"] = df["Datetime"].dt.date
    df = df.drop_duplicates(subset=["date"], keep="last")
    df = df.sort_values("date").reset_index(drop=True)

    df = df.rename(columns={"Open": "open", "High": "high",
                            "Low": "low", "Close": "close", "Volume": "volume"})
    df.loc[df["volume"] <= 0, "volume"] = np.nan
    return df[["date", "open", "high", "low", "close", "volume"]]


def load_daily(symbol: str) -> Optional[pd.DataFrame]:
    """Daily OHLCV for one equity from Daily_Historical_Data_Fresh/."""
    return _read_ohlcv(os.path.join(STOCK_DIR, f"{symbol}_Daily_2Y.csv"))


def load_benchmark() -> pd.DataFrame:
    """Nifty 50 daily closes, 5Y file extended with anything only the 1Y file has."""
    base = _read_ohlcv(os.path.join(INDEX_DIR, "NIFTY_50_Daily_5Y.csv"))
    extra = _read_ohlcv(os.path.join(INDEX_DIR, "NIFTY_50_Daily_1Y.csv"))
    if base is None and extra is None:
        raise FileNotFoundError(f"No Nifty 50 daily CSV under {INDEX_DIR}")
    if base is None:
        return extra
    if extra is not None:
        missing = extra[~extra["date"].isin(set(base["date"]))]
        if not missing.empty:
            base = pd.concat([base, missing], ignore_index=True)
            base = base.sort_values("date").reset_index(drop=True)
    return base


def load_universe(universe: str = "nifty500") -> List[dict]:
    """Universe as [{symbol, company, industry}].

    Nifty 500 comes from ind_nifty500list.csv — the same list the Python refresh pipeline
    uses, and the only one carrying an Industry column for the sector cap. (The dashboard's
    MW-NIFTY-500-*.csv has no sectors.)
    """
    # Keys must match the nifty500 branch exactly — callers (and Phase 4's eDIS lookup) index
    # these dicts blind, and a missing "isin" would KeyError only on the nifty50 path.
    if universe == "nifty50":
        return [{"symbol": s, "company": s, "industry": "NIFTY50", "isin": ""} for s in NIFTY50]

    if not os.path.exists(UNIVERSE_CSV):
        raise FileNotFoundError(f"Universe list not found: {UNIVERSE_CSV}")
    df = pd.read_csv(UNIVERSE_CSV)
    out = []
    for row in df.itertuples(index=False):
        symbol = str(getattr(row, "Symbol", "")).strip()
        if not symbol:
            continue
        out.append({
            "symbol": symbol,
            "company": str(getattr(row, "_0", symbol)).strip(),   # "Company Name"
            "industry": str(getattr(row, "Industry", "")).strip() or "Unknown",
            # ISIN is needed for the eDIS authorisation a CNC sell requires. The DhanHQ
            # skill's guardrail says to prefer the ISIN reported in holdings over a
            # looked-up one, so treat this as a fallback for pre-trade checks only.
            "isin": str(getattr(row, "_4", "")).strip(),          # "ISIN Code"
        })
    return out


def load_price_map(symbols: Sequence[str], min_bars: int = 0) -> Dict[str, pd.DataFrame]:
    """Load every symbol that has a CSV with at least min_bars rows."""
    out: Dict[str, pd.DataFrame] = {}
    for sym in symbols:
        df = load_daily(sym)
        if df is None or len(df) < min_bars:
            continue
        out[sym] = df
    return out


def latest_data_date(price_map: Dict[str, pd.DataFrame]) -> Optional[date]:
    """Newest bar across the loaded universe — used by the live freshness guard."""
    dates = [df["date"].iloc[-1] for df in price_map.values() if len(df)]
    return max(dates) if dates else None


# ──────────────────────────────────────────────────────────────────────────────
# Indicator tables
# ──────────────────────────────────────────────────────────────────────────────

def build_tables(price_map: Dict[str, pd.DataFrame], cfg: MomentumConfig) -> Dict[str, dict]:
    """Precompute per-symbol indicators as date->value dicts for O(1) daily lookup.

    Building these once and indexing by date is what keeps a 500-symbol, 7-year backtest
    to seconds rather than minutes — the same shape v9 uses (backtest_nifty50_rs_v9.py:129).
    """
    n = cfg.breakout_days
    tables: Dict[str, dict] = {}

    for sym, df in price_map.items():
        closes = df["close"]

        ema20 = closes.ewm(span=20, adjust=False).mean()
        ema50 = closes.ewm(span=50, adjust=False).mean()
        ema200 = closes.ewm(span=200, adjust=False).mean()

        # No ATR here: this system's ladder is percentage-based, not Chandelier like v9's.
        # Computing one anyway cost a concat + ewm over every symbol on every rebuild.

        # Rolling breakout high, shifted so the current bar is not part of its own high.
        rolling = closes.rolling(n, min_periods=n).max()
        high_1 = rolling.shift(1)     # yesterday's n-day closing max
        high_2 = rolling.shift(2)     # the day-before's n-day closing max

        vol = df["volume"]
        vol20 = vol.rolling(20, min_periods=10).mean()
        turnover20 = (closes * vol).rolling(20, min_periods=10).mean()

        dates = df["date"]
        tables[sym] = {
            "ema20": dict(zip(dates, ema20)),
            "ema50": dict(zip(dates, ema50)),
            "ema200": dict(zip(dates, ema200)),
            "high_1": dict(zip(dates, high_1)),
            "high_2": dict(zip(dates, high_2)),
            "close_1": dict(zip(dates, closes.shift(1))),
            "vol": dict(zip(dates, vol)),
            "vol20": dict(zip(dates, vol20)),
            "turnover20": dict(zip(dates, turnover20)),
            "bars": {d: i + 1 for i, d in enumerate(dates)},   # bars of history as of date
            "px": {r.date: r for r in df.itertuples(index=False)},
        }
    return tables


# ──────────────────────────────────────────────────────────────────────────────
# Regime
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RegimeCalendar:
    """Weekly market-regime calendar derived from the benchmark.

    Regime for ISO week W is ON iff the PREVIOUS week's final close was above the 200 SMA.
    Deciding a week's regime from data that is already complete removes the intra-week
    whipsaw that plagued the daily-regime versions of this system (v3-v5).
    """

    trading_days: List[date]
    on_days: set                       # every date falling in a regime-ON week
    review_days: set                   # first trading day of each ISO week
    week_regime: Dict[Tuple[int, int], bool]   # (iso_year, iso_week) -> ON, for inspection

    def is_on(self, d: date) -> bool:
        return d in self.on_days

    def is_review_day(self, d: date) -> bool:
        return d in self.review_days

    def next_review_day(self, d: date) -> Optional[date]:
        """The next weekly review date on or after the day following `d`.

        Falls back to projecting forward when `d` is the newest bar we have, which is the
        normal case live — the calendar is built from history and so contains no future
        trading days at all. Projection is weekday-only (it cannot know NSE holidays), so a
        holiday Monday reports a review date that the live cycle will simply roll past.
        """
        known = next((x for x in self.trading_days if x > d and x in self.review_days), None)
        if known:
            return known
        this_week = pd.Timestamp(d).isocalendar()[:2]
        probe = d + timedelta(days=1)
        for _ in range(14):
            if probe.weekday() < 5 and tuple(pd.Timestamp(probe).isocalendar()[:2]) != tuple(this_week):
                return probe
            probe += timedelta(days=1)
        return None


def build_regime_weekly(bench: pd.DataFrame, cfg: MomentumConfig) -> RegimeCalendar:
    closes = bench["close"]
    sma = closes.rolling(cfg.regime_sma, min_periods=cfg.regime_sma).mean()
    dates = list(bench["date"])

    week_days: Dict[Tuple[int, int], List[Tuple[int, date]]] = defaultdict(list)
    for i, d in enumerate(dates):
        iso = pd.Timestamp(d).isocalendar()
        week_days[(iso[0], iso[1])].append((i, d))

    weeks = sorted(week_days.keys())
    week_regime: Dict[Tuple[int, int], bool] = {}
    for w_idx, wk in enumerate(weeks):
        if not cfg.regime_enabled:
            week_regime[wk] = True
            continue
        if w_idx == 0:
            week_regime[wk] = False
            continue
        last_i = week_days[weeks[w_idx - 1]][-1][0]
        prev_sma = sma.iloc[last_i]
        week_regime[wk] = (not pd.isna(prev_sma)) and bool(closes.iloc[last_i] > prev_sma)

    on_days = {d for wk, days in week_days.items() if week_regime.get(wk)
               for _, d in days}
    review_days = {days[0][1] for days in week_days.values()}

    return RegimeCalendar(trading_days=dates, on_days=on_days,
                          review_days=review_days, week_regime=week_regime)


# ──────────────────────────────────────────────────────────────────────────────
# Composite relative strength & ranking
# ──────────────────────────────────────────────────────────────────────────────

def composite_rs(stock_closes: np.ndarray, bench_closes: np.ndarray,
                 weights: Sequence[Tuple[int, float]] = RS_WEIGHTS) -> float:
    """Weighted multi-timeframe relative strength versus the benchmark.

        RS = sum_n  w_n * [ (S_t / S_{t-n}) / (I_t / I_{t-n}) - 1 ]

    Zero means the stock moved exactly with the index over every lookback. Both arrays must
    already be truncated to the as-of date, with the most recent bar last. Terms whose
    lookback exceeds the available history are skipped, so newly listed names score on what
    they have rather than being silently zeroed.
    """
    if len(stock_closes) < 2 or len(bench_closes) < 2:
        return 0.0
    score = 0.0
    for n, w in weights:
        if len(stock_closes) <= n or len(bench_closes) <= n:
            continue
        s_then, s_now = stock_closes[-1 - n], stock_closes[-1]
        b_then, b_now = bench_closes[-1 - n], bench_closes[-1]
        if not (s_then and b_then and b_now):
            continue
        if np.isnan(s_then) or np.isnan(s_now) or np.isnan(b_then) or np.isnan(b_now):
            continue
        score += w * ((s_now / s_then) / (b_now / b_then) - 1.0)
    return float(score)


@dataclass
class RSMatrix:
    """Every symbol's closes reindexed onto the benchmark's trading calendar.

    Built once, then indexed positionally. This exists for correctness before speed:
    composite_rs looks back `n` array positions in BOTH series, so if a symbol is missing
    bars the benchmark has, its "n bars ago" is a different calendar date than the index's
    and the ratio compares mismatched spans. On this dataset only 3 of 483 Nifty 500 symbols
    share the benchmark's calendar exactly — one has over a thousand missing bars — so the
    positional form is wrong for nearly every name. Reindexing pins both series to the same
    dates. (backtest_nifty50_rs_v9.py has this bug; it went unnoticed because a Nifty 50
    universe is almost perfectly aligned.)

    Missing days are forward-filled: a stock that did not trade carries its previous close,
    which is the right input to a return calculation. Days before a symbol's listing stay
    NaN and are skipped by composite_rs.
    """

    dates: List[date]
    index_of: Dict[date, int]
    bench: np.ndarray
    closes: Dict[str, np.ndarray]        # aligned to `dates`, forward-filled
    has_bar: Dict[str, np.ndarray]       # True where the symbol has its own bar that day
    bar_counts: Dict[str, np.ndarray]    # cumulative count of the symbol's own bars


def build_rs_matrix(price_map: Dict[str, pd.DataFrame], bench: pd.DataFrame) -> RSMatrix:
    dates = list(bench["date"])
    index_of = {d: i for i, d in enumerate(dates)}
    bench_arr = bench["close"].to_numpy(dtype=float)

    closes: Dict[str, np.ndarray] = {}
    has_bar: Dict[str, np.ndarray] = {}
    bar_counts: Dict[str, np.ndarray] = {}
    for sym, df in price_map.items():
        s = pd.Series(df["close"].to_numpy(dtype=float), index=list(df["date"]))
        s = s[~s.index.duplicated(keep="last")]
        aligned = s.reindex(dates)
        present = aligned.notna().to_numpy()
        closes[sym] = aligned.ffill().to_numpy(dtype=float)
        has_bar[sym] = present
        bar_counts[sym] = np.cumsum(present)
    return RSMatrix(dates=dates, index_of=index_of, bench=bench_arr,
                    closes=closes, has_bar=has_bar, bar_counts=bar_counts)


def rank_universe(price_map: Dict[str, pd.DataFrame], bench: pd.DataFrame,
                  as_of: date, cfg: MomentumConfig,
                  matrix: Optional[RSMatrix] = None) -> List[Tuple[str, float]]:
    """Rank every symbol with sufficient history by composite RS, strongest first.

    Symbols with no bar of their own on `as_of` (delisted, suspended, or a data gap) are
    excluded rather than ranked on a carried-forward price — debug/confirmed_data_gaps.json
    documents multi-year holes in this dataset.

    Pass a prebuilt `matrix` to avoid rebuilding it on every review day; the backtest does.
    """
    m = matrix if matrix is not None else build_rs_matrix(price_map, bench)
    i = m.index_of.get(as_of)
    if i is None or i < 1:
        return []

    out: List[Tuple[str, float]] = []
    for sym, arr in m.closes.items():
        if not m.has_bar[sym][i]:
            continue                              # no bar of its own today
        if m.bar_counts[sym][i] < cfg.min_history_bars:
            continue
        out.append((sym, composite_rs(arr[:i + 1], m.bench[:i + 1], cfg.rs_weights)))

    out.sort(key=lambda x: x[1], reverse=True)
    return out


def ranks_by_symbol(ranking: Sequence[Tuple[str, float]]) -> Dict[str, int]:
    """{symbol: 1-based rank} from the output of rank_universe."""
    return {sym: i + 1 for i, (sym, _) in enumerate(ranking)}


# ──────────────────────────────────────────────────────────────────────────────
# Entry filters
# ──────────────────────────────────────────────────────────────────────────────

def passes_entry_filters(sym: str, tables: Dict[str, dict], as_of: date,
                         cfg: MomentumConfig) -> Tuple[bool, str]:
    """Per-symbol entry gate. Returns (ok, reason) — reason names the first failing test.

    The reason string is surfaced on the dashboard so a rejected top-ranked name is
    explainable ("why didn't it buy RELIANCE?") rather than a silent no-op.
    """
    t = tables.get(sym)
    if not t:
        return False, "no data"

    row = t["px"].get(as_of)
    if row is None:
        return False, "no bar"
    close = float(row.close)

    if t["bars"].get(as_of, 0) < cfg.min_history_bars:
        return False, "short history"
    if close < cfg.min_price:
        return False, f"price < {cfg.min_price:g}"

    turnover = t["turnover20"].get(as_of)
    if turnover is None or pd.isna(turnover):
        return False, "no turnover data"
    if float(turnover) < cfg.min_avg_turnover:
        return False, "illiquid"

    if cfg.require_stacked_ema:
        e20, e50, e200 = (t["ema20"].get(as_of), t["ema50"].get(as_of), t["ema200"].get(as_of))
        if any(x is None or pd.isna(x) for x in (e20, e50, e200)):
            return False, "no EMA"
        if not (close > float(e20) > float(e50) > float(e200)):
            return False, "EMA not stacked"

    h1 = t["high_1"].get(as_of)
    if h1 is None or pd.isna(h1):
        return False, "no breakout window"
    if close <= float(h1):
        return False, f"below {cfg.breakout_days}d high"

    if cfg.breakout_confirm:
        h2, c1 = t["high_2"].get(as_of), t["close_1"].get(as_of)
        if any(x is None or pd.isna(x) for x in (h2, c1)):
            return False, "no confirm window"
        if float(c1) <= float(h2):
            return False, "breakout unconfirmed"

    if cfg.require_volume:
        vol, vol20 = t["vol"].get(as_of), t["vol20"].get(as_of)
        # Today's volume is NaN on rows patched by fetch_today_quotes.py, which writes 0.
        # Skip the test rather than reject every candidate on quote-patched days.
        if vol is not None and not pd.isna(vol) and vol20 is not None and not pd.isna(vol20):
            if float(vol20) > 0 and float(vol) <= float(vol20):
                return False, "low volume"

    return True, "ok"


# ──────────────────────────────────────────────────────────────────────────────
# Position & exit ladder
# ──────────────────────────────────────────────────────────────────────────────

STAGE_INITIAL = 0     # hard stop at -stop_pct from entry
STAGE_BREAKEVEN = 1   # stop raised to entry
STAGE_TRAIL = 2       # stop trails trail_pct below the running peak close

# Ladder thresholds are compared with a tolerance because the obvious cases land exactly on
# them in binary float: 115/100 - 1 is 0.14999999999999997, so an exact `>= 15.0` would
# refuse to arm breakeven at precisely +15%.
_EPS = 1e-9


class Position:
    """One held stock and its exit ladder.

    The ladder ratchets on the PEAK close, never on the current one, so a stop that has been
    raised can never fall back. Rungs, each applied as a floor (see update()):

        entry            stop = entry * (1 - stop_pct)
        peak >= +15%     stop = max(stop, entry)                    (risk removed)
        peak >= +25%     stop = max(stop, peak * (1 - trail_pct))   (trailing)
        close >= target  exit, if a target_pct is configured at all

    update() is called once per trading day with that day's close. It is pure — it returns
    an exit reason and mutates only this object's own stop/peak/stage.
    """

    __slots__ = ("symbol", "entry_date", "entry_price", "qty", "rank_at_entry",
                 "industry", "peak_close", "stop_price", "stage", "last_close",
                 "rank_strikes")

    def __init__(self, symbol: str, entry_date: date, entry_price: float, qty: int,
                 cfg: MomentumConfig, rank_at_entry: int = 0, industry: str = ""):
        self.symbol = symbol
        self.entry_date = entry_date
        self.entry_price = float(entry_price)
        self.qty = int(qty)
        self.rank_at_entry = rank_at_entry
        self.industry = industry
        self.peak_close = float(entry_price)
        self.stop_price = float(entry_price) * (1.0 - cfg.stop_pct / 100.0)
        self.stage = STAGE_INITIAL
        self.last_close = float(entry_price)
        self.rank_strikes = 0

    # ── derived values ────────────────────────────────────────────────────────
    @property
    def invested(self) -> float:
        return self.entry_price * self.qty

    def gain_pct(self, price: float) -> float:
        return (price / self.entry_price - 1.0) * 100.0

    def unrealised(self, price: float) -> float:
        return (price - self.entry_price) * self.qty

    def hold_days(self, as_of: date) -> int:
        return (as_of - self.entry_date).days

    # ── the ladder ────────────────────────────────────────────────────────────
    def update(self, close: float, cfg: MomentumConfig) -> Optional[str]:
        """Advance the ladder one day. Returns "target", "stop", or None."""
        close = float(close)
        self.last_close = close
        if close > self.peak_close:
            self.peak_close = close

        if cfg.target_pct is not None and self.gain_pct(close) >= cfg.target_pct - _EPS:
            return "target"

        # Rungs are CUMULATIVE, not exclusive. An if/elif here would let a position that
        # gaps straight past the trail trigger skip the breakeven rung, and with a trail as
        # wide as 25% the resulting stop sits BELOW entry (1.30 x 0.75 = 0.975) — i.e. a
        # stock could be up 30% and still stop out for a loss. Applying both rungs and
        # taking the max makes the stop monotonic in both price and stage.
        peak_gain = self.gain_pct(self.peak_close)
        if peak_gain >= cfg.breakeven_trigger_pct - _EPS:
            self.stop_price = max(self.stop_price, self.entry_price)
            self.stage = STAGE_BREAKEVEN
        if peak_gain >= cfg.trail_trigger_pct - _EPS:
            self.stop_price = max(self.stop_price,
                                  self.peak_close * (1.0 - cfg.trail_pct / 100.0))
            self.stage = STAGE_TRAIL

        if close < self.stop_price:
            return "stop"
        return None

    def stage_label(self) -> str:
        return {STAGE_INITIAL: "hard stop",
                STAGE_BREAKEVEN: "breakeven",
                STAGE_TRAIL: "trailing"}[self.stage]

    # ── persistence ───────────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "entry_date": self.entry_date.isoformat(),
            "entry_price": self.entry_price,
            "qty": self.qty,
            "rank_at_entry": self.rank_at_entry,
            "industry": self.industry,
            "peak_close": self.peak_close,
            "stop_price": self.stop_price,
            "stage": self.stage,
            "last_close": self.last_close,
            "rank_strikes": self.rank_strikes,
        }

    @classmethod
    def from_dict(cls, d: dict, cfg: MomentumConfig) -> "Position":
        pos = cls(
            symbol=d["symbol"],
            entry_date=datetime.fromisoformat(d["entry_date"]).date()
            if isinstance(d["entry_date"], str) else d["entry_date"],
            entry_price=d["entry_price"],
            qty=d["qty"],
            cfg=cfg,
            rank_at_entry=d.get("rank_at_entry", 0),
            industry=d.get("industry", ""),
        )
        # Restore ratcheted state verbatim — recomputing it would reset a raised stop.
        pos.peak_close = float(d.get("peak_close", pos.entry_price))
        pos.stop_price = float(d.get("stop_price", pos.stop_price))
        pos.stage = int(d.get("stage", STAGE_INITIAL))
        pos.last_close = float(d.get("last_close", pos.entry_price))
        pos.rank_strikes = int(d.get("rank_strikes", 0))
        return pos


# ──────────────────────────────────────────────────────────────────────────────
# Review helpers (shared by backtest and live engine)
# ──────────────────────────────────────────────────────────────────────────────

def rank_rotation_exits(portfolio: Dict[str, Position], ranks: Dict[str, int],
                        as_of: date, cfg: MomentumConfig) -> List[Tuple[str, str]]:
    """Weekly rank-rotation check. Returns [(symbol, reason)] for positions to close.

    A position needs `sell_rank_strikes` CONSECUTIVE reviews outside the sell rank limit
    before it is dropped — one bad week in a 500-name universe is noise, not a trend break.
    Strike counters are mutated on the positions themselves, so this must be called exactly
    once per review day.
    """
    exits: List[Tuple[str, str]] = []
    for sym, pos in portfolio.items():
        rank = ranks.get(sym)

        # Absent from the ranking is NOT evidence of weakness. rank_universe drops any
        # symbol without a fresh bar, so a stale CSV or a one-day feed gap would otherwise
        # look identical to a collapse in relative strength — and two such reviews in a row
        # would force-sell a perfectly healthy position on a data problem. Hold the counter
        # steady instead; the stop ladder still protects the position either way.
        if rank is None:
            continue

        if rank > cfg.sell_rank_limit:
            pos.rank_strikes += 1
        else:
            pos.rank_strikes = 0
            continue
        if pos.hold_days(as_of) < cfg.min_hold_days:
            continue
        if pos.rank_strikes >= cfg.sell_rank_strikes:
            exits.append((sym, f"rank {rank} for {pos.rank_strikes} reviews"))
    return exits


def sector_counts(portfolio: Dict[str, Position]) -> Dict[str, int]:
    counts: Dict[str, int] = defaultdict(int)
    for pos in portfolio.values():
        counts[pos.industry] += 1
    return dict(counts)


def select_candidates(ranking: Sequence[Tuple[str, float]], portfolio: Dict[str, Position],
                      tables: Dict[str, dict], industries: Dict[str, str], as_of: date,
                      cooldowns: Dict[str, date], cfg: MomentumConfig,
                      free_slots: int) -> Tuple[List[dict], List[dict]]:
    """Pick this review's buys. Returns (picks, rejections).

    Walks the ranking from the top, taking names that clear every gate until the slot,
    per-review and sector caps are hit. Rejections carry a reason for the dashboard.
    """
    picks: List[dict] = []
    rejections: List[dict] = []
    counts = sector_counts(portfolio)
    taken = 0
    cap = free_slots if cfg.max_new_per_review is None else min(free_slots, cfg.max_new_per_review)

    for rank, (sym, rs) in enumerate(ranking, start=1):
        if taken >= cap:
            break
        if rank > cfg.buy_rank_limit:
            break
        if sym in portfolio:
            continue

        industry = industries.get(sym, "Unknown")
        cooldown_until = cooldowns.get(sym)
        if cooldown_until and as_of < cooldown_until:
            rejections.append({"symbol": sym, "rank": rank, "rs": rs,
                               "reason": f"cooldown until {cooldown_until}"})
            continue
        if counts.get(industry, 0) >= cfg.sector_cap:
            rejections.append({"symbol": sym, "rank": rank, "rs": rs,
                               "reason": f"sector cap ({industry})"})
            continue

        ok, reason = passes_entry_filters(sym, tables, as_of, cfg)
        if not ok:
            rejections.append({"symbol": sym, "rank": rank, "rs": rs, "reason": reason})
            continue

        picks.append({"symbol": sym, "rank": rank, "rs": rs, "industry": industry})
        counts[industry] = counts.get(industry, 0) + 1
        taken += 1

    return picks, rejections


def size_position(price: float, rank: int, cfg: MomentumConfig,
                  cash_available: float) -> int:
    """Shares to buy for a slot at this rank, capped by cash on hand. 0 means skip."""
    alloc = min(cfg.allocation_for_rank(rank), cash_available)
    if price <= 0 or alloc <= 0:
        return 0
    return int(alloc // price)
