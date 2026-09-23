"""
Fetch the NIFTY "Time-Based Comparison" table: Spot/Fut/PCR/Max Pain/ATM/VIX/OI-change/
highest-OI-strike/straddle-delta/bias, bucketed into fixed intervals across the session.

Stateless by design, same pattern as trending_oi_fetch.py — every invocation reconstructs
the whole session from Dhan's own retained per-minute history
(intraday_minute_data(..., oi=True)) rather than accumulating state via a background
collector, so it works identically whether the market is open right now or has been
closed for hours: Dhan keeps that day's per-minute OI/LTP for each contract regardless of
when you ask for it. There is still no way to reconstruct a day *before* today's once its
contracts are no longer the active/near expiry (separate, unrelated to this script) — see
dhan-expired-options-data for that.

Usage:
    python nifty_time_analysis_fetch.py --interval 15
    python nifty_time_analysis_fetch.py --interval 5 --date 2026-09-22

Outputs a single JSON line to stdout. Logs go to stderr.
"""

import sys
import os
import json
import argparse
import time
import math
from datetime import datetime, timedelta, date as date_cls
from zoneinfo import ZoneInfo
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = ZoneInfo("Asia/Kolkata")

VALID_INTERVALS = ("1", "3", "5", "15", "30")
ATM_BAND_WIDTH = 10  # strikes each side of ATM (21 strikes) — matches trending_oi_fetch.py
MAX_TRACKED_STRIKES = 21
LEG_CALL_PACING_SECONDS = 0.3
VIX_SECURITY_ID = 21   # India VIX, NSE_IDX/IDX_I segment (docs/API_GOTCHAS.md)
SESSION_OPEN_HOUR, SESSION_OPEN_MINUTE = 9, 15
SESSION_CLOSE_HOUR, SESSION_CLOSE_MINUTE = 15, 30
# NSE options' reported OI keeps updating for a few minutes past the 15:30 bell as the
# exchange finalizes end-of-day settlement — see the fetch_end_dt comment in main().
SETTLEMENT_BUFFER_MIN = 15

VOL_BIAS_FLAT_POINTS = 3.0
WEAK_BEARISH_POINTS = 8.0


def now_ist() -> datetime:
    return datetime.now(IST).replace(tzinfo=None)


def clean_val(v, default=0.0):
    try:
        val = float(v)
        if math.isnan(val) or math.isinf(val):
            return default
        return val
    except Exception:
        return default


def session_open(day: date_cls) -> datetime:
    return datetime(day.year, day.month, day.day, SESSION_OPEN_HOUR, SESSION_OPEN_MINUTE)


def session_close(day: date_cls) -> datetime:
    return datetime(day.year, day.month, day.day, SESSION_CLOSE_HOUR, SESSION_CLOSE_MINUTE)


def normalize_intraday_df(df):
    """Normalize the SDK's intraday DataFrame column names to time/close/oi."""
    if df.empty:
        return df
    rename_map = {
        "start_time": "time", "start_Time": "time", "kline_time": "time", "timestamp": "time",
        "close": "close", "Close": "close",
        "oi": "oi", "OI": "oi", "open_interest": "oi", "openInterest": "oi",
    }
    df = df.rename(columns=rename_map)
    if "time" not in df.columns:
        return df.iloc[0:0]
    if df["time"].dtype.kind in ("i", "u", "f"):
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    else:
        df["time"] = pd.to_datetime(df["time"])
    return df


def describe_api_error(err):
    if not err:
        return ""
    code = (err.get("code") or "").strip()
    message = (err.get("message") or "").strip() or "unknown error"
    prefix = f"{code}: " if code else ""
    return f" Dhan data API error — {prefix}{message}."


def master_option_frame(helper, expiry):
    df = helper._load_master_list()
    if df is None or df.empty:
        return pd.DataFrame()
    mask = (
        (df["EXCH_ID"] == "NSE")
        & (df["INSTRUMENT"] == "OPTIDX")
        & (df["UNDERLYING_SYMBOL"] == "NIFTY")
        & (df["SM_EXPIRY_DATE"].astype(str) == expiry)
    )
    return df[mask]


def strikes_from_master(frame):
    if frame.empty or "STRIKE_PRICE" not in frame.columns:
        return []
    by_type = frame.groupby("STRIKE_PRICE")["OPTION_TYPE"].agg(set)
    return sorted(
        clean_val(strike) for strike, types in by_type.items() if {"CE", "PE"}.issubset(types)
    )


def legs_from_master(frame, band):
    lookup = {}
    for _, row in frame.iterrows():
        try:
            key = (clean_val(row["STRIKE_PRICE"]), str(row["OPTION_TYPE"]).upper())
            lookup[key] = int(row["SECURITY_ID"])
        except (TypeError, ValueError):
            continue
    return [(lookup.get((s, "CE")), lookup.get((s, "PE"))) for s in band]


def pick_band_around_spot(strikes, spot):
    if not strikes:
        return []
    nearest_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    lo = max(0, nearest_idx - ATM_BAND_WIDTH)
    hi = min(len(strikes), nearest_idx + ATM_BAND_WIDTH + 1)
    return strikes[lo:hi]


def cap_to_nearest(strikes, spot, limit):
    if len(strikes) <= limit:
        return strikes
    nearest = sorted(strikes, key=lambda s: abs(s - spot))[:limit]
    return sorted(nearest)


def fetch_index_series(helper, security_id, segment, instrument, day, open_dt, end_dt):
    """One index's per-minute close for the session, as ({minute -> value}, api_error).
    Shared for NIFTY spot and India VIX — neither carries OI."""
    raw = helper.get_intraday_minute_data(
        security_id=security_id, exchange_segment=segment, instrument_type=instrument,
        interval="1", from_date=open_dt.strftime("%Y-%m-%d %H:%M:%S"),
        to_date=end_dt.strftime("%Y-%m-%d %H:%M:%S"), oi=False,
    )
    api_error = helper.last_api_error
    df = normalize_intraday_df(raw)
    if df.empty or "close" not in df.columns:
        return {}, api_error
    df = df[df["time"].dt.date == day]
    return {
        r["time"].replace(second=0, microsecond=0): clean_val(r.get("close")) for _, r in df.iterrows()
    }, api_error


def fetch_leg_series(helper, security_id, segment, instrument, from_dt, to_dt, with_oi=True):
    df = helper.get_intraday_minute_data(
        security_id=security_id, exchange_segment=segment, instrument_type=instrument,
        interval="1", from_date=from_dt.strftime("%Y-%m-%d %H:%M:%S"),
        to_date=to_dt.strftime("%Y-%m-%d %H:%M:%S"), oi=with_oi,
    )
    df = normalize_intraday_df(df)
    if df.empty:
        return None
    return df


def reindex_series(leg_df, day, full_range, want_oi):
    """A leg's raw per-minute df -> a (oi_series, ltp_series) pair reindexed onto
    `full_range`, forward/back-filled. bfill matters as much as ffill: the first tick of
    the day lands at 09:16, not 09:15 — without it the opening minute reads 0, which then
    makes the first bucket's OI baseline zero and every later row report the entire day's
    OI as its own "change" instead of the real intraday delta."""
    if leg_df is None or leg_df.empty:
        return None, None
    leg_df = leg_df[leg_df["time"].dt.date == day]
    if leg_df.empty:
        return None, None
    indexed = leg_df.set_index("time")
    oi_s = None
    if want_oi and "oi" in indexed.columns:
        oi_s = indexed["oi"].reindex(full_range).ffill().bfill().fillna(0)
    ltp_s = indexed["close"].reindex(full_range).ffill().bfill().fillna(0) if "close" in indexed.columns else None

    # `indexed` may extend past full_range's last slot when the caller fetched a
    # settlement buffer beyond the nominal session close (see SETTLEMENT_BUFFER_MIN).
    # Exchange OI keeps updating for a few minutes after 15:30 as the day's trades
    # settle, so the value literally timestamped 15:30:00 is routinely NOT the day's
    # final OI — back-fill the last bucket with the true latest available reading
    # instead, or every "final" row would show a mid-settlement number that silently
    # disagrees with every other OI source in this dashboard (all of which read the
    # settled figure).
    if len(indexed.index) and indexed.index.max() > full_range[-1]:
        if oi_s is not None:
            oi_s.iloc[-1] = indexed["oi"].iloc[-1]
        if ltp_s is not None and "close" in indexed.columns:
            ltp_s.iloc[-1] = indexed["close"].iloc[-1]

    return oi_s, ltp_s


def compute_max_pain(strikes, ce_oi_at_t, pe_oi_at_t):
    """Brute-force scan over the tracked band — payout = sum ce_oi*max(0,K-s) +
    pe_oi*max(0,s-K), minimized over K. O(n^2) at n<=21, cheap even across hundreds of
    buckets.

    Returns 0.0 when the whole band's OI is zero at this bucket — same "no data" sentinel
    highest_oi_strike() already uses — rather than every candidate strike tying at a
    payout of 0.0 and the scan confidently reporting the lowest strike as a real answer."""
    if not strikes:
        return 0.0
    if sum(ce_oi_at_t.values()) + sum(pe_oi_at_t.values()) <= 0:
        return 0.0
    best_strike, best_payout = strikes[0], None
    for k in strikes:
        payout = 0.0
        for s in strikes:
            payout += ce_oi_at_t.get(s, 0.0) * max(0.0, k - s) + pe_oi_at_t.get(s, 0.0) * max(0.0, s - k)
        if best_payout is None or payout < best_payout:
            best_payout, best_strike = payout, k
    return best_strike


def highest_oi_strike(oi_at_t):
    best_strike, best_oi = 0.0, -1.0
    for s, oi in oi_at_t.items():
        if oi > 0 and oi > best_oi:
            best_oi, best_strike = oi, s
    return best_strike, (best_oi if best_oi > 0 else 0.0)


def classify_vol_bias(spot_diff, has_prev):
    if not has_prev:
        return "#N/A"
    if spot_diff > VOL_BIAS_FLAT_POINTS:
        return "Bullish"
    if spot_diff < -VOL_BIAS_FLAT_POINTS:
        return "Bearish"
    return "Follow OI bias"


def classify_bias(spot_diff, fut_oi_chg_pct, has_prev):
    if not has_prev or fut_oi_chg_pct is None:
        return "#N/A"
    if fut_oi_chg_pct > 0 and spot_diff >= 0:
        return "Long Build-up"
    if fut_oi_chg_pct > 0 and spot_diff < 0:
        return "Short Build-up"
    if fut_oi_chg_pct < 0 and spot_diff >= 0:
        return "Short Covering"
    if fut_oi_chg_pct < 0 and spot_diff < 0:
        return "Long Unwinding (Weak Bearish)" if abs(spot_diff) < WEAK_BEARISH_POINTS else "Long Unwinding"
    return "Neutral"


def main():
    parser = argparse.ArgumentParser(description="Fetch NIFTY time-based comparison table")
    parser.add_argument("--interval", default="15", choices=VALID_INTERVALS)
    parser.add_argument("--date", default=None, help="Historical session date (YYYY-MM-DD); omit for today")
    args = parser.parse_args()
    interval_minutes = int(args.interval)

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        sys.exit(0)
    helper = DhanHelper(dhan)

    now_dt = now_ist().replace(second=0, microsecond=0)
    today = now_dt.date()

    if args.date:
        try:
            day = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            day = today
    else:
        day = today
    is_live = day >= today

    def bail(note):
        print(json.dumps({
            "date": day.isoformat(), "interval": str(interval_minutes), "nearest_expiry": None,
            "rows": [], "is_live": is_live, "backtrace_status": "unavailable", "coverage_note": note,
        }))
        sys.exit(0)

    if is_live:
        day = today
        open_dt = session_open(day)
        end_dt = min(now_dt, session_close(day))
        if now_dt < open_dt:
            bail("Market has not opened yet — the table fills in from 09:15.")
        # NSE OI keeps updating for several minutes after the 15:30 bell as the exchange
        # finalizes the day's settlement — a contract's OI print at exactly 15:30:00 is
        # routinely NOT its final value (e.g. one 2026-09-29 NIFTY PE was still ~12% off its
        # eventual settled OI at 15:30, only stabilizing by ~15:39). Fetch a bit past the
        # bell once we're clearly past it, so the "15:30" bucket can be back-filled with the
        # true settled reading instead of a mid-update one — see reindex_series().
        fetch_end_dt = min(now_dt, session_close(day) + timedelta(minutes=SETTLEMENT_BUFFER_MIN)) if now_dt >= session_close(day) else end_dt
    else:
        open_dt = session_open(day)
        end_dt = session_close(day)
        fetch_end_dt = session_close(day) + timedelta(minutes=SETTLEMENT_BUFFER_MIN)

    full_range = pd.date_range(open_dt, end_dt, freq="1min")

    # Spot + VIX — both plain index series, no OI, no settlement lag; fetch only through the
    # real session close so `ref_spot`/ATM-band centring aren't nudged by post-close ticks.
    spot_by_minute, spot_api_error = fetch_index_series(helper, 13, "IDX_I", "INDEX", day, open_dt, end_dt)
    if DhanHelper.is_fatal_error(spot_api_error):
        bail("Could not read NIFTY intraday data." + describe_api_error(spot_api_error))
    if not spot_by_minute:
        bail("No NIFTY intraday data for this session yet." + describe_api_error(spot_api_error))
    ordered_minutes = sorted(spot_by_minute)
    spot_series = pd.Series(spot_by_minute).reindex(full_range).ffill().bfill()

    vix_by_minute, _ = fetch_index_series(helper, VIX_SECURITY_ID, "IDX_I", "INDEX", day, open_dt, end_dt)
    vix_series = pd.Series(vix_by_minute).reindex(full_range).ffill().bfill().fillna(0) if vix_by_minute else pd.Series(0.0, index=full_range)

    # Reference spot for expiry/ATM band centring.
    ref_spot = spot_by_minute[ordered_minutes[0]] if not is_live else spot_by_minute[ordered_minutes[-1]]

    expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
    if not expiries:
        bail("Failed to fetch NIFTY expiry list from Dhan.")
    today_str = today.isoformat()
    future_expiries = [e for e in expiries if e >= today_str]
    expiry = future_expiries[0] if future_expiries else expiries[0]

    expiry_frame = master_option_frame(helper, expiry)
    all_strikes = strikes_from_master(expiry_frame)
    if not all_strikes:
        chain_df = pd.DataFrame()
        for backoff in (0, 3.5):
            if backoff:
                time.sleep(backoff)
            try:
                chain_df = helper.get_option_chain_df("NIFTY", expiry)
                if not chain_df.empty:
                    break
            except Exception:
                pass
        if chain_df.empty:
            bail(f"No {expiry} NIFTY contracts found — cannot determine strikes.")
        all_strikes = sorted(clean_val(s) for s in chain_df.index.tolist())

    band = pick_band_around_spot(all_strikes, ref_spot)
    capped_note = ""
    if len(band) > MAX_TRACKED_STRIKES:
        requested = len(band)
        band = cap_to_nearest(band, ref_spot, MAX_TRACKED_STRIKES)
        capped_note = f" Capped from {requested} to the {len(band)} strikes nearest ATM."
    if not band:
        bail("No strikes available for this expiry.")

    if not expiry_frame.empty:
        band_legs = legs_from_master(expiry_frame, band)
    else:
        band_legs = []
        for strike in band:
            ce = helper.find_option("NIFTY", expiry, strike, "CE")
            pe = helper.find_option("NIFTY", expiry, strike, "PE")
            band_legs.append((int(ce["SECURITY_ID"]) if ce else None, int(pe["SECURITY_ID"]) if pe else None))

    # Per-strike matrices — kept separate (not summed) since Max Pain and highest-OI-strike
    # need each strike's own OI, unlike trending_oi_fetch's aggregate totals.
    ce_oi = {}
    pe_oi = {}
    ce_ltp = {}
    pe_ltp = {}
    legs_ok = 0
    legs_failed = 0
    api_error = None

    for strike, (ce_id, pe_id) in zip(band, band_legs):
        for side, sec_id, store_oi, store_ltp in (
            ("ce", ce_id, ce_oi, ce_ltp), ("pe", pe_id, pe_oi, pe_ltp),
        ):
            if not sec_id:
                legs_failed += 1
                continue
            leg_df = fetch_leg_series(helper, sec_id, "NSE_FNO", "OPTIDX", open_dt, fetch_end_dt, with_oi=True)
            leg_error = helper.last_api_error
            time.sleep(LEG_CALL_PACING_SECONDS)
            oi_s, ltp_s = reindex_series(leg_df, day, full_range, want_oi=True)
            if oi_s is None:
                legs_failed += 1
                if leg_error:
                    api_error = leg_error
                    if DhanHelper.is_fatal_error(leg_error):
                        bail("Could not read NIFTY option intraday data." + describe_api_error(leg_error))
                continue
            legs_ok += 1
            store_oi[strike] = oi_s
            store_ltp[strike] = ltp_s if ltp_s is not None else pd.Series(0.0, index=full_range)

    if not legs_ok:
        reason = describe_api_error(api_error) or (" — the market may have been closed that day." if not is_live else ".")
        bail(f"Dhan returned no intraday open-interest data (oi=True) for these contracts on {day.isoformat()}{reason}")

    # Futures — single leg, own OI series.
    fut_rec = helper.find_future("NIFTY", exchange="NSE", instrument="FUTIDX")
    fut_oi_series, fut_ltp_series, fut_oi_ok, fut_ltp_ok = None, None, False, False
    if fut_rec:
        fut_sid = int(fut_rec["SECURITY_ID"])
        fut_leg_df = fetch_leg_series(helper, fut_sid, "NSE_FNO", "FUTIDX", open_dt, fetch_end_dt, with_oi=True)
        fut_oi_series, fut_ltp_series = reindex_series(fut_leg_df, day, full_range, want_oi=True)
        fut_oi_ok = fut_oi_series is not None
        fut_ltp_ok = fut_ltp_series is not None
    # Falling back to spot keeps Fut/Fut-Spot Diff numeric rather than blank, but that fallback
    # must never look like a real reading — Fut-Spot Diff would silently read 0.00 all session
    # with nothing anywhere saying it's fabricated, so the caller is told via fut_ltp_ok and must
    # surface it in coverage_note.
    if fut_ltp_series is None:
        fut_ltp_series = spot_series
    if fut_oi_series is None:
        fut_oi_series = pd.Series(0.0, index=full_range)

    dropped = legs_failed
    dropped_note = f" {dropped} of {dropped + legs_ok} option legs returned no data." if dropped else ""
    fut_note = "" if fut_ltp_ok else " Futures data unavailable — Nifty Fut/Fut-Spot Diff fall back to Spot (diff reads as 0.00, not a real reading)."

    # ── Bucket into `interval_minutes` and compute derived columns ──────────────────
    rows = []
    prev = None
    running_sum_spot = 0.0
    running_count = 0

    # Bucket boundaries: last-observed-minute-in-bucket, same as trending_oi_fetch.py —
    # a dict keyed by bucket start, overwritten on every minute in ascending order, ends
    # up holding each bucket's LAST minute.
    bucket_last_minute = {}
    for t in full_range:
        elapsed = (t.to_pydatetime() - open_dt).total_seconds() / 60.0
        bucket_index = max(0, int(elapsed // interval_minutes))
        bucket_time = open_dt + timedelta(minutes=bucket_index * interval_minutes)
        bucket_last_minute[bucket_time] = t

    for bucket_time in sorted(bucket_last_minute):
        t = bucket_last_minute[bucket_time]

        spot = clean_val(spot_series.get(t))
        fut = clean_val(fut_ltp_series.get(t))
        vix = clean_val(vix_series.get(t))
        fut_oi_t = clean_val(fut_oi_series.get(t)) if fut_oi_ok else None

        ce_oi_at_t = {s: clean_val(series.get(t)) for s, series in ce_oi.items()}
        pe_oi_at_t = {s: clean_val(series.get(t)) for s, series in pe_oi.items()}

        total_ce_oi = sum(ce_oi_at_t.values())
        total_pe_oi = sum(pe_oi_at_t.values())
        pcr = round(total_pe_oi / total_ce_oi, 3) if total_ce_oi > 0 else 0.0

        max_pain = compute_max_pain(band, ce_oi_at_t, pe_oi_at_t)
        put_strike, put_oi = highest_oi_strike(pe_oi_at_t)
        call_strike, call_oi = highest_oi_strike(ce_oi_at_t)

        atm = min(band, key=lambda s: abs(s - spot)) if spot > 0 else band[len(band) // 2]
        atm_ce_ltp = clean_val(ce_ltp.get(atm, pd.Series()).get(t)) if atm in ce_ltp else 0.0
        atm_pe_ltp = clean_val(pe_ltp.get(atm, pd.Series()).get(t)) if atm in pe_ltp else 0.0
        straddle_premium = atm_ce_ltp + atm_pe_ltp

        running_sum_spot += spot
        running_count += 1
        avg_price = round(running_sum_spot / running_count, 2) if running_count else spot

        has_prev = prev is not None
        spot_diff = (spot - prev["spot"]) if has_prev else 0.0

        if has_prev and fut_oi_ok and prev.get("fut_oi_ok") and prev["fut_oi_t"]:
            fut_oi_chg_pct = round(((fut_oi_t - prev["fut_oi_t"]) / prev["fut_oi_t"]) * 100, 2)
        else:
            fut_oi_chg_pct = None

        straddle_delta = round(straddle_premium - prev["straddle_premium"], 2) if has_prev else None

        def dir_of(cur, prevv):
            if prevv is None:
                return 0
            return 1 if cur > prevv else (-1 if cur < prevv else 0)

        row = {
            "time": bucket_time.strftime("%H:%M"),
            "spot": round(spot, 2), "spot_dir": dir_of(spot, prev["spot"] if has_prev else None),
            "fut": round(fut, 2), "fut_dir": dir_of(fut, prev["fut"] if has_prev else None),
            "fut_spot_diff": round(fut - spot, 2),
            "fut_spot_diff_dir": dir_of(fut - spot, (prev["fut"] - prev["spot"]) if has_prev else None),
            "avg_price": avg_price, "avg_price_dir": dir_of(avg_price, prev["avg_price"] if has_prev else None),
            "max_pain": max_pain, "max_pain_dir": dir_of(max_pain, prev["max_pain"] if has_prev else None),
            "pcr": pcr,
            "atm": atm, "atm_dir": dir_of(atm, prev["atm"] if has_prev else None),
            "vix": round(vix, 2), "vix_dir": dir_of(vix, prev["vix"] if has_prev else None),
            "fut_oi_chg_pct": fut_oi_chg_pct,
            "highest_put_oi_strike": put_strike, "highest_put_oi_lakhs": round(put_oi / 100000, 1),
            "highest_call_oi_strike": call_strike, "highest_call_oi_lakhs": round(call_oi / 100000, 1),
            "straddle_delta": straddle_delta,
            "vol_bias": classify_vol_bias(spot_diff, has_prev),
            "bias": classify_bias(spot_diff, fut_oi_chg_pct, has_prev),
        }
        rows.append(row)

        prev = {
            "spot": spot, "fut": fut, "avg_price": avg_price, "max_pain": max_pain, "atm": atm,
            "vix": vix, "fut_oi_t": fut_oi_t, "fut_oi_ok": fut_oi_ok, "straddle_premium": straddle_premium,
        }

    rows.reverse()  # most-recent-first, matching trending_oi_fetch.py / the original page

    result = {
        "date": day.isoformat(),
        "interval": str(interval_minutes),
        "nearest_expiry": expiry,
        "rows": rows,
        "is_live": is_live,
        "legs_ok": legs_ok,
        "legs_failed": legs_failed,
        "backtrace_status": "ok",
        "coverage_note": (
            f"{'Live' if is_live else 'Historical'} session for {day.isoformat()}, "
            f"{len(band)} strike{'' if len(band) == 1 else 's'} ({band[0]:g}..{band[-1]:g})."
            + capped_note + dropped_note + fut_note
        ),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
