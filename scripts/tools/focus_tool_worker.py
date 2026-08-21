#!/usr/bin/env python
"""
Focus Tool worker — the rule engine behind the Straddles & Strangles terminal.

The dashboard page at /focus-tool writes debug/focus_tool_config.json and reads
debug/focus_tool_status.json. It never places an order for an armed row itself.
This process does, on a 1-second loop, so a scheduled entry or a spot-level stop
keeps working after the browser tab is closed.

    venv\\Scripts\\python.exe scripts/tools/focus_tool_worker.py
    venv\\Scripts\\python.exe scripts/tools/focus_tool_worker.py --once --dry-run

Contract with the dashboard, matching every other long-running process here:
  read   debug/focus_tool_config.json   (reloaded whenever its mtime moves)
  write  debug/focus_tool_status.json   (heartbeat every tick)
  stop   debug/focus_tool_stop.trigger

Two things this worker deliberately does NOT do:

  * It never closes anything on shutdown. A stop trigger, a crash and a
    market-closed exit all leave open positions exactly where they are. They are
    the user's to manage; a process exiting is not a reason to trade.

  * It never trusts the broker's net quantity when sizing an exit. Dhan nets
    every position by security id, so a strike this worker holds may be shared
    with a running strategy. Exits go through lib/strategy_risk.resolve_exit_qty,
    which closes what THIS worker opened, clamped by what the broker still shows.
    Skipping that flattened a sibling strategy's leg for real on 2026-07-30.

Market data comes from Dhan for every broker. An option's LTP is set by the
exchange, not by the account you view it through, so there is no reason to spawn
a second identical feed — only order routing is genuinely broker-specific. This
mirrors the QUOTE_CHANNEL decision in rs_dashboard/lib/useLiveOptionsWS.ts.

The rule functions below (parse_hhmm, atm_strike, resolve_strikes, dte_for,
dte_matches, pair_pnl, evaluate_entry, evaluate_exit, evaluate_global_risk) are a
line-for-line port of rs_dashboard/lib/focusTool.ts. Change one, change both in
the same commit: a disagreement means the screen shows one thing and the account
does another.
"""

import argparse
import ctypes
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

DEBUG_DIR    = os.path.join(ROOT, 'debug')
CONFIG_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_config.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_status.json')
# --once is a test harness and deliberately skips the singleton mutex, so it can
# run while a real worker is live. It must therefore never write the status file
# the dashboard reads — a single test tick would otherwise blank out a running
# worker's rows and then mark it STOPPED.
STATUS_FILE_ONCE = os.path.join(DEBUG_DIR, 'focus_tool_status_once.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'focus_tool_stop.trigger')
LOG_FILE     = os.path.join(DEBUG_DIR, 'focus_tool_worker_events.log')

TICK_SECONDS = 1.0

# Repo-wide intraday auto-exit (CLAUDE.md). Mirrors INTRADAY_EXIT_MINUTES.
INTRADAY_EXIT_MINUTES = 15 * 60 + 17

# Cash-market exchange each underlying's options trade on, and the order segment
# that follows from it. SENSEX is the one that splits: its chain and contracts
# key on BSE / BSE_FNO while the index's own spot is served under IDX_I.
UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE'}
SPOT_IDS   = {'NIFTY': 13, 'BANKNIFTY': 25, 'SENSEX': 51}
STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'SENSEX': 100}

logger = logging.getLogger('focus_tool')

_singleton_handle = None


# ─── Infrastructure ───────────────────────────────────────────────

def setup_logging():
    os.makedirs(DEBUG_DIR, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        handlers=[logging.FileHandler(LOG_FILE, encoding='utf-8'), logging.StreamHandler(sys.stdout)],
    )


def atomic_write(path, data):
    """Write-then-rename. The dashboard polls this file every second and a torn
    read would render as an empty terminal."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except Exception as e:
        logger.warning(f'Failed to write {path}: {e}')
        return False


def acquire_singleton():
    """At most one worker process.

    Note the inversion versus copy_trade_bridge.acquire_singleton, which fails
    OPEN on ambiguity: a missing copy-trade bridge is a silent outage, so
    starting a possible duplicate is the lesser evil there. Here it is the other
    way round — two workers reading the same config would BOTH enter every armed
    row, doubling live positions. So a genuine ERROR_ALREADY_EXISTS refuses to
    start. Only a total failure of the mutex API falls through, and the API
    route's PID check still covers that case.

    use_last_error=True + ctypes.get_last_error() rather than
    windll.kernel32.GetLastError(): the latter can read a stale 183 left by an
    unrelated ctypes call and refuse to start with no other process in existence.
    """
    global _singleton_handle
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel32.CreateMutexW(None, False, 'dhan_algo_focus_tool_worker')
        err = ctypes.get_last_error()
        if not handle:
            return True
        _singleton_handle = handle
        return err != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


# ─── Rule engine (mirror of rs_dashboard/lib/focusTool.ts) ────────

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


def atm_strike(spot, step):
    if not (spot > 0) or not (step > 0):
        return 0
    return int(round(spot / step) * step)


def resolve_strikes(atm, offset, step):
    """CE above, PE below — offset 0 is a straddle, n a symmetric strangle. The
    CE strike can never end up below the PE strike, so the inversion the
    straddle strategies guard against is unconstructible here."""
    width = abs(int(offset)) * step
    return atm + width, atm - width


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
    if dte is None:
        return False
    if filt == 'any':
        return dte >= 0
    if filt == '0':
        return dte == 0
    if filt == '1':
        return dte == 1
    if filt == '0+1':
        return dte in (0, 1)
    return False


def pair_pnl(fill, ce_ltp, pe_ltp, side):
    """Mark-to-market on the pair in rupees. `qty` is absolute units already."""
    entry = float(fill['ceEntry']) + float(fill['peEntry'])
    now = ce_ltp + pe_ltp
    move = entry - now if side == 'SELL' else now - entry
    return move * float(fill['qty'])


def entry_combined(fill):
    return float(fill['ceEntry']) + float(fill['peEntry'])


def evaluate_entry(row, now_minutes, dte, group_started):
    """(enter, reason). A DRAFT row never enters — that is what Arm is for."""
    if not group_started:
        return False, 'group stopped'
    if row.get('state') != 'ARMED':
        return False, f"state {row.get('state')}"
    if not (int(row.get('lots') or 0) > 0):
        return False, 'lots must be > 0'
    if not dte_matches(row.get('dte', 'any'), dte):
        return False, f"DTE {dte} != {row.get('dte')}"

    entry_at = parse_hhmm(row.get('entryTime'))
    if entry_at is None:
        return False, 'no entry time'
    if now_minutes < entry_at:
        return False, f"waiting for {row.get('entryTime')}"
    if now_minutes >= INTRADAY_EXIT_MINUTES:
        return False, 'past 15:17 intraday cutoff'

    # Opening after the row's own exit time would be flattened next tick.
    exit_at = parse_hhmm(row.get('exitTime'))
    if exit_at is not None and now_minutes >= exit_at:
        return False, f"past its own exit time {row.get('exitTime')}"

    return True, f"entry time {row.get('entryTime')} reached"


def evaluate_exit(row, now_minutes, spot, ce_ltp, pe_ltp, vwap, book_exit):
    """(exit, reason) for one entered row. First match wins, in this order:

        1. the 15:17 intraday bell
        2. the group's Book Exit spot level
        3. the row's own exit time
        4. the row's H-up / L-down spot levels
        5. VWAP cross
        6. SL rupees / SL multiple

    Every spot-derived rule is suppressed when spot <= 0. A failed quote read
    arrives as 0, and 0 is below every conceivable L-down level — treating that
    as a breach would flatten the whole book on one dropped tick.
    """
    if row.get('state') != 'ENTERED' or not row.get('fill'):
        return False, ''

    if now_minutes >= INTRADAY_EXIT_MINUTES:
        return True, 'Intraday auto-exit 15:17'

    spot_known = spot > 0

    if spot_known and (book_exit or {}).get('enabled'):
        hi, lo = book_exit.get('spotHigh'), book_exit.get('spotLow')
        if hi is not None and spot >= hi:
            return True, f'Book exit: spot {spot} >= {hi}'
        if lo is not None and spot <= lo:
            return True, f'Book exit: spot {spot} <= {lo}'

    exit_at = parse_hhmm(row.get('exitTime'))
    if exit_at is not None and now_minutes >= exit_at:
        return True, f"Exit time {row.get('exitTime')}"

    exits = row.get('exits') or {}
    hi, lo = exits.get('spotHigh'), exits.get('spotLow')

    if spot_known:
        if hi is not None and spot >= hi:
            return True, f'H-up {hi} breached (spot {spot})'
        if lo is not None and spot <= lo:
            return True, f'L-down {lo} breached (spot {spot})'

    combined = ce_ltp + pe_ltp

    # A short pair is hurt by premium expanding through VWAP, a long pair by it
    # collapsing through VWAP. combined > 0 guards a pair of missing quotes
    # (0 + 0) from reading as "collapsed below VWAP" and exiting a long.
    if exits.get('vwap') and vwap and vwap > 0 and combined > 0:
        if row.get('side') == 'SELL' and combined >= vwap:
            return True, f'Premium {combined:.2f} >= VWAP {vwap:.2f}'
        if row.get('side') == 'BUY' and combined <= vwap:
            return True, f'Premium {combined:.2f} <= VWAP {vwap:.2f}'

    sl_rs = exits.get('slRupees')
    if sl_rs and sl_rs > 0 and combined > 0:
        pnl = pair_pnl(row['fill'], ce_ltp, pe_ltp, row.get('side'))
        if pnl <= -sl_rs:
            return True, f'SL Rs{sl_rs} hit (P&L Rs{pnl:.0f})'

    # SL x is the stop as a factor of the entry premium, applied symmetrically:
    # a short exits on a multiple, a long on the reciprocal. Stated as a ratio
    # rather than a rupee loss because the rupee form goes negative for a long
    # once the multiple exceeds 2.
    sl_mult = exits.get('slMult')
    if sl_mult and sl_mult > 1 and combined > 0:
        entry = entry_combined(row['fill'])
        if entry > 0:
            if row.get('side') == 'SELL' and combined >= entry * sl_mult:
                return True, f'SL x{sl_mult}: premium {combined:.2f} vs entry {entry:.2f}'
            if row.get('side') == 'BUY' and combined <= entry / sl_mult:
                return True, f'SL x{sl_mult}: premium {combined:.2f} vs entry {entry:.2f}'

    return False, ''


def evaluate_global_risk(cfg, total_pnl, peak_pnl, lock_floor):
    """(exit_all, reason, lock_floor, trail_state) for the account-level budget.

    The trail is components/ProfitLock.tsx's state machine moved server-side:
    dormant until P&L clears TRIGGER, then a floor that ratchets up 1:1 with
    every new peak and never moves down. TRIGGER is the hysteresis — without it
    the floor would arm on the first rupee of profit and fire on the next tick.

    Returns the floor to persist rather than mutating, so a restart mid-session
    resumes from whatever was last written instead of silently re-arming.
    """
    risk = cfg.get('risk') or {}
    trail = cfg.get('trail') or {}
    trail_state = 'INACTIVE'

    if risk.get('enabled'):
        target = risk.get('targetRs')
        stop = risk.get('stopRs')
        if target and target > 0 and total_pnl >= target:
            return True, f'Target Rs{target} reached (Rs{total_pnl:.0f})', lock_floor, trail_state
        # STOP is stored as a positive magnitude; the UI labels it a loss limit.
        if stop and stop > 0 and total_pnl <= -stop:
            return True, f'Stop Rs{stop} hit (Rs{total_pnl:.0f})', lock_floor, trail_state

    trigger = trail.get('triggerRs')
    if trail.get('enabled') and trigger and trigger > 0:
        gap = trail.get('lockRs') or 0
        if gap < 0:
            gap = 0

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


# ─── Market data ──────────────────────────────────────────────────

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
        self._vwap_cache = {}       # (ce_id, pe_id) -> (minute_key, vwap)
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

    # -- VWAP --------------------------------------------------------

    def premium_vwap(self, underlying, ce_row, pe_row):
        """Session VWAP of the CE+PE combined premium, recomputed once a minute.

        Same construction as nifty_vwap_1min_straddle: typical price of the
        combined bar weighted by the average of the two legs' volumes. Only
        called for rows that actually enabled the VW exit, so the two API calls
        per minute are paid only where they buy something.
        """
        if not ce_row or not pe_row:
            return None
        key = (str(ce_row['SECURITY_ID']), str(pe_row['SECURITY_ID']))
        minute_key = datetime.now().strftime('%Y-%m-%d %H:%M')
        hit = self._vwap_cache.get(key)
        if hit and hit[0] == minute_key:
            return hit[1]

        vwap = None
        try:
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            today = datetime.now().strftime('%Y-%m-%d')
            tomorrow = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

            frames = []
            for row in (ce_row, pe_row):
                df = self.helper.get_intraday_minute_data(
                    security_id=str(int(row['SECURITY_ID'])), exchange_segment=seg,
                    instrument_type='OPTIDX', interval='1',
                    from_date=today, to_date=tomorrow)
                if df is None or df.empty:
                    frames = []
                    break
                frames.append(df)

            if len(frames) == 2:
                ce, pe = frames
                n = min(len(ce), len(pe))
                ce, pe = ce.tail(n).reset_index(drop=True), pe.tail(n).reset_index(drop=True)

                def col(df, *names):
                    for nm in names:
                        if nm in df.columns:
                            return df[nm].astype(float)
                    return None

                ch, cl, cc = col(ce, 'high', 'High'), col(ce, 'low', 'Low'), col(ce, 'close', 'Close')
                ph, pl, pc = col(pe, 'high', 'High'), col(pe, 'low', 'Low'), col(pe, 'close', 'Close')
                cv, pv = col(ce, 'volume', 'Volume'), col(pe, 'volume', 'Volume')

                if all(x is not None for x in (ch, cl, cc, ph, pl, pc, cv, pv)):
                    typical = ((ch + ph) + (cl + pl) + (cc + pc)) / 3.0
                    vol = (cv + pv) / 2.0
                    total = float(vol.sum())
                    if total > 0:
                        vwap = float((typical * vol).sum() / total)
        except Exception as e:
            logger.warning(f'VWAP computation failed for {key}: {e}')
            vwap = None

        self._vwap_cache[key] = (minute_key, vwap)
        return vwap


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

    def place(self, underlying, expiry, strike, opt_type, side, qty, product):
        """(ok, detail). `qty` is absolute units, never lots."""
        if self.dry_run:
            return True, f'DRY-RUN {side} {qty} {underlying} {expiry} {int(strike)}{opt_type}'

        if self.broker == 'dhan':
            row = self.market.leg(underlying, expiry, strike, opt_type)
            if not row:
                return False, f'Contract not found: {underlying} {expiry} {int(strike)}{opt_type}'
            seg = 'BSE_FNO' if UNDERLYING_EXCHANGE.get(underlying) == 'BSE' else 'NSE_FNO'
            try:
                order_id = self.helper.place_order(
                    security_id=str(int(row['SECURITY_ID'])), exchange_segment=seg,
                    transaction_type=side, quantity=int(qty), order_type='MARKET',
                    product_type=product, price=0.0)
            except Exception as e:
                return False, f'Order failed: {e}'
            return (True, str(order_id)) if order_id else (False, 'Order rejected by broker')

        child = self._child(underlying)
        if not child:
            return False, f'{self.broker} session unavailable'
        try:
            symbol = child.resolve_symbol(strike, expiry, opt_type)
            if not symbol:
                return False, f'{self.broker}: no symbol for {int(strike)}{opt_type} {expiry}'
            mapped = child.map_product(product)
            placed, order_ids, err = child.place_child_order(symbol, side, int(qty), mapped)
            if err:
                return False, f'{self.broker}: {err} (placed {placed}/{qty})'
            if placed < qty:
                return False, f'{self.broker}: partial fill {placed}/{qty}'
            return True, ','.join(str(o) for o in order_ids)
        except Exception as e:
            return False, f'{self.broker}: {e}'

    def close(self, underlying, expiry, strike, opt_type, side, own_qty, product):
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


# ─── Worker ───────────────────────────────────────────────────────

class FocusWorker:
    def __init__(self, dry_run=False, once=False):
        self.dry_run = dry_run
        self.status_file = STATUS_FILE_ONCE if once else STATUS_FILE
        self.helper = None
        self.market = None
        self.router = None
        self.cfg = None
        self._cfg_mtime = None
        self.realised = 0.0
        self.peak_pnl = 0.0
        self.lock_floor = None
        self.trail_state = 'INACTIVE'
        self.halted_reason = ''
        self._session_date = datetime.now().date()

    # -- config ------------------------------------------------------

    def load_config(self, force=False):
        """Reload whenever the file's mtime moves, so a Save in the browser
        takes effect on the next tick instead of at the next restart."""
        try:
            mtime = os.path.getmtime(CONFIG_FILE)
        except OSError:
            if self.cfg is None:
                self.cfg = {'broker': 'dhan', 'live': False, 'risk': {}, 'trail': {}, 'groups': []}
            return

        if not force and mtime == self._cfg_mtime:
            return
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                self.cfg = json.load(f)
            self._cfg_mtime = mtime
            logger.info(f"Config reloaded: broker={self.cfg.get('broker')} live={self.cfg.get('live')}")
        except Exception as e:
            # Keep running on the last good config. A half-written file is a
            # transient, not a reason to stop managing open positions.
            logger.warning(f'Config reload failed, keeping previous: {e}')

    def save_config(self):
        """Persist row state changes (fills, exits, errors) back to the config.

        The config file is the single source of truth for row state, so a
        restart resumes managing whatever was open rather than forgetting it.
        Written atomically; the API route re-sanitises anything the browser
        sends back on top of this.
        """
        if not atomic_write(CONFIG_FILE, self.cfg):
            return
        try:
            self._cfg_mtime = os.path.getmtime(CONFIG_FILE)
        except OSError:
            pass

    # -- lifecycle ---------------------------------------------------

    def connect(self):
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper

        dhan = get_dhan_client()
        if not dhan:
            raise RuntimeError('Dhan auth failed — run login.py to refresh the access token')
        self.helper = DhanHelper(dhan)
        self.market = MarketData(self.helper)
        return True

    def is_live(self):
        """Real orders require BOTH the config's LIVE toggle and the absence of
        --dry-run. Two independent brakes, either of which is sufficient."""
        return bool(self.cfg.get('live')) and not self.dry_run

    def rows_of(self, group):
        return group.get('rows') or []

    # -- entry / exit ------------------------------------------------

    def enter_row(self, group, row, atm, expiry, step):
        underlying = group['underlying']
        lot = self.market.lot_size(underlying)
        if not lot:
            row['state'] = 'ERROR'
            row['error'] = f'Lot size unresolved for {underlying} — refusing to size an order'
            logger.error(row['error'])
            return

        ce_strike, pe_strike = resolve_strikes(atm, row.get('offset', 0), step)
        qty = int(row['lots']) * lot
        side = 'SELL' if row['side'] == 'SELL' else 'BUY'
        product = group.get('product', 'INTRADAY')

        ce_row = self.market.leg(underlying, expiry, ce_strike, 'CE')
        pe_row = self.market.leg(underlying, expiry, pe_strike, 'PE')
        ce_ltp = self.market.ltp(underlying, ce_row)
        pe_ltp = self.market.ltp(underlying, pe_row)

        # Both legs share the row's side, so there is no long-first ordering to
        # exploit here; CE then PE simply keeps the logs readable.
        legs = [('CE', ce_strike), ('PE', pe_strike)]
        placed = []
        for opt_type, strike in legs:
            ok, detail = self.router.place(underlying, expiry, strike, opt_type, side, qty, product)
            if not ok:
                row['state'] = 'ERROR'
                row['error'] = f'{opt_type} entry failed: {detail}'
                logger.error(f"[{underlying}] row {row['id']}: {row['error']}")
                # A half-open pair is worse than none: unwind what did fill so
                # the row is not left with naked directional risk it never asked
                # for. If the unwind itself fails, the error stays on the row.
                for done_type, done_strike in placed:
                    rev = 'BUY' if side == 'SELL' else 'SELL'
                    undo_ok, undo_detail = self.router.close(
                        underlying, expiry, done_strike, done_type, rev, qty, product)
                    if not undo_ok:
                        row['error'] += f' | {done_type} unwind FAILED: {undo_detail} — position is naked'
                        logger.error(f"[{underlying}] row {row['id']}: {row['error']}")
                return
            placed.append((opt_type, strike))

        row['state'] = 'ENTERED'
        row.pop('error', None)
        row['fill'] = {
            'ceStrike': ce_strike, 'peStrike': pe_strike,
            'ceEntry': ce_ltp, 'peEntry': pe_ltp,
            'qty': qty, 'ts': datetime.now().isoformat(timespec='seconds'),
            'ceId': str(int(ce_row['SECURITY_ID'])) if ce_row else None,
            'peId': str(int(pe_row['SECURITY_ID'])) if pe_row else None,
        }
        mode = 'LIVE' if self.is_live() else 'SIM'
        logger.info(f"[{underlying}] row {row['id']} ENTERED ({mode}): {side} {row['lots']} lot(s) "
                    f"{ce_strike}CE @ {ce_ltp} + {pe_strike}PE @ {pe_ltp}, qty {qty}")

    def exit_row(self, group, row, expiry, reason, ce_ltp, pe_ltp):
        underlying = group['underlying']
        fill = row.get('fill') or {}
        qty = int(fill.get('qty') or 0)
        product = group.get('product', 'INTRADAY')
        # Closing direction is the opposite of how the row was opened.
        close_side = 'BUY' if row.get('side') == 'SELL' else 'SELL'

        failures = []
        for opt_type, strike_key in (('CE', 'ceStrike'), ('PE', 'peStrike')):
            strike = fill.get(strike_key)
            if strike is None:
                failures.append(f'{opt_type}: no strike recorded')
                continue
            ok, detail = self.router.close(underlying, expiry, strike, opt_type, close_side, qty, product)
            if not ok:
                failures.append(f'{opt_type}: {detail}')

        pnl = pair_pnl(fill, ce_ltp, pe_ltp, row.get('side')) if fill else 0.0

        if failures:
            # Stay ENTERED. An exit that partly failed still has live risk, and
            # marking it EXITED would hide that from both the screen and the
            # next tick's rules.
            row['error'] = f'Exit failed ({reason}): ' + ' | '.join(failures)
            logger.error(f"[{underlying}] row {row['id']}: {row['error']}")
            return False

        row['state'] = 'EXITED'
        row.pop('error', None)
        self.realised += pnl
        logger.info(f"[{underlying}] row {row['id']} EXITED: {reason} | P&L Rs{pnl:.0f}")
        return True

    # -- tick --------------------------------------------------------

    def tick(self):
        self.load_config()
        cfg = self.cfg or {}

        # A new session day resets the trail and the realised tally. Without
        # this an overnight process would still be measuring against
        # yesterday's peak.
        today = datetime.now().date()
        if today != self._session_date:
            logger.info('New session day — resetting realised P&L, peak and trail lock')
            self._session_date = today
            self.realised = 0.0
            self.peak_pnl = 0.0
            self.lock_floor = None
            self.halted_reason = ''

        now = datetime.now()
        now_minutes = now.hour * 60 + now.minute
        today_str = now.strftime('%Y-%m-%d')

        broker = cfg.get('broker', 'dhan')
        if self.router is None or self.router.broker != broker or self.router.dry_run != (not self.is_live()):
            self.router = OrderRouter(self.helper, self.market, broker, dry_run=not self.is_live())

        unrealised = 0.0
        status_groups = []
        dirty = False
        # Rows that are entered right now, so a global exit knows what to close.
        open_rows = []

        for group in cfg.get('groups') or []:
            underlying = group.get('underlying')
            if underlying not in SPOT_IDS:
                continue

            rows = self.rows_of(group)
            started = bool(group.get('started'))
            has_work = started or any(r.get('state') == 'ENTERED' for r in rows)
            if not rows or not has_work:
                status_groups.append({'underlying': underlying, 'rows': []})
                continue

            step = group.get('strikeStep') or STRIKE_STEP.get(underlying, 50)
            spot = self.market.spot(underlying)
            fut = self.market.future_ltp(underlying) if group.get('atmBy') == 'FUT' else 0.0
            anchor = fut if (group.get('atmBy') == 'FUT' and fut > 0) else spot
            atm = atm_strike(anchor, step)
            expiry = self.market.nearest_expiry(underlying)
            dte = dte_for(expiry, today_str) if expiry else None

            status_rows = []
            for row in rows:
                state = row.get('state')

                # An entered row is priced off the strikes it actually holds;
                # everything else previews at the current ATM.
                if state == 'ENTERED' and row.get('fill'):
                    ce_strike = row['fill']['ceStrike']
                    pe_strike = row['fill']['peStrike']
                else:
                    ce_strike, pe_strike = resolve_strikes(atm, row.get('offset', 0), step)

                ce_row = self.market.leg(underlying, expiry, ce_strike, 'CE') if expiry else None
                pe_row = self.market.leg(underlying, expiry, pe_strike, 'PE') if expiry else None
                ce_ltp = self.market.ltp(underlying, ce_row)
                pe_ltp = self.market.ltp(underlying, pe_row)

                vwap = None
                if state == 'ENTERED' and (row.get('exits') or {}).get('vwap'):
                    vwap = self.market.premium_vwap(underlying, ce_row, pe_row)

                reason = ''
                pnl = 0.0

                if state == 'ARMED' and not self.halted_reason:
                    ok, why = evaluate_entry(row, now_minutes, dte, started)
                    reason = why
                    if ok and expiry:
                        self.enter_row(group, row, atm, expiry, step)
                        dirty = True
                        state = row.get('state')
                        if state == 'ENTERED':
                            ce_strike = row['fill']['ceStrike']
                            pe_strike = row['fill']['peStrike']

                if state == 'ENTERED' and row.get('fill'):
                    pnl = pair_pnl(row['fill'], ce_ltp, pe_ltp, row.get('side'))
                    unrealised += pnl
                    open_rows.append((group, row, expiry, ce_ltp, pe_ltp))

                    should_exit, why = evaluate_exit(
                        row, now_minutes, spot, ce_ltp, pe_ltp, vwap, group.get('bookExit'))
                    if should_exit:
                        reason = why
                        if self.exit_row(group, row, expiry, why, ce_ltp, pe_ltp):
                            unrealised -= pnl
                            open_rows.pop()
                        dirty = True
                        state = row.get('state')

                status_rows.append({
                    'id': row.get('id'), 'state': state,
                    'ceStrike': ce_strike, 'peStrike': pe_strike,
                    'ceLtp': ce_ltp, 'peLtp': pe_ltp, 'combined': ce_ltp + pe_ltp,
                    'vwap': vwap, 'pnl': round(pnl, 2),
                    'reason': reason, 'error': row.get('error'),
                })

            status_groups.append({
                'underlying': underlying, 'spot': spot, 'fut': fut, 'atm': atm,
                'expiry': expiry, 'dte': dte, 'lot': self.market.lot_size(underlying),
                'rows': status_rows,
            })

        total = self.realised + unrealised
        if total > self.peak_pnl:
            self.peak_pnl = total

        exit_all, why, self.lock_floor, self.trail_state = evaluate_global_risk(
            cfg, total, self.peak_pnl, self.lock_floor)

        if exit_all and open_rows:
            logger.warning(f'GLOBAL RISK: {why} — closing {len(open_rows)} open row(s)')
            self.halted_reason = why
            for group, row, expiry, ce_ltp, pe_ltp in open_rows:
                self.exit_row(group, row, expiry, why, ce_ltp, pe_ltp)
            dirty = True
        elif exit_all:
            self.halted_reason = why

        if dirty:
            self.save_config()

        self.write_status('RUNNING', status_groups, self.realised, unrealised, total)

    def write_status(self, status, groups=None, realised=0.0, unrealised=0.0, total=0.0, message=''):
        atomic_write(self.status_file, {
            'status': status,
            'pid': os.getpid(),
            'last_update_ts': time.time(),
            'last_update': datetime.now().isoformat(timespec='seconds'),
            'broker': (self.cfg or {}).get('broker', 'dhan'),
            'live': self.is_live(),
            'dry_run': self.dry_run,
            'message': message or self.halted_reason,
            'groups': groups or [],
            'pnl': {
                'realised': round(realised, 2),
                'unrealised': round(unrealised, 2),
                'total': round(total, 2),
                'peak': round(self.peak_pnl, 2),
                'lock': round(self.lock_floor, 2) if self.lock_floor is not None else None,
                'trailState': self.trail_state,
            },
        })

    # -- run ---------------------------------------------------------

    def run(self, once=False):
        self.load_config(force=True)
        self.write_status('STARTING', message='Connecting to Dhan')

        try:
            self.connect()
        except Exception as e:
            logger.error(f'Startup failed: {e}')
            self.write_status('ERROR', message=str(e))
            return 1

        mode = 'DRY-RUN' if self.dry_run else 'LIVE-CAPABLE'
        logger.info(f'Focus Tool worker started ({mode}, pid {os.getpid()})')

        while True:
            started = time.time()
            try:
                self.tick()
            except Exception as e:
                # One bad tick must not kill a process that is managing open
                # positions. Log it, surface it, and try again next second.
                logger.exception(f'Tick failed: {e}')
                self.write_status('RUNNING', message=f'Tick error: {e}')

            if once:
                break

            if os.path.exists(STOP_TRIGGER):
                logger.info('Stop trigger found — shutting down. Open positions are left untouched.')
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                break

            time.sleep(max(0.0, TICK_SECONDS - (time.time() - started)))

        if not once:
            self.write_status('STOPPED', message='Worker stopped — open positions untouched')
        return 0


def main():
    parser = argparse.ArgumentParser(description='Focus Tool straddle/strangle rule engine')
    parser.add_argument('--once', action='store_true',
                        help='Run a single tick and exit (for testing)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Never place a real order, whatever the config says')
    args = parser.parse_args()

    setup_logging()

    if not args.once and not acquire_singleton():
        logger.error('Another Focus Tool worker is already running — refusing to start. '
                     'Two workers would enter every armed row twice.')
        return 1

    return FocusWorker(dry_run=args.dry_run, once=args.once).run(once=args.once)


if __name__ == '__main__':
    sys.exit(main())
