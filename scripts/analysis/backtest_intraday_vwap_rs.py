"""
Intraday VWAP + relative-strength backtest for the Nifty 50 universe.

Replays the 1-minute store bar-by-bar across all 50 symbols, running the SAME
rules the live strategy runs — every signal decision comes from
lib/intraday_signals.py, which strategies/intraday_equity/nifty50_vwap_rs.py
also imports. Nothing about entry, sizing, stops or exits is reimplemented here.
That shared-module discipline is what makes a dry-run/replay reconciliation
meaningful; the rest of scripts/analysis/ forked its logic and cannot do this.

READ THIS BEFORE TRUSTING A RESULT
----------------------------------
The store holds ~81 sessions (Dhan serves a limited trailing window of 1-minute
data). That is enough to REJECT a broken rule set and to measure how sensitive
the edge is to costs. It is NOT enough to choose parameters: 81 sessions is one
market regime, and tuning on it produces a number that describes the past, not
an edge. This harness is a falsification tool, not an optimizer, and --sweep
refuses to run below 40 sessions for exactly that reason.

Usage:
    venv\\Scripts\\python.exe scripts/analysis/backtest_intraday_vwap_rs.py
    venv\\Scripts\\python.exe scripts/analysis/backtest_intraday_vwap_rs.py --symbols RELIANCE --verbose
    venv\\Scripts\\python.exe scripts/analysis/backtest_intraday_vwap_rs.py --cost-sensitivity
    venv\\Scripts\\python.exe scripts/analysis/backtest_intraday_vwap_rs.py --start 2026-06-01 --excel
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.intraday_signals import (  # noqa: E402
    NIFTY50, BENCHMARK_KEY, IntradayConfig, Candidate, Position,
    build_features, exit_reason, initial_stop, load_1m, load_benchmark_1m,
    load_store, position_size, rank_candidates, select_new_entries,
    sector_of, target_price, trail_stop,
)

DEBUG_DIR = os.path.join(ROOT, "debug")
REPORTS_DIR = os.path.join(ROOT, "reports")
SUMMARY_JSON = os.path.join(DEBUG_DIR, "intraday_backtest_summary.json")


# ── Records ───────────────────────────────────────────────────────────────────
@dataclass
class Trade:
    symbol: str
    side: str
    qty: int
    entry_ts: pd.Timestamp
    entry_price: float
    exit_ts: pd.Timestamp
    exit_price: float
    exit_reason: str
    entry_score: float
    conditions: Dict[str, bool]
    gross_pnl: float
    costs: float
    net_pnl: float
    r_multiple: float
    mae: float                 # max adverse excursion, in R
    mfe: float                 # max favourable excursion, in R
    bars_held: int
    sector: str = ""

    def to_row(self) -> dict:
        d = dict(self.__dict__)
        d["conditions"] = ",".join(k for k, v in self.conditions.items() if v)
        return d


@dataclass
class BacktestResult:
    cfg: IntradayConfig
    trades: List[Trade] = field(default_factory=list)
    sessions: int = 0
    symbols: int = 0
    first_session: Optional[date] = None
    last_session: Optional[date] = None
    skipped_unsizable: int = 0
    blocked_by_caps: int = 0

    # ── Frames ────────────────────────────────────────────────────────────
    def trades_df(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame(columns=[f.name for f in Trade.__dataclass_fields__.values()])
        return pd.DataFrame([t.to_row() for t in self.trades])

    def daily(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame(columns=["date", "trades", "gross", "costs", "net", "cum", "peak", "dd"])
        df = self.trades_df()
        df["date"] = pd.to_datetime(df["exit_ts"]).dt.date
        g = df.groupby("date").agg(trades=("net_pnl", "size"), gross=("gross_pnl", "sum"),
                                   costs=("costs", "sum"), net=("net_pnl", "sum")).reset_index()
        g["cum"] = g["net"].cumsum()
        g["peak"] = g["cum"].cummax()
        g["dd"] = g["cum"] - g["peak"]
        return g

    def per_symbol(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame()
        df = self.trades_df()
        g = df.groupby("symbol").agg(
            trades=("net_pnl", "size"), net=("net_pnl", "sum"),
            wins=("net_pnl", lambda s: int((s > 0).sum())),
            avg_r=("r_multiple", "mean"),
        ).reset_index()
        g["win_rate"] = (g["wins"] / g["trades"] * 100).round(1)
        return g.sort_values("net", ascending=False)

    def per_hour(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame()
        df = self.trades_df()
        df["hour"] = pd.to_datetime(df["entry_ts"]).dt.strftime("%H")
        g = df.groupby("hour").agg(trades=("net_pnl", "size"), net=("net_pnl", "sum"),
                                   avg_r=("r_multiple", "mean")).reset_index()
        return g.sort_values("hour")

    def per_reason(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame()
        df = self.trades_df()
        g = df.groupby("exit_reason").agg(trades=("net_pnl", "size"), net=("net_pnl", "sum"),
                                          avg_r=("r_multiple", "mean")).reset_index()
        return g.sort_values("net", ascending=False)

    # ── Headline metrics ──────────────────────────────────────────────────
    def metrics(self) -> dict:
        n = len(self.trades)
        if n == 0:
            return {"trades": 0, "sessions": self.sessions, "net_pnl": 0.0,
                    "expectancy_r": 0.0, "win_rate": 0.0}

        df = self.trades_df()
        net = df["net_pnl"]
        wins, losses = net[net > 0], net[net <= 0]
        daily = self.daily()
        gross_win = float(wins.sum())
        gross_loss = float(-losses.sum())

        streak = worst = 0
        for v in net:
            streak = streak + 1 if v <= 0 else 0
            worst = max(worst, streak)

        peak_equity = max(float(daily["peak"].max()) if len(daily) else 0.0, 1.0)
        return {
            "sessions":        self.sessions,
            "symbols":         self.symbols,
            "first_session":   str(self.first_session) if self.first_session else None,
            "last_session":    str(self.last_session) if self.last_session else None,
            "trades":          n,
            "trades_per_day":  round(n / max(self.sessions, 1), 2),
            "gross_pnl":       round(float(df["gross_pnl"].sum()), 2),
            "costs":           round(float(df["costs"].sum()), 2),
            "net_pnl":         round(float(net.sum()), 2),
            "win_rate":        round(len(wins) / n * 100, 1),
            "avg_win":         round(float(wins.mean()) if len(wins) else 0.0, 2),
            "avg_loss":        round(float(losses.mean()) if len(losses) else 0.0, 2),
            "expectancy_r":    round(float(df["r_multiple"].mean()), 3),
            "expectancy_inr":  round(float(net.mean()), 2),
            "profit_factor":   round(gross_win / gross_loss, 2) if gross_loss > 0 else float("inf"),
            "max_dd":          round(float(daily["dd"].min()) if len(daily) else 0.0, 2),
            "max_dd_pct":      round(float(daily["dd"].min()) / peak_equity * 100, 1) if len(daily) else 0.0,
            "longest_loss_streak": worst,
            "avg_bars_held":   round(float(df["bars_held"].mean()), 1),
            "avg_mae_r":       round(float(df["mae"].mean()), 2),
            "avg_mfe_r":       round(float(df["mfe"].mean()), 2),
            "skipped_unsizable": self.skipped_unsizable,
            "blocked_by_caps": self.blocked_by_caps,
        }


# ── Fill model ────────────────────────────────────────────────────────────────
def _slip(price: float, side: str, is_entry: bool, cfg: IntradayConfig) -> float:
    """Slippage always works against us: pay up entering a long, get less exiting."""
    adverse = 1 if (side == "LONG") == is_entry else -1
    return price * (1 + adverse * cfg.slippage_bps / 10_000.0)


def _level_fill(level: float, nxt_open: float, side: str, cfg: IntradayConfig,
                is_stop: bool) -> float:
    """Fill for a stop or target.

    A naive backtest fills every stop exactly at the stop price and thereby
    overstates results badly on 1-minute equity data, where gaps through a level
    are routine. If the next bar opens beyond the level, that open IS the fill.
    """
    if is_stop:
        gapped = nxt_open < level if side == "LONG" else nxt_open > level
    else:
        gapped = nxt_open > level if side == "LONG" else nxt_open < level
    if gapped:
        return nxt_open
    # Not gapped: fill at the level, still paying slippage on a stop.
    return _slip(level, side, is_entry=False, cfg=cfg) if is_stop else level


# ── Core replay ───────────────────────────────────────────────────────────────
def run_backtest(cfg: IntradayConfig,
                 symbols: Optional[Sequence[str]] = None,
                 start: Optional[date] = None,
                 end: Optional[date] = None,
                 preloaded: Optional[Dict[str, pd.DataFrame]] = None,
                 features: Optional[Dict[str, pd.DataFrame]] = None,
                 verbose: bool = True) -> BacktestResult:
    cfg.validate()
    symbols = list(symbols or NIFTY50)

    if features is None:
        store = preloaded if preloaded is not None else load_store(symbols)
        bench = load_1m(cfg.benchmark)
        if bench is None and verbose:
            print(f"WARNING: benchmark {cfg.benchmark} missing — RS gate will be neutral")
        if verbose:
            print(f"Building features for {len(store)} symbols…")
        features = {s: build_features(df, bench, cfg) for s, df in store.items() if len(df)}

    features = {s: f for s, f in features.items() if s in symbols and len(f)}
    if not features:
        raise SystemExit("No symbols with data — run scripts/downloader/refresh_intraday_1min.py")

    all_days = sorted({ts.date() for f in features.values() for ts in f.index.normalize().unique()})
    if start:
        all_days = [d for d in all_days if d >= start]
    if end:
        all_days = [d for d in all_days if d <= end]

    result = BacktestResult(cfg=cfg, symbols=len(features),
                            first_session=all_days[0] if all_days else None,
                            last_session=all_days[-1] if all_days else None)

    # Pre-slice per session so the inner loop never rescans the full history.
    by_day: Dict[date, Dict[str, pd.DataFrame]] = {}
    for sym, f in features.items():
        for d, grp in f.groupby(f.index.normalize()):
            day = d.date()
            if start and day < start:
                continue
            if end and day > end:
                continue
            by_day.setdefault(day, {})[sym] = grp

    for session in all_days:
        day_frames = by_day.get(session, {})
        if not day_frames:
            continue
        result.sessions += 1
        _run_session(session, day_frames, cfg, result, verbose)

    if verbose:
        print(f"Replayed {result.sessions} sessions, {len(result.trades)} trades.")
    return result


def _run_session(session: date, frames: Dict[str, pd.DataFrame], cfg: IntradayConfig,
                 result: BacktestResult, verbose: bool) -> None:
    grid = sorted({ts for f in frames.values() for ts in f.index})
    if len(grid) < 2:
        return

    positions: Dict[str, Position] = {}
    entry_ctx: Dict[str, dict] = {}      # symbol -> bookkeeping for the open trade
    cooldown_until: Dict[str, pd.Timestamp] = {}
    symbol_trades: Dict[str, int] = {}
    trades_today = 0
    deployed = 0.0
    last_entry_ts: Optional[pd.Timestamp] = None

    # Materialize each symbol's session as {timestamp: {column: value}} once.
    # Pandas scalar indexing (f.loc[ts]) dominated the runtime here — this loop
    # touches ~1.5M bar-symbol pairs per full run, and a dict hit is ~50x faster
    # than a .loc. The signal functions accept either form.
    lookups: Dict[str, Dict[pd.Timestamp, dict]] = {
        s: f.to_dict("index") for s, f in frames.items()
    }

    def row_at(sym: str, ts: pd.Timestamp) -> Optional[dict]:
        f = lookups.get(sym)
        return f.get(ts) if f is not None else None

    for i, ts in enumerate(grid[:-1]):
        nxt = grid[i + 1]
        hhmm = ts.strftime("%H:%M")
        rows = {s: r for s in frames if (r := row_at(s, ts)) is not None}
        if not rows:
            continue

        # ── 1. Exits first, so a freed slot can be refilled on this same bar ──
        for sym in list(positions):
            pos = positions[sym]
            row = rows.get(sym)
            if row is None:
                continue
            ltp = float(row["Close"])
            ctx = entry_ctx[sym]
            _track_excursion(pos, ctx, float(row["High"]), float(row["Low"]))

            reason = exit_reason(pos, row, cfg, hhmm, ltp=ltp)
            if not reason:
                continue

            nxt_row = row_at(sym, nxt)
            nxt_open = float(nxt_row["Open"]) if nxt_row is not None else ltp

            if reason == "STOP":
                fill = _level_fill(pos.stop, nxt_open, pos.side, cfg, is_stop=True)
            elif reason == "TARGET":
                fill = _level_fill(pos.target, nxt_open, pos.side, cfg, is_stop=False)
            else:
                fill = _slip(nxt_open, pos.side, is_entry=False, cfg=cfg)

            _close(pos, ctx, fill, nxt, reason, cfg, result)
            deployed -= pos.notional()
            del positions[sym]
            del entry_ctx[sym]
            cooldown_until[sym] = ts + pd.Timedelta(seconds=cfg.symbol_cooldown_s)

        # ── 2. Trail surviving positions ──────────────────────────────────
        for sym, pos in positions.items():
            row = rows.get(sym)
            if row is not None:
                pos.stop = trail_stop(pos, row, cfg, ltp=float(row["Close"]))

        # ── 3. Entries ────────────────────────────────────────────────────
        if not (cfg.entry_start <= hhmm < cfg.entry_cutoff):
            continue
        if len(positions) >= cfg.max_positions:
            continue
        if trades_today >= cfg.max_trades_per_day:
            continue
        if last_entry_ts is not None and (ts - last_entry_ts).total_seconds() < cfg.entry_spacing_s:
            continue

        excluded = set(positions) | {s for s, until in cooldown_until.items() if ts < until}
        excluded |= {s for s, n in symbol_trades.items() if n >= cfg.max_symbol_trades}

        ranked = rank_candidates({s: r for s, r in rows.items() if s not in excluded},
                                 cfg, exclude=excluded, ts=ts)
        if not ranked:
            continue

        chosen = select_new_entries(ranked, cfg, list(positions.values()))
        if not chosen and ranked:
            result.blocked_by_caps += 1

        for cand in chosen:
            nxt_row = row_at(cand.symbol, nxt)
            if nxt_row is None:
                continue
            entry = _slip(float(nxt_row["Open"]), cand.side, is_entry=True, cfg=cfg)
            atr_v = cand.atr
            if not np.isfinite(atr_v) or atr_v <= 0:
                continue

            stop = initial_stop(entry, atr_v, cand.side, cfg)
            qty = position_size(entry, stop, cfg, deployed=deployed)
            if qty <= 0:
                # Never fall back to 1 share — an unsizable setup is a skipped one.
                result.skipped_unsizable += 1
                continue

            pos = Position(symbol=cand.symbol, side=cand.side, qty=qty, entry_price=entry,
                           stop=stop, target=target_price(entry, stop, cand.side, cfg),
                           entry_ts=nxt, entry_score=cand.score)
            positions[cand.symbol] = pos
            entry_ctx[cand.symbol] = {"conditions": cand.conditions.as_dict(),
                                      "mae": 0.0, "mfe": 0.0, "bars": 0, "entry_i": i}
            deployed += pos.notional()
            symbol_trades[cand.symbol] = symbol_trades.get(cand.symbol, 0) + 1
            trades_today += 1
            last_entry_ts = ts
            if len(positions) >= cfg.max_positions or trades_today >= cfg.max_trades_per_day:
                break

    # ── Force-flatten anything still open at the last bar of the session ──
    final_ts = grid[-1]
    for sym, pos in list(positions.items()):
        row = row_at(sym, final_ts)
        px = float(row["Close"]) if row is not None else pos.entry_price
        _close(pos, entry_ctx[sym], _slip(px, pos.side, is_entry=False, cfg=cfg),
               final_ts, "SQUARE_OFF", cfg, result)


def _track_excursion(pos: Position, ctx: dict, high: float, low: float) -> None:
    ctx["bars"] += 1
    if pos.risk_per_share <= 0:
        return
    if pos.side == "LONG":
        ctx["mfe"] = max(ctx["mfe"], (high - pos.entry_price) / pos.risk_per_share)
        ctx["mae"] = min(ctx["mae"], (low - pos.entry_price) / pos.risk_per_share)
    else:
        ctx["mfe"] = max(ctx["mfe"], (pos.entry_price - low) / pos.risk_per_share)
        ctx["mae"] = min(ctx["mae"], (pos.entry_price - high) / pos.risk_per_share)


def _close(pos: Position, ctx: dict, fill: float, ts: pd.Timestamp, reason: str,
           cfg: IntradayConfig, result: BacktestResult) -> None:
    gross = (fill - pos.entry_price) * pos.sign * pos.qty
    costs = 2.0 * cfg.cost_per_order          # one entry + one exit
    net = gross - costs
    r = ((fill - pos.entry_price) * pos.sign / pos.risk_per_share
         if pos.risk_per_share > 0 else 0.0)

    result.trades.append(Trade(
        symbol=pos.symbol, side=pos.side, qty=pos.qty,
        entry_ts=pos.entry_ts, entry_price=round(pos.entry_price, 2),
        exit_ts=ts, exit_price=round(fill, 2), exit_reason=reason,
        entry_score=round(pos.entry_score, 1), conditions=ctx["conditions"],
        gross_pnl=round(gross, 2), costs=round(costs, 2), net_pnl=round(net, 2),
        r_multiple=round(r, 3), mae=round(ctx["mae"], 2), mfe=round(ctx["mfe"], 2),
        bars_held=ctx["bars"], sector=sector_of(pos.symbol),
    ))


# ── Reporting ─────────────────────────────────────────────────────────────────
def print_report(res: BacktestResult, top_n: int = 12) -> None:
    m = res.metrics()
    line = "=" * 74
    print(f"\n{line}\nINTRADAY VWAP + RS BACKTEST\n{line}")
    print(f"  {m['sessions']} sessions ({m.get('first_session')} -> {m.get('last_session')}), "
          f"{m['symbols']} symbols")
    print(f"  NOT AN OPTIMIZER: {m['sessions']} sessions is one market regime. Use this to")
    print(f"  reject a broken rule set, not to select parameters.")
    print(line)

    if m["trades"] == 0:
        print("  NO TRADES. Gates may be too tight, or the store is too short.")
        print(f"  skipped (unsizable): {res.skipped_unsizable}   blocked by caps: {res.blocked_by_caps}")
        print(line)
        return

    print(f"  Trades           {m['trades']}  ({m['trades_per_day']}/day)")
    print(f"  Win rate         {m['win_rate']}%")
    print(f"  Gross / Costs    {m['gross_pnl']:,.0f} / {m['costs']:,.0f}")
    print(f"  NET P&L          {m['net_pnl']:,.0f}")
    print(f"  Expectancy       {m['expectancy_r']} R   ({m['expectancy_inr']:,.0f} per trade)")
    print(f"  Profit factor    {m['profit_factor']}")
    print(f"  Avg win / loss   {m['avg_win']:,.0f} / {m['avg_loss']:,.0f}")
    print(f"  Max drawdown     {m['max_dd']:,.0f}")
    print(f"  Loss streak      {m['longest_loss_streak']}")
    print(f"  Avg bars held    {m['avg_bars_held']}   MAE {m['avg_mae_r']}R / MFE {m['avg_mfe_r']}R")
    print(f"  Skipped unsizable {m['skipped_unsizable']}   Blocked by caps {m['blocked_by_caps']}")

    print(f"\n  Exit reasons:")
    for _, r in res.per_reason().iterrows():
        print(f"    {r['exit_reason']:<12} {int(r['trades']):>4}  net {r['net']:>10,.0f}  avg {r['avg_r']:>6.2f}R")

    print(f"\n  By hour:")
    for _, r in res.per_hour().iterrows():
        print(f"    {r['hour']}:xx        {int(r['trades']):>4}  net {r['net']:>10,.0f}  avg {r['avg_r']:>6.2f}R")

    ps = res.per_symbol()
    print(f"\n  Top / bottom symbols (of {len(ps)} traded):")
    # head+tail would double-print every row when fewer symbols traded than the
    # window, which reads as twice the activity actually happened.
    shown = ps if len(ps) <= top_n else pd.concat([ps.head(top_n // 2), ps.tail(top_n // 2)])
    for _, r in shown.iterrows():
        print(f"    {r['symbol']:<12} {int(r['trades']):>3} trades  net {r['net']:>10,.0f}  "
              f"win {r['win_rate']:>5.1f}%  avg {r['avg_r']:>6.2f}R")

    # Concentration check: an edge carried by a couple of names is noise.
    if len(ps) >= 5 and m["net_pnl"] > 0:
        top5 = float(ps.head(5)["net"].sum())
        share = top5 / m["net_pnl"] * 100
        print(f"\n  Concentration: top 5 symbols = {share:.0f}% of net P&L", end="")
        print("  <-- WARNING: edge is concentrated, likely noise" if share > 80 else "")
    print(line)


def cost_sensitivity(cfg: IntradayConfig, features: Dict[str, pd.DataFrame],
                     symbols: Sequence[str], start=None, end=None,
                     levels=(0.0, 25.0, 50.0)) -> pd.DataFrame:
    """Costs are frequently the entire edge in 1-minute equity intraday. A single
    headline number at one assumed cost says nothing without this table."""
    out = []
    for c in levels:
        v = IntradayConfig(**{**cfg.to_dict(), "cost_per_order": c})
        r = run_backtest(v, symbols=symbols, start=start, end=end,
                         features=features, verbose=False)
        m = r.metrics()
        out.append({"cost_per_order": c, "trades": m["trades"], "net_pnl": m["net_pnl"],
                    "expectancy_r": m["expectancy_r"], "win_rate": m["win_rate"],
                    "profit_factor": m["profit_factor"]})
    return pd.DataFrame(out)


def write_summary_json(res: BacktestResult, path: str = SUMMARY_JSON,
                       sensitivity: Optional[pd.DataFrame] = None) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    daily = res.daily()
    payload = {
        "generated_at": datetime.now().isoformat(),
        "config": res.cfg.to_dict(),
        "metrics": res.metrics(),
        "equity_curve": [{"date": str(r["date"]), "cum": float(r["cum"]), "dd": float(r["dd"])}
                         for _, r in daily.iterrows()],
        "per_reason": res.per_reason().to_dict("records"),
        "per_hour": res.per_hour().to_dict("records"),
        "per_symbol": res.per_symbol().to_dict("records"),
        "cost_sensitivity": sensitivity.to_dict("records") if sensitivity is not None else None,
        "caveat": (f"{res.sessions} sessions of one market regime. Falsification tool, "
                   f"not an optimizer — do not select parameters on this."),
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    os.replace(tmp, path)
    print(f"  summary -> {os.path.relpath(path, ROOT)}")


def write_excel(res: BacktestResult, stamp: str) -> Optional[str]:
    os.makedirs(REPORTS_DIR, exist_ok=True)
    path = os.path.join(REPORTS_DIR, f"intraday_vwap_rs_{stamp}.xlsx")
    try:
        with pd.ExcelWriter(path) as xl:
            res.trades_df().to_excel(xl, sheet_name="Trades", index=False)
            res.daily().to_excel(xl, sheet_name="Daily", index=False)
            res.per_symbol().to_excel(xl, sheet_name="PerSymbol", index=False)
            res.per_hour().to_excel(xl, sheet_name="PerHour", index=False)
            res.per_reason().to_excel(xl, sheet_name="PerReason", index=False)
            pd.DataFrame([res.metrics()]).T.to_excel(xl, sheet_name="Summary")
    except Exception as e:
        print(f"  Excel export skipped: {e}")
        return None
    print(f"  excel   -> {os.path.relpath(path, ROOT)}")
    return path


def write_plot(res: BacktestResult, stamp: str) -> Optional[str]:
    daily = res.daily()
    if len(daily) < 2:
        return None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True,
                                   gridspec_kw={"height_ratios": [3, 1]})
    x = pd.to_datetime(daily["date"])
    ax1.plot(x, daily["cum"], lw=1.6, color="#059669")
    ax1.axhline(0, color="#888", lw=0.8)
    ax1.set_title(f"Intraday VWAP+RS — net P&L ({res.sessions} sessions)")
    ax1.set_ylabel("Cumulative net")
    ax1.grid(alpha=0.25)

    ax2.fill_between(x, daily["dd"], 0, color="#dc2626", alpha=0.5)
    ax2.set_ylabel("Drawdown")
    ax2.grid(alpha=0.25)
    fig.autofmt_xdate()
    fig.tight_layout()

    os.makedirs(REPORTS_DIR, exist_ok=True)
    path = os.path.join(REPORTS_DIR, f"intraday_vwap_rs_{stamp}.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    print(f"  chart   -> {os.path.relpath(path, ROOT)}")
    return path


# ── Sweep (deliberately hard to misuse) ───────────────────────────────────────
def run_sweep(cfg: IntradayConfig, features: Dict[str, pd.DataFrame],
              symbols: Sequence[str], sessions: List[date]) -> pd.DataFrame:
    if len(sessions) < 40:
        raise SystemExit(
            f"--sweep refused: only {len(sessions)} sessions available (need 40+).\n"
            "Selecting parameters on a shorter sample fits noise, and the resulting\n"
            "numbers would describe this sample rather than an edge. Run the backtest\n"
            "at default parameters instead, and keep growing the store."
        )
    split = int(len(sessions) * 0.6)
    in_end, out_start = sessions[split - 1], sessions[split]
    print(f"\nSweep: optimize on {sessions[0]}..{in_end} ({split} sessions), "
          f"report on {out_start}..{sessions[-1]} ({len(sessions)-split} sessions)")

    grid = [(a, s, r) for a in (18.0, 20.0, 25.0)
            for s in (1.2, 1.5, 2.0)
            for r in (1.5, 2.0, 3.0)]
    rows = []
    for adx_min, stop_mult, tgt_r in grid:
        v = IntradayConfig(**{**cfg.to_dict(), "adx_min": adx_min,
                              "atr_stop_mult": stop_mult, "target_r": tgt_r})
        ins = run_backtest(v, symbols=symbols, start=sessions[0], end=in_end,
                           features=features, verbose=False).metrics()
        oos = run_backtest(v, symbols=symbols, start=out_start, end=sessions[-1],
                           features=features, verbose=False).metrics()
        rows.append({"adx_min": adx_min, "atr_stop_mult": stop_mult, "target_r": tgt_r,
                     "in_trades": ins["trades"], "in_exp_r": ins["expectancy_r"],
                     "in_net": ins["net_pnl"], "out_trades": oos["trades"],
                     "out_exp_r": oos["expectancy_r"], "out_net": oos["net_pnl"]})
        print(f"  adx>={adx_min:<5} stop={stop_mult:<4} tgt={tgt_r:<4} "
              f"| IN {ins['expectancy_r']:>6.3f}R ({ins['trades']:>3}) "
              f"| OUT {oos['expectancy_r']:>6.3f}R ({oos['trades']:>3})")

    df = pd.DataFrame(rows).sort_values("in_exp_r", ascending=False)
    best = df.iloc[0]
    print(f"\n  Best in-sample: adx>={best['adx_min']} stop={best['atr_stop_mult']} "
          f"tgt={best['target_r']} -> IN {best['in_exp_r']}R, OUT {best['out_exp_r']}R")
    if best["out_exp_r"] < best["in_exp_r"] * 0.5:
        print("  WARNING: out-of-sample less than half of in-sample — this is overfit.")
    return df


# ── CLI ───────────────────────────────────────────────────────────────────────
def build_config(args) -> IntradayConfig:
    cfg = IntradayConfig()
    for name in ("adx_min", "max_positions", "max_per_sector", "risk_per_trade",
                 "atr_stop_mult", "target_r", "min_score", "cost_per_order",
                 "slippage_bps", "max_order_value", "max_deployed",
                 "entry_start", "entry_cutoff", "square_off", "allow_short",
                 "symbol_cooldown_s", "entry_spacing_s", "max_symbol_trades",
                 "exit_on_vwap_loss", "exit_on_rs_loss", "trail_arm_r",
                 "trail_atr_mult", "max_vwap_stretch_atr", "base_tf_min", "htf_min"):
        v = getattr(args, name, None)
        if v is not None:
            setattr(cfg, name, v)
    cfg.validate()
    return cfg


def main():
    p = argparse.ArgumentParser(
        description="Replay the intraday VWAP+RS rules over the 1-minute store.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  backtest_intraday_vwap_rs.py\n"
            "  backtest_intraday_vwap_rs.py --symbols RELIANCE --verbose\n"
            "  backtest_intraday_vwap_rs.py --cost-sensitivity --excel --plot\n"
            "  backtest_intraday_vwap_rs.py --sweep        # refuses below 40 sessions\n"
        ))
    p.add_argument("--symbols", default="", help="Comma-separated subset (default: all 50)")
    p.add_argument("--start", default=None, help="First session, YYYY-MM-DD")
    p.add_argument("--end", default=None, help="Last session, YYYY-MM-DD")

    p.add_argument("--adx-min", dest="adx_min", type=float)
    p.add_argument("--max-positions", dest="max_positions", type=int)
    p.add_argument("--max-per-sector", dest="max_per_sector", type=int)
    p.add_argument("--risk-per-trade", dest="risk_per_trade", type=float)
    p.add_argument("--atr-stop-mult", dest="atr_stop_mult", type=float)
    p.add_argument("--target-r", dest="target_r", type=float)
    p.add_argument("--min-score", dest="min_score", type=float)
    p.add_argument("--cost-per-order", dest="cost_per_order", type=float)
    p.add_argument("--slippage-bps", dest="slippage_bps", type=float)
    p.add_argument("--max-order-value", dest="max_order_value", type=float)
    p.add_argument("--max-deployed", dest="max_deployed", type=float)
    p.add_argument("--entry-start", dest="entry_start")
    p.add_argument("--entry-cutoff", dest="entry_cutoff")
    p.add_argument("--square-off", dest="square_off")
    p.add_argument("--symbol-cooldown", dest="symbol_cooldown_s", type=int)
    p.add_argument("--entry-spacing", dest="entry_spacing_s", type=int)
    p.add_argument("--max-symbol-trades", dest="max_symbol_trades", type=int)
    p.add_argument("--allow-short", dest="allow_short", action="store_true", default=None)
    # Now OFF by default (it cost -0.75R over 222 trades), so the flag enables it.
    p.add_argument("--vwap-exit", dest="exit_on_vwap_loss", action="store_true", default=None,
                   help="Re-enable the close-through-VWAP exit (off by default)")
    p.add_argument("--rs-exit", dest="exit_on_rs_loss", action="store_true", default=None,
                   help="Exit when intraday RS vs NIFTY flips negative")
    p.add_argument("--trail-arm-r", dest="trail_arm_r", type=float)
    p.add_argument("--trail-atr-mult", dest="trail_atr_mult", type=float)
    p.add_argument("--vwap-stretch", dest="max_vwap_stretch_atr", type=float)
    p.add_argument("--base-tf", dest="base_tf_min", type=int,
                   help="Signal timeframe in minutes (1, 5, 15…)")
    p.add_argument("--htf", dest="htf_min", type=int,
                   help="Confirmation timeframe for Supertrend/ADX in minutes")

    p.add_argument("--cost-sensitivity", action="store_true", help="Report at 0/25/50 per order")
    p.add_argument("--sweep", action="store_true", help="In/out-of-sample parameter sweep")
    p.add_argument("--excel", action="store_true")
    p.add_argument("--plot", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    cfg = build_config(args)
    symbols = ([s.strip().upper() for s in args.symbols.split(",") if s.strip()]
               if args.symbols else list(NIFTY50))
    start = datetime.strptime(args.start, "%Y-%m-%d").date() if args.start else None
    end = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else None

    print(f"Loading store for {len(symbols)} symbols…")
    store = load_store(symbols)
    if not store:
        raise SystemExit("Store empty — run scripts/downloader/refresh_intraday_1min.py first")
    bench = load_benchmark_1m(cfg)
    if bench is None:
        print(f"WARNING: benchmark {cfg.benchmark} missing — the RS gate will pass everything")
    print(f"Building features for {len(store)} symbols…")
    features = {s: build_features(df, bench, cfg) for s, df in store.items()}

    res = run_backtest(cfg, symbols=symbols, start=start, end=end,
                       features=features, verbose=args.verbose)
    print_report(res)

    sens = None
    if args.cost_sensitivity:
        print("\nCost sensitivity (costs are frequently the whole edge):")
        sens = cost_sensitivity(cfg, features, symbols, start, end)
        print(sens.to_string(index=False))

    if args.sweep:
        sessions = sorted({ts.date() for f in features.values()
                           for ts in f.index.normalize().unique()
                           if (not start or ts.date() >= start) and (not end or ts.date() <= end)})
        run_sweep(cfg, features, symbols, sessions)

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    print("\nArtifacts:")
    write_summary_json(res, sensitivity=sens)
    if args.excel:
        write_excel(res, stamp)
    if args.plot:
        write_plot(res, stamp)


if __name__ == "__main__":
    main()
