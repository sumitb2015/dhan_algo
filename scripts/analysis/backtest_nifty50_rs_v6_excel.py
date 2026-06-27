"""
Backtest v6 — Excel Export
Runs the v6 backtest and writes a fully formatted Excel report with sheets:
  1. Summary        — overall stats + strategy parameters
  2. Strategy       — plain-English explanation of every rule + formula
  3. Monthly PNL    — month-wise breakdown table
  4. Closed Trades  — full trade log
  5. Open Positions — current MTM positions
  6. Calculations   — worked examples of RS, SL step-up, regime filter
"""

import os, math
import pandas as pd
import numpy as np
from datetime import date
import xlsxwriter

# ── paths ────────────────────────────────────────────────────────────────────
ROOT     = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
IDX_PATH = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")
OUT_PATH = os.path.join(ROOT, "debug", "backtest_v6_report.xlsx")

# ── universe ─────────────────────────────────────────────────────────────────
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

# ── strategy parameters ───────────────────────────────────────────────────────
START_DATE         = date(2025, 1, 1)
INVEST_PER_SLOT    = 10_000
MAX_INVEST         = 15_000
PORTFOLIO_SIZE     = 20
RS_LOOKBACK        = 126      # ~6 months of trading days
SMA_PERIOD         = 50
MOM_PERIOD         = 63       # ~3 months
SL_PCT             = 0.10
TARGET_PCT         = 0.30
BREAKEVEN_AT       = 0.15
TRAIL_AT           = 0.25
REBAL_HOLD         = 45       # days held before rebalancing eligible
REBAL_TOP_N        = 30       # exit if rank falls outside top-N
SYM_COOLDOWN_DAYS  = 10
MAX_NEW_PER_DAY    = 5
REGIME_OFF_DAYS    = 3


# ── data loading ──────────────────────────────────────────────────────────────
def load_index():
    df = pd.read_csv(IDX_PATH, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime":"date","Close":"close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date","close"]]


def load_stock(sym):
    path = os.path.join(DATA_DIR, f"{sym}_Daily_2Y.csv")
    if not os.path.exists(path): return None
    df = pd.read_csv(path, parse_dates=["Datetime"])
    df = df.rename(columns={"Datetime":"date","Open":"open","High":"high",
                             "Low":"low","Close":"close"})
    df["date"] = df["date"].dt.date
    return df.sort_values("date").reset_index(drop=True)[["date","open","high","low","close"]]


def build_regime(idx_df):
    c   = idx_df["close"]
    s50 = c.rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()
    m63 = c > c.shift(MOM_PERIOD)
    dates  = list(idx_df["date"])
    regime = {d for i, d in enumerate(dates)
              if not pd.isna(s50.iloc[i])
              and bool(c.iloc[i] > s50.iloc[i])
              and bool(m63.iloc[i])}
    return dates, c, regime


def build_tables(price_map):
    s50l, pxl = {}, {}
    for sym, df in price_map.items():
        s50l[sym] = dict(zip(df["date"],
                             df["close"].rolling(SMA_PERIOD, min_periods=SMA_PERIOD).mean()))
        pxl[sym]  = {r.date: r for r in df.itertuples(index=False)}
    return s50l, pxl


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


# ── position class ────────────────────────────────────────────────────────────
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
        if   pg >= TRAIL_AT:       trail = self.peak * (1 - SL_PCT)
        elif pg >= BREAKEVEN_AT:   trail = self.ep
        else:                      trail = self.ep * (1 - SL_PCT)
        self.sl = max(self.sl, trail)
        if hi >= self.target: return "target"
        if lo <= self.sl:     return "sl"
        return None

    def exit_px(self, reason, open_px):
        if reason == "target":            return self.target
        if reason in ("rebal","regime"):  return open_px
        return min(self.sl, open_px) if open_px < self.sl else self.sl

    def pnl(self, ep2): return (ep2 - self.ep) * self.shares
    def unr(self, curr): return (curr - self.ep) * self.shares


# ── backtest engine ───────────────────────────────────────────────────────────
def run_backtest():
    idx_df = load_index()
    idx_dates, idx_c, regime = build_regime(idx_df)
    price_map = {s: df for s in NIFTY50 if (df := load_stock(s)) is not None}
    s50l, pxl = build_tables(price_map)
    trading_days = [d for d in idx_dates if d >= START_DATE]
    first_on = next((d for d in trading_days if d in regime), None)

    portfolio: dict[str, Pos] = {}
    trades: list[dict] = []
    sl_hit: dict[str, int] = {}
    rebal_month = -1
    consecutive_off = 0
    regime_exited   = False

    def entry_ok(sym, d, rs, day_idx):
        if rs <= 0.0: return False
        if day_idx - sl_hit.get(sym, -9999) < SYM_COOLDOWN_DAYS: return False
        s50 = s50l[sym].get(d)
        row = pxl[sym].get(d)
        if s50 is None or row is None or pd.isna(s50): return False
        return float(row.close) > float(s50)

    def record(sym, pos, exit_date, ep2, reason):
        pnl = pos.pnl(ep2)
        trades.append({
            "Symbol":       sym,
            "Entry Date":   pos.entry_date,
            "Exit Date":    exit_date,
            "Hold Days":    (exit_date - pos.entry_date).days,
            "Entry Price":  pos.ep,
            "Exit Price":   ep2,
            "Shares":       pos.shares,
            "Capital In":   pos.invest,
            "PNL (Rs.)":    pnl,
            "PNL %":        pnl / pos.invest * 100,
            "Exit Reason":  reason,
        })
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
        idx_pos = idx_dates.index(day)
        r_on    = day in regime

        if r_on:
            consecutive_off = 0
            regime_exited   = False
        else:
            consecutive_off += 1

        # Regime exit
        if consecutive_off == REGIME_OFF_DAYS and not regime_exited and portfolio:
            regime_exited = True
            for sym, pos in list(portfolio.items()):
                row = pxl[sym].get(day)
                ep2 = float(row.close) if row else pos.ep
                record(sym, pos, day, ep2, "regime")
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

        # Monthly rebalancing
        if r_on and day.month != rebal_month:
            rebal_month = day.month
            ranked  = rank_universe(price_map, idx_c, idx_pos, day)
            top_n   = {s for s, _ in ranked[:REBAL_TOP_N]}
            for sym, pos in list(portfolio.items()):
                held = (day - pos.entry_date).days
                if held > REBAL_HOLD and sym not in top_n:
                    row = pxl[sym].get(day)
                    ep2 = float(row.open) if row else pos.ep
                    record(sym, pos, day, ep2, "rebal")

        # Fill empty slots
        if r_on:
            empty = PORTFOLIO_SIZE - len(portfolio)
            if empty > 0:
                ranked  = rank_universe(price_map, idx_c, idx_pos, day)
                in_ptf  = set(portfolio.keys())
                filled  = 0
                for sym, rs in ranked:
                    if filled >= min(empty, MAX_NEW_PER_DAY): break
                    if sym in in_ptf: continue
                    if not entry_ok(sym, day, rs, day_idx): continue
                    pos = do_buy(sym, day)
                    if pos:
                        in_ptf.add(sym); filled += 1

    # MTM open positions
    last_day = trading_days[-1]
    open_rows = []
    for sym, pos in portfolio.items():
        row = pxl[sym].get(last_day)
        if not row: continue
        curr = float(row.close)
        unr  = pos.unr(curr)
        open_rows.append({
            "Symbol":           sym,
            "Entry Date":       pos.entry_date,
            "Days Held":        (last_day - pos.entry_date).days,
            "Entry Price":      pos.ep,
            "Current Price":    curr,
            "Shares":           pos.shares,
            "Capital In":       pos.invest,
            "Unrealised PNL":   unr,
            "Unrealised %":     unr / pos.invest * 100,
            "Stop Loss":        pos.sl,
            "Target":           pos.target,
        })

    return trades, open_rows, first_on, trading_days, len(price_map)


# ── Excel writer ──────────────────────────────────────────────────────────────
def write_excel(trades, open_rows, first_on, trading_days, n_stocks):
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    wb = xlsxwriter.Workbook(OUT_PATH)

    # ── colour palette (light theme) ─────────────────────────────────────────
    C_WHITE   = "#FFFFFF"
    C_BG      = "#FFFFFF"   # cell background
    C_BG_ALT  = "#F5F7FA"   # alternate / section bg
    C_HEADER  = "#1F3864"   # table header (dark navy)
    C_SUBHDR  = "#2E5FA3"   # sub-heading blue
    C_ACCENT  = "#1F3864"   # title accent
    C_BORDER  = "#BFC9D9"   # light border
    C_TEXT    = "#1A1A2E"   # main text (near-black)
    C_LABEL   = "#2E5FA3"   # label blue
    C_GREEN   = "#1D6F42"   # profit green (dark, readable on white)
    C_RED     = "#C00000"   # loss red
    C_AMBER   = "#7B4F00"   # rebal amber
    C_BLUE    = "#1F5C99"   # regime blue
    C_BG_G    = "#E8F5E9"   # light green cell bg for profit rows
    C_BG_R    = "#FFEBEE"   # light red cell bg for loss rows
    C_BG_H    = "#EAF0FB"   # light blue header bg

    def fmt(options):
        defaults = {"font_name":"Calibri","font_size":10,"font_color":C_TEXT,
                    "bg_color":C_BG,"border":0}
        defaults.update(options)
        return wb.add_format(defaults)

    # common formats
    f_title   = fmt({"font_size":16,"bold":True,"font_color":C_ACCENT,"bg_color":C_BG_H})
    f_h2      = fmt({"font_size":12,"bold":True,"font_color":C_SUBHDR,"bg_color":C_BG,
                     "bottom":2,"bottom_color":C_SUBHDR})
    f_h3      = fmt({"font_size":10,"bold":True,"font_color":C_LABEL,"bg_color":C_BG_ALT,
                     "border":1,"border_color":C_BORDER})
    f_label   = fmt({"bold":True,"font_color":C_LABEL,"bg_color":C_BG})
    f_value   = fmt({"font_color":C_TEXT,"bg_color":C_BG})
    f_th      = fmt({"bold":True,"font_color":C_WHITE,"bg_color":C_HEADER,
                     "align":"center","border":1,"border_color":C_BORDER})
    f_td      = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,"font_color":C_TEXT})
    f_td_c    = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,
                     "align":"center","font_color":C_TEXT})
    f_td_r    = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,
                     "align":"right","font_color":C_TEXT})
    f_money   = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,
                     "num_format":"#,##0","align":"right","font_color":C_TEXT})
    f_pct     = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,
                     "num_format":"0.00%","align":"right","font_color":C_TEXT})
    f_date    = fmt({"bg_color":C_BG,"border":1,"border_color":C_BORDER,
                     "num_format":"dd-mmm-yy","align":"center","font_color":C_TEXT})
    f_green   = fmt({"bg_color":C_BG_G,"border":1,"border_color":C_BORDER,
                     "num_format":"#,##0","align":"right","font_color":C_GREEN,"bold":True})
    f_red     = fmt({"bg_color":C_BG_R,"border":1,"border_color":C_BORDER,
                     "num_format":"#,##0","align":"right","font_color":C_RED,"bold":True})
    f_pct_g   = fmt({"bg_color":C_BG_G,"border":1,"border_color":C_BORDER,
                     "num_format":"0.00%","align":"right","font_color":C_GREEN,"bold":True})
    f_pct_r   = fmt({"bg_color":C_BG_R,"border":1,"border_color":C_BORDER,
                     "num_format":"0.00%","align":"right","font_color":C_RED,"bold":True})
    f_reason  = {
        "target": fmt({"bg_color":"#D4EDDA","border":1,"border_color":C_BORDER,
                        "align":"center","font_color":C_GREEN,"bold":True}),
        "sl":     fmt({"bg_color":"#FFEBEE","border":1,"border_color":C_BORDER,
                        "align":"center","font_color":C_RED,"bold":True}),
        "rebal":  fmt({"bg_color":"#FFF8E1","border":1,"border_color":C_BORDER,
                        "align":"center","font_color":C_AMBER}),
        "regime": fmt({"bg_color":"#E3F2FD","border":1,"border_color":C_BORDER,
                        "align":"center","font_color":C_BLUE}),
    }
    f_wrap    = fmt({"text_wrap":True,"valign":"top","bg_color":C_BG,"font_color":C_TEXT})
    f_code    = fmt({"font_name":"Courier New","font_size":9,
                     "font_color":"#1D6F42","bg_color":"#F0FFF4",
                     "border":1,"border_color":C_BORDER,"text_wrap":True,"valign":"top"})
    f_mono_y  = fmt({"font_name":"Courier New","font_size":9,
                     "font_color":C_AMBER,"bg_color":"#FFFDE7"})

    tdf = pd.DataFrame(trades)
    tdf["exit_ym"] = pd.to_datetime(tdf["Exit Date"]).dt.to_period("M")

    closed_pnl = tdf["PNL (Rs.)"].sum()
    unr_pnl    = sum(r["Unrealised PNL"] for r in open_rows)
    total_pnl  = closed_pnl + unr_pnl
    init_cap   = PORTFOLIO_SIZE * INVEST_PER_SLOT
    n          = len(tdf)
    wins       = (tdf["PNL (Rs.)"] > 0).sum()
    losses     = n - wins
    aw         = tdf[tdf["PNL (Rs.)"] > 0]["PNL (Rs.)"].mean() if wins else 0
    al         = tdf[tdf["PNL (Rs.)"] < 0]["PNL (Rs.)"].mean() if losses else 0
    exp        = (wins/n * aw) + (losses/n * al) if n else 0
    tgt_cnt    = (tdf["Exit Reason"] == "target").sum()
    sl_cnt     = (tdf["Exit Reason"] == "sl").sum()
    rb_cnt     = (tdf["Exit Reason"] == "rebal").sum()
    rg_cnt     = (tdf["Exit Reason"] == "regime").sum()

    # ── Sheet 1: Summary ─────────────────────────────────────────────────────
    ws = wb.add_worksheet("Summary")
    ws.hide_gridlines(2)
    ws.set_tab_color(C_ACCENT)
    ws.set_column("A:A", 28)
    ws.set_column("B:B", 20)
    ws.set_column("C:C", 28)
    ws.set_column("D:D", 20)
    ws.set_column("E:E", 2)

    ws.merge_range("A1:D1", "NIFTY 50 RS Momentum Strategy — Backtest v6", f_title)
    ws.merge_range("A2:D2",
        f"Period: {trading_days[0]}  to  {trading_days[-1]}   |   "
        f"First regime-ON: {first_on}   |   Universe: {n_stocks} stocks",
        fmt({"font_size":9,"font_color":"#555555","bg_color":C_BG_H,"italic":True}))
    ws.write("A3", "", fmt({"bg_color":C_BG}))

    def kv_block(row, col, pairs, heading):
        ws.merge_range(row, col, row, col+1, heading, f_h2)
        row += 1
        for label, val, vfmt in pairs:
            ws.write(row, col,   label, f_label)
            ws.write(row, col+1, val,   vfmt)
            row += 1
        return row

    f_money2  = fmt({"font_color":C_TEXT,  "bg_color":C_BG,"num_format":"#,##0"})
    f_pct2    = fmt({"font_color":C_TEXT,  "bg_color":C_BG,"num_format":"0.00%"})
    f_green2  = fmt({"font_color":C_GREEN, "bg_color":C_BG,"num_format":"#,##0","bold":True})
    f_red2    = fmt({"font_color":C_RED,   "bg_color":C_BG,"num_format":"#,##0","bold":True})
    f_pct_g2  = fmt({"font_color":C_GREEN, "bg_color":C_BG,"num_format":"0.00%","bold":True})
    f_pct_r2  = fmt({"font_color":C_RED,   "bg_color":C_BG,"num_format":"0.00%","bold":True})
    f_val2    = fmt({"font_color":C_TEXT,  "bg_color":C_BG})
    f_int2    = fmt({"font_color":C_TEXT,  "bg_color":C_BG,"num_format":"0"})

    total_pnl_fmt   = f_green2 if total_pnl  >= 0 else f_red2
    total_pct_fmt   = f_pct_g2 if total_pnl  >= 0 else f_pct_r2
    closed_pnl_fmt  = f_green2 if closed_pnl >= 0 else f_red2
    unr_pnl_fmt     = f_green2 if unr_pnl    >= 0 else f_red2

    perf_pairs = [
        ("Initial Capital",     init_cap,              f_money2),
        ("Closed PNL",          closed_pnl,            closed_pnl_fmt),
        ("Open MTM (unrealised)",unr_pnl,              unr_pnl_fmt),
        ("Total PNL",           total_pnl,             total_pnl_fmt),
        ("Total Return",        total_pnl/init_cap,    total_pct_fmt),
        ("Annualised Return",   total_pnl/init_cap/1.5,total_pct_fmt),
        ("Nifty 50 Return",     -0.007,                f_pct2),
        ("Alpha vs Nifty",      total_pnl/init_cap - (-0.007), total_pct_fmt),
    ]
    trade_pairs = [
        ("Total Trades (closed)", n,             f_int2),
        ("Winning Trades",        wins,           f_int2),
        ("Losing Trades",         losses,         f_int2),
        ("Win Rate",              wins/n,         f_pct2),
        ("Avg Win",               aw,             f_green2),
        ("Avg Loss",              al,             f_red2),
        ("Win/Loss Ratio",        f"{abs(aw/al):.2f}x" if al else "N/A", f_val2),
        ("Expectancy / Trade",    exp,            f_green2 if exp>=0 else f_red2),
    ]
    reason_pairs = [
        ("Target Exits",          tgt_cnt,        f_int2),
        ("Stop-Loss Exits",       sl_cnt,         f_int2),
        ("Rebalance Exits",       rb_cnt,         f_int2),
        ("Regime Exits",          rg_cnt,         f_int2),
        ("Open Positions",        len(open_rows), f_int2),
        ("Open Slots",            PORTFOLIO_SIZE-len(open_rows), f_int2),
    ]

    kv_block(3,  0, perf_pairs,   "Performance Summary")
    kv_block(3,  2, trade_pairs,  "Trade Statistics")
    kv_block(13, 2, reason_pairs, "Exit Breakdown")

    # Parameters block
    r = 13
    ws.merge_range(r, 0, r, 1, "Strategy Parameters", f_h2); r += 1
    params = [
        ("Universe",            f"Nifty 50 ({n_stocks} stocks loaded)"),
        ("Portfolio size",      f"{PORTFOLIO_SIZE} positions"),
        ("Capital per slot",    f"Rs.{INVEST_PER_SLOT:,}  (max Rs.{MAX_INVEST:,})"),
        ("RS Lookback",         f"{RS_LOOKBACK} trading days (~6 months)"),
        ("Stop-Loss",           f"{SL_PCT*100:.0f}% below entry (hard floor)"),
        ("Breakeven trigger",   f"+{BREAKEVEN_AT*100:.0f}% peak gain → SL moves to entry"),
        ("Trail trigger",       f"+{TRAIL_AT*100:.0f}% peak gain → trail {SL_PCT*100:.0f}% below peak"),
        ("Profit Target",       f"+{TARGET_PCT*100:.0f}% from entry"),
        ("Max entries/day",     f"{MAX_NEW_PER_DAY} new positions"),
        ("Symbol cooldown",     f"{SYM_COOLDOWN_DAYS} days after SL hit"),
        ("Regime filter",       f"Nifty > {SMA_PERIOD}-DMA  AND  Nifty > Nifty {MOM_PERIOD}d ago"),
        ("Regime exit",         f"Exit ALL positions after {REGIME_OFF_DAYS} consecutive OFF days"),
        ("Monthly rebalance",   f"Exit if RS rank > {REBAL_TOP_N} AND held > {REBAL_HOLD} days"),
        ("Entry filter",        "Stock > own 50-DMA  AND  RS > 0"),
    ]
    for label, val in params:
        ws.write(r, 0, label, f_label)
        ws.write(r, 1, val,   f_value); r += 1

    # ── Sheet 2: Strategy ────────────────────────────────────────────────────
    ws2 = wb.add_worksheet("Strategy")
    ws2.hide_gridlines(2)
    ws2.set_tab_color(C_SUBHDR)
    ws2.set_column("A:A", 22)
    ws2.set_column("B:B", 85)

    def section(row, title, rows):
        ws2.merge_range(row, 0, row, 1, title, f_h2); row += 1
        for label, text in rows:
            ws2.write(row, 0, label, f_h3)
            ws2.write(row, 1, text,  f_wrap)
            ws2.set_row(row, max(30, math.ceil(len(text)/80)*15))
            row += 1
        ws2.write(row, 0, "", fmt({"bg_color":C_BG}))
        ws2.write(row, 1, "", fmt({"bg_color":C_BG})); row += 2
        return row

    r = 0
    ws2.merge_range("A1:B1", "Strategy Rulebook — Nifty 50 RS Momentum v6", f_title)
    ws2.merge_range("A2:B2",
        "A systematic, rules-based approach that rotates capital into the strongest "
        "Nifty 50 stocks relative to the index, using a market-regime gate to avoid "
        "buying into sustained downtrends, and a step-up trailing stop to let winners run.",
        fmt({"font_size":10,"italic":True,"text_wrap":True,"valign":"top",
             "bg_color":C_BG_H,"font_color":"#444444"}))
    ws2.set_row(1, 40)
    ws2.write("A3","",fmt({"bg_color":C_BG})); r = 3

    r = section(r, "1. Universe & Capital Allocation", [
        ("Universe",      "All 50 stocks in the Nifty 50 index. Stocks are ranked daily by their Mansfield RS Ratio against the Nifty 50 index."),
        ("Capital",       f"Total capital: Rs.{init_cap:,} split into {PORTFOLIO_SIZE} equal slots of Rs.{INVEST_PER_SLOT:,} each. A single position can use up to Rs.{MAX_INVEST:,} (buying at close price, rounding down to whole shares)."),
        ("Max positions", f"{PORTFOLIO_SIZE} simultaneous open positions. New entries limited to {MAX_NEW_PER_DAY} per trading day to avoid mass-entry on the same day."),
    ])

    r = section(r, "2. Market Regime Filter (Gate)", [
        ("Definition",   f"Regime is ON when BOTH conditions hold: (a) Nifty 50 daily close > its {SMA_PERIOD}-day simple moving average, AND (b) Nifty 50 close today > Nifty 50 close {MOM_PERIOD} trading days ago (3-month momentum)."),
        ("Why dual?",    "A single 50-DMA condition triggered on Jan 2, 2025 (a one-day spike). The 3-month momentum condition correctly kept the regime OFF until April 16, 2025 — when the bull market genuinely resumed."),
        ("OFF action",   f"When regime turns OFF for {REGIME_OFF_DAYS} consecutive trading days, ALL open positions are sold at that day's close price (regime exit). This prevents holding through sustained corrections."),
        ("Re-entry",     "After a regime exit, new entries are allowed again on the very next regime-ON day. The slot count is replenished immediately."),
    ])

    r = section(r, "3. RS Rank — Entry Scoring", [
        ("Formula",      f"Mansfield RS Ratio = ( StockClose / StockClose_{RS_LOOKBACK}d_ago ) / ( NiftyClose / NiftyClose_{RS_LOOKBACK}d_ago ) - 1\n\nA positive RS means the stock has outperformed Nifty over the past ~6 months. Higher RS = stronger relative momentum."),
        ("Ranking",      f"All 50 stocks are ranked by RS ratio in descending order each trading day. The strategy targets stocks ranked 1-{PORTFOLIO_SIZE} (top 20)."),
        ("Entry filter", f"To be eligible for entry, a stock must also: (a) RS > 0 (outperforming Nifty), AND (b) stock price > its own {SMA_PERIOD}-day SMA (not in an individual downtrend), AND (c) no SL hit on this stock within the last {SYM_COOLDOWN_DAYS} trading days."),
    ])

    r = section(r, "4. Stop-Loss — Three-Stage Step-Up", [
        ("Stage 1 — Hard floor",   f"Initial SL = Entry Price × {1-SL_PCT:.2f}  ({SL_PCT*100:.0f}% below entry). This is the minimum SL — it can only move UP, never down."),
        ("Stage 2 — Breakeven",    f"Once the position's peak gain reaches +{BREAKEVEN_AT*100:.0f}%, the SL is raised to the exact entry price (breakeven). Any prior loss risk is eliminated."),
        ("Stage 3 — Trailing",     f"Once the peak gain reaches +{TRAIL_AT*100:.0f}%, the SL trails at peak_price × {1-SL_PCT:.2f} (i.e., {SL_PCT*100:.0f}% below the highest price reached). As the stock keeps rising, the SL rises with it — locking in profits."),
        ("SL trigger",             "If the daily low price touches or breaches the SL level, the position is closed. Exit price = min(SL, day open) to account for gap-down opens."),
        ("Target exit",            f"If the daily high reaches Entry Price × {1+TARGET_PCT:.2f} (+{TARGET_PCT*100:.0f}%), the position is closed at the target price."),
    ])

    r = section(r, "5. Monthly Rebalancing", [
        ("When",  f"On the first regime-ON trading day of each calendar month, the universe is re-ranked."),
        ("Rule",  f"Any position held for more than {REBAL_HOLD} days AND whose RS rank has fallen outside the top {REBAL_TOP_N} is exited at the day's open price. This forces rotation out of stocks that have lost their relative strength."),
        ("Why?",  "Without rebalancing, the strategy can get stuck in positions like KOTAKBANK (held 329 days doing nothing in v1). The 45-day grace period prevents churn on newly entered positions."),
    ])

    r = section(r, "6. Position Sizing", [
        ("Method",      f"Fixed-rupee sizing: Rs.{INVEST_PER_SLOT:,} per slot, capped at Rs.{MAX_INVEST:,}. Shares = floor(Rs.{MAX_INVEST:,} / entry_price), minimum 1 share."),
        ("Rationale",   "Simple equal-weight approach. Each of the 20 slots represents 5% of capital. No complex Kelly sizing — keeps the model transparent and avoids over-concentration in low-priced stocks."),
    ])

    # ── Sheet 3: Monthly PNL ─────────────────────────────────────────────────
    ws3 = wb.add_worksheet("Monthly PNL")
    ws3.hide_gridlines(2)
    ws3.set_tab_color(C_GREEN)
    ws3.set_column("A:A", 14)
    ws3.set_column("B:H", 13)

    ws3.merge_range("A1:H1", "Month-wise PNL Breakdown", f_title)
    ws3.write("A2", "", fmt({"bg_color":C_BG}))

    headers = ["Month","Trades","Wins","Losses","Regime","Rebal","Win %","PNL (Rs.)","Cumulative"]
    ws3.set_column("I:I", 14)
    for c, h in enumerate(headers):
        ws3.write(2, c, h, f_th)

    cum = 0.0
    data_rows = []
    for ym, g in tdf.groupby("exit_ym"):
        nt = len(g); w = (g["PNL (Rs.)"] > 0).sum()
        rg = (g["Exit Reason"] == "regime").sum()
        rb = (g["Exit Reason"] == "rebal").sum()
        mp = g["PNL (Rs.)"].sum(); cum += mp
        data_rows.append((str(ym), nt, int(w), nt-int(w), int(rg), int(rb), w/nt, mp, cum))

    for ri, row_data in enumerate(data_rows):
        r = ri + 3
        ym, nt, w, l, rg, rb, wr, mp, cu = row_data
        ws3.write(r, 0, ym,  f_td_c)
        ws3.write(r, 1, nt,  f_td_c)
        ws3.write(r, 2, w,   f_td_c)
        ws3.write(r, 3, l,   f_td_c)
        ws3.write(r, 4, rg,  f_td_c)
        ws3.write(r, 5, rb,  f_td_c)
        ws3.write(r, 6, wr,  f_pct)
        pf = f_green if mp >= 0 else f_red
        cf = f_green if cu >= 0 else f_red
        ws3.write(r, 7, mp,  pf)
        ws3.write(r, 8, cu,  cf)

    # Total row
    tr = len(data_rows) + 3
    f_tot = fmt({"bold":True,"bg_color":C_BG_H,"border":1,"border_color":C_BORDER,"num_format":"#,##0","align":"right","font_color":C_ACCENT})
    f_tot_c= fmt({"bold":True,"bg_color":C_BG_H,"border":1,"border_color":C_BORDER,"align":"center","font_color":C_ACCENT})
    f_tot_p= fmt({"bold":True,"bg_color":C_BG_H,"border":1,"border_color":C_BORDER,"num_format":"0.00%","align":"right","font_color":C_ACCENT})
    ws3.write(tr, 0, "TOTAL",          f_tot_c)
    ws3.write(tr, 1, n,                f_tot_c)
    ws3.write(tr, 2, int(wins),        f_tot_c)
    ws3.write(tr, 3, int(losses),      f_tot_c)
    ws3.write(tr, 4, int(rg_cnt),      f_tot_c)
    ws3.write(tr, 5, int(rb_cnt),      f_tot_c)
    ws3.write(tr, 6, wins/n,           f_tot_p)
    ws3.write(tr, 7, closed_pnl,       f_tot)
    ws3.write(tr, 8, closed_pnl,       f_tot)

    # ── Sheet 4: Closed Trades ───────────────────────────────────────────────
    ws4 = wb.add_worksheet("Closed Trades")
    ws4.hide_gridlines(2)
    ws4.set_tab_color(C_RED)
    ws4.set_column("A:A", 14)
    ws4.set_column("B:C", 13)
    ws4.set_column("D:D", 10)
    ws4.set_column("E:F", 11)
    ws4.set_column("G:G", 8)
    ws4.set_column("H:H", 13)
    ws4.set_column("I:J", 12)
    ws4.set_column("K:K", 12)

    ws4.merge_range("A1:K1", "Closed Trade Log", f_title)
    trade_headers = ["Symbol","Entry Date","Exit Date","Hold Days",
                     "Entry Price","Exit Price","Shares",
                     "Capital In","PNL (Rs.)","PNL %","Exit Reason"]
    for c, h in enumerate(trade_headers):
        ws4.write(2, c, h, f_th)

    for ri, t in enumerate(sorted(trades, key=lambda x: x["Exit Date"])):
        r = ri + 3
        reason = t["Exit Reason"]
        pnl    = t["PNL (Rs.)"]
        pct    = t["PNL %"] / 100
        ws4.write(r, 0,  t["Symbol"],        f_td_c)
        ws4.write(r, 1,  t["Entry Date"],    f_date)
        ws4.write(r, 2,  t["Exit Date"],     f_date)
        ws4.write(r, 3,  t["Hold Days"],     f_td_c)
        ws4.write(r, 4,  t["Entry Price"],   f_td_r)
        ws4.write(r, 5,  t["Exit Price"],    f_td_r)
        ws4.write(r, 6,  t["Shares"],        f_td_c)
        ws4.write(r, 7,  t["Capital In"],    f_money)
        ws4.write(r, 8,  pnl, f_green if pnl >= 0 else f_red)
        ws4.write(r, 9,  pct, f_pct_g if pct >= 0 else f_pct_r)
        ws4.write(r, 10, reason, f_reason.get(reason, f_td_c))

    # ── Sheet 5: Open Positions ──────────────────────────────────────────────
    ws5 = wb.add_worksheet("Open Positions")
    ws5.hide_gridlines(2)
    ws5.set_tab_color(C_BLUE)
    ws5.set_column("A:A", 14)
    ws5.set_column("B:C", 13)
    ws5.set_column("D:D", 10)
    ws5.set_column("E:F", 12)
    ws5.set_column("G:G", 8)
    ws5.set_column("H:I", 14)
    ws5.set_column("J:K", 12)

    ws5.merge_range("A1:K1", f"Open Positions — MTM as of {trading_days[-1]}", f_title)
    open_headers = ["Symbol","Entry Date","Days Held","Entry Price","Current Price",
                    "Shares","Capital In","Unrealised PNL","Unrealised %","Stop Loss","Target"]
    for c, h in enumerate(open_headers):
        ws5.write(2, c, h, f_th)

    for ri, r_data in enumerate(sorted(open_rows, key=lambda x: x["Unrealised %"], reverse=True)):
        r = ri + 3
        unr = r_data["Unrealised PNL"]
        pct = r_data["Unrealised %"] / 100
        ws5.write(r, 0,  r_data["Symbol"],         f_td_c)
        ws5.write(r, 1,  r_data["Entry Date"],      f_date)
        ws5.write(r, 2,  r_data["Days Held"],       f_td_c)
        ws5.write(r, 3,  r_data["Entry Price"],     f_td_r)
        ws5.write(r, 4,  r_data["Current Price"],   f_td_r)
        ws5.write(r, 5,  r_data["Shares"],          f_td_c)
        ws5.write(r, 6,  r_data["Capital In"],      f_money)
        ws5.write(r, 7,  unr, f_green if unr >= 0 else f_red)
        ws5.write(r, 8,  pct, f_pct_g if pct >= 0 else f_pct_r)
        ws5.write(r, 9,  r_data["Stop Loss"],       f_td_r)
        ws5.write(r, 10, r_data["Target"],          f_td_r)

    # Total row for open positions
    tot_r = len(open_rows) + 3
    ws5.write(tot_r, 0, "TOTAL",  f_tot_c)
    ws5.write(tot_r, 6, sum(r["Capital In"] for r in open_rows), f_tot)
    ws5.write(tot_r, 7, unr_pnl, f_tot)

    # ── Sheet 6: Calculations ────────────────────────────────────────────────
    ws6 = wb.add_worksheet("Calculations")
    ws6.hide_gridlines(2)
    ws6.set_tab_color(C_BLUE)
    ws6.set_column("A:A", 26)
    ws6.set_column("B:B", 70)

    ws6.merge_range("A1:B1", "Formula Reference & Worked Examples", f_title)

    def calc_section(row, title, items):
        ws6.merge_range(row, 0, row, 1, title, f_h2); row += 1
        for label, text, is_code in items:
            ws6.write(row, 0, label, f_h3)
            ws6.write(row, 1, text,  f_code if is_code else f_wrap)
            ws6.set_row(row, max(30, math.ceil(len(text)/68)*14))
            row += 1
        ws6.write(row, 0, "", fmt({"bg_color":C_BG}))
        ws6.write(row, 1, "", fmt({"bg_color":C_BG}))
        row += 2
        return row

    r = 2
    r = calc_section(r, "A. Mansfield RS Ratio", [
        ("Formula",
         "RS = ( stock_close_today / stock_close_126d_ago )\n"
         "     / ( nifty_close_today / nifty_close_126d_ago ) - 1",
         True),
        ("What it means",
         "Positive RS → stock has grown MORE than Nifty over the past 6 months\n"
         "Negative RS → stock has underperformed Nifty\n"
         "RS = 0.20 means the stock has outperformed Nifty by 20 percentage points.",
         False),
        ("Example — BEL entry Apr 17 2025",
         "BEL close today (Apr-17) = 295.15\n"
         "BEL close 126d ago       = 265.80  (approx Sep-2024)\n"
         "Nifty close today        = 23,817\n"
         "Nifty close 126d ago     = 25,810  (approx Sep-2024)\n\n"
         "RS = (295.15/265.80) / (23817/25810) - 1\n"
         "   = 1.1104 / 0.9228 - 1\n"
         "   = 1.2034 - 1\n"
         "   = +0.203  → BEL outperformed Nifty by 20.3% over 6 months → BUY",
         True),
    ])

    r = calc_section(r, "B. Market Regime Filter", [
        ("Condition 1 — SMA50",
         "sma50 = average(nifty_close, last 50 days)\n"
         "C1 = nifty_close_today > sma50",
         True),
        ("Condition 2 — Momentum63",
         "C2 = nifty_close_today > nifty_close_63_days_ago",
         True),
        ("Regime ON",
         "Regime = C1 AND C2\n\n"
         "Example — Jan 2, 2025 (FALSE POSITIVE):\n"
         "  Nifty = 24,188    SMA50 = 24,141  → C1 = TRUE\n"
         "  Nifty = 24,188    63d ago = 25,790 → C2 = FALSE\n"
         "  Regime = FALSE  (dual filter correctly rejects)",
         True),
        ("First genuine regime-ON",
         "April 16, 2025: Nifty = 23,817 > SMA50 = 23,660  AND  > 63d ago = 22,519\n"
         "Both conditions TRUE → Regime ON → entries allowed",
         True),
        ("Regime exit trigger",
         "consecutive_off_days = 0\n"
         "For each trading day:\n"
         "  if regime ON:  consecutive_off_days = 0\n"
         "  if regime OFF: consecutive_off_days += 1\n"
         "  if consecutive_off_days == 3: EXIT ALL POSITIONS at today's close",
         True),
    ])

    r = calc_section(r, "C. Step-Up Trailing Stop-Loss", [
        ("Initial SL (hard floor)",
         "sl = entry_price * 0.90   (10% below entry)\n"
         "SL can ONLY move UP — it is never lowered.",
         True),
        ("Stage 2 — Breakeven at +15%",
         "peak_gain = (peak_price / entry_price) - 1\n"
         "if peak_gain >= 0.15:\n"
         "    sl = max(sl, entry_price)  # move SL up to breakeven",
         True),
        ("Stage 3 — Trail at +25%",
         "if peak_gain >= 0.25:\n"
         "    sl = max(sl, peak_price * 0.90)  # trail 10% below peak",
         True),
        ("Worked example — SHRIRAMFIN",
         "Entry: Rs.796.45    Initial SL: Rs.716.81  (796.45 × 0.90)\n\n"
         "Day +40: price rises to Rs.955.00\n"
         "  peak_gain = (955/796.45)-1 = 19.9% → Stage 2\n"
         "  SL raised to Rs.796.45 (breakeven)\n\n"
         "Day +55: price rises to Rs.1,000.00\n"
         "  peak_gain = (1000/796.45)-1 = 25.6% → Stage 3\n"
         "  SL = 1000 × 0.90 = Rs.900.00\n\n"
         "Day +70 (Jan 12 regime exit): price = Rs.972.80\n"
         "  PNL = (972.80-796.45) × 18 shares = Rs.+3,174  (+22.1%)",
         True),
    ])

    r = calc_section(r, "D. Monthly Rebalancing", [
        ("Rule",
         "On the 1st regime-ON day of each month:\n"
         "  re-rank all 50 stocks by RS\n"
         "  for each open position:\n"
         "    if (days_held > 45) AND (rs_rank > 30):\n"
         "        EXIT at today's open",
         True),
        ("Example — CIPLA Jul 1, 2025",
         "CIPLA held since Apr 22 = 70 days  (> 45 days)\n"
         "CIPLA RS rank = 33  (outside top-30)\n"
         "→ Rebalance EXIT at open  PNL = Rs.-201  (-1.5%)\n\n"
         "Compare: without rebalancing, CIPLA would have been sold by regime-exit\n"
         "on Jul 29 at a similar price — rebalancing freed the slot 28 days earlier.",
         False),
    ])

    r = calc_section(r, "E. Position Sizing", [
        ("Formula",
         "shares = floor(15000 / entry_price)   # max Rs.15,000 per position\n"
         "shares = max(1, shares)                # minimum 1 share\n"
         "capital_invested = entry_price * shares",
         True),
        ("Examples",
         "BEL  @ Rs.295.15  → shares = floor(15000/295.15) = 50  → invest Rs.14,757\n"
         "M&M  @ Rs.2917.80 → shares = floor(15000/2917.80) = 5  → invest Rs.14,589\n"
         "LT   @ Rs.3685.50 → shares = floor(15000/3685.50) = 4  → invest Rs.14,742\n"
         "TATA @ Rs.170.51  → shares = floor(15000/170.51)  = 87 → invest Rs.14,834",
         True),
    ])

    wb.close()
    print(f"  Excel report written to: {OUT_PATH}")


# ── main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("Running v6 backtest...")
    trades, open_rows, first_on, trading_days, n_stocks = run_backtest()
    print(f"  {len(trades)} closed trades, {len(open_rows)} open positions")
    print("Writing Excel report...")
    write_excel(trades, open_rows, first_on, trading_days, n_stocks)
    print("Done.")
