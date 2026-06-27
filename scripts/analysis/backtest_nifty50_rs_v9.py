"""
Backtest v9 — Targeted fixes on v8 based on performance analysis

Changes from v8:
1. Regime: weekly 200 SMA (prev week's close) — prevents daily whipsaws
   Regime exit happens on weekly review day, not after 3 consecutive days.
2. Breakout: 55-day closing high (higher quality than 20-day).
3. Entry confirmation: require 2 consecutive closes above the 55-day high before
   buying (avoids first-day breakout whipsaws and captures retest entries).
4. Stop: 5x ATR14 trailing (Chandelier-style) instead of 3x — lets winners breathe.
5. Rank exit: sell only if rank > 25 for TWO consecutive weekly reviews.
6. Portfolio: 10 stocks (wider diversification to reduce concentration risk).
7. Sizing: rank 1-5 -> Rs.20k, rank 6-10 -> Rs.15k.
8. Max 2 new buys per weekly review (limit turnover).
"""

import os
import pandas as pd
import numpy as np
from datetime import date
from collections import defaultdict

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

START_DATE        = date(2025, 1, 1)
PORTFOLIO_SIZE    = 10
INVEST_TOP5       = 20_000    # ranks 1-5
INVEST_REST       = 15_000    # ranks 6-10
ATR_PERIOD        = 14
ATR_MULT          = 5.0       # 5x ATR trailing stop (wider — lets winners run)
REGIME_SMA        = 200       # weekly close must be > 200 SMA
SYM_COOLDOWN_DAYS = 10
MAX_NEW_PER_WEEK  = 2         # max 2 new buys per weekly review
BUY_RANK_LIMIT    = 10        # only buy stocks ranked <= this
SELL_RANK_LIMIT   = 25        # exit if rank > this for 2 consecutive weeks
MIN_HOLD_DAYS     = 7         # don't rebal-exit before 1 week
BREAKOUT_DAYS     = 55        # 55-day closing high for breakout filter

# Composite RS: (lookback_trading_days, weight) — same weights as v8
RS_WEIGHTS = [(10, 0.10), (21, 0.20), (63, 0.40), (126, 0.30)]


# ── data loading ───────────────────────────────────────────────────────────────

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


# ── regime (weekly) ────────────────────────────────────────────────────────────

def build_regime_weekly(idx_df):
    """
    Regime is ON for week W if the PREVIOUS week's Nifty close was above 200 SMA.
    This prevents intra-week / day-by-day whipsaws.
    """
    c = idx_df["close"]
    sma200 = c.rolling(REGIME_SMA, min_periods=REGIME_SMA).mean()
    dates = list(idx_df["date"])

    # Group trading days by ISO week
    week_days = defaultdict(list)    # (year, week) -> list of (i, date)
    for i, d in enumerate(dates):
        ts = pd.Timestamp(d)
        iso = ts.isocalendar()
        wk = (iso[0], iso[1])
        week_days[wk].append((i, d))

    sorted_weeks = sorted(week_days.keys())

    # Regime of week W = (prev week's last close > 200 SMA)
    week_regime: dict = {}
    for w_idx, wk in enumerate(sorted_weeks):
        if w_idx == 0:
            week_regime[wk] = False
            continue
        prev_wk = sorted_weeks[w_idx - 1]
        last_i  = week_days[prev_wk][-1][0]
        if pd.isna(sma200.iloc[last_i]):
            week_regime[wk] = False
        else:
            week_regime[wk] = bool(c.iloc[last_i] > sma200.iloc[last_i])

    regime = set()
    for wk, day_list in week_days.items():
        if week_regime.get(wk, False):
            for _, d in day_list:
                regime.add(d)

    return dates, c, regime, week_days, sorted_weeks, week_regime


# ── indicator tables ───────────────────────────────────────────────────────────

def build_tables(price_map):
    tables = {}
    for sym, df in price_map.items():
        closes = df["close"]
        highs  = df["high"]
        lows   = df["low"]

        ema20  = closes.ewm(span=20,  adjust=False).mean()
        ema50  = closes.ewm(span=50,  adjust=False).mean()
        ema200 = closes.ewm(span=200, adjust=False).mean()

        prev_c = closes.shift(1)
        tr = pd.concat([
            highs - lows,
            (highs - prev_c).abs(),
            (lows  - prev_c).abs(),
        ], axis=1).max(axis=1)
        atr14 = tr.ewm(span=ATR_PERIOD, adjust=False).mean()

        # 55-day breakout: rolling max shifted so current day's close not included
        rolling55 = closes.rolling(BREAKOUT_DAYS, min_periods=BREAKOUT_DAYS).max()
        high55_1  = rolling55.shift(1)    # yesterday's 55-day closing max
        high55_2  = rolling55.shift(2)    # 2-days-ago's 55-day closing max
        close_1   = closes.shift(1)       # yesterday's close

        has_vol = "volume" in df.columns
        if has_vol:
            vol_s   = df["volume"]
            vol20_s = vol_s.rolling(20, min_periods=10).mean()

        tables[sym] = {
            "ema20":   dict(zip(df["date"], ema20)),
            "ema50":   dict(zip(df["date"], ema50)),
            "ema200":  dict(zip(df["date"], ema200)),
            "atr14":   dict(zip(df["date"], atr14)),
            "high55_1": dict(zip(df["date"], high55_1)),   # yesterday's 55-day max
            "high55_2": dict(zip(df["date"], high55_2)),   # 2d-ago's 55-day max
            "close_1":  dict(zip(df["date"], close_1)),    # yesterday's close
            "vol":     dict(zip(df["date"], vol_s))   if has_vol else {},
            "vol20":   dict(zip(df["date"], vol20_s)) if has_vol else {},
            "px":      {r.date: r for r in df.itertuples(index=False)},
        }
    return tables


# ── composite RS and ranking ───────────────────────────────────────────────────

def composite_rs(sym_df, idx_c, idx_pos):
    sc = sym_df["close"].values
    ic = idx_c.values[:idx_pos + 1]
    score = 0.0
    for n, w in RS_WEIGHTS:
        if len(sc) > n and len(ic) > n:
            sb, sc_ = sc[-1 - n], sc[-1]
            ib, ic_ = ic[-1 - n], ic[-1]
            if sb and ib:
                score += w * ((sc_ / sb) / (ic_ / ib) - 1)
    return score


def rank_universe(price_map, idx_c, idx_pos, as_of):
    out = []
    for sym, df in price_map.items():
        sub = df[df["date"] <= as_of]
        rs  = composite_rs(sub, idx_c, idx_pos)
        out.append((sym, rs))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


# ── position class (5x ATR Chandelier trailing stop) ──────────────────────────

class Pos:
    def __init__(self, sym, ed, ep, sh, atr_init):
        self.sym        = sym
        self.entry_date = ed
        self.ep         = ep
        self.shares     = sh
        self.invest     = ep * sh
        self.peak_close = ep
        self._atr_init  = atr_init
        self.sl         = ep - ATR_MULT * atr_init

    def update(self, high, low, close, atr):
        if close > self.peak_close:
            self.peak_close = close
        atr_use = atr if (atr and not np.isnan(atr)) else self._atr_init
        new_sl  = self.peak_close - ATR_MULT * atr_use
        self.sl = max(self.sl, new_sl)
        if low <= self.sl:
            return "sl"
        return None

    def exit_px(self, reason, open_px):
        if reason in ("rebal", "regime", "ema50"):
            return open_px
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2): return (ep2 - self.ep) * self.shares
    def unr(self, curr): return (curr - self.ep) * self.shares


# ── main backtest ──────────────────────────────────────────────────────────────

def run():
    print("=" * 72)
    print("NIFTY 50 RS STRATEGY v9  (Rotation + Wider Stop)")
    print("=" * 72)
    print(f"  Portfolio     : {PORTFOLIO_SIZE} stocks")
    print(f"  Sizing        : rank 1-5 -> Rs.{INVEST_TOP5:,}, rank 6+ -> Rs.{INVEST_REST:,}")
    print(f"  Composite RS  : {RS_WEIGHTS}")
    print(f"  Regime        : weekly Nifty > {REGIME_SMA} SMA (prev week close)")
    print(f"  Stop          : {ATR_MULT}x ATR{ATR_PERIOD} trailing (no fixed target)")
    print(f"  Sell rule     : rank > {SELL_RANK_LIMIT} for 2 consecutive weeks OR EMA50 breach")
    print(f"  Entry         : stacked EMA + 2-close {BREAKOUT_DAYS}-day breakout + volume")
    print(f"  Max new/week  : {MAX_NEW_PER_WEEK}")

    idx_df = load_index()
    idx_dates, idx_c, regime, week_days, sorted_weeks, week_regime = build_regime_weekly(idx_df)
    idx_date_map = {d: i for i, d in enumerate(idx_dates)}

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    print(f"  Loaded {len(price_map)} stocks")

    tables = build_tables(price_map)
    trading_days = [d for d in idx_dates if d >= START_DATE]
    td_idx = {d: i for i, d in enumerate(trading_days)}

    # First trading day of each week within our backtest window
    rebal_days = set()
    for wk, day_list in week_days.items():
        first_day = next((d for _, d in day_list if d >= START_DATE), None)
        if first_day:
            rebal_days.add(first_day)

    print(f"  Backtest: {trading_days[0]} to {trading_days[-1]}")
    first_on = next((d for d in trading_days if d in regime), None)
    print(f"  First regime-ON: {first_on}")
    print()

    portfolio:      dict[str, Pos] = {}
    trades:         list[dict]     = []
    sl_hit:         dict[str, int] = {}
    rank_last_week: dict[str, int] = {}    # last week's rank for 2-week exit rule

    def record(sym, pos, exit_date, ep2, reason):
        pnl = pos.pnl(ep2)
        trades.append({
            "symbol": sym, "entry_date": pos.entry_date,
            "exit_date": exit_date, "entry_price": pos.ep,
            "exit_price": ep2, "shares": pos.shares, "invest": pos.invest,
            "pnl": pnl, "pnl_pct": pnl / pos.invest * 100,
            "exit_reason": reason, "hold_days": (exit_date - pos.entry_date).days,
        })
        if reason == "sl":
            sl_hit[sym] = td_idx.get(exit_date, 0)
        del portfolio[sym]

    def entry_ok(sym, d, day_idx, t):
        if day_idx - sl_hit.get(sym, -9999) < SYM_COOLDOWN_DAYS:
            return False
        row = t["px"].get(d)
        if not row:
            return False
        close = float(row.close)

        # Stacked EMA: Price > EMA20 > EMA50 > EMA200
        e20  = t["ema20"].get(d)
        e50  = t["ema50"].get(d)
        e200 = t["ema200"].get(d)
        if None in (e20, e50, e200):
            return False
        if not (close > float(e20) > float(e50) > float(e200)):
            return False

        # 2-close 55-day breakout confirmation:
        # Today AND yesterday both closed at new 55-day highs
        h55_1 = t["high55_1"].get(d)   # yesterday's 55-day max
        h55_2 = t["high55_2"].get(d)   # 2-days-ago's 55-day max
        c1    = t["close_1"].get(d)    # yesterday's close
        if any(x is None or pd.isna(x) for x in [h55_1, h55_2, c1]):
            return False
        if close <= float(h55_1):
            return False               # today is not a new 55-day high
        if float(c1) <= float(h55_2):
            return False               # yesterday was not a new 55-day high either

        # Volume: today > 20-day average
        vol20_val = t["vol20"].get(d)
        if vol20_val is not None and not pd.isna(vol20_val) and vol20_val > 0:
            vol = t["vol"].get(d) or 0
            if vol < float(vol20_val):
                return False

        return True

    def do_buy(sym, d, rank, t):
        row = t["px"].get(d)
        if not row:
            return None
        atr_val = t["atr14"].get(d)
        if atr_val is None or pd.isna(atr_val):
            return None
        ep     = float(row.close)
        invest = INVEST_TOP5 if rank <= 5 else INVEST_REST
        sh     = max(1, int(invest // ep))
        portfolio[sym] = Pos(sym, d, ep, sh, float(atr_val))
        return portfolio[sym]

    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_date_map[day]
        r_on    = day in regime

        # ── daily SL and EMA50 checks (every day, even off-regime) ───────────
        for sym, pos in list(portfolio.items()):
            t   = tables[sym]
            row = t["px"].get(day)
            if not row:
                continue
            close   = float(row.close)
            atr_val = t["atr14"].get(day)
            if atr_val is None or (isinstance(atr_val, float) and np.isnan(atr_val)):
                atr_val = pos._atr_init

            result = pos.update(float(row.high), float(row.low), close, float(atr_val))
            if result == "sl":
                ep2 = pos.exit_px("sl", float(row.open))
                pnl = pos.pnl(ep2)
                print(f"  {day}: SL EXIT   {sym}: {(day-pos.entry_date).days}d  "
                      f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)  sl={pos.sl:.2f}")
                record(sym, pos, day, ep2, "sl")
                continue

            # EMA50 breach exit
            e50 = t["ema50"].get(day)
            if e50 is not None and close < float(e50):
                pnl = pos.pnl(close)
                print(f"  {day}: EMA50 EXIT {sym}: {(day-pos.entry_date).days}d  "
                      f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                record(sym, pos, day, close, "ema50")

        # ── weekly review (first trading day of each calendar week) ───────────
        if day not in rebal_days:
            continue

        if not r_on:
            # Regime OFF: exit all open positions at open
            if portfolio:
                print(f"\n  *** {day}: REGIME OFF (weekly) — exiting all {len(portfolio)} positions ***")
                for sym, pos in list(portfolio.items()):
                    row = tables[sym]["px"].get(day)
                    ep2 = float(row.open) if row else pos.ep
                    pnl = pos.pnl(ep2)
                    print(f"    EXIT {sym}: {(day-pos.entry_date).days}d  "
                          f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                    record(sym, pos, day, ep2, "regime")
                print(f"  All positions closed. Waiting for regime-ON.\n")
            rank_last_week.clear()
            continue

        # Regime ON — rank universe and manage portfolio
        ranked   = rank_universe(price_map, idx_c, idx_pos, day)
        rank_map = {s: i + 1 for i, (s, _) in enumerate(ranked)}

        # Sell if rank > SELL_RANK_LIMIT for 2 consecutive weeks
        for sym, pos in list(portfolio.items()):
            held = (day - pos.entry_date).days
            if held < MIN_HOLD_DAYS:
                continue
            rk      = rank_map.get(sym, 999)
            rk_prev = rank_last_week.get(sym, 0)
            if rk > SELL_RANK_LIMIT and rk_prev > SELL_RANK_LIMIT:
                row = tables[sym]["px"].get(day)
                ep2 = float(row.open) if row else pos.ep
                pnl = pos.pnl(ep2)
                print(f"  {day}: REBAL EXIT {sym} (rank {rk} 2nd wk, {held}d)  "
                      f"PNL Rs.{pnl:+,.0f} ({pnl/pos.invest*100:+.1f}%)")
                record(sym, pos, day, ep2, "rebal")

        # Update rank memory for each held symbol
        for sym in list(portfolio.keys()):
            rank_last_week[sym] = rank_map.get(sym, 999)

        # Buy top-ranked candidates to fill empty slots
        in_ptf = set(portfolio.keys())
        filled  = 0
        for sym, rs in ranked:
            if len(portfolio) >= PORTFOLIO_SIZE:
                break
            if filled >= MAX_NEW_PER_WEEK:
                break
            rk = rank_map[sym]
            if rk > BUY_RANK_LIMIT:
                break
            if sym in in_ptf:
                continue
            t = tables[sym]
            if not entry_ok(sym, day, day_idx, t):
                continue
            pos = do_buy(sym, day, rk, t)
            if pos:
                in_ptf.add(sym)
                filled += 1
                print(f"  {day}: BUY  {sym}: {pos.shares}sh @ {pos.ep:.2f}  "
                      f"RS={rs:+.4f}  rank={rk}  invest=Rs.{pos.invest:,.0f}  "
                      f"sl={pos.sl:.2f}")

    # ── MTM ───────────────────────────────────────────────────────────────────
    last_day  = trading_days[-1]
    open_list = []
    for sym, pos in portfolio.items():
        row = tables[sym]["px"].get(last_day)
        if not row:
            continue
        curr = float(row.close)
        unr  = pos.unr(curr)
        open_list.append({
            "symbol": sym, "entry_date": pos.entry_date,
            "entry_price": pos.ep, "current": curr,
            "shares": pos.shares, "invest": pos.invest,
            "unr_pnl": unr, "unr_pct": unr / pos.invest * 100,
            "sl": pos.sl, "peak": pos.peak_close,
        })

    # ── report ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 72)
    print("RESULTS")
    print("=" * 72)

    closed_pnl = 0.0
    if trades:
        tdf = pd.DataFrame(trades)
        tdf["ym"] = pd.to_datetime(tdf["exit_date"]).dt.to_period("M")

        print(f"\n{'MONTH':<12} {'Tr':>4} {'W':>4} {'L':>4} {'SL':>4} "
              f"{'E50':>4} {'Rb':>4} {'Rg':>4} {'Win%':>6} {'PNL':>12} {'Cum':>14}")
        print("-" * 78)
        cum = 0.0
        for ym, g in tdf.groupby("ym"):
            n  = len(g); w = (g["pnl"] > 0).sum()
            sl = (g["exit_reason"] == "sl").sum()
            e5 = (g["exit_reason"] == "ema50").sum()
            rb = (g["exit_reason"] == "rebal").sum()
            rg = (g["exit_reason"] == "regime").sum()
            mp = g["pnl"].sum(); cum += mp
            print(f"{str(ym):<12} {n:>4} {w:>4} {n-w:>4} {sl:>4} "
                  f"{e5:>4} {rb:>4} {rg:>4} {w/n*100:>5.0f}% {mp:>+12,.0f} {cum:>+14,.0f}")
        print("-" * 78)

        closed_pnl = tdf["pnl"].sum()
        n  = len(tdf); w = (tdf["pnl"] > 0).sum()
        sl = (tdf["exit_reason"] == "sl").sum()
        e5 = (tdf["exit_reason"] == "ema50").sum()
        rb = (tdf["exit_reason"] == "rebal").sum()
        rg = (tdf["exit_reason"] == "regime").sum()
        aw = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0
        al = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0
        exp = (w / n * aw) + ((n - w) / n * al)

        # Best trades
        best = tdf.nlargest(5, "pnl_pct")[["symbol","entry_date","exit_date","pnl_pct","pnl","hold_days","exit_reason"]]
        worst = tdf.nsmallest(5, "pnl_pct")[["symbol","entry_date","exit_date","pnl_pct","pnl","hold_days","exit_reason"]]

        print(f"\nCLOSED TRADES ({n} total: {sl} SL / {e5} EMA50 / {rb} rebal / {rg} regime)")
        print(f"  Win rate    : {w}/{n} = {w/n*100:.1f}%")
        print(f"  Avg win     : Rs.{aw:+,.0f}")
        print(f"  Avg loss    : Rs.{al:+,.0f}")
        if al: print(f"  W:L ratio   : {abs(aw/al):.2f}x")
        print(f"  Expectancy  : Rs.{exp:+,.0f} / trade")
        print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")

        print(f"\n  Top 5 winners:")
        for _, r in best.iterrows():
            print(f"    {r['symbol']:<14} {str(r['entry_date']):>10}->{str(r['exit_date']):<10}  "
                  f"{r['pnl_pct']:>+6.1f}%  Rs.{r['pnl']:>+,.0f}  {r['hold_days']}d  [{r['exit_reason']}]")
        print(f"\n  Top 5 losers:")
        for _, r in worst.iterrows():
            print(f"    {r['symbol']:<14} {str(r['entry_date']):>10}->{str(r['exit_date']):<10}  "
                  f"{r['pnl_pct']:>+6.1f}%  Rs.{r['pnl']:>+,.0f}  {r['hold_days']}d  [{r['exit_reason']}]")

    unr_pnl = sum(r["unr_pnl"] for r in open_list) if open_list else 0.0
    if open_list:
        print(f"\nOPEN POSITIONS (MTM {last_day}):")
        print(f"{'Symbol':<14} {'Entry':<12} {'EntryPx':>8} {'Curr':>9} "
              f"{'Peak':>9} {'Shrs':>5} {'Unreal':>10} {'%':>7} {'SL':>9}")
        print("-" * 88)
        for r in sorted(open_list, key=lambda x: x["unr_pct"], reverse=True):
            print(f"{r['symbol']:<14} {str(r['entry_date']):<12} {r['entry_price']:>8.2f} "
                  f"{r['current']:>9.2f} {r['peak']:>9.2f} {r['shares']:>5} "
                  f"{r['unr_pnl']:>+10,.0f} {r['unr_pct']:>+6.1f}% {r['sl']:>9.2f}")
        print("-" * 88)
        print(f"  Total unrealised: Rs.{unr_pnl:+,.0f}   Open slots: {PORTFOLIO_SIZE - len(open_list)}")

    total    = closed_pnl + unr_pnl
    init_cap = PORTFOLIO_SIZE * INVEST_TOP5
    print(f"\nOVERALL")
    print(f"  Closed PNL  : Rs.{closed_pnl:+,.0f}")
    print(f"  Open MTM    : Rs.{unr_pnl:+,.0f}")
    print(f"  TOTAL PNL   : Rs.{total:+,.0f}")
    print(f"  Capital     : Rs.{init_cap:,.0f}  (10 x {INVEST_TOP5:,})")
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
