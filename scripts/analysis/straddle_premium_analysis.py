#!/usr/bin/env python3
"""
Straddle Premium Analysis
Queries nifty_options.db for ATM CE+PE data, computes opening premium statistics
by weekday and DTE. Produces three regime views:
  - all          : full history
  - pre_sep2025  : before 2025-09-01 (NSE weekly expiry was Thursday)
  - post_sep2025 : from 2025-09-01 onwards (NSE weekly expiry changed to Tuesday)
Writes debug/straddle_premium_analysis.json.
"""

import json
import sqlite3
import sys
from datetime import datetime, date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DB_PATH      = PROJECT_ROOT / "Options Data" / "nifty_options.db"
OUTPUT_PATH  = PROJECT_ROOT / "debug" / "straddle_premium_analysis.json"
STATUS_PATH  = PROJECT_ROOT / "debug" / "straddle_analysis_status.json"

WEEKDAY_NAMES  = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
REGIME_CUTOFF  = date(2025, 9, 1)   # NSE changed Thu->Tue weekly expiry on this date


def write_status(status: str, pct: int, message: str) -> None:
    try:
        STATUS_PATH.write_text(
            json.dumps({"status": status, "pct": pct, "message": message}),
            encoding="utf-8",
        )
    except Exception:
        pass


def npct(arr: np.ndarray, p: float) -> float:
    return float(np.percentile(arr, p)) if len(arr) > 0 else 0.0


def agg_stats(series: pd.Series) -> dict:
    arr = series.dropna().values
    if len(arr) == 0:
        return {"count": 0}
    return {
        "count":  int(len(arr)),
        "avg":    round(float(np.mean(arr)), 2),
        "median": round(float(np.median(arr)), 2),
        "std":    round(float(np.std(arr)), 2),
        "min":    round(float(np.min(arr)), 2),
        "max":    round(float(np.max(arr)), 2),
        "p10":    round(npct(arr, 10), 2),
        "p25":    round(npct(arr, 25), 2),
        "p75":    round(npct(arr, 75), 2),
        "p90":    round(npct(arr, 90), 2),
    }


def compute_regime_stats(daily: pd.DataFrame, merged: pd.DataFrame) -> dict:
    """Return all aggregated statistics for a given (already filtered) daily/merged pair."""
    if len(daily) == 0:
        return {
            "date_range": {"from": "", "to": ""},
            "total_days": 0, "total_expiries": 0,
            "summary": {}, "by_weekday": {}, "by_dte": {},
            "distribution": {}, "decay_dte_curve": [],
            "intraday_decay": {}, "monthly_trend": [],
            "range_analysis": {"by_dte": {}, "by_weekday": {}},
            "insights": ["No data available for this regime."],
        }

    # ── by_weekday ─────────────────────────────────────────────────────────────
    by_weekday: dict = {}
    for day in WEEKDAY_NAMES:
        sub = daily[daily["weekday"] == day]
        if len(sub) == 0:
            continue
        s = agg_stats(sub["open_premium"])
        s["seller_win_pct"] = round(float(sub["seller_win"].mean() * 100), 1)
        s["avg_decay_pct"]  = round(float(sub["decay_pct"].mean()), 1)
        s["avg_range"]      = round(float(sub["day_range"].mean()), 1)
        s["avg_range_pct"]  = round(float(sub["range_pct"].mean()), 1)
        by_weekday[day] = s

    # ── by_dte ─────────────────────────────────────────────────────────────────
    by_dte: dict = {}
    for label in ["0", "1", "2", "3", "4", "5+"]:
        sub = daily[daily["dte"] >= 5] if label == "5+" else daily[daily["dte"] == int(label)]
        if len(sub) == 0:
            continue
        s = agg_stats(sub["open_premium"])
        s["seller_win_pct"] = round(float(sub["seller_win"].mean() * 100), 1)
        s["avg_decay_pct"]  = round(float(sub["decay_pct"].mean()), 1)
        s["avg_range"]      = round(float(sub["day_range"].mean()), 1)
        s["avg_range_pct"]  = round(float(sub["range_pct"].mean()), 1)
        by_dte[label] = s

    # ── distribution ───────────────────────────────────────────────────────────
    premiums = daily["open_premium"].dropna().values
    hist_counts, hist_edges = np.histogram(premiums, bins=25)
    distribution = {
        "bins":     [round(float(e), 1) for e in hist_edges.tolist()],
        "counts":   hist_counts.tolist(),
        "mean":     round(float(np.mean(premiums)), 2),
        "std":      round(float(np.std(premiums)), 2),
        "median":   round(float(np.median(premiums)), 2),
        "skew":     round(float(scipy_stats.skew(premiums)), 3),
        "kurtosis": round(float(scipy_stats.kurtosis(premiums)), 3),
        "min":      round(float(np.min(premiums)), 2),
        "max":      round(float(np.max(premiums)), 2),
        "p10":      round(npct(premiums, 10), 2),
        "p25":      round(npct(premiums, 25), 2),
        "p75":      round(npct(premiums, 75), 2),
        "p90":      round(npct(premiums, 90), 2),
    }

    # ── decay_dte_curve ────────────────────────────────────────────────────────
    decay_dte_curve = []
    for dte_val in range(6):
        sub = daily[daily["dte"] == dte_val]["open_premium"].dropna()
        if len(sub) > 0:
            decay_dte_curve.append({
                "dte": dte_val, "label": str(dte_val),
                "avg": round(float(sub.mean()), 2),
                "p25": round(float(sub.quantile(0.25)), 2),
                "p75": round(float(sub.quantile(0.75)), 2),
                "count": int(len(sub)),
            })
    sub5 = daily[daily["dte"] >= 5]["open_premium"].dropna()
    if len(sub5) > 0:
        decay_dte_curve.insert(0, {
            "dte": "5+", "label": "5+",
            "avg": round(float(sub5.mean()), 2),
            "p25": round(float(sub5.quantile(0.25)), 2),
            "p75": round(float(sub5.quantile(0.75)), 2),
            "count": int(len(sub5)),
        })

    # ── intraday_decay ─────────────────────────────────────────────────────────
    bucket_map = daily[["expiry", "trade_date", "dte"]].copy()
    bucket_map["dte_bucket"] = bucket_map["dte"].apply(
        lambda x: str(x) if x <= 2 else "3+"
    )
    full = merged.merge(
        bucket_map[["expiry", "trade_date", "dte_bucket"]],
        on=["expiry", "trade_date"],
        how="inner",
    )
    intraday_decay: dict = {}
    for bucket in ["0", "1", "2", "3+"]:
        sub = full[(full["dte_bucket"] == bucket) &
                   (full["time_str"] >= "09:15") &
                   (full["time_str"] <= "15:30")]
        if len(sub) == 0:
            continue
        agg_df = (
            sub.groupby("time_str")["straddle_close"]
            .agg(avg="mean",
                 p25=lambda x: x.quantile(0.25),
                 p75=lambda x: x.quantile(0.75))
            .reset_index()
            .sort_values("time_str")
        )
        intraday_decay[bucket] = [
            {"time": row["time_str"],
             "avg":  round(float(row["avg"]), 2),
             "p25":  round(float(row["p25"]), 2),
             "p75":  round(float(row["p75"]), 2)}
            for _, row in agg_df.iterrows()
        ]

    # ── monthly_trend ──────────────────────────────────────────────────────────
    monthly = (
        daily.groupby("month")["open_premium"]
        .agg(avg="mean", count="count")
        .reset_index()
        .sort_values("month")
    )
    monthly_trend = [
        {"month": row["month"], "avg": round(float(row["avg"]), 2), "count": int(row["count"])}
        for _, row in monthly.iterrows()
    ]

    # ── range_analysis ─────────────────────────────────────────────────────────
    range_by_dte: dict = {}
    for label in ["0", "1", "2", "3", "4", "5+"]:
        sub = daily[daily["dte"] >= 5] if label == "5+" else daily[daily["dte"] == int(label)]
        if len(sub) == 0:
            continue
        range_by_dte[label] = {
            "avg_range":      round(float(sub["day_range"].mean()), 2),
            "avg_range_pct":  round(float(sub["range_pct"].mean()), 1),
            "seller_win_pct": round(float(sub["seller_win"].mean() * 100), 1),
        }

    range_by_weekday: dict = {}
    for day in WEEKDAY_NAMES:
        sub = daily[daily["weekday"] == day]
        if len(sub) == 0:
            continue
        range_by_weekday[day] = {
            "avg_range":     round(float(sub["day_range"].mean()), 2),
            "avg_range_pct": round(float(sub["range_pct"].mean()), 1),
        }

    # ── insights ───────────────────────────────────────────────────────────────
    insights = []
    overall_win = round(float(daily["seller_win"].mean() * 100), 1)
    avg_decay   = round(float(daily["decay_pct"].mean()), 1)
    insights.append(
        f"Sellers who shorted at open and covered at close won on {overall_win}% of all trading days."
    )
    if by_dte:
        best_dte = max(by_dte.items(), key=lambda x: x[1].get("seller_win_pct", 0))
        insights.append(
            f"DTE {best_dte[0]} has the highest seller win rate at {best_dte[1]['seller_win_pct']}%"
            f" (avg opening premium Rs.{best_dte[1]['avg']:.0f})."
        )
    if by_weekday:
        best_wd = max(by_weekday.items(), key=lambda x: x[1].get("avg", 0))
        low_wd  = min(by_weekday.items(), key=lambda x: x[1].get("avg", 9999))
        insights.append(
            f"{best_wd[0]} has the highest average opening premium (Rs.{best_wd[1]['avg']:.0f});"
            f" {low_wd[0]} the lowest (Rs.{low_wd[1]['avg']:.0f})."
        )
    if "0" in by_dte and "5+" in by_dte:
        pct_diff = round((1 - by_dte["0"]["avg"] / by_dte["5+"]["avg"]) * 100, 1)
        insights.append(
            f"Opening premium on expiry day (0 DTE) averages Rs.{by_dte['0']['avg']:.0f}"
            f" -- {pct_diff}% lower than 5+ DTE days (Rs.{by_dte['5+']['avg']:.0f})."
        )
    yearly = daily.groupby("year")["open_premium"].mean()
    if len(yearly) > 0:
        best_yr  = int(yearly.idxmax())
        worst_yr = int(yearly.idxmin())
        insights.append(
            f"{best_yr} had the highest average opening premium (Rs.{yearly[best_yr]:.0f});"
            f" {worst_yr} had the lowest (Rs.{yearly[worst_yr]:.0f})."
        )
    insights.append(
        f"On average, {avg_decay}% of the opening premium decays by end of day"
        f" across all DTE and weekdays."
    )

    return {
        "date_range": {
            "from": str(daily["trade_date"].min()),
            "to":   str(daily["trade_date"].max()),
        },
        "total_days":     int(len(daily)),
        "total_expiries": int(daily["expiry"].nunique()),
        "summary": {
            "overall_avg":         round(float(daily["open_premium"].mean()), 2),
            "overall_median":      round(float(daily["open_premium"].median()), 2),
            "overall_min":         round(float(daily["open_premium"].min()), 2),
            "overall_max":         round(float(daily["open_premium"].max()), 2),
            "avg_daily_decay_pct": round(float(daily["decay_pct"].mean()), 1),
            "seller_win_pct":      round(float(daily["seller_win"].mean() * 100), 1),
        },
        "by_weekday":    by_weekday,
        "by_dte":        by_dte,
        "distribution":  distribution,
        "decay_dte_curve": decay_dte_curve,
        "intraday_decay":  intraday_decay,
        "monthly_trend":   monthly_trend,
        "range_analysis": {
            "by_dte":     range_by_dte,
            "by_weekday": range_by_weekday,
        },
        "insights": insights,
    }


def main() -> None:
    write_status("running", 0, "Connecting to database...")

    if not DB_PATH.exists():
        write_status("error", 0, f"Database not found: {DB_PATH}")
        print(f"ERROR: {DB_PATH} not found", file=sys.stderr)
        sys.exit(1)

    # ── Load all ATM rows ──────────────────────────────────────────────────────
    write_status("running", 5, "Loading ATM option data from database...")
    conn = sqlite3.connect(str(DB_PATH))
    df = pd.read_sql(
        """
        SELECT expiry, datetime, option_type, open, high, low, close, spot
        FROM option_prices
        WHERE strike_relative = 'ATM'
        ORDER BY expiry, datetime, option_type
        """,
        conn,
        parse_dates=["datetime"],
    )
    conn.close()
    write_status("running", 30, f"Loaded {len(df):,} rows. Building straddle series...")

    df["expiry_date"] = pd.to_datetime(df["expiry"]).dt.date
    df["trade_date"]  = df["datetime"].dt.date
    df["time_str"]    = df["datetime"].dt.strftime("%H:%M")

    # ── Pivot CE/PE side by side ───────────────────────────────────────────────
    idx = ["expiry", "datetime", "trade_date", "expiry_date", "time_str", "spot"]
    ce = df[df["option_type"] == "CE"].set_index(idx)[["open", "high", "low", "close"]]
    pe = df[df["option_type"] == "PE"].set_index(idx)[["open", "high", "low", "close"]]
    merged = ce.join(pe, lsuffix="_ce", rsuffix="_pe", how="inner").reset_index()

    merged["straddle_close"] = merged["close_ce"] + merged["close_pe"]
    merged["straddle_high"]  = merged["high_ce"]  + merged["high_pe"]
    merged["straddle_low"]   = merged["low_ce"]   + merged["low_pe"]

    write_status("running", 48, "Computing per-day opening and closing premiums...")

    # ── Per-day opening (9:15) ─────────────────────────────────────────────────
    open_rows = merged[merged["time_str"] == "09:15"][
        ["expiry", "trade_date", "expiry_date", "straddle_close"]
    ].rename(columns={"straddle_close": "open_premium"})

    # ── Per-day closing (last candle) ──────────────────────────────────────────
    close_rows = (
        merged.sort_values("datetime")
        .groupby(["expiry", "trade_date"])
        .last()
        .reset_index()[["expiry", "trade_date", "straddle_close"]]
        .rename(columns={"straddle_close": "close_premium"})
    )

    # ── Day high / low ─────────────────────────────────────────────────────────
    extremes = (
        merged.groupby(["expiry", "trade_date"])
        .agg(day_high=("straddle_high", "max"), day_low=("straddle_low", "min"))
        .reset_index()
    )

    daily = (
        open_rows
        .merge(close_rows, on=["expiry", "trade_date"], how="left")
        .merge(extremes,   on=["expiry", "trade_date"], how="left")
    )
    daily = daily[(daily["open_premium"] > 0) & (daily["close_premium"] > 0)].copy()

    # Drop any rows where the trade date falls on a weekend (data quality guard)
    daily["_trade_dow"] = pd.to_datetime(daily["trade_date"]).dt.weekday
    daily = daily[daily["_trade_dow"] < 5].drop(columns=["_trade_dow"])

    # ── Derived columns ────────────────────────────────────────────────────────
    daily["expiry_date"]   = pd.to_datetime(daily["expiry_date"])
    daily["trade_date_dt"] = pd.to_datetime(daily["trade_date"])
    # Use business-day DTE so weekends don't create gaps (e.g. Tue expiry: Fri=2 DTE not 4)
    daily["dte"] = [
        int(np.busday_count(str(td), str(ex)))
        for td, ex in zip(daily["trade_date"], daily["expiry_date"].dt.date)
    ]
    daily["dte_label"]     = daily["dte"].apply(lambda x: str(x) if x < 5 else "5+")
    daily["weekday"]       = daily["trade_date_dt"].dt.weekday.map(
                                 {i: n for i, n in enumerate(WEEKDAY_NAMES)}
                             )
    daily["decay_pct"]     = (daily["open_premium"] - daily["close_premium"]) / daily["open_premium"] * 100
    daily["seller_win"]    = (daily["close_premium"] < daily["open_premium"]).astype(int)
    daily["day_range"]     = daily["day_high"] - daily["day_low"]
    daily["range_pct"]     = daily["day_range"] / daily["open_premium"] * 100
    daily["month"]         = daily["trade_date_dt"].dt.to_period("M").astype(str)
    daily["year"]          = daily["trade_date_dt"].dt.year

    write_status("running", 58, "Splitting into regimes (pre/post Sep 2025)...")

    daily_pre  = daily[daily["trade_date"] < REGIME_CUTOFF].copy()
    daily_post = daily[daily["trade_date"] >= REGIME_CUTOFF].copy()
    merged_pre  = merged[merged["trade_date"] < REGIME_CUTOFF].copy()
    merged_post = merged[merged["trade_date"] >= REGIME_CUTOFF].copy()

    write_status("running", 62, "Aggregating: full history...")
    regime_all = compute_regime_stats(daily, merged)

    write_status("running", 76, "Aggregating: pre-Sep 2025 (Thursday expiry)...")
    regime_pre = compute_regime_stats(daily_pre, merged_pre)

    write_status("running", 90, "Aggregating: post-Sep 2025 (Tuesday expiry)...")
    regime_post = compute_regime_stats(daily_post, merged_post)

    # ── Write output ───────────────────────────────────────────────────────────
    output = {
        "generated_at":  datetime.now().isoformat(),
        "regime_cutoff": str(REGIME_CUTOFF),
        "regimes": {
            "all":          regime_all,
            "pre_sep2025":  regime_pre,
            "post_sep2025": regime_post,
        },
    }

    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
    write_status("done", 100, f"Analysis complete. {len(daily):,} trading days processed.")
    print(f"Done. {len(daily):,} days -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
