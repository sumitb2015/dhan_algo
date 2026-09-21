#!/usr/bin/env python3
"""
Re-apply the dhan_algo override note to the vendor VectorBT skills.

The backtesting pack is installed with `npx skills` (skills-lock.json, source marketcalls/vectorbt-backtesting-skills),
so an `npx skills update` rewrites those SKILL.md files and drops the note that points them at `dhan-backtest-data`.
This script is idempotent: it inserts the note right after the frontmatter, skips files that already have it, and never
touches anything else. It does not edit skills-lock.json (its hashes will therefore differ for these six files).

    python3 .claude/skills/dhan-backtest-data/scripts/apply_vendor_overrides.py           # apply
    python3 .claude/skills/dhan-backtest-data/scripts/apply_vendor_overrides.py --check   # report only, exit 1 if any missing
"""
import os
import sys

SKILLS = ("backtest", "optimize", "quick-stats", "strategy-compare", "setup", "vectorbt-expert")
MARK = "Repo override (dhan_algo)"
NOTE = (
    "> **Repo override (dhan_algo):** this repo has no OpenAlgo server and its market data is Dhan-only. The data-fetch, "
    "indicator-library, benchmark, lot-size and output-location steps below do not apply as written. "
    "Read the `dhan-backtest-data` skill first and use its substitutions (`load_ohlcv()` instead of `client.history()`, "
    "`pandas_ta`/`lib.intraday_signals` instead of `openalgo.ta`, no yfinance).\n"
)


def skills_dir() -> str:
    d = os.path.dirname(os.path.abspath(__file__))
    while not os.path.isdir(os.path.join(d, ".claude", "skills")):
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("run inside the dhan_algo repo")
        d = parent
    return os.path.join(d, ".claude", "skills")


def main() -> int:
    check = "--check" in sys.argv
    base = skills_dir()
    missing = 0
    for name in SKILLS:
        path = os.path.realpath(os.path.join(base, name, "SKILL.md"))   # resolves the .claude -> .agents symlink
        if not os.path.exists(path):
            print(f"{name:18s} not installed, skipped")
            continue
        text = open(path, encoding="utf-8").read()
        if MARK in text:
            print(f"{name:18s} ok")
            continue
        missing += 1
        head, sep, rest = text.partition("\n---\n") if text.startswith("---\n") else ("", "", "")
        if not sep:
            print(f"{name:18s} SKIPPED: no frontmatter found, patch by hand")
            continue
        if check:
            print(f"{name:18s} MISSING note")
            continue
        open(path, "w", encoding="utf-8").write(head + "\n---\n\n" + NOTE + "\n" + rest.lstrip("\n"))
        print(f"{name:18s} patched")
    return 1 if (check and missing) else 0


if __name__ == "__main__":
    sys.exit(main())
