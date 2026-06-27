"""
Backtest — EMA Momentum Breakout Strategy

Entry rules (all must be true, checked daily):
  1. Nifty RSI(14) < 30  (oversold market filter — only enter on market dips)
  2. Price > EMA20 > EMA50 > EMA200  (stacked / aligned EMAs)
  3. Stock is ABOVE Supertrend (10, 3)  — direction is bullish
  4. RSI(14) > 50

Exit rule:
  - Close drops below EMA100

No RS ranking. Buy on next open after signal day.
"""

import os
import pandas as pd
import numpy as np
from datetime import date

ROOT     = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
IDX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")

NIFTY50 = [
    "ADANIENT","ADANIPORTS","APOLLOHOSP","ASIANPAINT","AXISBANK",
    "BAJAJ-AUTO","BAJAJFINSV","BAJFINANCE","BEL","BHARTIARTL",
    "CIPLA","COALINDIA","DRREDDY","EICHERMOT","ETERNAL",
    "GRASIM","HCLTECH","HDFCBANK","HDFCLIFE","HEROMOTOCO",
    "HINDALCO","HINDUNILVR","ICICIBANK","INDUSINDBK","INFY",
    "ITC","JIOFIN","KOTAKBANK","LT","M&M",
    "MARUTI","NESTLEIND","NTPC","ONGC","POWERGRID",
    "RELIANCE","SBILIFE","SBIN","SHRIRAMFIN","SUNPHARMA",
    "TATACONSUM","TATASTEEL","TCS","TECHM","TITAN",
    "TMCV","TMPV","TRENT","ULTRACEMCO","WIPRO",
]

START_DATE     = date(2026, 1, 1)
PORTFOLIO_SIZE = 10
INVEST_PER_STK = 20_000

ST_PERIOD     = 10    # Supertrend ATR period
ST_MULT       = 3.0   # Supertrend multiplier
RSI_PERIOD    = 14
NIFTY_RSI_MAX = 30    # market filter: only enter when Nifty RSI <= this (oversold)
COOLDOWN_DAYS = 5     # days to wait after an exit before re-entering the same stock


# ── data loading ───────────────────────────────────────────────────────────────

def load_stock(sym):
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    col_map = {"Datetime": "date", "Open": "open", "High": "high",
               "Low": "low", "Close": "close"}
    if "Volume" in df.columns:
        col_map["Volume"] = "volume"
    df = df.rename(columns=col_map)
    df["date"] = df["date"].dt.date
    cols = ["date", "open", "high", "low", "close"]
    if "volume" in df.columns:
        cols.append("volume")
    return df.sort_values("date").reset_index(drop=True)[cols]


def load_index():
    df = pd.read_csv(IDX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date", "close"]]


# ── indicator calculations ─────────────────────────────────────────────────────

def compute_supertrend(high: pd.Series, low: pd.Series, close: pd.Series,
                       period: int = 10, mult: float = 3.0):
    """Returns (supertrend Series, direction Series) where direction=1 is bullish."""
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr = tr.ewm(span=period, adjust=False).mean()

    hl2 = (high + low) / 2
    basic_ub = hl2 + mult * atr
    basic_lb = hl2 - mult * atr

    n = len(close)
    final_ub = np.full(n, np.nan)
    final_lb = np.full(n, np.nan)
    supertrend = np.full(n, np.nan)
    direction  = np.zeros(n, dtype=int)   # 1 = bullish, -1 = bearish

    for i in range(period, n):
        bub = basic_ub.iloc[i]
        blb = basic_lb.iloc[i]
        c   = close.iloc[i]
        pc  = close.iloc[i - 1]

        # Final upper band
        pfub = final_ub[i - 1] if not np.isnan(final_ub[i - 1]) else bub
        final_ub[i] = bub if (bub < pfub or pc > pfub) else pfub

        # Final lower band
        pflb = final_lb[i - 1] if not np.isnan(final_lb[i - 1]) else blb
        final_lb[i] = blb if (blb > pflb or pc < pflb) else pflb

        # Supertrend direction
        prev_st = supertrend[i - 1]
        prev_dir = direction[i - 1]
        if np.isnan(prev_st):
            # Initialise based on first close vs bands
            if c > final_ub[i]:
                supertrend[i] = final_lb[i]; direction[i] = 1
            else:
                supertrend[i] = final_ub[i]; direction[i] = -1
        elif prev_dir == -1:  # was bearish
            if c > final_ub[i]:
                supertrend[i] = final_lb[i]; direction[i] = 1
            else:
                supertrend[i] = final_ub[i]; direction[i] = -1
        else:  # was bullish
            if c < final_lb[i]:
                supertrend[i] = final_ub[i]; direction[i] = -1
            else:
                supertrend[i] = final_lb[i]; direction[i] = 1

    return pd.Series(supertrend, index=close.index), pd.Series(direction, index=close.index)


def compute_rsi(close: pd.Series, period: int = 14):
    delta = close.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs  = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


# ── build per-stock indicator tables ──────────────────────────────────────────

def build_tables(price_map: dict) -> dict:
    tables = {}
    for sym, df in price_map.items():
        c, h, l = df["close"], df["high"], df["low"]

        ema20  = c.ewm(span=20,  adjust=False).mean()
        ema50  = c.ewm(span=50,  adjust=False).mean()
        ema100 = c.ewm(span=100, adjust=False).mean()
        ema200 = c.ewm(span=200, adjust=False).mean()
        rsi    = compute_rsi(c, RSI_PERIOD)
        st, st_dir = compute_supertrend(h, l, c, ST_PERIOD, ST_MULT)

        dates = df["date"].tolist()
        tables[sym] = {
            "ema20":   dict(zip(dates, ema20)),
            "ema50":   dict(zip(dates, ema50)),
            "ema100":  dict(zip(dates, ema100)),
            "ema200":  dict(zip(dates, ema200)),
            "rsi":     dict(zip(dates, rsi)),
            "st":      dict(zip(dates, st)),
            "st_dir":  dict(zip(dates, st_dir)),
            "px":      {r.date: r for r in df.itertuples(index=False)},
        }
    return tables


# ── position ───────────────────────────────────────────────────────────────────

class Pos:
    def __init__(self, sym, entry_date, entry_price, shares):
        self.sym        = sym
        self.entry_date = entry_date
        self.ep         = entry_price
        self.shares     = shares
        self.invest     = entry_price * shares

    def pnl(self, exit_price):
        return (exit_price - self.ep) * self.shares

    def pnl_pct(self, exit_price):
        return self.pnl(exit_price) / self.invest * 100


# ── entry / exit logic ────────────────────────────────────────────────────────

def entry_signal(sym, d, t) -> bool:
    """True if all entry conditions are met on day d (signal to buy tomorrow's open)."""
    row = t["px"].get(d)
    if not row:
        return False
    c = float(row.close)

    e20  = t["ema20"].get(d)
    e50  = t["ema50"].get(d)
    e200 = t["ema200"].get(d)
    if any(x is None or (isinstance(x, float) and np.isnan(x)) for x in [e20, e50, e200]):
        return False
    # Stacked: price > EMA20 > EMA50 > EMA200
    if not (c > float(e20) > float(e50) > float(e200)):
        return False

    # Supertrend bullish
    st_dir = t["st_dir"].get(d)
    if st_dir is None or int(st_dir) != 1:
        return False

    # RSI > 50
    rsi = t["rsi"].get(d)
    if rsi is None or np.isnan(rsi) or float(rsi) <= 50:
        return False

    return True


def exit_signal(pos: Pos, d, t) -> str | None:
    """Returns exit reason string or None if no exit."""
    row = t["px"].get(d)
    if not row:
        return None
    c = float(row.close)

    e100 = t["ema100"].get(d)
    if e100 is not None and not np.isnan(e100) and c < float(e100):
        return "ema100"

    return None


# ── main backtest ──────────────────────────────────────────────────────────────

def run():
    print("=" * 72)
    print("EMA MOMENTUM BREAKOUT BACKTEST")
    print("=" * 72)
    print(f"  Universe      : Nifty 50")
    print(f"  Period        : {START_DATE} onwards")
    print(f"  Portfolio     : {PORTFOLIO_SIZE} stocks max")
    print(f"  Investment    : Rs.{INVEST_PER_STK:,} per stock")
    print(f"  Entry rules   : Nifty RSI({RSI_PERIOD}) < {NIFTY_RSI_MAX}  (oversold market filter)")
    print(f"                  Price > EMA20 > EMA50 > EMA200")
    print(f"                  Supertrend({ST_PERIOD},{ST_MULT}) bullish")
    print(f"                  RSI({RSI_PERIOD}) > 50")
    print(f"  Exit rule     : Close < EMA100")
    print(f"  Cooldown      : {COOLDOWN_DAYS} days after exit before re-entry")
    print()

    # Nifty RSI lookup (computed on full history so EWM is warm at START_DATE)
    idx_df   = load_index()
    idx_rsi  = compute_rsi(idx_df["close"], RSI_PERIOD)
    nifty_rsi: dict[date, float] = dict(zip(idx_df["date"].tolist(), idx_rsi))

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    print(f"  Loaded {len(price_map)} stocks\n")

    tables = build_tables(price_map)

    # Collect all unique trading days across all stocks, filtered to START_DATE+
    all_dates = sorted({d for df in price_map.values() for d in df["date"].tolist()
                        if d >= START_DATE})
    td_idx    = {d: i for i, d in enumerate(all_dates)}

    portfolio:    dict[str, Pos]  = {}
    trades:       list[dict]      = []
    last_exit:    dict[str, int]  = {}   # sym -> td_idx of last exit
    pending_buy:  dict[str, None] = {}   # syms signalled today, buy tomorrow's open

    for day_idx, day in enumerate(all_dates):

        # ── execute pending buys on today's open ─────────────────────────────
        for sym in list(pending_buy.keys()):
            if sym in portfolio or len(portfolio) >= PORTFOLIO_SIZE:
                continue
            t   = tables[sym]
            row = t["px"].get(day)
            if not row:
                continue
            ep    = float(row.open)
            sh    = max(1, int(INVEST_PER_STK // ep))
            portfolio[sym] = Pos(sym, day, ep, sh)
            print(f"  {day}: BUY   {sym:14s} @ {ep:.2f}  "
                  f"({sh} sh, invested Rs.{ep*sh:,.0f})")
        pending_buy.clear()

        # ── check exits for all open positions ────────────────────────────────
        for sym, pos in list(portfolio.items()):
            t      = tables[sym]
            reason = exit_signal(pos, day, t)
            if reason:
                row = t["px"].get(day)
                ep2 = float(row.close) if row else pos.ep
                pnl = pos.pnl(ep2)
                held = (day - pos.entry_date).days
                print(f"  {day}: SELL  {sym:14s} @ {ep2:.2f}  "
                      f"PNL Rs.{pnl:+,.0f} ({pos.pnl_pct(ep2):+.1f}%)  "
                      f"{held}d  [{reason}]")
                trades.append({
                    "symbol": sym, "entry_date": pos.entry_date,
                    "exit_date": day, "entry_price": pos.ep,
                    "exit_price": ep2, "shares": pos.shares,
                    "invest": pos.invest, "pnl": pnl,
                    "pnl_pct": pos.pnl_pct(ep2),
                    "exit_reason": reason,
                    "hold_days": held,
                })
                last_exit[sym] = day_idx
                del portfolio[sym]

        # ── scan for new entry signals ────────────────────────────────────────
        nrsi = nifty_rsi.get(day)
        nifty_ok = nrsi is not None and not np.isnan(nrsi) and float(nrsi) < NIFTY_RSI_MAX

        if len(portfolio) < PORTFOLIO_SIZE and nifty_ok:
            for sym in sorted(price_map.keys()):
                if sym in portfolio or sym in pending_buy:
                    continue
                # Cooldown check
                last = last_exit.get(sym, -9999)
                if day_idx - (last if isinstance(last, int) else td_idx.get(last, 0)) < COOLDOWN_DAYS:
                    continue
                t = tables[sym]
                if entry_signal(sym, day, t):
                    pending_buy[sym] = None

    # ── MTM open positions ────────────────────────────────────────────────────
    last_day  = all_dates[-1]
    open_list = []
    for sym, pos in portfolio.items():
        row = tables[sym]["px"].get(last_day)
        if not row:
            continue
        curr = float(row.close)
        unr  = pos.pnl(curr)
        open_list.append({
            "symbol": sym, "entry_date": pos.entry_date,
            "entry_price": pos.ep, "current": curr,
            "shares": pos.shares, "invest": pos.invest,
            "unr_pnl": unr, "unr_pct": unr / pos.invest * 100,
        })

    # ── report ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Tr':>4} {'W':>4} {'L':>4} {'Win%':>6} {'PNL':>12} {'Cum':>14}")
        print("-" * 62)
        cum = 0.0
        for ym, g in tdf.groupby("ym"):
            n  = len(g); w = (g["pnl"] > 0).sum()
            mp = g["pnl"].sum(); cum += mp
            print(f"{str(ym):<12} {n:>4} {w:>4} {n-w:>4} "
                  f"{w/n*100:>5.0f}% {mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 62)

        closed_pnl = tdf["pnl"].sum()
        n   = len(tdf); w = (tdf["pnl"] > 0).sum()
        e100 = (tdf["exit_reason"] == "ema100").sum()
        aw  = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0
        al  = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        exp = (w / n * aw) + ((n - w) / n * al)

        best  = tdf.nlargest(5,  "pnl_pct")[["symbol","entry_date","exit_date","pnl_pct","pnl","hold_days","exit_reason"]]
        worst = tdf.nsmallest(5, "pnl_pct")[["symbol","entry_date","exit_date","pnl_pct","pnl","hold_days","exit_reason"]]

        print(f"\nCLOSED TRADES ({n} total: {e100} EMA100 exits)")
        print(f"  Win rate    : {w}/{n} = {w/n*100:.1f}%")
        print(f"  Avg win     : Rs.{aw:+,.0f}")
        print(f"  Avg loss    : Rs.{al:+,.0f}")
        if al: print(f"  W:L ratio   : {abs(aw/al):.2f}x")
        print(f"  Expectancy  : Rs.{exp:+,.0f} / trade")
        print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")

        print(f"\n  Top 5 winners:")
        for _, r in best.iterrows():
            print(f"    {r['symbol']:<14} {str(r['entry_date']):>10} -> {str(r['exit_date']):<10}  "
                  f"{r['pnl_pct']:>+6.1f}%  Rs.{r['pnl']:>+,.0f}  {r['hold_days']}d  [{r['exit_reason']}]")
        print(f"\n  Top 5 losers:")
        for _, r in worst.iterrows():
            print(f"    {r['symbol']:<14} {str(r['entry_date']):>10} -> {str(r['exit_date']):<10}  "
                  f"{r['pnl_pct']:>+6.1f}%  Rs.{r['pnl']:>+,.0f}  {r['hold_days']}d  [{r['exit_reason']}]")

    unr_pnl = sum(r["unr_pnl"] for r in open_list) if open_list else 0.0
    if open_list:
        print(f"\nOPEN POSITIONS (MTM {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'EntryPx':>8} {'Curr':>9} "
              f"{'Shrs':>5} {'Unrealised':>12} {'%':>7}")
        print("-" * 72)
        for r in sorted(open_list, key=lambda x: x["unr_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current']:>9.2f} {r['shares']:>5} "
                  f"{r['unr_pnl']:>+12,.0f} {r['unr_pct']:>+6.1f}%")
        print("-" * 72)
        print(f"  Total unrealised: Rs.{unr_pnl:+,.0f}   Open slots: {PORTFOLIO_SIZE - len(open_list)}")

    total    = closed_pnl + unr_pnl
    init_cap = PORTFOLIO_SIZE * INVEST_PER_STK
    print(f"\nOVERALL")
    print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")
    print(f"  Open MTM    : Rs.{unr_pnl:+,.0f}")
    print(f"  TOTAL PNL   : Rs.{total:+,.0f}")
    print(f"  Capital     : Rs.{init_cap:,.0f}  ({PORTFOLIO_SIZE} x {INVEST_PER_STK:,})")
    print(f"  Return      : {total/init_cap*100:+.2f}%")
    period_yrs = (all_dates[-1] - all_dates[0]).days / 365.25
    print(f"  Annualised  : {total/init_cap*100/period_yrs:+.2f}%  ({period_yrs:.1f} yr period)")

    if trades:
        print(f"\nCLOSED TRADE LOG")
        print(f"{'Symbol':<14} {'Entry':>10} {'Exit':>10} {'EntryPx':>8} {'ExitPx':>8} "
              f"{'Shrs':>5} {'PNL':>10} {'%':>7} {'Reason':<12} {'Days':>5}")
        print("-" * 90)
        for t in sorted(trades, key=lambda x: x["exit_date"]):
            print(f"{t['symbol']:<14} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['entry_price']:>8.2f} {t['exit_price']:>8.2f} {t['shares']:>5} "
                  f"{t['pnl']:>+10,.0f} {t['pnl_pct']:>+6.1f}% "
                  f"{t['exit_reason']:<12} {t['hold_days']:>5}")


if __name__ == "__main__":
    run()
