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
