"""
Backtest: Nifty 50 RS-ranked equity strategy
- Start: Jan 1, 2025
- Universe: 50 Nifty 50 stocks
- Ranking: Mansfield RS vs Nifty 50 index (126-day / 6-month lookback)
- Portfolio: Top 20 stocks, 10,000 INR invested in each at entry
- SL: 10% below entry price, trailing (SL rises 1 rupee per rupee of price gain)
  => SL = highest_price_since_entry - (entry_price * 0.10)
- Target: 30% above entry price
- On exit: replace with highest-ranked eligible stock not in portfolio
  (if exited stock is still in top 20, skip it and take #21)
"""

import os
import sys
import pandas as pd
import numpy as np
from datetime import datetime, date
from collections import defaultdict

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
INDEX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")

# ── Nifty 50 universe (excluding the index itself) ─────────────────────────────
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

# Strategy parameters
START_DATE = date(2025, 1, 1)
INVEST_PER_STOCK = 10_000       # INR
PORTFOLIO_SIZE = 20             # top N stocks
RS_LOOKBACK = 126               # trading days (~6 months)
SL_PCT = 0.10                   # 10% stop-loss
TARGET_PCT = 0.30               # 30% profit target


# ── Data loading ───────────────────────────────────────────────────────────────

def load_stock(symbol: str) -> pd.DataFrame | None:
    path = os.path.join(DATA_DIR, f"{symbol}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Open": "open", "High": "high",
                             "Low": "low", "Close": "close", "Volume": "volume"})
    df["date"] = df["date"].dt.date
    df = df.sort_values("date").reset_index(drop=True)
    return df[["date", "open", "high", "low", "close", "volume"]]


def load_index() -> pd.DataFrame:
    df = pd.read_csv(INDEX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Open": "open", "High": "high",
                             "Low": "low", "Close": "close", "Volume": "volume"})
    df["date"] = df["date"].dt.date
    df = df.sort_values("date").reset_index(drop=True)
    return df[["date", "close"]]


# ── RS calculation ─────────────────────────────────────────────────────────────

def compute_rs_ratio(stock_closes: pd.Series, index_closes: pd.Series,
                     lookback: int = RS_LOOKBACK) -> float:
    """Mansfield RS ratio at the latest point."""
    if len(stock_closes) <= lookback or len(index_closes) <= lookback:
        return 0.0
    s_curr = stock_closes.iloc[-1]
    s_base = stock_closes.iloc[-1 - lookback]
    i_curr = index_closes.iloc[-1]
    i_base = index_closes.iloc[-1 - lookback]
    if s_base == 0 or i_base == 0:
        return 0.0
    return ((s_curr / s_base) / (i_curr / i_base)) - 1


def rank_stocks(price_map: dict, index_close_series: pd.Series,
                idx_pos: int, as_of_date: date) -> list[tuple[str, float]]:
    """
    Returns list of (symbol, rs_ratio) sorted best -> worst (rank 1 = best).
    price_map: {symbol: DataFrame with columns date/close}
    idx_pos: position in index_close_series corresponding to as_of_date
    """
    scores = []
    for sym, df in price_map.items():
        # align stock data up to as_of_date
        stock_slice = df[df["date"] <= as_of_date]["close"]
        index_slice = index_close_series.iloc[:idx_pos + 1]
        rs = compute_rs_ratio(stock_slice, index_slice)
        scores.append((sym, rs))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


# ── Trade tracking ─────────────────────────────────────────────────────────────

class Position:
    def __init__(self, symbol: str, entry_date: date, entry_price: float,
                 shares: int, invest_amount: float):
        self.symbol = symbol
        self.entry_date = entry_date
        self.entry_price = entry_price
        self.shares = shares
        self.invest_amount = invest_amount
        self.sl = entry_price * (1 - SL_PCT)
        self.target = entry_price * (1 + TARGET_PCT)
        self.highest_price = entry_price
        # trailing: SL rises by 1 rs for each 1 rs the price rises above entry
        # SL = highest_price - (entry_price * SL_PCT)
        self.trail_rupees = entry_price * SL_PCT   # fixed rupee trail distance

    def update(self, high: float, low: float) -> str | None:
        """
        Simulate intraday: check if target or SL hit.
        Returns 'target', 'sl', or None.
        Uses high to update trailing SL, then checks low vs SL and high vs target.
        """
        # Update trailing SL from today's high
        if high > self.highest_price:
            self.highest_price = high
            self.sl = self.highest_price - self.trail_rupees

        # Check target first (assuming favorable order: target before SL on up days)
        if high >= self.target:
            return "target"
        if low <= self.sl:
            return "sl"
        return None

    def exit_price(self, exit_reason: str, open_price: float,
                   high: float, low: float) -> float:
        """Return realistic exit price for the given reason."""
        if exit_reason == "target":
            return self.target  # limit order at target
        else:
            # SL hit: if gap-down open below SL, exit at open
            return min(self.sl, open_price) if open_price < self.sl else self.sl

    def pnl(self, exit_px: float) -> float:
        return (exit_px - self.entry_price) * self.shares


# ── Main backtest ──────────────────────────────────────────────────────────────

def run_backtest():
    print("Loading data...")

    # Load index
    index_df = load_index()
    index_dates = list(index_df["date"])
    index_closes = index_df["close"]

    # Load all stocks
    price_map: dict[str, pd.DataFrame] = {}
    for sym in NIFTY50_STOCKS:
        df = load_stock(sym)
        if df is not None:
            price_map[sym] = df
        else:
            print(f"  WARNING: No data for {sym}")

    available_stocks = list(price_map.keys())
    print(f"  Loaded {len(available_stocks)} stocks")

    # Build trading day calendar from index
    trading_days = [d for d in index_dates if d >= START_DATE]
    print(f"  Trading days from {trading_days[0]} to {trading_days[-1]}: {len(trading_days)}")

    # Build per-stock price lookup {symbol: {date: row}}
    stock_lookup: dict[str, dict[date, dict]] = {}
    for sym, df in price_map.items():
        stock_lookup[sym] = {row.date: row for row in df.itertuples(index=False)}

    # ── Initialise on first trading day ≥ START_DATE ──────────────────────────
    first_day = trading_days[0]
    idx_pos = index_dates.index(first_day)

    print(f"\nRanking stocks on {first_day}...")
    ranked = rank_stocks(price_map, index_closes, idx_pos, first_day)
    print(f"  Top 5: {[(s, round(r, 4)) for s, r in ranked[:5]]}")

    # Open initial 20 positions
    portfolio: dict[str, Position] = {}
    for sym, rs in ranked[:PORTFOLIO_SIZE]:
        row = stock_lookup[sym].get(first_day)
        if row is None:
            continue
        entry_price = row.open  # buy at open on the first day
        shares = int(INVEST_PER_STOCK // entry_price)
        if shares == 0:
            shares = 1
        pos = Position(sym, first_day, entry_price, shares, entry_price * shares)
        portfolio[sym] = pos
        print(f"  BUY {sym}: {shares} shares @ {entry_price:.2f} "
              f"(invest {entry_price * shares:.0f})")

    # ── Trade log ──────────────────────────────────────────────────────────────
    trades: list[dict] = []
    cash_flow: list[dict] = []  # for reporting

    total_invested = sum(p.entry_price * p.shares for p in portfolio.values())
    print(f"\nInitial investment: Rs.{total_invested:,.0f} across {len(portfolio)} stocks\n")

    # ── Day-by-day simulation ──────────────────────────────────────────────────
    for day in trading_days[1:]:
        idx_pos = index_dates.index(day)

        exits_today = []

        # Check all open positions
        for sym, pos in list(portfolio.items()):
            row = stock_lookup[sym].get(day)
            if row is None:
                continue

            result = pos.update(row.high, row.low)
            if result:
                exit_px = pos.exit_price(result, row.open, row.high, row.low)
                pnl = pos.pnl(exit_px)
                trade = {
                    "symbol": sym,
                    "entry_date": pos.entry_date,
                    "exit_date": day,
                    "entry_price": pos.entry_price,
                    "exit_price": exit_px,
                    "shares": pos.shares,
                    "invest": pos.invest_amount,
                    "pnl": pnl,
                    "pnl_pct": pnl / pos.invest_amount * 100,
                    "exit_reason": result,
                    "hold_days": (day - pos.entry_date).days,
                }
                trades.append(trade)
                exits_today.append((sym, trade))
                del portfolio[sym]

        # Replace exited stocks
        if exits_today:
            # Get fresh rankings
            ranked_now = rank_stocks(price_map, index_closes, idx_pos, day)
            top20_now = {s for s, _ in ranked_now[:PORTFOLIO_SIZE]}
            in_portfolio = set(portfolio.keys())

            for exited_sym, trade in exits_today:
                # Find replacement
                replacement = None
                for i, (sym, rs) in enumerate(ranked_now):
                    if sym in in_portfolio:
                        continue
                    # If exited stock is still in top 20, skip to #21+
                    if exited_sym in top20_now and i < PORTFOLIO_SIZE:
                        continue
                    replacement = sym
                    break

                if replacement is None:
                    print(f"  {day}: No replacement found for {exited_sym}")
                    continue

                row = stock_lookup[replacement].get(day)
                if row is None:
                    print(f"  {day}: No price data for replacement {replacement}")
                    continue

                entry_price = row.close  # buy at close on exit day
                shares = int(INVEST_PER_STOCK // entry_price)
                if shares == 0:
                    shares = 1
                pos = Position(replacement, day, entry_price, shares, entry_price * shares)
                portfolio[replacement] = pos
                in_portfolio.add(replacement)

                print(f"  {day}: EXIT {exited_sym} ({trade['exit_reason']}, "
                      f"PNL Rs.{trade['pnl']:+.0f} / {trade['pnl_pct']:+.1f}%) "
                      f"-> BUY {replacement}: {shares} @ {entry_price:.2f}")

    # ── Mark-to-market for open positions ─────────────────────────────────────
    last_day = trading_days[-1]
    open_positions = []
    for sym, pos in portfolio.items():
        row = stock_lookup[sym].get(last_day)
        if row is None:
            continue
        curr_price = row.close
        unrealised_pnl = (curr_price - pos.entry_price) * pos.shares
        open_positions.append({
            "symbol": sym,
            "entry_date": pos.entry_date,
            "entry_price": pos.entry_price,
            "current_price": curr_price,
            "shares": pos.shares,
            "invest": pos.invest_amount,
            "unrealised_pnl": unrealised_pnl,
            "unrealised_pct": unrealised_pnl / pos.invest_amount * 100,
            "trailing_sl": pos.sl,
        })

    # ── Month-wise PNL report ──────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("BACKTEST RESULTS — Nifty 50 RS Strategy (Jan 2025 to present)")
    print("=" * 70)

    if trades:
        trades_df = pd.DataFrame(trades)
        trades_df["exit_ym"] = pd.to_datetime(trades_df["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'#Trades':>8} {'#Win':>6} {'#Loss':>6} {'Win%':>7} {'PNL (Rs.)':>12} {'Cum PNL (Rs.)':>14}")
        print("-" * 70)

        cum_pnl = 0.0
        monthly = trades_df.groupby("exit_ym")

        for ym, grp in monthly:
            n = len(grp)
            wins = (grp["pnl"] > 0).sum()
            losses = (grp["pnl"] < 0).sum()
            win_pct = wins / n * 100 if n > 0 else 0
            month_pnl = grp["pnl"].sum()
            cum_pnl += month_pnl
            print(f"{str(ym):<12} {n:>8} {wins:>6} {losses:>6} {win_pct:>6.1f}%"
                  f" {month_pnl:>+12,.0f} {cum_pnl:>+14,.0f}")

        print("-" * 70)

        # Summary stats
        total_pnl = trades_df["pnl"].sum()
        total_trades = len(trades_df)
        total_wins = (trades_df["pnl"] > 0).sum()
        avg_win = trades_df[trades_df["pnl"] > 0]["pnl"].mean() if total_wins > 0 else 0
        avg_loss = trades_df[trades_df["pnl"] < 0]["pnl"].mean() if (trades_df["pnl"] < 0).any() else 0
        avg_hold = trades_df["hold_days"].mean()

        target_exits = (trades_df["exit_reason"] == "target").sum()
        sl_exits = (trades_df["exit_reason"] == "sl").sum()

        print(f"\n{'CLOSED TRADES SUMMARY':}")
        print(f"  Total closed trades : {total_trades}")
        print(f"  Winners             : {total_wins} ({total_wins/total_trades*100:.1f}%)")
        print(f"  Losers              : {total_trades - total_wins} ({(total_trades - total_wins)/total_trades*100:.1f}%)")
        print(f"  Target hits         : {target_exits}")
        print(f"  SL hits             : {sl_exits}")
        print(f"  Avg win             : Rs.{avg_win:+,.0f}")
        print(f"  Avg loss            : Rs.{avg_loss:+,.0f}")
        print(f"  Avg hold (days)     : {avg_hold:.1f}")
        print(f"  Total closed PNL    : Rs.{total_pnl:+,.0f}")
    else:
        print("\n  No closed trades yet.")
        total_pnl = 0

    # Open positions
    if open_positions:
        open_df = pd.DataFrame(open_positions)
        total_unrealised = open_df["unrealised_pnl"].sum()
        print(f"\n{'OPEN POSITIONS (mark-to-market as of ' + str(last_day) + ')':}")
        print(f"{'Symbol':<14} {'Entry Date':<12} {'Entry':>8} {'Current':>9} {'Shares':>7} "
              f"{'Unrealised':>12} {'%':>7} {'Trail SL':>10}")
        print("-" * 80)
        for r in sorted(open_positions, key=lambda x: x["unrealised_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current_price']:>9.2f} {r['shares']:>7} "
                  f"{r['unrealised_pnl']:>+12,.0f} {r['unrealised_pct']:>+6.1f}% "
                  f"{r['trailing_sl']:>10.2f}")
        print("-" * 80)
        print(f"  Total unrealised PNL: Rs.{total_unrealised:+,.0f}")
    else:
        total_unrealised = 0

    total_overall = total_pnl + total_unrealised
    print(f"\n{'OVERALL PNL (closed + open MTM)':}")
    print(f"  Closed PNL          : Rs.{total_pnl:+,.0f}")
    print(f"  Open MTM            : Rs.{total_unrealised:+,.0f}")
    print(f"  TOTAL PNL           : Rs.{total_overall:+,.0f}")
    initial_capital = PORTFOLIO_SIZE * INVEST_PER_STOCK
    print(f"  Initial capital     : Rs.{initial_capital:,.0f}")
    print(f"  Return on capital   : {total_overall / initial_capital * 100:+.2f}%")

    # Detailed trade log
    if trades:
        print(f"\n{'CLOSED TRADE LOG':}")
        print(f"{'Symbol':<14} {'Entry':>10} {'Exit':>10} {'Entry Px':>9} {'Exit Px':>9} "
              f"{'Shares':>7} {'PNL':>10} {'%':>7} {'Reason':<8} {'Days':>5}")
        print("-" * 90)
        for t in sorted(trades, key=lambda x: x["exit_date"]):
            print(f"{t['symbol']:<14} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['entry_price']:>9.2f} {t['exit_price']:>9.2f} {t['shares']:>7} "
                  f"{t['pnl']:>+10,.0f} {t['pnl_pct']:>+6.1f}% {t['exit_reason']:<8} {t['hold_days']:>5}")


if __name__ == "__main__":
    run_backtest()
