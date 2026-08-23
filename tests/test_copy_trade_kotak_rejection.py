"""Kotak asynchronous RMS rejections must surface as errors, so the copy-trade
bridge's margin top-up hedge can fire.

Regression cover for 2026-08-21: Kotak accepted every SELL synchronously
(`stat: Ok` + `nOrdNo`), RMS rejected several of them for margin a second or
two later, and the bridge logged them all as `success`. The buy-hedge trigger
is only ever reached from a *detected* rejection, so it never ran and the Dhan
and Kotak books desynced.

Run: venv\\Scripts\\python.exe -m pytest tests/test_copy_trade_kotak_rejection.py
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.kotak.responses import classify_order_status, find_order_row  # noqa: E402
from scripts.tools.child_brokers import ChildBroker, KotakChild  # noqa: E402


ORDER_ID = '2082674228649304064'


class FakeKotakClient:
    """Minimal Kotak Neo client stub: accepts every order, then serves whatever
    order-book rows the test queued for each successive order_report() call."""

    def __init__(self, reports):
        self._reports = list(reports)
        self.placed = []
        self.report_calls = 0

    def place_order(self, **kwargs):
        self.placed.append(kwargs)
        return {'stat': 'Ok', 'nOrdNo': ORDER_ID}

    def order_report(self):
        self.report_calls += 1
        if not self._reports:
            return {'stat': 'Not_Ok', 'stCode': 5203, 'errMsg': 'No Data'}
        nxt = self._reports.pop(0)
        return nxt


def _row(status, reason=None):
    row = {'nOrdNo': ORDER_ID, 'ordSt': status}
    if reason:
        row['rejRsn'] = reason
    return row


def _ok(rows):
    return {'stat': 'Ok', 'data': rows}


def _empty():
    return {'stat': 'Not_Ok', 'stCode': 5203, 'errMsg': 'No Data'}


def _child(reports):
    child = KotakChild(FakeKotakClient(reports), log=lambda *a, **k: None)
    child.freeze_qty = 1800
    return child


# ── status classification ────────────────────────────────────────────

def test_classify_separates_pending_from_accepted():
    assert classify_order_status('REJECTED') == 'rejected'
    assert classify_order_status('CANCELLED') == 'rejected'
    assert classify_order_status('OPEN') == 'accepted'
    assert classify_order_status('COMPLETE') == 'accepted'
    # The status Kotak serves in the window where RMS has not ruled yet MUST
    # NOT read as accepted — that is the whole bug.
    assert classify_order_status('put order req received') == 'pending'
    assert classify_order_status('Validation Pending') == 'pending'
    assert classify_order_status('') == 'pending'
    assert classify_order_status('SOMETHING NEW') == 'unknown'


def test_find_order_row_matches_as_string():
    rows = [{'nOrdNo': ORDER_ID, 'ordSt': 'OPEN'}]
    assert find_order_row(rows, int(ORDER_ID))['ordSt'] == 'OPEN'
    assert find_order_row(rows, '999') is None


# ── synchronous confirmation window ──────────────────────────────────

def test_rejection_arriving_after_the_first_poll_is_still_detected():
    """The old one-shot 0.4s peek saw 'put order req received' and returned
    success. RMS rejected a beat later and nobody noticed."""
    child = _child([
        _ok([_row('put order req received')]),
        _ok([_row('REJECTED', 'RMS:Margin Exceeds,Required:354766.42, Available:305446.90')]),
    ])
    with pytest.raises(RuntimeError, match='(?i)margin'):
        child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')


def test_immediate_acceptance_does_not_burn_the_whole_poll_window():
    child = _child([_ok([_row('OPEN')])])
    assert child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS') == ORDER_ID
    assert child.client.report_calls == 1
    assert child.pending_confirm == []


def test_rejection_error_text_is_recognised_as_a_margin_rejection():
    from scripts.tools.copy_trade_bridge import is_margin_rejection
    child = _child([_ok([_row('REJECTED', 'RMS:Margin Exceeds')])])
    try:
        child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
        pytest.fail('expected a rejection')
    except RuntimeError as e:
        assert is_margin_rejection(str(e))


# ── asynchronous confirmation on the watchdog thread ─────────────────

def test_unresolved_order_is_registered_for_later_confirmation():
    """Rejections slower than the placement window must not be lost: the order
    is parked so the watchdog thread can resolve it."""
    child = _child([_empty(), _empty(), _empty()])
    assert child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS') == ORDER_ID
    assert len(child.pending_confirm) == 1
    assert child.pending_confirm[0]['order_id'] == ORDER_ID
    assert child.pending_confirm[0]['symbol'] == 'NIFTY26AUG24250PE'
    assert child.pending_confirm[0]['qty'] == 65


def test_confirm_placements_reports_a_late_rejection():
    child = _child([_empty(), _empty(), _empty()])
    child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))

    rejections = child.confirm_placements()
    assert len(rejections) == 1
    assert rejections[0]['symbol'] == 'NIFTY26AUG24250PE'
    assert rejections[0]['side'] == 'SELL'
    assert rejections[0]['qty'] == 65
    assert 'Margin Exceeds' in rejections[0]['reason']
    assert child.pending_confirm == []      # resolved, not re-reported
    assert child.confirm_placements() == []


def test_confirm_placements_never_reports_an_accepted_or_unknown_order():
    """Re-placing an order that actually went through doubles a live position,
    so only a positive REJECTED/CANCELLED may be reported."""
    child = _child([_empty(), _empty(), _empty()])
    child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    child.client._reports.append(_ok([_row('COMPLETE')]))
    assert child.confirm_placements() == []
    assert child.pending_confirm == []

    child2 = _child([_empty(), _empty(), _empty()])
    child2._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    child2.client._reports.append(_ok([_row('SOME NEW STATUS')]))
    assert child2.confirm_placements() == []
    assert len(child2.pending_confirm) == 1   # still watched, never re-placed


def test_confirm_placements_gives_up_after_the_timeout():
    child = _child([_empty(), _empty(), _empty()])
    child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    child.pending_confirm[0]['ts'] = time.time() - (KotakChild.CONFIRM_TIMEOUT_SEC + 1)
    assert child.confirm_placements() == []
    assert child.pending_confirm == []


def test_place_child_order_attaches_the_leg_context_for_the_hedge():
    """ensure_hedge_capacity refuses to act without strike/expiry/opt_type, so a
    re-queued rejection has to carry them."""
    child = _child([_empty(), _empty(), _empty()])
    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28', 'opt_type': 'PE'}
    placed, ids, err = child.place_child_order(
        'NIFTY26AUG24250PE', 'SELL', 65, product='MIS', context=ctx)
    assert (placed, err) == (65, None)
    assert ids == [ORDER_ID]
    assert child.pending_confirm[0]['context'] == ctx

    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))
    rej = child.confirm_placements()
    assert rej[0]['context']['strike'] == 24250.0


# ── the bridge turns a confirmed rejection back into a hedged retry ──

def test_bridge_requeues_a_confirmed_rejection_with_hedge_context():
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28',
           'opt_type': 'PE', 'product_hints': (), 'price': 120.0}
    child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS', context=ctx)
    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))

    retry_queue, state, logged = [], {'failed_count': 0}, []
    ctb.confirm_child_placements({'kotak': child}, retry_queue, state,
                                 armed=True, append=logged.append)

    assert len(retry_queue) == 1
    item = retry_queue[0]
    assert item['broker'] == 'kotak'
    assert item['child_symbol'] == 'NIFTY26AUG24250PE'
    assert (item['side'], item['qty']) == ('SELL', 65)
    # ensure_hedge_capacity bails out without these
    assert (item['strike'], item['expiry'], item['opt_type']) == (24250.0, '2026-08-28', 'PE')
    # Resumes the leg's retry budget rather than restarting it.
    assert item['attempts'] == 1
    assert 'queued_at' not in item or item['queued_at'] is None
    assert logged and logged[0]['result'] == 'child_order_rejected'


def test_bridge_does_not_requeue_while_disarmed():
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS',
                            context={'strike': 24250.0, 'expiry': '2026-08-28',
                                     'opt_type': 'PE'})
    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))

    retry_queue, logged = [], []
    ctb.confirm_child_placements({'kotak': child}, retry_queue, {'failed_count': 0},
                                 armed=False, append=logged.append)
    assert retry_queue == []
    assert logged and logged[0]['result'] == 'child_order_rejected'


def test_repeated_async_rejections_do_not_loop_forever():
    """A leg rejected asynchronously every round must exhaust the same retry
    budget as any other failure, not restart it each time."""
    from scripts.tools import copy_trade_bridge as ctb

    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28', 'opt_type': 'PE'}
    seen = []
    for attempts in range(0, ctb.RETRY_MAX_ATTEMPTS + 2):
        child = _child([_empty(), _empty(), _empty()])
        child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS',
                                context={**ctx, 'attempts': attempts})
        child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))
        q, logged = [], []
        ctb.confirm_child_placements({'kotak': child}, q, {'failed_count': 0},
                                     armed=True, append=logged.append)
        seen.append(bool(q))
        if q:
            assert q[0]['attempts'] == attempts + 1
        else:
            assert logged[0]['result'] == 'retry_exhausted'

    assert seen[0] is True and seen[-1] is False, seen


# ── review fixes ─────────────────────────────────────────────────────

class MultiOrderKotakClient(FakeKotakClient):
    """Hands out a distinct order id per placement, and always serves the same
    order book (so one fetch can resolve every parked order)."""

    def __init__(self, rows=None, delay=0.0):
        super().__init__([])
        self._seq = 0
        self.rows = rows or []
        self.delay = delay

    def place_order(self, **kwargs):
        self._seq += 1
        self.placed.append(kwargs)
        return {'stat': 'Ok', 'nOrdNo': f'{ORDER_ID}{self._seq}'}

    def order_report(self):
        self.report_calls += 1
        if self.delay:
            time.sleep(self.delay)
        return _ok(self.rows) if self.rows else _empty()


def test_confirm_placements_fetches_the_order_book_once_per_pass():
    """One HTTP call per pass, not per parked order — this runs on the same
    watchdog thread that owns the retry drain."""
    child = KotakChild(MultiOrderKotakClient(), log=lambda *a, **k: None)
    for _ in range(3):
        child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    assert len(child.pending_confirm) == 3

    child.client.rows = [{'nOrdNo': e['order_id'], 'ordSt': 'REJECTED',
                          'rejRsn': 'RMS:Margin Exceeds'}
                         for e in child.pending_confirm]
    before = child.client.report_calls
    rejections = child.confirm_placements()
    assert len(rejections) == 3
    assert child.client.report_calls - before == 1


def test_poll_window_is_bounded_by_wall_clock_not_attempt_count():
    """A slow order book must not multiply the SDK read timeout by the attempt
    count on the WS callback thread."""
    child = KotakChild(MultiOrderKotakClient(delay=0.5), log=lambda *a, **k: None)
    child.CONFIRM_POLL_BUDGET_SEC = 0.6
    started = time.time()
    child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    elapsed = time.time() - started
    # 3 attempts x (0.5s call + 0.4s sleep) would be ~2.6s without the budget.
    assert elapsed < 1.8, elapsed
    assert child.client.report_calls < KotakChild.CONFIRM_POLL_ATTEMPTS + 1
    assert len(child.pending_confirm) == 1     # still handed to the watchdog


def test_partial_fill_then_cancel_places_only_the_remainder():
    """CANCELLED with a non-zero filled qty is a partial, not a rejection:
    re-placing the whole slice would double the part that already traded."""
    child = _child([_ok([{'nOrdNo': ORDER_ID, 'ordSt': 'CANCELLED',
                          'fldQty': 40, 'rejRsn': 'Exchange cancelled remainder'}])])
    child.set_position_snapshot({})
    placed, ids, err = child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65,
                                              product='MIS')
    assert placed == 40                 # counted, so the caller queues 25
    assert ids == [ORDER_ID]
    assert 'filling 40/65' in err
    # Only the part that reached the market is booked into the position cache.
    assert child.margin['positions']['NIFTY26AUG24250PE'] == -40


def test_bridge_requeues_only_the_unfilled_remainder():
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28', 'opt_type': 'PE'}
    child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS', context=ctx)
    child.client._reports.append(_ok([{'nOrdNo': ORDER_ID, 'ordSt': 'CANCELLED',
                                       'fldQty': 40, 'rejRsn': 'cancelled remainder'}]))

    q, logged = [], []
    ctb.confirm_child_placements({'kotak': child}, q, {'failed_count': 0},
                                 armed=True, append=logged.append)
    assert len(q) == 1
    assert q[0]['qty'] == 25
    assert logged[0]['filled_qty'] == 40


def test_fully_filled_slice_is_never_requeued():
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28', 'opt_type': 'PE'}
    child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS', context=ctx)
    child.client._reports.append(_ok([{'nOrdNo': ORDER_ID, 'ordSt': 'CANCELLED',
                                       'fldQty': 65}]))

    q, logged = [], []
    ctb.confirm_child_placements({'kotak': child}, q, {'failed_count': 0},
                                 armed=True, append=logged.append)
    assert q == []
    assert 'already filled' in logged[0]['error']


def test_rejected_hedge_buy_stops_counting_as_a_held_hedge():
    """A phantom hedge is netted out of the safety exit, so a real orphaned
    short at that strike would survive the parent going flat."""
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    # A hedge BUY carries no leg context - it replicates no parent leg.
    child.place_child_order('NIFTY26AUG24750CE', 'BUY', 130, product='MIS')
    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Insufficient cash')]))

    chq = {'kotak': {'NIFTY26AUG24750CE': 130}}
    q, logged = [], []
    ctb.confirm_child_placements({'kotak': child}, q, {'failed_count': 0},
                                 armed=True, child_hedge_qty=chq, append=logged.append)

    assert chq['kotak'] == {}          # no longer netted out of the safety exit
    assert q == []                     # a hedge is never re-queued as a parent leg
    assert logged[0]['result'] == 'child_order_rejected'


def test_a_replicated_sell_never_touches_the_hedge_book():
    from scripts.tools import copy_trade_bridge as ctb

    child = _child([_empty(), _empty(), _empty()])
    ctx = {'order_no': 'P1', 'strike': 24250.0, 'expiry': '2026-08-28', 'opt_type': 'PE'}
    child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, product='MIS', context=ctx)
    child.client._reports.append(_ok([_row('REJECTED', 'RMS:Margin Exceeds')]))

    chq = {'kotak': {'NIFTY26AUG24750CE': 130}}
    ctb.confirm_child_placements({'kotak': child}, [], {'failed_count': 0},
                                 armed=True, child_hedge_qty=chq, append=lambda e: None)
    assert chq['kotak'] == {'NIFTY26AUG24750CE': 130}


def test_pending_confirm_is_bounded_for_processes_that_never_drain():
    """focus_tool_broker caches one child per underlying for the life of the
    worker and never calls confirm_placements, so the list must self-evict."""
    child = KotakChild(MultiOrderKotakClient(), log=lambda *a, **k: None)
    child.PENDING_CONFIRM_MAX = 5
    for _ in range(20):
        child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    assert len(child.pending_confirm) <= 5


def test_pending_confirm_evicts_entries_past_the_timeout():
    child = KotakChild(MultiOrderKotakClient(), log=lambda *a, **k: None)
    child._place_one('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    child.pending_confirm[0]['ts'] = time.time() - (child.CONFIRM_TIMEOUT_SEC + 1)
    child._place_one('NIFTY26AUG24300CE', 'SELL', 65, 'MIS')
    assert [e['symbol'] for e in child.pending_confirm] == ['NIFTY26AUG24300CE']


def test_focus_tool_style_positional_call_still_works():
    """focus_tool_broker calls place_child_order(symbol, side, qty, product)
    positionally — the new `context` param must stay trailing."""
    child = _child([_ok([_row('OPEN')])])
    placed, ids, err = child.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, 'MIS')
    assert (placed, err) == (65, None)
    assert ids == [ORDER_ID]


def test_zerodha_child_is_unaffected_by_the_confirmation_machinery():
    from scripts.tools.child_brokers import ZerodhaChild
    assert ZerodhaChild.confirm_placements is ChildBroker.confirm_placements

    class FakeKite:
        VARIETY_REGULAR = 'regular'
        EXCHANGE_NFO = 'NFO'
        TRANSACTION_TYPE_BUY = 'BUY'
        TRANSACTION_TYPE_SELL = 'SELL'
        ORDER_TYPE_MARKET = 'MARKET'
        VALIDITY_DAY = 'DAY'
        PRODUCT_NRML = 'NRML'
        PRODUCT_MIS = 'MIS'

        def __init__(self): self.orders = []

        def place_order(self, **kw):
            self.orders.append(kw)
            return '250821000123'

    z = ZerodhaChild(FakeKite(), log=lambda *a, **k: None)
    placed, ids, err = z.place_child_order('NIFTY26AUG24250PE', 'SELL', 65, 'NRML',
                                           context={'strike': 24250.0})
    assert (placed, err) == (65, None)
    assert z.pending_confirm == []          # never parks anything
    assert z.confirm_placements() == []
