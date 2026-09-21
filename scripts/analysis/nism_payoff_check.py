"""Recompute the NISM Series VIII workbook payoff tables and check them against the printed values.

Reads the workbook's chapter 5 text (raw/articles/nism-viii-ed-ch05-option-trading-strategies.md in the
Obsidian vault), rebuilds each strategy's per-leg and net payoff from its legs, and compares every cell
of every printed table. Optionally draws the charts. Education/verification only: no market data, no orders.

    venv/bin/python scripts/analysis/nism_payoff_check.py [--raw PATH] [--plot OUTDIR]
"""
import argparse
import os
import re

DEFAULT_RAW = os.path.expanduser(
    "~/Brain/dhan_algo_brain/raw/articles/nism-viii-ed-ch05-option-trading-strategies.md")


def leg_pay(leg, spot):
    """Per-unit expiry P&L of one leg. side=+1 long, -1 short; premium is subtracted for longs (added for shorts)."""
    kind, side = leg["k"], leg["side"]
    if kind == "call":
        v = max(spot - leg["K"], 0) - leg["P"]
    elif kind == "put":
        v = max(leg["K"] - spot, 0) - leg["P"]
    else:  # 'stock' or 'future': linear from the entry price
        v = spot - leg["entry"]
    return side * v


def net(legs, spot):
    return sum(leg_pay(l, spot) for l in legs)


def _c(side, K, P): return dict(k="call", side=side, K=K, P=P)
def _p(side, K, P): return dict(k="put", side=side, K=K, P=P)
def _s(entry): return dict(k="stock", side=1, entry=entry)


# (name, text marker locating the printed table, legs in the table's column order)
STRATEGIES = [
    ("Bull call spread", "Bullish Vertical Spread using Calls", [_c(1, 5800, 300), _c(-1, 6200, 145)]),
    ("Bull put spread", "Bullish Vertical Spread using Puts", [_p(-1, 6200, 220), _p(1, 6000, 170)]),
    ("Bear call spread", "Bearish Vertical Spread using calls", [_c(1, 6200, 145), _c(-1, 5800, 300)]),
    ("Bear put spread", "Bearish Vertical Spread using puts", [_p(-1, 6000, 170), _p(1, 6200, 220)]),
    ("Long straddle", "Combined pay-off may be shown as follows", [_c(1, 6000, 257), _p(1, 6000, 136)]),
    ("Short straddle", "Position may be shown as follows", [_c(-1, 6000, 257), _p(-1, 6000, 136)]),
    ("Long strangle", "Let us see this with various price points", [_c(1, 6200, 145), _p(1, 6000, 140)]),
    ("Short strangle", "This is exactly opposite to the long strangle", [_c(-1, 6200, 145), _p(-1, 6000, 140)]),
    ("Covered call", "Therefore, combined position of long stock", [_s(1590), _c(-1, 1600, 10)]),
    ("Protective put", "Long Cash         1600", [_s(1600), _p(1, 1600, 20)]),
    ("Collar", "Combined position (i.e. long underlying", [_s(1590), _c(-1, 1600, 10), _p(1, 1580, 7)]),
    ("Butterfly (calls)", "Spot              6100", [_c(1, 6000, 230), _c(-1, 6100, 150), _c(1, 6200, 100), _c(-1, 6100, 150)]),
]


def parse_rows(text, marker, n_legs):
    """First run of table rows after `marker`: CMP followed by n_legs leg columns and the net column."""
    i = text.find(marker)
    if i < 0:
        raise SystemExit(f"marker not found: {marker!r}")
    pat = re.compile(r"^\s+(\d{4})((?:\s+-?\d+){%d})\s*$" % (n_legs + 1))
    rows, started = [], False
    for line in text[i:].split("\n")[1:]:
        m = pat.match(line)
        if m:
            rows.append((int(m.group(1)), [int(x) for x in m.group(2).split()]))
            started = True
        elif started and re.match(r"^\s*(As can|It may|It should|In this|From the|The pay)", line):
            break
    return rows


def breakevens(legs, lo, hi, step=0.5):
    """Zero crossings by linear interpolation between adjacent samples (exact at kinks on a 0.5 grid)."""
    xs = [lo + k * step for k in range(int((hi - lo) / step) + 1)]
    ys = [net(legs, x) for x in xs]
    out = []
    for i in range(1, len(xs)):
        if ys[i - 1] == 0:
            out.append(xs[i - 1])
        elif ys[i - 1] * ys[i] < 0:
            out.append(xs[i - 1] - ys[i - 1] * (xs[i] - xs[i - 1]) / (ys[i] - ys[i - 1]))
    return sorted(set(round(b, 2) for b in out)), max(ys), min(ys)


def bounds(legs):
    ks = [l.get("K", l.get("entry")) for l in legs]
    pad = 500 if max(ks) > 3000 else 150
    return min(ks) - pad, max(ks) + pad


def check(raw):
    text = open(raw).read()
    cells = bad = 0
    for name, marker, legs in STRATEGIES:
        rows = parse_rows(text, marker, len(legs))
        mism = []
        for spot, vals in rows:
            for c, v in zip([leg_pay(l, spot) for l in legs] + [net(legs, spot)], vals):
                cells += 1
                if abs(c - v) > 1e-9:
                    bad += 1
                    mism.append((spot, round(c, 2), v))
        lo, hi = bounds(legs)
        bep, mx, mn = breakevens(legs, lo, hi)
        print(f"{name:18s} rows={len(rows):2d} mismatches={len(mism)} BEP={bep} window max={mx:g} min={mn:g}")
    print(f"cells compared {cells}, mismatches {bad}")
    return bad


def plot(outdir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(outdir, exist_ok=True)
    for name, _, legs in STRATEGIES:
        lo, hi = bounds(legs)
        xs = list(range(int(lo), int(hi) + 1))
        fig, ax = plt.subplots(figsize=(8, 4.2), dpi=110)
        for l in legs:
            lab = ("Long " if l["side"] > 0 else "Short ") + l["k"]
            lab += f" {l['K']} @ {l['P']}" if l["k"] != "stock" else f" bought {l['entry']}"
            ax.plot(xs, [leg_pay(l, x) for x in xs], lw=1, ls="--", alpha=.7, label=lab)
        ax.plot(xs, [net(legs, x) for x in xs], color="black", lw=2.4, label="Net payoff at expiry")
        ax.axhline(0, color="grey", lw=.8)
        for b in breakevens(legs, lo, hi)[0]:
            ax.axvline(b, color="red", lw=.8, ls=":")
        ax.set_title(f"{name} (NISM workbook example, recomputed)", fontsize=11)
        ax.set_xlabel("Underlying at expiry"); ax.set_ylabel("P/L per unit"); ax.legend(fontsize=7)
        fig.tight_layout()
        fig.savefig(os.path.join(outdir, "nism-viii-computed-" + re.sub(r"[ ()]", "-", name.lower()).strip("-") + ".png"))
        plt.close(fig)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--raw", default=DEFAULT_RAW)
    ap.add_argument("--plot", metavar="OUTDIR")
    a = ap.parse_args()
    rc = check(a.raw)
    if a.plot:
        plot(a.plot)
    raise SystemExit(1 if rc else 0)
