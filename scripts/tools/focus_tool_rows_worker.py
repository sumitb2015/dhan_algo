#!/usr/bin/env python
"""
Focus Tool worker for the LIVE terminal (rs_dashboard/components/FocusTool.tsx).

The browser page can only act while its tab is open. This process runs the same
rule engine server-side on a 250ms loop, so a scheduled entry, a spot-level stop
or the 15:17 bell keeps working after the tab is closed, the laptop sleeps or
the browser crashes.

It is built to be FAST, which mostly means keeping blocking work off the tick:
spot and every option leg arrive over the market-feed WebSocket rather than
REST (a REST quote blocks the loop for ~1.1s on DhanHelper's shared limiter,
which made exit latency scale with the number of open positions), fills settle
on the order-update callback instead of being waited for, and the position book
is reconciled on its own 2s cadence rather than in front of every rule. What is
left on the tick is reading live_data and evaluating pure functions.

    venv\\Scripts\\python.exe scripts/tools/focus_tool_rows_worker.py --broker dhan
    venv\\Scripts\\python.exe scripts/tools/focus_tool_rows_worker.py --once --dry-run

Market data and order routing live in scripts/tools/focus_tool_broker.py
(MarketData, OrderRouter) — they only ever speak in
underlying/expiry/strike/option-type and know nothing about this schema.

Contract with the dashboard, matching every other long-running process here:
  read   debug/focus_tool_rows.json          (the page's own config, reloaded on mtime)
  write  debug/focus_tool_rows_worker_status.json     (heartbeat every tick)
  write  debug/focus_tool_rows_worker_state.json      (this worker's own fill ledger)
  stop   debug/focus_tool_rows_worker_stop.trigger

Four deliberate non-behaviours:

  * It never closes anything on shutdown. A stop trigger, a crash and a
    market-closed exit all leave open positions exactly where they are. They are
    the user's to manage; a process exiting is not a reason to trade.

  * It never trusts the broker's net quantity when sizing an exit. Dhan nets
    every position by security id, so a strike this worker holds may be shared
    with a running strategy or with the same strike in another row. Exits go
    through lib/strategy_risk.resolve_exit_qty, which closes what THIS worker
    opened, clamped by what the broker still shows.

  * It never trades unless the config's own LIVE - REAL MONEY switch is on.
    That flag is the page's master arm; a worker that ignored it would trade
    from a screen showing "dry run".

  * It never treats a broker ACK as a fill. `place_order` returning an id means
    Dhan accepted the order, not that the exchange traded it. A leg is recorded
    unconfirmed at an LTP estimate and settled with the ACTUAL traded price and
    quantity when the order-update socket reports one — off the tick thread, so
    confirming one leg never stalls another row's exit rules.

And one thing it does on its own cadence: it reconciles the ledger against the
broker's own position book, writing quantities DOWN (never up) when the broker
shows less than the ledger claims. Without that, an exit order that was accepted
but never filled would zero the ledger while the position was still live — the
row would read as flat and every rule would stop watching it. That snapshot is
also what exits are sized from, so a close order does not pay for its own
positions call.

Because it owns a fill ledger, P&L here is marked against what THIS worker
opened, not against the whole account. That is also what the account-level
Target/Stop/Trail is measured on — an unrelated strategy's drawdown must not
flatten this tool's rows. The browser's Risk/MTM panel shows whole-account P&L
and so can differ; the page stands its own scheduler down whenever this worker
is running, so only one of the two is ever acting.

The rule functions mirror FocusTool.tsx's evaluateRowExit / the scheduler
effect. Change one, change both in the same commit: a disagreement means the
screen shows one thing and the account does another.
"""

import argparse
import ctypes
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

DEBUG_DIR    = os.path.join(ROOT, 'debug')
CONFIG_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_rows.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker_status.json')
# --once is a test harness and deliberately skips the singleton mutex so it can
# run while a real worker is live. It must therefore never write the status file
# the dashboard reads, or one test tick would mark a running worker STOPPED.
STATUS_FILE_ONCE = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker_status_once.json')
STATE_FILE   = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker_state.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker_stop.trigger')
LOG_FILE     = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker.log')

# Spot AND every option leg arrive over the WebSocket (see ensure_legs_subscribed),
# so a tick is pure CPU: read live_data, evaluate the rules, act. It used to be
# 2s because each leg cost a blocking ~1.1s REST quote, which made exit latency
# scale with the number of open positions. It no longer does, so the loop runs
# at scalper cadence — the only REST left on the tick path is throttled below.
TICK_SECONDS = 0.25

# The position-book reconcile is a REST call, so it is paced independently of
# the tick rather than running four times a second.
RECONCILE_EVERY_SECONDS = 2.0

# The dashboard polls the status file; rewriting it on every 250ms tick would be
# four disk writes a second for a panel that refreshes far more slowly.
STATUS_EVERY_SECONDS = 1.0

# How wide a strike ladder to keep on the tick feed, in steps either side of
# ATM. Wide enough that a PREMIUM-mode target resolves without a REST chain and
# that a strike shift lands on a contract already subscribed; the socket carries
# hundreds of instruments, so the cost is master-list lookups, not bandwidth.
LADDER_STEPS = 12

# The refresher's own cadence, and how stale a published snapshot may be before
# the tick refuses to use it. A dead refresher must make a rule go INERT, never
# fire it on a number from several minutes ago — a stale VWAP closing a live
# position is exactly the failure this design exists to avoid.
REFRESH_EVERY_SECONDS = 1.0
SNAPSHOT_STALE_SECONDS = 150.0

# How long a freshly opened leg is exempt from reconciliation. The position book
# lags a fill by a second or two, and reading that lag as "the broker shows
# nothing" would drop a live leg from the ledger moments after opening it.
RECONCILE_GRACE_SECONDS = 20.0

# Repo-wide intraday auto-exit (CLAUDE.md), mirroring FocusTool.tsx's
# INTRADAY_BACKSTOP_HM.
INTRADAY_EXIT_MINUTES = 15 * 60 + 17

STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'SENSEX': 100}

# MarketFeed segment codes (mirrors focus_tool_ws.py / live_options_ws.py).
IDX_FEED     = 0    # index segment, differentiated by security id
NSE_FNO_FEED = 2
BSE_FNO_FEED = 8
FEED_FULL    = 21   # full packet
UNDERLYINGS = ('NIFTY', 'BANKNIFTY', 'SENSEX')

# Group product -> the product string each broker's order path expects. Mirrors
# PRODUCT_ALIAS in FocusTool.tsx. OrderRouter maps the child-broker side itself.
PRODUCT_FOR = {'INTRADAY': 'INTRADAY', 'MARGIN': 'MARGIN'}

IST = timezone(timedelta(hours=5, minutes=30))

logger = logging.getLogger('focus_tool_rows')

_singleton_handle = None

from scripts.tools.focus_tool_broker import (      # noqa: E402
    MarketData, OrderRouter, UNDERLYING_EXCHANGE,
)


# ─── Infrastructure ───────────────────────────────────────────────

def setup_logging():
    os.makedirs(DEBUG_DIR, exist_ok=True)
    # Reason strings carry the same glyphs the screen shows (H↑, ₹, ×) so the
    # two implementations can be compared character for character. The log file
    # is already UTF-8; this stops the Windows console mangling them on the way
    # to the spawn log, which is where a crash is read back from.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        handlers=[logging.FileHandler(LOG_FILE, encoding='utf-8'), logging.StreamHandler(sys.stdout)],
    )
    # MarketData/OrderRouter log through the sibling module's logger; point it
    # at this worker's handlers so their warnings land in one place.
    logging.getLogger('focus_tool').handlers = logging.getLogger().handlers
    logging.getLogger('focus_tool').setLevel(logging.INFO)


def atomic_write(path, data):
    """Write-then-rename. The dashboard polls these files and a torn read would
    render as an empty terminal."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except Exception as e:
        logger.warning(f'Failed to write {path}: {e}')
        return False


def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def acquire_singleton():
    """At most one worker process.

    Fails CLOSED on a genuine ERROR_ALREADY_EXISTS: two workers reading the same
    config would BOTH enter every armed row, doubling live positions. Only a
    total failure of the mutex API falls through, and the API route's PID check
    still covers that case.

    use_last_error=True + ctypes.get_last_error() rather than
    windll.kernel32.GetLastError(): the latter can read a stale 183 left by an
    unrelated ctypes call and refuse to start with no other process in existence.
    """
    global _singleton_handle
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel32.CreateMutexW(None, False, 'dhan_algo_focus_tool_rows_worker')
        err = ctypes.get_last_error()
        if not handle:
            return True
        _singleton_handle = handle
        return err != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


# ─── Rule engine (mirror of rs_dashboard/components/FocusTool.tsx) ────────

def parse_hhmm(value):
    """'HH:MM' -> minutes since midnight, or None for empty/malformed input."""
    s = str(value or '').strip()
    if not s or ':' not in s:
        return None
    head, _, tail = s.partition(':')
    try:
        h, m = int(head), int(tail)
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def num(value, default=None):
    """A config number that arrives as a UI string. '' -> default, never 0:
    an empty box means "rule off", and 0 would read as a real threshold."""
    s = str(value if value is not None else '').strip()
    if s == '':
        return default
    try:
        f = float(s)
    except ValueError:
        return default
    return f if f == f else default   # NaN -> default


def js_num(value):
    """Format a number the way JavaScript's String(Number) does.

    Parity detail, not cosmetics: the reason strings are asserted character for
    character against lib/focusToolRules.ts (see focusToolRules.cases.json), and
    JS prints 2000 as "2000" where Python's f-string prints 2000.0 as "2000.0".
    """
    f = float(value)
    return str(int(f)) if f == int(f) else repr(f)


def atm_strike(spot, step):
    if not (spot > 0) or not (step > 0):
        return 0
    return int(round(spot / step) * step)


def legs_of(row):
    """Legs this row trades. `side` selects which, it is not a direction —
    this tool always opens with a SELL."""
    side = str(row.get('side') or 'BOTH').upper()
    return ['CE', 'PE'] if side == 'BOTH' else [side]


def dte_for(expiry, today):
    """Calendar days from `today` to `expiry`, both 'YYYY-MM-DD'. 0 = expiry
    today, negative = lapsed, None = unparseable."""
    try:
        a = datetime.strptime(str(expiry).strip(), '%Y-%m-%d').date()
        b = datetime.strptime(str(today).strip(), '%Y-%m-%d').date()
    except (ValueError, TypeError):
        return None
    return (a - b).days


def dte_matches(filt, dte):
    """Mirrors dteMatches() in FocusTool.tsx."""
    if str(filt) == 'Any':
        return True
    if dte is None:
        return False
    if str(filt) == '0':
        return dte == 0
    if str(filt) == '1':
        return dte == 1
    if str(filt) == '0+1':
        return dte in (0, 1)
    return False


def nearest_strike_by_premium(chain, opt_type, target):
    """The listed strike whose premium is the closest one AT OR BELOW
    `target` — not simply the closest by absolute difference. `chain` is
    {strike: {'CE': ltp, 'PE': ltp}}. Mirrors FocusTool.tsx's
    nearestStrikeByPremium(): the target is a ceiling on what you're willing
    to sell the leg for, not a midpoint to snap to, so a strike priced above
    it is never picked even if it sits closer than the best one under it."""
    if not chain or not target or target <= 0:
        return None
    best, best_px = None, float('-inf')
    for strike, legs in chain.items():
        px = legs.get(opt_type) or 0.0
        if not (px > 0) or px > target:
            continue
        if px > best_px:
            best_px, best = px, int(strike)
    return best


def resolve_row_strikes(row, atm, step, chain):
    """(ce_strike, pe_strike), either possibly None.

    ATM mode resolves each leg arithmetically and independently — there is no
    guard keeping CE >= PE, because an inverted strangle is a valid user-chosen
    shape here (see FocusTool.tsx's rowLive). PREMIUM mode picks whichever
    listed strike's LTP is the closest one at or below that leg's rupee
    target — see nearest_strike_by_premium.
    """
    if str(row.get('strikeMode') or 'ATM') == 'PREMIUM':
        return (nearest_strike_by_premium(chain, 'CE', num(row.get('cePremium'))),
                nearest_strike_by_premium(chain, 'PE', num(row.get('pePremium'))))
    if not atm:
        return None, None
    ce = atm + int(row.get('ceOffset') or 0) * step
    pe = atm + int(row.get('peOffset') or 0) * step
    return ce, pe


def evaluate_entry(row, group, now_minutes, dte, strikes_ready, flat=True):
    """(enter, reason). A draft row never enters — that is what Arm is for.

    The ORDER of these checks is part of the contract, not an implementation
    detail: `reason` is what gets logged and shown, and evaluateEntry in
    lib/focusToolRules.ts reports the same reason for the same row. Both are
    asserted against lib/focusToolRules.cases.json.
    """
    if not group or not group.get('enabled'):
        return False, 'index not started'
    if str(row.get('status')) != 'armed':
        return False, f"status {row.get('status')}"
    if not (int(row.get('lots') or 0) > 0):
        return False, 'lots must be > 0'
    if not flat:
        return False, 'already holds a position'
    if not strikes_ready:
        return False, 'strikes unresolved'
    if not dte_matches(row.get('dte', 'Any'), dte):
        return False, f"DTE {dte} != {row.get('dte')}"

    entry_at = parse_hhmm(row.get('entryTime'))
    if entry_at is None:
        return False, 'no entry time'
    if now_minutes < entry_at:
        return False, f"waiting for {row.get('entryTime')}"

    # Never open into a window that has already closed — a row armed after its
    # own exit time (or after the intraday bell) would be flattened next tick.
    exit_at = parse_hhmm(row.get('exitTime'))
    if exit_at is not None and now_minutes >= exit_at:
        return False, f"past its own exit time {row.get('exitTime')}"
    if str((group or {}).get('product') or 'INTRADAY') == 'INTRADAY' and now_minutes >= INTRADAY_EXIT_MINUTES:
        return False, 'past 15:17 intraday cutoff'

    return True, f"entry time {row.get('entryTime')} reached"


def evaluate_row_exit(row, spot, premium, entry_premium, pnl, vwap):
    """The first LEVEL exit this row breaches, or None.

    H-up, L-down, VWAP cross, SL rupees, SL multiple — in that order, character
    for character identical to evaluateRowExit in lib/focusToolRules.ts. Both
    are asserted against lib/focusToolRules.cases.json, so a rule changed on one
    side fails the other until it is changed there too.

    `premium`, `entry_premium` and `pnl` cover only the legs this row's Side
    trades AND that are still open — a CE-only row measured against a CE+PE
    premium would cross its threshold at the wrong number.

    Spot rules are suppressed at spot <= 0 and premium rules at premium <= 0: a
    failed quote read arrives as 0, and 0 is below every conceivable L-down
    level, so treating it as a breach would flatten the book on one dropped tick.
    """
    hi = num(row.get('levelHigh'))
    if hi is not None and spot > 0 and spot >= hi:
        return f'H↑ breached: spot {spot:.2f} ≥ {js_num(hi)}'
    lo = num(row.get('levelLow'))
    if lo is not None and spot > 0 and spot <= lo:
        return f'L↓ breached: spot {spot:.2f} ≤ {js_num(lo)}'

    # This tool only ever opens with a SELL, so it is hurt by premium EXPANDING
    # through VWAP or through a multiple of the entry price.
    if row.get('levelVw') and vwap is not None and vwap > 0:
        if premium > 0 and premium >= vwap:
            return f'VW breached: premium {premium:.2f} ≥ VWAP {vwap:.2f}'

    sl_rs = num(row.get('slRupees'))
    if sl_rs is not None and sl_rs > 0 and pnl <= -sl_rs:
        return f'SL ₹{js_num(sl_rs)} hit (P&L ₹{pnl:.0f})'

    sl_mult = num(row.get('slMultiplier'))
    if sl_mult is not None and sl_mult > 1:
        if entry_premium > 0 and premium > 0 and premium >= entry_premium * sl_mult:
            return (f'SL ×{js_num(sl_mult)} hit '
                    f'(premium {premium:.2f} vs entry {entry_premium:.2f})')
    return None


def evaluate_exit(row, group, fill, now_minutes, spot, premium, vwap, pnl):
    """(exit, reason) for one row this worker holds open. First match wins:

        1. the 15:17 intraday bell (MIS rows only)
        2. the group's Book Exit spot level
        3. the row's own exit time
        4. everything in evaluate_row_exit — H-up / L-down / VWAP / SL

    The first three are clock- and group-driven and belong to the worker's
    scheduler; the browser evaluates them in its own tick loop for the same
    reason. Only the fourth is a shared, tested rule.
    """
    if not fill:
        return False, ''

    product = str((group or {}).get('product') or 'INTRADAY')
    if product == 'INTRADAY' and now_minutes >= INTRADAY_EXIT_MINUTES:
        return True, 'Intraday auto-exit 15:17'

    spot_known = spot > 0

    if spot_known and (group or {}).get('bookExit'):
        hi, lo = num((group or {}).get('spotHigh')), num((group or {}).get('spotLow'))
        if hi is not None and hi > 0 and spot >= hi:
            return True, f'Book exit: spot {spot:.2f} >= {js_num(hi)}'
        if lo is not None and lo > 0 and spot <= lo:
            return True, f'Book exit: spot {spot:.2f} <= {js_num(lo)}'

    exit_at = parse_hhmm(row.get('exitTime'))
    if exit_at is not None and now_minutes >= exit_at:
        return True, f"Exit time {row.get('exitTime')}"

    reason = evaluate_row_exit(
        row, spot, premium, float(fill.get('entryPremium') or 0.0), pnl, vwap)
    return (True, reason) if reason else (False, '')


def evaluate_leg_exit(row, leg, fill, ltp):
    """(exit, reason) for one leg's OWN SL x — independent of the pair-level
    slMultiplier/slRupees in evaluate_exit, and independent of row['side']: a
    leftover position on a leg the row no longer trades still deserves its own
    stop. Only fires while that leg is actually held; a closed leg has no
    entry price left to compare against.
    """
    held = (fill or {}).get(leg)
    if not held:
        return False, ''
    mult = num(row.get('ceSlMultiplier' if leg == 'CE' else 'peSlMultiplier'))
    if mult is None or mult <= 1 or not (ltp > 0):
        return False, ''
    entry = float(held.get('entryPrice') or 0.0)
    # Short: hurt by this leg's own premium expanding through a multiple of
    # what it was sold for.
    if entry > 0 and ltp >= entry * mult:
        return True, (f'{leg} SL ×{js_num(mult)} hit '
                      f'(premium {ltp:.2f} vs entry {entry:.2f})')
    return False, ''


def evaluate_global_risk(cfg, total_pnl, peak_pnl, lock_floor):
    """(exit_all, reason, lock_floor, trail_state) for the account-level budget.

    The trail is dormant until P&L clears TRIGGER, then a floor that ratchets up
    with every new peak and never moves down. TRIGGER is the hysteresis —
    without it the floor would arm on the first rupee of profit and fire on the
    next tick.

    Returns the floor to persist rather than mutating, so a restart mid-session
    resumes from what was last written instead of silently re-arming.
    """
    trail_state = 'INACTIVE'

    if cfg.get('riskEnabled'):
        target = num(cfg.get('targetRupees'))
        stop = num(cfg.get('stopRupees'))
        if target is not None and target > 0 and total_pnl >= target:
            return True, f'Target ₹{target:.0f} reached (₹{total_pnl:.0f})', lock_floor, trail_state
        # STOP is stored as a positive magnitude; the UI labels it a loss limit.
        if stop is not None and stop > 0 and total_pnl <= -stop:
            return True, f'Stop ₹{stop:.0f} hit (₹{total_pnl:.0f})', lock_floor, trail_state

    trigger = num(cfg.get('triggerRupees'))
    if cfg.get('trailEnabled') and trigger is not None and trigger > 0:
        gap = num(cfg.get('lockRupees'), 0.0) or 0.0
        gap = max(gap, 0.0)

        if lock_floor is None:
            if total_pnl >= trigger:
                lock_floor = trigger - gap
                trail_state = 'ARMED'
            else:
                trail_state = 'DORMANT'
        else:
            trail_state = 'ARMED'
            # Ratchet on the running peak, not the current tick: a spike that
            # has already faded still counts, and the floor can only rise.
            ratchet = peak_pnl - gap
            if ratchet > lock_floor:
                lock_floor = ratchet
            if total_pnl <= lock_floor:
                return (True,
                        f'Trail lock ₹{lock_floor:.0f} hit '
                        f'(₹{total_pnl:.0f}, peak ₹{peak_pnl:.0f})',
                        lock_floor, trail_state)

    return False, '', lock_floor, trail_state


# ─── Worker ───────────────────────────────────────────────────────

class FocusRowsWorker:
    """Drives the live Focus Tool config.

    The fill ledger (`self.fills`) is this worker's own record of what it
    opened, keyed row id -> leg -> {strike, qty, entryPrice}. It is the sizing
    authority for exits (via resolve_exit_qty) and the entry price for SL x, and
    it is persisted every time it changes so a restart mid-session picks up its
    positions rather than abandoning them.
    """

    def __init__(self, broker='dhan', dry_run=False, once=False):
        self.broker = broker
        self.dry_run = dry_run
        self.once = once
        self.helper = None
        self.market = None
        self.router = None

        self.cfg = {}
        self._cfg_mtime = None
        self.fills = {}            # row id -> {'CE'|'PE': {...}, 'entryPremium': float}
        self.peak_pnl = 0.0
        self.lock_floor = None
        self.trail_state = 'INACTIVE'
        self.events = []           # recent (ts, level, message) for the dashboard
        self._warned_orphans = set()   # ledger ids already reported as orphaned
        self._warned_stale_arm = False # yesterday's live arm reported once
        self._subscribed = set()       # option security ids already on the tick feed
        # self.fills is mutated by the tick thread AND by the order-update
        # callback thread (see on_order_update), so every mutation takes this.
        self._fills_lock = threading.RLock()
        self._pending = {}             # order id -> (row id, leg), awaiting a fill
        self._last_reconcile = 0.0
        self._last_status = 0.0
        # Last broker net-quantity snapshot, reused by exits within the same
        # window so a close order does not pay for its own positions call.
        self._net_snapshot = None
        self.started_at = datetime.now().isoformat()
        # Published by the refresher thread, read by the tick. Each value is
        # (stamped_at, payload) so the tick can refuse a snapshot whose
        # producer has died — see _fresh().
        self._chain_snapshot = {}  # (underlying, expiry) -> (ts, {strike: {CE, PE}})
        self._vwap_snapshot = {}   # (underlying, expiry, ce, pe, legs) -> (ts, vwap)
        self._refresher = None
        self._stopping = False

    # -- lifecycle ---------------------------------------------------

    def connect(self):
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper
        dhan = get_dhan_client()
        if not dhan:
            raise RuntimeError('Dhan authentication failed')
        self.helper = DhanHelper(dhan)
        self.market = MarketData(self.helper)
        self.router = OrderRouter(self.helper, self.market, self.broker, self.dry_run)
        self.start_spot_feed()
        self.start_order_feed()
        self.start_refresher()

    def start_order_feed(self):
        """Subscribe to Dhan's order-update WebSocket and settle fills on it.

        This is what keeps fill confirmation OFF the tick thread. An entry
        records its order id and returns immediately; when the socket reports a
        terminal status for that id, on_order_update() writes the real traded
        price and quantity into the ledger. Blocking the loop to confirm one
        leg would stall the exit rules for every other row.

        Best-effort and Dhan-only. With the socket down, legs simply stay
        unconfirmed at their LTP estimate and reconcile() sizes them against the
        position book — slower to settle, never wrong.
        """
        if self.dry_run or self.broker != 'dhan':
            return
        try:
            self.helper.start_order_update_websocket(self.on_order_update)
            self.log('info', 'Order-update feed subscribed')
        except Exception as e:
            self.log('warning', f'Order-update WebSocket unavailable, fills settle '
                                f'from the position book instead: {e}')

    def on_order_update(self, payload):
        """Settle one pending leg against its real fill. Runs on the SOCKET
        thread — every ledger mutation here takes the lock, and nothing in it
        may block or place an order."""
        try:
            data = (payload or {}).get('Data') or {}
            order_id = str(data.get('orderNo') or data.get('OrderNo') or '')
            if not order_id:
                return
            with self._fills_lock:
                target = self._pending.get(order_id)
            if not target:
                return   # not ours, or already settled
            status = str(data.get('status') or data.get('Status') or '').upper()
            if status in ('CANCELLED', 'REJECTED', 'EXPIRED'):
                with self._fills_lock:
                    self._pending.pop(order_id, None)
                self.log('error', f'Order {order_id} came back {status} — the leg it opened '
                                  f'is being sized off the position book instead.')
                return
            if status != 'TRADED':
                return

            fill = self.router.read_fill(order_id)
            row_id, leg = target
            with self._fills_lock:
                self._pending.pop(order_id, None)
                held = (self.fills.get(row_id) or {}).get(leg)
                if not held or held.get('orderId') != order_id:
                    return   # the leg was closed or rolled while the fill was in flight
                if fill:
                    held['qty'] = int(fill['qty'])
                    held['entryPrice'] = float(fill['price'])
                    held['confirmed'] = True
                    # entryPremium drives SL x, so it has to follow the legs it
                    # is the sum of.
                    entry = self.fills.get(row_id) or {}
                    entry['entryPremium'] = sum(
                        float((entry.get(k) or {}).get('entryPrice') or 0.0)
                        for k in ('CE', 'PE') if entry.get(k))
                self.save_state()
            if fill:
                self.log('info', f"{row_id[-4:]} {leg}: filled {fill['qty']} @ {fill['price']:.2f}")
        except Exception as e:
            logger.warning(f'Order update handling failed: {e}')

    def load_state(self):
        st = read_json(STATE_FILE) or {}
        # Only resume a ledger written today. Carrying yesterday's fills into a
        # new session would size exits against positions the broker has already
        # squared off, and re-arm a trail from a P&L that no longer exists.
        if st.get('session') == datetime.now(IST).strftime('%Y-%m-%d'):
            self.fills = st.get('fills') or {}
            self.peak_pnl = float(st.get('peakPnl') or 0.0)
            self.lock_floor = st.get('lockFloor')
            if self.fills:
                self.log('info', f'Resumed {len(self.fills)} open row(s) from state file')
        elif st:
            self.log('info', 'State file is from a previous session — starting flat')

    def save_state(self):
        atomic_write(STATE_FILE, {
            'session': datetime.now(IST).strftime('%Y-%m-%d'),
            'fills': self.fills,
            'peakPnl': self.peak_pnl,
            'lockFloor': self.lock_floor,
            'updatedAt': datetime.now().isoformat(),
        })

    def load_config(self):
        """Reload only when the file's mtime moves — the page rewrites it on
        every Save, and re-parsing every tick would be pointless work."""
        try:
            mtime = os.path.getmtime(CONFIG_FILE)
        except OSError:
            return
        if mtime == self._cfg_mtime:
            return
        cfg = read_json(CONFIG_FILE)
        if not isinstance(cfg, dict):
            return
        self._cfg_mtime = mtime
        self.cfg = cfg
        self.log('info', f"Config reloaded — {len(cfg.get('rows') or [])} row(s), "
                         f"live={bool(cfg.get('liveRealMoney'))}")

    def log(self, level, message):
        getattr(logger, level if level in ('info', 'warning', 'error') else 'info')(message)
        self.events.append({'ts': datetime.now().isoformat(), 'level': level, 'message': message})
        del self.events[:-50]

    # -- market data -------------------------------------------------

    def group_for(self, underlying):
        for g in (self.cfg.get('groups') or []):
            if g.get('underlying') == underlying:
                return g
        return None

    # -- background market data --------------------------------------
    #
    # Nothing below runs on the tick thread. The tick only ever READS the
    # snapshots these publish, so a slow REST call can never stall an exit.

    def start_refresher(self):
        """Start the thread that owns every remaining REST market-data call.

        Two things used to fetch from inside the tick, once a minute each, and
        both could stall it: the option chain (PREMIUM-mode strike resolution)
        and the session VWAPs. The chain was the worse of the two — DhanHelper
        paces that endpoint with a hard `time.sleep(3.0 - elapsed)`, so two
        underlyings in premium mode meant a ~3s stall and three meant ~6s, once
        a minute, while stops were live.
        """
        t = threading.Thread(target=self._refresher_loop, name='focus-refresher', daemon=True)
        t.start()
        self._refresher = t

    def _refresher_loop(self):
        while not self._stopping:
            try:
                self.refresh_market_data()
            except Exception as e:
                logger.warning(f'Refresher pass failed: {e}')
            time.sleep(REFRESH_EVERY_SECONDS)

    def refresh_market_data(self):
        """One refresher pass: extend the ladder, republish chain and VWAP."""
        cfg = self.cfg
        rows = list(cfg.get('rows') or [])
        with self._fills_lock:
            fills = {k: dict(v) for k, v in self.fills.items()}

        self._refresh_ladder(rows, fills)
        self._refresh_chains(rows, fills)
        self._refresh_vwaps(rows, fills)

    def _refresh_ladder(self, rows, fills):
        """Keep an ATM +/- LADDER_STEPS strike ladder on the tick feed.

        This is what lets PREMIUM mode resolve with no REST at all: the chain
        snapshot is built from live_data below. It also means a strike shift
        usually lands on a contract that is already subscribed, so the new leg
        has a price immediately instead of on the next feed round trip.
        """
        wanted = []
        for u in {r.get('underlying') for r in rows if r.get('underlying') in UNDERLYINGS}:
            # The FUTURE, for groups picking ATM off it rather than off spot.
            # It is not an index and so was not covered by the spot feed, which
            # left future_ltp() on the REST path — one blocking quote roughly
            # every second once the tick dropped to 250ms, i.e. the faster loop
            # made it worse. Subscribed here, it becomes a dict read like
            # everything else.
            try:
                fut_sid = self.market.future_id(u)
                if fut_sid:
                    wanted.append((u, {'SECURITY_ID': int(fut_sid)}))
            except Exception as e:
                logger.warning(f'{u}: futures subscription skipped: {e}')

            spot = self.market.spot(u)
            step = STRIKE_STEP[u]
            atm = atm_strike(spot, step)
            if not atm:
                continue
            expiry = self._ladder_expiry(u, rows, fills)
            if not expiry:
                continue
            for i in range(-LADDER_STEPS, LADDER_STEPS + 1):
                strike = atm + i * step
                for leg in ('CE', 'PE'):
                    # find_option reads the in-memory master list and is cached
                    # per contract, so a settled ladder costs nothing per pass.
                    row = self.market.leg(u, expiry, strike, leg)
                    if row is not None:
                        wanted.append((u, row))
        if wanted:
            self.ensure_legs_subscribed(wanted)

    def _ladder_expiry(self, underlying, rows, fills):
        """The expiry this underlying's ladder should cover — whatever its rows
        actually trade, else the nearest."""
        for r in rows:
            if r.get('underlying') == underlying:
                held = fills.get(r.get('id')) or {}
                exp = held.get('expiry') or r.get('expiry')
                if exp:
                    return exp
        return self.market.nearest_expiry(underlying)

    def _refresh_chains(self, rows, fills):
        """Publish {strike: {'CE': ltp, 'PE': ltp}} per (underlying, expiry).

        Built from live_data — the ladder above is already subscribed, so this
        is a dict scan, not a REST call, and the prices are current rather than
        up to a minute old. The REST chain is kept only as a cold-start
        fallback for an underlying whose ticks have not arrived yet, and even
        that runs here, off the tick thread.
        """
        needed = set()
        for r in rows:
            if str(r.get('strikeMode') or 'ATM') != 'PREMIUM':
                continue
            if r.get('underlying') not in UNDERLYINGS:
                continue
            if r['id'] not in fills and str(r.get('status')) != 'armed':
                continue
            expiry = ((fills.get(r['id']) or {}).get('expiry')
                      or r.get('expiry')
                      or self.market.nearest_expiry(r['underlying']))
            if expiry:
                needed.add((r['underlying'], expiry))
        if not needed:
            return

        published = dict(self._chain_snapshot)
        for u, expiry in needed:
            live = self._chain_from_feed(u, expiry)
            if live:
                published[(u, expiry)] = (time.time(), live)
                continue
            # No ticks for this ladder yet. One REST chain, at most once a
            # minute, and harmless here because nothing is waiting on it.
            prev = published.get((u, expiry))
            if prev and time.time() - prev[0] < 60.0:
                continue
            fetched = self._fetch_chain_rest(u, expiry)
            if fetched:
                published[(u, expiry)] = (time.time(), fetched)
        self._chain_snapshot = published

    def _chain_from_feed(self, underlying, expiry):
        """The subscribed ladder's current prices, as a chain-shaped dict."""
        step = STRIKE_STEP[underlying]
        atm = atm_strike(self.market.spot(underlying), step)
        if not atm:
            return {}
        out = {}
        for i in range(-LADDER_STEPS, LADDER_STEPS + 1):
            strike = atm + i * step
            prices = {}
            for leg in ('CE', 'PE'):
                row = self.market.leg(underlying, expiry, strike, leg)
                if row is None:
                    continue
                live = self.helper.live_data.get(str(int(row['SECURITY_ID'])))
                if not live:
                    continue
                px = float(live.get('last_price') or live.get('LTP') or 0.0)
                if px > 0:
                    prices[leg] = px
            if prices:
                out[strike] = prices
        return out

    def _fetch_chain_rest(self, underlying, expiry):
        """Cold-start fallback only. Refresher thread — never the tick."""
        chain = {}
        try:
            # SENSEX splits three ways (CLAUDE.md): its chain keys on security
            # id 1 / BSE_FNO, not on the index's own id 51. Passing the bare
            # symbol resolves to 51 and returns an empty chain, silently.
            if underlying == 'SENSEX':
                df = self.helper.get_option_chain_df('1', expiry, exchange_segment='BSE_FNO')
            else:
                df = self.helper.get_option_chain_df(underlying, expiry)
            # get_option_chain_df sets Strike as the INDEX, not as a column —
            # reading r['Strike'] silently yields nothing.
            if df is not None and not df.empty:
                for strike_raw, r in df.iterrows():
                    try:
                        strike = int(round(float(strike_raw)))
                    except (TypeError, ValueError):
                        continue

                    def px(col):
                        try:
                            return float(r[col] or 0.0)
                        except (KeyError, TypeError, ValueError):
                            return 0.0
                    chain[strike] = {'CE': px('ce_last_price'), 'PE': px('pe_last_price')}
        except Exception as e:
            logger.warning(f'{underlying} {expiry}: chain fetch failed: {e}')
        return chain

    def _refresh_vwaps(self, rows, fills):
        """Recompute the session VWAP of each watched strike pair, once a minute.

        Deliberately still REST and still closed-bar: that construction is what
        makes this number match TradingView and the broker terminal. Computing
        it from ticks instead would be faster and would change the price the
        rule fires at, which is not a trade worth making for a stop.
        """
        wanted = set()
        for r in rows:
            if not r.get('levelVw'):
                continue
            fill = fills.get(r.get('id'))
            if not fill:
                continue
            legs = tuple(l for l in ('CE', 'PE') if fill.get(l))
            if not legs:
                continue
            ce = (fill.get('CE') or {}).get('strike')
            pe = (fill.get('PE') or {}).get('strike')
            wanted.add((r['underlying'], fill.get('expiry') or '', ce, pe, legs))

        if not wanted:
            return
        published = dict(self._vwap_snapshot)
        for key in wanted:
            prev = published.get(key)
            if prev and time.time() - prev[0] < 60.0:
                continue
            underlying, expiry, ce, pe, legs = key
            value = self._compute_side_vwap(underlying, expiry, ce, pe, list(legs))
            published[key] = (time.time(), value)
        self._vwap_snapshot = published

    def _compute_side_vwap(self, underlying, expiry, ce_strike, pe_strike, legs):
        """Session VWAP of just `legs`, off closed 1-minute bars.

        Side-aware for the same reason evaluate_exit is: a CE-only row compared
        against a combined CE+PE VWAP would cross at the wrong premium.
        """
        try:
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            today = datetime.now().strftime('%Y-%m-%d')
            tomorrow = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

            per_leg = []
            for leg in legs:
                strike = ce_strike if leg == 'CE' else pe_strike
                if strike is None:
                    return None
                row = self.market.leg(underlying, expiry, strike, leg)
                if not row:
                    return None
                df = self.helper.get_intraday_minute_data(
                    security_id=str(int(row['SECURITY_ID'])), exchange_segment=seg,
                    instrument_type='OPTIDX', interval='1', from_date=today, to_date=tomorrow)
                if df is None or df.empty:
                    return None
                per_leg.append(df)

            if len(per_leg) != len(legs):
                return None
            # Drop the still-forming bar: its partial volume would drag the
            # running average away from every closed-bar platform's number.
            n = min(len(df) for df in per_leg) - 1
            if n <= 0:
                return None
            num_ = den = 0.0
            for i in range(n):
                typical = vol = 0.0
                for df in per_leg:
                    r = df.iloc[i]
                    try:
                        hi, lo, cl = float(r['high']), float(r['low']), float(r['close'])
                        v = float(r['volume'])
                    except (KeyError, TypeError, ValueError):
                        return None
                    typical += (hi + lo + cl) / 3.0
                    vol += v
                vol /= len(per_leg)
                num_ += typical * vol
                den += vol
            return num_ / den if den > 0 else None
        except Exception as e:
            logger.warning(f'VWAP failed for {underlying} {ce_strike}/{pe_strike}: {e}')
            return None

    # -- snapshot readers (tick thread) ------------------------------

    def _fresh(self, entry):
        """A published snapshot value, or None once it is too old to act on.

        A refresher that has died must make its rules go INERT rather than keep
        firing them off a number from several minutes ago. A stale VWAP closing
        a live position is exactly the failure this whole design avoids.
        """
        if not entry:
            return None
        stamped, value = entry
        if time.time() - stamped > SNAPSHOT_STALE_SECONDS:
            return None
        return value

    def chain_for(self, underlying, expiry):
        return self._fresh(self._chain_snapshot.get((underlying, expiry))) or {}

    def vwap_for(self, underlying, expiry, ce_strike, pe_strike, legs):
        return self._fresh(self._vwap_snapshot.get(
            (underlying, expiry, ce_strike, pe_strike, tuple(legs))))

    # -- trading -----------------------------------------------------

    def enter_row(self, row, group, expiry, ce_strike, pe_strike, reason):
        """Open every leg this row trades. Records only the legs that actually
        got through — a half-filled entry leaves a ledger describing exactly
        what is open, so the exit path closes that and nothing more."""
        u = row['underlying']
        lot = self.market.lot_size(u)
        if not lot:
            self.log('error', f"{u} {row['id'][-4:]}: lot size unresolved — not entering")
            return
        qty = int(row.get('lots') or 0) * lot
        if qty <= 0:
            return
        product = PRODUCT_FOR.get(str(group.get('product') or 'INTRADAY'), 'INTRADAY')

        opened = {}
        for leg in legs_of(row):
            strike = ce_strike if leg == 'CE' else pe_strike
            if strike is None:
                continue
            ok, detail, order_id = self.router.place(u, expiry, strike, leg, 'SELL', qty, product)
            if not ok:
                self.log('error', f"{u} {row['id'][-4:]} {int(strike)}{leg}: entry failed — {detail}")
                continue
            # Recorded immediately at an LTP estimate and marked unconfirmed —
            # the tick thread never waits for a fill. on_order_update() settles
            # the real traded price and quantity when the socket reports one,
            # and reconcile() sizes the leg against the position book either way.
            price = self.market.ltp(u, self.market.leg(u, expiry, strike, leg))
            opened[leg] = {'strike': int(strike), 'qty': qty, 'entryPrice': price,
                           'confirmed': False, 'openedTs': time.time(),
                           'orderId': str(order_id) if order_id else None}
            if order_id:
                self._pending[str(order_id)] = (row['id'], leg)
            self.log('info', f"{u} {row['id'][-4:]}: SELL {qty} {int(strike)}{leg} @ ~{price:.2f} ({detail})")

        if not opened:
            self.log('error', f"{u} {row['id'][-4:]}: entry aborted — no leg opened")
            return

        opened['expiry'] = expiry
        opened['product'] = product
        # Recorded so the ledger entry stays self-describing: if its config row
        # is later deleted, orphan_rows() can still tell what this position is
        # and keep the exit ladder reaching it.
        opened['underlying'] = u
        opened['entryPremium'] = sum(v['entryPrice'] for k, v in opened.items()
                                     if k in ('CE', 'PE'))
        opened['enteredAt'] = datetime.now().isoformat()
        with self._fills_lock:
            self.fills[row['id']] = opened
            self.save_state()
        self.log('info', f"{u} {row['id'][-4:]}: ENTERED ({reason}) — "
                         f"combined entry {opened['entryPremium']:.2f}")

    def net_hint_for(self, underlying, expiry, strike, leg):
        """This leg's net quantity from the last reconcile snapshot, or None.

        None means "no fresh snapshot" and sends OrderRouter.close down its own
        lookup — correct, just slower. Anything older than the reconcile window
        is not offered: sizing an exit off a stale book is exactly the mistake
        resolve_exit_qty exists to prevent.
        """
        if self._net_snapshot is None:
            return None
        if time.time() - self._last_reconcile > RECONCILE_EVERY_SECONDS:
            return None
        key = self.router.position_key(underlying, expiry, strike, leg)
        if not key:
            return None
        return int(self._net_snapshot.get(key, 0))

    def exit_row(self, row, reason):
        """Close every leg the ledger says this row holds. The ledger entry is
        dropped only once every leg reports closed, so a partial failure leaves
        the remainder tracked and retried on the next tick instead of being
        forgotten while still open."""
        fill = self.fills.get(row['id'])
        if not fill:
            return
        u = row['underlying']
        expiry = fill.get('expiry') or ''
        product = fill.get('product') or 'INTRADAY'
        self.log('info', f"{u} {row['id'][-4:]}: exiting — {reason}")

        remaining = {}
        for leg in ('CE', 'PE'):
            held = fill.get(leg)
            if not held:
                continue
            ok, detail = self.router.close(
                u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product,
                net_hint=self.net_hint_for(u, expiry, held['strike'], leg))
            if ok:
                self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
            else:
                self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: exit FAILED — {detail}")
                remaining[leg] = held

        with self._fills_lock:
            if remaining:
                remaining['expiry'] = expiry
                remaining['product'] = product
                remaining['underlying'] = fill.get('underlying')
                remaining['entryPremium'] = fill.get('entryPremium')
                remaining['enteredAt'] = fill.get('enteredAt')
                self.fills[row['id']] = remaining
            else:
                self.fills.pop(row['id'], None)
            self.save_state()

    def exit_leg(self, row, leg, reason):
        """Close just ONE leg on its own SL x breach, leaving the other leg —
        and the row itself — exactly as it was. Mirrors exit_row's
        retry-on-failure shape but only ever touches this one leg's ledger
        entry; the other leg (and its own rules) is untouched."""
        fill = self.fills.get(row['id'])
        held = (fill or {}).get(leg)
        if not held:
            return
        u = row['underlying']
        expiry = fill.get('expiry') or ''
        product = fill.get('product') or 'INTRADAY'
        self.log('info', f"{u} {row['id'][-4:]}: leg-exit {leg} — {reason}")

        ok, detail = self.router.close(u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product,
                                       net_hint=self.net_hint_for(u, expiry, held['strike'], leg))
        if ok:
            self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
            with self._fills_lock:
                fill.pop(leg, None)
                if not any(k in fill for k in ('CE', 'PE')):
                    self.fills.pop(row['id'], None)
                self.save_state()
        else:
            self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: leg-exit FAILED — {detail}")
            # Left in the ledger untouched — evaluate_leg_exit re-fires next
            # tick and retries, same as exit_row's partial-failure path.

    def reconcile(self):
        """Write the ledger down to what the broker actually shows.

        The ledger is this worker's sizing authority, and it moves on order
        ACKs — which are not fills. Three ways it drifts above broker truth:

          * an exit was accepted but never filled (or only partly), so the
            ledger says flat while the position is live;
          * a leg was closed elsewhere — another instance, a manual square-off,
            the broker's own auto-square-off;
          * an entry was ACKed but rejected at the exchange, so the ledger
            claims a position that does not exist.

        Reconciliation is strictly DOWNWARD. A broker quantity larger than the
        ledger belongs to something else — another row, another strategy, a
        manual trade — and claiming it would let this worker close a position it
        never opened, which is the whole failure resolve_exit_qty exists to
        prevent.

        A leg is left alone for RECONCILE_GRACE_SECONDS after it was last
        opened: the position book lags a fresh fill, and a zero read in that
        window is latency, not truth.
        """
        if not self.fills:
            return
        # Throttled independently of the tick. The tick now runs several times a
        # second so the exit rules react immediately; the position book does not
        # change that fast and is a REST call against an account-wide budget, so
        # reconciling on every tick would spend the budget the leg quotes and
        # the order path depend on.
        now = time.time()
        if now - self._last_reconcile < RECONCILE_EVERY_SECONDS:
            return
        self._last_reconcile = now

        with self._fills_lock:
            underlyings = {f.get('underlying') for f in self.fills.values()}
        snapshot = self.router.net_positions(underlyings=[u for u in underlyings if u])
        if snapshot is None:
            # Unknown, not empty. Leaving the ledger untouched is the only safe
            # reading of a failed position call.
            return
        # Kept for this tick's exits: resolve_exit_qty would otherwise repeat
        # this very call on the critical path of every close order.
        self._net_snapshot = snapshot

        changed = False
        with self._fills_lock:
            for rid, fill in list(self.fills.items()):
                u = fill.get('underlying')
                expiry = fill.get('expiry') or ''
                for leg in ('CE', 'PE'):
                    held = fill.get(leg)
                    if not held:
                        continue
                    if now - float(held.get('openedTs') or 0) < RECONCILE_GRACE_SECONDS:
                        continue
                    key = self.router.position_key(u, expiry, held['strike'], leg)
                    if not key:
                        continue
                    broker_qty = abs(int(snapshot.get(key, 0)))
                    own_qty = int(held.get('qty') or 0)
                    if broker_qty >= own_qty:
                        continue
                    changed = True
                    if broker_qty <= 0:
                        self.log('warning',
                                 f"{u} {rid[-4:]} {held['strike']}{leg}: broker shows no position but "
                                 f"the ledger held {own_qty} — dropping the leg (closed elsewhere, or "
                                 f"the entry never filled).")
                        fill.pop(leg, None)
                    else:
                        self.log('warning',
                                 f"{u} {rid[-4:]} {held['strike']}{leg}: ledger {own_qty} vs broker "
                                 f"{broker_qty} — writing the ledger down.")
                        held['qty'] = broker_qty
                if not any(k in fill for k in ('CE', 'PE')):
                    self.fills.pop(rid, None)
            if changed:
                self.save_state()

    def orphan_rows(self, rows):
        """Synthetic rows for ledger entries whose config row has been deleted.

        Deleting a row does not close its position. The page blocks the delete
        while it can see one, but it resolves positions off the row's CURRENT
        strike config, so a row whose strikes have drifted (or that this worker
        entered without the page ever marking it entered) can be deleted while
        this worker is still holding it. Those fills would otherwise never be
        looked at again: never exited, never bell-squared, never shown on
        screen — a live short sitting in a state file.

        They are rebuilt into minimal rows so the exit ladder still reaches
        them. Every user-configured rule is dropped, because there is no
        config left to read: no H-up/L-down, no SL, no VWAP, no book exit, no
        exit time. What survives is only what was never the user's to opt out
        of — the 15:17 intraday bell (via the fill's own recorded product) and
        the account-level risk budget.
        """
        # Forget ids that have since been closed, so a row that is deleted,
        # re-added and deleted again warns each time rather than once ever.
        with self._fills_lock:
            self._warned_orphans &= set(self.fills)
            ledger = list(self.fills.items())
        known = {r.get('id') for r in rows}
        out = []
        for rid, fill in ledger:
            if rid in known:
                continue
            u = fill.get('underlying')
            if u not in UNDERLYINGS:
                # A ledger entry from before `underlying` was recorded. It
                # cannot be quoted or closed without knowing its index, so it
                # is reported and left alone rather than acted on blindly.
                if rid not in self._warned_orphans:
                    self._warned_orphans.add(rid)
                    self.log('error', f'Orphaned fill {rid[-4:]} has no underlying recorded — '
                                      f'cannot manage it. Close it manually at the broker.')
                continue
            if rid not in self._warned_orphans:
                self._warned_orphans.add(rid)
                held = ', '.join(f"{fill[l]['strike']}{l}" for l in ('CE', 'PE') if fill.get(l))
                self.log('warning', f'Row {rid[-4:]} was deleted from the config but this worker '
                                    f'still holds {u} {held}. Keeping the 15:17 bell and the '
                                    f'account risk budget on it; its own level exits are gone.')
            out.append({
                'id': rid,
                'underlying': u,
                'status': 'entered',
                'orphan': True,
                'expiry': fill.get('expiry') or '',
                'side': 'BOTH',
                'dte': 'Any',
                'entryTime': '',
                'exitTime': '',
            })
        return out

    # -- the tick ----------------------------------------------------

    def tick(self):
        self.load_config()
        # Broker truth first: every rule below is priced and sized off the
        # ledger, so it has to agree with the position book before it is used.
        self.reconcile()
        cfg = self.cfg
        rows = list(cfg.get('rows') or [])
        # Fills whose config row is gone still hold real positions — see
        # orphan_rows. Appended so every loop below (quotes, exits, the status
        # snapshot and the account risk sweep) reaches them too.
        rows += self.orphan_rows(rows)

        now = datetime.now(IST)
        now_minutes = now.hour * 60 + now.minute
        today = now.strftime('%Y-%m-%d')

        # The live arm expires with the session. liveRealMoney lives on disk and
        # this worker is auto-started when the page mounts, so without the date
        # check a config armed on Friday would still be armed on Monday morning
        # — trading a setup nobody has looked at today. Mirrors the same check
        # in FocusTool.tsx's applyServerConfig.
        live = bool(cfg.get('liveRealMoney')) and str(cfg.get('liveArmedOn') or '') == today
        if bool(cfg.get('liveRealMoney')) and not live and not self._warned_stale_arm:
            self._warned_stale_arm = True
            self.log('warning', f"Config says live, but it was armed on "
                                f"{cfg.get('liveArmedOn') or 'an unknown date'}, not {today}. "
                                f"Treating as dry run — re-arm LIVE · REAL MONEY on the page.")
        if live:
            self._warned_stale_arm = False

        snapshot = []
        total_pnl = 0.0
        spots = {}
        # Legs quoted this tick — handed to the feed so the NEXT tick reads them
        # from live_data instead of paying a blocking REST quote each.
        tick_legs = []

        # Only touch underlyings that actually have rows — every quote costs an
        # API call against an account-wide rate limit.
        for u in {r.get('underlying') for r in rows if r.get('underlying') in UNDERLYINGS}:
            spots[u] = self.market.spot(u)

        # ATM base per each index group's own "ATM BY" pick (mirrors
        # FocusTool.tsx's rowLive). Futures LTP is only fetched for an
        # underlying that both wants it AND actually needs resolving right
        # now (armed or open) — same rate-limit reasoning as the chain fetch
        # below, and get_ltp caches nothing, so an unconditional fetch here
        # would cost one more REST call per tick per underlying.
        atm_base = dict(spots)
        for u in {r.get('underlying') for r in rows if r.get('underlying') in UNDERLYINGS}:
            group = self.group_for(u)
            if not group or group.get('atmBy') != 'Fut':
                continue
            wants_it = any(
                r.get('underlying') == u and (r['id'] in self.fills or str(r.get('status')) == 'armed')
                for r in rows
            )
            if not wants_it:
                continue
            fut = self.market.future_ltp(u)
            if fut > 0:
                atm_base[u] = fut

        # No chain fetch here. The refresher thread publishes it (built from
        # the subscribed ladder's live ticks, so it is current rather than up
        # to a minute old); the tick only reads, and an absent snapshot simply
        # leaves strikes unresolved, which evaluate_entry already refuses to
        # trade on.

        for row in rows:
            u = row.get('underlying')
            if u not in UNDERLYINGS:
                continue
            group = self.group_for(u)
            step = STRIKE_STEP[u]
            spot = spots.get(u, 0.0)
            expiry = row.get('expiry') or self.market.nearest_expiry(u)
            atm = atm_strike(atm_base.get(u, spot), step)
            ce_strike, pe_strike = resolve_row_strikes(
                row, atm, step, self.chain_for(u, expiry))

            fill = self.fills.get(row['id'])
            if row.get('orphan'):
                # No config row left, so no index group either. The product
                # comes from the fill itself (that is what the position was
                # opened under) and every optional rule stays off.
                group = {'underlying': u, 'enabled': False, 'bookExit': False,
                         'product': (fill or {}).get('product') or 'INTRADAY'}
            # Once a row is open, only quote legs the ledger actually still
            # holds — NOT legs_of(row) blindly. A leg closed by exit_leg (the
            # per-leg SL x below) is gone from `fill`, and legs_of(row) still
            # names it (it only reflects the Side toggle), so summing it back
            # into `premium` would compare the pair-level VW/SL x rules
            # against a phantom leg that no longer has any position behind it.
            # Pre-entry (no fill yet), legs_of(row) is the right preview.
            legs = list(fill) if fill else legs_of(row)
            legs = [l for l in legs if l in ('CE', 'PE')]

            # Live premium and P&L for just the legs this row trades, marked
            # against this worker's own fills (see the module docstring).
            #
            # Quotes are only pulled for rows that actually need them: an open
            # row (its exit rules are priced) or an armed one (about to be).
            # A draft row is inert, and quoting it would spend the account-wide
            # ~1 req/s budget that the open rows' exit rules depend on.
            premium = 0.0
            pnl = 0.0
            leg_ltp = {}
            needs_quotes = bool(fill) or str(row.get('status')) == 'armed'
            if needs_quotes:
                for leg in legs:
                    strike = (fill.get(leg) or {}).get('strike') if fill else (
                        ce_strike if leg == 'CE' else pe_strike)
                    if strike is None:
                        continue
                    leg_row = self.market.leg(u, expiry, strike, leg)
                    tick_legs.append((u, leg_row))
                    ltp = self.market.ltp(u, leg_row)
                    leg_ltp[leg] = ltp
                    premium += ltp
                    held = (fill or {}).get(leg)
                    if held and ltp > 0:
                        # Short: profit is the premium decaying below what it sold for.
                        pnl += (float(held['entryPrice']) - ltp) * float(held['qty'])
            if fill:
                total_pnl += pnl

            vwap = None
            if row.get('levelVw') and fill:
                ce_s = (fill.get('CE') or {}).get('strike', ce_strike)
                pe_s = (fill.get('PE') or {}).get('strike', pe_strike)
                if ce_s is not None and pe_s is not None:
                    vwap = self.vwap_for(u, expiry, ce_s, pe_s, legs)

            snapshot.append({
                'id': row['id'], 'underlying': u, 'status': row.get('status'),
                # The strikes actually HELD once open, not the live ATM
                # resolution — the page pins its position lookup to these, and
                # a drifting ATM would point it at a strike nobody holds.
                'ceStrike': (fill.get('CE') or {}).get('strike') if fill else ce_strike,
                'peStrike': (fill.get('PE') or {}).get('strike') if fill else pe_strike,
                'expiry': expiry,
                'orphan': bool(row.get('orphan')),
                'open': bool(fill), 'premium': round(premium, 2),
                'pnl': round(pnl, 2), 'vwap': round(vwap, 2) if vwap else None,
                'entryPremium': round(float((fill or {}).get('entryPremium') or 0.0), 2),
            })

            if not live:
                continue

            if fill:
                # Leg-wise SL x first — it can fire independently of, and more
                # often than, the pair-level rules. Skip the whole-row check
                # this tick once a leg exit has been sent: the fill dict it
                # would be evaluated against is about to change underneath it.
                leg_exit_sent = False
                for leg in ('CE', 'PE'):
                    do_leg_exit, leg_reason = evaluate_leg_exit(row, leg, fill, leg_ltp.get(leg, 0.0))
                    if do_leg_exit:
                        self.exit_leg(row, leg, leg_reason)
                        leg_exit_sent = True
                        break
                if leg_exit_sent:
                    continue

                do_exit, reason = evaluate_exit(
                    row, group, fill, now_minutes, spot, premium, vwap, pnl)
                if do_exit:
                    self.exit_row(row, reason)
            else:
                dte = dte_for(expiry, today)
                ready = any((ce_strike if l == 'CE' else pe_strike) is not None for l in legs)
                do_enter, _reason = evaluate_entry(row, group, now_minutes, dte, ready, flat=True)
                if do_enter:
                    self.enter_row(row, group, expiry, ce_strike, pe_strike, _reason)

        # Anything quoted this tick joins the feed, so it is free from now on.
        self.ensure_legs_subscribed(tick_legs)

        # Account-level budget, measured on this worker's own rows.
        if total_pnl > self.peak_pnl:
            self.peak_pnl = total_pnl
        exit_all, risk_reason, self.lock_floor, self.trail_state = evaluate_global_risk(
            cfg, total_pnl, self.peak_pnl, self.lock_floor)
        if live and exit_all and self.fills:
            self.log('warning', f'Account risk triggered — {risk_reason}')
            for row in rows:
                if row['id'] in self.fills:
                    self.exit_row(row, risk_reason)
            self.save_state()

        self.write_status(snapshot, total_pnl, live)

    def write_status(self, snapshot, total_pnl, live, force=False):
        # Paced independently of the tick — see STATUS_EVERY_SECONDS.
        now = time.time()
        if not force and now - self._last_status < STATUS_EVERY_SECONDS:
            return
        self._last_status = now
        atomic_write(STATUS_FILE_ONCE if self.once else STATUS_FILE, {
            'status': 'RUNNING',
            'pid': os.getpid(),
            'broker': self.broker,
            'dryRun': self.dry_run,
            'liveRealMoney': live,
            'startedAt': self.started_at,
            'lastUpdate': datetime.now().isoformat(),
            'openRows': len(self.fills),
            'totalPnl': round(total_pnl, 2),
            'peakPnl': round(self.peak_pnl, 2),
            'lockFloor': round(self.lock_floor, 2) if self.lock_floor is not None else None,
            'trailState': self.trail_state,
            'rows': snapshot,
            'events': self.events[-20:],
        })

    def run(self):
        self.connect()
        self.load_state()
        self.load_config()

        if self.once:
            self.tick()
            return

        self.log('info', f'Focus Tool rows worker started — broker={self.broker} '
                         f'dry_run={self.dry_run}')
        try:
            while True:
                if os.path.exists(STOP_TRIGGER):
                    try:
                        os.remove(STOP_TRIGGER)
                    except OSError:
                        pass
                    self._stopping = True
                    self.log('info', 'Stop trigger detected — exiting. Open positions left as they are.')
                    break
                try:
                    self.tick()
                except Exception as e:
                    logger.exception(f'Tick failed: {e}')
                time.sleep(TICK_SECONDS)
        except KeyboardInterrupt:
            self.log('info', 'Interrupted — exiting. Open positions left as they are.')
        finally:
            self._stopping = True
            st = read_json(STATUS_FILE) or {}
            st['status'] = 'STOPPED'
            st['lastUpdate'] = datetime.now().isoformat()
            if not self.once:
                atomic_write(STATUS_FILE, st)


def main():
    parser = argparse.ArgumentParser(description='Focus Tool worker (live rows schema)')
    parser.add_argument('--broker', default='dhan', choices=['dhan', 'zerodha', 'kotak'],
                        help='Broker to ROUTE ORDERS to. Market data is always Dhan.')
    parser.add_argument('--dry-run', action='store_true',
                        help='Evaluate every rule and log the orders without placing them')
    parser.add_argument('--once', action='store_true',
                        help='Single tick then exit (test harness — skips the singleton mutex '
                             'and writes a separate status file)')
    args = parser.parse_args()

    setup_logging()

    if not args.once and not acquire_singleton():
        logger.error('Another Focus Tool rows worker is already running — refusing to start. '
                     'Two workers would both enter every armed row.')
        sys.exit(1)

    worker = FocusRowsWorker(broker=args.broker, dry_run=args.dry_run, once=args.once)
    try:
        worker.run()
    except Exception as e:
        logger.exception(f'Worker failed: {e}')
        if not args.once:
            atomic_write(STATUS_FILE, {
                'status': 'ERROR', 'pid': os.getpid(), 'error': str(e),
                'lastUpdate': datetime.now().isoformat(),
            })
        sys.exit(1)


if __name__ == '__main__':
    main()
