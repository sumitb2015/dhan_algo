#!/usr/bin/env python
"""
Focus Tool worker for the LIVE terminal (rs_dashboard/components/FocusTool.tsx).

The browser page can only act while its tab is open. This process runs the same
rule engine server-side on a 1-second loop, so a scheduled entry, a spot-level
stop or the 15:17 bell keeps working after the tab is closed, the laptop sleeps
or the browser crashes.

    venv\\Scripts\\python.exe scripts/tools/focus_tool_rows_worker.py --broker dhan
    venv\\Scripts\\python.exe scripts/tools/focus_tool_rows_worker.py --once --dry-run

Not to be confused with scripts/tools/focus_tool_worker.py. That one drives the
OTHER, unwired Focus Tool rewrite (lib/focusTool.ts + components/focus/*) and
speaks a different config schema entirely — different file, different row
shape, different rule vocabulary. This module deliberately shares nothing with
it but the two genuinely generic pieces below (MarketData, OrderRouter), which
are imported rather than copied because they only ever speak in
underlying/expiry/strike/option-type and know nothing about either schema.

Contract with the dashboard, matching every other long-running process here:
  read   debug/focus_tool_rows.json          (the page's own config, reloaded on mtime)
  write  debug/focus_tool_rows_worker_status.json     (heartbeat every tick)
  write  debug/focus_tool_rows_worker_state.json      (this worker's own fill ledger)
  stop   debug/focus_tool_rows_worker_stop.trigger

Three deliberate non-behaviours:

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

# Spot arrives over the WebSocket, but option-leg LTPs are still REST reads and
# Dhan's quote endpoint is limited to roughly one request a second ACCOUNT-WIDE
# (shared with every other script and the dashboard). Two seconds keeps an open
# straddle's two legs inside that budget while staying far quicker than the
# level-exit rules need — spot levels and stops are not sub-second decisions.
TICK_SECONDS = 2.0

# Repo-wide intraday auto-exit (CLAUDE.md), mirroring FocusTool.tsx's
# INTRADAY_BACKSTOP_HM.
INTRADAY_EXIT_MINUTES = 15 * 60 + 17

STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'SENSEX': 100}
UNDERLYINGS = ('NIFTY', 'BANKNIFTY', 'SENSEX')

# Group product -> the product string each broker's order path expects. Mirrors
# PRODUCT_ALIAS in FocusTool.tsx. OrderRouter maps the child-broker side itself.
PRODUCT_FOR = {'INTRADAY': 'INTRADAY', 'MARGIN': 'MARGIN'}

IST = timezone(timedelta(hours=5, minutes=30))

logger = logging.getLogger('focus_tool_rows')

_singleton_handle = None

# The two genuinely schema-agnostic pieces of the sibling worker. They speak
# only in underlying/expiry/strike/option-type, so both schemas can drive them.
from scripts.tools.focus_tool_worker import (      # noqa: E402
    MarketData, OrderRouter, UNDERLYING_EXCHANGE,
)


# ─── Infrastructure ───────────────────────────────────────────────

def setup_logging():
    os.makedirs(DEBUG_DIR, exist_ok=True)
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


def evaluate_entry(row, group, now_minutes, dte, strikes_ready):
    """(enter, reason). A draft row never enters — that is what Arm is for."""
    if not group or not group.get('enabled'):
        return False, 'index not started'
    if str(row.get('status')) != 'armed':
        return False, f"status {row.get('status')}"
    if not (int(row.get('lots') or 0) > 0):
        return False, 'lots must be > 0'
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


def evaluate_exit(row, group, fill, now_minutes, spot, premium, vwap, pnl):
    """(exit, reason) for one row this worker holds open. First match wins:

        1. the 15:17 intraday bell (MIS rows only)
        2. the group's Book Exit spot level
        3. the row's own exit time
        4. H-up / L-down spot levels
        5. VWAP cross
        6. SL rupees / SL multiple

    `premium` and `pnl` cover only the legs this row's Side trades, and so does
    the entry price they are compared against — a CE-only row measured against
    a CE+PE premium would cross its threshold at the wrong number.

    Every spot-derived rule is suppressed when spot <= 0. A failed quote read
    arrives as 0, and 0 is below every conceivable L-down level — treating that
    as a breach would flatten the whole book on one dropped tick. Premium-driven
    rules are likewise suppressed at 0.
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
            return True, f'Book exit: spot {spot:.2f} >= {hi}'
        if lo is not None and lo > 0 and spot <= lo:
            return True, f'Book exit: spot {spot:.2f} <= {lo}'

    exit_at = parse_hhmm(row.get('exitTime'))
    if exit_at is not None and now_minutes >= exit_at:
        return True, f"Exit time {row.get('exitTime')}"

    if spot_known:
        hi, lo = num(row.get('levelHigh')), num(row.get('levelLow'))
        if hi is not None and spot >= hi:
            return True, f'H-up {hi} breached (spot {spot:.2f})'
        if lo is not None and spot <= lo:
            return True, f'L-down {lo} breached (spot {spot:.2f})'

    # This tool only ever opens with a SELL, so it is hurt by premium EXPANDING
    # through VWAP or through a multiple of the entry price.
    if row.get('levelVw') and vwap and vwap > 0 and premium > 0 and premium >= vwap:
        return True, f'Premium {premium:.2f} >= VWAP {vwap:.2f}'

    sl_rs = num(row.get('slRupees'))
    if sl_rs is not None and sl_rs > 0 and pnl <= -sl_rs:
        return True, f'SL Rs{sl_rs:.0f} hit (P&L Rs{pnl:.0f})'

    sl_mult = num(row.get('slMultiplier'))
    if sl_mult is not None and sl_mult > 1 and premium > 0:
        entry = float(fill.get('entryPremium') or 0.0)
        if entry > 0 and premium >= entry * sl_mult:
            return True, f'SL x{sl_mult}: premium {premium:.2f} vs entry {entry:.2f}'

    return False, ''


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
        return True, f'{leg} SL x{mult}: premium {ltp:.2f} vs entry {entry:.2f}'
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
            return True, f'Target Rs{target:.0f} reached (Rs{total_pnl:.0f})', lock_floor, trail_state
        # STOP is stored as a positive magnitude; the UI labels it a loss limit.
        if stop is not None and stop > 0 and total_pnl <= -stop:
            return True, f'Stop Rs{stop:.0f} hit (Rs{total_pnl:.0f})', lock_floor, trail_state

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
                        f'Trail lock Rs{lock_floor:.0f} hit (Rs{total_pnl:.0f}, peak Rs{peak_pnl:.0f})',
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
        self.started_at = datetime.now().isoformat()
        self._chain_cache = {}     # (underlying, expiry) -> (minute_key, chain)
        self._vwap_cache = {}      # (underlying, expiry, ce, pe, side) -> (minute_key, vwap)

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

    def start_spot_feed(self):
        """Subscribe the three index spots over the market-feed WebSocket.

        Spot is read on every tick for every underlying that has rows, and
        Dhan's quote REST endpoint is rate-limited to roughly one request a
        second ACCOUNT-WIDE. Polling it at tick speed would 429 constantly and
        starve the option-leg quotes that actually gate exits. get_ltp()
        prefers helper.live_data over REST (see CLAUDE.md), so one long-lived
        subscription makes spot effectively free and leaves the REST budget for
        the legs.

        Best-effort: if the socket cannot start, MarketData.spot() falls back to
        REST exactly as before — slower, but not wrong.
        """
        try:
            IDX_SEGMENT, FULL = 0, 21
            instruments = [(IDX_SEGMENT, str(sid), FULL)
                           for sid in (13, 25, 51)]   # NIFTY, BANKNIFTY, SENSEX
            self.helper.start_websocket(instruments)
            self.log('info', 'Spot feed subscribed (NIFTY, BANKNIFTY, SENSEX)')
        except Exception as e:
            self.log('warning', f'Spot WebSocket unavailable, falling back to REST quotes: {e}')

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

    def chain(self, underlying, expiry):
        """{strike: {'CE': ltp, 'PE': ltp}} for PREMIUM-mode strike resolution,
        refreshed once a minute. Only fetched for underlyings that actually have
        a PREMIUM-mode row — Dhan's chain endpoint is rate-limited account-wide."""
        key = (underlying, expiry)
        minute = datetime.now().strftime('%Y-%m-%d %H:%M')
        hit = self._chain_cache.get(key)
        if hit and hit[0] == minute:
            return hit[1]
        chain = {}
        try:
            # SENSEX splits three ways (CLAUDE.md): its chain keys on security
            # id 1 / BSE_FNO, not on the index's own id 51. Passing the bare
            # symbol resolves to 51 and returns an empty chain, silently.
            if underlying == 'SENSEX':
                df = self.helper.get_option_chain_df('1', expiry, exchange_segment='BSE_FNO')
            else:
                df = self.helper.get_option_chain_df(underlying, expiry)
            # get_option_chain_df sets Strike as the INDEX (dhan_helper.py:3534),
            # not as a column — reading r['Strike'] silently yields nothing.
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
        self._chain_cache[key] = (minute, chain)
        return chain

    def side_vwap(self, underlying, expiry, ce_strike, pe_strike, legs):
        """Session VWAP of the premium of just `legs`, recomputed once a minute.

        Side-aware for the same reason evaluate_exit is: a CE-only row compared
        against a combined CE+PE VWAP would cross at the wrong premium. Uses
        only closed bars so the number matches what TradingView and the broker
        terminal show (see scripts/tools/focus_tool_vwap.py, same construction).
        """
        key = (underlying, expiry, ce_strike, pe_strike, tuple(legs))
        minute = datetime.now().strftime('%Y-%m-%d %H:%M')
        hit = self._vwap_cache.get(key)
        if hit and hit[0] == minute:
            return hit[1]

        vwap = None
        try:
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            today = datetime.now().strftime('%Y-%m-%d')
            tomorrow = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')
            now = datetime.now(tz=IST)

            per_leg = []
            for leg in legs:
                strike = ce_strike if leg == 'CE' else pe_strike
                row = self.market.leg(underlying, expiry, strike, leg)
                if not row:
                    per_leg = []
                    break
                df = self.helper.get_intraday_minute_data(
                    security_id=str(int(row['SECURITY_ID'])), exchange_segment=seg,
                    instrument_type='OPTIDX', interval='1', from_date=today, to_date=tomorrow)
                if df is None or df.empty:
                    per_leg = []
                    break
                per_leg.append(df)

            if per_leg and len(per_leg) == len(legs):
                # Drop the still-forming bar: its partial volume would drag the
                # running average away from every closed-bar platform's number.
                n = min(len(df) for df in per_leg) - 1
                if n > 0:
                    num_ = den = 0.0
                    for i in range(n):
                        typical = vol = 0.0
                        ok = True
                        for df in per_leg:
                            r = df.iloc[i]
                            try:
                                hi, lo, cl = float(r['high']), float(r['low']), float(r['close'])
                                v = float(r['volume'])
                            except (KeyError, TypeError, ValueError):
                                ok = False
                                break
                            typical += (hi + lo + cl) / 3.0
                            vol += v
                        if not ok:
                            num_ = den = 0.0
                            break
                        vol /= len(per_leg)
                        num_ += typical * vol
                        den += vol
                    if den > 0:
                        vwap = num_ / den
            _ = now
        except Exception as e:
            logger.warning(f'VWAP failed for {key}: {e}')
            vwap = None

        self._vwap_cache[key] = (minute, vwap)
        return vwap

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
            ok, detail = self.router.place(u, expiry, strike, leg, 'SELL', qty, product)
            if not ok:
                self.log('error', f"{u} {row['id'][-4:]} {int(strike)}{leg}: entry failed — {detail}")
                continue
            price = self.market.ltp(u, self.market.leg(u, expiry, strike, leg))
            opened[leg] = {'strike': int(strike), 'qty': qty, 'entryPrice': price}
            self.log('info', f"{u} {row['id'][-4:]}: SELL {qty} {int(strike)}{leg} @ ~{price:.2f} ({detail})")

        if not opened:
            self.log('error', f"{u} {row['id'][-4:]}: entry aborted — no leg opened")
            return

        opened['expiry'] = expiry
        opened['product'] = product
        opened['entryPremium'] = sum(v['entryPrice'] for k, v in opened.items()
                                     if k in ('CE', 'PE'))
        opened['enteredAt'] = datetime.now().isoformat()
        self.fills[row['id']] = opened
        self.save_state()
        self.log('info', f"{u} {row['id'][-4:]}: ENTERED ({reason}) — "
                         f"combined entry {opened['entryPremium']:.2f}")

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
                u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product)
            if ok:
                self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
            else:
                self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: exit FAILED — {detail}")
                remaining[leg] = held

        if remaining:
            remaining['expiry'] = expiry
            remaining['product'] = product
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

        ok, detail = self.router.close(u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product)
        if ok:
            self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
            del fill[leg]
            if not any(k in fill for k in ('CE', 'PE')):
                self.fills.pop(row['id'], None)
            self.save_state()
        else:
            self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: leg-exit FAILED — {detail}")
            # Left in the ledger untouched — evaluate_leg_exit re-fires next
            # tick and retries, same as exit_row's partial-failure path.

    # -- the tick ----------------------------------------------------

    def tick(self):
        self.load_config()
        cfg = self.cfg
        rows = cfg.get('rows') or []
        live = bool(cfg.get('liveRealMoney'))

        now = datetime.now(IST)
        now_minutes = now.hour * 60 + now.minute
        today = now.strftime('%Y-%m-%d')

        snapshot = []
        total_pnl = 0.0
        spots = {}

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

        # Same budget reasoning as the leg quotes below: only PREMIUM-mode rows
        # that are actually armed or open need a chain to resolve against.
        needs_chain = {
            (r['underlying'], r.get('expiry') or self.market.nearest_expiry(r['underlying']))
            for r in rows
            if str(r.get('strikeMode') or 'ATM') == 'PREMIUM'
            and r.get('underlying') in UNDERLYINGS
            and (r['id'] in self.fills or str(r.get('status')) == 'armed')
        }
        chains = {k: self.chain(*k) for k in needs_chain}

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
                row, atm, step, chains.get((u, expiry)))

            fill = self.fills.get(row['id'])
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
                    ltp = self.market.ltp(u, self.market.leg(u, expiry, strike, leg))
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
                    vwap = self.side_vwap(u, expiry, ce_s, pe_s, legs)

            snapshot.append({
                'id': row['id'], 'underlying': u, 'status': row.get('status'),
                'ceStrike': ce_strike, 'peStrike': pe_strike, 'expiry': expiry,
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
                do_enter, _reason = evaluate_entry(row, group, now_minutes, dte, ready)
                if do_enter:
                    self.enter_row(row, group, expiry, ce_strike, pe_strike, _reason)

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

    def write_status(self, snapshot, total_pnl, live):
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
