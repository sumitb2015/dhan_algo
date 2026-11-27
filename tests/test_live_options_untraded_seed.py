"""live_options_ws: a strike with no tick yet (exchange closed / pre-open on BSE, MCX) still publishes the startup
chain's previous close, so /index-scalper's Quick Trade chips show a dimmed price instead of a dash. ltp stays 0.

Pure: no Dhan session. Run: venv/bin/python tests/test_live_options_untraded_seed.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'tools'))

from live_options_ws import _fetch_prev_meta, _seed_untraded_side  # noqa: E402


class _FakeHelper:
    """Dhan's real chain shape: the close field is previous_close_price (docs/API_GOTCHAS.md)."""
    def get_option_chain(self, symbol, expiry, exchange_segment='IDX_I'):
        return {'oc': {'84300.000000': {
            'ce': {'last_price': 822.8, 'previous_close_price': 822.8, 'previous_oi': 128060, 'oi': 0},
            'pe': {'last_price': 714.35, 'previous_close_price': 714.35, 'previous_oi': 101360, 'oi': 0},
        }}}


def test_prev_meta_reads_previous_close_price():
    meta = _fetch_prev_meta(_FakeHelper(), '1', '2026-12-03', exchange_segment='BSE_FNO', attempts=1)
    assert meta[84300] == {'ce_oi': 128060, 'pe_oi': 101360, 'ce_close': 822.8, 'pe_close': 714.35}


def empty():
    return {'ltp': 0, 'oi': 0, 'volume': 0, 'prev_close': 0.0, 'change': 0.0, 'change_pct': 0.0, 'oi_chg_pct': 0.0, 'buildup': ''}


def test_seeds_prev_close_and_prev_oi_keeps_ltp_zero():
    side = empty()
    _seed_untraded_side(side, {'ce_close': 412.35, 'ce_oi': 1200, 'pe_close': 380.0, 'pe_oi': 900}, 'ce')
    assert side['prev_close'] == 412.35
    assert side['prev_oi'] == 1200
    assert side['ltp'] == 0
    assert side['change'] == 0.0 and side['change_pct'] == 0.0


def test_missing_baseline_leaves_side_untouched():
    side = empty()
    _seed_untraded_side(side, None, 'pe')
    assert side == empty()
    _seed_untraded_side(side, {'pe_close': 0.0, 'pe_oi': 0}, 'pe')
    assert side == empty()


if __name__ == '__main__':
    test_prev_meta_reads_previous_close_price()
    test_seeds_prev_close_and_prev_oi_keeps_ltp_zero()
    test_missing_baseline_leaves_side_untouched()
    print('ok')
