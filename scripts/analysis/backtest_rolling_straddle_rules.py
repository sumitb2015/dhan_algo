"""
Backtest of nifty_rolling_straddle.py --roll-type rules on 1-min data from
`Options Data/nifty_options.db`.

Mirrors the live rules: entry 09:20 (09:30 on expiry day) gated on CE/PE ratio < 2x until 14:30;
rolls on imbalance (always) + spot% or delta; per-straddle SL 1.25x P0 (roll, else flat); per-leg SL
once no roll is possible; daily stop % of capital; profit-lock trail on % of the first premium;
time exit 15:15. Fills at the 1-min close +/- slippage; the live loop checks every second, so
intraminute spikes are not modelled. Delta is Black-Scholes from the stored IV (not Dhan's Greeks).
"""
import argparse, math, os, sqlite3, sys
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from lib.nse_holidays import is_regular_session, effective_expiry_date  # NSE holidays + Muhurat: one shared calendar
from lib.rolling_straddle_rules import trail_lock_pct, is_balanced, straddle_sl_hit, leg_sl_hit, roll_reason

DB = os.path.join(ROOT, "Options Data", "nifty_options.db")


def bs_delta(kind, spot, k, iv_pct, t_years):
    if iv_pct is None or iv_pct <= 0 or t_years <= 0:
        return None
    s = iv_pct / 100.0 * math.sqrt(t_years)
    d1 = (math.log(spot / k) + 0.5 * s * s) / s
    cdf = 0.5 * (1 + math.erf(d1 / math.sqrt(2)))
    return cdf if kind == "CE" else cdf - 1.0


def order_cost(price, qty, side):
    """Dhan F&O option order friction (see dhan-backtest-data): brokerage 20 + GST, exchange fee
    ~0.05% of turnover + GST, SEBI/stamp ~3/cr, STT 0.1% on SELL premium only."""
    turnover = price * qty
    c = 20.0 * 1.18 + 0.0005 * turnover * 1.18 + 3e-7 * turnover
    if side == "SELL":
        c += 0.001 * turnover
    return c


def run_day(conn, day, a):
    d0, d1 = f"{day} 09:15:00", f"{day} 15:30:00"
    exp = conn.execute("SELECT MIN(expiry) FROM option_prices WHERE datetime >= ? AND datetime < ? AND expiry >= ?",
                       (d0, f"{day} 09:16:00", day)).fetchone()[0]
    if not exp:
        return None
    df = pd.read_sql_query("SELECT datetime, strike, option_type, close, spot, iv FROM option_prices "
                           "WHERE datetime >= ? AND datetime <= ? AND expiry = ?", conn, params=(d0, d1, exp))
    if df.empty:
        return None
    # A holiday-labelled expiry (2023-06-29, 2024-04-11) really expires the session before.
    exp_eff = effective_expiry_date(exp).isoformat()
    is_expiry = exp_eff == day
    start = a.expiry_start if is_expiry else a.start
    px = {(r.datetime[11:16], r.strike, r.option_type): (r.close, r.iv) for r in df.itertuples()}
    spot = {t[11:16]: s for t, s in df.groupby("datetime")["spot"].first().items()}
    exp_end = pd.Timestamp(f"{exp_eff} 15:30:00")
    qty = a.lots * a.lot_size
    slip = a.slippage
    day_stop = a.capital * a.day_stop_pct / 100.0

    st = dict(realized=0.0, costs=0.0, orders=0)
    rolls = 0
    pos = None
    p0_first, best, lock = None, 0.0, None
    log, reason = [], "EOD"

    def sell(price):
        st["costs"] += order_cost(price, qty, "SELL"); st["orders"] += 1
        return price - slip

    def buy(price):
        st["costs"] += order_cost(price, qty, "BUY"); st["orders"] += 1
        return price + slip

    def close_leg(p, leg, ltp):
        fill = buy(ltp)
        st["realized"] += (p[leg] - fill) * qty
        p[leg + "_open"] = False

    def try_enter(t):
        nonlocal pos, p0_first
        s = spot.get(t)
        if s is None:
            return False
        atm = round(s / 50.0) * 50.0
        ce, pe = px.get((t, atm, "CE")), px.get((t, atm, "PE"))
        if not ce or not pe or ce[0] <= 0 or pe[0] <= 0:
            return False
        if not is_balanced(ce[0], pe[0], a.imb_ratio):
            return False  # wait until balanced
        c_fill, p_fill = sell(ce[0]), sell(pe[0])
        pos = dict(strike=atm, ce=c_fill, pe=p_fill, ce_open=True, pe_open=True,
                   p0=c_fill + p_fill, ref=s, armed=False)
        if p0_first is None:
            p0_first = pos["p0"] * qty
        log.append(f"{t} SELL {atm} CE {c_fill:.1f} PE {p_fill:.1f} (spot {s:.0f})")
        return True

    times = sorted({k[0] for k in px if "09:15" <= k[0] <= "15:30"})
    for t in times:
        if t < start:
            continue
        s = spot.get(t)
        if s is None:
            continue
        if pos is None:
            if t >= a.eod:
                reason = "flat at EOD"; break
            if t >= a.no_roll_after:
                reason = "never balanced/entered" if p0_first is None else "no re-entry after cutoff"
                break
            if p0_first is not None and st["realized"] <= -day_stop:
                reason = "day stop (flat)"; break
            if p0_first is not None and lock is not None and st["realized"] <= lock:
                reason = "profit lock (flat)"; break
            try_enter(t)
            continue

        k = pos["strike"]
        ce, pe = px.get((t, k, "CE")), px.get((t, k, "PE"))
        if not ce or not pe:
            continue
        cl, pl = ce[0], pe[0]
        unreal = ((pos["ce"] - cl) * pos["ce_open"] + (pos["pe"] - pl) * pos["pe_open"]) * qty
        total = st["realized"] + unreal

        def exit_all(why):
            nonlocal reason
            if pos["ce_open"]: close_leg(pos, "ce", cl)
            if pos["pe_open"]: close_leg(pos, "pe", pl)
            log.append(f"{t} EXIT ALL ({why}) spot {s:.0f}")
            reason = why

        if t >= a.eod:
            exit_all("EOD 15:15"); break
        if total <= -day_stop:
            exit_all("day stop"); break
        best = max(best, total)
        lp = trail_lock_pct(best / p0_first, a.trail_start) if p0_first else None
        if lp is not None:
            lock = lp * p0_first
            if total <= lock:
                exit_all("profit lock"); break

        can_roll = rolls < a.max_rolls and t < a.no_roll_after
        if not can_roll:
            for leg, ltp in (("ce", cl), ("pe", pl)):
                if pos[leg + "_open"] and leg_sl_hit(ltp, pos[leg], a.leg_sl_mult):
                    close_leg(pos, leg, ltp)
                    log.append(f"{t} LEG SL {leg.upper()} @ {ltp:.1f}")
            if not pos["ce_open"] and not pos["pe_open"]:
                reason = "both legs SL"; break

        both = pos["ce_open"] and pos["pe_open"]
        why = None
        if both and straddle_sl_hit(cl, pl, pos["p0"], a.sl_mult):
            if not can_roll:
                exit_all("straddle SL, no rolls"); break
            why = f"straddle SL {cl + pl:.1f}>={a.sl_mult}x{pos['p0']:.1f}"
        elif can_roll:
            md = None
            if a.trigger == "delta":
                ty = max((exp_end - pd.Timestamp(f"{day} {t}:00")).total_seconds(), 60) / (365 * 86400)
                ds = [abs(x) for x in (bs_delta("CE", s, k, ce[1], ty), bs_delta("PE", s, k, pe[1], ty)) if x is not None]
                md = max(ds) if ds else None
            why, pos["armed"] = roll_reason(ce=cl, pe=pl, spot=s, ref_spot=pos["ref"], armed=pos["armed"],
                                            trigger=a.trigger, spot_pct=a.spot_pct, max_delta=md,
                                            delta_limit=a.roll_delta, imbalance_ratio=a.imb_ratio)
        if why:
            if pos["ce_open"]: close_leg(pos, "ce", cl)
            if pos["pe_open"]: close_leg(pos, "pe", pl)
            rolls += 1
            log.append(f"{t} ROLL #{rolls} ({why}) spot {s:.0f}")
            pos = None
            try_enter(t)

    if pos is not None and (pos["ce_open"] or pos["pe_open"]):
        t = times[-1]
        ce, pe = px.get((t, pos["strike"], "CE")), px.get((t, pos["strike"], "PE"))
        if pos["ce_open"] and ce: close_leg(pos, "ce", ce[0])
        if pos["pe_open"] and pe: close_leg(pos, "pe", pe[0])
        log.append(f"{t} FORCED CLOSE at data end")
    gross = st["realized"]
    return dict(date=day, expiry_day=is_expiry, rolls=rolls, orders=st["orders"], gross=round(gross),
                costs=round(st["costs"]), net=round(gross - st["costs"]), exit=reason,
                p0_pts=round(p0_first / qty, 1) if p0_first else None), log


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--start-date", required=True)
    p.add_argument("--end-date", required=True)
    p.add_argument("--trigger", choices=["spot_pct", "delta"], default="spot_pct")
    p.add_argument("--spot-pct", type=float, default=0.4)
    p.add_argument("--roll-delta", type=float, default=0.60)
    p.add_argument("--imb-ratio", type=float, default=2.0)
    p.add_argument("--sl-mult", type=float, default=1.25)
    p.add_argument("--leg-sl-mult", type=float, default=1.5)
    p.add_argument("--max-rolls", type=int, default=3)
    p.add_argument("--start", default="09:20")
    p.add_argument("--expiry-start", default="09:30")
    p.add_argument("--no-roll-after", default="14:30")
    p.add_argument("--eod", default="15:15")
    p.add_argument("--capital", type=float, default=200000.0)
    p.add_argument("--day-stop-pct", type=float, default=1.5)
    p.add_argument("--trail-start", type=float, default=0.20)
    p.add_argument("--lots", type=int, default=1)
    p.add_argument("--lot-size", type=int, default=65)
    p.add_argument("--slippage", type=float, default=0.5, help="points per fill")
    p.add_argument("--verbose", action="store_true")
    a = p.parse_args()

    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = []
    for d in pd.date_range(a.start_date, a.end_date, freq="B"):
        if not is_regular_session(d):
            continue
        day = d.strftime("%Y-%m-%d")
        out = run_day(conn, day, a)
        if not out:
            continue
        res, log = out
        rows.append(res)
        if a.verbose:
            print(f"\n== {day} ==\n  " + "\n  ".join(log))
    df = pd.DataFrame(rows)
    if df.empty:
        print("no sessions with data"); return
    print(df.to_string(index=False))
    print(f"\nsessions={len(df)} gross={df.gross.sum():,.0f} costs={df.costs.sum():,.0f} net={df.net.sum():,.0f} "
          f"win={int((df.net > 0).sum())}/{len(df)} rolls={df.rolls.sum()} orders={df.orders.sum()}")


if __name__ == "__main__":
    main()
