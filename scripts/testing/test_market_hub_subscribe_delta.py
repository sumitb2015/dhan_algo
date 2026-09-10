"""
Pure-mock tests for market_data_hub.py's _dedup_wanted() and
_compute_subscribe_delta() — the registry-union and diff-subscribe logic. No
login, no network, no live market required — run any time:

    venv\\Scripts\\python.exe scripts/testing/test_market_hub_subscribe_delta.py
"""
import os
import sys
import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

# market_data_hub.py isn't a package module (it's a standalone script under
# scripts/tools/) and its own module-level code (logging.basicConfig, etc.) is
# harmless to run at import time — load it directly rather than adding
# scripts/tools to sys.path and risking a name collision with another script.
_spec = importlib.util.spec_from_file_location(
    'market_data_hub', os.path.join(ROOT, 'scripts', 'tools', 'market_data_hub.py'))
market_data_hub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(market_data_hub)

PASS = []
FAIL = []


def check(name, condition):
    if condition:
        PASS.append(name)
        print(f'[OK] {name}')
    else:
        FAIL.append(name)
        print(f'[FAIL] {name}')


def test_dedup_wanted_union_and_richest_feed_type():
    entries = [
        {'consumer': 'a', 'instruments': [[1, '25', 17], [0, '13', 17]]},
        {'consumer': 'b', 'instruments': [[1, '25', 21], [2, '99', 21]]},
    ]
    best = market_data_hub._dedup_wanted(entries)
    check('union covers all distinct (segment, sid) pairs',
          set(best.keys()) == {('1', '25'), ('0', '13'), ('2', '99')})
    check('shared instrument keeps the richer feed type (Full=21 over Quote=17)',
          best[('1', '25')] == (1, '25', 21))


def test_dedup_wanted_skips_malformed_entry():
    """Regression test: one malformed instrument entry (wrong length, from a
    corrupted or version-skewed wanted_*.json) must not abort the whole union —
    it used to raise ValueError uncaught, killing the hub for every consumer."""
    entries = [
        {'consumer': 'a', 'instruments': [[1, '25', 17], ['not', 'a', 'triple', 'oops']]},
        {'consumer': 'b', 'instruments': [[0, '13', 17]]},
    ]
    best = market_data_hub._dedup_wanted(entries)
    check('a malformed entry is skipped without raising, good entries still union',
          set(best.keys()) == {('1', '25'), ('0', '13')})


def test_compute_subscribe_delta_new_instrument():
    current = {}
    wanted = {('1', '25'): (1, '25', 17)}
    to_add, to_remove_keys, to_remove = market_data_hub._compute_subscribe_delta(current, wanted)
    check('a brand-new key is added', to_add == [(1, '25', 17)])
    check('nothing to remove yet', to_remove_keys == [] and to_remove == [])


def test_compute_subscribe_delta_feed_type_upgrade():
    """Regression test: a consumer needing a richer feed type on an instrument
    another consumer already claimed at a lower tier must still get upgraded —
    previously `to_add` only checked key presence, so this silently never
    happened once the key existed in `current`."""
    current = {('1', '25'): (1, '25', 17)}       # already subscribed at Quote
    wanted = {('1', '25'): (1, '25', 21)}         # union now wants Full
    to_add, to_remove_keys, to_remove = market_data_hub._compute_subscribe_delta(current, wanted)
    check('an existing key needing a richer feed type is included in to_add',
          to_add == [(1, '25', 21)])
    check('an upgrade is not also treated as a removal',
          to_remove_keys == [])


def test_compute_subscribe_delta_no_upgrade_needed():
    current = {('1', '25'): (1, '25', 21)}        # already at Full
    wanted = {('1', '25'): (1, '25', 17)}          # union only wants Quote now
    to_add, to_remove_keys, to_remove = market_data_hub._compute_subscribe_delta(current, wanted)
    check('a key already subscribed at a richer tier than currently wanted is not re-added',
          to_add == [])
    check('a downgrade request does not remove the instrument either '
          '(still wanted, just at a lower tier — current stays at the richer level)',
          to_remove_keys == [])


def test_compute_subscribe_delta_removal():
    current = {('1', '25'): (1, '25', 17), ('0', '13'): (0, '13', 17)}
    wanted = {('0', '13'): (0, '13', 17)}
    to_add, to_remove_keys, to_remove = market_data_hub._compute_subscribe_delta(current, wanted)
    check('a key no longer in any consumer\'s wanted set is removed',
          to_remove_keys == [('1', '25')] and to_remove == [(1, '25', 17)])
    check('nothing spurious added', to_add == [])


def run():
    test_dedup_wanted_union_and_richest_feed_type()
    test_dedup_wanted_skips_malformed_entry()
    test_compute_subscribe_delta_new_instrument()
    test_compute_subscribe_delta_feed_type_upgrade()
    test_compute_subscribe_delta_no_upgrade_needed()
    test_compute_subscribe_delta_removal()

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    return len(FAIL) == 0


if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
