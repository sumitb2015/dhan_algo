"""
Backtest of the "Strong Start" swing setup from the Trading with Groww "Chart Gym" video (XX-OkqmewGI).

Rules are the video's, made mechanical by us (every threshold below is OUR reading, marked with a flag):
  Setup day S   : narrow-range day (range is the smallest of the last --nr days), stock in a prior advance
                  (>= --runup% gain over --runup-days) with a controlled correction (<= --maxdd% from the swing
                  high), close above the 50-day average, and NOT extended (<= --maxext% above the low of the
                  last 10-EMA undercut).
  Trigger day T : next session. Strong Start = gap up (open > S close) AND the day's low holds above S close,
                  or open ~= low (within --openlow%). Entry = max(open, S high) if price trades through it.
                  Initial stop = low of T. Trade skipped if (entry-stop)/entry > --maxrisk%.
  Management    : +8% -> stop to cost; +15% -> stop below 20-EMA; +24% -> stop below 10-EMA;
                  sell 50% at +40%; remainder rides the trailing stop.
  --nolook      : control run with NO same-day look-ahead: enter at T open only if open > S close and
                  open <= S high*1.01; stop = S low. (The default rule needs T's low, known only at T's close.)
Data: Daily_Historical_Data_Fresh (Dhan). Survivorship: files are today's Nifty-500 constituents.
"""
import argparse, glob, os, sys
import numpy as np, pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ap = argparse.ArgumentParser()
ap.add_argument("--nr", type=int, default=7)
ap.add_argument("--runup", type=float, default=40.0)
ap.add_argument("--runup-days", type=int, default=63)
ap.add_argument("--maxdd", type=float, default=25.0)
ap.add_argument("--maxext", type=float, default=15.0)
ap.add_argument("--openlow", type=float, default=1.0)
ap.add_argument("--maxrisk", type=float, default=5.0)
ap.add_argument("--fee", type=float, default=0.15, help="round-trip... per side %% incl. slippage")
ap.add_argument("--nolook", action="store_true")
ap.add_argument("--regime", action="store_true", help="only trade when Nifty 500 closes above its 50-day average on the setup day")
ap.add_argument("--voldry", type=float, default=0, help="setup-day volume must be below this multiple of its 50-day average (0=off)")
ap.add_argument("--maxrun", type=float, default=0, help="skip if the stock is up more than this %% over 120 sessions (0=off): video's 'needs a base after ~100%%'")
ap.add_argument("--gapmax", type=float, default=0, help="nolook: skip if open is more than this %% above setup high (0=off)")
ap.add_argument("--atrstop", type=float, default=0, help="nolook: stop = min(setup low, entry - k*ATR14); 0=setup low only")
ap.add_argument("--exhaust", action="store_true", help="after +40%%, sell the rest on the widest-range, highest-volume bar of 60 sessions")
ap.add_argument("--port", action="store_true", help="portfolio simulation")
ap.add_argument("--risk", type=float, default=0.5, help="portfolio: %% of equity risked per trade")
ap.add_argument("--maxpos", type=int, default=10)
ap.add_argument("--out", default=None)
a = ap.parse_args()


def load(path):
    d = pd.read_csv(path, parse_dates=["Datetime"]).rename(columns=str.lower)
    d = d.rename(columns={"datetime": "date"}).set_index("date").sort_index()
    d = d[~d.index.duplicated()]
    d = d[(d.volume > 0) & (d.close > 0)]
    return d


def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


_bm = pd.read_csv(os.path.join(ROOT, "Historical Data", "NIFTY_500_Daily.csv"), parse_dates=["Datetime"]).set_index("Datetime").Close
REGIME = _bm > _bm.rolling(50).mean()


def trades_for(sym, d):
    if len(d) < 200:
        return []
    o, h, l, c, v = (d[k].values for k in ("open", "high", "low", "close", "volume"))
    n = len(d)
    e10, e20 = ema(d.close, 10).values, ema(d.close, 20).values
    sma50 = d.close.rolling(50).mean().values
    rng = (d.high - d.low).values
    rng_min = pd.Series(rng).rolling(a.nr).min().values
    hi_swing = d.close.rolling(a.runup_days).max().values
    lo_base = d.close.rolling(a.runup_days * 2).min().values
    # extension from the low of the last 10-EMA undercut (undercut: low < ema10)
    under = l < e10
    last_under_low = np.full(n, np.nan); cur = np.nan
    for i in range(n):
        if under[i]:
            cur = l[i]
        last_under_low[i] = cur
    # a gap this size means a split/demerger break, not price action
    vavg = pd.Series(v).rolling(50).mean().values
    tr = pd.concat([d.high - d.low, (d.high - d.close.shift()).abs(), (d.low - d.close.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 14, adjust=False).mean().values
    rng60 = pd.Series(rng).rolling(60).max().values
    vol60 = pd.Series(v).rolling(60).max().values
    run120 = (d.close / d.close.rolling(120).min()).values - 1
    reg = REGIME.reindex(d.index).ffill().fillna(False).values
    jump = np.abs(np.r_[0, o[1:] / c[:-1] - 1]) > 0.35
    out = []; i = 200; busy_until = -1
    while i < n - 2:
        s, t = i, i + 1
        if t <= busy_until or jump[max(0, s - 1):t + 1].any():
            i += 1; continue
        setup = (
            rng[s] <= rng_min[s] + 1e-9
            and hi_swing[s] / lo_base[s] - 1 >= a.runup / 100
            and 1 - c[s] / hi_swing[s] <= a.maxdd / 100
            and c[s] > sma50[s]
            and (np.isnan(last_under_low[s]) or c[s] / last_under_low[s] - 1 <= a.maxext / 100)
        )
        if setup and a.regime and not reg[s]: setup = False
        if setup and a.voldry and v[s] >= a.voldry * vavg[s]: setup = False
        if setup and a.maxrun and run120[s] > a.maxrun / 100: setup = False
        if not setup:
            i += 1; continue
        if a.nolook:
            if not (o[t] > c[s] and o[t] <= h[s] * 1.01):
                i += 1; continue
            if a.gapmax and o[t] > h[s] * (1 + a.gapmax / 100):
                i += 1; continue
            entry, stop, ei = o[t], l[s], t
            if a.atrstop: stop = min(stop, entry - a.atrstop * atr[s])
        else:
            strong = (o[t] > c[s] and l[t] >= c[s]) or ((o[t] - l[t]) / o[t] <= a.openlow / 100)
            trig = max(o[t], h[s])
            if not (strong and h[t] >= trig):
                i += 1; continue
            entry, stop, ei = trig, l[t], t
        risk = entry - stop
        if risk <= 0 or risk / entry > a.maxrisk / 100:
            i += 1; continue
        # manage from the day after entry (stop set at close of entry day in default mode)
        start = ei if a.nolook else ei + 1
        cur_stop, half_sold, realised, ex_i, ex_p = stop, False, 0.0, None, None
        rem = 1.0
        for j in range(start, min(n, ei + 250)):
            if o[j] <= cur_stop:                       # gap through stop
                px = o[j]; realised += rem * (px - entry); rem = 0; ex_i, ex_p = j, px; break
            if l[j] <= cur_stop:
                px = cur_stop; realised += rem * (px - entry); rem = 0; ex_i, ex_p = j, px; break
            gain = h[j] / entry - 1
            if not half_sold and gain >= 0.40:
                px = max(o[j], entry * 1.40); realised += 0.5 * (px - entry); rem -= 0.5; half_sold = True
            if a.exhaust and half_sold and rng[j] >= rng60[j] and v[j] >= vol60[j]:
                px = c[j]; realised += rem * (px - entry); rem = 0; ex_i, ex_p = j, px; break
            if gain >= 0.08: cur_stop = max(cur_stop, entry)
            if gain >= 0.15: cur_stop = max(cur_stop, 0.99 * e20[j])
            if gain >= 0.24: cur_stop = max(cur_stop, 0.99 * e10[j])
        if rem > 0:
            j = min(n - 1, ei + 249); px = c[j]; realised += rem * (px - entry); ex_i, ex_p = j, px
        fee = 2 * a.fee / 100 * entry
        out.append(dict(sym=sym, setup=d.index[s], entry_date=d.index[ei], exit_date=d.index[ex_i],
                        entry=entry, exit=ex_p, risk_pct=risk / entry * 100,
                        ret_gross=realised / entry * 100, ret_net=(realised - fee) / entry * 100,
                        R_gross=realised / risk, R_net=(realised - fee) / risk, bars=ex_i - ei))
        busy_until = ex_i
        i = ex_i + 1
    return out


rows = []
files = sorted(glob.glob(os.path.join(ROOT, "Daily_Historical_Data_Fresh", "*_Daily_2Y.csv")))
for f in files:
    sym = os.path.basename(f).replace("_Daily_2Y.csv", "")
    try:
        rows += trades_for(sym, load(f))
    except Exception as e:
        print("skip", sym, e, file=sys.stderr)
T = pd.DataFrame(rows)
if T.empty:
    print("NO TRADES"); sys.exit()
T = T.sort_values("entry_date").reset_index(drop=True)


def summ(x, tag):
    w = x[x.R_net > 0]; ls = x[x.R_net <= 0]
    pf = w.R_net.sum() / abs(ls.R_net.sum()) if len(ls) and ls.R_net.sum() else np.inf
    return (f"{tag:<22} n={len(x):5d} win={100*(x.R_net>0).mean():5.1f}% "
            f"avgR_gross={x.R_gross.mean():+.2f} avgR_net={x.R_net.mean():+.2f} "
            f"medR={x.R_net.median():+.2f} PF={pf:4.2f} avgRet%={x.ret_net.mean():+.2f} "
            f"best={x.R_net.max():+.1f}R avgHold={x.bars.mean():.0f}d")


print(f"files={len(files)} mode={'NOLOOK' if a.nolook else 'default'} params={vars(a)}")
print(summ(T, "ALL"))
T["yr"] = T.entry_date.dt.year
for y, g in T.groupby("yr"): print(summ(g, str(y)))
print(summ(T[T.entry_date < "2023-01-01"], "IS  2019-2022"))
print(summ(T[T.entry_date >= "2023-01-01"], "OOS 2023-2026"))
top = T.R_net.nlargest(max(1, len(T)//20))
print(f"top5% of trades give {100*top.sum()/T.R_net.sum():.0f}% of total R; "
      f"avgR_net without them = {T.R_net.drop(top.index).mean():+.2f}")
print(f"first {T.entry_date.min().date()} last {T.entry_date.max().date()}; "
      f"avg risk {T.risk_pct.mean():.1f}%")
if a.port:
    ev = T.sort_values("entry_date"); eq = 1.0; peak = 1.0; mdd = 0.0; open_ = []; curve = []; taken = 0
    for r in ev.itertuples():
        # realise exits that happened before this entry
        for x in sorted([x for x in open_ if x[0] < r.entry_date]):
            eq += x[1]; open_.remove(x); peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak); curve.append((x[0], eq))
        if len(open_) >= a.maxpos: continue
        used = sum(x[2] for x in open_)                     # gross exposure, never above 100% of equity
        size = min(a.risk / 100 * eq / (r.risk_pct / 100), 0.2 * eq, eq - used)   # cap 20% per name
        if size < 0.02 * eq: continue
        open_.append((r.exit_date, size * r.ret_net / 100, size)); taken += 1
    for x in sorted(open_):
        eq += x[1]; peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak); curve.append((x[0], eq))
    yrs = (T.exit_date.max() - T.entry_date.min()).days / 365.25
    bmr = _bm.loc[T.entry_date.min():]; bcagr = (bmr.iloc[-1] / bmr.iloc[0]) ** (1 / yrs) - 1
    ret = pd.Series(dict(curve)); ann = ret.groupby(ret.index.year).last().pct_change()
    print(f"PORTFOLIO risk={a.risk}% maxpos={a.maxpos} taken={taken}/{len(T)}  final x{eq:.2f}  CAGR={100*(eq**(1/yrs)-1):.1f}%  maxDD(realised)={100*mdd:.1f}%  Nifty500 CAGR same span={100*bcagr:.1f}%")
if a.out:
    T.to_csv(a.out, index=False); print("saved", a.out)
