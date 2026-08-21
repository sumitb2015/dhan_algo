"""
Child-broker abstraction for the Dhan -> (Zerodha | Kotak) copy-trade bridge.

The bridge used to hold one module-level `kite` handle and route every
configured child through it — `child['broker']` only ever labelled the log
entry. This module is the seam that makes a second child broker possible: each
implementation owns its own client, instrument cache, margin state and position
snapshot, and the bridge drives them all through one interface.

`ZerodhaChild` is a straight move of the bridge's previous kite-based functions.
Its behaviour must not change — every safety property below was learned from a
real desync, and the whole point of concentrating the risk in `KotakChild` is
that the Zerodha path stays byte-for-byte equivalent in effect.

The invariants, which apply to BOTH brokers:

  1. **A reducing order is never margin-blocked.** Refusing an exit strands a
     naked position, which is far worse than any margin rejection, and closing a
     position releases margin rather than consuming it.
  2. **Unknown margin state fails OPEN.** A blocked entry is itself a
     parent/child desync, so we never block on a figure we could not fetch.
  3. **A stale position snapshot fails OPEN**, because without it the fast path
     cannot prove an order is not an exit.
  4. **The fast path never makes an HTTP call.** It runs on the order-update WS
     callback thread, where a round-trip stalls event delivery and can drop the
     connection.
  5. **Premium is paid from cash, not collateral.** A BUY that opens exposure is
     a debit; `margin['available']` is the NET figure and includes pledged
     collateral, so it can cover an order the broker then rejects for want of
     cash. Checked separately, and only for orders that increase exposure.

The one deliberate asymmetry is `supports_exact_margin`. Zerodha prices a real
basket (`basket_order_margins`) so a block on the retry path is broker truth and
terminal. Kotak has no basket endpoint, so its "exact" recheck is still an
estimate — the bridge must not treat a Kotak block as final.
"""
import math
import threading
import time
from datetime import datetime

MARGIN_BLOCKED = 'MARGIN_BLOCKED'

# Past this age the fast path stops trusting its cached position snapshot and
# fails open rather than risk mistaking an exit for an entry.
POSITIONS_MAX_AGE_SEC = 20

# NFO NIFTY options freeze quantity — market orders above this are rejected.
# Kotak overrides this from its own master (lFreezeQty), which is 1801.
DEFAULT_FREEZE_QTY = 1800

# Last-resort lot size, used only when a symbol is absent from the child's own
# instrument cache. Exchange lot sizes get revised (NIFTY has been 50, then 75,
# and is 65 today), so this is NOT a literal anyone should rely on: the bridge
# calls set_default_lot_size() at startup with DhanHelper.get_lot_size('NIFTY').
# This module stays free of pandas/DhanHelper imports on purpose — the fast path
# runs on the order-update WS callback thread — hence injection rather than a
# direct call. The value below only survives if that injection never happens.
DEFAULT_LOT_SIZE = 65


def set_default_lot_size(size) -> bool:
    """Point the fallback at the library-resolved lot size. Returns True if set."""
    global DEFAULT_LOT_SIZE
    try:
        value = int(size)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False
    DEFAULT_LOT_SIZE = value
    return True

INSTRUMENTS_REFRESH_MIN_INTERVAL_SEC = 600


def find_option_symbol(instruments: list, strike, expiry: str, opt_type: str):
    """Match a (strike, expiry, opt_type) triple to a cached contract's symbol.

    Works for either broker: both instrument caches are written in the same row
    shape precisely so this stays broker-agnostic.
    """
    try:
        strike_f = float(strike)
    except (TypeError, ValueError):
        return None
    for inst in instruments:
        if (inst.get('expiry') == expiry
                and inst.get('instrument_type') == opt_type
                and float(inst.get('strike', -1)) == strike_f):
            return inst.get('tradingsymbol')
    return None


class ChildBroker:
    """Interface + the margin/position machinery shared by every child broker.

    Subclasses implement only the broker-specific primitives (the `_`-prefixed
    methods plus map_product / find_recent_matching_order / verify_session /
    load_instruments); everything safety-critical lives here so the two brokers
    cannot drift apart on it.
    """

    name = 'child'
    supports_exact_margin = False

    def __init__(self, log=print):
        self.log = log
        self.freeze_qty = DEFAULT_FREEZE_QTY
        self._instruments = []
        self._symbols = set()
        self._instruments_refreshed_at = 0.0
        self._margin_probe_symbol = None

        # Guards the positions map only. The scalar fields need no lock: each is
        # replaced by a single assignment, so a reader sees either the old or the
        # new value, never a torn one.
        #
        # 'positions' is the exception, because it is read-modify-written by
        # note_position_delta (WS thread) while the watchdog rebinds it
        # wholesale. Unsynchronised, a delta applied between the watchdog's read
        # and its assignment lands on the discarded dict and is lost — and a lost
        # delta makes a just-opened position look flat, so the exit that follows
        # is classified as an entry and can be margin-blocked.
        self._positions_lock = threading.Lock()
        self.margin = {
            'available': None,      # total capacity; None = unknown -> fail open
            'cash': None,           # what option premium can actually be paid from
            'per_lot': None,        # measured margin for a 1-lot short (fast path)
            'lot_size': DEFAULT_LOT_SIZE,
            'updated_ts': 0.0,
            'error': None,
            'blocked_count': 0,
            'positions': None,
            'positions_ts': 0.0,
        }

    # ── instruments ──────────────────────────────────────────────────

    def load_instruments(self) -> list:
        raise NotImplementedError

    def _refresh_instruments_cache(self) -> bool:
        """Regenerate the on-disk instrument cache. Blocking. Returns success."""
        raise NotImplementedError

    def init_instruments(self):
        self._set_instruments(self.load_instruments())
        self._instruments_refreshed_at = time.time()

    def _set_instruments(self, instruments: list):
        self._instruments = instruments
        self._symbols = {i.get('tradingsymbol') for i in instruments}

    @property
    def instruments(self) -> list:
        return self._instruments

    def symbols(self) -> set:
        return self._symbols

    def find_symbol(self, strike, expiry, opt_type):
        """Fast in-memory lookup. Safe to call from the WS callback thread."""
        return find_option_symbol(self._instruments, strike, expiry, opt_type)

    def refresh_instruments(self) -> bool:
        """On a lookup miss (e.g. a strike the exchange added intraday),
        regenerate the cache once and reload — throttled so a genuinely
        unsupported instrument cannot hammer the broker API."""
        if time.time() - self._instruments_refreshed_at < INSTRUMENTS_REFRESH_MIN_INTERVAL_SEC:
            return False
        self._instruments_refreshed_at = time.time()
        try:
            if not self._refresh_instruments_cache():
                return False
            self._set_instruments(self.load_instruments())
            self.log(f'[{self.name}] Instrument cache refreshed ({len(self._instruments)} contracts)')
            return True
        except Exception as e:
            self.log(f'[{self.name}] Instrument cache refresh failed: {e}')
            return False

    def resolve_symbol(self, strike, expiry, opt_type):
        """Lookup with a one-shot (throttled) cache refresh on miss. Blocking —
        only ever call from the watchdog thread, never the WS callback."""
        sym = self.find_symbol(strike, expiry, opt_type)
        if sym is None and self.refresh_instruments():
            sym = self.find_symbol(strike, expiry, opt_type)
        return sym

    def expiries(self, on_or_after: str = None) -> list:
        out = {i.get('expiry') for i in self._instruments if i.get('expiry')}
        if on_or_after:
            out = {e for e in out if e >= on_or_after}
        return sorted(out)

    def lot_size_for(self, symbol) -> int:
        for i in self._instruments:
            if i.get('tradingsymbol') == symbol:
                try:
                    return int(i.get('lot_size') or DEFAULT_LOT_SIZE)
                except (TypeError, ValueError):
                    break
        return DEFAULT_LOT_SIZE

    # ── session ──────────────────────────────────────────────────────

    def verify_session(self):
        """Prove the session actually works. Returns (ok, detail).

        Restoring a session from a token file never contacts the broker, so an
        overnight-expired token yields a perfectly healthy-looking client.
        Without this probe the bridge reaches RUNNING, then fails EVERY
        replication and desyncs the session while the dashboard shows a green
        heartbeat.
        """
        raise NotImplementedError

    # ── products ─────────────────────────────────────────────────────

    def map_product(self, *hints):
        """Map a Dhan order's product to this broker's equivalent.

        Multiple hints are required because the two fill sources disagree on
        field names: the order-update WS carries NO 'productType' key — it sends
        'productName' ('INTRADAY'/'MARGIN'/'CNC') plus a single-letter 'product'
        ('I'/'M'/'C'). Only the REST order list sends 'productType'. Reading just
        'productType' silently mapped every WS-delivered fill to MIS, which is
        how a MARGIN parent ended up auto-squared off at ~15:20 while the parent
        still held.
        """
        raise NotImplementedError

    # ── positions ────────────────────────────────────────────────────

    def positions_rows(self) -> list:
        """Normalised open positions: [{'symbol', 'qty' (signed), 'product',
        'exchange'}]. Raises on failure — callers must not read an exception as
        "flat"."""
        raise NotImplementedError

    def note_position_delta(self, symbol: str, side: str, qty: int):
        """Optimistically fold a just-placed order into the cached position map.

        Only ever makes the broker MORE aware of exposure it holds, so its only
        possible effect on check_margin is to classify a follow-up order as
        reducing and skip the gate. It can never manufacture a false block —
        which is why it is safe to apply before the fill is confirmed, and why an
        order later rejected leaves the cache merely pessimistic rather than
        dangerous. The next snapshot refresh replaces this with broker truth.
        """
        signed = int(qty) if str(side).upper() == 'BUY' else -int(qty)
        with self._positions_lock:
            pos = self.margin.get('positions')
            if pos is None:
                return
            pos[symbol] = pos.get(symbol, 0) + signed

    def set_position_snapshot(self, positions: dict):
        """Replace the cached position map with broker truth, under the lock so a
        concurrent note_position_delta cannot be silently dropped."""
        with self._positions_lock:
            self.margin['positions'] = positions
            self.margin['positions_ts'] = time.time()

    def refresh_positions(self) -> bool:
        """Pull a fresh position snapshot for the fast-path gate.

        On failure the previous snapshot is left in place; check_margin ages it
        out on its own and fails open once it is too old to trust.
        """
        try:
            self.set_position_snapshot({r['symbol']: r['qty'] for r in self.positions_rows()})
            return True
        except Exception:
            return False

    # ── margin ───────────────────────────────────────────────────────

    def _fetch_margin(self):
        """(snapshot_dict, error) — {'net', 'cash', ...}."""
        raise NotImplementedError

    def _measure_per_lot(self, symbol: str, qty: int, product: str):
        """(rupees_per_lot, error) for a 1-lot short of `symbol`."""
        raise NotImplementedError

    def refresh_margin(self) -> bool:
        """Refresh available funds. Doubles as the connection keep-alive.

        On error the figure drops to "unknown" rather than keeping a stale one:
        the gate fails open on None, which is the right call when we cannot see
        the account. Stale numbers could block real trades (or wave through
        unaffordable ones) for hours.
        """
        snap, err = self._fetch_margin()
        if err:
            self.margin['available'] = None
            self.margin['cash'] = None
            self.margin['error'] = err
            return False
        self.margin['available'] = snap['net']
        self.margin['cash'] = snap['cash']
        self.margin['error'] = None
        self.margin['updated_ts'] = time.time()
        return True

    def set_margin_probe(self, symbol: str):
        """Pin the representative contract whose per-lot margin the fast path uses."""
        self._margin_probe_symbol = symbol
        if symbol:
            self.margin['lot_size'] = self.lot_size_for(symbol)

    @property
    def margin_probe_symbol(self):
        return self._margin_probe_symbol

    def refresh_per_lot(self, product: str) -> bool:
        """Re-measure the representative per-lot margin used by the fast path."""
        if not self._margin_probe_symbol:
            return False
        per_lot, err = self._measure_per_lot(
            self._margin_probe_symbol, self.margin.get('lot_size') or DEFAULT_LOT_SIZE, str(product))
        if err:
            self.margin['error'] = f'per-lot probe failed: {err}'
            return False
        if per_lot and per_lot > 0:
            self.margin['per_lot'] = per_lot
            return True
        return False

    def check_margin(self, symbol: str, side: str, qty: int, product, exact: bool = False,
                     price=None):
        """Can the child afford this order? Returns (ok, detail_dict).

        See the module docstring — rules 1 through 5 are all enforced here, and
        every uncertain branch deliberately allows the order through.

        `exact=False` (the WS callback thread) uses only cached scalars — no
        HTTP, so event delivery is never stalled. `exact=True` (the watchdog
        thread, where find_recent_matching_order already blocks) may hit the API,
        but only does so where the broker can genuinely price a basket.

        `price` is the parent fill's traded price, carried down from the order
        update so rule 5 costs no extra call. Absent, the cash check is skipped
        rather than guessed.
        """
        detail = {'mode': 'exact' if exact and self.supports_exact_margin else 'cached',
                  'broker': self.name}

        # Rule 1 — reducing orders bypass the gate entirely, on BOTH paths.
        if exact and self.supports_exact_margin:
            try:
                held = self._held_qty_live(symbol)
            except Exception as e:
                detail['error'] = f'position fetch failed: {e}'
                detail['failed_open'] = True
                return True, detail
        else:
            positions = self.margin.get('positions')
            age = time.time() - (self.margin.get('positions_ts') or 0.0)
            if positions is None or age > POSITIONS_MAX_AGE_SEC:
                detail['error'] = (f'position snapshot {"missing" if positions is None else f"stale ({age:.0f}s)"}'
                                   ' — cannot prove this is not an exit')
                detail['failed_open'] = True
                return True, detail
            held = int(positions.get(symbol, 0))
            detail['positions_age_sec'] = round(age, 1)
        detail['held_qty'] = held
        if _is_reducing(held, side, qty):
            detail['skipped'] = 'reducing existing exposure — not gated'
            return True, detail

        # Rule 5 — a BUY that OPENS exposure is a premium debit, payable only
        # from cash. Deliberately placed AFTER the reducing bypass so buying
        # back a short is still never gated, and it fails OPEN on an unknown
        # price or unknown cash (rule 2). No HTTP: `price` rode in on the fill.
        if str(side).upper() == 'BUY':
            cash = self.margin.get('cash')
            if not price:
                detail['cash_check'] = 'no fill price on the parent order — not gated'
            elif cash is None:
                detail['cash_check'] = 'cash balance unknown — not gated'
                detail['failed_open'] = True
            else:
                premium = float(price) * qty
                detail['premium'] = round(premium, 2)
                detail['cash'] = round(cash, 2)
                if premium > cash:
                    detail['blocked_on'] = 'cash'
                    detail['required'] = round(premium, 2)
                    detail['available'] = round(cash, 2)
                    detail['shortfall'] = round(premium - cash, 2)
                    return False, detail

        available = self.margin['available']
        if available is None:
            detail['error'] = self.margin.get('error') or 'margin state not yet populated'
            detail['failed_open'] = True
            return True, detail
        detail['available'] = round(available, 2)

        if exact and self.supports_exact_margin:
            required, err = self._required_margin_exact(symbol, side, qty, product)
            if err:
                detail['error'] = f'basket margin failed: {err}'
                detail['failed_open'] = True
                return True, detail
        else:
            per_lot = self.margin['per_lot']
            if per_lot is None:
                detail['error'] = 'per-lot margin not yet measured'
                detail['failed_open'] = True
                return True, detail
            lot_size = self.margin.get('lot_size') or DEFAULT_LOT_SIZE
            # Deliberately a ceiling: a part-lot quantity still reserves a whole
            # lot's worth of risk, and rounding down here would wave through the
            # order that tips the account over.
            lots = max(1, math.ceil(qty / lot_size))
            required = per_lot * lots
            detail['per_lot'] = round(per_lot, 2)
            detail['lots'] = lots

        detail['required'] = round(required, 2)
        if required <= available:
            return True, detail
        detail['shortfall'] = round(required - available, 2)
        return False, detail

    def _held_qty_live(self, symbol: str) -> int:
        """Signed net qty straight from the broker (exact path only)."""
        for row in self.positions_rows():
            if row['symbol'] == symbol:
                return int(row['qty'])
        return 0

    def _required_margin_exact(self, symbol, side, qty, product):
        raise NotImplementedError

    # ── orders ───────────────────────────────────────────────────────

    def _place_one(self, symbol: str, side: str, qty: int, product):
        """Place ONE market order slice. Returns an order id, or raises."""
        raise NotImplementedError

    def place_child_order(self, symbol: str, side: str, qty: int, product=None,
                          margin_check: bool = False, exact_margin: bool = False,
                          detail_out: dict = None, price=None):
        """Place a MARKET order sliced to the freeze quantity.

        With `margin_check=True`, an unaffordable order is refused before
        anything is placed and the error is the MARGIN_BLOCKED sentinel.

        Returns (placed_qty, order_ids, error) — never raises. On a mid-slice
        failure, placed_qty reflects what actually went through, so the caller
        can queue exactly the remainder for retry (re-placing the full qty would
        duplicate the successful slices).
        """
        if product is None:
            product = self.default_product
        if margin_check:
            ok, detail = self.check_margin(symbol, side, qty, product, exact=exact_margin,
                                           price=price)
            # Report via a caller-supplied dict, not shared state: the WS thread
            # and the watchdog thread can both be in here at once, and a shared
            # "last block" slot lets one thread's numbers end up in the other's
            # log entry.
            if detail_out is not None:
                detail_out.clear()
                detail_out.update(detail)
            if not ok:
                self.margin['blocked_count'] += 1
                self.log(f'[{self.name}] MARGIN BLOCKED '
                         f'({detail.get("blocked_on", "margin")}, {detail.get("mode")}) '
                         f'{side} {qty} {symbol}: '
                         f'needs Rs {detail.get("required", 0):,.2f}, have Rs {detail.get("available", 0):,.2f} '
                         f'(short Rs {detail.get("shortfall", 0):,.2f})')
                return 0, [], MARGIN_BLOCKED
        order_ids = []
        placed = 0
        remaining = qty
        while remaining > 0:
            chunk = min(remaining, self.freeze_qty)
            try:
                order_id = self._place_one(symbol, side, chunk, product)
            except Exception as e:
                return placed, order_ids, str(e)
            order_ids.append(order_id)
            placed += chunk
            remaining -= chunk
            # Keep the cached position map current between snapshot refreshes so
            # an exit arriving seconds after its entry is still recognised as
            # reducing (and therefore never gated).
            self.note_position_delta(symbol, side, chunk)
        return placed, order_ids, None

    def find_recent_matching_order(self, symbol: str, side: str, qty: int, since_ts):
        """Best-effort dedup check before RE-trying a chunk whose previous
        placement raised — the request may have reached the broker even though
        the response was lost, and a blind retry would double the position.
        Neither broker offers a client-supplied idempotency key, so this can only
        match on symbol/side/qty/time, not guarantee identity.

        Returns the matching order id, or None (verify failed or no match — the
        caller should fall through to a normal retry either way). Only called
        from the watchdog thread, since it is an extra blocking call.
        """
        raise NotImplementedError

    def close_position(self, row: dict, qty: int, side: str):
        """Force-close `qty` of a held position (safety exit). Returns an order
        id, or raises. Takes the whole normalised row so the close inherits the
        position's own product and exchange rather than assuming defaults."""
        raise NotImplementedError

    # ── reporting ────────────────────────────────────────────────────

    @property
    def default_product(self):
        raise NotImplementedError

    def status(self) -> dict:
        """Margin-gate fields for the bridge's heartbeat/status file."""
        return {
            'margin_available': self.margin['available'],
            'margin_cash': self.margin['cash'],
            'margin_per_lot': round(self.margin['per_lot'], 2) if self.margin['per_lot'] else None,
            'margin_updated_ts': self.margin['updated_ts'],
            'margin_error': self.margin['error'],
            'margin_blocked_count': self.margin['blocked_count'],
            'margin_probe_symbol': self._margin_probe_symbol,
            'instruments': len(self._instruments),
        }


def _is_reducing(held_qty: int, side: str, qty: int) -> bool:
    from lib.zerodha.margin import is_reducing
    return is_reducing(held_qty, side, qty)


# ───────────────────────── Zerodha ──────────────────────────────────

class ZerodhaChild(ChildBroker):
    """Kite Connect child. A move of the bridge's previous kite-based path —
    behaviour here is deliberately unchanged."""

    name = 'zerodha'
    supports_exact_margin = True   # basket_order_margins prices a real basket

    def __init__(self, kite, log=print):
        super().__init__(log=log)
        self.kite = kite
        self.freeze_qty = DEFAULT_FREEZE_QTY

    @classmethod
    def create(cls, log=print, **_ignored):
        from scripts.tools.zerodha_instruments_cache import restore_session_from_json
        kite = restore_session_from_json()
        if kite is None:
            raise RuntimeError('Zerodha auth failed — run zerodha_autologin.py')
        return cls(kite, log=log)

    # -- instruments
    def load_instruments(self) -> list:
        from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache
        return load_zerodha_instruments_cache()

    def _refresh_instruments_cache(self) -> bool:
        import os
        import subprocess
        import sys
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        subprocess.run(
            [sys.executable, os.path.join(root, 'scripts', 'tools', 'zerodha_instruments_cache.py')],
            check=True, timeout=120,
        )
        return True

    # -- session
    def verify_session(self):
        try:
            profile = self.kite.profile()
            return True, f"Zerodha session OK ({profile.get('user_id', '?')})"
        except Exception as e:
            return False, f'Zerodha token rejected ({e}) — run zerodha_autologin.py'

    # -- products
    @property
    def default_product(self):
        return self.kite.PRODUCT_MIS

    def map_product(self, *hints):
        """CNC maps to NRML rather than PRODUCT_CNC: this bridge only ever places
        NFO option orders, where CNC is not a valid product. Unrecognized/missing
        values fall back to MIS."""
        for hint in hints:
            h = str(hint or '').strip().upper()
            if h in ('MARGIN', 'NRML', 'M'):
                return self.kite.PRODUCT_NRML
            if h in ('CNC', 'C'):
                return self.kite.PRODUCT_NRML
            if h in ('INTRADAY', 'MIS', 'I'):
                return self.kite.PRODUCT_MIS
        return self.kite.PRODUCT_MIS

    # -- positions
    def positions_rows(self) -> list:
        rows = []
        for p in self.kite.positions().get('net', []):
            sym = p.get('tradingsymbol')
            if not sym:
                continue
            try:
                qty = int(p.get('quantity', 0) or 0)
            except (TypeError, ValueError):
                continue
            rows.append({
                'symbol': sym, 'qty': qty,
                'product': p.get('product', self.kite.PRODUCT_MIS),
                'exchange': p.get('exchange', 'NFO'),
            })
        return rows

    # -- margin
    def _fetch_margin(self):
        from lib.zerodha.margin import get_margin_snapshot
        return get_margin_snapshot(self.kite)

    def _measure_per_lot(self, symbol, qty, product):
        from lib.zerodha.margin import get_required_margin, build_order_param
        # consider_positions=True on purpose: this must be the MARGINAL cost of
        # one more lot given what the account already holds, which is exactly
        # what Zerodha itself checks at order time. The standalone rate ignores
        # offsets from existing hedges and would over-state the requirement,
        # false-blocking affordable orders — and a false block is itself a
        # parent/child desync.
        return get_required_margin(
            self.kite, [build_order_param(symbol, 'SELL', qty, product)], consider_positions=True)

    def _required_margin_exact(self, symbol, side, qty, product):
        from lib.zerodha.margin import get_required_margin, build_order_param
        return get_required_margin(
            self.kite, [build_order_param(symbol, side, qty, product)], consider_positions=True)

    # -- orders
    def _place_one(self, symbol, side, qty, product):
        return self.kite.place_order(
            variety=self.kite.VARIETY_REGULAR,
            exchange=self.kite.EXCHANGE_NFO,
            tradingsymbol=symbol,
            transaction_type=(self.kite.TRANSACTION_TYPE_BUY if side == 'BUY'
                              else self.kite.TRANSACTION_TYPE_SELL),
            quantity=qty,
            product=product,
            order_type=self.kite.ORDER_TYPE_MARKET,
            validity=self.kite.VALIDITY_DAY,
            # Zerodha rejects API market orders on options without market
            # protection; -1 = automatic system-managed protection band.
            market_protection=-1,
        )

    def find_recent_matching_order(self, symbol, side, qty, since_ts):
        try:
            orders = self.kite.orders()
        except Exception:
            return None
        txn = self.kite.TRANSACTION_TYPE_BUY if side == 'BUY' else self.kite.TRANSACTION_TYPE_SELL
        for o in orders or []:
            if o.get('tradingsymbol') != symbol:
                continue
            if o.get('transaction_type') != txn:
                continue
            if int(o.get('quantity', 0) or 0) != qty:
                continue
            if str(o.get('status', '') or '').upper() in ('REJECTED', 'CANCELLED'):
                continue
            ts = o.get('order_timestamp')
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts)
                except ValueError:
                    ts = None
            # Fail CLOSED: an unparseable/missing timestamp must NOT count as a
            # match — misidentifying an unrelated older order as "already placed"
            # would skip the real retry and leave the leg unreplicated, which is
            # worse than the rare duplicate this check exists to prevent.
            if ts is None or since_ts is None or ts < since_ts:
                continue
            return o.get('order_id')
        return None

    def close_position(self, row, qty, side):
        return self.kite.place_order(
            variety=self.kite.VARIETY_REGULAR,
            exchange=row.get('exchange', 'NFO'),
            tradingsymbol=row['symbol'],
            transaction_type=side,
            quantity=qty,
            product=row.get('product', self.kite.PRODUCT_MIS),
            order_type=self.kite.ORDER_TYPE_MARKET,
            validity=self.kite.VALIDITY_DAY,
            market_protection=-1,
        )


# ───────────────────────── Kotak Neo ────────────────────────────────

class KotakChild(ChildBroker):
    """Kotak Neo child.

    Three Kotak-specific hazards are handled here and nowhere else:

      - **A read timeout is not a failure.** The order may be live, so the error
        is marked unconfirmed and the retry path must verify against the order
        book before re-placing. A *connect* error means the request never
        reached the broker and is safe to retry blindly.
      - **The session can die mid-day** (stCode 100008 'unauthorized'), and no
        amount of retrying fixes it. One capped re-login is attempted; after
        that the broker reports itself unavailable rather than burning the retry
        budget on every fill.
      - **Errors arrive as 200-OK bodies**, so a response that did not raise
        still has to be inspected.
    """

    name = 'kotak'
    # Kotak's check-margin endpoint prices ONE order in isolation — there is no
    # basket equivalent and no consider_positions, so it cannot account for
    # hedge offset against the existing book. Its "exact" answer would still be
    # an estimate, so the exact path is not offered at all and the bridge must
    # not treat a Kotak block as terminal.
    supports_exact_margin = False

    RELOGIN_MAX_ATTEMPTS = 2

    def __init__(self, client, underlying='NIFTY', log=print):
        super().__init__(log=log)
        self.client = client
        self.underlying = underlying
        self.available = True
        self.unavailable_reason = None
        self._relogin_attempts = 0
        self._segment = 'bse_fo' if underlying == 'SENSEX' else 'nse_fo'

    @classmethod
    def create(cls, log=print, underlying='NIFTY', **_ignored):
        from lib.kotak.authentication import get_kotak_client
        client = get_kotak_client()
        return cls(client, underlying=underlying, log=log)

    # -- session
    def verify_session(self):
        from lib.kotak.margin import get_margin_snapshot
        snap, err = get_margin_snapshot(self.client)
        if err:
            return False, f'Kotak session rejected ({err}) — run kotak_autologin.py --force'
        return True, f"Kotak session OK (net Rs {snap['net']:,.2f})"

    def _handle_response(self, res) -> bool:
        """Detect a dead session in any response. Returns True if it was handled
        (i.e. the caller should treat this as a session problem, not a rejection).
        """
        from lib.kotak.responses import is_unauthorized
        if not is_unauthorized(res):
            return False
        self._relogin()
        return True

    def _relogin(self):
        """One capped attempt to re-establish the session.

        The bridge holds credentials, so this is possible without operator
        action — but it is capped because a repeated failure means something the
        bridge cannot fix (revoked API key, TOTP drift), and hammering the login
        endpoint on every fill would only obscure that.
        """
        if self._relogin_attempts >= self.RELOGIN_MAX_ATTEMPTS:
            self._mark_unavailable('session expired and re-login attempts exhausted — '
                                   'run kotak_autologin.py --force and restart the bridge')
            return False
        self._relogin_attempts += 1
        self.log(f'[{self.name}] Session unauthorized — attempting re-login '
                 f'({self._relogin_attempts}/{self.RELOGIN_MAX_ATTEMPTS})')
        try:
            from lib.kotak.authentication import kotak_login
            self.client = kotak_login(verbose=False)
            self.available = True
            self.unavailable_reason = None
            self.log(f'[{self.name}] Re-login succeeded')
            return True
        except Exception as e:
            self._mark_unavailable(f're-login failed: {e}')
            return False

    def _mark_unavailable(self, reason: str):
        self.available = False
        self.unavailable_reason = reason
        self.margin['error'] = reason
        self.log(f'[{self.name}] UNAVAILABLE: {reason}')

    # -- instruments
    def load_instruments(self) -> list:
        import json
        import os
        from datetime import datetime
        from scripts.tools.kotak_instruments_cache import output_file, refresh
        path = output_file(self.underlying)
        # Rebuild when the cache is missing OR was written before today. A
        # date check matters more here than on a symbol miss: a weekly expiry
        # that rolled overnight leaves yesterday's file full of contracts that
        # still resolve, so nothing would ever trigger the miss-driven refresh —
        # the bridge would just replicate against a dead expiry's symbols.
        stale = True
        if os.path.exists(path):
            try:
                stale = (datetime.fromtimestamp(os.path.getmtime(path)).date()
                         != datetime.now().date())
            except OSError:
                stale = True
        if stale:
            return refresh(self.underlying, client=self.client,
                           log=lambda m: self.log(f'[{self.name}] {m}'))
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    def _refresh_instruments_cache(self) -> bool:
        # In-process, unlike the Zerodha path's subprocess: the client is already
        # authenticated here and a second login would invalidate this one.
        from scripts.tools.kotak_instruments_cache import refresh
        refresh(self.underlying, client=self.client, log=lambda m: self.log(f'[{self.name}] {m}'))
        return True

    def _set_instruments(self, instruments: list):
        super()._set_instruments(instruments)
        # Kotak publishes the real freeze quantity per contract (1801 for NIFTY,
        # not Zerodha's 1800) — market orders above it are rejected outright.
        freezes = [int(i.get('freeze_qty') or 0) for i in instruments]
        freezes = [f for f in freezes if f > 0]
        if freezes:
            self.freeze_qty = min(freezes)

    # -- products
    @property
    def default_product(self):
        return 'MIS'

    def map_product(self, *hints):
        for hint in hints:
            h = str(hint or '').strip().upper()
            if h in ('MARGIN', 'NRML', 'M'):
                return 'NRML'
            if h in ('CNC', 'C'):
                # CNC is not valid on F&O — same reasoning as the Zerodha path.
                return 'NRML'
            if h in ('INTRADAY', 'MIS', 'I'):
                return 'MIS'
        return 'MIS'

    # -- positions
    def positions_rows(self) -> list:
        from lib.kotak.margin import get_positions, net_qty_of
        rows, err = get_positions(self.client)
        if err:
            raise RuntimeError(err)
        out = []
        for row in rows or []:
            symbol = str(row.get('trdSym') or row.get('sym') or '').strip()
            if not symbol:
                continue
            qty = net_qty_of(row)
            if qty == 0:
                continue
            out.append({
                'symbol': symbol, 'qty': qty,
                'product': row.get('prod') or row.get('prd') or 'MIS',
                'exchange': row.get('exSeg') or self._segment,
            })
        return out

    # -- margin
    def _fetch_margin(self):
        from lib.kotak.margin import get_margin_snapshot
        snap, err = get_margin_snapshot(self.client)
        if err and 'unauthorized' in str(err).lower():
            self._relogin()
        return snap, err

    def _measure_per_lot(self, symbol, qty, product):
        """Per-lot margin from Kotak's single-order check-margin endpoint.

        Unlike Zerodha's basket call this cannot consider existing positions, so
        it reports the STANDALONE rate and therefore over-states the marginal
        cost of one more lot on a hedged book. Over-reserving is the safe
        direction for a gate, and the fast-path block it produces is
        non-terminal by design (see supports_exact_margin).
        """
        from lib.kotak.responses import error_message
        token = None
        for i in self._instruments:
            if i.get('tradingsymbol') == symbol:
                token = i.get('instrument_token')
                break
        if not token:
            return None, f'no instrument token cached for {symbol}'
        try:
            res = self.client.margin_required(
                exchange_segment=self._segment,
                price='0',
                order_type='MKT',
                product=str(product).upper(),
                quantity=str(int(qty)),
                instrument_token=str(token),
                transaction_type='S',
            )
        except Exception as e:
            return None, str(e)
        err = error_message(res)
        if err:
            return None, err
        # Verified against the live endpoint (2026-07-31), which returns:
        #   {'data': {'avlCash','totMrgnUsd','mrgnUsd','ordMrgn','rmsVldtd',
        #             'reqdMrgn','avlMrgn','insufFund','stat','stCode'}}
        # 'ordMrgn' is the margin for THIS order (145,411 for a 1-lot NIFTY
        # short, in line with Zerodha's ~165,746 for the same leg);
        # 'totMrgnUsd' is the book total after it, used only as a fallback.
        data = res.get('data') if isinstance(res, dict) else None
        if isinstance(data, dict):
            for key in ('ordMrgn', 'totMrgnUsd'):
                if data.get(key) is not None:
                    try:
                        value = float(data[key])
                    except (TypeError, ValueError):
                        continue
                    if value > 0:
                        return value, None
        # Deliberately an error, not a zero: an unrecognised response shape must
        # leave per_lot as None so the gate fails OPEN rather than treating every
        # order as free.
        return None, f'unrecognised check-margin response shape: {res!r}'

    # -- orders
    def _place_one(self, symbol, side, qty, product, segment=None):
        from lib.kotak.authentication import is_connect_error, is_timeout_error
        from lib.kotak.responses import error_message, order_id_of, st_code, NO_LTP_STCODE
        try:
            res = self.client.place_order(
                exchange_segment=segment or self._segment,
                product=str(product).upper(),
                price='0',
                order_type='MKT',
                quantity=str(int(qty)),
                validity='DAY',
                trading_symbol=symbol,
                transaction_type='B' if str(side).upper() == 'BUY' else 'S',
                amo='NO',
                disclosed_quantity='0',
                market_protection='0',
                pf='N',
                trigger_price='0',
            )
        except Exception as e:
            if is_connect_error(e):
                # Never reached the broker — safe for the caller to retry blindly.
                raise RuntimeError(f'connect error, order NOT placed: {e}')
            if is_timeout_error(e):
                # The order MAY be live. Flagged so drain_retry_queue verifies
                # against the order book before placing what could be a duplicate.
                raise UnconfirmedOrder(f'read timeout — order may be live: {e}')
            raise

        if self._handle_response(res):
            raise RuntimeError('Kotak session unauthorized — order NOT placed')

        order_id = order_id_of(res)
        if isinstance(res, dict) and res.get('stat') == 'Ok' and order_id:
            return order_id

        err = error_message(res) or str(res)
        if st_code(res) == NO_LTP_STCODE:
            # Illiquid strike: Kotak refuses MARKET orders with no LTP and asks
            # for a limit. Deliberately NOT auto-converted — silently switching
            # an exit to a limit order can leave it unfilled, which is the
            # failure this bridge exists to avoid.
            raise RuntimeError(f'Kotak rejected the MARKET order (no LTP on {symbol}) — '
                               f'illiquid strike, place manually: {err}')
        raise RuntimeError(err)

    def find_recent_matching_order(self, symbol, side, qty, since_ts):
        from lib.kotak.responses import unwrap_list
        try:
            rows, err = unwrap_list(self.client.order_report())
        except Exception:
            return None
        if err:
            return None
        txn = 'B' if str(side).upper() == 'BUY' else 'S'
        for o in rows or []:
            if str(o.get('trdSym') or '').strip() != symbol:
                continue
            if str(o.get('trnsTp') or '').strip().upper() != txn:
                continue
            try:
                if int(float(o.get('qty', 0) or 0)) != qty:
                    continue
            except (TypeError, ValueError):
                continue
            if str(o.get('ordSt', '') or '').lower() in ('rejected', 'cancelled'):
                continue
            ts = _parse_kotak_time(o.get('ordEntTm') or o.get('ordDtTm') or o.get('ordTm') or o.get('exCfmTm'))
            # Fail CLOSED, exactly as on the Zerodha path — an unparseable
            # timestamp must not count as a match.
            if ts is None or since_ts is None or ts < since_ts:
                continue
            return o.get('nOrdNo')
        return None

    def close_position(self, row, qty, side):
        # Close on the position's OWN segment and product, not this broker's
        # configured defaults — a leg opened on bse_fo must not be squared off
        # against nse_fo. (The bridge is NIFTY-only today, so the two always
        # agree; inheriting them keeps that from becoming a silent bug the day
        # it isn't.)
        return self._place_one(row['symbol'], side, qty, row.get('product', 'MIS'),
                               segment=row.get('exchange') or self._segment)


class UnconfirmedOrder(Exception):
    """Placement whose outcome is genuinely unknown (response lost in flight).

    Exists to make the error MESSAGE unambiguous in the log. It needs no special
    handling upstream: place_child_order returns any raise as an error string,
    and the bridge stamps `queued_at` on every such retry item, so
    drain_retry_queue already verifies against the order book before re-placing.
    That path is the duplicate guard for both brokers.
    """


def _parse_kotak_time(raw):
    """Parse a Kotak order timestamp. Returns None if unparseable — callers fail
    closed on that, so guessing here would be actively harmful."""
    if not raw:
        return None
    text = str(raw).strip()
    for fmt in ('%d-%b-%Y %H:%M:%S', '%d-%m-%Y %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%H:%M:%S'):
        try:
            parsed = datetime.strptime(text, fmt)
            if fmt == '%H:%M:%S':
                today = datetime.now()
                return parsed.replace(year=today.year, month=today.month, day=today.day)
            return parsed
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


BROKER_CLASSES = {
    'zerodha': ZerodhaChild,
    'kotak': KotakChild,
}


def create_broker(name: str, log=print, **kwargs):
    """Build a child broker by config name. Raises if it cannot be authenticated —
    the bridge logs that and marks the child unavailable rather than silently
    dropping its fills."""
    cls = BROKER_CLASSES.get(str(name).lower())
    if cls is None:
        raise ValueError(f'Unknown child broker: {name!r}')
    return cls.create(log=log, **kwargs)
