"""
Backtest the Options Regime Score (rs_dashboard/lib/optionsRegime.ts) against real
historical 1-minute NIFTY option-chain OI, using Options Data/nifty_options.db
(built by convert_options_to_sqlite.py) instead of the live iv_snapshot_collector.py
CSVs — the DB already has ~5.5 years of real per-minute OI, so there is no need to
wait for the live collector to accumulate sessions one day at a time.

The math below is a line-for-line Python port of rs_dashboard/lib/optionsRegime.ts —
same weights, thresholds, and window sizes — so a backtest result here reflects
what the dashboard would actually have shown, not an approximation.

Known differences from the live collector (iv_snapshot_collector.py), worth keeping
in mind when reading results:
  - The DB's 'ATM' label is recomputed every minute (nearest strike to that minute's
    spot), not locked at session open like the live collector. So "ATM+2" can point
    at a different absolute strike at 9:16 than at 9:45. This makes the OI window
    more adaptive to intraday spot moves, but is not identical to production.
  - The DB stores only the nearest weekly expiry per calendar day (confirmed: one
    expiry per day, 1379 trading days total, 2020-12-31 to 2026-07-28).
  - change_OI is derived here as a per-minute diff of the aggregate OI series
    (equivalent to summing per-strike diffs, since the same 21 strikes are present
    each minute) — the live collector's change_OI field only started working
    correctly from 2026-08-26 onward (see fix commit a548e1a), so this backtest
    does not depend on that field at all.

Usage:
    python scripts/analysis/backtest_options_regime.py
    python scripts/analysis/backtest_options_regime.py --start 2026-01-01 --end 2026-07-28
    python scripts/analysis/backtest_options_regime.py --wings 10 --short-offset 2 --spread-width 2
    python scripts/analysis/backtest_options_regime.py --db "D:\\other\\nifty_options.db"
"""
import argparse
import math
import sqlite3

import pandas as pd

DEFAULT_DB = r"C:\dhan_algo\dhan_algo\Options Data\nifty_options.db"

# ── Regime math — ported 1:1 from rs_dashboard/lib/optionsRegime.ts ──────────

EPS_STD = 1e-6
MIN_SAMPLES = 10
REGRESSION_WINDOW = 30
ACCEL_WINDOW = 10
RETURN_LOOKBACK = 30

SIGNAL_WEIGHTS = {"oi": 0.25, "slope": 0.20, "accel": 0.10, "wpi": 0.25, "priceTrend": 0.20}
CONFIDENCE_WEIGHTS = {"oi": 0.30, "slope": 0.20, "wpi": 0.25, "priceTrend": 0.25}
Z_CAP = 3
THRESH_STRONG = 1.25
THRESH_DIRECTIONAL = 0.5
ZONE_THRESH = 0.5
CONFIDENCE_HIGH = 1.5
CONFIDENCE_MODERATE = 0.7


def clip(z, limit=Z_CAP):
    return max(-limit, min(limit, z))


def zone_for(z):
    if z > ZONE_THRESH:
        return "Bullish"
    if z < -ZONE_THRESH:
        return "Bearish"
    return "Neutral"


def rolling_regression_slope(series, i, window=REGRESSION_WINDOW):
    start = max(0, i - window + 1)
    m = i - start + 1
    if m < 2:
        return 0.0
    xs = range(m)
    ys = series[start:i + 1]
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_xx = sum(x * x for x in xs)
    denom = m * sum_xx - sum_x * sum_x
    if abs(denom) < EPS_STD:
        return 0.0
    return (m * sum_xy - sum_x * sum_y) / denom


def rolling_delta(series, i, window):
    j = max(0, i - window)
    return series[i] - series[j]


def writing_pressure(ce_oi_chg, ce_ltp_chg, pe_oi_chg, pe_ltp_chg):
    put_pressure = pe_oi_chg * -pe_ltp_chg
    call_pressure = ce_oi_chg * ce_ltp_chg
    return put_pressure + call_pressure


def log_return(spot_now, spot_then):
    if spot_now <= 0 or spot_then <= 0:
        return 0.0
    return math.log(spot_now / spot_then)


def zscore(series, i):
    """Expanding-window z-score: uses only samples 0..i (no lookahead)."""
    if i < MIN_SAMPLES:
        return 0.0
    window = series[:i + 1]
    mean = sum(window) / len(window)
    variance = sum((v - mean) ** 2 for v in window) / len(window)
    std = math.sqrt(variance)
    if std < EPS_STD:
        return 0.0
    return (series[i] - mean) / std


def regime_label_for_signal(signal):
    if signal > THRESH_STRONG:
        return "Strong Bullish"
    if signal < -THRESH_STRONG:
        return "Strong Bearish"
    if abs(signal) < THRESH_DIRECTIONAL:
        return "Neutral"
    return "Bullish" if signal > 0 else "Bearish"


def confidence_label_for(confidence):
    if confidence >= CONFIDENCE_HIGH:
        return "High"
    if confidence >= CONFIDENCE_MODERATE:
        return "Moderate"
    return "Low"


def is_bullish_label(label):
    return label in ("Bullish", "Strong Bullish")


def is_bearish_label(label):
    return label in ("Bearish", "Strong Bearish")


def is_confirmed(label, oi_zone, wpi_zone, price_trend_zone):
    if label == "Neutral":
        return True
    direction = "Bullish" if is_bullish_label(label) else "Bearish"
    return oi_zone == direction and wpi_zone == direction and price_trend_zone == direction


def suggested_strategy_for(label, confirmed):
    if label == "Neutral":
        return "Iron Condor"
    if not confirmed:
        return "No trade — regime not confirmed"
    return "Bull Put Spread" if is_bullish_label(label) else "Bear Call Spread"


def compute_regime_series(spots, ce_oi, pe_oi, ce_ltp, pe_ltp):
    """One trading session's worth of per-minute aggregates -> per-minute regime records.

    Mirrors computeRegimeSeries() in lib/optionsRegime.ts exactly (same formulas,
    same expanding-window-per-session reset — this is called once per calendar day).
    """
    n = len(spots)
    d_series = [pe_oi[i] - ce_oi[i] for i in range(n)]
    slope_series = [rolling_regression_slope(d_series, i) for i in range(n)]
    accel_series = [rolling_delta(slope_series, i, ACCEL_WINDOW) for i in range(n)]

    session_avg_spot = []
    running_sum = 0.0
    for i in range(n):
        running_sum += spots[i]
        session_avg_spot.append(running_sum / (i + 1))
    spot_deviation_series = [spots[i] - session_avg_spot[i] for i in range(n)]

    nifty_return_series = [log_return(spots[i], spots[max(0, i - RETURN_LOOKBACK)]) for i in range(n)]

    wpi_series = [
        writing_pressure(
            0.0 if i == 0 else ce_oi[i] - ce_oi[i - 1],
            0.0 if i == 0 else ce_ltp[i] - ce_ltp[i - 1],
            0.0 if i == 0 else pe_oi[i] - pe_oi[i - 1],
            0.0 if i == 0 else pe_ltp[i] - pe_ltp[i - 1],
        )
        for i in range(n)
    ]

    records = []
    for i in range(n):
        oi_z = zscore(d_series, i)
        slope_z = zscore(slope_series, i)
        accel_z = zscore(accel_series, i)
        wpi_z = zscore(wpi_series, i)
        price_trend_z = (zscore(spot_deviation_series, i) + zscore(nifty_return_series, i)) / 2

        oi_z_, slope_z_, accel_z_, wpi_z_, pt_z_ = (clip(v) for v in (oi_z, slope_z, accel_z, wpi_z, price_trend_z))
        signal = (
            SIGNAL_WEIGHTS["oi"] * oi_z_ + SIGNAL_WEIGHTS["slope"] * slope_z_ + SIGNAL_WEIGHTS["accel"] * accel_z_
            + SIGNAL_WEIGHTS["wpi"] * wpi_z_ + SIGNAL_WEIGHTS["priceTrend"] * pt_z_
        )
        confidence = (
            CONFIDENCE_WEIGHTS["oi"] * abs(oi_z_) + CONFIDENCE_WEIGHTS["slope"] * abs(slope_z_)
            + CONFIDENCE_WEIGHTS["wpi"] * abs(wpi_z_) + CONFIDENCE_WEIGHTS["priceTrend"] * abs(pt_z_)
        )

        warming_up = i < MIN_SAMPLES
        label = "Neutral" if warming_up else regime_label_for_signal(signal)
        oi_zone, slope_zone, wpi_zone, pt_zone = (zone_for(v) for v in (oi_z, slope_z, wpi_z, price_trend_z))
        confirmed = True if warming_up else is_confirmed(label, oi_zone, wpi_zone, pt_zone)

        records.append({
            "i": i, "signal": signal, "confidence": confidence,
            "confidence_label": confidence_label_for(confidence),
            "label": label, "confirmed": confirmed,
            "strategy": suggested_strategy_for(label, confirmed),
            "oi_z": oi_z, "slope_z": slope_z, "wpi_z": wpi_z, "price_trend_z": price_trend_z,
            "oi_zone": oi_zone, "wpi_zone": wpi_zone, "price_trend_zone": pt_zone,
            "warming_up": warming_up,
        })
    return records


# ── Data loading ──────────────────────────────────────────────────────────────

def get_trading_days(con, start, end):
    q = "SELECT DISTINCT date(datetime) FROM option_prices"
    params = []
    if start or end:
        q += " WHERE 1=1"
        if start:
            q += " AND datetime >= ?"
            params.append(start)
        if end:
            q += " AND datetime <= ?"
            params.append(end + " 23:59:59")
    q += " ORDER BY 1"
    return [r[0] for r in con.execute(q, params).fetchall()]


def load_day(con, day, wings):
    offsets = ["ATM"] + [f"ATM+{k}" for k in range(1, wings + 1)] + [f"ATM-{k}" for k in range(1, wings + 1)]
    placeholders = ",".join("?" * len(offsets))
    q = f"""
        SELECT datetime, option_type, strike_relative, close, oi, spot
        FROM option_prices
        WHERE date(datetime) = ? AND strike_relative IN ({placeholders})
        ORDER BY datetime
    """
    df = pd.read_sql_query(q, con, params=[day] + offsets)
    return df


def aggregate_minutely(df):
    """Per-minute: total CE/PE OI, OI-weighted avg CE/PE premium, spot."""
    ce = df[df.option_type == "CE"]
    pe = df[df.option_type == "PE"]

    def agg(side):
        g = side.groupby("datetime")
        oi_sum = g["oi"].sum()
        wtd_ltp = (side["close"] * side["oi"]).groupby(side["datetime"]).sum() / oi_sum.replace(0, float("nan"))
        return oi_sum, wtd_ltp.fillna(0.0)

    ce_oi, ce_ltp = agg(ce)
    pe_oi, pe_ltp = agg(pe)
    spot = df.groupby("datetime")["spot"].first()

    out = pd.DataFrame({"ceOI": ce_oi, "peOI": pe_oi, "ceLTP": ce_ltp, "peLTP": pe_ltp, "spot": spot}).dropna()
    out = out.sort_index()
    return out


# ── Strategy P&L simulation (one trade/day, first confirmed signal, held to EOD) ──

def strike_lookup(df, side, offset_label):
    rows = df[(df.option_type == side) & (df.strike_relative == offset_label)]
    series = rows.set_index("datetime")["close"]
    # A strike can briefly carry the same relative label twice in one minute if the
    # underlying's rounding to the strike grid flips right at a boundary — keep the
    # first recorded quote for that minute rather than let a duplicate index turn
    # scalar lookups below into an (ambiguous) 2-element Series.
    return series[~series.index.duplicated(keep="first")]


def simulate_first_signal_pnl(day_df, minutely, records, short_offset, width):
    """One trade per day: enter at the first confirmed non-Neutral signal, exit at EOD.

    Simplifications (deliberate, for a first-pass backtest — not production sizing):
    ignores margin, brokerage, slippage; one lot-equivalent (per-point P&L, not
    rupees, since NIFTY lot size changed across this multi-year range); assumes
    the spread can be filled at the recorded 1-minute close; no early exit/stop.
    """
    first = next((r for r in records if not r["warming_up"] and r["confirmed"] and r["label"] != "Neutral"), None)
    if first is None:
        return None

    ts_index = minutely.index
    entry_ts = ts_index[first["i"]]
    exit_ts = ts_index[-1]

    bullish = is_bullish_label(first["label"])
    side = "PE" if bullish else "CE"
    short_label = f"ATM-{short_offset}" if bullish else f"ATM+{short_offset}"
    long_label = f"ATM-{short_offset + width}" if bullish else f"ATM+{short_offset + width}"

    short_series = strike_lookup(day_df, side, short_label)
    long_series = strike_lookup(day_df, side, long_label)
    if entry_ts not in short_series.index or entry_ts not in long_series.index:
        return None
    if exit_ts not in short_series.index or exit_ts not in long_series.index:
        return None

    entry_credit = short_series[entry_ts] - long_series[entry_ts]
    exit_debit = short_series[exit_ts] - long_series[exit_ts]
    pnl_points = entry_credit - exit_debit  # credit spread: profit if it narrows

    return {
        "entry_time": entry_ts, "label": first["label"], "strategy": first["strategy"],
        "short_label": short_label, "long_label": long_label,
        "entry_credit": entry_credit, "exit_debit": exit_debit, "pnl_points": pnl_points,
    }


# ── Forward-return hit-rate check (validates confirmation vs raw divergence) ──

def forward_return_hitrate(minutely, records, horizon):
    spots = minutely["spot"].values
    n = len(spots)
    raw_hits, raw_total = 0, 0
    confirmed_hits, confirmed_total = 0, 0
    for r in records:
        i = r["i"]
        if i + horizon >= n or r["warming_up"]:
            continue
        fwd = spots[i + horizon] - spots[i]
        d_sign = 1 if (r["oi_z"] > 0) else (-1 if r["oi_z"] < 0 else 0)
        if d_sign != 0:
            raw_total += 1
            if (fwd > 0) == (d_sign > 0):
                raw_hits += 1
        if r["confirmed"] and r["label"] != "Neutral":
            confirmed_total += 1
            bullish = is_bullish_label(r["label"])
            if (fwd > 0) == bullish:
                confirmed_hits += 1
    return raw_hits, raw_total, confirmed_hits, confirmed_total


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Backtest the Options Regime Score against historical 1-min OI data")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--start", default=None, help="YYYY-MM-DD (default: earliest available)")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default: latest available)")
    ap.add_argument("--wings", type=int, default=10)
    ap.add_argument("--short-offset", type=int, default=2, help="Short strike ATM offset for the simulated spread")
    ap.add_argument("--spread-width", type=int, default=2, help="Long strike is short-offset + this, further OTM")
    ap.add_argument("--horizon", type=int, default=15, help="Forward-return horizon in minutes for hit-rate check")
    ap.add_argument("--limit-days", type=int, default=None, help="Cap number of trading days processed (for a quick run)")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    days = get_trading_days(con, args.start, args.end)
    if args.limit_days:
        days = days[-args.limit_days:]
    print(f"Backtesting {len(days)} trading days ({days[0]} to {days[-1]})")

    all_pnl = []
    raw_hits_total = raw_total_total = confirmed_hits_total = confirmed_total_total = 0
    confirmed_signal_days = 0
    label_counts = {}

    for day in days:
        day_df = load_day(con, day, args.wings)
        if day_df.empty:
            continue
        minutely = aggregate_minutely(day_df)
        if len(minutely) < MIN_SAMPLES + 1:
            continue

        records = compute_regime_series(
            minutely["spot"].tolist(), minutely["ceOI"].tolist(), minutely["peOI"].tolist(),
            minutely["ceLTP"].tolist(), minutely["peLTP"].tolist(),
        )

        for r in records:
            if r["warming_up"]:
                continue
            label_counts[r["label"]] = label_counts.get(r["label"], 0) + 1

        rh, rt, ch, ct = forward_return_hitrate(minutely, records, args.horizon)
        raw_hits_total += rh; raw_total_total += rt
        confirmed_hits_total += ch; confirmed_total_total += ct

        pnl = simulate_first_signal_pnl(day_df, minutely, records, args.short_offset, args.spread_width)
        if pnl:
            pnl["day"] = day
            all_pnl.append(pnl)
            confirmed_signal_days += 1

    con.close()

    print("\n=== Label distribution (all non-warmup minutes, all days) ===")
    total_minutes = sum(label_counts.values())
    for label, count in sorted(label_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {label:16s} {count:>10d}  ({100*count/total_minutes:.1f}%)")

    print(f"\n=== Forward-return hit rate (horizon={args.horizon} min) ===")
    if raw_total_total:
        print(f"  Raw OI_Z sign        : {raw_hits_total}/{raw_total_total} = {100*raw_hits_total/raw_total_total:.1f}%")
    if confirmed_total_total:
        print(f"  Confirmed signal only : {confirmed_hits_total}/{confirmed_total_total} = {100*confirmed_hits_total/confirmed_total_total:.1f}%")
    else:
        print("  No confirmed signals in this range.")

    print(f"\n=== Simulated 1-trade/day credit-spread P&L (short ATM±{args.short_offset}, width {args.spread_width}, held to EOD) ===")
    print(f"  Days with a confirmed signal: {confirmed_signal_days}/{len(days)}")
    if all_pnl:
        pnl_df = pd.DataFrame(all_pnl)
        wins = (pnl_df["pnl_points"] > 0).sum()
        print(f"  Trades simulated: {len(pnl_df)}")
        print(f"  Win rate: {wins}/{len(pnl_df)} = {100*wins/len(pnl_df):.1f}%")
        print(f"  Mean P&L (points): {pnl_df['pnl_points'].mean():.2f}")
        print(f"  Total P&L (points, sum across all days): {pnl_df['pnl_points'].sum():.2f}")
        print(f"  Std dev P&L (points): {pnl_df['pnl_points'].std():.2f}")
        print(f"  Worst day: {pnl_df['pnl_points'].min():.2f}   Best day: {pnl_df['pnl_points'].max():.2f}")
    else:
        print("  No simulated trades (no confirmed signals with valid strike data in range).")


if __name__ == "__main__":
    main()
