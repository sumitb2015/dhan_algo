"""
Backtest v5: Nifty 50 RS Weekly Rotation

Core change from v4: weekly portfolio review (every Monday).
If stock drops to RS rank > 25, exit it at close and replace.
This keeps the portfolio always in the top momentum leaders.

Additional improvements:
  - Stock must be above 200-DMA (not just 50-DMA) at entry
  - RS minimum threshold: 0.05 (5% outperformance over index in 6m)
  - SL: hard 10% floor (no trailing) + 30% target unchanged
  - Keep dual regime filter (close > 50-DMA AND > close_63d_ago)
  - Per-symbol cooldown: 7 days after SL hit
  - Max 5 new entries per day
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
START_DATE        = date(2025, 1, 1)
INVEST_PER_SLOT   = 10_000
MAX_INVEST        = 15_000
PORTFOLIO_SIZE    = 20
BUY_RANK_CUTOFF   = 20          # buy stocks ranked 1-20
HOLD_RANK_CUTOFF  = 25          # hold if still ranked 1-25; exit if rank > 25
RS_LOOKBACK       = 126
MIN_RS            = 0.05        # minimum RS to enter (5% outperformance)
SMA50             = 50
SMA200            = 200
MOM_PERIOD        = 63
SL_PCT            = 0.10
TARGET_PCT        = 0.30
SYM_COOLDOWN_DAYS = 7
MAX_NEW_PER_DAY   = 5
WEEKLY_REBAL_HOLD = 14          # hold positions at least 14 days before rebalancing out


# ── Data ───────────────────────────────────────────────────────────────────────

def load_index():
    df = pd.read_csv(IDX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date", "close"]]


def load_stock(sym):
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime": "date", "Open": "open",
                             "High": "high", "Low": "low", "Close": "close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date","open","high","low","close"]]


def build_regime(idx_df):
    c   = idx_df["close"]
    s50 = c.rolling(SMA50, min_periods=SMA50).mean()
    m63 = c > c.shift(MOM_PERIOD)
    dates = list(idx_df["date"])
    regime = {d for i, d in enumerate(dates)
              if not pd.isna(s50.iloc[i]) and bool(c.iloc[i] > s50.iloc[i]) and bool(m63.iloc[i])}
    return dates, c, regime


def build_stock_tables(price_map):
    sma50_lkp  = {}
    sma200_lkp = {}
    px_lkp     = {}
    for sym, df in price_map.items():
        c = df["close"]
        sma50_lkp[sym]  = dict(zip(df["date"], c.rolling(SMA50, min_periods=SMA50).mean()))
        sma200_lkp[sym] = dict(zip(df["date"], c.rolling(SMA200, min_periods=SMA200).mean()))
        px_lkp[sym]     = {r.date: r for r in df.itertuples(index=False)}
    return sma50_lkp, sma200_lkp, px_lkp


def rank_universe(price_map, idx_closes, idx_pos, as_of):
    n = RS_LOOKBACK
    scores = []
    for sym, df in price_map.items():
        sc = df[df["date"] <= as_of]["close"]
        ic = idx_closes.iloc[:idx_pos + 1]
        if len(sc) <= n or len(ic) <= n:
            scores.append((sym, 0.0))
            continue
        sb, sc_ = sc.iloc[-1-n], sc.iloc[-1]
        ib, ic_ = ic.iloc[-1-n], ic.iloc[-1]
        rs = ((sc_ / sb) / (ic_ / ib) - 1) if sb and ib else 0.0
        scores.append((sym, rs))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


# ── Position ───────────────────────────────────────────────────────────────────

class Pos:
    def __init__(self, sym, entry_date, ep, shares):
        self.sym, self.entry_date = sym, entry_date
        self.ep, self.shares     = ep, shares
        self.invest              = ep * shares
        self.sl                  = ep * (1 - SL_PCT)
        self.target              = ep * (1 + TARGET_PCT)
        self.peak                = ep

    def update(self, hi, lo):
        if hi > self.peak:
            self.peak = hi
        # Step-up SL: breakeven when peak +15%, trail 10% below peak when +25%
        pg = (self.peak / self.ep) - 1
        if pg >= 0.25:
            trail = self.peak * (1 - SL_PCT)
        elif pg >= 0.15:
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
        if reason == "rotate":
            return open_px
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2):
        return (ep2 - self.ep) * self.shares

    def unr(self, curr):
        return (curr - self.ep) * self.shares


def is_new_week(d, prev_d):
    if prev_d is None:
        return True
    return d.isocalendar()[:2] != prev_d.isocalendar()[:2]


# ── Backtest ───────────────────────────────────────────────────────────────────

def run():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v5  (weekly rotation + 200-DMA entry filter)")
    print("=" * 72)

    idx_df              = load_index()
    idx_dates, idx_c, regime = build_regime(idx_df)

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    print(f"  Loaded {len(price_map)} stocks")

    s50_lkp, s200_lkp, px_lkp = build_stock_tables(price_map)
    trading_days = [d for d in idx_dates if d >= START_DATE]
    first_on = next((d for d in trading_days if d in regime), None)
    print(f"  Backtest: {trading_days[0]} to {trading_days[-1]}")
    print(f"  First regime-ON: {first_on}")

    portfolio: dict[str, Pos] = {}
    trades:    list[dict]     = []
    sl_hit:    dict[str, int] = {}

    def regime_on(d): return d in regime

    def entry_ok(sym, d, rs, day_idx):
        if rs < MIN_RS:
            return False
        if day_idx - sl_hit.get(sym, -9999) < SYM_COOLDOWN_DAYS:
            return False
        s50  = s50_lkp[sym].get(d)
        s200 = s200_lkp[sym].get(d)
        row  = px_lkp[sym].get(d)
        if any(v is None or pd.isna(v) for v in [s50, s200, row]):
            return False
        return float(row.close) > float(s50) and float(row.close) > float(s200)

    def do_buy(sym, d):
        row = px_lkp[sym].get(d)
        if not row:
            return None
        ep     = float(row.close)
        shares = max(1, int(MAX_INVEST // ep))
        pos    = Pos(sym, d, ep, shares)
        portfolio[sym] = pos
        return pos

    def record(sym, pos, exit_date, ep2, reason):
        pnl = pos.pnl(ep2)
        trades.append({
            "symbol": sym, "entry_date": pos.entry_date,
            "exit_date": exit_date, "entry_price": pos.ep,
            "exit_price": ep2, "shares": pos.shares,
            "invest": pos.invest, "pnl": pnl,
            "pnl_pct": pnl / pos.invest * 100,
            "exit_reason": reason,
            "hold_days": (exit_date - pos.entry_date).days,
        })
        if reason == "sl":
            sl_hit[sym] = trading_days.index(exit_date)
        del portfolio[sym]

    prev_day = None
    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_dates.index(day)

        # 1. Daily SL / target check
        for sym, pos in list(portfolio.items()):
            row = px_lkp[sym].get(day)
            if not row:
                continue
            result = pos.update(float(row.high), float(row.low))
            if result:
                ep2 = pos.exit_px(result, float(row.open))
                record(sym, pos, day, ep2, result)

        # 2. Weekly rotation (Monday or first day of new week) when regime ON
        if is_new_week(day, prev_day) and regime_on(day):
            ranked   = rank_universe(price_map, idx_c, idx_pos, day)
            rs_rank  = {sym: i + 1 for i, (sym, _) in enumerate(ranked)}
            rs_dict  = {sym: rs for sym, rs in ranked}

            # Exit positions that fell out of top-HOLD_RANK_CUTOFF AND held > WEEKLY_REBAL_HOLD days
            for sym, pos in list(portfolio.items()):
                rank  = rs_rank.get(sym, 99)
                held  = (day - pos.entry_date).days
                if rank > HOLD_RANK_CUTOFF and held >= WEEKLY_REBAL_HOLD:
                    row = px_lkp[sym].get(day)
                    ep2 = float(row.open) if row else pos.ep
                    pnl = pos.pnl(ep2)
                    print(f"  {day}: ROTATE OUT {sym} (rank {rank}, {held}d) "
                          f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                    record(sym, pos, day, ep2, "rotate")

            # Fill empty slots (rate-limited)
            empty   = PORTFOLIO_SIZE - len(portfolio)
            in_ptf  = set(portfolio.keys())
            filled  = 0
            for sym, rs in ranked:
                if filled >= min(empty, MAX_NEW_PER_DAY):
                    break
                if sym in in_ptf:
                    continue
                rank = rs_rank[sym]
                if rank > BUY_RANK_CUTOFF:
                    break
                if not entry_ok(sym, day, rs, day_idx):
                    continue
                pos = do_buy(sym, day)
                if pos:
                    in_ptf.add(sym)
                    filled += 1
                    print(f"  {day}: BUY {sym}: {pos.shares} @ {pos.ep:.2f} "
                          f"(rank {rank}, RS {rs:+.3f})")

        prev_day = day

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

        print(f"\n{'MONTH':<12} {'Tr':>4} {'W':>4} {'L':>4} {'Rot':>4} {'Win%':>6} "
              f"{'PNL':>12} {'Cum PNL':>14}")
        print("-" * 65)
        cum = 0.0
        for ym, g in tdf.groupby("ym"):
            n   = len(g)
            w   = (g["pnl"] > 0).sum()
            l   = (g["pnl"] < 0).sum()
            r   = (g["exit_reason"] == "rotate").sum()
            mp  = g["pnl"].sum()
            cum += mp
            print(f"{str(ym):<12} {n:>4} {w:>4} {l:>4} {r:>4} {w/n*100:>5.0f}% "
                  f"{mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 65)

        closed_pnl = tdf["pnl"].sum()
        n   = len(tdf)
        w   = (tdf["pnl"] > 0).sum()
        tgt = (tdf["exit_reason"] == "target").sum()
        sl  = (tdf["exit_reason"] == "sl").sum()
        rot = (tdf["exit_reason"] == "rotate").sum()
        aw  = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0
        al  = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        exp = (w / n * aw) + ((n - w) / n * al) if n else 0

        print(f"\nCLOSED TRADES ({n} total, {tgt} target / {sl} SL / {rot} rotate)")
        print(f"  Win rate      : {w}/{n} = {w/n*100:.1f}%")
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

    # Closed trade log
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
