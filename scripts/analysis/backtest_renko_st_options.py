"""
Renko + Supertrend option-selling backtest on NIFTY, modelled on the /renko page's Supertrend AUTO.

Signals (rs_dashboard/scripts/renko-st-signals.ts -> the page's own lib/renko.ts buildRenko + renkoSupertrend):
  * Bricks on NIFTY 1-minute closes. `--source dhan` (default) = Dhan's NIFTY index candles, the series the page draws
    (fetched with scripts/tools/price_pnf_candles.py, market data only); `--source db` = the `spot` stored with the
    expired options, which is NOT the index close (mean gap ~1 pt, ~10 % of minutes outside the index bar's range):
    use it only for windows Dhan's candle history no longer covers.
  * Brick size: 'auto' (the page's auto brick, lib/renkoAutoBrick.ts, recomputed each morning from earlier bars only; the
    chart is redrawn on it as the page does) plus fixed bricks (`--bricks`).
Rules (lib/pnfAuto.ts + supertrendSignals):
  * Enter only on a brick whose colour agrees with the Supertrend line: line up + green brick -> SELL 1 lot of the
    current-week ATM PE; line down + red brick -> SELL the ATM CE.
  * Line flips against the position -> buy it back; the flip brick agrees with the new line, so the other side is sold
    on the same minute.
  * `--hold mis` (default): no entries from 15:15, square-off at 15:15, flat every evening (the page's MIS window).
    `--hold nrml`: the same at 15:35 (the page's NRML window). `--hold carry`: held overnight (not what the page does;
    kept for comparison); on expiry day the short is closed at 15:15 and re-entered next session on an agreeing brick.
  * Fill: the option's close on the minute the brick printed (`stats`); `stats_next_minute` fills a minute later.
  * The strike is fixed at entry and priced at that strike until exit, from Options Data/nifty_options.db (each week's
    contract, ATM +-10 strikes). An exit whose strike left that window is priced from its last stored minute and listed
    under `stale_exits`.
Costs: Rs 50 per order (the repo's measured Dhan F&O average, dhan-backtest-data skill), plus a stress case of `--slip`
points per order (`net_slip`).

Writes debug/backtests/renko_st_options/<run id>/result.json and debug/backtests/renko_st_options/latest.json
(read by the /renko page's Backtest panel through /api/renko-backtest).

Usage:
  venv/bin/python scripts/analysis/backtest_renko_st_options.py                       # month to the DB's last expiry, MIS
  venv/bin/python scripts/analysis/backtest_renko_st_options.py --hold carry --source db --start 2026-09-21 --end 2026-10-19
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)
from lib.nse_holidays import is_nse_trading_day  # noqa: E402

DB = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")
DASHBOARD = os.path.join(PROJECT_ROOT, "rs_dashboard")
SIGNALS_TS = os.path.join(DASHBOARD, "scripts", "renko-st-signals.ts")
PRICE_SCRIPT = os.path.join(PROJECT_ROOT, "scripts", "tools", "price_pnf_candles.py")
PYTHON = sys.executable
OUT_DIR = os.path.join(PROJECT_ROOT, "debug", "backtests", "renko_st_options")
IST = timezone(timedelta(hours=5, minutes=30))
INDEX_SESSION = ("09:15", "15:29")
OPTION_SESSION = ("09:15", "15:39")       # F&O trades to 15:40 (SEBI CAS); the NRML exit at 15:35 needs these minutes
EXPIRY_SQUARE_OFF = "15:15"
HOLD_CUTOFF = {"mis": "15:15", "nrml": "15:35", "carry": None}


def day_of(t: int) -> str:
    return datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")


def hm_of(t: int) -> str:
    return datetime.fromtimestamp(t, IST).strftime("%H:%M")


def to_t(dt: str) -> int:
    return int(datetime.strptime(dt, "%Y-%m-%d %H:%M:%S").replace(tzinfo=IST).timestamp())


def in_window(t: int, d0: str, d1: str, session) -> bool:
    return d0 <= day_of(t) <= d1 and session[0] <= hm_of(t) <= session[1]


def last_expiry(c) -> str:
    return c.execute("select max(expiry) from option_prices").fetchone()[0]


def db_spot_bars(c, d0: str, d1: str) -> list:
    """The `spot` on the ATM CE row of the week's contract (one contract per date in the DB). Close only, no high/low."""
    rows = c.execute("select datetime, spot from option_prices where strike_relative='ATM' and option_type='CE' "
                     "and datetime >= ? and datetime <= ? order by datetime", (f"{d0} 09:15:00", f"{d1} 15:29:00")).fetchall()
    seen, bars = set(), []
    for dt, spot in rows:
        if not (INDEX_SESSION[0] <= dt[11:16] <= INDEX_SESSION[1]) or dt in seen or not spot or spot <= 0:
            continue
        seen.add(dt)
        bars.append({"t": to_t(dt), "ce": spot, "pe": 0, "straddle": spot, "vol": 0})
    return bars


def dhan_index_bars(d0: str, d1: str) -> list:
    """NIFTY index 1-minute candles from Dhan (with high / low), as the /renko page loads them."""
    first = datetime.strptime(d0, "%Y-%m-%d").date()
    sessions = sum(1 for k in range((date.today() - first).days + 1) if is_nse_trading_day(first + timedelta(days=k))) + 5
    r = subprocess.run([PYTHON, PRICE_SCRIPT, "--kind", "index", "--symbol", "NIFTY", "--sessions", str(sessions)],
                       cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=600)
    lines = [ln for ln in r.stdout.strip().splitlines() if ln.startswith("{")]
    if r.returncode != 0 or not lines:
        sys.exit(f"Dhan index fetch failed (exit {r.returncode}): {r.stderr[-500:]}")
    payload = json.loads(lines[-1])
    if payload.get("error"):
        sys.exit(f"Dhan index fetch failed: {payload['error']}")
    raw = next(iter(payload["bars"].values()), [])
    bars = [{"t": b["t"], "ce": b["straddle"], "pe": 0, "straddle": b["straddle"], "vol": 0,
             **({"h": b["h"], "l": b["l"]} if b.get("h") is not None else {})}
            for b in raw if in_window(b["t"], d0, d1, INDEX_SESSION) and b.get("straddle", 0) > 0]
    if not bars or day_of(bars[0]["t"]) > (first + timedelta(days=4)).isoformat():
        sys.exit(f"Dhan index history does not reach back to {d0} (first bar {day_of(bars[0]['t']) if bars else 'none'}): "
                 "use --source db for this window")
    return bars


def load_options(c, d0: str, d1: str):
    rows = c.execute("select expiry, datetime, option_type, strike, strike_relative, close from option_prices "
                     "where datetime >= ? and datetime <= ?", (f"{d0} 09:15:00", f"{d1} 15:39:00")).fetchall()
    px = defaultdict(dict)   # (expiry, type, strike) -> {t: close}
    atm = {}                 # t -> (expiry, strike)
    for exp, dt, ot, k, rel, close in rows:
        if not (OPTION_SESSION[0] <= dt[11:16] <= OPTION_SESSION[1]) or not close or close <= 0:
            continue
        t = to_t(dt)
        px[(exp, ot, k)][t] = close
        if rel == "ATM" and ot == "CE":
            atm[t] = (exp, k)
    return px, atm


def run_signals(bars: list, start: str, st_period: int, st_mult: float, bricks: str) -> dict:
    node = shutil.which("node")
    if not node:
        sys.exit("node is not on PATH (needed for the page's Renko / Supertrend code)")
    with tempfile.TemporaryDirectory() as tmp:
        bp, out = os.path.join(tmp, "bars.json"), os.path.join(tmp, "signals.json")
        with open(bp, "w") as f:
            json.dump(bars, f)
        r = subprocess.run([node, "--no-warnings", SIGNALS_TS, bp, start, out, str(st_period), str(st_mult), bricks],
                           cwd=DASHBOARD, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"renko-st-signals.ts failed:\n{r.stderr}")
        with open(out) as f:
            return json.load(f)


class Pricer:
    def __init__(self, px, atm):
        self.px, self.atm, self.minutes = px, atm, sorted(atm)

    def price(self, key, t):
        """close at t, else the nearest earlier minute within 5, else the nearest later within 5."""
        s = self.px.get(key, {})
        for dt in (0, -60, -120, -180, -240, -300, 60, 120, 180, 240, 300):
            if t + dt in s:
                return s[t + dt]
        return None

    def last_known(self, key, t):
        s = self.px.get(key, {})
        before = [x for x in s if x <= t]
        return (s[max(before)], max(before) - t) if before else (None, None)


def simulate(pr: Pricer, bricks: list, delay: int, lot: int, hold: str):
    """The page AUTO's Supertrend rule on `bricks`, filled `delay` minutes after the brick printed."""
    cutoff = HOLD_CUTOFF[hold]
    queue = sorted(bricks, key=lambda b: b["t"])
    qi = 0
    side, leg, trades, stale = 0, None, [], []
    done_day = None                       # a day whose last entry chance has passed (expiry-day square-off in carry)
    last_day = day_of(pr.minutes[-1])

    def close_leg(t, day, why):
        nonlocal leg, side
        key = (leg["expiry"], leg["type"], leg["strike"])
        p = pr.price(key, t)
        if p is None:
            p, g = pr.last_known(key, t)
            stale.append({"day": day, "type": leg["type"], "strike": leg["strike"], "age_min": -g // 60, "price": p})
        trades.append({**leg, "exit_t": t, "exit": p, "why": why})
        leg, side = None, 0

    for t in pr.minutes:
        day, hm = day_of(t), hm_of(t)
        due = []
        while qi < len(queue) and queue[qi]["t"] + 60 * delay <= t:
            if queue[qi]["day"] == day:   # a brick whose fill minute fell on a closed market never fills the next day
                due.append(queue[qi])
            qi += 1
        if leg:
            if cutoff and hm >= cutoff:
                close_leg(t, day, "eod")
            elif leg["expiry"] == day and hm >= EXPIRY_SQUARE_OFF:
                close_leg(t, day, "expiry")
                done_day = day
            elif day == last_day and hm >= (cutoff or EXPIRY_SQUARE_OFF):
                close_leg(t, day, "end")
        if (cutoff and hm >= cutoff) or done_day == day:
            continue
        for b in due:
            if b["dir"] is None:
                continue
            if leg and b["dir"] != side:
                close_leg(t, day, "flip")
            if not leg and b["col"] == b["dir"]:
                exp, k_atm = pr.atm[t]
                if exp == day and hm >= EXPIRY_SQUARE_OFF:
                    continue
                want = "PE" if b["dir"] == 1 else "CE"
                p = pr.price((exp, want, k_atm), t)
                if p is None:
                    continue
                leg, side = {"expiry": exp, "type": want, "strike": k_atm, "entry_t": t, "entry": p}, b["dir"]
    for tr in trades:
        tr["pts"] = round(tr["entry"] - tr["exit"], 2)
        tr["gross"] = round(tr["pts"] * lot, 2)
    return trades, stale


def stats(trades: list, cost: float, slip: float, lot: int) -> dict:
    if not trades:
        return {"trades": 0}
    net = [t["gross"] - 2 * cost for t in trades]
    eq = peak = dd = 0.0
    for x in net:
        eq += x
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    by_day = defaultdict(float)
    for t, x in zip(trades, net):
        by_day[day_of(t["exit_t"])] += x
    wins = [x for x in net if x > 0]
    losses = [x for x in net if x <= 0]
    overnight = [x for t, x in zip(trades, net) if day_of(t["entry_t"]) != day_of(t["exit_t"])]
    return {
        "trades": len(trades), "orders": 2 * len(trades),
        "gross": round(sum(t["gross"] for t in trades)), "costs": round(2 * cost * len(trades)),
        "net": round(sum(net)), "net_slip": round(sum(net) - 2 * slip * lot * len(trades)),
        "win_rate": round(100 * len(wins) / len(trades), 1),
        "avg_win": round(sum(wins) / len(wins)) if wins else 0,
        "avg_loss": round(sum(losses) / len(losses)) if losses else 0,
        "max_dd": round(dd),
        "best_day": round(max(by_day.values())), "worst_day": round(min(by_day.values())),
        "green_days": sum(1 for v in by_day.values() if v > 0), "days": len(by_day),
        "pe_net": round(sum(x for t, x in zip(trades, net) if t["type"] == "PE")),
        "ce_net": round(sum(x for t, x in zip(trades, net) if t["type"] == "CE")),
        "overnight_trades": len(overnight), "overnight_net": round(sum(overnight)),
        "avg_hold_min": round(sum((t["exit_t"] - t["entry_t"]) / 60 for t in trades) / len(trades)),
    }


def weekly(trades: list, cost: float) -> list:
    wk = defaultdict(lambda: [0.0, 0])
    for t in trades:
        wk[t["expiry"]][0] += t["gross"] - 2 * cost
        wk[t["expiry"]][1] += 1
    return [{"expiry": e, "net": round(v[0]), "trades": v[1]} for e, v in sorted(wk.items())]


def month_before(d: str) -> str:
    dt = datetime.strptime(d, "%Y-%m-%d")
    return (dt.replace(month=dt.month - 1) if dt.month > 1 else dt.replace(year=dt.year - 1, month=12)).strftime("%Y-%m-%d")


def main():
    ap = argparse.ArgumentParser(description="Renko + Supertrend ATM option-selling backtest (the /renko page's AUTO rule)")
    ap.add_argument("--end", help="last session (default: the DB's last expiry)")
    ap.add_argument("--start", help="first traded session (default: one month before --end)")
    ap.add_argument("--source", choices=["dhan", "db"], default="dhan", help="signal bars: Dhan index candles or DB spot")
    ap.add_argument("--hold", choices=["mis", "nrml", "carry"], default="mis")
    ap.add_argument("--warmup-days", type=int, default=10, help="calendar days of bars before --start for the auto brick")
    ap.add_argument("--st-period", type=int, default=1)
    ap.add_argument("--st-mult", type=float, default=2.0)
    ap.add_argument("--bricks", default="10,15,20,25,30,40,50", help="fixed brick sizes to run beside 'auto'")
    ap.add_argument("--lot", type=int, default=65)
    ap.add_argument("--cost", type=float, default=50.0, help="Rs per order")
    ap.add_argument("--slip", type=float, default=1.0, help="stress case: points against us per order")
    a = ap.parse_args()

    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    end = a.end or last_expiry(c)
    start = a.start or month_before(end)
    warm = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=a.warmup_days)).strftime("%Y-%m-%d")

    bars = dhan_index_bars(warm, end) if a.source == "dhan" else db_spot_bars(c, warm, end)
    if not bars:
        sys.exit(f"no signal bars for {warm}..{end}")
    sig = run_signals(bars, start, a.st_period, a.st_mult, a.bricks)
    px, atm = load_options(c, start, end)
    if not atm:
        sys.exit(f"no ATM option data in {DB} for {start}..{end}")
    pr = Pricer(px, atm)

    window = [b for b in bars if day_of(b["t"]) >= start]
    closes = [b["straddle"] for b in window]
    configs = []
    for name, s in sig["configs"].items():
        t0, stale = simulate(pr, s["bricks"], 0, a.lot, a.hold)
        t1, _ = simulate(pr, s["bricks"], 1, a.lot, a.hold)
        st0, st1 = stats(t0, a.cost, a.slip, a.lot), stats(t1, a.cost, a.slip, a.lot)
        boxes = sorted(set(s["boxes"].values()))
        configs.append({
            "key": name,
            "label": "Auto" if name == "auto" else f"{name[5:]} pts",
            "brick": boxes[0] if len(boxes) == 1 else None,
            "brick_range": [boxes[0], boxes[-1]],
            "boxes_by_day": s["boxes"],
            "bricks": len(s["bricks"]),
            "stats": st0, "stats_next_minute": st1,
            "weekly": weekly(t0, a.cost),
            "stale_exits": stale,
            "trades": [{"expiry": t["expiry"], "type": t["type"], "strike": t["strike"],
                        "entry_t": t["entry_t"], "entry": t["entry"], "exit_t": t["exit_t"], "exit": t["exit"],
                        "pts": t["pts"], "net": round(t["gross"] - 2 * a.cost), "why": t["why"]} for t in t0],
        })

    run_id = f"{start}_{end}_{a.hold}_{a.source}_{datetime.now(IST).strftime('%Y%m%d_%H%M%S')}"
    result = {
        "id": run_id,
        "generated_at": datetime.now(IST).isoformat(timespec="seconds"),
        "strategy": "Renko + Supertrend AUTO: sell the current-week ATM PE on a green brick with the line up, ATM CE on a red brick with it down (1 lot)",
        "params": {"start": start, "end": end, "st_period": a.st_period, "st_mult": a.st_mult, "lot": a.lot,
                   "cost_per_order": a.cost, "slip_pts": a.slip, "hold": a.hold, "cutoff": HOLD_CUTOFF[a.hold],
                   "expiry_square_off": EXPIRY_SQUARE_OFF, "fill": "option close on the brick's minute",
                   "source": a.source,
                   "underlying": "Dhan NIFTY index 1-min candles" if a.source == "dhan" else "NIFTY spot stored in Options Data/nifty_options.db"},
        "market": {"sessions": len({day_of(b["t"]) for b in window}), "spot_start": closes[0], "spot_end": closes[-1],
                   "spot_low": min(closes), "spot_high": max(closes),
                   "change_pct": round(100 * (closes[-1] / closes[0] - 1), 2)},
        "auto_formulas": sig["configs"]["auto"].get("formulas", {}),
        "configs": configs,
    }
    run_dir = os.path.join(OUT_DIR, run_id)
    os.makedirs(run_dir, exist_ok=True)
    for path in (os.path.join(run_dir, "result.json"), os.path.join(OUT_DIR, "latest.json")):
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(result, f)
        os.replace(tmp, path)

    print(f"{start} -> {end}: {result['market']['sessions']} sessions, NIFTY {closes[0]} -> {closes[-1]} "
          f"({result['market']['change_pct']:+.2f}%), hold {a.hold}, signals {a.source}, lot {a.lot}, "
          f"Rs{a.cost:.0f}/order, slip {a.slip} pt/order")
    print(f"{'config':>9} {'brick':>12} {'trades':>7} {'gross':>8} {'net':>8} {'net-slip':>9} {'win%':>6} {'maxDD':>8} {'next-min':>9}")
    for cfg in configs:
        s0, s1 = cfg["stats"], cfg["stats_next_minute"]
        br = f"{cfg['brick_range'][0]}-{cfg['brick_range'][1]}" if cfg["brick"] is None else str(cfg["brick"])
        print(f"{cfg['label']:>9} {br:>12} {s0.get('trades', 0):>7} {s0.get('gross', 0):>8} {s0.get('net', 0):>8} "
              f"{s0.get('net_slip', 0):>9} {s0.get('win_rate', 0):>6} {s0.get('max_dd', 0):>8} {s1.get('net', 0):>9}")
    print(f"saved {os.path.relpath(run_dir, PROJECT_ROOT)}/result.json and latest.json")


if __name__ == "__main__":
    main()
