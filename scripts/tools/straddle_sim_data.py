"""
Data for the Straddle Simulator page: replay NIFTY straddles from the local expired-options store.

Usage:
    python straddle_sim_data.py --mode expiries [--limit 40]
    python straddle_sim_data.py --mode load --expiry 2026-09-22 --from 2026-09-21 --to 2026-09-22 [--atm auto|23000]

Prints ONE JSON line to stdout ({"error": "..."} on failure). Read-only: the DB is opened with mode=ro, no broker call is made.

Store limits (see dhan-expired-options-data): NIFTY only, strikes ATM±10 relative (50-pt step), about 6 sessions per expiry, per-minute
volume. Absolute strikes ATM-200 / ATM / ATM+200 are served for as long as spot stays inside that window; `coverage` reports the bars
found per strike so a thin strike is visible instead of silent.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(ROOT, "Options Data", "nifty_options.db")
_IST = timezone(timedelta(hours=5, minutes=30))
OFFSETS = (-200, 0, 200)
STRIKE_STEP = 50


def _epoch(dt_text: str) -> int:
    """'YYYY-MM-DD HH:MM:SS' (naive IST in the store) -> epoch seconds."""
    return int(datetime.fromisoformat(dt_text).replace(tzinfo=_IST).timestamp())


def _connect(path: str = DB_PATH) -> sqlite3.Connection:
    if not os.path.exists(path):
        raise FileNotFoundError(f"options store not found: {path} (it is gitignored; build it with scripts/analysis/convert_options_to_sqlite.py)")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def list_expiries(conn: sqlite3.Connection, limit: int = 40) -> list:
    """Newest first. Walks the expiry index with MAX(expiry) < previous: a GROUP BY over the 22M-row table would scan all of it."""
    out = []
    cur = conn.execute("SELECT MAX(expiry) FROM option_prices").fetchone()[0]
    while cur is not None and len(out) < limit:
        first, last = conn.execute("SELECT MIN(datetime), MAX(datetime) FROM option_prices WHERE expiry = ?", (cur,)).fetchone()
        out.append({"expiry": cur, "first": first[:10], "last": last[:10]})
        cur = conn.execute("SELECT MAX(expiry) FROM option_prices WHERE expiry < ?", (cur,)).fetchone()[0]
    return out


def _sessions(conn: sqlite3.Connection, expiry: str) -> list:
    rows = conn.execute(
        "SELECT DISTINCT substr(datetime, 1, 10) FROM option_prices WHERE expiry = ? AND option_type = 'CE' AND strike_relative = 'ATM' ORDER BY 1",
        (expiry,),
    ).fetchall()
    return [r[0] for r in rows]


def build_payload(conn: sqlite3.Connection, expiry: str, date_from: str, date_to: str, atm) -> dict:
    sessions = _sessions(conn, expiry)
    if not sessions:
        raise ValueError(f"no data for expiry {expiry}")
    replay = [s for s in sessions if date_from <= s <= date_to]
    if not replay:
        raise ValueError(f"no sessions between {date_from} and {date_to} for expiry {expiry} (data runs {sessions[0]} to {sessions[-1]})")
    before = [s for s in sessions if s < replay[0]]
    preload = before[-1] if before else None
    first_day = preload or replay[0]

    if atm == "auto":
        row = conn.execute(
            "SELECT strike FROM option_prices WHERE expiry = ? AND option_type = 'CE' AND strike_relative = 'ATM' AND datetime >= ? ORDER BY datetime LIMIT 1",
            (expiry, f"{replay[0]} 00:00:00"),
        ).fetchone()
        if row is None:
            raise ValueError(f"no ATM row on {replay[0]}")
        atm_strike = int(row[0])
    else:
        atm_strike = int(atm)
    strikes = [atm_strike + o for o in OFFSETS]

    keep = set(([preload] if preload else []) + replay)
    rows = conn.execute(
        f"SELECT datetime, option_type, strike, close, volume, spot FROM option_prices "
        f"WHERE expiry = ? AND datetime >= ? AND datetime <= ? AND strike IN ({','.join('?' * len(strikes))}) ORDER BY datetime",
        (expiry, f"{first_day} 00:00:00", f"{replay[-1]} 23:59:59", *[float(s) for s in strikes]),
    ).fetchall()

    legs = {s: {} for s in strikes}  # strike -> datetime -> {CE:(close, vol), PE:(close, vol)}
    spot_at = {}
    mid = float(atm_strike)
    for dt_text, typ, strike, close, vol, spot in rows:
        if dt_text[:10] not in keep:
            continue
        legs[int(strike)].setdefault(dt_text, {})[typ] = (close, vol or 0.0)
        if float(strike) == mid and spot is not None:
            spot_at[dt_text] = float(spot)

    bars, coverage = {}, {}
    for strike in strikes:
        series = []
        for dt_text in sorted(legs[strike]):
            ce, pe = legs[strike][dt_text].get("CE"), legs[strike][dt_text].get("PE")
            if not ce or not pe or not (ce[0] or 0) > 0 or not (pe[0] or 0) > 0:
                continue
            series.append({
                "t": _epoch(dt_text),
                "ce": round(float(ce[0]), 2),
                "pe": round(float(pe[0]), 2),
                "straddle": round(float(ce[0]) + float(pe[0]), 2),
                "vol": float(ce[1]) + float(pe[1]),
            })
        bars[str(strike)] = series
        coverage[str(strike)] = len(series)

    spot_times = sorted(spot_at)
    return {
        "expiry": expiry,
        "atm": atm_strike,
        "strikes": strikes,
        "preloadSession": preload,
        "sessions": replay,
        "bars": bars,
        "coverage": coverage,
        "spotT": [_epoch(t) for t in spot_times],
        "spotV": [spot_at[t] for t in spot_times],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["expiries", "load"], required=True)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--expiry")
    parser.add_argument("--from", dest="date_from")
    parser.add_argument("--to", dest="date_to")
    parser.add_argument("--atm", default="auto")
    args = parser.parse_args()
    try:
        conn = _connect()
        try:
            if args.mode == "expiries":
                print(json.dumps({"expiries": list_expiries(conn, args.limit)}))
            else:
                if not (args.expiry and args.date_from and args.date_to):
                    raise ValueError("--expiry, --from and --to are required for --mode load")
                atm = "auto" if args.atm == "auto" else int(float(args.atm))
                print(json.dumps(build_payload(conn, args.expiry, args.date_from, args.date_to, atm)))
        finally:
            conn.close()
    except (ValueError, FileNotFoundError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc)}))
    except Exception as exc:  # never leave the caller without a JSON line
        print(json.dumps({"error": f"unexpected: {exc}"}))


if __name__ == "__main__":
    main()
