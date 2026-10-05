"""The shared NSE holiday list (rs_dashboard/lib/nseHolidays.json) and its Python readers."""
import json
import os
import sys
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib.nse_holidays import NSE_HOLIDAYS, is_nse_trading_day  # noqa: E402

# NSE equity holidays for 2026, https://www.nseindia.com/resources/exchange-communication-holidays
NSE_2026 = [
    "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
    "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
]


def test_2026_matches_nse():
    got = sorted(d for d in NSE_HOLIDAYS if d.startswith("2026"))
    assert got == NSE_2026


def test_only_weekday_holidays_are_listed():
    assert all(date.fromisoformat(d).weekday() < 5 for d in NSE_HOLIDAYS)


def test_trading_day_accepts_date_datetime_and_string():
    assert not is_nse_trading_day("2026-10-02")                      # Gandhi Jayanti
    assert not is_nse_trading_day(date(2026, 10, 20))                # Dussehra
    assert not is_nse_trading_day(datetime(2026, 11, 10, 10, 0))     # Diwali-Balipratipada
    assert not is_nse_trading_day("2026-10-03")                      # Saturday
    assert is_nse_trading_day("2026-10-05")                          # Monday, open


def test_unlisted_year_is_weekdays_only():
    assert is_nse_trading_day("2030-01-02")        # Wednesday
    assert not is_nse_trading_day("2030-01-05")    # Saturday


def test_dhan_helper_uses_the_shared_list():
    from lib.dhan_helper import DhanHelper
    assert DhanHelper.NSE_HOLIDAYS is NSE_HOLIDAYS


def test_json_matches_ts_source():
    path = os.path.join(ROOT, "rs_dashboard", "lib", "nseHolidays.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert set(data["holidays"]) >= {"2026"}
    assert sorted(data["holidays"]["2026"]) == NSE_2026


def test_momentum_review_projection_skips_holiday():
    from lib.momentum import RegimeCalendar
    cal = RegimeCalendar(trading_days=[date(2026, 9, 11)], on_days=set(), review_days=set(), week_regime={})
    # Fri 11 Sep → next week's Monday 14 Sep is Ganesh Chaturthi, so Tuesday 15 Sep.
    assert cal.next_review_day(date(2026, 9, 11)) == date(2026, 9, 15)


def test_muhurat_is_a_trading_day_but_not_a_regular_session():
    from lib.nse_holidays import is_regular_session
    assert is_nse_trading_day("2024-11-01") and not is_regular_session("2024-11-01")   # evening Muhurat hour
    assert not is_nse_trading_day("2025-10-21") and not is_regular_session("2025-10-21")  # NSE lists it as a holiday too
    assert is_regular_session("2024-11-04")


def test_corrected_pre_2026_holidays_from_nse():
    # The old hand-kept lists had these three on the wrong day (the data trades on the old dates).
    for wrong, right in (("2023-06-28", "2023-06-29"), ("2023-11-13", "2023-11-14"), ("2024-04-10", "2024-04-11")):
        assert is_nse_trading_day(wrong) and not is_nse_trading_day(right)
    for special in ("2024-01-22", "2024-05-20", "2024-11-20", "2025-10-22", "2025-11-05"):
        assert not is_nse_trading_day(special)


def test_drop_non_regular_sessions_frame_and_index():
    import pandas as pd
    from lib.nse_holidays import drop_non_regular_sessions, regular_session_days
    df = pd.DataFrame({"Datetime": pd.to_datetime(["2025-10-20", "2025-10-21", "2025-10-22", "2025-10-23", "2025-10-25"]),
                       "v": range(5)})
    # 21st Muhurat/holiday, 22nd Balipratipada holiday, 25th Saturday.
    assert list(drop_non_regular_sessions(df, "Datetime")["v"]) == [0, 3]
    assert list(drop_non_regular_sessions(df.set_index("Datetime")).index.strftime("%Y-%m-%d")) == ["2025-10-20", "2025-10-23"]
    assert len(drop_non_regular_sessions(df.iloc[0:0], "Datetime")) == 0
    assert regular_session_days(["2025-10-21", "2025-10-23", date(2025, 10, 25)]) == ["2025-10-23"]


def test_backtest_data_has_no_non_regular_sessions():
    """Whatever the loaders hand to a backtest must contain no holiday / Muhurat / weekend day."""
    import pytest
    from lib.momentum import load_benchmark
    path = os.path.join(ROOT, "Historical Data", "NIFTY_50_Daily_5Y.csv")
    if not os.path.exists(path):
        pytest.skip("no local NIFTY daily data")
    from lib.nse_holidays import is_regular_session
    bad = [d for d in load_benchmark()["date"] if not is_regular_session(d)]
    assert bad == []


def test_effective_expiry_date_moves_a_holiday_label_back():
    from lib.nse_holidays import effective_expiry_date
    # The options DB labels these expiries on a holiday; the contracts expired the session before.
    assert effective_expiry_date("2023-06-29") == date(2023, 6, 28)
    assert effective_expiry_date("2024-04-11") == date(2024, 4, 10)
    assert effective_expiry_date("2025-10-28") == date(2025, 10, 28)        # an ordinary trading day
    assert effective_expiry_date(date(2026, 10, 20)) == date(2026, 10, 19)  # Dussehra Tuesday -> Monday
    assert effective_expiry_date("2026-03-03") == date(2026, 3, 2)
