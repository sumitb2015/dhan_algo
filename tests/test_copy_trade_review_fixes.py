"""Regression cover for the 2026-10-17 copy-trade review fixes (stubbed, no broker).

Run: venv\\Scripts\\python.exe -m pytest tests/test_copy_trade_review_fixes.py
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.tools import copy_trade_bridge as bridge  # noqa: E402


class _Dhan:
    def __init__(self, res):
        self.res = res

    def get_order_list(self):
        return self.res


class _Helper:
    def __init__(self, res):
        self.dhan = _Dhan(res)


def test_zerodha_cache_loader_importable():
    from scripts.tools.zerodha_instruments_cache import load_zerodha_instruments_cache
    assert callable(load_zerodha_instruments_cache)


def test_baseline_fails_closed_when_order_book_unreadable(monkeypatch):
    monkeypatch.setattr(bridge.time, 'sleep', lambda *_: None)
    with pytest.raises(RuntimeError):
        bridge.baseline_today_orders(_Helper({'status': 'failure'}), {})


def test_baseline_accepts_empty_successful_book():
    assert bridge.baseline_today_orders(_Helper({'status': 'success', 'data': []}), {}) == 0


def test_split_reducing_and_clamp():
    # parent short 130, BUY 130 -> all reducing; child holds short 65 only
    red, opn = bridge.split_reducing(-130, 'BUY', 130)
    assert (red, opn) == (130, 0)
    assert bridge.clamp_child_qty(red, opn, 1, 'BUY', -65) == (65, 65)
    # child flat -> nothing to close, exit would have opened a long
    assert bridge.clamp_child_qty(red, opn, 1, 'BUY', 0) == (0, 130)
    # unknown child position fails open
    assert bridge.clamp_child_qty(red, opn, 2, 'BUY', None) == (260, 0)
    # flip: parent long 65, SELL 130 -> 65 reducing + 65 opening
    red, opn = bridge.split_reducing(65, 'SELL', 130)
    assert (red, opn) == (65, 65)
    assert bridge.clamp_child_qty(red, opn, 1, 'SELL', 0) == (65, 65)
    # plain entry never clamps
    assert bridge.split_reducing(0, 'SELL', 65) == (0, 65)


def test_margin_classifier_ignores_generic_rejections():
    assert not bridge.is_margin_rejection('Kotak order rejected by RMS: no LTP, limit price required')
    assert bridge.is_margin_rejection('RMS: Insufficient margin, shortfall 12000')


# ── handle_update driven end to end with stub brokers ──────────────────────

import json  # noqa: E402


class StubChild:
    name = 'stub'
    default_product = 'MIS'

    def __init__(self, held=None):
        self.held = dict(held or {})
        self.orders = []

    def find_symbol(self, strike, expiry, opt_type):
        return f'NIFTY{expiry}{strike}{opt_type}'

    def map_product(self, *hints):
        return 'MIS'

    def held_qty_cached(self, symbol):
        return self.held.get(symbol, 0)

    def check_margin(self, *a, **k):
        return True, {}

    def place_child_order(self, symbol, side, qty, **kw):
        self.orders.append((symbol, side, qty))
        return qty, ['oid'], None


@pytest.fixture
def env(tmp_path, monkeypatch):
    for name in ('LOG_FILE', 'REPLICATED_FILE', 'RETRY_FILE', 'INFLIGHT_FILE',
                 'RAW_EVENTS_FILE', 'CONFIG_FILE'):
        monkeypatch.setattr(bridge, name, str(tmp_path / (name.lower() + '.json')))
    cfg = {'armed': True, 'children': [{'broker': 'stub', 'multiplier': 1, 'enabled': True}]}
    (tmp_path / 'config_file.json').write_text(json.dumps(cfg))
    monkeypatch.setattr(bridge, 'load_config', lambda: cfg)
    child = StubChild()
    state = {'last_replication_ts': 0.0, 'failed_count': 0}
    retry_queue, replicated = [], {}
    parent_net = {}
    h = bridge.make_handle_update({'stub': child}, {}, parent_net, replicated, {}, retry_queue,
                                  state, lambda *a, **k: None)
    return h, child, retry_queue, replicated, parent_net, tmp_path


def _fill(order_no, side, traded, status='Traded', sid='111', symbol='NIFTY-Oct2026-2', seg=None):
    d = {'Status': status, 'OrderNo': order_no, 'TradedQty': traded, 'TxnType': side,
         'SecurityId': sid, 'Symbol': symbol, 'StrikePrice': 22500, 'ExpiryDate': '2026-10-06',
         'OptType': 'PE', 'ProductType': 'INTRADAY', 'TradedPrice': 50}
    if seg:
        d['ExchangeSegment'] = seg
    return {'Type': 'order_alert', 'Data': d}


def test_partial_then_full_fill_copies_only_the_increment(env):
    h, child, *_ = env
    h(_fill('A1', 'S', 65, status='Part Traded'))
    h(_fill('A1', 'S', 130))
    h(_fill('A1', 'S', 130))  # replay: no-op
    assert [o[2] for o in child.orders] == [65, 65]


def test_exit_without_child_position_is_skipped(env):
    h, child, _q, _r, parent_net, tmp = env
    parent_net['111'] = -65  # parent is short; child never got the entry
    h(_fill('X1', 'B', 65))
    assert child.orders == []
    log = json.loads((tmp / 'log_file.json').read_text())['entries']
    assert log[-1]['result'] == 'exit_skipped_child_flat'


def test_exit_clamped_to_child_holding(env):
    h, child, _q, _r, parent_net, _t = env
    parent_net['111'] = -130
    child.held['NIFTY2026-10-0622500PE'] = -65
    h(_fill('X2', 'B', 130))
    assert [o[2] for o in child.orders] == [65]


def test_other_underlying_and_segment_are_not_copied(env):
    h, child, *_ = env
    h(_fill('F1', 'S', 65, symbol='FINNIFTY-Oct2026-2'))
    h(_fill('F2', 'S', 65, seg='BSE_FNO'))
    assert child.orders == []


def test_unavailable_child_is_queued_and_journal_retired(env):
    h, child, q, replicated, parent_net, tmp = env
    h2 = bridge.make_handle_update({}, {}, parent_net, replicated, {}, q,
                                   {'last_replication_ts': 0.0, 'failed_count': 0},
                                   lambda *a, **k: None)
    h2(_fill('U1', 'S', 65))
    assert len(q) == 1 and q[0]['qty'] == 65
    saved = json.loads((tmp / 'retry_file.json').read_text())['items']
    assert len(saved) == 1
    inflight = json.loads((tmp / 'inflight_file.json').read_text())
    assert inflight['fills'] == {}


def test_retry_queue_survives_restart_and_crash_gap_is_logged(env):
    h, child, q, replicated, parent_net, tmp = env
    q.append({'order_no': 'R1', 'broker': 'stub', 'child_symbol': 'S', 'qty': 65, 'side': 'SELL',
              'attempts': 1, 'next_ts': 0, 'queued_at': bridge.datetime.now(), 'product_hints': ('I',)})
    bridge.persist_retry_queue(q)
    restored = []
    assert bridge.restore_retry_queue(restored) == 1
    assert restored[0]['order_no'] == 'R1' and isinstance(restored[0]['queued_at'], bridge.datetime)
    bridge.journal_begin('C1', 65, 'SELL', 'NIFTY', 65)  # simulated kill before journal_end
    assert bridge.recover_inflight() == 1
    log = json.loads((tmp / 'log_file.json').read_text())['entries']
    assert any(e['result'] == 'crash_recovery_unknown' for e in log)


def test_zerodha_async_rejection_is_detected():
    from scripts.tools.child_brokers import ZerodhaChild

    class Kite:
        VARIETY_REGULAR = 'regular'; EXCHANGE_NFO = 'NFO'
        TRANSACTION_TYPE_BUY = 'BUY'; TRANSACTION_TYPE_SELL = 'SELL'
        ORDER_TYPE_MARKET = 'MARKET'; VALIDITY_DAY = 'DAY'
        PRODUCT_MIS = 'MIS'; PRODUCT_NRML = 'NRML'

        def place_order(self, **kw):
            return '2500'

        def orders(self):
            return [{'order_id': '2500', 'status': 'REJECTED',
                     'status_message': 'price band', 'filled_quantity': 0}]

    z = ZerodhaChild(Kite(), log=lambda *a: None)
    assert z._place_one('NIFTYX', 'SELL', 65, 'MIS') == '2500'
    rejected, timed_out = z.confirm_placements()
    assert len(rejected) == 1 and rejected[0]['reason'] == 'price band' and not timed_out
    assert z.pending_confirm == []
