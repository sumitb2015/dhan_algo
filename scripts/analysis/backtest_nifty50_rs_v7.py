"""
Backtest v7: v6 + three entry-quality filters

New in v7 vs v6:
  1. REGIME_CONFIRM_DAYS = 5  — no new entries until Nifty has been in regime for
     5 consecutive ON days. Prevents mass-entry on first day of a false break.
  2. RS Acceleration — stock's RS score must be HIGHER than its RS 10 trading
     days ago. Skips names that were strong but are now fading.
  3. 52-week High Proximity — stock must be within HIGH_PROXIMITY (5%) of its
     252-day closing high. Buys breakout leaders, not laggards.

All v6 parameters and exit logic unchanged.
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

START_DATE          = date(2025, 1, 1)
INVEST_PER_SLOT     = 10_000
MAX_INVEST          = 15_000
PORTFOLIO_SIZE      = 20
RS_LOOKBACK         = 126
SMA_PERIOD          = 50
MOM_PERIOD          = 63
SL_PCT              = 0.10
TARGET_PCT          = 0.30
BREAKEVEN_AT        = 0.15
TRAIL_AT            = 0.25
REBAL_HOLD          = 45
REBAL_TOP_N         = 30
SYM_COOLDOWN_DAYS   = 10
MAX_NEW_PER_DAY     = 5
REGIME_OFF_DAYS     = 3

# v7 new parameters
REGIME_CONFIRM_DAYS = 5     # consecutive ON days before entries are allowed
RS_ACCEL_DAYS       = 10    # RS must exceed RS this many trading days ago
HIGH_LOOKBACK       = 252   # 52-week high window (trading days)
HIGH_PROXIMITY      = 0.95  # stock must be >= this fraction of its HIGH_LOOKBACK high


def load_index():
    df = pd.read_csv(IDX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime":"date","Close":"close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date","close"]]


def load_stock(sym):
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime":"date","Open":"open","High":"high",
                             "Low":"low","Close":"close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date","open","high","low","close"]]


def build_regime(idx_df):
    c = idx_df["close"]
    s50 = c.rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()
    m63 = c > c.shift(MOM_PERIOD)
    dates = list(idx_df["date"])
    regime = {d for i, d in enumerate(dates)
              if not pd.isna(s50.iloc[i]) and bool(c.iloc[i] > s50.iloc[i]) and bool(m63.iloc[i])}
    return dates, c, regime


def build_tables(price_map):
    s50l, pxl, highl = {}, {}, {}
    for sym, df in price_map.items():
        closes = df["close"]
        s50l[sym]  = dict(zip(df["date"], closes.rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()))
        highl[sym] = dict(zip(df["date"], closes.rolling(HIGH_LOOKBACK, min_periods=HIGH_LOOKBACK).max()))
        pxl[sym]   = {r.date: r for r in df.itertuples(index=False)}
    return s50l, pxl, highl


def _rs_score(sym_df, idx_c, end_day_idx, lookback=RS_LOOKBACK):
    """Compute Mansfield RS for sym_df using the last `lookback` periods up to end_day_idx."""
    sc = sym_df["close"].values
    ic = idx_c.values
    # use data up to end_day_idx inclusive
    sc = sc[:end_day_idx + 1]
    ic = ic[:end_day_idx + 1]
    if len(sc) <= lookback or len(ic) <= lookback:
        return 0.0
    sb, sc_ = sc[-1 - lookback], sc[-1]
    ib, ic_ = ic[-1 - lookback], ic[-1]
    if sb == 0 or ib == 0:
        return 0.0
    return (sc_ / sb) / (ic_ / ib) - 1


def rank_universe(price_map, idx_c, idx_pos, as_of):
    n = RS_LOOKBACK
    out = []
    for sym, df in price_map.items():
        sc = df[df["date"] <= as_of]["close"]
        ic = idx_c.iloc[:idx_pos + 1]
        if len(sc) <= n or len(ic) <= n:
            out.append((sym, 0.0)); continue
        sb, sc_, ib, ic_ = sc.iloc[-1-n], sc.iloc[-1], ic.iloc[-1-n], ic.iloc[-1]
        rs = ((sc_ / sb) / (ic_ / ib) - 1) if sb and ib else 0.0
        out.append((sym, rs))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


class Pos:
    def __init__(self, sym, ed, ep, sh):
        self.sym, self.entry_date, self.ep, self.shares = sym, ed, ep, sh
        self.invest = ep * sh
        self.peak   = ep
        self.sl     = ep * (1 - SL_PCT)
        self.target = ep * (1 + TARGET_PCT)

    def update(self, hi, lo):
        if hi > self.peak: self.peak = hi
        pg = (self.peak / self.ep) - 1
        if pg >= TRAIL_AT:        trail = self.peak * (1 - SL_PCT)
        elif pg >= BREAKEVEN_AT:  trail = self.ep
        else:                     trail = self.ep * (1 - SL_PCT)
        self.sl = max(self.sl, trail)
        if hi >= self.target: return "target"
        if lo <= self.sl:     return "sl"
        return None

    def exit_px(self, reason, open_px):
        if reason == "target": return self.target
        if reason in ("rebal", "regime"): return open_px
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2): return (ep2 - self.ep) * self.shares
    def unr(self, curr): return (curr - self.ep) * self.shares


def run():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v7  (v6 + 3 entry-quality filters)")
    print("=" * 72)
    print(f"  Regime confirm : {REGIME_CONFIRM_DAYS} consecutive ON days before entries")
    print(f"  RS acceleration: RS must exceed RS-{RS_ACCEL_DAYS}d")
    print(f"  High proximity : stock >= {HIGH_PROXIMITY*100:.0f}% of {HIGH_LOOKBACK}-day high")

    idx_df = load_index()
    idx_dates, idx_c, regime = build_regime(idx_df)
    idx_date_map = {d: i for i, d in enumerate(idx_dates)}  # O(1) lookups

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    print(f"  Loaded {len(price_map)} stocks")

    s50l, pxl, highl = build_tables(price_map)
    trading_days = [d for d in idx_dates if d >= START_DATE]
    first_on = next((d for d in trading_days if d in regime), None)
    print(f"  Backtest: {trading_days[0]} to {trading_days[-1]}")
    print(f"  First regime-ON: {first_on}")

    portfolio: dict[str, Pos] = {}
    trades: list[dict] = []
    sl_hit: dict[str, int] = {}
    rebal_month = -1
    consecutive_off = 0
    consecutive_on  = 0
    regime_exited = False

    def entry_ok(sym, d, rs, day_idx):
        # Regime must be confirmed for REGIME_CONFIRM_DAYS consecutive days
        if consecutive_on < REGIME_CONFIRM_DAYS:
            return False
        # Symbol cooldown after SL
        if day_idx - sl_hit.get(sym, -9999) < SYM_COOLDOWN_DAYS:
            return False
        # Stock must be above its own 50-DMA
        s50 = s50l[sym].get(d)
        row = pxl[sym].get(d)
        if s50 is None or row is None or pd.isna(s50):
            return False
        close = float(row.close)
        if close <= float(s50):
            return False
        # 52-week high proximity: stock must be within HIGH_PROXIMITY of recent high
        h252 = highl[sym].get(d)
        if h252 is None or pd.isna(h252) or close < HIGH_PROXIMITY * float(h252):
            return False
        # RS acceleration: RS today must exceed RS RS_ACCEL_DAYS trading days ago
        if day_idx >= RS_ACCEL_DAYS:
            prev_day = trading_days[day_idx - RS_ACCEL_DAYS]
            prev_idx_pos = idx_date_map.get(prev_day)
            if prev_idx_pos is not None:
                df_sym = price_map[sym]
                sc_prev = df_sym[df_sym["date"] <= prev_day]["close"]
                ic_prev = idx_c.iloc[:prev_idx_pos + 1]
                n = RS_LOOKBACK
                if len(sc_prev) > n and len(ic_prev) > n:
                    sb, sc_ = sc_prev.iloc[-1-n], sc_prev.iloc[-1]
                    ib, ic_ = ic_prev.iloc[-1-n], ic_prev.iloc[-1]
                    rs_prev = ((sc_ / sb) / (ic_ / ib) - 1) if sb and ib else 0.0
                    if rs <= rs_prev:
                        return False  # RS decelerating — skip
        return True

    def record(sym, pos, exit_date, ep2, reason):
        pnl = pos.pnl(ep2)
        trades.append({"symbol": sym, "entry_date": pos.entry_date,
                        "exit_date": exit_date, "entry_price": pos.ep,
                        "exit_price": ep2, "shares": pos.shares, "invest": pos.invest,
                        "pnl": pnl, "pnl_pct": pnl / pos.invest * 100,
                        "exit_reason": reason, "hold_days": (exit_date - pos.entry_date).days})
        if reason == "sl":
            sl_hit[sym] = trading_days.index(exit_date)
        del portfolio[sym]

    def do_buy(sym, d):
        row = pxl[sym].get(d)
        if not row: return None
        ep = float(row.close)
        sh = max(1, int(MAX_INVEST // ep))
        portfolio[sym] = Pos(sym, d, ep, sh)
        return portfolio[sym]

    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_date_map[day]
        r_on = day in regime

        if r_on:
            consecutive_off = 0
            consecutive_on += 1
            regime_exited = False
        else:
            consecutive_off += 1
            consecutive_on = 0

        # Regime exit: sell all after REGIME_OFF_DAYS consecutive OFF days
        if consecutive_off == REGIME_OFF_DAYS and not regime_exited and portfolio:
            regime_exited = True
            print(f"\n  *** {day}: REGIME OFF {REGIME_OFF_DAYS} days — exiting all {len(portfolio)} positions ***")
            for sym, pos in list(portfolio.items()):
                row = pxl[sym].get(day)
                ep2 = float(row.close) if row else pos.ep
                pnl = pos.pnl(ep2)
                print(f"    EXIT {sym}: {(day-pos.entry_date).days}d, PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                record(sym, pos, day, ep2, "regime")
            print(f"  All positions closed. Waiting for regime-ON.\n")
            continue

        # Normal SL / target exits
        if consecutive_off < REGIME_OFF_DAYS or regime_exited:
            for sym, pos in list(portfolio.items()):
                row = pxl[sym].get(day)
                if not row: continue
                result = pos.update(float(row.high), float(row.low))
                if result:
                    ep2 = pos.exit_px(result, float(row.open))
                    record(sym, pos, day, ep2, result)

        # Monthly rebalancing (first regime-ON day of month)
        if r_on and day.month != rebal_month:
            rebal_month = day.month
            ranked = rank_universe(price_map, idx_c, idx_pos, day)
            top_n = {s for s, _ in ranked[:REBAL_TOP_N]}
            for sym, pos in list(portfolio.items()):
                held = (day - pos.entry_date).days
                if held > REBAL_HOLD and sym not in top_n:
                    row = pxl[sym].get(day)
                    ep2 = float(row.open) if row else pos.ep
                    pnl = pos.pnl(ep2)
                    rank_pos = next((i+1 for i, (s, _) in enumerate(ranked) if s == sym), '?')
                    print(f"  {day}: REBAL EXIT {sym} ({held}d, rank {rank_pos}) PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                    record(sym, pos, day, ep2, "rebal")

        # Fill empty slots when regime ON and confirmed
        if r_on and consecutive_on >= REGIME_CONFIRM_DAYS:
            empty = PORTFOLIO_SIZE - len(portfolio)
            if empty > 0:
                ranked = rank_universe(price_map, idx_c, idx_pos, day)
                in_ptf = set(portfolio.keys())
                filled = 0
                for sym, rs in ranked:
                    if filled >= min(empty, MAX_NEW_PER_DAY): break
                    if sym in in_ptf: continue
                    if not entry_ok(sym, day, rs, day_idx): continue
                    pos = do_buy(sym, day)
                    if pos:
                        in_ptf.add(sym); filled += 1
                        print(f"  {day}: BUY {sym}: {pos.shares} @ {pos.ep:.2f} (RS {rs:+.3f}, on={consecutive_on}d)")

    # MTM
    last_day = trading_days[-1]
    open_list = []
    for sym, pos in portfolio.items():
        row = pxl[sym].get(last_day)
        if not row: continue
        curr = float(row.close); unr = pos.unr(curr)
        open_list.append({"symbol": sym, "entry_date": pos.entry_date,
                           "entry_price": pos.ep, "current": curr, "shares": pos.shares,
                           "invest": pos.invest, "unr_pnl": unr,
                           "unr_pct": unr / pos.invest * 100, "sl": pos.sl})

    # Report
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Tr':>4} {'W':>4} {'L':>4} {'Rg':>4} {'Rb':>4} {'Win%':>6} {'PNL':>12} {'Cum':>14}")
        print("-" * 70)
        cum = 0.0
        for ym, g in tdf.groupby("ym"):
            n = len(g); w = (g["pnl"] > 0).sum()
            rg = (g["exit_reason"] == "regime").sum()
            rb = (g["exit_reason"] == "rebal").sum()
            mp = g["pnl"].sum(); cum += mp
            print(f"{str(ym):<12} {n:>4} {w:>4} {n-w:>4} {rg:>4} {rb:>4} {w/n*100:>5.0f}% {mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 70)

        closed_pnl = tdf["pnl"].sum()
        n = len(tdf); w = (tdf["pnl"] > 0).sum()
        tgt = (tdf["exit_reason"] == "target").sum()
        sl  = (tdf["exit_reason"] == "sl").sum()
        rb  = (tdf["exit_reason"] == "rebal").sum()
        rg  = (tdf["exit_reason"] == "regime").sum()
        aw  = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0
        al  = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        exp = (w / n * aw) + ((n - w) / n * al)

        print(f"\nCLOSED TRADES ({n} total: {tgt} target / {sl} SL / {rb} rebal / {rg} regime)")
        print(f"  Win rate    : {w}/{n} = {w/n*100:.1f}%")
        print(f"  Avg win     : Rs.{aw:+,.0f}")
        print(f"  Avg loss    : Rs.{al:+,.0f}")
        if al: print(f"  W:L ratio   : {abs(aw/al):.2f}x")
        print(f"  Expectancy  : Rs.{exp:+,.0f} / trade")
        print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")

    unr_pnl = sum(r["unr_pnl"] for r in open_list) if open_list else 0.0
    if open_list:
        print(f"\nOPEN POSITIONS (MTM {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'EntryPx':>8} {'Curr':>9} {'Shrs':>5} {'Unreal':>10} {'%':>7} {'SL':>9}")
        print("-" * 80)
        for r in sorted(open_list, key=lambda x: x["unr_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current']:>9.2f} {r['shares']:>5} {r['unr_pnl']:>+10,.0f} "
                  f"{r['unr_pct']:>+6.1f}% {r['sl']:>9.2f}")
        print("-" * 80)
        print(f"  Total unrealised: Rs.{unr_pnl:+,.0f}   Open slots: {PORTFOLIO_SIZE - len(open_list)}")

    total = closed_pnl + unr_pnl
    init_cap = PORTFOLIO_SIZE * INVEST_PER_SLOT
    print(f"\nOVERALL")
    print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")
    print(f"  Open MTM    : Rs.{unr_pnl:+,.0f}")
    print(f"  TOTAL PNL   : Rs.{total:+,.0f}")
    print(f"  Capital     : Rs.{init_cap:,.0f}")
    print(f"  Return      : {total/init_cap*100:+.2f}%")
    print(f"  Annualised  : {total/init_cap*100/1.5:+.2f}% (~18 month period)")

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
