#!/usr/bin/env python
"""
Market data and order routing for the Focus Tool worker.

These two classes are the only genuinely schema-agnostic parts of the Focus
Tool: they speak in underlying / expiry / strike / option-type and know nothing
about rows, groups or exit rules. They were extracted here when the second,
unwired Focus Tool implementation was deleted — scripts/tools/focus_tool_rows_worker.py
had been importing them out of that module, which meant a dead rewrite could not
be removed without taking the live worker's plumbing with it.

  MarketData   spot, futures, expiries, contract lookup, LTPs, premium VWAP.
               Always Dhan, whichever broker the orders go to: an option's price
               is set by the exchange, not by the account you view it through.

  OrderRouter  places and closes legs on Dhan, Zerodha or Kotak. Dhan goes
               straight through DhanHelper; the others go through
               scripts/tools/child_brokers.py, the same abstraction the
               copy-trade bridge drives.
"""

import logging
from datetime import datetime, timedelta

# Cash-market exchange each underlying's options trade on, and the order segment
# that follows from it. SENSEX is the one that splits: its chain and contracts
# key on BSE / BSE_FNO while the index's own spot is served under IDX_I.
UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE'}
SPOT_IDS = {'NIFTY': 13, 'BANKNIFTY': 25, 'SENSEX': 51}

logger = logging.getLogger('focus_tool')


class MarketData:
    """Spot, futures, expiries, contract lookup, LTPs and premium VWAP.

    Everything is served off one DhanHelper regardless of which broker the user
    trades through — an option's price is the exchange's, not the broker's.
    """

    def __init__(self, helper):
        self.helper = helper
        self._fut_cache = {}        # underlying -> (date, security_id)
        self._expiry_cache = {}     # underlying -> (date, [expiries])
        self._leg_cache = {}        # (underlying, expiry, strike, opt) -> row
        self._lot_cache = {}        # underlying -> lot size
        self._last_spot = {}        # underlying -> last good spot

    # -- spot --------------------------------------------------------

    def spot(self, underlying):
        """Index spot, falling back to the last good reading rather than 0.

        NIFTY spot must be requested under IDX_I, not NSE, or it returns 0 (see
        nifty_oi_profile_fetch.py). A 0 here is not a price — it is a failed
        read, and every spot-driven rule treats it as "unknown" rather than as a
        level breach, so the fallback is a convenience, not a safety net.
        """
        sid = SPOT_IDS.get(underlying)
        if not sid:
            return 0.0
        try:
            ltp = self.helper.get_ltp(sid, exchange='IDX_I', instrument='INDEX') or 0.0
        except Exception as e:
            logger.warning(f'{underlying}: spot read failed: {e}')
            ltp = 0.0
        if ltp > 0:
            self._last_spot[underlying] = ltp
            return float(ltp)
        return float(self._last_spot.get(underlying, 0.0))

    # -- futures -----------------------------------------------------

    def future_id(self, underlying):
        """Nearest non-lapsed FUTIDX contract id, resolved once per day.

        find_future sorts by expiry but does NOT filter past ones, so it happily
        returns a contract that expired months ago. premarket_data's
        _find_nearest_future is the version that filters.
        """
        today = datetime.now().date()
        hit = self._fut_cache.get(underlying)
        if hit and hit[0] == today:
            return hit[1]
        try:
            from scripts.tools.premarket_data import _find_nearest_future
            exch = UNDERLYING_EXCHANGE.get(underlying, 'NSE')
            fut = _find_nearest_future(self.helper, underlying, exchange=exch, instrument='FUTIDX')
            sid = int(fut['SECURITY_ID']) if fut else None
        except Exception as e:
            logger.warning(f'{underlying}: futures lookup failed: {e}')
            sid = None
        self._fut_cache[underlying] = (today, sid)
        return sid

    def future_ltp(self, underlying):
        sid = self.future_id(underlying)
        if not sid:
            return 0.0
        seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
        try:
            return float(self.helper.get_ltp(sid, exchange=seg, instrument='FUTIDX') or 0.0)
        except Exception as e:
            logger.warning(f'{underlying}: futures LTP failed: {e}')
            return 0.0

    # -- expiry ------------------------------------------------------

    def nearest_expiry(self, underlying):
        """The nearest expiry on or after today. Cached per day — the list only
        changes when a contract lapses."""
        today = datetime.now().date()
        hit = self._expiry_cache.get(underlying)
        if hit and hit[0] == today:
            expiries = hit[1]
        else:
            try:
                expiries = self.helper.get_expiries(underlying) or []
            except Exception as e:
                logger.warning(f'{underlying}: expiry list failed: {e}')
                expiries = []
            self._expiry_cache[underlying] = (today, expiries)

        today_str = today.strftime('%Y-%m-%d')
        for e in sorted(expiries):
            if e >= today_str:
                return e
        return ''

    # -- contracts ---------------------------------------------------

    def leg(self, underlying, expiry, strike, opt_type):
        """Master-list row for one option leg, cached for the process lifetime
        (contract ids do not change)."""
        key = (underlying, expiry, int(strike), opt_type)
        if key in self._leg_cache:
            return self._leg_cache[key]
        exch = UNDERLYING_EXCHANGE.get(underlying, 'NSE')
        row = None
        try:
            row = self.helper.find_option(underlying, expiry, strike, opt_type, exchange=exch)
        except Exception as e:
            logger.warning(f'{underlying} {expiry} {strike}{opt_type}: lookup failed: {e}')
        self._leg_cache[key] = row
        return row

    def lot_size(self, underlying):
        """Lot size from the helper. No literal fallback anywhere: exchange lot
        sizes get revised (NIFTY has been 50, then 75, is 65 today) and a
        hardcoded default silently mis-sizes every order until someone notices.
        Returns None when unresolved, and the caller refuses to trade."""
        if underlying in self._lot_cache:
            return self._lot_cache[underlying]
        try:
            lot = int(self.helper.get_lot_size(underlying) or 0)
        except Exception as e:
            logger.warning(f'{underlying}: lot size lookup failed: {e}')
            lot = 0
        resolved = lot if lot > 1 else None
        self._lot_cache[underlying] = resolved
        return resolved

    def ltp(self, underlying, leg_row):
        if not leg_row:
            return 0.0
        seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
        try:
            return float(self.helper.get_ltp(
                int(leg_row['SECURITY_ID']), exchange=seg, instrument='OPTIDX') or 0.0)
        except Exception as e:
            logger.warning(f'LTP failed for {leg_row.get("SECURITY_ID")}: {e}')
            return 0.0

# ─── Order routing ────────────────────────────────────────────────

class OrderRouter:
    """Places and closes legs on whichever broker the config names.

    Dhan goes straight through DhanHelper. Zerodha and Kotak go through
    scripts/tools/child_brokers.py, which already owns each broker's instrument
    cache, symbol resolution and product mapping — the same abstraction the
    copy-trade bridge drives.

    In dry-run mode nothing is placed and every call reports success. That makes
    the whole rule engine exercisable end to end without money at risk, which is
    the only honest way to test a scheduler that trades.
    """

    def __init__(self, helper, market, broker, dry_run):
        self.helper = helper
        self.market = market
        self.broker = broker
        self.dry_run = dry_run
        self._children = {}   # underlying -> ChildBroker

    def _child(self, underlying):
        """Child brokers are instantiated lazily and per underlying: Kotak's
        instrument cache is scoped to one underlying by design."""
        if self.broker == 'dhan':
            return None
        key = underlying
        if key in self._children:
            return self._children[key]
        child = None
        try:
            from scripts.tools.child_brokers import ZerodhaChild, KotakChild
            cls = ZerodhaChild if self.broker == 'zerodha' else KotakChild
            child = cls.create(log=logger.info, underlying=underlying)
            if child:
                child.init_instruments()
        except Exception as e:
            logger.error(f'{self.broker}: child broker init failed for {underlying}: {e}')
            child = None
        self._children[key] = child
        return child

    def net_positions(self, underlyings=()):
        """One broker-truth snapshot of every open F&O leg: {key: signed qty}.

        The key is what that broker joins positions by — Dhan's numeric security
        id, everyone else's trading symbol — matching how `leg()` and
        `resolve_symbol()` identify a contract elsewhere in this module.

        Returns None if the book could not be read. That is NOT the same as an
        empty book, and callers reconciling a ledger against this must treat it
        as "unknown" and leave the ledger alone: writing a ledger down to zero on
        a failed HTTP call would silently abandon every open position.

        One call per tick, never one per leg — Dhan's REST budget is about a
        request a second account-wide.
        """
        if self.dry_run:
            return None

        if self.broker == 'dhan':
            try:
                df = self.helper.get_positions()
            except Exception as e:
                logger.warning(f'Position snapshot failed: {e}')
                return None
            if df is None:
                return None
            # An empty frame is only trustworthy when the call itself succeeded;
            # get_positions records the failure rather than raising.
            if getattr(self.helper, 'last_api_error', None):
                return None
            out = {}
            if not df.empty and 'securityId' in df.columns:
                for _, r in df.iterrows():
                    try:
                        out[str(int(r['securityId']))] = int(r.get('netQty') or 0)
                    except (TypeError, ValueError):
                        continue
            return out

        # ONE call, not one per underlying. Child brokers are instantiated per
        # underlying (Kotak's instrument cache is scoped that way), but both
        # brokers' positions_rows() returns the WHOLE ACCOUNT — Zerodha's
        # kite.positions() and Kotak's get_positions(client) alike. Asking each
        # of three underlyings' children therefore made three identical
        # account-wide calls on every reconcile. Any one session answers for
        # all of them, so the first one that initialises is used.
        for u in (underlyings or ()):
            child = self._child(u)
            if not child:
                continue
            try:
                return {str(r['symbol']): int(r.get('qty') or 0)
                        for r in child.positions_rows()}
            except Exception as e:
                logger.warning(f'{self.broker}: position snapshot failed via {u}: {e}')
                return None
        # No session at all — unknown, not empty.
        return None

    def position_key(self, underlying, expiry, strike, opt_type):
        """The key `net_positions` would file this leg under, or None."""
        if self.broker == 'dhan':
            row = self.market.leg(underlying, expiry, strike, opt_type)
            if row is None:
                return None
            try:
                return str(int(row['SECURITY_ID']))
            except (TypeError, ValueError, KeyError):
                return None
        child = self._child(underlying)
        if not child:
            return None
        try:
            return child.resolve_symbol(strike, expiry, opt_type) or None
        except Exception:
            return None

    def read_fill(self, order_id):
        """What an order ACTUALLY did: {'qty': int, 'price': float} or None.

        A broker ACK is not a fill, so the ledger must not record one off the
        ACK alone — that stores a position that may not exist at a price that
        was never paid. This does a SINGLE non-blocking read of the order and
        returns None unless it has actually traded.

        Never called on the tick thread: the order-update callback calls it the
        moment the socket reports a terminal status. Returns None for "not
        confirmed", which callers must treat as unknown, never as filled.
        """
        try:
            detail = self.helper.get_order_by_id(str(order_id)) or {}
        except Exception as e:
            logger.warning(f'Fill read failed for order {order_id}: {e}')
            return None
        status = str(detail.get('orderStatus') or detail.get('status') or '').upper()
        if status and status != 'TRADED':
            return None

        def pick(*names):
            for n in names:
                v = detail.get(n)
                if v not in (None, ''):
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        continue
            return None

        # Dhan has spelled these differently across SDK versions; take whichever
        # the payload actually carries rather than pinning one name.
        qty = pick('filledQty', 'filled_qty', 'tradedQuantity', 'quantity')
        price = pick('averageTradedPrice', 'average_traded_price', 'tradedPrice', 'price')
        if not qty or qty <= 0:
            return None
        return {'qty': int(qty), 'price': float(price or 0.0)}

    def place(self, underlying, expiry, strike, opt_type, side, qty, product):
        """(ok, detail, order_id). `qty` is absolute units, never lots.

        Returns as soon as the broker ACKs. `order_id` is the handle to settle
        the real fill against later — see confirm_fill, which the caller runs
        off the tick thread. None when there is no id to track (dry run, or a
        child broker that reports no usable id).
        """
        if self.dry_run:
            return True, f'DRY-RUN {side} {qty} {underlying} {expiry} {int(strike)}{opt_type}', None

        if self.broker == 'dhan':
            row = self.market.leg(underlying, expiry, strike, opt_type)
            if not row:
                return False, f'Contract not found: {underlying} {expiry} {int(strike)}{opt_type}', None
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            try:
                order_id = self.helper.place_order(
                    security_id=str(int(row['SECURITY_ID'])), exchange_segment=seg,
                    transaction_type=side, quantity=int(qty), order_type='MARKET',
                    product_type=product, price=0.0)
            except Exception as e:
                return False, f'Order failed: {e}', None
            if not order_id:
                return False, 'Order rejected by broker', None
            # Deliberately does NOT wait for the fill. This runs on the worker's
            # single tick thread, and blocking it to confirm one leg stalls the
            # exit rules for every OTHER row — on a scalper terminal that trade
            # is never worth making. The caller records the leg as unconfirmed
            # against this order id, and the order-update callback (or the next
            # reconcile) settles the real price and quantity out of band.
            return True, str(order_id), str(order_id)

        child = self._child(underlying)
        if not child:
            return False, f'{self.broker} session unavailable', None
        try:
            symbol = child.resolve_symbol(strike, expiry, opt_type)
            if not symbol:
                return False, f'{self.broker}: no symbol for {int(strike)}{opt_type} {expiry}', None
            mapped = child.map_product(product)
            placed, order_ids, err = child.place_child_order(symbol, side, int(qty), mapped)
            if err:
                return False, f'{self.broker}: {err} (placed {placed}/{qty})', None
            if placed < qty:
                return False, f'{self.broker}: partial fill {placed}/{qty}', None
            # No fill confirmation for child brokers: ChildBroker has no
            # equivalent of Dhan's order-update socket, and `placed` is what the
            # broker accepted, not what traded. The caller falls back to an LTP
            # estimate and flags the leg unconfirmed; reconcile() sizes it
            # against the position book on a later tick.
            return True, ','.join(str(o) for o in order_ids), None
        except Exception as e:
            return False, f'{self.broker}: {e}', None

    def close(self, underlying, expiry, strike, opt_type, side, own_qty, product,
              net_hint=None):
        """Close a leg this worker opened. `side` is the closing direction:
        BUY to cover a short, SELL to exit a long.

        On Dhan the size is resolved through strategy_risk.resolve_exit_qty so
        the order can never exceed what this worker actually opened AND what the
        broker still shows in that direction. That matters because Dhan nets by
        security id — a strategy running the same strike shares the position.
        """
        if self.dry_run:
            return True, f'DRY-RUN close {side} {own_qty} {underlying} {int(strike)}{opt_type}'

        if self.broker == 'dhan':
            row = self.market.leg(underlying, expiry, strike, opt_type)
            if not row:
                return False, f'Contract not found for exit: {int(strike)}{opt_type}'
            sec_id = str(int(row['SECURITY_ID']))
            if net_hint is not None:
                # The caller already has a fresh position snapshot, so the exit
                # is sized from it rather than re-fetching the whole book on the
                # critical path of the close order. Same clamp as
                # resolve_exit_qty — exit what we opened, never more than the
                # broker still shows in our direction — just without the extra
                # ~50-100ms round trip in front of every exit.
                net = int(net_hint)
                available = -net if side == 'BUY' else net
                qty = min(int(own_qty), available) if available > 0 else 0
                if 0 < qty < int(own_qty):
                    logger.warning(f'Leg {sec_id}: broker shows only {available} available but this '
                                   f'worker tracks {own_qty}. Exiting {qty} — the rest went elsewhere.')
            else:
                try:
                    from lib.strategy_risk import resolve_exit_qty
                    qty, net = resolve_exit_qty(self.helper, sec_id, own_qty, side, log=logger)
                except Exception as e:
                    return False, f'Exit sizing failed: {e}'
            if qty <= 0:
                # Already flat — closed by another instance, manually, or by the
                # broker. Report success so the row settles rather than retrying
                # an order that has nothing to close.
                return True, f'already flat (broker net {net})'
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            try:
                order_id = self.helper.place_order(
                    security_id=sec_id, exchange_segment=seg, transaction_type=side,
                    quantity=int(qty), order_type='MARKET', product_type=product, price=0.0)
            except Exception as e:
                return False, f'Exit order failed: {e}'
            return (True, str(order_id)) if order_id else (False, 'Exit order rejected')

        # Child brokers key positions by trading symbol, and their own
        # close_position clamps to the held quantity.
        child = self._child(underlying)
        if not child:
            return False, f'{self.broker} session unavailable'
        try:
            symbol = child.resolve_symbol(strike, expiry, opt_type)
            if not symbol:
                return False, f'{self.broker}: no symbol for exit {int(strike)}{opt_type}'
            placed, order_ids, err = child.place_child_order(
                symbol, side, int(own_qty), child.map_product(product))
            if err:
                return False, f'{self.broker}: {err} (placed {placed}/{own_qty})'
            return True, ','.join(str(o) for o in order_ids)
        except Exception as e:
            return False, f'{self.broker}: {e}'
