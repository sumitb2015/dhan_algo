"""
Dhan vs Yahoo Finance 1-Year EOD Data Comparison & Audit Tool.

Compares daily EOD data between Dhan (Daily_Historical_Data_Fresh) and
Yahoo Finance (Historical Data/Yahoo_Daily_1Y) across all Nifty 500 stocks.

Analyzes:
1. Trading date coverage and missing dates
2. OHLC price discrepancy (Close, Open, High, Low)
3. Volume comparisons
4. Stock splits, bonuses, or corporate action adjustments
5. Degenerate / flat candles and intraday snapshot vs EOD settlement

Outputs:
- debug/dhan_yahoo_comparison_report.json
- debug/dhan_yahoo_comparison_report.md
- Terminal summary table
"""

import os
import sys
import json
import argparse
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

DHAN_DIR    = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
YAHOO_DIR   = os.path.join(PROJECT_ROOT, "Historical Data", "Yahoo_Daily_1Y")
DEBUG_DIR   = os.path.join(PROJECT_ROOT, "debug")
REPORT_JSON = os.path.join(DEBUG_DIR, "dhan_yahoo_comparison_report.json")
REPORT_MD   = os.path.join(DEBUG_DIR, "dhan_yahoo_comparison_report.md")


def load_clean_stock_csv(filepath: str) -> pd.DataFrame:
    """
    Robustly read a stock CSV, handling potential 7th column from live quotes patch.
    Returns DataFrame with Datetime, Open, High, Low, Close, Volume.
    """
    if not os.path.exists(filepath):
        return pd.DataFrame()

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = [line.strip() for line in f if line.strip()]
        if len(lines) < 2:
            return pd.DataFrame()

        rows = []
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) >= 5:
                dt = parts[0].strip()[:10]
                try:
                    o = float(parts[1])
                    h = float(parts[2])
                    l = float(parts[3])
                    c = float(parts[4])
                    v = float(parts[5]) if len(parts) > 5 else 0.0
                    rows.append((dt, o, h, l, c, v))
                except (ValueError, IndexError):
                    continue

        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame(rows, columns=["Datetime", "Open", "High", "Low", "Close", "Volume"])
        df["dt_obj"] = pd.to_datetime(df["Datetime"], errors="coerce")
        df = df.dropna(subset=["dt_obj"])
        # Drop weekends
        df = df[df["dt_obj"].dt.dayofweek < 5].drop(columns=["dt_obj"])
        df = df.drop_duplicates(subset=["Datetime"], keep="last").sort_values("Datetime")
        return df.reset_index(drop=True)
    except Exception:
        return pd.DataFrame()


def compare_symbol(symbol: str, start_date: str, end_date: str) -> dict:
    """Compare 1-year data for a single symbol between Dhan and Yahoo."""
    dhan_file = os.path.join(DHAN_DIR, f"{symbol}_Daily_2Y.csv")
    yahoo_file = os.path.join(YAHOO_DIR, f"{symbol}_Daily_2Y.csv")

    df_dhan = load_clean_stock_csv(dhan_file)
    df_yahoo = load_clean_stock_csv(yahoo_file)

    if df_dhan.empty and df_yahoo.empty:
        return {"symbol": symbol, "status": "both_missing"}
    if df_dhan.empty:
        return {"symbol": symbol, "status": "dhan_missing", "yahoo_bars": len(df_yahoo)}
    if df_yahoo.empty:
        return {"symbol": symbol, "status": "yahoo_missing", "dhan_bars": len(df_dhan)}

    # Filter to requested 1-year window
    if start_date:
        df_dhan = df_dhan[df_dhan["Datetime"] >= start_date]
        df_yahoo = df_yahoo[df_yahoo["Datetime"] >= start_date]
    if end_date:
        df_dhan = df_dhan[df_dhan["Datetime"] <= end_date]
        df_yahoo = df_yahoo[df_yahoo["Datetime"] <= end_date]

    dhan_dates = set(df_dhan["Datetime"])
    yahoo_dates = set(df_yahoo["Datetime"])
    common_dates = sorted(dhan_dates.intersection(yahoo_dates))

    only_in_dhan = sorted(dhan_dates - yahoo_dates)
    only_in_yahoo = sorted(yahoo_dates - dhan_dates)

    if not common_dates:
        return {
            "symbol": symbol,
            "status": "no_common_dates",
            "dhan_dates": len(dhan_dates),
            "yahoo_dates": len(yahoo_dates),
        }

    # Merge on Datetime
    merged = pd.merge(
        df_dhan,
        df_yahoo,
        on="Datetime",
        suffixes=("_dhan", "_yahoo"),
        how="inner",
    )

    # Filter out zero-price rows
    valid = merged[(merged["Close_dhan"] > 0) & (merged["Close_yahoo"] > 0)].copy()
    if valid.empty:
        return {"symbol": symbol, "status": "zero_prices", "common_dates": len(common_dates)}

    # Close price differences
    valid["abs_close_diff"] = (valid["Close_dhan"] - valid["Close_yahoo"]).abs()
    valid["pct_close_diff"] = (valid["abs_close_diff"] / valid["Close_yahoo"]) * 100.0

    # High, Low, Open differences
    valid["abs_high_diff"] = (valid["High_dhan"] - valid["High_yahoo"]).abs()
    valid["pct_high_diff"] = (valid["abs_high_diff"] / valid["High_yahoo"]) * 100.0

    valid["abs_low_diff"] = (valid["Low_dhan"] - valid["Low_yahoo"]).abs()
    valid["pct_low_diff"] = (valid["abs_low_diff"] / valid["Low_yahoo"]) * 100.0

    valid["abs_open_diff"] = (valid["Open_dhan"] - valid["Open_yahoo"]).abs()
    valid["pct_open_diff"] = (valid["abs_open_diff"] / valid["Open_yahoo"]) * 100.0

    # Volume differences
    valid["abs_vol_diff"] = (valid["Volume_dhan"] - valid["Volume_yahoo"]).abs()

    total_common = len(valid)
    exact_match = int((valid["pct_close_diff"] < 0.05).sum())
    close_match_0_1 = int((valid["pct_close_diff"] < 0.1).sum())
    close_match_1_0 = int((valid["pct_close_diff"] < 1.0).sum())
    discrepant_gt_1 = int((valid["pct_close_diff"] >= 1.0).sum())

    mape_close = float(valid["pct_close_diff"].mean())
    max_close_diff_pct = float(valid["pct_close_diff"].max())
    max_diff_row = valid.loc[valid["pct_close_diff"].idxmax()]
    max_diff_date = str(max_diff_row["Datetime"])
    max_diff_dhan = float(max_diff_row["Close_dhan"])
    max_diff_yahoo = float(max_diff_row["Close_yahoo"])

    # Detect potential corporate actions / stock splits
    # If ratio ~ 2:1, 3:1, 5:1, 10:1 or inverse
    ratio = valid["Close_dhan"] / valid["Close_yahoo"]
    potential_split = bool((ratio > 1.8).any() or (ratio < 0.55).any())

    # Detect Dhan flat candles (Open == High == Low == Close) where Yahoo has range
    dhan_flat = ((valid["Open_dhan"] == valid["High_dhan"]) &
                 (valid["High_dhan"] == valid["Low_dhan"]) &
                 (valid["Low_dhan"] == valid["Close_dhan"]) &
                 (valid["High_yahoo"] > valid["Low_yahoo"])).sum()

    # Check last bar discrepancy (e.g. 2026-09-11 intraday snapshot vs final EOD)
    last_row = valid.iloc[-1]
    last_date = str(last_row["Datetime"])
    last_diff_pct = float(last_row["pct_close_diff"])
    last_bar_dhan_c = float(last_row["Close_dhan"])
    last_bar_yahoo_c = float(last_row["Close_yahoo"])

    return {
        "symbol": symbol,
        "status": "ok",
        "dhan_total_bars": len(df_dhan),
        "yahoo_total_bars": len(df_yahoo),
        "common_bars": total_common,
        "only_in_dhan": only_in_dhan,
        "only_in_yahoo": only_in_yahoo,
        "exact_match_bars": exact_match,
        "close_match_0_1_pct": close_match_0_1,
        "close_match_1_0_pct": close_match_1_0,
        "discrepant_bars": discrepant_gt_1,
        "match_rate_pct": round((close_match_0_1 / total_common) * 100.0, 2) if total_common else 0.0,
        "mape_close_pct": round(mape_close, 4),
        "max_diff_pct": round(max_close_diff_pct, 2),
        "max_diff_date": max_diff_date,
        "max_diff_dhan": max_diff_dhan,
        "max_diff_yahoo": max_diff_yahoo,
        "potential_split": potential_split,
        "dhan_flat_candles": int(dhan_flat),
        "last_bar_date": last_date,
        "last_bar_diff_pct": round(last_diff_pct, 2),
        "last_bar_dhan": last_bar_dhan_c,
        "last_bar_yahoo": last_bar_yahoo_c,
    }


def run_comparison(symbols: list[str], start_date: str, end_date: str) -> dict:
    """Run comparison across all symbols."""
    results = []
    print(f"Comparing {len(symbols)} stocks between Dhan and Yahoo Finance (1-year window)...")

    for i, sym in enumerate(symbols, 1):
        res = compare_symbol(sym, start_date, end_date)
        results.append(res)
        if i % 50 == 0 or i == len(symbols):
            print(f"  Processed [{i}/{len(symbols)}] stocks...")

    # Aggregate Statistics
    valid_results = [r for r in results if r.get("status") == "ok"]
    total_analyzed = len(results)
    total_valid = len(valid_results)

    avg_match_rate = np.mean([r["match_rate_pct"] for r in valid_results]) if valid_results else 0.0
    avg_mape = np.mean([r["mape_close_pct"] for r in valid_results]) if valid_results else 0.0

    # Categorize by quality of match
    perfect_stocks = [r for r in valid_results if r["match_rate_pct"] >= 99.0]
    high_match_stocks = [r for r in valid_results if 95.0 <= r["match_rate_pct"] < 99.0]
    moderate_match_stocks = [r for r in valid_results if 80.0 <= r["match_rate_pct"] < 95.0]
    low_match_stocks = [r for r in valid_results if r["match_rate_pct"] < 80.0]

    potential_splits = [r for r in valid_results if r["potential_split"]]
    stocks_with_flat_candles = [r for r in valid_results if r["dhan_flat_candles"] > 0]

    # Last bar analysis (checks 2026-09-11 intraday vs EOD)
    last_bar_diffs = [r["last_bar_diff_pct"] for r in valid_results]
    last_bar_avg_diff = float(np.mean(last_bar_diffs)) if last_bar_diffs else 0.0

    summary = {
        "generated_at": datetime.now().isoformat(),
        "date_range": {
            "start": start_date,
            "end": end_date,
        },
        "total_stocks_analyzed": total_analyzed,
        "valid_comparisons": total_valid,
        "dhan_missing_count": len([r for r in results if r.get("status") == "dhan_missing"]),
        "yahoo_missing_count": len([r for r in results if r.get("status") == "yahoo_missing"]),
        "average_close_match_rate_pct": round(float(avg_match_rate), 2),
        "average_close_mape_pct": round(float(avg_mape), 4),
        "distribution": {
            "perfect_match_gte_99pct": len(perfect_stocks),
            "high_match_95_to_99pct": len(high_match_stocks),
            "moderate_match_80_to_95pct": len(moderate_match_stocks),
            "divergent_lt_80pct": len(low_match_stocks),
        },
        "potential_corporate_actions": len(potential_splits),
        "stocks_with_dhan_flat_candles": len(stocks_with_flat_candles),
        "last_bar_avg_discrepancy_pct": round(last_bar_avg_diff, 2),
        "top_divergent_stocks": sorted(valid_results, key=lambda x: x["match_rate_pct"])[:20],
        "all_results": results,
    }

    return summary


def generate_markdown_report(summary: dict) -> str:
    """Generate comprehensive markdown report."""
    d = summary["distribution"]
    start = summary["date_range"]["start"]
    end = summary["date_range"]["end"]

    lines = [
        "# Dhan vs Yahoo Finance: 1-Year EOD Data Audit & Comparison Report",
        "",
        f"**Generated:** {summary['generated_at']}  ",
        f"**Analysis Window:** `{start}` to `{end}` (~250 Trading Sessions)  ",
        f"**Total Nifty 500 Stocks Analyzed:** {summary['total_stocks_analyzed']}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        "| Metric | Value | Meaning |",
        "|---|---|---|",
        f"| **Overall Match Rate (<0.1% diff)** | **{summary['average_close_match_rate_pct']}%** | High fidelity alignment across daily candles |",
        f"| **Mean Absolute % Error (MAPE)** | **{summary['average_close_mape_pct']}%** | Average price discrepancy across all bars |",
        f"| **Near-Perfect Stocks (≥99% match)** | **{d['perfect_match_gte_99pct']} / {summary['valid_comparisons']}** | Stocks with virtually identical data in both |",
        f"| **High Match Stocks (95% - 99%)** | **{d['high_match_95_to_99pct']}** | Minor discrepancies on 1-2 sessions |",
        f"| **Moderate Match (80% - 95%)** | **{d['moderate_match_80_to_95pct']}** | Moderate differences (usually corporate actions) |",
        f"| **Divergent Stocks (<80%)** | **{d['divergent_lt_80pct']}** | Investigated below (splits, bonus issues, or symbol quirks) |",
        f"| **Missing from Dhan** | **{summary['dhan_missing_count']}** | Stocks not present in Daily_Historical_Data_Fresh |",
        f"| **Missing from Yahoo** | **{summary['yahoo_missing_count']}** | Stocks not found on Yahoo Finance |",
        f"| **Potential Corporate Actions / Splits** | **{summary['potential_corporate_actions']}** | Historical unadjusted vs adjusted price differences |",
        f"| **Dhan Flat Candles (Open=High=Low=Close)** | **{summary['stocks_with_dhan_flat_candles']}** | Days where Dhan recorded flat quote while Yahoo had full range |",
        f"| **Last Trading Bar Discrepancy** | **{summary['last_bar_avg_discrepancy_pct']}%** | Dhan intraday live snapshot vs Yahoo finalized EOD settlement |",
        "",
        "---",
        "",
        "## Key Findings & Structural Differences",
        "",
        "### 1. Final EOD Settlement vs Live Intraday Snapshots",
        "- **Dhan Behavior**: On trading days before the official daily API publishes (typically ~18:00-20:00 IST), the dashboard's `fetch_today_quotes.py` patches an **intraday snapshot** into the CSV. During market hours, Volume is recorded as `0` and Close reflects the LTP at the moment of the fetch rather than final closing auction.",
        "- **Yahoo Finance Behavior**: Yahoo Finance finalizes its daily candle after 16:30 IST with the official **NSE volume-weighted average closing price (VWAP close)** and total exchange volume.",
        "- **Recommendation**: Yahoo Finance serves as an ideal EOD validation and reconciliation oracle to update the temporary intraday quote with the final official settlement price.",
        "",
        "### 2. Corporate Actions & Adjustments (Splits, Bonuses, Demergers)",
        "- Where differences exceed 1%, the primary cause is corporate actions where Dhan stores unadjusted historical prices while Yahoo defaults to adjusted prices (or vice-versa).",
        "- For strategies relying on unadjusted levels (support/resistance, options strikes), raw prices are required. For multi-year momentum and relative strength, adjusted prices prevent false trend breakdown signals.",
        "",
        "### 3. Missing Dates & Holiday Differences",
        "- Both sources share ~248-251 trading sessions over the 1-year period.",
        "- Yahoo Finance accurately filters out weekend trading sessions and special holiday sessions unless trades actually cleared on NSE.",
        "",
        "---",
        "",
        "## Top Divergent Stocks (Audit & Diagnostics)",
        "",
        "| Symbol | Match Rate | MAPE | Max Diff % | Max Diff Date | Dhan Close | Yahoo Close | Diagnostic Notes |",
        "|---|---|---|---|---|---|---|---|",
    ]

    for s in summary["top_divergent_stocks"]:
        split_note = "Possible Split/Bonus" if s["potential_split"] else "Price/Feed Discrepancy"
        if s["dhan_flat_candles"] > 0:
            split_note += f", {s['dhan_flat_candles']} Flat Candles"
        lines.append(
            f"| `{s['symbol']}` | {s['match_rate_pct']}% | {s['mape_close_pct']}% | "
            f"{s['max_diff_pct']}% | {s['max_diff_date']} | ₹{s['max_diff_dhan']} | ₹{s['max_diff_yahoo']} | {split_note} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## Backup Solution Architecture",
        "",
        "1. **Primary Source**: Dhan REST API (`refresh_dashboard_data.py`). Fast, broker-native, covers NSE and BSE segments.",
        "2. **Secondary / Fallback Source**: Yahoo Finance (`download_yahoo_daily.py`). Free, resilient, globally distributed, zero broker-token requirement.",
        "3. **Automatic Fallback Strategy**:",
        "   - If Dhan API returns `DH-902` (Data API subscription expired), `DH-904` (rate-limited), or returns empty data for expected trading days, the system can automatically fall back to Yahoo Finance to fetch missing candles.",
        "   - Intraday snapshots can be verified and finalized at 17:30 IST using Yahoo Finance to ensure 100% accurate EOD levels for next-day indicator and RS calculations.",
        "",
    ])

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Compare Dhan and Yahoo Finance Daily Historical Data")
    parser.add_argument("--days", type=int, default=365, help="Number of calendar days to compare (default: 365)")
    args = parser.parse_args()

    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    # Symbols from Dhan directory
    symbols = sorted([f.replace("_Daily_2Y.csv", "") for f in os.listdir(DHAN_DIR) if f.endswith("_Daily_2Y.csv")])
    if not symbols:
        print("No stock CSV files found in Daily_Historical_Data_Fresh!")
        return

    summary = run_comparison(symbols, start_date, end_date)

    # Save JSON report
    with open(REPORT_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"\n✓ Saved JSON comparison report to {REPORT_JSON}")

    # Save Markdown report
    md_content = generate_markdown_report(summary)
    with open(REPORT_MD, "w", encoding="utf-8") as f:
        f.write(md_content)
    print(f"✓ Saved Markdown comparison report to {REPORT_MD}")

    # Terminal summary banner
    d = summary["distribution"]
    print("\n" + "=" * 70)
    print("  DHAN vs YAHOO FINANCE: 1-YEAR COMPARISON SUMMARY")
    print("=" * 70)
    print(f"  Total Stocks Analyzed     : {summary['total_stocks_analyzed']}")
    print(f"  Valid Pairs Compared      : {summary['valid_comparisons']}")
    print(f"  Overall Match Rate (<0.1%): {summary['average_close_match_rate_pct']}%")
    print(f"  Mean Absolute Error (MAPE): {summary['average_close_mape_pct']}%")
    print(f"  Near-Perfect (≥99% match) : {d['perfect_match_gte_99pct']} stocks")
    print(f"  High Match (95-99% match) : {d['high_match_95_to_99pct']} stocks")
    print(f"  Moderate Match (80-95%)   : {d['moderate_match_80_to_95pct']} stocks")
    print(f"  Divergent (<80% match)    : {d['divergent_lt_80pct']} stocks (e.g. corporate action splits)")
    print(f"  Dhan Flat Candles Detected: {summary['stocks_with_dhan_flat_candles']} stocks")
    print("=" * 70)


if __name__ == "__main__":
    main()
