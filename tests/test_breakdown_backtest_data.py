"""Pure-logic checks for the Breakdown Scalper backtest data builder (no DB, no broker)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'tools'))
import breakdown_backtest_data as m  # noqa: E402


def contracts(day, bars):
    out = {}
    for strike, opt, hm, close in bars:
        e = out.setdefault(f'{strike}{opt}', {'strike': strike, 'option': opt, 'bars': []})
        e['bars'].append([f'{day} {hm}', close, close, close, close, 1, 0])
    return out


def test_real_spot_is_forward_filled_and_back_filled():
    day = '2026-04-21'
    c = contracts(day, [(23000, 'CE', '09:15', 100), (23000, 'CE', '09:16', 100), (23000, 'CE', '09:17', 100)])
    assert m.fill_spot({'09:16': 23010.0}, c, day) == {'09:15': 23010.0, '09:16': 23010.0, '09:17': 23010.0}


def test_no_spot_uses_put_call_parity_and_carries_gaps():
    day = '2026-04-21'
    c = contracts(day, [(23000, 'CE', '09:15', 120), (23000, 'PE', '09:15', 100), (23100, 'CE', '09:15', 60),
                        (23100, 'PE', '09:15', 150), (23000, 'CE', '09:16', 121)])
    out = m.fill_spot({}, c, day)
    assert out['09:15'] == 23020.0  # strike with the nearest CE/PE: K + CE - PE
    assert out['09:16'] == 23020.0  # no complete pair this minute: carried


def test_no_spot_and_no_pair_gives_nothing():
    day = '2026-04-21'
    assert m.fill_spot({}, contracts(day, [(23000, 'CE', '09:15', 120)]), day) == {}
