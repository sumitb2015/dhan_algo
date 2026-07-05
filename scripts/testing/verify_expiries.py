"""
Verify generated expiry dates against known NSE holiday adjustments.

Checks that:
1. Holiday Thursdays shift to Wednesday (or earlier) correctly.
2. Total count per year is plausible (~52 weekly expiries).
3. No two consecutive expiries are on the same date.
"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts", "downloader"))

from download_expired_options import generate_hybrid_expiries, NSE_HOLIDAYS
from datetime import datetime

# Known Thursday holidays that should shift to Wednesday
HOLIDAY_THURSDAYS = {
    "2021-03-11", "2021-05-13", "2021-08-19", "2021-11-04",  # shift comments in downloader
    "2022-04-14",
    "2023-01-26", "2023-03-30",
    "2024-04-10",
}

def verify_year(year: int):
    expiries = generate_hybrid_expiries(datetime(year, 1, 1), datetime(year, 12, 31), "NIFTY")
    expiries.sort()
    print(f"\n=== {year} NIFTY expiries ({len(expiries)} total) ===")
    for e in expiries:
        d = datetime.strptime(e, "%Y-%m-%d")
        marker = ""
        # The Thursday that would have been this expiry
        if e in HOLIDAY_THURSDAYS:
            marker = "  <-- SHOULD NOT APPEAR (was holiday Thu)"
        # Check if any Thursday in NSE_HOLIDAYS maps here
        for hol in HOLIDAY_THURSDAYS:
            hol_d = datetime.strptime(hol, "%Y-%m-%d")
            if hol_d.year == year and hol_d.strftime("%Y-%m-%d") in NSE_HOLIDAYS:
                # The shifted expiry should be Wed = hol_d - 1 day
                shifted = (hol_d - __import__('datetime').timedelta(days=1)).strftime("%Y-%m-%d")
                if e == shifted:
                    marker = f"  <-- holiday-adjusted from {hol} (Thu->Wed)"
        print(f"  {e}  ({d.strftime('%a')}){marker}")

    # Sanity checks
    assert len(expiries) >= 48, f"Too few expiries for {year}: {len(expiries)}"
    assert len(expiries) == len(set(expiries)), f"Duplicate expiry dates in {year}"
    for hol_thu in HOLIDAY_THURSDAYS:
        if hol_thu.startswith(str(year)):
            assert hol_thu not in expiries, f"Holiday Thursday {hol_thu} appeared in expiries!"
    print(f"  [OK] No holiday Thursdays in output, no duplicates, count >= 48")


if __name__ == "__main__":
    for yr in [2021, 2022, 2023, 2024]:
        verify_year(yr)

    # Show 2025 transition
    expiries25 = generate_hybrid_expiries(datetime(2025, 7, 1), datetime(2025, 10, 31), "NIFTY")
    expiries25.sort()
    print("\n=== 2025 Jul–Oct (Thu→Tue transition) ===")
    for e in expiries25:
        d = datetime.strptime(e, "%Y-%m-%d")
        print(f"  {e}  ({d.strftime('%a')})")
    # Verify no Thursday after Sep 1, 2025
    for e in expiries25:
        d = datetime.strptime(e, "%Y-%m-%d")
        if e >= "2025-09-01":
            assert d.weekday() != 3, f"Thursday found after regime change: {e}"
    print("  [OK] No Thursdays post 2025-09-01")
