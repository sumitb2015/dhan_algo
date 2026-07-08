import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tools'))

from normalized_1min_candles import _normalize_series


def test_normalize_series_basis_is_first_open():
    rows = [
        {'time': '09:15', 'open': 100.0, 'close': 100.0},
        {'time': '09:16', 'open': 100.5, 'close': 101.0},
        {'time': '09:17', 'open': 101.0, 'close': 99.0},
    ]
    result = _normalize_series(rows)
    assert result[0]['pct'] == 0.0, result
    assert result[1]['pct'] == 1.0, result
    assert result[2]['pct'] == -1.0, result
    assert result[0]['close'] == 100.0


def test_normalize_series_empty_input():
    assert _normalize_series([]) == []


def test_normalize_series_zero_open_does_not_crash():
    rows = [{'time': '09:15', 'open': 0.0, 'close': 5.0}]
    result = _normalize_series(rows)
    assert result == [{'time': '09:15', 'close': 5.0, 'pct': 0.0}]


if __name__ == '__main__':
    test_normalize_series_basis_is_first_open()
    test_normalize_series_empty_input()
    test_normalize_series_zero_open_does_not_crash()
    print('OK - all normalized_1min_candles tests passed')
