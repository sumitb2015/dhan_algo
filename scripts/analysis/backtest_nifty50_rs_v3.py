"""
Backtest v3: Nifty 50 RS-ranked equity strategy (robust version)

Fixes vs v2:
  1. Dual regime filter: close > 50-DMA AND close > close_63d_ago
     (prevents single-spike false entries like Jan 2, 2025)
  2. Clean capital tracking: fill empty slots every regime-ON day
     (no bug where capital disappears into limbo)
  3. Per-symbol cooldown: 10 trading days before re-buying same symbol after SL
     (prevents immediately re-entering a falling stock)
  4. Entry quality: stock must be above its 50-DMA AND RS > 0
  5. Step-up trailing SL:
       - < +10% peak  : hard SL at entry - 10%
       - >= +10% peak : SL moves to entry (breakeven)
       - >= +20% peak : SL trails at peak * 90%
  6. Invest up to Rs.15,000 per position (so single high-priced share qualifies)
"""

import os
import pandas as pd
import numpy as np
from datetime import date, timedelta

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
INDEX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")

NIFTY50_STOCKS = [
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

# ── Parameters ─────────────────────────────────────────────────────────────────
START_DATE        = date(2025, 1, 1)
INVEST_PER_SLOT   = 10_000
MAX_INVEST        = 15_000          # allow up to 15k for high-priced stocks
PORTFOLIO_SIZE    = 20
RS_LOOKBACK       = 126             # 6-month Mansfield RS
SMA_PERIOD        = 50              # for regime + stock filter
MOM_PERIOD        = 63              # 3-month momentum for regime
SL_PCT            = 0.10
TARGET_PCT        = 0.30
SYM_COOLDOWN_DAYS = 10              # days before re-buying same symbol after SL


# ── Loaders ───────────────────────────────────────────────────────────────────

def load_df(path: str, date_col: str = "Datetime") -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=[date_col])
    df = df.rename(columns={date_col: "date", "Open": "open", "High": "high",
                             "Low": "low", "Close": "close", "Volume": "volume"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)


def load_index() -> pd.DataFrame:
    return load_df(INDEX_PATH)[["date", "close"]]


def load_stock(sym: str) -> pd.DataFrame | None:
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    return load_df(path)[["date", "open", "high", "low", "close"]]


# ── Indicators ─────────────────────────────────────────────────────────────────

def sma(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(n, min_periods=n).mean()


# ── Pre-build lookup tables ────────────────────────────────────────────────────

def build_index_tables(index_df: pd.DataFrame) -> tuple:
    """Returns (dates_list, closes_series, regime_set)."""
    closes = index_df["close"]
    sma50  = sma(closes, SMA_PERIOD)
    mom63  = closes > closes.shift(MOM_PERIOD)

    dates = list(index_df["date"])
    # Regime = above 50-DMA AND positive 3-month momentum
    regime_set = set()
    for i, d in enumerate(dates):
        if pd.isna(sma50.iloc[i]):
            continue
        if bool(closes.iloc[i] > sma50.iloc[i]) and bool(mom63.iloc[i]):
            regime_set.add(d)

    return dates, closes, regime_set


def build_stock_tables(price_map: dict) -> tuple:
    """
    Returns:
      sma50_lookup : {sym: {date: sma50_value}}
      price_lookup : {sym: {date: namedtuple_row}}
    """
    sma50_lookup = {}
    price_lookup = {}
    for sym, df in price_map.items():
        df2 = df.copy()
        df2["sma50"] = sma(df2["close"], SMA_PERIOD)
        sma50_lookup[sym] = {r.date: r.sma50 for r in df2.itertuples(index=False)}
        price_lookup[sym]  = {r.date: r for r in df.itertuples(index=False)}
    return sma50_lookup, price_lookup


# ── RS ranking ─────────────────────────────────────────────────────────────────

def compute_rs(stock_closes: pd.Series, idx_closes: pd.Series) -> float:
    n = RS_LOOKBACK
    if len(stock_closes) <= n or len(idx_closes) <= n:
        return 0.0
    sc, sb = stock_closes.iloc[-1], stock_closes.iloc[-1 - n]
    ic, ib = idx_closes.iloc[-1], idx_closes.iloc[-1 - n]
    if sb == 0 or ib == 0:
        return 0.0
    return ((sc / sb) / (ic / ib)) - 1


def rank_universe(price_map: dict, idx_closes: pd.Series,
                  idx_pos: int, as_of: date) -> list[tuple[str, float]]:
    scores = []
    for sym, df in price_map.items():
        sc = df[df["date"] <= as_of]["close"]
        ic = idx_closes.iloc[:idx_pos + 1]
        scores.append((sym, compute_rs(sc, ic)))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


# ── Position ───────────────────────────────────────────────────────────────────

class Position:
    def __init__(self, sym: str, entry_date: date, ep: float, shares: int):
        self.symbol      = sym
        self.entry_date  = entry_date
        self.entry_price = ep
        self.shares      = shares
        self.invest      = ep * shares
        self.peak        = ep
        self.sl          = ep * (1 - SL_PCT)
        self.target      = ep * (1 + TARGET_PCT)

    def update(self, high: float, low: float) -> str | None:
        if high > self.peak:
            self.peak = high

        pg = (self.peak / self.entry_price) - 1  # peak gain
        if pg >= 0.20:
            trail_sl = self.peak * (1 - SL_PCT)       # trail 10% below peak
        elif pg >= 0.10:
            trail_sl = self.entry_price                # breakeven
        else:
            trail_sl = self.entry_price * (1 - SL_PCT) # hard floor

        self.sl = max(self.sl, trail_sl)  # SL never moves down

        if high >= self.target:
            return "target"
        if low <= self.sl:
            return "sl"
        return None

    def exit_px(self, reason: str, open_price: float) -> float:
        if reason == "target":
            return self.target
        return min(self.sl, open_price) if open_price < self.sl else self.sl

    def pnl(self, exit_px: float) -> float:
        return (exit_px - self.entry_price) * self.shares

    def unr(self, curr: float) -> float:
        return (curr - self.entry_price) * self.shares


# ── Main backtest ──────────────────────────────────────────────────────────────

def run_backtest():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v3")
    print("Regime: close > 50-DMA AND close > close[63d ago]")
    print("Entry:  stock above 50-DMA, RS > 0")
    print("SL:     step-up trailing (floor->breakeven->10% trail)")
    print("=" * 72)

    # ── Load data ──────────────────────────────────────────────────────────────
    print("\nLoading data...")
    index_df  = load_index()
    idx_dates, idx_closes, regime_set = build_index_tables(index_df)

    price_map = {sym: df for sym in NIFTY50_STOCKS
                 if (df := load_stock(sym)) is not None}
    print(f"  Loaded {len(price_map)} stocks")

    sma50_lkp, price_lkp = build_stock_tables(price_map)

    trading_days = [d for d in idx_dates if d >= START_DATE]
    print(f"  Backtest: {trading_days[0]} to {trading_days[-1]} ({len(trading_days)} days)")

    # First regime-ON date
    first_regime = next((d for d in trading_days if d in regime_set), None)
    print(f"  First regime-ON day: {first_regime}")

    # ── State ─────────────────────────────────────────────────────────────────
    portfolio: dict[str, Position] = {}
    trades: list[dict] = []
    sym_last_sl: dict[str, int] = {}  # sym -> day_idx of last SL hit

    # ── Helpers ───────────────────────────────────────────────────────────────

    def regime_on(d: date) -> bool:
        return d in regime_set

    def entry_ok(sym: str, d: date, rs: float, day_idx: int) -> bool:
        # RS must be positive
        if rs <= 0:
            return False
        # Not in cooldown
        if day_idx - sym_last_sl.get(sym, -9999) < SYM_COOLDOWN_DAYS:
            return False
        # Stock must be above its 50-DMA
        s50 = sma50_lkp[sym].get(d)
        row = price_lkp[sym].get(d)
        if s50 is None or row is None or pd.isna(s50):
            return False
        return float(row.close) > float(s50)

    def try_buy(sym: str, d: date, price_col: str = "close") -> Position | None:
        row = price_lkp[sym].get(d)
        if row is None:
            return None
        ep = float(getattr(row, price_col))
        if ep <= 0:
            return None
        shares = max(1, int(MAX_INVEST // ep))
        return Position(sym, d, ep, shares)

    # ── Day loop ───────────────────────────────────────────────────────────────
    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_dates.index(day)

        # 1. Process exits
        for sym, pos in list(portfolio.items()):
            row = price_lkp[sym].get(day)
            if row is None:
                continue
            result = pos.update(float(row.high), float(row.low))
            if result:
                ep = pos.exit_px(result, float(row.open))
                pnl = pos.pnl(ep)
                trades.append({
                    "symbol":       sym,
                    "entry_date":   pos.entry_date,
                    "exit_date":    day,
                    "entry_price":  pos.entry_price,
                    "exit_price":   ep,
                    "shares":       pos.shares,
                    "invest":       pos.invest,
                    "pnl":          pnl,
                    "pnl_pct":      pnl / pos.invest * 100,
                    "exit_reason":  result,
                    "hold_days":    (day - pos.entry_date).days,
                    "regime_at_exit": regime_on(day),
                })
                if result == "sl":
                    sym_last_sl[sym] = day_idx
                del portfolio[sym]

        # 2. Fill empty slots when regime is ON
        empty_slots = PORTFOLIO_SIZE - len(portfolio)
        if empty_slots > 0 and regime_on(day):
            ranked = rank_universe(price_map, idx_closes, idx_pos, day)
            in_ptf = set(portfolio.keys())
            filled = 0
            for sym, rs in ranked:
                if filled >= empty_slots:
                    break
                if sym in in_ptf:
                    continue
                if not entry_ok(sym, day, rs, day_idx):
                    continue
                pos = try_buy(sym, day, "close")
                if pos is None:
                    continue
                portfolio[sym] = pos
                in_ptf.add(sym)
                filled += 1
                if empty_slots <= PORTFOLIO_SIZE // 2 or filled <= 3:
                    # Only print first few fills to avoid log spam
                    print(f"  {day}: BUY {sym}: {pos.shares} @ {pos.entry_price:.2f} "
                          f"(RS {rs:+.3f})")
            if filled > 3:
                print(f"  {day}: ... +{filled-3} more positions filled "
                      f"({len(portfolio)}/{PORTFOLIO_SIZE} slots)")
            elif filled == 0 and empty_slots > 0:
                pass  # Regime ON but no eligible stocks

    # ── Mark-to-market ─────────────────────────────────────────────────────────
    last_day = trading_days[-1]
    open_pos = []
    for sym, pos in portfolio.items():
        row = price_lkp[sym].get(last_day)
        if row is None:
            continue
        curr = float(row.close)
        unr  = pos.unr(curr)
        open_pos.append({
            "symbol":      sym,
            "entry_date":  pos.entry_date,
            "entry_price": pos.entry_price,
            "current":     curr,
            "shares":      pos.shares,
            "invest":      pos.invest,
            "unr_pnl":     unr,
            "unr_pct":     unr / pos.invest * 100,
            "trail_sl":    pos.sl,
            "target":      pos.target,
        })

    # ── Report ─────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Trades':>7} {'Win':>5} {'Loss':>6} {'Win%':>7} "
              f"{'PNL':>12} {'Cum PNL':>14}")
        print("-" * 68)
        cum = 0.0
        for ym, grp in tdf.groupby("ym"):
            n, w = len(grp), (grp["pnl"] > 0).sum()
            mp   = grp["pnl"].sum()
            cum += mp
            print(f"{str(ym):<12} {n:>7} {w:>5} {n-w:>6} {w/n*100:>6.1f}% "
                  f"{mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 68)

        closed_pnl  = tdf["pnl"].sum()
        ttrades     = len(tdf)
        twins       = (tdf["pnl"] > 0).sum()
        tgt_exits   = (tdf["exit_reason"] == "target").sum()
        sl_exits    = (tdf["exit_reason"] == "sl").sum()
        avg_win     = tdf[tdf["pnl"] > 0]["pnl"].mean() if twins else 0
        avg_loss    = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        expectancy  = (twins / ttrades * avg_win) + ((ttrades - twins) / ttrades * avg_loss)
        avg_hold    = tdf["hold_days"].mean()
        max_win     = tdf["pnl"].max()
        max_loss    = tdf["pnl"].min()

        print(f"\nCLOSED TRADES SUMMARY")
        print(f"  Total trades        : {ttrades}")
        print(f"  Winners             : {twins} ({twins/ttrades*100:.1f}%)")
        print(f"  Losers              : {ttrades-twins} ({(ttrades-twins)/ttrades*100:.1f}%)")
        print(f"  Target hits (+30%)  : {tgt_exits}")
        print(f"  SL hits             : {sl_exits}")
        print(f"  Avg win             : Rs.{avg_win:+,.0f}")
        print(f"  Avg loss            : Rs.{avg_loss:+,.0f}")
        if avg_loss:
            print(f"  Win/Loss ratio      : {abs(avg_win/avg_loss):.2f}x")
        print(f"  Expectancy/trade    : Rs.{expectancy:+,.0f}")
        print(f"  Best trade          : Rs.{max_win:+,.0f}")
        print(f"  Worst trade         : Rs.{max_loss:+,.0f}")
        print(f"  Avg hold (days)     : {avg_hold:.1f}")
        print(f"  Closed PNL          : Rs.{closed_pnl:+,.0f}")

    unr_pnl = 0.0
    if open_pos:
        unr_pnl = sum(r["unr_pnl"] for r in open_pos)
        print(f"\nOPEN POSITIONS (MTM as of {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'EntryPx':>8} {'Curr':>9} "
              f"{'Shrs':>5} {'Unreal':>10} {'%':>7} {'SL':>9} {'Target':>9}")
        print("-" * 88)
        for r in sorted(open_pos, key=lambda x: x["unr_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current']:>9.2f} {r['shares']:>5} {r['unr_pnl']:>+10,.0f} "
                  f"{r['unr_pct']:>+6.1f}% {r['trail_sl']:>9.2f} {r['target']:>9.2f}")
        print("-" * 88)
        print(f"  Total unrealised: Rs.{unr_pnl:+,.0f}   Open slots: {PORTFOLIO_SIZE - len(open_pos)}")

    total   = closed_pnl + unr_pnl
    init_cap = PORTFOLIO_SIZE * INVEST_PER_SLOT
    print(f"\nOVERALL (closed + open MTM)")
    print(f"  Closed PNL          : Rs.{closed_pnl:+,.0f}")
    print(f"  Open MTM            : Rs.{unr_pnl:+,.0f}")
    print(f"  TOTAL PNL           : Rs.{total:+,.0f}")
    print(f"  Initial capital     : Rs.{init_cap:,.0f}")
    print(f"  Return on capital   : {total/init_cap*100:+.2f}%")

    # Closed trade log
    if trades:
        print(f"\nCLOSED TRADE LOG")
        print(f"{'Symbol':<14} {'Entry':>10} {'Exit':>10} {'EntryPx':>8} {'ExitPx':>9} "
              f"{'Shrs':>5} {'PNL':>10} {'%':>7} {'Rsn':<8} {'Days':>5}")
        print("-" * 90)
        for t in sorted(trades, key=lambda x: x["exit_date"]):
            print(f"{t['symbol']:<14} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['entry_price']:>8.2f} {t['exit_price']:>9.2f} {t['shares']:>5} "
                  f"{t['pnl']:>+10,.0f} {t['pnl_pct']:>+6.1f}% "
                  f"{t['exit_reason']:<8} {t['hold_days']:>5}")


if __name__ == "__main__":
    run_backtest()
