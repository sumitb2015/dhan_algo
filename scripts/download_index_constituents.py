"""
Download NSE's official index constituent lists into index_constituents/.

Sibling of download_nifty500_symbols.py (same source, same safety rules): each list is NSE's
file saved verbatim (Company Name, Industry, Symbol, Series, ISIN Code), validated before it
replaces anything, and written atomically. A failed or truncated download keeps the existing
file for that index. A manifest.json records the label, count and download date of every list;
rs_dashboard/lib/indexConstituents.ts reads it for the RS Strategy page's index filter.

Run when NSE reconstitutes indices (March and September), or any time:
    venv/bin/python scripts/download_index_constituents.py
Constituent lists are reference data, not market data, so the Dhan-only market-data rule is untouched.
"""
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJECT_ROOT, "index_constituents")
BASE_URL = "https://archives.nseindia.com/content/indices/ind_{slug}list.csv"
IST = timezone(timedelta(hours=5, minutes=30))

# key, label, NSE file slug, expected constituent count. A download is rejected when it has fewer
# than 60% of the expected count (a truncated file or an HTML error page).
INDICES = [
    ("nifty50",             "Nifty 50",                   "nifty50",                    50),
    ("niftynext50",         "Nifty Next 50",              "niftynext50",                50),
    ("nifty100",            "Nifty 100",                  "nifty100",                  100),
    ("nifty200",            "Nifty 200",                  "nifty200",                  200),
    ("niftymidcap100",      "Nifty Midcap 100",           "niftymidcap100",            100),
    ("niftymidcap150",      "Nifty Midcap 150",           "niftymidcap150",            150),
    ("niftysmallcap100",    "Nifty Smallcap 100",         "niftysmallcap100",          100),
    ("niftysmallcap250",    "Nifty Smallcap 250",         "niftysmallcap250",          250),
    ("niftybank",           "Nifty Bank",                 "niftybank",                  14),
    ("niftypsubank",        "Nifty PSU Bank",             "niftypsubank",               12),
    ("niftyfinance",        "Nifty Financial Services",   "niftyfinance",               20),
    ("niftyfinsrv2550",     "Nifty Fin Services 25/50",   "niftyfinancialservices25-50", 20),
    ("niftyit",             "Nifty IT",                   "niftyit",                    10),
    ("niftyauto",           "Nifty Auto",                 "niftyauto",                  15),
    ("niftypharma",         "Nifty Pharma",               "niftypharma",                20),
    ("niftyhealthcare",     "Nifty Healthcare",           "niftyhealthcare",            20),
    ("niftyfmcg",           "Nifty FMCG",                 "niftyfmcg",                  15),
    ("niftymetal",          "Nifty Metal",                "niftymetal",                 15),
    ("niftyenergy",         "Nifty Energy",               "niftyenergy",                40),
    ("niftyoilgas",         "Nifty Oil & Gas",            "niftyoilgas",                15),
    ("niftyrealty",         "Nifty Realty",               "niftyrealty",                10),
    ("niftymedia",          "Nifty Media",                "niftymedia",                 10),
    ("niftyconsumerdurables", "Nifty Consumer Durables",  "niftyconsumerdurables",      15),
    ("niftyinfra",          "Nifty Infrastructure",       "niftyinfra",                 30),
]


def fetch(slug: str) -> str:
    req = urllib.request.Request(
        BASE_URL.format(slug=slug),
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8")


def parse_symbols(content: str) -> list[str]:
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames or "Symbol" not in reader.fieldnames:
        return []
    return [r["Symbol"].strip() for r in reader if r.get("Symbol") and not r["Symbol"].strip().startswith("DUMMY")]


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = {"indices": {}}
    today = datetime.now(IST).strftime("%Y-%m-%d")

    failed = []
    for key, label, slug, expect in INDICES:
        try:
            content = fetch(slug)
            syms = parse_symbols(content)
            if len(syms) < int(expect * 0.6):
                raise ValueError(f"only {len(syms)} symbols (expected ~{expect})")
            if len(set(syms)) != len(syms):
                raise ValueError("duplicate symbols in the download")
            tmp = os.path.join(OUT_DIR, f"{key}.csv.tmp")
            with open(tmp, "w", newline="", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp, os.path.join(OUT_DIR, f"{key}.csv"))
            manifest["indices"][key] = {"label": label, "file": f"{key}.csv", "count": len(syms), "downloaded": today}
            print(f"[OK]   {label:<28} {len(syms):>3} symbols")
        except Exception as e:  # keep the previous file for this index
            failed.append(key)
            print(f"[FAIL] {label:<28} {e} - keeping the existing file")

    # Drop manifest entries for indices no longer in the registry.
    valid = {k for k, *_ in INDICES}
    manifest["indices"] = {k: v for k, v in manifest["indices"].items() if k in valid}
    manifest["order"] = [k for k, *_ in INDICES if k in manifest["indices"]]
    tmp = manifest_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, manifest_path)
    print(f"\n{len(manifest['indices'])} indices on disk, {len(failed)} failed this run.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
