"""
Nifty 50 RS — A/B Test Suite (v8 as baseline, one change per test)

BASE  v8 exactly: 20-day breakout, composite RS, daily regime 3-OFF exit, 3x ATR, EMA50 exit
A     No breakout filter         — does the 20-day gate help?
B     No EMA50 exit              — does cutting on EMA50 hurt winners?
C     No regime gate             — does market timing actually help?
E     Accelerating RS weights    — 21=40%, 63=30%, 126=20%, 252=10%
F     5x ATR trailing stop       — does a wider stop let winners run more?
"""

import os
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

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
START_DATE = date(2025, 1, 1)

RS_BASE  = [(10, 0.10), (21, 0.20), (63, 0.40), (126, 0.30)]
RS_ACCEL = [(21, 0.40), (63, 0.30), (126, 0.20), (252, 0.10)]


@dataclass
class Config:
    label: str
    desc: str
    portfolio_size: int  = 8
    invest_top_n:   int  = 3
    invest_top:     int  = 20_000
    invest_rest:    int  = 15_000
    atr_mult:       float = 3.0
    use_regime:     bool  = True
    regime_off_days: int  = 3
    use_ema50_exit: bool  = True
    breakout_days:  int   = 20       # 0 = disabled
    rs_weights:     List[Tuple] = field(default_factory=lambda: RS_BASE)
    sell_rank_limit: int  = 20
    buy_rank_limit:  int  = 10
    min_hold_days:   int  = 5
    max_new_per_week: int = 3


CONFIGS = [
    Config("BASE", "20d breakout | composite RS | daily regime | 3x ATR | EMA50 exit"),
    Config("A",    "No breakout filter",        breakout_days=0),
    Config("B",    "No EMA50 exit",             use_ema50_exit=False),
    Config("C",    "No regime gate",            use_regime=False),
    Config("E",    "Accel RS 21=40 63=30 126=20 252=10", rs_weights=RS_ACCEL),
    Config("F",    "5x ATR trailing stop",      atr_mult=5.0),
]


# ── shared data loading ────────────────────────────────────────────────────────

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


def build_regime(idx_df):
    c    = idx_df["close"]
    s200 = c.rolling(200, min_periods=200).mean()
    dates = list(idx_df["date"])
    regime = {d for i, d in enumerate(dates)
              if not pd.isna(s200.iloc[i]) and bool(c.iloc[i] > s200.iloc[i])}
    return dates, c, regime


def build_tables(price_map):
    tables = {}
    for sym, df in price_map.items():
        c = df["close"]; h = df["high"]; l = df["low"]
        pc = c.shift(1)
        tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
        hv = "volume" in df.columns
        tables[sym] = {
            "ema20":  dict(zip(df["date"], c.ewm(span=20,  adjust=False).mean())),
            "ema50":  dict(zip(df["date"], c.ewm(span=50,  adjust=False).mean())),
            "ema200": dict(zip(df["date"], c.ewm(span=200, adjust=False).mean())),
            "atr14":  dict(zip(df["date"], tr.ewm(span=14, adjust=False).mean())),
            "high20": dict(zip(df["date"], c.rolling(20, min_periods=20).max().shift(1))),
            "vol":    dict(zip(df["date"], df["volume"])) if hv else {},
            "vol20":  dict(zip(df["date"], df["volume"].rolling(20, min_periods=10).mean())) if hv else {},
            "px":     {r.date: r for r in df.itertuples(index=False)},
        }
    return tables


# ── ranking ────────────────────────────────────────────────────────────────────

def composite_rs(sub_df, idx_c_vals, idx_pos, weights):
    sc = sub_df["close"].values
    ic = idx_c_vals[:idx_pos + 1]
    score = 0.0
    for n, w in weights:
        if len(sc) > n and len(ic) > n:
            sb, sc_ = sc[-1 - n], sc[-1]
            ib, ic_ = ic[-1 - n], ic[-1]
            if sb and ib:
                score += w * ((sc_ / sb) / (ic_ / ib) - 1)
    return score


def rank_universe(price_map, idx_c_vals, idx_pos, as_of, weights):
    out = [(sym, composite_rs(df[df["date"] <= as_of], idx_c_vals, idx_pos, weights))
           for sym, df in price_map.items()]
    out.sort(key=lambda x: x[1], reverse=True)
    return out


# ── position ───────────────────────────────────────────────────────────────────

class Pos:
    __slots__ = ["sym", "entry_date", "ep", "shares", "invest",
                 "peak_close", "_ai", "_am", "sl"]

    def __init__(self, sym, ed, ep, sh, atr_init, atr_mult):
        self.sym        = sym
        self.entry_date = ed
        self.ep         = ep
        self.shares     = sh
        self.invest     = ep * sh
        self.peak_close = ep
        self._ai        = atr_init    # initial ATR (fallback)
        self._am        = atr_mult
        self.sl         = ep - atr_mult * atr_init

    def update(self, high, low, close, atr):
        if close > self.peak_close:
            self.peak_close = close
        a = atr if (atr and not np.isnan(atr)) else self._ai
        self.sl = max(self.sl, self.peak_close - self._am * a)
        return "sl" if low <= self.sl else None

    def exit_px(self, reason, open_px):
        if reason in ("rebal", "regime", "ema50"):
            return open_px
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2): return (ep2 - self.ep) * self.shares
    def unr(self, curr): return (curr - self.ep) * self.shares


# ── backtest engine ────────────────────────────────────────────────────────────

def run_backtest(cfg: Config, price_map, tables, idx_c, idx_dates,
                 regime_set, trading_days, td_idx, idx_date_map):

    idx_c_vals   = idx_c.values
    portfolio:   Dict[str, Pos] = {}
    trades:      List[Dict]     = []
    sl_hit:      Dict[str, int] = {}
    rebal_week   = -1
    consec_off   = 0
    reg_exited   = False
    first_entry: Optional[date] = None

    def record(sym, pos, exit_date, ep2, reason):
        pnl = pos.pnl(ep2)
        trades.append({
            "symbol": sym, "entry_date": pos.entry_date, "exit_date": exit_date,
            "entry_price": pos.ep, "exit_price": ep2, "invest": pos.invest,
            "pnl": pnl, "pnl_pct": pnl / pos.invest * 100,
            "exit_reason": reason, "hold_days": (exit_date - pos.entry_date).days,
        })
        if reason == "sl":
            sl_hit[sym] = td_idx.get(exit_date, 0)
        del portfolio[sym]

    def can_enter(sym, d, day_idx, t):
        if day_idx - sl_hit.get(sym, -9999) < 10:
            return False
        row = t["px"].get(d)
        if not row:
            return False
        close = float(row.close)
        e20 = t["ema20"].get(d); e50 = t["ema50"].get(d); e200 = t["ema200"].get(d)
        if None in (e20, e50, e200):
            return False
        if not (close > float(e20) > float(e50) > float(e200)):
            return False
        if cfg.breakout_days > 0:
            h = t["high20"].get(d)
            if h is None or pd.isna(h) or close <= float(h):
                return False
        v20 = t["vol20"].get(d)
        if v20 is not None and not pd.isna(v20) and v20 > 0:
            if (t["vol"].get(d) or 0) < float(v20):
                return False
        return True

    def do_buy(sym, d, rank, t):
        row = t["px"].get(d)
        if not row:
            return None
        atr = t["atr14"].get(d)
        if atr is None or pd.isna(atr):
            return None
        ep     = float(row.close)
        invest = cfg.invest_top if rank <= cfg.invest_top_n else cfg.invest_rest
        sh     = max(1, int(invest // ep))
        portfolio[sym] = Pos(sym, d, ep, sh, float(atr), cfg.atr_mult)
        return portfolio[sym]

    regime_on = (lambda d: True) if not cfg.use_regime else (lambda d: d in regime_set)

    for day_idx, day in enumerate(trading_days):
        idx_pos = idx_date_map[day]
        on      = regime_on(day)

        if on:   consec_off = 0; reg_exited = False
        else:    consec_off += 1

        # regime exit: sell everything on the trigger day
        if cfg.use_regime and consec_off == cfg.regime_off_days and not reg_exited and portfolio:
            reg_exited = True
            for sym, pos in list(portfolio.items()):
                row = tables[sym]["px"].get(day)
                record(sym, pos, day, float(row.close) if row else pos.ep, "regime")
            continue  # skip daily checks + rebalance on this day

        # daily SL and EMA50 checks
        for sym, pos in list(portfolio.items()):
            t   = tables[sym]
            row = t["px"].get(day)
            if not row:
                continue
            close   = float(row.close)
            atr_val = t["atr14"].get(day) or pos._ai
            if isinstance(atr_val, float) and np.isnan(atr_val):
                atr_val = pos._ai
            result = pos.update(float(row.high), float(row.low), close, float(atr_val))
            if result == "sl":
                record(sym, pos, day, pos.exit_px("sl", float(row.open)), "sl")
                continue
            if cfg.use_ema50_exit:
                e50 = t["ema50"].get(day)
                if e50 and close < float(e50):
                    record(sym, pos, day, close, "ema50")

        # weekly rebalance (first trading day of each ISO week)
        wk = day.isocalendar()[1] + day.year * 100
        if on and wk != rebal_week:
            rebal_week = wk
            ranked = rank_universe(price_map, idx_c_vals, idx_pos, day, cfg.rs_weights)
            rmap   = {s: i + 1 for i, (s, _) in enumerate(ranked)}

            # exit rank losers
            for sym, pos in list(portfolio.items()):
                if (day - pos.entry_date).days < cfg.min_hold_days:
                    continue
                if rmap.get(sym, 999) > cfg.sell_rank_limit:
                    row = tables[sym]["px"].get(day)
                    record(sym, pos, day, float(row.open) if row else pos.ep, "rebal")

            # buy top-ranked
            in_p = set(portfolio.keys()); filled = 0
            for sym, _ in ranked:
                if len(portfolio) >= cfg.portfolio_size:
                    break
                if filled >= cfg.max_new_per_week:
                    break
                rk = rmap[sym]
                if rk > cfg.buy_rank_limit:
                    break
                if sym in in_p:
                    continue
                t = tables[sym]
                if not can_enter(sym, day, day_idx, t):
                    continue
                pos = do_buy(sym, day, rk, t)
                if pos:
                    in_p.add(sym); filled += 1
                    if first_entry is None:
                        first_entry = day

    # MTM
    last_day = trading_days[-1]
    unr_pnl  = 0.0
    for sym, pos in portfolio.items():
        row = tables[sym]["px"].get(last_day)
        if row:
            unr_pnl += pos.unr(float(row.close))

    cap = cfg.portfolio_size * cfg.invest_top

    if not trades:
        return {"n": 0, "w": 0, "win_pct": 0.0, "aw": 0.0, "al": 0.0, "wl": 0.0,
                "closed": 0.0, "unr": unr_pnl, "total": unr_pnl,
                "ret": unr_pnl / cap * 100, "first": first_entry,
                "reasons": {}, "best_pct": 0.0, "worst_pct": 0.0, "trades": []}

    tdf = pd.DataFrame(trades)
    n   = len(tdf)
    w   = int((tdf["pnl"] > 0).sum())
    aw  = tdf[tdf["pnl"] > 0]["pnl"].mean() if w else 0.0
    al  = tdf[tdf["pnl"] < 0]["pnl"].mean() if (tdf["pnl"] < 0).any() else 0.0
    closed = tdf["pnl"].sum()
    total  = closed + unr_pnl

    return {
        "n": n, "w": w, "win_pct": w / n * 100,
        "aw": aw, "al": al, "wl": abs(aw / al) if al else 0.0,
        "closed": closed, "unr": unr_pnl, "total": total,
        "ret": total / cap * 100, "first": first_entry,
        "reasons": tdf["exit_reason"].value_counts().to_dict(),
        "best_pct": float(tdf["pnl_pct"].max()),
        "worst_pct": float(tdf["pnl_pct"].min()),
        "trades": trades,
    }


# ── comparison output ──────────────────────────────────────────────────────────

def print_comparison(results):
    print("\n" + "=" * 95)
    print("COMPARISON TABLE  (all Jan 2025 - Jun 2026 | Capital = portfolio_size x Rs.20,000)")
    print("=" * 95)
    hdr = (f"{'Test':<5} {'Desc':<42} {'Trd':>4} {'W':>3} {'Win%':>5} "
           f"{'AvgW':>7} {'AvgL':>7} {'W:L':>5} {'Best%':>7} {'Return':>7} {'1stEntry':<12}")
    print(hdr)
    print("-" * 95)
    for lbl, (cfg, r) in results.items():
        first = str(r["first"]) if r["first"] else "never    "
        desc  = cfg.desc[:42]
        print(f"{lbl:<5} {desc:<42} {r['n']:>4} {r['w']:>3} {r['win_pct']:>4.0f}% "
              f"{r['aw']:>+7,.0f} {r['al']:>+7,.0f} {r['wl']:>5.2f} "
              f"{r['best_pct']:>+6.1f}% {r['ret']:>+6.2f}% {first}")
    print("-" * 95)

    print("\nExit reason breakdown:")
    print(f"  {'Test':<5} {'SL':>5} {'EMA50':>6} {'Rebal':>6} {'Regime':>7} "
          f"{'ClosedPNL':>11} {'OpenMTM':>10} {'TotalPNL':>10}")
    print("  " + "-" * 60)
    for lbl, (cfg, r) in results.items():
        reas = r["reasons"]
        print(f"  {lbl:<5} {reas.get('sl',0):>5} {reas.get('ema50',0):>6} "
              f"{reas.get('rebal',0):>6} {reas.get('regime',0):>7} "
              f"{r['closed']:>+11,.0f} {r['unr']:>+10,.0f} {r['total']:>+10,.0f}")

    # Top 3 winners per test
    print("\nBest 3 individual trades per test:")
    for lbl, (cfg, r) in results.items():
        if not r["trades"]:
            print(f"  {lbl}: no trades"); continue
        top3 = sorted(r["trades"], key=lambda x: x["pnl_pct"], reverse=True)[:3]
        trades_str = "  |  ".join(
            f"{t['symbol']} {t['pnl_pct']:+.1f}% ({t['hold_days']}d)"
            for t in top3
        )
        print(f"  {lbl}: {trades_str}")


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 72)
    print("NIFTY 50 RS — A/B TEST SUITE")
    print("=" * 72)

    idx_df = load_index()
    idx_dates, idx_c, regime_set = build_regime(idx_df)
    idx_date_map = {d: i for i, d in enumerate(idx_dates)}

    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    tables    = build_tables(price_map)
    print(f"  Loaded {len(price_map)} stocks")

    trading_days = [d for d in idx_dates if d >= START_DATE]
    td_idx       = {d: i for i, d in enumerate(trading_days)}
    print(f"  Period: {trading_days[0]} to {trading_days[-1]}")
    print()

    results = {}
    for cfg in CONFIGS:
        print(f"  Running {cfg.label}: {cfg.desc} ...", end="", flush=True)
        r = run_backtest(cfg, price_map, tables, idx_c, idx_dates,
                         regime_set, trading_days, td_idx, idx_date_map)
        results[cfg.label] = (cfg, r)
        print(f" done  ({r['n']} trades, {r['ret']:+.1f}%)")

    print_comparison(results)


if __name__ == "__main__":
    main()
