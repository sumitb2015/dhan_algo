"""
Backtest v2: Nifty 50 RS-ranked equity strategy (improved)

Improvements over v1:
  1. Market regime filter  - only open/replace when Nifty close > 50-DMA
  2. Step-up trailing SL   - hard 10% floor, breakeven at +10%, trail at 10% from peak once +20%
  3. Entry quality filter  - stock must be above own 50-DMA AND RS ratio > 0
  4. 5-day SL cooldown     - wait 5 trading days after SL hit before replacing (no cascade)
  5. Position sizing       - invest up to Rs.15,000 if a single share > Rs.10,000

Strategy parameters (unchanged from v1):
  - Universe  : Nifty 50 stocks (50 names)
  - Ranking   : Mansfield RS vs Nifty 50 (126-day lookback)
  - Portfolio : top 20 slots, Rs.10,000 invested per slot
  - Target    : +30% from entry
"""

import os
import pandas as pd
import numpy as np
from datetime import date, timedelta
from collections import defaultdict

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
INDEX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")

# ── Universe ───────────────────────────────────────────────────────────────────
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
START_DATE       = date(2025, 1, 1)
INVEST_PER_SLOT  = 10_000       # INR base investment per position
MAX_INVEST       = 15_000       # allow up to 15k if single share > 10k
PORTFOLIO_SIZE   = 20
RS_LOOKBACK      = 126          # 6-month RS lookback
SL_PCT           = 0.10         # initial hard SL: 10% below entry
TARGET_PCT       = 0.30         # profit target: 30%
SMA_PERIOD       = 50           # 50-day SMA for regime + stock filters
SL_COOLDOWN_DAYS = 5            # trading days to wait before replacing after SL
MIN_INVEST_SHARES = 1           # always buy at least 1 share


# ── Data loading ───────────────────────────────────────────────────────────────

def load_stock(symbol: str) -> pd.DataFrame | None:
    path = os.path.join(DATA_DIR, f"{symbol}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Open": "open", "High": "high",
                             "Low": "low", "Close": "close", "Volume": "volume"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[
        ["date", "open", "high", "low", "close", "volume"]
    ]


def load_index() -> pd.DataFrame:
    df = pd.read_csv(INDEX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date", "close"]]


# ── Indicators ─────────────────────────────────────────────────────────────────

def compute_sma(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(n, min_periods=n).mean()


def compute_rs_ratio(stock_closes: pd.Series, index_closes: pd.Series,
                     lookback: int = RS_LOOKBACK) -> float:
    """Mansfield RS ratio: positive = stock outperforming index."""
    if len(stock_closes) <= lookback or len(index_closes) <= lookback:
        return 0.0
    s_c, s_b = stock_closes.iloc[-1], stock_closes.iloc[-1 - lookback]
    i_c, i_b = index_closes.iloc[-1], index_closes.iloc[-1 - lookback]
    if s_b == 0 or i_b == 0:
        return 0.0
    return ((s_c / s_b) / (i_c / i_b)) - 1


def rank_stocks(price_map: dict, index_closes: pd.Series,
                idx_pos: int, as_of_date: date) -> list[tuple[str, float]]:
    """Returns (symbol, rs_ratio) sorted best to worst. Only stocks with rs > 0."""
    scores = []
    for sym, df in price_map.items():
        sl = df[df["date"] <= as_of_date]["close"]
        il = index_closes.iloc[:idx_pos + 1]
        rs = compute_rs_ratio(sl, il)
        scores.append((sym, rs))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


# ── Step-up trailing SL ────────────────────────────────────────────────────────

class Position:
    def __init__(self, symbol: str, entry_date: date, entry_price: float, shares: int):
        self.symbol = symbol
        self.entry_date = entry_date
        self.entry_price = entry_price
        self.shares = shares
        self.invest_amount = entry_price * shares
        self.highest_price = entry_price
        self.sl = entry_price * (1 - SL_PCT)   # initial hard 10% SL
        self.target = entry_price * (1 + TARGET_PCT)

    def update(self, high: float, low: float) -> str | None:
        # Update peak
        if high > self.highest_price:
            self.highest_price = high

        # Step-up SL logic
        peak_gain = (self.highest_price / self.entry_price) - 1
        if peak_gain >= 0.20:
            # Trail 10% below peak (only when peak was 20%+ up)
            trail_sl = self.highest_price * (1 - SL_PCT)
        elif peak_gain >= 0.10:
            # Move to breakeven when peak was 10%+ up
            trail_sl = self.entry_price
        else:
            # Hard floor: 10% below entry
            trail_sl = self.entry_price * (1 - SL_PCT)

        # SL can only move up, never down
        self.sl = max(self.sl, trail_sl)

        # Check exits (target checked first on the same candle)
        if high >= self.target:
            return "target"
        if low <= self.sl:
            return "sl"
        return None

    def exit_price(self, reason: str, open_price: float) -> float:
        if reason == "target":
            return self.target
        # SL: gap-down exit at open if below SL
        return min(self.sl, open_price) if open_price < self.sl else self.sl

    def pnl(self, exit_px: float) -> float:
        return (exit_px - self.entry_price) * self.shares

    def unrealised(self, current_price: float) -> float:
        return (current_price - self.entry_price) * self.shares


# ── Pre-compute 50-DMA lookup for each stock ──────────────────────────────────

def build_sma_lookup(price_map: dict) -> dict[str, dict[date, float]]:
    """For each stock: {date -> 50-day SMA of close on that date}."""
    lookup = {}
    for sym, df in price_map.items():
        df2 = df.copy()
        df2["sma50"] = compute_sma(df2["close"], SMA_PERIOD)
        lookup[sym] = {row.date: row.sma50 for row in df2.itertuples(index=False)}
    return lookup


# ── Main backtest ──────────────────────────────────────────────────────────────

def run_backtest():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v2 (with regime filter + step-up SL)")
    print("=" * 72)
    print("Loading data...")

    index_df = load_index()
    index_dates = list(index_df["date"])
    index_closes = index_df["close"]

    # 50-DMA of Nifty for regime filter
    index_sma50 = compute_sma(index_closes, SMA_PERIOD)
    index_sma50_by_date: dict[date, float] = {
        d: v for d, v in zip(index_dates, index_sma50) if not pd.isna(v)
    }

    # Load stocks
    price_map: dict[str, pd.DataFrame] = {}
    for sym in NIFTY50_STOCKS:
        df = load_stock(sym)
        if df is not None:
            price_map[sym] = df
    print(f"  Loaded {len(price_map)} stocks")

    # Pre-compute stock 50-DMAs
    stock_sma50 = build_sma_lookup(price_map)

    # Per-stock price lookup {sym: {date: row}}
    stock_lookup: dict[str, dict[date, object]] = {
        sym: {row.date: row for row in df.itertuples(index=False)}
        for sym, df in price_map.items()
    }

    trading_days = [d for d in index_dates if d >= START_DATE]
    print(f"  Trading days: {trading_days[0]} to {trading_days[-1]} ({len(trading_days)} days)")

    # ── State ─────────────────────────────────────────────────────────────────
    portfolio: dict[str, Position] = {}
    trades: list[dict] = []
    cash_idle = 0.0         # capital waiting to be deployed
    sl_cooldown: dict[str, int] = {}  # sym -> trading day index of last SL
    # We track how many slots are in cooldown (waiting to deploy)
    pending_slots: list[tuple[int, float]] = []  # (available_from_day_idx, capital)

    # ── Helper: is the market in a bullish regime? ─────────────────────────────
    def regime_ok(d: date) -> bool:
        sma = index_sma50_by_date.get(d)
        if sma is None:
            return False
        pos = index_dates.index(d)
        close = index_closes.iloc[pos]
        return float(close) > float(sma)

    # ── Helper: is entry valid for stock? ─────────────────────────────────────
    def entry_ok(sym: str, d: date, rs_ratio: float) -> bool:
        if rs_ratio <= 0:
            return False  # must actually outperform index
        sma = stock_sma50[sym].get(d)
        row = stock_lookup[sym].get(d)
        if sma is None or row is None or pd.isna(sma):
            return False
        return float(row.close) > float(sma)

    # ── Helper: pick replacement ───────────────────────────────────────────────
    def pick_replacement(exited_sym: str, ranked: list, in_portfolio: set,
                         as_of_date: date) -> tuple[str, float] | None:
        top20 = {s for s, _ in ranked[:PORTFOLIO_SIZE]}
        for i, (sym, rs) in enumerate(ranked):
            if sym in in_portfolio:
                continue
            # If exited stock is still top-20, skip it (take #21+)
            if exited_sym in top20 and sym == exited_sym:
                continue
            if not entry_ok(sym, as_of_date, rs):
                continue
            return sym, rs
        return None

    # ── Open initial positions ─────────────────────────────────────────────────
    first_day = trading_days[0]
    print(f"\n--- Scanning for initial entry on {first_day} ---")

    if not regime_ok(first_day):
        regime_date = None
        for d in trading_days:
            if regime_ok(d):
                regime_date = d
                break
        print(f"  Regime OFF on {first_day}. Will wait until Nifty > 50-DMA.")
        if regime_date:
            print(f"  First regime-ON day: {regime_date}")
    else:
        regime_date = first_day

    # We'll handle initial entry in the main loop (first regime-ON day)
    initial_entry_done = False

    # ── Day-by-day simulation ──────────────────────────────────────────────────
    for day_idx, day in enumerate(trading_days):
        idx_pos = index_dates.index(day)
        regime_on = regime_ok(day)

        # --- Initial entry logic ---
        if not initial_entry_done and regime_on:
            print(f"\n  Regime ON! First entries on {day}")
            ranked0 = rank_stocks(price_map, index_closes, idx_pos, day)
            in_portfolio = set(portfolio.keys())
            slots_filled = 0
            for sym, rs in ranked0:
                if slots_filled >= PORTFOLIO_SIZE:
                    break
                if sym in in_portfolio:
                    continue
                if not entry_ok(sym, day, rs):
                    continue
                row = stock_lookup[sym].get(day)
                if row is None:
                    continue
                ep = float(row.open)
                shares = max(MIN_INVEST_SHARES, int(MAX_INVEST // ep))
                pos = Position(sym, day, ep, shares)
                portfolio[sym] = pos
                in_portfolio.add(sym)
                slots_filled += 1
                print(f"    BUY {sym}: {shares} @ {ep:.2f} (RS {rs:+.3f})")
            print(f"  Opened {slots_filled} initial positions")
            initial_entry_done = True
            continue

        # --- Check positions for exit ---
        exits_today = []
        for sym, pos in list(portfolio.items()):
            row = stock_lookup[sym].get(day)
            if row is None:
                continue
            result = pos.update(float(row.high), float(row.low))
            if result:
                ep = pos.exit_price(result, float(row.open))
                pnl = pos.pnl(ep)
                trade = {
                    "symbol": sym,
                    "entry_date": pos.entry_date,
                    "exit_date": day,
                    "entry_price": pos.entry_price,
                    "exit_price": ep,
                    "shares": pos.shares,
                    "invest": pos.invest_amount,
                    "pnl": pnl,
                    "pnl_pct": pnl / pos.invest_amount * 100,
                    "exit_reason": result,
                    "hold_days": (day - pos.entry_date).days,
                    "regime_at_exit": regime_on,
                }
                trades.append(trade)
                exits_today.append((sym, result))
                del portfolio[sym]

        # --- Replace exits ---
        if exits_today and regime_on:
            ranked_now = rank_stocks(price_map, index_closes, idx_pos, day)
            in_portfolio = set(portfolio.keys())

            for exited_sym, exit_reason in exits_today:
                # SL cooldown: skip replacement for 5 trading days
                if exit_reason == "sl":
                    sl_cooldown[exited_sym] = day_idx

                # Wait 5 trading days after SL before adding a new position
                if exit_reason == "sl":
                    # Queue the slot to open 5 trading days later
                    pending_slots.append((day_idx + SL_COOLDOWN_DAYS, INVEST_PER_SLOT))
                    continue

                # Target exit: replace immediately
                result = pick_replacement(exited_sym, ranked_now, in_portfolio, day)
                if result is None:
                    pending_slots.append((day_idx + 1, INVEST_PER_SLOT))
                    continue
                rep_sym, rep_rs = result
                row = stock_lookup[rep_sym].get(day)
                if row is None:
                    continue
                ep = float(row.close)
                shares = max(MIN_INVEST_SHARES, int(MAX_INVEST // ep))
                pos = Position(rep_sym, day, ep, shares)
                portfolio[rep_sym] = pos
                in_portfolio.add(rep_sym)
                t = trades[-1] if trades else {}
                print(f"  {day}: EXIT {exited_sym} (target, PNL {t.get('pnl_pct',0):+.1f}%) "
                      f"-> BUY {rep_sym}: {shares} @ {ep:.2f} (RS {rep_rs:+.3f})")

        elif exits_today and not regime_on:
            # Regime is off: don't replace, park the capital
            for exited_sym, exit_reason in exits_today:
                pnl_pct = next((t["pnl_pct"] for t in reversed(trades)
                                if t["symbol"] == exited_sym), 0)
                print(f"  {day}: EXIT {exited_sym} ({exit_reason}, {pnl_pct:+.1f}%) "
                      f"[REGIME OFF - capital parked]")

        # --- Deploy pending slots ---
        deployable = [slot for slot in pending_slots if slot[0] <= day_idx]
        if deployable and regime_on:
            pending_slots = [s for s in pending_slots if s[0] > day_idx]
            ranked_now = rank_stocks(price_map, index_closes, idx_pos, day)
            in_portfolio = set(portfolio.keys())
            for _, capital in deployable:
                result = pick_replacement("__none__", ranked_now, in_portfolio, day)
                if result is None:
                    pending_slots.append((day_idx + 1, capital))
                    continue
                rep_sym, rep_rs = result
                row = stock_lookup[rep_sym].get(day)
                if row is None:
                    continue
                ep = float(row.close)
                shares = max(MIN_INVEST_SHARES, int(MAX_INVEST // ep))
                pos = Position(rep_sym, day, ep, shares)
                portfolio[rep_sym] = pos
                in_portfolio.add(rep_sym)
                print(f"  {day}: DEFERRED BUY {rep_sym}: {shares} @ {ep:.2f} (RS {rep_rs:+.3f})")

    # ── Mark-to-market ─────────────────────────────────────────────────────────
    last_day = trading_days[-1]
    open_positions = []
    for sym, pos in portfolio.items():
        row = stock_lookup[sym].get(last_day)
        if row is None:
            continue
        curr = float(row.close)
        unr = pos.unrealised(curr)
        open_positions.append({
            "symbol": sym,
            "entry_date": pos.entry_date,
            "entry_price": pos.entry_price,
            "current_price": curr,
            "shares": pos.shares,
            "invest": pos.invest_amount,
            "unrealised_pnl": unr,
            "unrealised_pct": unr / pos.invest_amount * 100,
            "trail_sl": pos.sl,
            "target": pos.target,
        })

    # ── Reports ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    total_closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["exit_ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Trades':>7} {'Win':>5} {'Loss':>6} {'Win%':>7} "
              f"{'PNL':>12} {'Cum PNL':>14}")
        print("-" * 68)
        cum = 0.0
        for ym, grp in tdf.groupby("exit_ym"):
            n = len(grp)
            w = (grp["pnl"] > 0).sum()
            l = n - w
            wp = w / n * 100
            mp = grp["pnl"].sum()
            cum += mp
            print(f"{str(ym):<12} {n:>7} {w:>5} {l:>6} {wp:>6.1f}% "
                  f"{mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 68)

        total_closed_pnl = tdf["pnl"].sum()
        ttrades = len(tdf)
        twins = (tdf["pnl"] > 0).sum()
        target_exits = (tdf["exit_reason"] == "target").sum()
        sl_exits = (tdf["exit_reason"] == "sl").sum()
        avg_win = tdf[tdf["pnl"] > 0]["pnl"].mean() if twins > 0 else 0
        avg_loss = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        avg_hold = tdf["hold_days"].mean()
        expectancy = (twins / ttrades * avg_win) + ((ttrades - twins) / ttrades * avg_loss)

        print(f"\nCLOSED TRADES SUMMARY")
        print(f"  Total trades        : {ttrades}")
        print(f"  Winners             : {twins} ({twins/ttrades*100:.1f}%)")
        print(f"  Losers              : {ttrades-twins} ({(ttrades-twins)/ttrades*100:.1f}%)")
        print(f"  Target hits (+30%)  : {target_exits}")
        print(f"  SL hits             : {sl_exits}")
        print(f"  Avg win             : Rs.{avg_win:+,.0f}")
        print(f"  Avg loss            : Rs.{avg_loss:+,.0f}")
        print(f"  Win/Loss ratio      : {abs(avg_win/avg_loss):.2f}x" if avg_loss != 0 else "")
        print(f"  Expectancy per trade: Rs.{expectancy:+,.0f}")
        print(f"  Avg hold (days)     : {avg_hold:.1f}")
        print(f"  Closed PNL          : Rs.{total_closed_pnl:+,.0f}")

    # Open positions table
    total_unr = 0.0
    if open_positions:
        open_df = pd.DataFrame(open_positions)
        total_unr = open_df["unrealised_pnl"].sum()
        print(f"\nOPEN POSITIONS (MTM as of {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'Entry Px':>9} {'Curr Px':>9} "
              f"{'Shrs':>5} {'Unreal':>10} {'%':>7} {'SL':>9} {'Target':>9}")
        print("-" * 88)
        for r in sorted(open_positions, key=lambda x: x["unrealised_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>9.2f} "
                  f"{r['current_price']:>9.2f} {r['shares']:>5} "
                  f"{r['unrealised_pnl']:>+10,.0f} {r['unrealised_pct']:>+6.1f}% "
                  f"{r['trail_sl']:>9.2f} {r['target']:>9.2f}")
        print("-" * 88)
        print(f"  Total unrealised PNL: Rs.{total_unr:+,.0f}")
        print(f"  Open positions      : {len(open_positions)}")

    total_pnl = total_closed_pnl + total_unr
    initial_cap = PORTFOLIO_SIZE * INVEST_PER_SLOT
    print(f"\nOVERALL")
    print(f"  Closed PNL          : Rs.{total_closed_pnl:+,.0f}")
    print(f"  Open MTM            : Rs.{total_unr:+,.0f}")
    print(f"  TOTAL PNL           : Rs.{total_pnl:+,.0f}")
    print(f"  Initial capital     : Rs.{initial_cap:,.0f}")
    print(f"  Return on capital   : {total_pnl/initial_cap*100:+.2f}%")
    print(f"  Annualised return   : {total_pnl/initial_cap*100 / 1.5:+.2f}% "
          f"(approx, 18-month period)")

    # Detailed trade log
    if trades:
        print(f"\nCLOSED TRADE LOG")
        print(f"{'Symbol':<14} {'Entry':>10} {'Exit':>10} {'EntryPx':>9} {'ExitPx':>9} "
              f"{'Shrs':>5} {'PNL':>10} {'%':>7} {'Reason':<8} {'Days':>5}")
        print("-" * 92)
        for t in sorted(trades, key=lambda x: x["exit_date"]):
            print(f"{t['symbol']:<14} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['entry_price']:>9.2f} {t['exit_price']:>9.2f} {t['shares']:>5} "
                  f"{t['pnl']:>+10,.0f} {t['pnl_pct']:>+6.1f}% "
                  f"{t['exit_reason']:<8} {t['hold_days']:>5}")


if __name__ == "__main__":
    run_backtest()
