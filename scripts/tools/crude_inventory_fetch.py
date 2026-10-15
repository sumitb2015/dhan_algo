"""
Fetch the weekly US crude-oil inventory picture for the /crude-inventories dashboard page.

Two sources, both free:
  1. EIA (eia.gov), the official numbers. Full weekly history per series comes from the
     "hist_xls" workbooks (no API key). Those workbooks trail by a week right after a
     release, so the newest week is patched in from the current WPSR tables
     (ir.eia.gov/wpsr/table1.csv and table4.csv).
  2. Investing.com's economic calendar, for the market consensus (Forecast) next to the
     Actual, for both the EIA report and the API (American Petroleum Institute) Tuesday
     preview. Investing.com blocks plain HTTP (403), so it goes through the Firecrawl API
     (FIRECRAWL_API_KEY from the environment or the project .env). Without a key this part is
     skipped and the EIA part still works. The calendar page shows only ~10 releases, so the
     rows are merged into the previous cache and the consensus history grows run by run.

Not a Dhan market-data feed: this is fundamental/macro data with no Dhan equivalent, and it
feeds a read-only page, never a strategy.

Writes debug/crude_inventory.json and prints a one-line JSON summary to stdout.
Usage: python crude_inventory_fetch.py [--weeks 300] [--no-consensus]
"""

import argparse
import csv
import io
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_FILE = os.path.join(ROOT, "debug", "crude_inventory.json")

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) dhan-algo crude-inventory"}
HIST_URL = "https://www.eia.gov/dnav/pet/hist_xls/{sid}w.xls"
WPSR_URL = "https://ir.eia.gov/wpsr/{table}.csv"

# key -> (EIA series id, label, unit, WPSR (table, row label, scale) for the newest-week patch).
# Stocks are in million barrels in the WPSR tables (x1000 -> kbbl); flows are already kb/d.
SERIES = {
    "crude":      ("WCESTUS1", "Commercial crude (ex-SPR)", "kbbl", ("table1", "Commercial (Excluding SPR)", 1000.0)),
    "cushing":    ("W_EPC0_SAX_YCUOK_MBBL", "Cushing, OK crude", "kbbl", ("table4", "Cushing", 1000.0)),
    "spr":        ("WCSSTUS1", "Strategic Petroleum Reserve", "kbbl", ("table1", "Strategic Petroleum Reserve (SPR)", 1000.0)),
    "gasoline":   ("WGTSTUS1", "Total motor gasoline", "kbbl", ("table1", "Total Motor Gasoline", 1000.0)),
    "distillate": ("WDISTUS1", "Distillate fuel oil", "kbbl", ("table1", "Distillate Fuel Oil", 1000.0)),
    "refinery":   ("WPULEUS3", "Refinery utilization", "pct", ("table2", "Percent Utilization", 1.0)),
    # First "Imports"/"Exports" rows of table1's balance sheet are crude (lines (8) and (12));
    # the product rows come later and are skipped because the first occurrence wins.
    "production": ("WCRFPUS2", "Crude field production", "kbd", ("table1", "Domestic Production", 1.0)),
    "imports":    ("WCRIMUS2", "Crude imports", "kbd", ("table1", "Imports", 1.0)),
    "exports":    ("WCREXUS2", "Crude exports", "kbd", ("table1", "Exports", 1.0)),
}

CONSENSUS_PAGES = {
    "eia": "https://in.investing.com/economic-calendar/eia-crude-oil-inventories-75",
    "api": "https://in.investing.com/economic-calendar/api-weekly-crude-stock-656",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch_history(sid, weeks):
    r = requests.get(HIST_URL.format(sid=sid), headers=UA, timeout=60)
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content), sheet_name="Data 1", header=None, skiprows=3)
    df = df.iloc[:, :2].dropna()
    out = []
    for d, v in df.tail(weeks).itertuples(index=False):
        out.append([pd.Timestamp(d).strftime("%Y-%m-%d"), float(v)])
    return out


def fetch_wpsr(table):
    """WPSR table -> (week_end 'YYYY-MM-DD', {row label: current-week value as published}).

    A table can hold several sections, each with its own header row: "STUB_1",<dates>... (label
    in column 0) or "STUB_1","STUB_2",<dates>... (group in column 0, label in column 1, with a
    "(8)   " line-number prefix that is stripped). The first occurrence of a label wins.
    """
    r = requests.get(WPSR_URL.format(table=table), headers=UA, timeout=30)
    r.raise_for_status()
    text = r.content.decode("latin-1")  # not UTF-8: blank cells carry stray 0xA0/0x96 bytes
    week = None
    label_col = 0
    values = {}
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        if row[0].startswith("STUB_1"):
            label_col = 1 if len(row) > 1 and row[1].startswith("STUB_2") else 0
            if week is None:
                week = datetime.strptime(row[label_col + 1], "%m/%d/%y").strftime("%Y-%m-%d")
            continue
        if len(row) <= label_col + 1:
            continue
        label = re.sub(r"^\(\d+\)\s*", "", row[label_col].strip())
        if label in values:
            continue
        try:
            values[label] = float(row[label_col + 1].replace(",", ""))
        except ValueError:
            pass
    if week is None:
        raise RuntimeError("no header row")
    return week, values


def firecrawl_key():
    key = os.environ.get("FIRECRAWL_API_KEY")
    if key:
        return key.strip()
    env_path = os.path.join(ROOT, ".env")
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*FIRECRAWL_API_KEY\s*=\s*['\"]?([^'\"\s]+)", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


def parse_amount(s):
    """'-3.186M' -> -3.186 (million barrels). Blank -> None."""
    s = (s or "").strip().replace(",", "")
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*([KMB]?)", s)
    if not m:
        return None
    v = float(m.group(1))
    return {"K": v / 1000.0, "M": v, "B": v * 1000.0, "": v}[m.group(2)]


def parse_calendar_markdown(md):
    """Rows of the '| Release date | Time | Actual | Forecast | Previous |' table."""
    rows = []
    in_table = False
    for line in md.splitlines():
        if line.startswith("| Release date"):
            in_table = True
            continue
        if not in_table:
            continue
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5 or cells[0].startswith("---"):
            continue
        try:
            rel = datetime.strptime(cells[0], "%d-%m-%Y").date()
        except ValueError:
            continue
        rows.append({
            "release": rel.isoformat(),
            "time": cells[1],
            "actual": parse_amount(cells[2]),
            "forecast": parse_amount(cells[3]),
            "previous": parse_amount(cells[4]),
        })
    return rows


def fetch_consensus(key, url):
    r = requests.post(
        "https://api.firecrawl.dev/v2/scrape",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"url": url, "formats": ["markdown"], "onlyMainContent": False},
        timeout=90,
    )
    r.raise_for_status()
    body = r.json()
    md = (body.get("data") or {}).get("markdown") or ""
    rows = parse_calendar_markdown(md)
    if not rows:
        raise RuntimeError("calendar table not found in scraped page")
    return rows


def merge_rows(old, new):
    """Union by release date; a newer scrape wins (it may carry the Actual a forecast lacked)."""
    by_date = {r["release"]: r for r in old or []}
    for r in new:
        by_date[r["release"]] = r
    return sorted(by_date.values(), key=lambda r: r["release"])


def load_previous():
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, default=320, help="weeks of history per series (5y seasonal needs ~5y+)")
    ap.add_argument("--no-consensus", action="store_true", help="skip the Investing.com forecast scrape")
    args = ap.parse_args()

    prev = load_previous()
    errors = []

    wpsr = {}
    for table in sorted({p[0] for *_, p in SERIES.values() if p}):
        try:
            wpsr[table] = fetch_wpsr(table)
        except Exception as e:  # noqa: BLE001 - one table failing must not drop the rest
            errors.append(f"WPSR {table}: {e}")

    series = {}
    for key, (sid, label, unit, patch) in SERIES.items():
        try:
            points = fetch_history(sid, args.weeks)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sid}: {e}")
            points = (prev.get("series", {}).get(key) or {}).get("points", [])
        if patch and patch[0] in wpsr:
            week, values = wpsr[patch[0]]
            v = values.get(patch[1])
            if v is not None and (not points or week > points[-1][0]):
                points.append([week, round(v * patch[2], 1)])
        series[key] = {"id": sid, "label": label, "unit": unit, "points": points}
        log(f"{key}: {len(points)} weeks, last {points[-1] if points else None}")

    consensus = prev.get("consensus") or {"eia": [], "api": []}
    consensus_status = "ok"
    if args.no_consensus:
        consensus_status = "skipped"
    else:
        key = firecrawl_key()
        if not key:
            consensus_status = "no FIRECRAWL_API_KEY in environment or .env"
        else:
            for name, url in CONSENSUS_PAGES.items():
                try:
                    consensus[name] = merge_rows(consensus.get(name), fetch_consensus(key, url))
                    log(f"consensus {name}: {len(consensus[name])} releases")
                except Exception as e:  # noqa: BLE001
                    errors.append(f"consensus {name}: {e}")
                    consensus_status = "partial"

    crude = series["crude"]["points"]
    out = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_week": crude[-1][0] if crude else None,
        "series": series,
        "consensus": consensus,
        "consensus_status": consensus_status,
        "errors": errors,
        "sources": {
            "eia_history": HIST_URL.format(sid="<series>"),
            "eia_wpsr": "https://www.eia.gov/petroleum/supply/weekly/",
            "consensus": CONSENSUS_PAGES,
        },
    }
    if not crude:
        print(json.dumps({"ok": False, "error": "; ".join(errors) or "no EIA data"}))
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(tmp, OUT_FILE)
    print(json.dumps({"ok": True, "latest_week": out["latest_week"], "consensus": consensus_status, "errors": errors}))


if __name__ == "__main__":
    main()
