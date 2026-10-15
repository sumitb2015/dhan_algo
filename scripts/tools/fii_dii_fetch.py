"""
Fetch daily FII/DII trading activity (cash market + F&O) for the /fii-dii dashboard page.

All sources are NSE's own public endpoints (no login, no Dhan equivalent exists):
  Cash (capital market), provisional, Rs crore:
    https://www.nseindia.com/api/fiidiiTradeReact   NSE + BSE + MSEI combined (the headline figure)
    https://www.nseindia.com/api/fiidiiTradeNse     NSE only
    Both return only the LATEST session. NSE has no history endpoint for this, so each run merges
    the day into the cache and the cash history grows run by run (a day nobody fetched is lost).
  F&O, end of day, archived per date (backfilled):
    nsearchives .../content/nsccl/fao_participant_oi_DDMMYYYY.csv   participant-wise OI (contracts)
    nsearchives .../content/nsccl/fao_participant_vol_DDMMYYYY.csv  participant-wise volume (contracts)
    nsearchives .../content/fo/fii_stats_DD-Mon-YYYY.xls             FII derivatives statistics (Rs crore)

Read-only, feeds a page only — never a strategy.
Writes debug/fii_dii.json and prints a one-line JSON summary to stdout.
Usage: python fii_dii_fetch.py [--sessions 60]
"""

import argparse
import csv
import io
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from lib.nse_holidays import is_nse_trading_day  # noqa: E402

OUT_FILE = os.path.join(ROOT, "debug", "fii_dii.json")

UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Accept": "application/json,text/csv,*/*",
    "Referer": "https://www.nseindia.com/reports/fii-dii",
}
CASH_URLS = {
    "combined": "https://www.nseindia.com/api/fiidiiTradeReact",
    "nse": "https://www.nseindia.com/api/fiidiiTradeNse",
}
OI_URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{d:%d%m%Y}.csv"
VOL_URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_vol_{d:%d%m%Y}.csv"
STATS_URL = "https://nsearchives.nseindia.com/content/fo/fii_stats_{d:%d-%b-%Y}.xls"

# Participant CSV columns (after "Client Type"), in file order.
PART_COLS = [
    "fut_idx_long", "fut_idx_short", "fut_stk_long", "fut_stk_short",
    "opt_idx_call_long", "opt_idx_put_long", "opt_idx_call_short", "opt_idx_put_short",
    "opt_stk_call_long", "opt_stk_put_long", "opt_stk_call_short", "opt_stk_put_short",
    "total_long", "total_short",
]
PARTICIPANTS = ("Client", "DII", "FII", "Pro")

# fii_stats row label -> key. Rows not listed (FINNIFTY, NIFTYNXT50, ...) are ignored.
STATS_ROWS = {
    "INDEX FUTURES": "idx_fut", "NIFTY FUTURES": "nifty_fut", "BANKNIFTY FUTURES": "banknifty_fut",
    "INDEX OPTIONS": "idx_opt", "NIFTY OPTIONS": "nifty_opt", "BANKNIFTY OPTIONS": "banknifty_opt",
    "STOCK FUTURES": "stk_fut", "STOCK OPTIONS": "stk_opt",
}

session = requests.Session()
session.headers.update(UA)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def num(s):
    return float(str(s).replace(",", "").strip())


# ── Cash ────────────────────────────────────────────────────────────────────

def fetch_cash(url):
    """-> (date 'YYYY-MM-DD', {"fii": {...}, "dii": {...}}) in Rs crore."""
    r = session.get(url, timeout=20)
    r.raise_for_status()
    rows = r.json()
    out, day = {}, None
    for row in rows:
        cat = str(row.get("category", "")).upper()
        key = "dii" if cat.startswith("DII") else "fii" if cat.startswith("FII") else None
        if not key:
            continue
        d = datetime.strptime(row["date"], "%d-%b-%Y").date().isoformat()
        if day and d != day:
            raise RuntimeError(f"mixed dates in response: {day} vs {d}")
        day = d
        out[key] = {"buy": num(row["buyValue"]), "sell": num(row["sellValue"]), "net": num(row["netValue"])}
    if not day or set(out) != {"fii", "dii"}:
        raise RuntimeError(f"unexpected response: {str(rows)[:200]}")
    return day, out


# ── F&O ─────────────────────────────────────────────────────────────────────

def fetch_archive(url):
    """-> bytes, or None when NSE has no file for that date (holiday / not yet published)."""
    r = session.get(url, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    # A missing archive sometimes comes back 200 with an HTML error page.
    if r.content[:15].lower().startswith((b"<!doctype", b"<html")):
        return None
    return r.content


def parse_participant_csv(raw):
    out = {}
    for row in csv.reader(io.StringIO(raw.decode("utf-8", "replace"))):
        if not row:
            continue
        name = row[0].strip()
        if name not in PARTICIPANTS:
            continue
        vals = [num(v) for v in row[1:1 + len(PART_COLS)]]
        if len(vals) != len(PART_COLS):
            raise RuntimeError(f"{name}: {len(vals)} columns, expected {len(PART_COLS)}")
        out[name] = dict(zip(PART_COLS, (int(v) for v in vals)))
    if set(out) != set(PARTICIPANTS):
        raise RuntimeError(f"participants found: {sorted(out)}")
    return out


def parse_fii_stats(raw):
    df = pd.read_excel(io.BytesIO(raw), header=None)
    out = {}
    for row in df.itertuples(index=False):
        label = str(row[0]).strip().upper()
        key = STATS_ROWS.get(label)
        if not key:
            continue
        try:
            out[key] = {
                "buy_contracts": int(row[1]), "buy_cr": float(row[2]),
                "sell_contracts": int(row[3]), "sell_cr": float(row[4]),
                "oi_contracts": int(row[5]), "oi_cr": float(row[6]),
            }
        except (TypeError, ValueError):
            continue
    if "idx_fut" not in out:
        raise RuntimeError("INDEX FUTURES row not found")
    return out


def fetch_fno_day(d):
    """-> dict for one session, or None if NSE has not published the participant OI file."""
    raw_oi = fetch_archive(OI_URL.format(d=d))
    if raw_oi is None:
        return None
    day = {"oi": parse_participant_csv(raw_oi)}
    raw_vol = fetch_archive(VOL_URL.format(d=d))
    if raw_vol is not None:
        day["vol"] = parse_participant_csv(raw_vol)
    raw_stats = fetch_archive(STATS_URL.format(d=d))
    if raw_stats is not None:
        day["fii_stats"] = parse_fii_stats(raw_stats)
    return day


def candidate_days(n_sessions, today):
    """Most recent n NSE trading days up to today, newest first."""
    out, d = [], today
    while len(out) < n_sessions and (today - d).days < n_sessions * 3:
        if is_nse_trading_day(d):
            out.append(d)
        d -= timedelta(days=1)
    return out


def load_previous():
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=60, help="F&O sessions to keep/backfill")
    args = ap.parse_args()

    prev = load_previous()
    errors = []

    # Cash: merge today's provisional figures into the saved history (a re-run the same evening
    # overwrites the day, so a later, revised print wins).
    cash = {r["date"]: r for r in prev.get("cash", [])}
    for src, url in CASH_URLS.items():
        try:
            d, vals = fetch_cash(url)
            row = cash.setdefault(d, {"date": d})
            row[src] = vals
            log(f"cash {src}: {d} FII {vals['fii']['net']:+.2f} DII {vals['dii']['net']:+.2f}")
        except Exception as e:  # noqa: BLE001 - one source failing must not drop the other
            errors.append(f"cash {src}: {e}")

    # F&O: fetch only sessions not already cached (the newest one is always re-checked in case an
    # earlier run caught it before fii_stats / vol were published).
    fno = {r["date"]: r for r in prev.get("fno", [])}
    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    days = candidate_days(args.sessions, today)
    newest_cached = max(fno) if fno else None
    fetched = 0
    for d in days:
        iso = d.isoformat()
        have = fno.get(iso)
        complete = have and "vol" in have and "fii_stats" in have
        if complete and iso != newest_cached:
            continue
        try:
            day = fetch_fno_day(d)
            fetched += 1
            if day is None:
                if d != today:
                    log(f"fno {iso}: not published")
                continue
            fno[iso] = {"date": iso, **day}
            log(f"fno {iso}: ok ({', '.join(day)})")
        except Exception as e:  # noqa: BLE001
            errors.append(f"fno {iso}: {e}")
        time.sleep(0.25)  # be polite to the archive host

    oldest = days[-1].isoformat() if days else ""
    fno_rows = sorted((r for k, r in fno.items() if k >= oldest), key=lambda r: r["date"])
    cash_rows = sorted(cash.values(), key=lambda r: r["date"])

    if not cash_rows and not fno_rows:
        print(json.dumps({"ok": False, "error": "; ".join(errors) or "no data"}))
        sys.exit(1)

    out = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_cash": cash_rows[-1]["date"] if cash_rows else None,
        "latest_fno": fno_rows[-1]["date"] if fno_rows else None,
        "cash": cash_rows,
        "fno": fno_rows,
        "errors": errors,
        "sources": {
            "cash_combined": CASH_URLS["combined"],
            "cash_nse": CASH_URLS["nse"],
            "participant_oi": OI_URL.replace("{d:%d%m%Y}", "DDMMYYYY"),
            "participant_vol": VOL_URL.replace("{d:%d%m%Y}", "DDMMYYYY"),
            "fii_stats": STATS_URL.replace("{d:%d-%b-%Y}", "DD-Mon-YYYY"),
        },
    }
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(tmp, OUT_FILE)
    print(json.dumps({"ok": True, "latest_cash": out["latest_cash"], "latest_fno": out["latest_fno"],
                      "fno_fetched": fetched, "errors": errors}))


if __name__ == "__main__":
    main()
