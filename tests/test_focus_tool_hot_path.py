#!/usr/bin/env python
"""
Guards the Focus Tool worker's hot path.

    venv\\Scripts\\python.exe tests/test_focus_tool_hot_path.py

The worker is a scalper terminal's server-side executor: its tick decides when
a live position is closed, so anything that BLOCKS the tick delays every stop
on the book. That has gone wrong twice in the same way — first with option-leg
quotes (a blocking ~1.1s REST call per leg per tick, which made exit latency
scale with the number of positions held), then with inline fill confirmation
(up to 20s during which no other row was evaluated at all).

So this asserts the property directly rather than the symptom:

  1. STATICALLY — walk the call graph from tick() and fail if it can reach any
     REST-calling method that is not explicitly allowed. This catches the
     regression at the moment it is written, without needing a market open.

  2. DYNAMICALLY — run the quote path and the rule engine against a stubbed
     helper whose every REST entry point is a tripwire, and time them.

No broker, no side effects, no market hours. Safe to run any time, and NOT part
of run_all_tests.py's live-account suite.

Narrow scope (after the unfinished WS-feed refactor was reverted): legs on the
market WebSocket via ensure_legs_subscribed, and fill confirmation off the
tick via on_order_update. Chain/VWAP may still touch REST on their own caches;
that is allowed only through methods listed in ALLOWED_ON_TICK or not reached
from tick via place/confirm paths.
"""

import ast
import io
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

WORKER_SRC = os.path.join(ROOT, 'scripts', 'tools', 'focus_tool_rows_worker.py')

failures = []
checked = 0


def check(name, got, want):
    global checked
    checked += 1
    if got != want:
        failures.append(f'{name}\n    expected: {want!r}\n    got:      {got!r}')


def fail(name, detail):
    global checked
    checked += 1
    failures.append(f'{name}\n    {detail}')


# ── 1. Static: what can the tick reach? ─────────────────────────────────────

# Calls that go to the network. Named by attribute, which is how they appear on
# helper / router / market.
REST_CALLS = {
    'get_option_chain_df', 'get_intraday_minute_data', 'get_positions',
    'get_net_quantity', 'get_order_by_id', 'wait_for_fill', 'place_order',
    'ohlc_data', 'quote_data', 'get_expiries', 'net_positions',
    'expiry_list', 'subscribe_instruments',
}

# Methods allowed to make one anyway, with the reason they are exempt.
ALLOWED_ON_TICK = {
    # Paced / needed for ledger truth — see reconcile's own docstring.
    'reconcile',
    # Only reached when an order is actually being placed. The order IS the
    # network call; it cannot be anywhere else. place() must ACK without
    # wait_for_fill (asserted separately).
    'enter_row', 'exit_row', 'exit_leg',
    # Subscribing is how legs get OFF the REST quote path in the first place.
    'ensure_legs_subscribed',
    # Minute-cached REST; not ideal on the tick, but out of this pass's scope
    # (no background refresher). Allowed so the static graph does not force
    # unfinished ladder work back in.
    'chain', 'side_vwap',
}


def method_graph(class_name):
    """{method: (self-calls, rest-calls)} for one class in the worker module."""
    tree = ast.parse(io.open(WORKER_SRC, encoding='utf-8').read())
    cls = next(n for n in ast.walk(tree)
               if isinstance(n, ast.ClassDef) and n.name == class_name)
    graph = {}
    for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef)]:
        self_calls, rest = set(), set()
        for node in ast.walk(fn):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            attr = node.func.attr
            if attr in REST_CALLS:
                rest.add(attr)
            # self.foo(...) -> an edge to this class's own method
            if isinstance(node.func.value, ast.Name) and node.func.value.id == 'self':
                self_calls.add(attr)
        graph[fn.name] = (self_calls, rest)
    return graph


def reachable_from(graph, root):
    """Every method reachable from `root`, with the path that got there."""
    seen, order, stack = {root: [root]}, [], [root]
    while stack:
        name = stack.pop()
        order.append(name)
        for callee in graph.get(name, (set(), set()))[0]:
            if callee in graph and callee not in seen:
                seen[callee] = seen[name] + [callee]
                stack.append(callee)
    return seen


def test_tick_makes_no_unexpected_rest_calls():
    graph = method_graph('FocusRowsWorker')
    check('tick() exists', 'tick' in graph, True)
    check('ensure_legs_subscribed() exists', 'ensure_legs_subscribed' in graph, True)
    check('on_order_update() exists', 'on_order_update' in graph, True)

    reached = reachable_from(graph, 'tick')
    for name, path in sorted(reached.items()):
        rest = graph[name][1]
        if not rest or name in ALLOWED_ON_TICK:
            continue
        fail(f'REST on the hot path: {name}() calls {sorted(rest)}',
             'tick -> ' + ' -> '.join(path[1:]) + '\n    '
             'Move it off the tick, or add it to ALLOWED_ON_TICK with a reason.')


def test_fill_confirmation_is_off_the_tick():
    """The 20s stall regression, asserted directly."""
    graph = method_graph('FocusRowsWorker')
    reached = reachable_from(graph, 'tick')
    check('wait_for_fill is unreachable from tick',
          any('wait_for_fill' in graph[n][1] for n in reached), False)
    check('the order-update callback is NOT on the tick path',
          'on_order_update' in reached, False)

    # place() in the broker must not call wait_for_fill either — that is how
    # enter_row used to stall every other row's exits.
    broker_src = os.path.join(ROOT, 'scripts', 'tools', 'focus_tool_broker.py')
    tree = ast.parse(io.open(broker_src, encoding='utf-8').read())
    place_fn = None
    for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == 'OrderRouter']:
        for fn in [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'place']:
            place_fn = fn
    check('OrderRouter.place exists', place_fn is not None, True)
    place_rest = set()
    for node in ast.walk(place_fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in ('wait_for_fill', 'confirm_fill'):
                place_rest.add(node.func.attr)
    check('OrderRouter.place does not wait for fills', place_rest, set())


# ── 2. Dynamic: how fast is it, and does it touch REST? ─────────────────────

REST_TRIPWIRES = []


class StubHelper:
    """live_data answers instantly; every REST entry point is a tripwire."""

    def __init__(self, with_legs=True):
        self.live_data = {}
        self.last_api_error = None
        if with_legs:
            self.live_data = {
                '13': {'LTP': 24000.0},
                '90001': {'LTP': 101.5},
                '90002': {'LTP': 78.25},
            }

    def _rest(self, what):
        REST_TRIPWIRES.append(what)
        raise AssertionError(f'REST call on the hot path: {what}')

    def ohlc_data(self, *a, **k):
        self._rest('ohlc_data')

    def quote_data(self, *a, **k):
        self._rest('quote_data')

    def get_positions(self, *a, **k):
        self._rest('get_positions')

    def find_option(self, *a, **k):
        raise AssertionError('master-list lookup on the hot path')

    def get_ltp(self, sid, exchange=None, instrument=None, **k):
        live = self.live_data.get(str(sid))
        if live:
            return float(live['LTP'])
        return self._rest(f'get_ltp({sid})')


LEGS = {
    ('NIFTY', '2026-08-27', 24000, 'CE'): {'SECURITY_ID': 90001},
    ('NIFTY', '2026-08-27', 24000, 'PE'): {'SECURITY_ID': 90002},
}


def test_quote_path_is_cpu_only():
    from scripts.tools.focus_tool_broker import MarketData

    helper = StubHelper(with_legs=True)
    market = MarketData(helper)
    market._leg_cache.update(LEGS)   # contracts are cached for the process life

    ce = market.leg('NIFTY', '2026-08-27', 24000, 'CE')
    pe = market.leg('NIFTY', '2026-08-27', 24000, 'PE')

    n = 2000
    t0 = time.perf_counter()
    for _ in range(n):
        market.spot('NIFTY')
        market.ltp('NIFTY', ce)
        market.ltp('NIFTY', pe)
    quote_us = (time.perf_counter() - t0) / n * 1e6

    check('quote path makes no REST calls', REST_TRIPWIRES, [])
    if quote_us >= 500:
        fail('quote path too slow', f'{quote_us:.0f}us per tick for spot + 2 legs')
    print(f'  quote path:  {quote_us:7.1f} us / tick (spot + 2 legs)')

    # Control: a leg NOT on the feed must fall through to REST, proving the
    # speed above comes from the subscription and not from the stub.
    cold = MarketData(StubHelper(with_legs=False))
    cold._leg_cache.update(LEGS)
    before = len(REST_TRIPWIRES)
    cold.ltp('NIFTY', ce)   # MarketData.ltp swallows the error by design
    check('an unsubscribed leg still falls through to REST',
          len(REST_TRIPWIRES) > before, True)


def test_rule_engine_is_fast():
    from scripts.tools.focus_tool_rows_worker import (
        evaluate_row_exit, evaluate_global_risk,
    )
    row = {'levelHigh': '24100', 'levelLow': '23900', 'levelVw': True,
           'slRupees': '2000', 'slMultiplier': '2', 'side': 'BOTH'}
    cfg = {'riskEnabled': True, 'targetRupees': '5000', 'stopRupees': '3000',
           'trailEnabled': True, 'triggerRupees': '2000', 'lockRupees': '500'}
    n = 2000
    t0 = time.perf_counter()
    for _ in range(n):
        evaluate_row_exit(row, 24000.0, 179.75, 180.0, -20.0, 195.0, 194.0)
        evaluate_global_risk(cfg, 1200.0, 1500.0, None)
    rules_us = (time.perf_counter() - t0) / n * 1e6
    if rules_us >= 200:
        fail('rule engine too slow', f'{rules_us:.0f}us per tick')
    print(f'  rule engine: {rules_us:7.1f} us / tick (row exit + account budget)')

    # Inert VWAP must not close anything.
    row_vw = {'levelHigh': '', 'levelLow': '', 'levelVw': True,
              'slRupees': '', 'slMultiplier': '1', 'side': 'BOTH'}
    check('VW with no VWAP never fires',
          evaluate_row_exit(row_vw, 24000.0, 400.0, 180.0, 0.0, None, None), None)


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    test_tick_makes_no_unexpected_rest_calls()
    test_fill_confirmation_is_off_the_tick()
    test_quote_path_is_cpu_only()
    test_rule_engine_is_fast()

    if failures:
        print(f'\n{len(failures)} of {checked} checks FAILED:\n')
        for f in failures:
            print('  ' + f)
        return 1
    print(f'\nAll {checked} hot-path checks passed — the tick makes no blocking '
          f'fill wait, and legs on the feed are CPU-only quotes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
