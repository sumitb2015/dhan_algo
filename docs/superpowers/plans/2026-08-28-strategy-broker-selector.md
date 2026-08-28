# Strategy Broker Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the 10 NFO-option-selling strategies place their own live orders directly against Kotak or Zerodha (not just Dhan), selected from a persistent dashboard broker picker, while market data keeps coming from Dhan.

**Architecture:** A new `lib/execution_broker.py` sits between a strategy and either `DhanHelper` (default, unchanged behavior) or a `ChildBroker` (`scripts/tools/child_brokers.py`, already used by the copy-trade bridge). Strategies gain a `--broker` CLI flag and swap their `helper.buy()/sell()` call sites for `broker.buy()/sell()`. The dashboard's existing `useBrokerSelector` hook (already supports dhan/zerodha/kotak, already localStorage-persisted) is surfaced on the Strategies page and threaded into the existing launch POST as an extra CLI arg.

**Tech Stack:** Python 3 (argparse, pytest), Next.js/TypeScript (existing `rs_dashboard` App Router conventions).

**Spec:** `docs/superpowers/specs/2026-08-28-strategy-broker-selector-design.md`

## Global Constraints

- In scope: `nifty_advanced_imbalance.py`, `nifty_delta_neutral.py`, `nifty_value_imbalance_straddle.py`, `nifty_value_imbalance_strangle.py`, `nifty_vwap_1min_straddle.py`, `nifty_vix_straddle.py`, `nifty_rolling_straddle.py` (all `strategies/value_imbalance/`), `strategies/spread_trend/nifty_spread_trend.py`, `strategies/oi_directional/nifty_oi_directional.py`, `strategies/st_oi_bearcall/nifty_st_oi_bearcall.py` — 10 scripts total.
- Out of scope, must NOT be touched: `strategies/crudeoil/*` (MCX futures), `strategies/momentum_investing/nifty500_momentum.py` (CNC equity), `strategies/intraday_equity/nifty50_vwap_rs.py` (not validated).
- Market data (LTP, candles, option chain, indicators) always comes from `DhanHelper`, regardless of the selected execution broker.
- SL/target/time exits on Zerodha/Kotak are software-managed only (no resting broker-side stop order) — this is a documented, accepted gap, not something to fix in this plan.
- A running strategy instance's broker is fixed at launch time (baked into its spawned CLI args); changing the dashboard's header selector afterward must not affect it.
- Every existing Dhan-only code path (no `--broker` flag, or `--broker dhan`) must be byte-for-byte behaviorally unchanged.

---

## Task 1: `lib/execution_broker.py` — core module

**Files:**
- Create: `lib/execution_broker.py`
- Test: `tests/test_execution_broker.py`

**Interfaces:**
- Consumes: `DhanHelper.find_option(underlying, expiry, strike, option_type)`, `.get_option_id(...)`, `.buy(symbol, qty, price=None, product="INTRADAY")`, `.sell(...)`, `.get_net_quantity(symbol)` (all pre-existing, `lib/dhan_helper.py`). `scripts.tools.child_brokers.create_broker(name, log=..., underlying=...)` returning a `ChildBroker` with `.init_instruments()`, `.verify_session()`, `.resolve_symbol(strike, expiry, opt_type)`, `.place_child_order(symbol, side, qty, product)`, `.map_product(*hints)`, `.positions_rows()` (all pre-existing, `scripts/tools/child_brokers.py`).
- Produces: `ExecutionBroker.create(broker: str, helper, underlying: str, log=print) -> ExecutionBroker`, raising `ExecutionBrokerError` on failure. Instance methods `buy(strike, expiry, opt_type, qty, product="INTRADAY") -> Optional[str]`, `sell(strike, expiry, opt_type, qty, product="INTRADAY") -> Optional[str]`, `get_owned_net_qty(strike, expiry, opt_type) -> int`. Module constant `EXECUTION_BROKERS = ("dhan", "zerodha", "kotak")`. Used by Task 2 (`lib/strategy_risk.py`) and Tasks 4-13 (strategy wiring).

- [ ] **Step 1: Write the failing tests**

```python
"""Broker-agnostic execution front: dhan pass-through must be behavior-
identical to calling DhanHelper directly; zerodha/kotak must route through
ChildBroker's resolve_symbol/place_child_order.

Run: venv\\Scripts\\python.exe -m pytest tests/test_execution_broker.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402


class FakeSec(dict):
    """Mimics the pandas-Series-like row DhanHelper.find_option() returns."""


class FakeHelper:
    def __init__(self):
        self.buy_calls = []
        self.sell_calls = []
        self.net_qty = 0

    def find_option(self, underlying, expiry, strike, option_type):
        return FakeSec(SECURITY_ID=f"{underlying}-{expiry}-{strike}-{option_type}")

    def get_option_id(self, underlying, strike, option_type, expiry):
        return None  # not needed when find_option succeeds

    def buy(self, symbol, qty, price=None, product="INTRADAY"):
        self.buy_calls.append((symbol, qty, product))
        return "DHAN-ORDER-1"

    def sell(self, symbol, qty, price=None, product="INTRADAY"):
        self.sell_calls.append((symbol, qty, product))
        return "DHAN-ORDER-2"

    def get_net_quantity(self, symbol):
        return self.net_qty


class FakeChild:
    name = "kotak"

    def __init__(self):
        self.placed = []
        self._positions = []

    def init_instruments(self):
        pass

    def verify_session(self):
        return True, "ok"

    def resolve_symbol(self, strike, expiry, opt_type):
        return f"SYM-{strike}-{opt_type}"

    def map_product(self, *hints):
        return "MIS"

    def place_child_order(self, symbol, side, qty, product):
        order_id = f"CHILD-{side}-{symbol}"
        self.placed.append((symbol, side, qty, product))
        return qty, [order_id], None

    def positions_rows(self):
        return self._positions


def test_dhan_buy_resolves_via_find_option_and_calls_helper_buy():
    helper = FakeHelper()
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    order_id = broker.buy(25000, "2026-09-25", "CE", 75)
    assert order_id == "DHAN-ORDER-1"
    assert helper.buy_calls == [("NIFTY-2026-09-25-25000-CE", 75, "INTRADAY")]


def test_dhan_sell_calls_helper_sell():
    helper = FakeHelper()
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    order_id = broker.sell(25100, "2026-09-25", "PE", 75)
    assert order_id == "DHAN-ORDER-2"
    assert helper.sell_calls == [("NIFTY-2026-09-25-25100-PE", 75, "INTRADAY")]


def test_dhan_get_owned_net_qty_reads_helper_net_quantity():
    helper = FakeHelper()
    helper.net_qty = -75
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    assert broker.get_owned_net_qty(25000, "2026-09-25", "CE") == -75


def test_kotak_buy_resolves_symbol_and_places_child_order():
    helper = FakeHelper()
    child = FakeChild()
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    order_id = broker.buy(25000, "2026-09-25", "CE", 75)
    assert order_id == "CHILD-BUY-SYM-25000-CE"
    assert child.placed == [("SYM-25000-CE", "BUY", 75, "MIS")]
    assert helper.buy_calls == []  # never touches Dhan for order placement


def test_kotak_get_owned_net_qty_reads_positions_rows():
    helper = FakeHelper()
    child = FakeChild()
    child._positions = [{"symbol": "SYM-25000-CE", "qty": -150}]
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    assert broker.get_owned_net_qty(25000, "2026-09-25", "CE") == -150


def test_unresolvable_symbol_returns_none_not_an_exception():
    helper = FakeHelper()
    child = FakeChild()
    child.resolve_symbol = lambda strike, expiry, opt_type: None
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    assert broker.buy(25000, "2026-09-25", "CE", 75) is None
    assert child.placed == []


def test_create_unknown_broker_raises_value_error():
    with pytest.raises(ValueError):
        ExecutionBroker.create("upstox", FakeHelper(), "NIFTY")


def test_create_child_broker_failure_raises_execution_broker_error(monkeypatch):
    import scripts.tools.child_brokers as child_brokers

    def boom(name, log=print, **kwargs):
        raise RuntimeError("Kotak auth failed — run kotak_autologin.py")

    monkeypatch.setattr(child_brokers, "create_broker", boom)
    with pytest.raises(ExecutionBrokerError):
        ExecutionBroker.create("kotak", FakeHelper(), "NIFTY")


def test_create_dead_session_raises_execution_broker_error(monkeypatch):
    import scripts.tools.child_brokers as child_brokers

    dead_child = FakeChild()
    dead_child.verify_session = lambda: (False, "Kotak token rejected")
    monkeypatch.setattr(child_brokers, "create_broker", lambda name, log=print, **kw: dead_child)
    with pytest.raises(ExecutionBrokerError):
        ExecutionBroker.create("kotak", FakeHelper(), "NIFTY")


def test_create_dhan_never_touches_child_brokers():
    broker = ExecutionBroker.create("dhan", FakeHelper(), "NIFTY")
    assert broker.broker == "dhan"
    assert broker.child is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv\Scripts\python.exe -m pytest tests/test_execution_broker.py -v`
Expected: FAIL / collection error — `lib.execution_broker` does not exist yet.

- [ ] **Step 3: Write the implementation**

```python
"""Broker-agnostic order execution front for live strategies.

Strategies resolve every leg by (strike, expiry, opt_type) already — this is
the one representation both DhanHelper and a ChildBroker (Zerodha/Kotak) can
turn into their own tradingsymbol, so it is the interface boundary here.

Market data (LTP, option chain, indicators) is NOT part of this module and
keeps coming from DhanHelper regardless of the selected execution broker —
see docs/superpowers/specs/2026-08-28-strategy-broker-selector-design.md.

`broker="dhan"` is a pure pass-through: it resolves the leg via the same
DhanHelper.find_option()/get_option_id() path `helper.option()` already uses,
then calls helper.buy()/sell() unchanged. Every strategy run without
--broker (or with --broker dhan) behaves exactly as before this module
existed.
"""
import logging

logger = logging.getLogger(__name__)

EXECUTION_BROKERS = ("dhan", "zerodha", "kotak")


class ExecutionBrokerError(Exception):
    """The selected execution broker could not be started (dead session,
    auth failure, unreachable API). Strategy main() should treat this as a
    startup failure and exit rather than trade with no working broker."""


class ExecutionBroker:
    def __init__(self, broker: str, helper, underlying: str, child=None, log=print):
        self.broker = broker
        self.helper = helper
        self.underlying = underlying
        self.child = child
        self.log = log

    @classmethod
    def create(cls, broker: str, helper, underlying: str, log=print) -> "ExecutionBroker":
        broker = str(broker or "dhan").lower()
        if broker not in EXECUTION_BROKERS:
            raise ValueError(f"Unknown execution broker: {broker!r}")
        if broker == "dhan":
            return cls(broker, helper, underlying, log=log)

        from scripts.tools.child_brokers import create_broker
        try:
            child = create_broker(broker, log=log, underlying=underlying)
            child.init_instruments()
        except Exception as e:
            raise ExecutionBrokerError(f"Could not start {broker} execution: {e}") from e
        ok, detail = child.verify_session()
        if not ok:
            raise ExecutionBrokerError(detail)
        return cls(broker, helper, underlying, child=child, log=log)

    # ── Dhan leg resolution (mirrors DhanHelper.option(), minus the quote) ──
    def _dhan_security_id(self, strike, expiry, opt_type):
        sec = self.helper.find_option(self.underlying, expiry, strike, opt_type)
        if sec is None:
            sec = self.helper.get_option_id(self.underlying, strike, opt_type, expiry)
        if sec is None:
            return None
        return str(sec["SECURITY_ID"])

    # ── orders ───────────────────────────────────────────────────────
    def buy(self, strike, expiry, opt_type, qty: int, product: str = "INTRADAY"):
        return self._place("BUY", strike, expiry, opt_type, qty, product)

    def sell(self, strike, expiry, opt_type, qty: int, product: str = "INTRADAY"):
        return self._place("SELL", strike, expiry, opt_type, qty, product)

    def _place(self, side, strike, expiry, opt_type, qty, product):
        if self.broker == "dhan":
            sec_id = self._dhan_security_id(strike, expiry, opt_type)
            if not sec_id:
                self.log(f"[execution_broker] Could not resolve {opt_type} {strike} "
                         f"({expiry}) on Dhan")
                return None
            fn = self.helper.buy if side == "BUY" else self.helper.sell
            return fn(sec_id, qty, product=product)

        symbol = self.child.resolve_symbol(strike, expiry, opt_type)
        if not symbol:
            self.log(f"[execution_broker] Could not resolve {opt_type} {strike} "
                     f"({expiry}) on {self.broker}")
            return None
        _, order_ids, err = self.child.place_child_order(
            symbol, side, qty, self.child.map_product(product))
        if err:
            self.log(f"[execution_broker] {self.broker} {side} {qty} {symbol} failed: {err}")
            return None
        return order_ids[-1] if order_ids else None

    def get_owned_net_qty(self, strike, expiry, opt_type) -> int:
        if self.broker == "dhan":
            sec_id = self._dhan_security_id(strike, expiry, opt_type)
            if not sec_id:
                return 0
            return int(self.helper.get_net_quantity(sec_id))

        symbol = self.child.resolve_symbol(strike, expiry, opt_type)
        if not symbol:
            return 0
        for row in self.child.positions_rows():
            if row["symbol"] == symbol:
                return int(row["qty"])
        return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv\Scripts\python.exe -m pytest tests/test_execution_broker.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution_broker.py tests/test_execution_broker.py
git commit -m "$(cat <<'EOF'
Add ExecutionBroker: broker-agnostic order front for strategies

Dhan mode is a pure pass-through to DhanHelper.buy/sell (unchanged
behavior). Zerodha/Kotak mode routes through the existing ChildBroker
used by the copy-trade bridge.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Generalize exit sizing in `lib/strategy_risk.py`

**Files:**
- Modify: `lib/strategy_risk.py`
- Test: `tests/test_strategy_risk.py`

**Interfaces:**
- Consumes: `ExecutionBroker.get_owned_net_qty(strike, expiry, opt_type)` (Task 1).
- Produces: `resolve_exit_qty_broker(broker: ExecutionBroker, strike, expiry, opt_type, own_qty, side, log=None) -> (qty, net_qty)`. Used by Tasks 4-10, 12-13 (the strategies that currently call `resolve_exit_qty`). The existing `resolve_exit_qty(helper, security_id, own_qty, side, log=None)` is left untouched — `strategies/intraday_equity/nifty50_vwap_rs.py` (out of scope) keeps calling it exactly as today.

- [ ] **Step 1: Write the failing test**

```python
"""resolve_exit_qty_broker must exit only what THIS strategy opened, clamped
by the execution broker's own position truth — the ExecutionBroker-based
sibling of resolve_exit_qty(), used by strategies wired for broker-selectable
execution (Task 1 onward).

Run: venv\\Scripts\\python.exe -m pytest tests/test_strategy_risk.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.strategy_risk import resolve_exit_qty_broker  # noqa: E402


class FakeBroker:
    def __init__(self, net_qty):
        self.net_qty = net_qty

    def get_owned_net_qty(self, strike, expiry, opt_type):
        return self.net_qty


def test_exits_own_qty_when_broker_confirms_enough_short():
    broker = FakeBroker(net_qty=-150)  # short 150 (2 lots)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 75
    assert net == -150


def test_clamps_to_broker_truth_when_sibling_already_closed_part():
    broker = FakeBroker(net_qty=-75)  # only 1 lot left, but this instance thinks it owns 2
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=150, side="BUY")
    assert qty == 75


def test_returns_zero_when_already_flat():
    broker = FakeBroker(net_qty=0)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 0


def test_returns_zero_when_own_qty_is_zero():
    broker = FakeBroker(net_qty=-150)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=0, side="BUY")
    assert qty == 0


def test_sell_side_closes_a_long_leg():
    broker = FakeBroker(net_qty=75)  # long 75
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "PE", own_qty=75, side="SELL")
    assert qty == 75


def test_lookup_failure_returns_zero_not_an_exception():
    class BoomBroker:
        def get_owned_net_qty(self, strike, expiry, opt_type):
            raise RuntimeError("Kotak order book unreadable")

    qty, net = resolve_exit_qty_broker(BoomBroker(), 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 0
    assert net == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `venv\Scripts\python.exe -m pytest tests/test_strategy_risk.py -v`
Expected: FAIL — `resolve_exit_qty_broker` not defined.

- [ ] **Step 3: Add the function** (append to `lib/strategy_risk.py`, below the existing `resolve_exit_qty`; do not modify the existing function or its docstring)

```python
def resolve_exit_qty_broker(broker, strike, expiry, opt_type, own_qty, side, log=None):
    """Like resolve_exit_qty(), but sized against an ExecutionBroker's own
    position truth instead of DhanHelper.get_net_quantity(). Used by
    strategies wired for broker-selectable execution (lib/execution_broker.py):
    on Kotak/Zerodha this reads that broker's own positions_rows(), so two
    instances sharing the SAME non-Dhan account are protected by the same
    "exit only what I opened" invariant that already covers Dhan.

    Args:
        broker: ExecutionBroker instance.
        strike, expiry, opt_type: the leg being closed.
        own_qty: quantity this strategy believes it holds (lots * lot_size).
        side: "BUY" to close a short leg, "SELL" to close a long leg.
        log: optional logger for the strategy (falls back to this module's).

    Returns:
        (qty, net_qty) where qty is the quantity to trade (0 = nothing to do)
        and net_qty is the raw broker net, for logging/diagnostics.
    """
    _log = log or logger
    side = str(side).upper()

    own_qty = int(own_qty or 0)
    if own_qty <= 0:
        return 0, 0

    try:
        net_qty = int(broker.get_owned_net_qty(strike, expiry, opt_type))
    except Exception as e:
        _log.error(f"resolve_exit_qty_broker: net quantity lookup failed for "
                   f"{opt_type} {strike} ({expiry}): {e}")
        return 0, 0

    available = -net_qty if side == "BUY" else net_qty
    if available <= 0:
        _log.info(
            f"Leg {opt_type} {strike} ({expiry}) already flat or reversed "
            f"(broker net {net_qty}, own {own_qty}). Skipping {side.lower()}-to-close."
        )
        return 0, net_qty

    qty = min(own_qty, available)
    if qty < own_qty:
        _log.warning(
            f"Leg {opt_type} {strike} ({expiry}): broker shows only {available} qty "
            f"available but this strategy tracks {own_qty}. Exiting {qty} — the rest "
            f"was closed elsewhere (another instance, manual square-off, or broker "
            f"auto-square-off)."
        )
    return qty, net_qty
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv\Scripts\python.exe -m pytest tests/test_strategy_risk.py -v`
Expected: all PASS. Also re-run `venv\Scripts\python.exe -m pytest tests/test_strategy_risk.py -k resolve_exit_qty -v` if an existing test file for the original function exists elsewhere — confirm no regression (there is none known as of this plan; grep `tests/` for `resolve_exit_qty` to double check before committing).

- [ ] **Step 5: Commit**

```bash
git add lib/strategy_risk.py tests/test_strategy_risk.py
git commit -m "$(cat <<'EOF'
Add resolve_exit_qty_broker for broker-selectable strategy exits

Generalizes the existing resolve_exit_qty safety invariant (exit only
what this instance opened, clamped by broker truth) to work against an
ExecutionBroker's own position snapshot, not just Dhan's. The original
resolve_exit_qty is untouched — intraday_equity keeps using it as-is.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `--broker` CLI flag in the strategy template

**Files:**
- Modify: `templates/strategy_template.py`

**Interfaces:**
- Consumes: `ExecutionBroker.create` (Task 1).
- Produces: the argparse + construction pattern every Task 4-13 script copies.

- [ ] **Step 1: Read the current template's argparse block and DhanHelper construction**

Run: `grep -n "add_argument\|get_dhan_client\|DhanHelper(" templates/strategy_template.py`

- [ ] **Step 2: Add the flag next to the existing `--live` flag**

```python
parser.add_argument(
    "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
    help="Execution broker for order placement. Market data always comes from Dhan. "
         "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
         "broker-side stop order)."
)
```

- [ ] **Step 3: Add broker construction immediately after `helper = DhanHelper(dhan)`**

```python
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
...
try:
    broker = ExecutionBroker.create(args.broker, helper, underlying="NIFTY", log=logger.info)
except ExecutionBrokerError as e:
    logger.error(f"Could not start {args.broker} execution: {e}")
    sys.exit(1)
```

- [ ] **Step 4: Verify the template still parses and runs its dry-run smoke path**

Run: `venv\Scripts\python.exe templates/strategy_template.py --help`
Expected: `--broker {dhan,zerodha,kotak}` appears in the help output; no traceback.

- [ ] **Step 5: Commit**

```bash
git add templates/strategy_template.py
git commit -m "$(cat <<'EOF'
Add --broker flag and ExecutionBroker wiring to the strategy template

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `strategies/value_imbalance/nifty_advanced_imbalance.py`

**Files:**
- Modify: `strategies/value_imbalance/nifty_advanced_imbalance.py`

**Interfaces:**
- Consumes: `ExecutionBroker` (Task 1), `resolve_exit_qty_broker` (Task 2), the `--broker` pattern (Task 3).

This is the fully worked example — Tasks 5-13 repeat this exact procedure against their own files' call sites, which will differ in line numbers and local variable names but follow the same rule.

- [ ] **Step 1: Add the flag and broker construction**

Apply Task 3's Step 2 and Step 3 changes to this file's own `argparse` setup and `main()`/`__init__`, using `underlying="NIFTY"`.

- [ ] **Step 2: Confirm every order call site**

Run: `grep -n "self\.helper\.\(buy\|sell\)(" strategies/value_imbalance/nifty_advanced_imbalance.py`
Expected lines (from current source): 363, 405, 441, 464, 488, 499, 512, 523, 842, 843, 848, 852, 1160, 1190, 1259, 1288, 1337, 1346, 1349, 1401.

- [ ] **Step 3: Replace each call**

The transformation rule: `self.helper.buy(symbol, qty, product=P)` where `symbol` was built from `(strike, expiry, opt_type)` becomes `self.broker.buy(strike, expiry, opt_type, qty, product=P)` — same for `sell`. Concretely, for the entry at line 363 (`self.helper.buy(self.pe_symbol_name, ce_lots_qty)` pattern — read the surrounding 10 lines first with `Read` to confirm the exact local variable names for strike/expiry at that call site, since they vary by branch: initial straddle entry uses `self.ce_strike`/`self.pe_strike`/`self.expiry`, later re-entry/roll branches use `self.candidate_strike`/`new_expiry`, etc.):

```python
# Before:
self.helper.buy(self.pe_symbol_name, qty)

# After:
self.broker.buy(self.pe_strike, self.expiry, "PE", qty)
```

Apply this pattern at every call site found in Step 2, substituting that call site's own strike/expiry/opt_type variables (verified by reading the surrounding code, not assumed).

- [ ] **Step 4: Replace `resolve_exit_qty` calls with `resolve_exit_qty_broker`**

Run: `grep -n "resolve_exit_qty" strategies/value_imbalance/nifty_advanced_imbalance.py`

```python
# Before:
qty, net = resolve_exit_qty(self.helper, self.ce_id, self.ce_lots * self.nifty_lot_size, "BUY")

# After:
qty, net = resolve_exit_qty_broker(self.broker, self.ce_strike, self.expiry, "CE",
                                   self.ce_lots * self.nifty_lot_size, "BUY")
```

Add `from lib.strategy_risk import resolve_exit_qty_broker` alongside the existing `resolve_exit_qty` import (leave the old import in place only if this file still needs it elsewhere — if this file no longer calls the old function anywhere after this step, remove the now-unused import).

- [ ] **Step 5: Add `"broker": args.broker` to the state dict**

Find the `save_strategy_state(...)` / `self.save_state(...)` call's payload construction and add the field.

- [ ] **Step 6: Dry-run smoke test (no live orders — market or after-hours, `--broker kotak` without `--live`)**

Run: `venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode winner_roll_atm --broker kotak`
Expected: process starts, logs `ExecutionBroker` construction succeeding (requires a valid `kotak_access_token.json` — run `kotak_autologin.py` first if it's stale), reaches its normal dry-run "would place order" logging without a traceback. Ctrl+C to stop; confirm `debug/nifty_advanced_imbalance_state.json` shows `"broker": "kotak"`.

- [ ] **Step 7: Regression check — default Dhan path unchanged**

Run: `venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode winner_roll_atm`
Expected: identical behavior/logs to before this task (aside from the added `"broker": "dhan"` state field).

- [ ] **Step 8: Commit**

```bash
git add strategies/value_imbalance/nifty_advanced_imbalance.py
git commit -m "$(cat <<'EOF'
Wire nifty_advanced_imbalance.py for broker-selectable execution

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `strategies/value_imbalance/nifty_delta_neutral.py`

**Files:** Modify `strategies/value_imbalance/nifty_delta_neutral.py`

Repeat Task 4's Steps 1-8 against this file:
- Step 2's discovery command: `grep -n "self\.helper\.\(buy\|sell\)(" strategies/value_imbalance/nifty_delta_neutral.py`
- Step 4's discovery command: `grep -n "resolve_exit_qty" strategies/value_imbalance/nifty_delta_neutral.py`
- Step 6's launch command: `venv\Scripts\python.exe strategies/value_imbalance/nifty_delta_neutral.py --broker kotak` (no `--live`)
- Step 7's launch command: same without `--broker`
- Note: `nifty_delta_neutral.py` deliberately skips the CE-strike > PE-strike inversion guard (per `CLAUDE.md`) — do not add it while wiring this file.
- Commit message: `Wire nifty_delta_neutral.py for broker-selectable execution`

---

## Task 6: Wire `strategies/value_imbalance/nifty_value_imbalance_straddle.py`

**Files:** Modify `strategies/value_imbalance/nifty_value_imbalance_straddle.py`

Repeat Task 4's Steps 1-8 against this file, substituting its own filename in every grep/run command from Task 5's pattern. Commit message: `Wire nifty_value_imbalance_straddle.py for broker-selectable execution`

---

## Task 7: Wire `strategies/value_imbalance/nifty_value_imbalance_strangle.py`

**Files:** Modify `strategies/value_imbalance/nifty_value_imbalance_strangle.py`

Repeat Task 4's Steps 1-8 against this file. Commit message: `Wire nifty_value_imbalance_strangle.py for broker-selectable execution`

---

## Task 8: Wire `strategies/value_imbalance/nifty_vwap_1min_straddle.py`

**Files:** Modify `strategies/value_imbalance/nifty_vwap_1min_straddle.py`

Repeat Task 4's Steps 1-8 against this file. Commit message: `Wire nifty_vwap_1min_straddle.py for broker-selectable execution`

---

## Task 9: Wire `strategies/value_imbalance/nifty_vix_straddle.py`

**Files:** Modify `strategies/value_imbalance/nifty_vix_straddle.py`

Repeat Task 4's Steps 1-8 against this file. This script's argparse setup does not call `resolve_exit_qty` (confirm with `grep -n "resolve_exit_qty" strategies/value_imbalance/nifty_vix_straddle.py` — if it returns nothing, skip Step 4 entirely rather than adding a new safety mechanism as part of this task). Commit message: `Wire nifty_vix_straddle.py for broker-selectable execution`

---

## Task 10: Wire `strategies/value_imbalance/nifty_rolling_straddle.py`

**Files:** Modify `strategies/value_imbalance/nifty_rolling_straddle.py`

Repeat Task 4's Steps 1-8 against this file. Commit message: `Wire nifty_rolling_straddle.py for broker-selectable execution`

---

## Task 11: Wire `strategies/spread_trend/nifty_spread_trend.py`

**Files:** Modify `strategies/spread_trend/nifty_spread_trend.py`

Repeat Task 4's Steps 1-8 against this file. This is a credit-spread strategy (short + long leg per side), so Step 2's grep will show two `buy`/`sell` pairs per entry/exit — apply the same substitution rule to both legs independently, each with its own strike. `grep -n "resolve_exit_qty" strategies/spread_trend/nifty_spread_trend.py` — if empty, skip Step 4 (per Task 9's note). Commit message: `Wire nifty_spread_trend.py for broker-selectable execution`

---

## Task 12: Wire `strategies/oi_directional/nifty_oi_directional.py`

**Files:** Modify `strategies/oi_directional/nifty_oi_directional.py`

Repeat Task 4's Steps 1-8 against this file (it does call `resolve_exit_qty` today — confirmed via repo grep, so Step 4 applies). Commit message: `Wire nifty_oi_directional.py for broker-selectable execution`

---

## Task 13: Wire `strategies/st_oi_bearcall/nifty_st_oi_bearcall.py`

**Files:** Modify `strategies/st_oi_bearcall/nifty_st_oi_bearcall.py`

Repeat Task 4's Steps 1-8 against this file. This is a bear-call-spread-only strategy (short + long leg), same two-legs note as Task 11 applies. `grep -n "resolve_exit_qty"` first to decide whether Step 4 applies. Commit message: `Wire nifty_st_oi_bearcall.py for broker-selectable execution`

---

## Task 14: Mark eligible strategies in `rs_dashboard/lib/strategyRegistry.ts`

**Files:**
- Modify: `rs_dashboard/lib/strategyRegistry.ts`

**Interfaces:**
- Produces: `execBrokerEligible?: boolean` field on each `STRATEGIES_METADATA` entry, read by Tasks 15, 17, 18.

- [ ] **Step 1: Read the current metadata type and entries**

The type is at line 20: `Record<string, { name: string; path: string; underlying: string }>`.

- [ ] **Step 2: Extend the type and mark the 10 eligible entries**

```typescript
export const STRATEGIES_METADATA: Record<string, {
  name: string; path: string; underlying: string; execBrokerEligible?: boolean;
}> = {
```

Add `execBrokerEligible: true,` to exactly the 10 entries whose `path` matches one of: `nifty_advanced_imbalance.py`, `nifty_delta_neutral.py`, `nifty_value_imbalance_straddle.py`, `nifty_value_imbalance_strangle.py`, `nifty_vwap_1min_straddle.py`, `nifty_vix_straddle.py`, `nifty_spread_trend.py`, `nifty_oi_directional.py`, `nifty_st_oi_bearcall.py`, `nifty_rolling_straddle.py`. Leave every other entry (the 4 `crudeoil` ones, `nifty50_vwap_rs.py`, `nifty500_momentum.py`) without the field (undefined = falsy = ineligible).

- [ ] **Step 3: Verify the dashboard still builds**

Run: `cd rs_dashboard && npm run build 2>&1 | tail -50`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/lib/strategyRegistry.ts
git commit -m "$(cat <<'EOF'
Mark the 10 option-selling strategies broker-execution-eligible

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Session pre-flight check + `--broker` pass-through in `/api/strategies`

**Files:**
- Create: `scripts/tools/verify_broker_session.py`
- Modify: `rs_dashboard/app/api/strategies/route.ts`

**Interfaces:**
- Consumes: `scripts.tools.child_brokers.create_broker` (existing), `STRATEGIES_METADATA[strategy].execBrokerEligible` (Task 14), `runPythonJson()` (existing, `rs_dashboard/lib/pyExec.ts`).
- Produces: `GET`-invocable one-shot script printing `{"ok": bool, "detail": str}` as its last stdout line, consumed by the route's `start` handler before spawning a non-Dhan run.

- [ ] **Step 1: Write the one-shot verification script**

```python
"""One-shot session check for a non-Dhan execution broker, invoked by the
dashboard's strategy launch route before spawning a strategy with
--broker zerodha|kotak. Prints exactly one JSON line to stdout.

Run: venv\\Scripts\\python.exe scripts/tools/verify_broker_session.py kotak
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.tools.child_brokers import create_broker  # noqa: E402


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("zerodha", "kotak"):
        print(json.dumps({"ok": False, "detail": "usage: verify_broker_session.py zerodha|kotak"}))
        sys.exit(1)
    name = sys.argv[1]
    try:
        child = create_broker(name, log=lambda m: None, underlying="NIFTY")
        ok, detail = child.verify_session()
    except Exception as e:
        ok, detail = False, str(e)
    print(json.dumps({"ok": ok, "detail": detail}))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Manual check (requires a real or deliberately expired Kotak session)**

Run: `venv\Scripts\python.exe scripts/tools/verify_broker_session.py kotak`
Expected: `{"ok": true, "detail": "Kotak session OK (net Rs ...)"}` with a valid session, or `{"ok": false, "detail": "Kotak session rejected (...) — run kotak_autologin.py --force"}` with an expired one.

- [ ] **Step 3: Wire the pre-flight into the route's `start` handler**

In `rs_dashboard/app/api/strategies/route.ts`, inside the `if (action === 'start')` block (after the "already running" check, before the shutdown-trigger cleanup at line ~202), add:

```typescript
import { runPythonJson } from '@/lib/pyExec';

// ... inside the start handler, after the already-running check:
const requestedBroker = typeof body.broker === 'string' ? body.broker : 'dhan';
const brokerEligible = !!meta.execBrokerEligible;
const effectiveBroker = brokerEligible ? requestedBroker : 'dhan';

if (effectiveBroker !== 'dhan') {
  const check = await runPythonJson<{ ok: boolean; detail: string }>(
    ['scripts/tools/verify_broker_session.py', effectiveBroker]
  );
  if (!check || !check.ok) {
    return NextResponse.json(
      { success: false, error: check?.detail || `${effectiveBroker} session check failed` },
      { status: 400 }
    );
  }
}
```

Then, where `cleanArgs` is built (existing `--instance-id` stripping loop), also strip any client-supplied `--broker` (never trust the raw `args` array for this — it must come only from `effectiveBroker`, decided server-side against `execBrokerEligible`):

```typescript
const cleanArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--instance-id') { i++; continue; }
  if (typeof args[i] === 'string' && args[i].startsWith('--instance-id=')) continue;
  if (args[i] === '--broker') { i++; continue; }
  if (typeof args[i] === 'string' && args[i].startsWith('--broker=')) continue;
  cleanArgs.push(args[i]);
}
if (effectiveBroker !== 'dhan') {
  cleanArgs.push('--broker', effectiveBroker);
}
```

Check `rs_dashboard/lib/pyExec.ts` for `runPythonJson`'s exact signature (array of args vs. a script path string plus args array) before writing this call — match whatever the existing call sites in this codebase use (e.g. other routes already call it for similar one-shot Python checks).

- [ ] **Step 4: Verify with the dashboard dev server**

Run: `cd rs_dashboard && npm run dev`, then from another terminal:
`curl -s -X POST http://localhost:3000/api/strategies -H "Content-Type: application/json" -d "{\"action\":\"start\",\"strategy\":\"advanced_imbalance\",\"args\":[],\"broker\":\"kotak\"}" --cookie "<dhan_session cookie>"`
Expected (expired/no Kotak session): `{"success": false, "error": "Kotak session rejected (...) "}`, HTTP 400, and no process spawned (`debug/nifty_advanced_imbalance_state.json` unchanged). With a valid session: `{"success": true, "pid": ...}` and the state file's initial write... continue to Task 16 before checking the `broker` field lands there (that's the strategy script's own write, verified in Task 4 Step 6).
Also verify: `POST` with `"strategy":"crudeoilm_supertrend","broker":"kotak"` (an ineligible strategy) spawns Dhan-only regardless — inspect the spawned `processArgs` in the server log line `Spawning background strategy: ...` and confirm no `--broker` flag appears.

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/verify_broker_session.py rs_dashboard/app/api/strategies/route.ts
git commit -m "$(cat <<'EOF'
Add broker session pre-flight and --broker pass-through to strategy launch

Server-side enforces execBrokerEligible rather than trusting the
client's args array, so a raw API call cannot force a non-Dhan broker
onto a strategy that was not wired for it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: `<BrokerSelector>` component on the Strategies page

**Files:**
- Create: `rs_dashboard/components/BrokerSelector.tsx`
- Modify: `rs_dashboard/app/strategies/page.tsx`

**Interfaces:**
- Consumes: `useBrokerSelector`, `BROKER_LABELS`, `type Broker` (existing, `rs_dashboard/hooks/useBrokerSelector.ts`).
- Produces: `<BrokerSelector />` (no props — self-contained, reads/writes the shared hook), rendered once on the Strategies page. Its selection is what Task 17/18 read when building launch args.

- [ ] **Step 1: Read the Strategies page's current header markup**

Run: `grep -n "export default function\|<h1\|className=\"sticky" rs_dashboard/app/strategies/page.tsx`

- [ ] **Step 2: Write the component**

```tsx
'use client';

import { useBrokerSelector, BROKER_LABELS, type Broker, BROKERS } from '@/hooks/useBrokerSelector';

/**
 * Global execution-broker picker for launching strategies. Persisted via
 * useBrokerSelector's localStorage key, so it stays consistent with the
 * Scalper/Advanced Scalper terminals' own broker selection. Only affects
 * strategies launched AFTER a selection change — a running instance keeps
 * whatever broker it was launched with.
 */
export default function BrokerSelector() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold text-zinc-400">EXECUTION BROKER</span>
      <select
        value={broker}
        onChange={e => setBroker(e.target.value as Broker)}
        className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                   rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500"
      >
        {BROKERS.map(b => (
          <option key={b} value={b} disabled={!authenticatedBrokers.includes(b)}>
            {BROKER_LABELS[b]}
          </option>
        ))}
      </select>
      {broker !== 'dhan' && (
        <span className="text-xs text-amber-400 font-semibold">
          Stop-loss is software-managed on {BROKER_LABELS[broker]} — no resting broker-side stop order.
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the Strategies page header**

Add `import BrokerSelector from '@/components/BrokerSelector';` and render `<BrokerSelector />` next to the page's existing title/header row (exact JSX placement depends on Step 1's findings — put it in the same sticky header bar as the page title, not inside the strategy list itself).

- [ ] **Step 4: Manual verification**

Run: `cd rs_dashboard && npm run dev`, open `/strategies`, confirm the selector renders, defaults to Dhan, switching to Kotak shows the software-managed-SL warning, and reloading the page keeps the selection (localStorage).

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/components/BrokerSelector.tsx rs_dashboard/app/strategies/page.tsx
git commit -m "$(cat <<'EOF'
Add execution-broker selector to the Strategies page header

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Wire `StrategyCard.tsx` to send and display the broker

**Files:**
- Modify: `rs_dashboard/components/StrategyCard.tsx`

**Interfaces:**
- Consumes: `useBrokerSelector` (existing hook), `meta.execBrokerEligible` (Task 14, via the `StrategyMeta` prop shape — extend its interface at line 14-17 to include `execBrokerEligible?: boolean`, threaded from wherever `StrategyCard` currently receives `meta` from the page/parent that reads `/api/strategies` GET response).
- Produces: the launch POST body gains `broker: <selected>` when eligible; the card's status area gains a broker badge read from `state.broker`.

- [ ] **Step 1: Read how `meta` flows into `StrategyCard` today**

Run: `grep -n "interface StrategyMeta\|meta:\|meta\.\|<StrategyCard" rs_dashboard/app/strategies/page.tsx rs_dashboard/components/StrategyCard.tsx | head -40`
Confirm whether `meta` already carries arbitrary fields from the `/api/strategies` GET response (`results[key].meta`) or is narrowed to `{key, name}` somewhere in between — if narrowed, widen that pass-through to include `execBrokerEligible` (the GET handler in Task 15's route already returns `meta.underlying`; add `meta.execBrokerEligible` there too, in the same object literal at `route.ts:114-120`).

- [ ] **Step 2: Add `execBrokerEligible` to the `StrategyMeta` interface and `broker` to `StrategyState`**

```typescript
interface StrategyMeta {
  key: string;
  name: string;
  execBrokerEligible?: boolean;
}
```

Add `broker?: string;` to the existing `StrategyState` interface (alongside `dry_run?: boolean;` etc., around line 39).

- [ ] **Step 3: Read the selected broker and include it in the launch body**

At the top of the component, add: `const { broker } = useBrokerSelector();` (import from `@/hooks/useBrokerSelector`).

At the `fetch('/api/strategies', ...)` call (line ~565), change:

```typescript
body: JSON.stringify({ action: 'start', strategy: meta.key, args, broker }),
```

(The server-side `route.ts` from Task 15 already ignores this for ineligible strategies, so no client-side eligibility branch is required here — but for clearer UX, disable/hide the broker selector's effect visually is handled centrally by `BrokerSelector` in Task 16, not per-card.)

- [ ] **Step 4: Display the running instance's broker**

Find where the card renders its status badges (near `<Badge>` usage for `status`/`dry_run`). Add:

```tsx
{state.broker && state.broker !== 'dhan' && (
  <Badge variant="outline" className="text-amber-400 border-amber-600">
    {state.broker.toUpperCase()}
  </Badge>
)}
```

- [ ] **Step 5: Manual verification**

With the dev server running, select Kotak in the header (Task 16), start an eligible strategy in dry-run, confirm the POST body (via browser devtools network tab) includes `"broker":"kotak"`, and once the state file (Task 4-13) writes `"broker":"kotak"`, confirm the badge appears on the card. Switch the header back to Dhan without stopping the running instance — confirm the badge stays `KOTAK` (it reads `state.broker`, not the live header selection).

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/components/StrategyCard.tsx rs_dashboard/app/api/strategies/route.ts
git commit -m "$(cat <<'EOF'
Send selected execution broker on strategy launch, show it on the card

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Wire `StrategyRowWide.tsx` the same way

**Files:**
- Modify: `rs_dashboard/components/StrategyRowWide.tsx` (or wherever `/strategies-plus` renders the wide-row variant — locate via `grep -rn "StrategyRowWide" rs_dashboard/app rs_dashboard/components` if the filename differs)

Per the existing `followup-strategy-launcher-duplication` note, `StrategyCard` and `StrategyRowWide` duplicate their entire launch-args construction — that duplication is not addressed by this plan (a separate, already-deferred cleanup). Apply Task 17's Steps 1-6 to this file's own copy of the launch POST and badge rendering, independently. Commit message: `Send selected execution broker on strategy launch from the wide row, show it inline`

---

## Task 19: Documentation

**Files:**
- Modify: `strategies/value_imbalance/strategy.md`, `strategies/spread_trend/strategy.md`, `strategies/oi_directional/strategy.md`, `strategies/st_oi_bearcall/strategy.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a short note to each of the 4 group `strategy.md` files**

```markdown
## Broker-selectable execution

This group supports `--broker {dhan,zerodha,kotak}` (default `dhan`). Market
data (LTP, option chain, indicators) always comes from Dhan regardless of the
selected execution broker. On Zerodha/Kotak, stop-loss/target/time exits are
software-managed only — the strategy loop detects the trigger and places a
market order to close; there is no resting broker-side stop order, unlike
Dhan's `place_sl_market()`. See
`docs/superpowers/specs/2026-08-28-strategy-broker-selector-design.md`.
```

- [ ] **Step 2: Add one line to `CLAUDE.md`'s Strategy Conventions section**, immediately after the existing `resolve_exit_qty` bullet:

```markdown
- The 10 NFO-option-selling strategies (`value_imbalance/`, `spread_trend/`, `st_oi_bearcall/`, `oi_directional/`) support `--broker {dhan,zerodha,kotak}` via `lib/execution_broker.py`, launched from the Strategies page's header broker selector. Market data stays Dhan-sourced regardless; Zerodha/Kotak exits are software-managed only (no resting SL order). `crudeoil/`, `momentum_investing/`, and `intraday_equity/` remain Dhan-only.
```

- [ ] **Step 3: Commit**

```bash
git add strategies/value_imbalance/strategy.md strategies/spread_trend/strategy.md strategies/oi_directional/strategy.md strategies/st_oi_bearcall/strategy.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Document broker-selectable execution for the 10 eligible strategies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
