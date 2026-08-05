"""
Fetch NIFTY "Trending OI": a table of chain-wide OI/LTP snapshots for a band of strikes
around ATM, bucketed into fixed intervals, each row diffed against the previous bucket.

Stateless by design — every invocation reconstructs the whole session from Dhan's own
retained per-minute history (intraday_minute_data(..., oi=True)) rather than accumulating
state across calls, so it's safe to spawn fresh per API request with no background process.

Usage:
    python trending_oi_fetch.py --expiry nearest --interval 5
    python trending_oi_fetch.py --expiry 2026-08-07 --interval 5 --date 2026-07-30
    python trending_oi_fetch.py --expiry nearest --interval 5 --strikes 24800,24850,24900

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

# Add project root to sys.path
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Every datetime in this script is IST wall-clock, tz-naive. Dhan returns UTC epochs, which
# normalize_intraday_df() converts to this same basis — don't mix in bare datetime.now(),
# which would be server-local and silently shift the whole session window off-market.
IST = ZoneInfo("Asia/Kolkata")

VALID_INTERVALS = ("1", "3", "5", "10", "15")
ATM_BAND_WIDTH = 5  # strikes each side of ATM (11 strikes, ~22 legs)
# Each tracked strike costs 2 paced intraday calls (~0.6s). The API route kills the spawn at 90s,
# so an uncapped selection (the chain carries 200+ strikes) would guarantee a timeout and burn
# the rate limit for nothing. 21 strikes ≈ 42 legs ≈ 25s, which leaves headroom.
MAX_TRACKED_STRIKES = 21
LEG_CALL_PACING_SECONDS = 0.3  # keeps sequential intraday_minute_data calls under Dhan's rate cap
SESSION_OPEN_HOUR, SESSION_OPEN_MINUTE = 9, 15
SESSION_CLOSE_HOUR, SESSION_CLOSE_MINUTE = 15, 30


def now_ist() -> datetime:
    """Current IST wall-clock as a tz-naive datetime."""
    return datetime.now(IST).replace(tzinfo=None)


def clean_val(v, default=0.0):
    """Sanitize floats against NaN/Inf so json.dumps produces valid JSON."""
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


def parse_strikes_param(strikes_param):
    if not strikes_param:
        return []
    res = []
    for s in strikes_param.split(","):
        s = s.strip()
        if s:
            try:
                res.append(float(s))
            except ValueError:
                pass
    return sorted(set(res))


def pick_band_around_spot(strikes, spot):
    if not strikes:
        return []
    nearest_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    lo = max(0, nearest_idx - ATM_BAND_WIDTH)
    hi = min(len(strikes), nearest_idx + ATM_BAND_WIDTH + 1)
    return strikes[lo:hi]


def select_band(all_strikes, spot, custom_strikes):
    """Returns (band, note). The note is non-empty whenever the band the caller gets back is
    not the band they asked for — silently substituting the ATM band would leave the dashboard's
    strike chips claiming a selection the numbers below them were never computed from."""
    if custom_strikes:
        wanted = set(custom_strikes)
        band = [s for s in all_strikes if s in wanted]
        if band:
            missing = [s for s in custom_strikes if s not in set(all_strikes)]
            if missing:
                shown = ", ".join(f"{s:g}" for s in missing[:5])
                more = f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""
                return band, f" {len(missing)} requested strike(s) are not in this expiry's chain and were dropped: {shown}{more}."
            return band, ""
        return (
            pick_band_around_spot(all_strikes, spot),
            " None of the requested strikes exist in this expiry's chain — showing the ATM band instead.",
        )
    return pick_band_around_spot(all_strikes, spot), ""


def cap_to_nearest(strikes, spot, limit):
    """Keep the `limit` strikes closest to spot, still in ascending order."""
    if len(strikes) <= limit:
        return strikes
    nearest = sorted(strikes, key=lambda s: abs(s - spot))[:limit]
    return sorted(nearest)


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
    # "timestamp" (epoch seconds, UTC) is the raw SDK field name — must convert to IST wall-clock
    # before comparing against session-window datetimes, which are IST-naive throughout this script.
    if df["time"].dtype.kind in ("i", "u", "f"):
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    else:
        df["time"] = pd.to_datetime(df["time"])
    return df


def fetch_leg_series(helper, security_id, from_dt, to_dt):
    """One option leg's per-minute (time, oi, close) for [from_dt, to_dt]."""
    df = helper.get_intraday_minute_data(
        security_id=security_id,
        exchange_segment="NSE_FNO",
        instrument_type="OPTIDX",
        interval="1",
        from_date=from_dt.strftime("%Y-%m-%d %H:%M:%S"),
        to_date=to_dt.strftime("%Y-%m-%d %H:%M:%S"),
        oi=True,
    )
    df = normalize_intraday_df(df)
    if df.empty or "oi" not in df.columns:
        return None
    return df


def describe_api_error(err):
    """Render a recorded DhanHelper.last_api_error as a short human sentence, or '' if there is none.
    Data-API methods return empty frames on failure and stash the cause here — without this the
    dashboard reports an auth/subscription outage as 'no data / market may have been closed'."""
    if not err:
        return ""
    code = (err.get("code") or "").strip()
    message = (err.get("message") or "").strip() or "unknown error"
    prefix = f"{code}: " if code else ""
    return f" Dhan data API error — {prefix}{message}."


def fetch_spot_series(helper, day, open_dt, end_dt):
    """
    The index's own per-minute close for the session, as ({minute -> spot}, api_error).
    Serves double duty: the day-high/low break column, and the ATM reference for a past
    session (where today's live LTP would centre the band on the wrong strikes entirely).
    """
    raw = helper.get_intraday_minute_data(
        security_id=13,
        exchange_segment="IDX_I",
        instrument_type="INDEX",
        interval="1",
        from_date=open_dt.strftime("%Y-%m-%d %H:%M:%S"),
        to_date=end_dt.strftime("%Y-%m-%d %H:%M:%S"),
        oi=False,
    )
    api_error = helper.last_api_error
    df = normalize_intraday_df(raw)
    if df.empty or "close" not in df.columns:
        return {}, api_error
    df = df[df["time"].dt.date == day]
    return {
        r["time"].replace(second=0, microsecond=0): clean_val(r.get("close"))
        for _, r in df.iterrows()
    }, api_error


def fetch_band_minute_series(helper, band_legs, day, open_dt, end_dt):
    """
    band_legs: list of (ce_security_id, pe_security_id) tuples for the selected strikes.
    Returns {range, ce_oi, pe_oi, ce_ltp, pe_ltp, legs_ok, legs_failed, api_error} where the
    series are per-minute totals across the range, or None if no leg returned usable OI data.
    `api_error` carries the last recorded DhanHelper data-API failure so the caller can tell an
    outage apart from a genuinely empty session.
    """
    full_range = pd.date_range(open_dt, end_dt, freq="1min")
    ce_oi = pd.Series(0.0, index=full_range)
    pe_oi = pd.Series(0.0, index=full_range)
    ce_ltp = pd.Series(0.0, index=full_range)
    pe_ltp = pd.Series(0.0, index=full_range)

    legs_ok = 0
    legs_failed = 0
    max_leg_time = None
    api_error = None

    for ce_id, pe_id in band_legs:
        for side, sec_id in (("ce", ce_id), ("pe", pe_id)):
            if not sec_id:
                legs_failed += 1
                continue
            leg_df = fetch_leg_series(helper, sec_id, open_dt, end_dt)
            leg_error = helper.last_api_error
            time.sleep(LEG_CALL_PACING_SECONDS)
            if leg_df is None or leg_df.empty:
                legs_failed += 1
                if leg_error:
                    api_error = leg_error
                    # Auth/subscription failures hit every leg identically — grinding through the
                    # remaining ~40 paced calls just delays the same answer past the route timeout.
                    if DhanHelper.is_fatal_error(leg_error):
                        return {
                            "range": pd.date_range(open_dt, open_dt, freq="1min"),
                            "ce_oi": ce_oi, "pe_oi": pe_oi, "ce_ltp": ce_ltp, "pe_ltp": pe_ltp,
                            "legs_ok": 0, "legs_failed": legs_failed, "api_error": api_error,
                        }
                continue
            leg_df = leg_df[leg_df["time"].dt.date == day]
            if leg_df.empty:
                legs_failed += 1
                continue
            legs_ok += 1
            max_t = leg_df["time"].max()
            if max_leg_time is None or max_t > max_leg_time:
                max_leg_time = max_t

            indexed = leg_df.set_index("time")
            # bfill matters as much as ffill: the first tick of the day lands at 09:16, not 09:15,
            # so without it every leg reads 0 for the opening minute. At interval=1 that makes the
            # first bucket the day's OI baseline of zero, and every later row then reports the
            # entire open interest as "change in OI" instead of the actual intraday delta.
            s_oi = indexed["oi"].reindex(full_range).ffill().bfill().fillna(0)
            if "close" in indexed.columns:
                s_ltp = indexed["close"].reindex(full_range).ffill().bfill().fillna(0)
            else:
                s_ltp = pd.Series(0.0, index=full_range)
            if side == "ce":
                ce_oi = ce_oi.add(s_oi, fill_value=0)
                ce_ltp = ce_ltp.add(s_ltp, fill_value=0)
            else:
                pe_oi = pe_oi.add(s_oi, fill_value=0)
                pe_ltp = pe_ltp.add(s_ltp, fill_value=0)

    effective_end = min(end_dt, max_leg_time.to_pydatetime()) if max_leg_time is not None else end_dt
    effective_range = pd.date_range(open_dt, effective_end, freq="1min")

    return {
        "range": effective_range,
        "ce_oi": ce_oi, "pe_oi": pe_oi, "ce_ltp": ce_ltp, "pe_ltp": pe_ltp,
        "legs_ok": legs_ok, "legs_failed": legs_failed, "api_error": api_error,
    }


def bucket_and_diff(series, interval_minutes, open_dt):
    """
    series: list of {time, spot, total_ce_oi, total_pe_oi, total_ce_ltp, total_pe_ltp} (per minute)
    Returns rows, most-recent-first, with all diff/derived columns.
    """
    buckets = {}
    for point in series:
        elapsed_minutes = (point["time"] - open_dt).total_seconds() / 60.0
        bucket_index = max(0, int(elapsed_minutes // interval_minutes))
        bucket_time = open_dt + timedelta(minutes=bucket_index * interval_minutes)
        buckets[bucket_time] = {k: v for k, v in point.items() if k != "time"}
    bucketed = [{"time": t, **buckets[t]} for t in sorted(buckets)]

    rows = []
    running_spot = None
    running_spot_high = None
    running_spot_low = None
    running_diff_high = None
    running_diff_low = None

    open_ce_oi = bucketed[0]["total_ce_oi"] if bucketed else None
    open_pe_oi = bucketed[0]["total_pe_oi"] if bucketed else None

    previous = None

    for snap in bucketed:
        time_ist = snap["time"]
        raw_spot = snap.get("spot")
        if raw_spot is not None and not (isinstance(raw_spot, float) and math.isnan(raw_spot)) and float(raw_spot) > 0:
            running_spot = float(raw_spot)
        spot = running_spot
        total_ce_oi = snap.get("total_ce_oi", 0.0)
        total_pe_oi = snap.get("total_pe_oi", 0.0)
        total_ce_ltp = snap.get("total_ce_ltp", 0.0)
        total_pe_ltp = snap.get("total_pe_ltp", 0.0)

        if previous is None:
            chng_in_call_oi = 0.0 if open_ce_oi is not None else None
            chng_in_put_oi = 0.0 if open_pe_oi is not None else None
            diff_in_oi = 0.0
            direction = "up"
            chng_in_direction = None
            direction_pct = None
            call_ltp_chng = None
            put_ltp_chng = None
            ce_pe_ltp_chng = None
            day_hl_diff_oi = None
            net_pcr = round(total_pe_oi / total_ce_oi, 2) if total_ce_oi > 0 else 1.0
        else:
            if open_ce_oi is not None and open_pe_oi is not None:
                chng_in_call_oi = total_ce_oi - open_ce_oi
                chng_in_put_oi = total_pe_oi - open_pe_oi
            else:
                chng_in_call_oi = total_ce_oi - previous["total_ce_oi"]
                chng_in_put_oi = total_pe_oi - previous["total_pe_oi"]

            diff_in_oi = chng_in_put_oi - chng_in_call_oi

            if chng_in_call_oi:
                net_pcr = round(abs(chng_in_put_oi / chng_in_call_oi), 2)
            elif total_ce_oi > 0:
                net_pcr = round(total_pe_oi / total_ce_oi, 2)
            else:
                net_pcr = 1.0

            prev_diff = previous.get("_diff_in_oi")
            if prev_diff is not None:
                chng_in_direction = diff_in_oi - prev_diff
                direction_pct = round((chng_in_direction / abs(prev_diff)) * 100.0, 2) if prev_diff != 0 else None
            else:
                chng_in_direction = diff_in_oi
                direction_pct = None

            direction = "up" if (chng_in_direction if chng_in_direction is not None else diff_in_oi) >= 0 else "down"

            call_ltp_chng = total_ce_ltp - previous["total_ce_ltp"]
            put_ltp_chng = total_pe_ltp - previous["total_pe_ltp"]
            ce_pe_ltp_chng = call_ltp_chng + put_ltp_chng

            if running_diff_high is not None and diff_in_oi > running_diff_high:
                day_hl_diff_oi = "Day High Break"
            elif running_diff_low is not None and diff_in_oi < running_diff_low:
                day_hl_diff_oi = "Day Low Break"
            else:
                day_hl_diff_oi = None

            if running_diff_high is None or diff_in_oi > running_diff_high:
                running_diff_high = diff_in_oi
            if running_diff_low is None or diff_in_oi < running_diff_low:
                running_diff_low = diff_in_oi

        day_hl_break = None
        if spot is not None and spot > 0:
            if running_spot_high is not None and spot > running_spot_high:
                day_hl_break = f"D.H.B. ({running_spot_high:.1f})"
            elif running_spot_low is not None and spot < running_spot_low:
                day_hl_break = f"D.L.B. ({running_spot_low:.1f})"

            if running_spot_high is None or spot > running_spot_high:
                running_spot_high = spot
            if running_spot_low is None or spot < running_spot_low:
                running_spot_low = spot

        sentiment = "Bullish" if (diff_in_oi >= 0 or net_pcr >= 1.0) else "Bearish"

        rows.append({
            "date": time_ist.strftime("%d-%m-%Y"),
            "time": time_ist.strftime("%H:%M:%S"),
            "spot": spot,
            "day_hl_break": day_hl_break,
            "total_call_oi": total_ce_oi,
            "total_put_oi": total_pe_oi,
            "chng_in_call_oi": chng_in_call_oi,
            "chng_in_put_oi": chng_in_put_oi,
            "diff_in_oi": diff_in_oi,
            "direction_pct": direction_pct,
            "direction": direction,
            "chng_in_direction": chng_in_direction,
            "net_pcr": net_pcr,
            "day_hl_diff_oi": day_hl_diff_oi,
            "sentiment": sentiment,
            "total_call_ltp": total_ce_ltp,
            "call_ltp_chng": call_ltp_chng,
            "ce_pe_ltp_chng": ce_pe_ltp_chng,
            "total_put_ltp": total_pe_ltp,
            "put_ltp_chng": put_ltp_chng,
        })

        snap["_diff_in_oi"] = diff_in_oi
        previous = snap

    rows.reverse()
    return rows


def main():
    parser = argparse.ArgumentParser(description="Fetch NIFTY Trending OI table")
    parser.add_argument("--expiry", default="nearest", help="Expiry date (YYYY-MM-DD) or 'nearest'")
    parser.add_argument("--interval", default="5", choices=VALID_INTERVALS, help="Bucket interval in minutes")
    parser.add_argument("--date", default=None, help="Historical session date (YYYY-MM-DD); omit for live/today")
    parser.add_argument("--strikes", default=None, help="Comma-separated custom strikes to track")

    args = parser.parse_args()
    interval_minutes = int(args.interval)

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
    if not expiries:
        print(json.dumps({"error": "Failed to fetch NIFTY expiry list from Dhan"}))
        sys.exit(0)

    now_dt = now_ist().replace(second=0, microsecond=0)
    today = now_dt.date()
    today_str = today.isoformat()
    future_expiries = [e for e in expiries if e >= today_str]
    nearest_expiry = future_expiries[0] if future_expiries else expiries[0]

    if args.expiry in ("nearest", "", None) or args.expiry not in expiries:
        expiry = nearest_expiry
    else:
        expiry = args.expiry

    # Determine target day + session window
    if args.date:
        try:
            day = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            day = today
    else:
        day = today

    is_live = day >= today
    custom_strikes = parse_strikes_param(args.strikes)

    def bail(note, spot=0.0, strikes=None, selected=None):
        print(json.dumps({
            "expiry": expiry, "interval": str(interval_minutes), "spot": spot,
            "selected_strikes": selected or [], "available_strikes": strikes or [],
            "requested_strikes": custom_strikes, "expiries": expiries, "rows": [],
            "is_live": is_live, "backtrace_status": "unavailable",
            "coverage_note": note,
        }))
        sys.exit(0)

    if is_live:
        day = today
        open_dt = session_open(day)
        end_dt = min(now_dt, session_close(day))
        if now_dt < open_dt:
            bail("Market has not opened yet — the table fills in from 09:15.")
    else:
        open_dt = session_open(day)
        end_dt = session_close(day)

    # The index's own minute series doubles as the ATM reference for a past session.
    spot_by_minute, spot_api_error = fetch_spot_series(helper, day, open_dt, end_dt)
    ordered_minutes = sorted(spot_by_minute)

    # An auth/subscription failure fails every downstream call identically — report the real
    # cause now instead of spending ~25s of paced option calls to arrive at "no data".
    if DhanHelper.is_fatal_error(spot_api_error):
        bail("Could not read NIFTY intraday data." + describe_api_error(spot_api_error))

    # Strike ladder
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
        bail("Failed to fetch the NIFTY option chain — cannot determine strikes.")

    all_strikes = sorted(clean_val(s) for s in chain_df.index.tolist())

    # Reference spot for centring the ATM band. A past session must use *that day's* opening
    # print — today's LTP would centre the band on strikes that weren't near the money then.
    if is_live:
        spot = clean_val(helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX"))
        if spot <= 0 and ordered_minutes:
            spot = spot_by_minute[ordered_minutes[-1]]
    else:
        spot = spot_by_minute[ordered_minutes[0]] if ordered_minutes else 0.0

    if spot <= 0:
        bail(
            "Could not resolve a NIFTY spot price for this session — cannot determine the ATM band."
            + describe_api_error(spot_api_error),
            strikes=all_strikes,
        )

    band, band_note = select_band(all_strikes, spot, custom_strikes)

    if not band:
        bail("No strikes available for this expiry.", spot=spot, strikes=all_strikes)

    # Keep the run inside the API route's spawn timeout — see MAX_TRACKED_STRIKES.
    capped_note = ""
    if len(band) > MAX_TRACKED_STRIKES:
        requested = len(band)
        band = cap_to_nearest(band, spot, MAX_TRACKED_STRIKES)
        capped_note = f" Capped from {requested} to the {len(band)} strikes nearest ATM."

    # Resolve CE/PE security IDs for the band
    band_legs = []
    for strike in band:
        ce = helper.find_option("NIFTY", expiry, strike, "CE")
        pe = helper.find_option("NIFTY", expiry, strike, "PE")
        band_legs.append((
            int(ce["SECURITY_ID"]) if ce else None,
            int(pe["SECURITY_ID"]) if pe else None,
        ))

    if not any(ce or pe for ce, pe in band_legs):
        bail(
            f"No tradable {expiry} contracts found for the selected strikes in the security master.",
            spot=spot, strikes=all_strikes, selected=band,
        )

    band_data = fetch_band_minute_series(helper, band_legs, day, open_dt, end_dt)

    if not band_data["legs_ok"]:
        # Distinguish a real API outage from a genuinely empty session — the two look identical
        # from here (both yield empty frames), but only one is the user's fault to wait out.
        api_error = band_data.get("api_error")
        if api_error:
            reason = describe_api_error(api_error)
        else:
            reason = " — the market may have been closed that day." if not is_live else "."
        bail(
            "Dhan returned no intraday open-interest data (oi=True) for these contracts on "
            f"{day.isoformat()}" + reason,
            spot=spot, strikes=all_strikes, selected=band,
        )

    series = []
    for t in band_data["range"]:
        t_py = t.to_pydatetime()
        series.append({
            "time": t_py,
            "spot": spot_by_minute.get(t_py),
            "total_ce_oi": float(band_data["ce_oi"][t]),
            "total_pe_oi": float(band_data["pe_oi"][t]),
            "total_ce_ltp": float(band_data["ce_ltp"][t]),
            "total_pe_ltp": float(band_data["pe_ltp"][t]),
        })

    rows = bucket_and_diff(series, interval_minutes, open_dt)

    # A leg that silently failed (rate limit, missing contract) contributes nothing to the
    # totals, which quietly understates them — say so rather than presenting a clean number.
    dropped = band_data["legs_failed"]
    dropped_note = ""
    if dropped:
        dropped_note = f" {dropped} of {dropped + band_data['legs_ok']} legs returned no data."
        dropped_note += describe_api_error(band_data.get("api_error"))

    result = {
        "expiry": expiry,
        "interval": str(interval_minutes),
        "spot": spot,
        "selected_strikes": band,
        "available_strikes": all_strikes,
        "requested_strikes": custom_strikes,
        "expiries": expiries,
        "rows": rows,
        "is_live": is_live,
        "backtrace_status": "ok",
        "coverage_note": (
            f"{'Live' if is_live else 'Historical'} session for {day.isoformat()}, "
            f"{len(band)} strike{'' if len(band) == 1 else 's'} "
            f"({band[0]:g}..{band[-1]:g})." + band_note + capped_note + dropped_note
        ),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
