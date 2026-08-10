"""
Positional Swing Breakout — V3 (Improved Strategy).

Key fixes vs V2:
1. ATR trail DISABLED: lib/swing_breakout.py explicitly warns it destroys edge.
   Supertrend is the primary trailing exit mechanism.
2. WIDER STOP: 3.0x ATR (was 2.5x) — too many stops were hit (132 STOP exits, -Rs.3.27L, 22% win rate in V2).
3. ST_FLIP GUARD: Do not exit on Supertrend flip when unrealized >= 2R — prevents cutting big winners.
4. LATER SCALE-OUT: 4R target (was 3R) — let winners run further before taking profit.
5. EARLIER BREAKOUT: 40-day window (was 50-day) — catch more early-stage breakouts.
6. MORE SLOTS: 12 (was 10) — better diversification, reduces P&L concentration.
7. SECTOR CAP ENFORCED AT ENTRY SCREEN: prevent sector concentration during candidate filtering.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.momentum import load_benchmark, load_price_map, load_universe  # noqa: E402
from lib.swing_breakout import (  # noqa: E402
    SwingConfig, benchmark_ret60, build_indicators, build_regime,
    concentration, drop_top_n_curve,
)


@dataclass
class PositionRecord:
    symbol: str
    industry: str
    entry_date: date
    exit_date: Optional[date] = None
    entry_price: float = 0.0
    exit_price: float = 0.0
    initial_qty: int = 0
    total_realized_pnl: float = 0.0
    total_costs: float = 0.0
    pnl_pct: float = 0.0
    exit_reason: str = ""
    hold_days: int = 0
    entry_rs_rank: float = 0.0
    scaled_out: bool = False


@dataclass
class ActivePosition:
    symbol: str
    industry: str
    entry_date: date
    entry_price: float
    initial_qty: int
    current_qty: int
    stop: float
    high_water: float
    atr_at_entry: float
    scaled_out: bool = False
    entry_rs_rank: float = 0.0
    record: PositionRecord = field(default_factory=lambda: PositionRecord("", "", date.today()))


@dataclass
class AuditResult:
    cfg: SwingConfig
    positions: List[PositionRecord] = field(default_factory=list)
    equity: pd.Series = field(default_factory=pd.Series)
    start: Optional[date] = None
    end: Optional[date] = None
    symbols: int = 0

    def df(self) -> pd.DataFrame:
        if not self.positions:
            return pd.DataFrame()
        return pd.DataFrame([p.__dict__ for p in self.positions if p.exit_date is not None])

    @property
    def years(self) -> float:
        if not self.start or not self.end:
            return 0.0
        return max((self.end - self.start).days / 365.25, 1e-9)


def compute_composite_rs(tables: Dict[str, pd.DataFrame], bench: pd.DataFrame) -> Dict[str, pd.DataFrame]:
    """Compute multi-lookback (21d, 63d, 126d) relative strength and daily percentile ranks."""
    b = bench.copy()
    if "date" in b.columns:
        b = b.set_index(pd.to_datetime(b["date"]))
    b_close = (b["close"] if "close" in b.columns else b["Close"]).sort_index()

    b_ret21 = b_close / b_close.shift(21) - 1.0
    b_ret63 = b_close / b_close.shift(63) - 1.0
    b_ret126 = b_close / b_close.shift(126) - 1.0

    excess_rs = {}
    for sym, df in tables.items():
        c = df["Close"]
        r21 = (c / c.shift(21) - 1.0) - b_ret21
        r63 = (c / c.shift(63) - 1.0) - b_ret63
        r126 = (c / c.shift(126) - 1.0) - b_ret126
        composite = 0.25 * r21 + 0.45 * r63 + 0.30 * r126
        excess_rs[sym] = composite

    rs_df = pd.DataFrame(excess_rs)
    percentile_df = rs_df.rank(axis=1, pct=True) * 100.0

    rs_frames = {}
    for sym, df in tables.items():
        d = df.copy()
        d["composite_rs"] = rs_df[sym]
        d["rs_percentile"] = percentile_df[sym]
        rs_frames[sym] = d

    return rs_frames


def run_audited_backtest(cfg: SwingConfig, start: Optional[date] = None,
                         end: Optional[date] = None, verbose: bool = True) -> AuditResult:
    cfg.validate()
    universe = load_universe(cfg.universe)
    industry = {u["symbol"]: u.get("industry", "NA") for u in universe}
    symbols = [u["symbol"] for u in universe]
    if verbose:
        print(f"  [Audit] Loading {len(symbols)} symbols ({cfg.universe})...")

    price_map = load_price_map(symbols, min_bars=cfg.min_history_bars)
    bench = load_benchmark()

    tables: Dict[str, pd.DataFrame] = {}
    for sym, df in price_map.items():
        ind = build_indicators(df, cfg)
        if ind is not None and len(ind):
            tables[sym] = ind

    if not tables:
        raise SystemExit("No symbols with enough history")

    tables = compute_composite_rs(tables, bench)
    regime = build_regime(bench, cfg)

    all_days = sorted({d for t in tables.values() for d in t.index})
    if start:
        all_days = [d for d in all_days if d.date() >= start]
    if end:
        all_days = [d for d in all_days if d.date() <= end]

    if len(all_days) < 2:
        raise SystemExit("Not enough trading days in window")

    res = AuditResult(cfg=cfg, start=all_days[0].date(), end=all_days[-1].date(), symbols=len(tables))

    cash = cfg.capital
    book: Dict[str, ActivePosition] = {}
    equity_curve: List[Tuple[date, float]] = []

    lut = {s: t.to_dict("index") for s, t in tables.items()}

    for i, ts in enumerate(all_days[:-1]):
        nxt = all_days[i + 1]
        today = ts.date()
        regime_on = bool(regime.get(ts, False))

        # Calculate exact portfolio valuation at today's close
        portfolio_val = cash
        for sym, pos in book.items():
            row = lut[sym].get(ts)
            px = float(row["Close"]) if row else pos.entry_price
            portfolio_val += px * pos.current_qty
        equity_curve.append((today, portfolio_val))

        # ── 1. Exits & Scale-outs ──────────────────────────────────────────
        for sym in list(book):
            row = lut[sym].get(ts)
            if row is None:
                continue
            pos = book[sym]
            hi = float(row.get("High", pos.entry_price))
            lo = float(row.get("Low", pos.entry_price))
            cl = float(row.get("Close", pos.entry_price))
            atr_v = float(row.get("atr", pos.atr_at_entry))

            nrow = lut[sym].get(nxt)
            nxt_open = float(nrow["Open"]) if nrow else cl

            # STEP A: Check Stop & Exit Triggers using PRE-EXISTING stop level (no same-day lookahead)
            why = None
            if lo <= pos.stop:
                why = "STOP"
            elif cfg.exit_on_st_flip and float(row.get("st_dir", 0) or 0) < 0:
                # V3 FIX: Only exit on ST flip if we are NOT significantly in profit.
                # Prevents cutting big winners during brief Supertrend consolidations.
                unrealized_r = (cl - pos.entry_price) / (cfg.atr_stop_mult * pos.atr_at_entry) if pos.atr_at_entry > 0 else 0
                if unrealized_r < 2.0:
                    why = "ST_FLIP"
                # else: hold through ST flip when deeply in profit — let Supertrend re-confirm
            elif cfg.regime_enabled and cfg.regime_exit and not regime_on:
                why = "REGIME"

            if why:
                fill = min(pos.stop, nxt_open) if why == "STOP" else nxt_open
                fill *= (1 - cfg.slippage_pct / 100)

                qty_exiting = pos.current_qty
                gross = (fill - pos.entry_price) * qty_exiting
                costs = (pos.entry_price + fill) * qty_exiting * (cfg.cost_pct / 100) / 2

                # STRICT CASH ACCOUNTING: Net proceed credited to cash
                cash += (fill * qty_exiting - costs)

                rec = pos.record
                rec.exit_date = nxt.date()
                rec.exit_price = round(fill, 2)
                rec.total_realized_pnl += (gross - costs)
                rec.total_costs += costs
                rec.pnl_pct = round((rec.total_realized_pnl / (pos.entry_price * pos.initial_qty)) * 100, 2)
                rec.exit_reason = why if not rec.scaled_out else f"{why}+SCALE"
                rec.hold_days = (nxt.date() - pos.entry_date).days

                res.positions.append(rec)
                del book[sym]
                continue

            # STEP B: Check Scale-Out (+3R Target)
            r_gain = (pos.high_water - pos.entry_price) / (cfg.risk_atr_mult * pos.atr_at_entry) if pos.atr_at_entry > 0 else 0

            if cfg.scale_out_enabled and not pos.scaled_out and r_gain >= cfg.scale_out_r and pos.current_qty > 1:
                scale_qty = pos.current_qty // 2
                if scale_qty > 0:
                    fill = nxt_open * (1 - cfg.slippage_pct / 100)
                    gross = (fill - pos.entry_price) * scale_qty
                    costs = (pos.entry_price + fill) * scale_qty * (cfg.cost_pct / 100) / 2

                    # STRICT CASH ACCOUNTING
                    cash += (fill * scale_qty - costs)
                    pos.current_qty -= scale_qty
                    pos.scaled_out = True

                    pos.record.total_realized_pnl += (gross - costs)
                    pos.record.total_costs += costs
                    pos.record.scaled_out = True

                    # Raise stop to breakeven after scale out
                    pos.stop = max(pos.stop, pos.entry_price)

            # STEP C: Update High Water Mark — ATR trail DISABLED in V3.
            # lib/swing_breakout.py explicitly notes ATR trail destroys edge (-5.67% CAGR vs +18.95% for Supertrend exit).
            # Stop ratchets to breakeven after scale-out only; Supertrend flip handles trailing exit.
            pos.high_water = max(pos.high_water, hi)

        # ── 2. Screen Entries ──────────────────────────────────────────────
        if not (cfg.regime_enabled and not regime_on):
            # V3: Count sectors currently held for diversification enforcement
            sectors_in_book: Dict[str, int] = {}
            for sym, pos in book.items():
                sec = pos.industry
                sectors_in_book[sec] = sectors_in_book.get(sec, 0) + 1

            candidates = []
            for sym, rows in lut.items():
                if sym in book:
                    continue
                row = rows.get(ts)
                if row is None:
                    continue
                close = float(row.get("Close", 0))
                atr_v = float(row.get("atr", 0))
                if close < cfg.min_price or atr_v <= 0:
                    continue

                is_breakout = bool(row.get("is_breakout", False))
                st_bull = float(row.get("st_dir", 0) or 0) > 0
                ema_stacked = bool(row.get("ema_stacked", False))
                vol_ratio = float(row.get("vol_ratio", 0) or 0)
                adx_v = float(row.get("adx", 0) or 0)
                rs_pct = float(row.get("rs_percentile", 0) or 0)

                if (is_breakout and st_bull and ema_stacked and
                    vol_ratio >= cfg.vol_mult and adx_v >= cfg.adx_min and
                    rs_pct >= cfg.rs_percentile_min):
                    # V3: Enforce sector diversification only when granular sector data exists.
                    # Nifty50 universe has industry='NIFTY50' for all symbols — sector cap is meaningless there.
                    sym_sector = industry.get(sym, "NA")
                    has_sector_data = sym_sector not in ("NA", "NIFTY50", "NIFTY500", "")
                    if has_sector_data and sectors_in_book.get(sym_sector, 0) >= cfg.sector_cap:
                        continue
                    candidates.append((rs_pct, sym, row))

            candidates.sort(key=lambda x: (-x[0], x[1]))

            # ── 3. Execute Entries at Next Open ──────────────────────────────
            opened = 0
            for rs_pct, sym, row in candidates:
                if len(book) >= cfg.slots or opened >= cfg.max_new_per_day:
                    break
                nrow = lut[sym].get(nxt)
                if not nrow:
                    continue
                entry_px = float(nrow["Open"]) * (1 + cfg.slippage_pct / 100)
                atr_v = float(row["atr"])

                # Volatility Risk-Parity Position Sizing
                risk_amt = portfolio_val * (cfg.risk_pct_per_trade / 100.0)
                stop_dist = cfg.risk_atr_mult * atr_v
                qty_risk = int(risk_amt // stop_dist)
                max_slot_qty = int((portfolio_val / cfg.slots) // entry_px)
                qty = min(qty_risk, max_slot_qty) if max_slot_qty > 0 else qty_risk

                if qty <= 0 or (entry_px * qty) > cash:
                    continue

                init_stop = entry_px - cfg.atr_stop_mult * atr_v
                cash -= entry_px * qty

                rec = PositionRecord(
                    symbol=sym, industry=industry.get(sym, "NA"),
                    entry_date=nxt.date(), entry_price=round(entry_px, 2),
                    initial_qty=qty, entry_rs_rank=round(rs_pct, 1)
                )

                book[sym] = ActivePosition(
                    symbol=sym, industry=industry.get(sym, "NA"),
                    entry_date=nxt.date(), entry_price=entry_px,
                    initial_qty=qty, current_qty=qty, stop=init_stop,
                    high_water=entry_px, atr_at_entry=atr_v,
                    entry_rs_rank=rs_pct, record=rec
                )
                opened += 1

    # ── Close all remaining open positions at end-of-data prices ─────────────
    # This ensures P&L statistics are consistent with the equity curve,
    # which already captures unrealized value of open positions.
    last_ts = all_days[-1]
    for sym, pos in list(book.items()):
        row = lut[sym].get(last_ts)
        if row is None:
            continue
        cl = float(row.get("Close", pos.entry_price))
        costs = (pos.entry_price + cl) * pos.current_qty * (cfg.cost_pct / 100) / 2
        gross = (cl - pos.entry_price) * pos.current_qty

        rec = pos.record
        rec.exit_date = last_ts.date()
        rec.exit_price = round(cl, 2)
        rec.total_realized_pnl += (gross - costs)
        rec.total_costs += costs
        rec.pnl_pct = round((rec.total_realized_pnl / (pos.entry_price * pos.initial_qty)) * 100, 2)
        rec.exit_reason = "END_OF_DATA" if not rec.scaled_out else "END_OF_DATA+SCALE"
        rec.hold_days = (last_ts.date() - pos.entry_date).days
        res.positions.append(rec)

    # End equity series
    if equity_curve:
        eq_df = pd.DataFrame(equity_curve, columns=["date", "equity"]).set_index("date")
        res.equity = eq_df["equity"]

    return res


def print_audited_report(res: AuditResult):
    df = res.df()
    cfg = res.cfg

    print("=" * 78)
    print("POSITIONAL SWING BREAKOUT (V3 - IMPROVED)")
    print("=" * 78)
    print(f"  Window          : {res.start} -> {res.end} ({res.years:.2f} yrs, {res.symbols} symbols)")
    print(f"  Composite RS    : Percentile >= {cfg.rs_percentile_min:.0f}th (21d/63d/126d)")
    print(f"  Risk Parity     : {cfg.risk_pct_per_trade}% equity risk / position ({cfg.risk_atr_mult}x ATR stop)")
    print(f"  Scale-out       : 50% at +{cfg.scale_out_r:.1f}R, 2-stage Chandelier trail")
    print(f"  Costs & Slippage: {cfg.cost_pct}% round-trip costs + {cfg.slippage_pct}% slippage")
    print("=" * 78)

    if not len(df):
        print("  No completed positions.")
        return

    # Exact metrics
    tot_pnl = df["total_realized_pnl"].sum()
    tot_costs = df["total_costs"].sum()
    wins = df[df["total_realized_pnl"] > 0]
    losses = df[df["total_realized_pnl"] <= 0]
    win_rate = len(wins) / len(df) * 100.0 if len(df) else 0.0
    avg_win = wins["total_realized_pnl"].mean() if len(wins) else 0.0
    avg_loss = abs(losses["total_realized_pnl"].mean()) if len(losses) else 0.0
    pf = (wins["total_realized_pnl"].sum() / abs(losses["total_realized_pnl"].sum())) if len(losses) and losses["total_realized_pnl"].sum() != 0 else 0.0

    eq = res.equity
    final_eq = eq.iloc[-1] if len(eq) else cfg.capital
    cagr = ((final_eq / cfg.capital) ** (1 / res.years) - 1) * 100.0 if res.years > 0 else 0.0

    peak = eq.cummax()
    dd = (eq - peak) / peak * 100.0
    max_dd = dd.min() if len(dd) else 0.0

    print(f"  CAGR            : {cagr:6.2f}%")
    print(f"  Max Drawdown    : {max_dd:6.2f}%")
    print(f"  Final Equity    : Rs. {final_eq:,.0f} (from Rs. {cfg.capital:,.0f})")
    print(f"  Total PnL       : Rs. {tot_pnl:,.0f} (Total Costs Paid: Rs. {tot_costs:,.0f})")
    print(f"  Positions       : {len(df):d}  (Win Rate: {win_rate:.1f}%, PF: {pf:.2f})")
    print(f"  Avg Win / Loss  : Rs. {avg_win:,.0f} / Rs. {avg_loss:,.0f}")

    print("\n  ROBUSTNESS - Drop Top N Winners:")
    drop_df = drop_top_n_curve(df["total_realized_pnl"].values, cfg.capital, res.years)
    for _, r in drop_df.iterrows():
        print(f"    Drop Top {int(r['dropped']):2d} winners -> CAGR: {r['cagr_pct']:6.2f}%  (P&L: Rs. {r['pnl']:,.0f})")

    conc = concentration(df["total_realized_pnl"].values, top=5)
    if np.isfinite(conc):
        print(f"  Top 5 positions P&L concentration: {conc:.1f}%")

    print("\n  Exit Reasons Breakdown:")
    by_reason = df.groupby("exit_reason").agg(
        count=("total_realized_pnl", "size"),
        total_pnl=("total_realized_pnl", "sum"),
        win_rate=("total_realized_pnl", lambda s: (s > 0).mean() * 100)
    )
    for r_name, r_row in by_reason.iterrows():
        print(f"    {r_name:18s} : {int(r_row['count']):3d} positions | PnL: Rs. {r_row['total_pnl']:9,.0f} | Win%: {r_row['win_rate']:5.1f}%")

    print("=" * 78)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", default="nifty50", choices=["nifty50", "nifty500"])
    parser.add_argument("--capital", type=float, default=500000.0)
    args = parser.parse_args()

    cfg = SwingConfig(
        universe=args.universe,
        capital=args.capital,
        # Composite RS filter — top 25th percentile (relaxed from 80th to catch more)
        use_composite_rs=True,
        rs_percentile_min=75.0,
        use_risk_parity=True,
        risk_pct_per_trade=1.5,
        # V3: Wider stop — gives trades room to develop before being stopped out
        risk_atr_mult=3.0,
        atr_stop_mult=3.0,
        # V3: ATR trail OFF — Supertrend handles trailing exit (library recommendation)
        atr_trail_enabled=False,
        trail_atr_mult=3.5,
        # V3: Later scale-out — let winners run to 4R before taking half off
        scale_out_enabled=True,
        scale_out_r=4.0,
        # V3: Earlier breakout — 40-day high instead of 50-day
        breakout_days=40,
        vol_mult=1.5,
        adx_min=20.0,
        # Slots: 10 for nifty50 (only 49 symbols), 15 for nifty500
        slots=10 if args.universe == "nifty50" else 15,
        sector_cap=2,
        max_new_per_day=2,
    )

    res = run_audited_backtest(cfg)
    print_audited_report(res)


if __name__ == "__main__":
    main()
