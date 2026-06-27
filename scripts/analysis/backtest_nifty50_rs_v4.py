"""
Backtest v4: Nifty 50 RS-ranked equity strategy (momentum rebalancing)

New in v4:
  1. Monthly rebalancing: on 1st regime-ON day each month, exit positions that
     fell out of RS top-30 AND have been held > 45 days. Redeploy capital.
  2. Rate-limit entries: max 5 new positions per day (prevents mass-entry risk
     of filling all 20 slots on a single day before a correction).
  3. SL thresholds widened: breakeven at +15% (was +10%), trail at 10% below
     peak only when peak gain >= +25% (was +20%).
  4. All other v3 improvements retained.
"""

import os
import pandas as pd
import numpy as np
from datetime import date

ROOT     = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
IDX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")

NIFTY50 = [
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
START_DATE         = date(2025, 1, 1)
INVEST_PER_SLOT    = 10_000
MAX_INVEST         = 15_000
PORTFOLIO_SIZE     = 20
RS_LOOKBACK        = 126        # 6-month Mansfield RS
SMA_PERIOD         = 50
MOM_PERIOD         = 63         # 3-month momentum for regime
SL_PCT             = 0.10
TARGET_PCT         = 0.30
BREAKEVEN_TRIGGER  = 0.15       # move SL to breakeven when peak +15%
TRAIL_TRIGGER      = 0.25       # trail 10% below peak when peak +25%
REBAL_HOLDOUT_DAYS = 45         # only rebalance positions held > 45 days
REBAL_KEEP_TOP_N   = 30         # keep if still in RS top 30
SYM_COOLDOWN_DAYS  = 10
MAX_NEW_PER_DAY    = 5          # rate-limit new entries


# ── Data loading ───────────────────────────────────────────────────────────────

def load_index() -> pd.DataFrame:
    df = pd.read_csv(IDX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date", "close"]]


def load_stock(sym: str) -> pd.DataFrame | None:
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Open": "open", "High": "high",
                             "Low": "low", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[
        ["date", "open", "high", "low", "close"]
    ]


# ── Precomputation ─────────────────────────────────────────────────────────────

def build_regime(index_df: pd.DataFrame):
    c = index_df["close"]
    s50 = c.rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()
    m63 = c > c.shift(MOM_PERIOD)
    dates = list(index_df["date"])
    regime = set()
    for i, d in enumerate(dates):
        if not pd.isna(s50.iloc[i]) and bool(c.iloc[i] > s50.iloc[i]) and bool(m63.iloc[i]):
            regime.add(d)
    return dates, c, regime


def build_stock_tables(price_map: dict):
    sma_lkp   = {}
    price_lkp = {}
    for sym, df in price_map.items():
        s50 = df["close"].rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()
        sma_lkp[sym]   = dict(zip(df["date"], s50))
        price_lkp[sym] = {r.date: r for r in df.itertuples(index=False)}
    return sma_lkp, price_lkp


def rank_universe(price_map, idx_closes, idx_pos, as_of):
    n = RS_LOOKBACK
    scores = []
    for sym, df in price_map.items():
        sc = df[df["date"] <= as_of]["close"]
        ic = idx_closes.iloc[:idx_pos + 1]
        if len(sc) <= n or len(ic) <= n:
            scores.append((sym, 0.0))
            continue
        sb, s_c = sc.iloc[-1 - n], sc.iloc[-1]
        ib, i_c = ic.iloc[-1 - n], ic.iloc[-1]
        rs = ((s_c / sb) / (i_c / ib) - 1) if sb and ib else 0.0
        scores.append((sym, rs))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


# ── Position ───────────────────────────────────────────────────────────────────

class Pos:
    def __init__(self, sym, entry_date, ep, shares):
        self.sym        = sym
        self.entry_date = entry_date
        self.ep         = ep
        self.shares     = shares
        self.invest     = ep * shares
        self.peak       = ep
        self.sl         = ep * (1 - SL_PCT)
        self.target     = ep * (1 + TARGET_PCT)

    def update(self, hi, lo):
        if hi > self.peak:
            self.peak = hi
        pg = (self.peak / self.ep) - 1
        if pg >= TRAIL_TRIGGER:
            trail = self.peak * (1 - SL_PCT)
        elif pg >= BREAKEVEN_TRIGGER:
            trail = self.ep
        else:
            trail = self.ep * (1 - SL_PCT)
        self.sl = max(self.sl, trail)
        if hi >= self.target:
            return "target"
        if lo <= self.sl:
            return "sl"
        return None

    def exit_px(self, reason, open_px):
        if reason == "target":
            return self.target
        if reason == "rebal":
            return open_px   # close at open on rebalance day
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2):
        return (ep2 - self.ep) * self.shares

    def unr(self, curr):
        return (curr - self.ep) * self.shares


# ── Backtest ───────────────────────────────────────────────────────────────────

def run():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v4  (monthly rebalancing + rate-limited entry)")
    print("=" * 72)

    idx_df               = load_index()
    idx_dates, idx_c, regime = build_regime(idx_df)

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    print(f"  Loaded {len(price_map)} stocks")

    sma_lkp, px_lkp = build_stock_tables(price_map)
    trading_days     = [d for d in idx_dates if d >= START_DATE]
    print(f"  Backtest: {trading_days[0]} to {trading_days[-1]}")
    print(f"  First regime-ON: {next((d for d in trading_days if d in regime), None)}")

    # ── State ──────────────────────────────────────────────────────────────────
    portfolio: dict[str, Pos] = {}
    trades:    list[dict]     = []
    sl_hit:    dict[str, int] = {}        # sym -> day_idx of last SL
    rebal_month: int          = -1        # month of last rebalance

    def regime_on(d):
        return d in regime

    def ok_to_buy(sym, d, rs, day_idx):
        if rs <= 0:
            return False
        if day_idx - sl_hit.get(sym, -9999) < SYM_COOLDOWN_DAYS:
            return False
        s50 = sma_lkp[sym].get(d)
        row = px_lkp[sym].get(d)
        if s50 is None or row is None or pd.isna(s50):
            return False
        return float(row.close) > float(s50)

    def record_trade(sym, pos, exit_date, ep2, reason, in_portfolio):
        pnl = pos.pnl(ep2)
        trades.append({
            "symbol":     sym, "entry_date": pos.entry_date,
            "exit_date":  exit_date, "entry_price": pos.ep,
            "exit_price": ep2, "shares": pos.shares,
            "invest":     pos.invest, "pnl": pnl,
            "pnl_pct":    pnl / pos.invest * 100,
            "exit_reason": reason,
            "hold_days":  (exit_date - pos.entry_date).days,
        })
        if reason == "sl":
            sl_hit[sym] = trading_days.index(exit_date)
        del portfolio[sym]

    def do_buy(sym, d, rs):
        row = px_lkp[sym].get(d)
        if row is None:
            return False
        ep = float(row.close)
        shares = max(1, int(MAX_INVEST // ep))
        portfolio[sym] = Pos(sym, d, ep, shares)
        return True

    # ── Main loop ──────────────────────────────────────────────────────────────
    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_dates.index(day)

        # 1. Process SL / target exits
        for sym, pos in list(portfolio.items()):
            row = px_lkp[sym].get(day)
            if row is None:
                continue
            result = pos.update(float(row.high), float(row.low))
            if result:
                ep2 = pos.exit_px(result, float(row.open))
                record_trade(sym, pos, day, ep2, result, portfolio)

        # 2. Monthly rebalancing (1st regime-ON day of each month)
        if regime_on(day) and day.month != rebal_month:
            rebal_month = day.month
            ranked     = rank_universe(price_map, idx_c, idx_pos, day)
            top_n      = {s for s, _ in ranked[:REBAL_KEEP_TOP_N]}
            rs_dict    = {s: r for s, r in ranked}
            exits      = []

            for sym, pos in list(portfolio.items()):
                held = (day - pos.entry_date).days
                if held > REBAL_HOLDOUT_DAYS and sym not in top_n:
                    row = px_lkp[sym].get(day)
                    ep2 = float(row.open) if row else pos.ep
                    exits.append((sym, pos, ep2))

            for sym, pos, ep2 in exits:
                pnl = pos.pnl(ep2)
                print(f"  {day}: REBAL EXIT {sym} after {(day-pos.entry_date).days}d "
                      f"(RS rank {next((i+1 for i,(s,_) in enumerate(ranked) if s==sym), '?')}) "
                      f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                trades.append({
                    "symbol": sym, "entry_date": pos.entry_date,
                    "exit_date": day, "entry_price": pos.ep, "exit_price": ep2,
                    "shares": pos.shares, "invest": pos.invest,
                    "pnl": pnl, "pnl_pct": pnl / pos.invest * 100,
                    "exit_reason": "rebal", "hold_days": (day - pos.entry_date).days,
                })
                del portfolio[sym]

        # 3. Fill empty slots (regime ON, rate-limited)
        empty = PORTFOLIO_SIZE - len(portfolio)
        if empty > 0 and regime_on(day):
            ranked  = rank_universe(price_map, idx_c, idx_pos, day)
            in_ptf  = set(portfolio.keys())
            filled  = 0
            for sym, rs in ranked:
                if filled >= min(empty, MAX_NEW_PER_DAY):
                    break
                if sym in in_ptf:
                    continue
                if not ok_to_buy(sym, day, rs, day_idx):
                    continue
                if do_buy(sym, day, rs):
                    in_ptf.add(sym)
                    filled += 1
                    pos = portfolio[sym]
                    print(f"  {day}: BUY {sym}: {pos.shares} @ {pos.ep:.2f} (RS {rs:+.3f})")

    # ── MTM ────────────────────────────────────────────────────────────────────
    last_day = trading_days[-1]
    open_list = []
    for sym, pos in portfolio.items():
        row = px_lkp[sym].get(last_day)
        if not row:
            continue
        curr = float(row.close)
        unr  = pos.unr(curr)
        open_list.append({
            "symbol": sym, "entry_date": pos.entry_date,
            "entry_price": pos.ep, "current": curr,
            "shares": pos.shares, "invest": pos.invest,
            "unr_pnl": unr, "unr_pct": unr / pos.invest * 100,
            "sl": pos.sl, "target": pos.target,
        })

    # ── Report ─────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Tr':>4} {'W':>4} {'L':>4} {'R':>4} {'Win%':>6} "
              f"{'PNL':>12} {'Cum PNL':>14}")
        print("-" * 65)
        cum = 0.0
        for ym, g in tdf.groupby("ym"):
            n  = len(g)
            w  = (g["pnl"] > 0).sum()
            l  = (g["pnl"] < 0).sum()
            r  = (g["exit_reason"] == "rebal").sum()
            mp = g["pnl"].sum(); cum += mp
            print(f"{str(ym):<12} {n:>4} {w:>4} {l:>4} {r:>4} {w/n*100:>5.0f}% "
                  f"{mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 65)

        closed_pnl = tdf["pnl"].sum()
        n  = len(tdf)
        w  = (tdf["pnl"] > 0).sum()
        tgt = (tdf["exit_reason"] == "target").sum()
        sl  = (tdf["exit_reason"] == "sl").sum()
        rb  = (tdf["exit_reason"] == "rebal").sum()
        aw  = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0
        al  = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        exp = (w / n * aw) + ((n - w) / n * al)

        print(f"\nCLOSED TRADES ({n} total)")
        print(f"  Winners       : {w} ({w/n*100:.1f}%)")
        print(f"  Losers        : {n-w} ({(n-w)/n*100:.1f}%)")
        print(f"  Target exits  : {tgt}   SL exits: {sl}   Rebal exits: {rb}")
        print(f"  Avg win       : Rs.{aw:+,.0f}")
        print(f"  Avg loss      : Rs.{al:+,.0f}")
        if al:
            print(f"  W:L ratio     : {abs(aw/al):.2f}x")
        print(f"  Expectancy    : Rs.{exp:+,.0f} per trade")
        print(f"  Best trade    : Rs.{tdf['pnl'].max():+,.0f}")
        print(f"  Worst trade   : Rs.{tdf['pnl'].min():+,.0f}")
        print(f"  Avg hold days : {tdf['hold_days'].mean():.1f}")
        print(f"  Closed PNL    : Rs.{closed_pnl:+,.0f}")

    unr_pnl = 0.0
    if open_list:
        unr_pnl = sum(r["unr_pnl"] for r in open_list)
        print(f"\nOPEN POSITIONS (MTM {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'EntryPx':>8} {'Curr':>9} "
              f"{'Shrs':>5} {'Unreal':>10} {'%':>7} {'SL':>9}")
        print("-" * 82)
        for r in sorted(open_list, key=lambda x: x["unr_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current']:>9.2f} {r['shares']:>5} {r['unr_pnl']:>+10,.0f} "
                  f"{r['unr_pct']:>+6.1f}% {r['sl']:>9.2f}")
        print("-" * 82)
        print(f"  Total unrealised: Rs.{unr_pnl:+,.0f}   Open slots: {PORTFOLIO_SIZE-len(open_list)}")

    total    = closed_pnl + unr_pnl
    init_cap = PORTFOLIO_SIZE * INVEST_PER_SLOT
    print(f"\nOVERALL")
    print(f"  Closed PNL   : Rs.{closed_pnl:+,.0f}")
    print(f"  Open MTM     : Rs.{unr_pnl:+,.0f}")
    print(f"  TOTAL PNL    : Rs.{total:+,.0f}")
    print(f"  Capital      : Rs.{init_cap:,.0f}")
    print(f"  Return       : {total/init_cap*100:+.2f}%")
    print(f"  Annualised   : {total/init_cap*100/1.5:+.2f}% (~18 month period)")

    # Trade log
    if trades:
        print(f"\nCLOSED TRADE LOG")
        print(f"{'Symbol':<14} {'Entry':>10} {'Exit':>10} {'EntryPx':>8} {'ExitPx':>8} "
              f"{'Shrs':>5} {'PNL':>10} {'%':>7} {'Rsn':<8} {'Days':>5}")
        print("-" * 90)
        for t in sorted(trades, key=lambda x: x["exit_date"]):
            print(f"{t['symbol']:<14} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['entry_price']:>8.2f} {t['exit_price']:>8.2f} {t['shares']:>5} "
                  f"{t['pnl']:>+10,.0f} {t['pnl_pct']:>+6.1f}% "
                  f"{t['exit_reason']:<8} {t['hold_days']:>5}")


if __name__ == "__main__":
    run()
