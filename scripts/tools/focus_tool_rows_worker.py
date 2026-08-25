#!/usr/bin/env python
"""
Focus Tool worker for the LIVE terminal (rs_dashboard/components/FocusTool.tsx).

The browser page can only act while its tab is open. This process runs the same
rule engine server-side on a 1-second loop, so a scheduled entry, a spot-level
stop or the 15:17 bell keeps working after the tab is closed, the laptop sleeps
or the browser crashes.

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

  * It never treats a broker ACK as a fill. `place_order` returning an id means
    Dhan accepted the order, not that the exchange traded it. Entries wait for a
    terminal status and record the ACTUAL traded price and quantity; a leg that
    cannot be confirmed is recorded as unconfirmed and reconciled against the
    position book on the next tick rather than trusted.

And one thing it does every tick: it reconciles its ledger against the broker's
own position book, writing quantities DOWN (never up) when the broker shows
less than the ledger claims. Without that, an exit order that was accepted but
never filled would zero the ledger while the position was still live — the row
would read as flat and every rule would stop watching it.

Because it owns a fill ledger, P&L here is marked against what THIS worker
opened, not against the whole account. Closed/rolled legs bank into
`bookedPnl` on the fill (and into `sessionBookedPnl` once the row goes fully
flat), so a leg-wise SL that drops the CE does not make the row's P&L collapse
to only the leftover PE. That cumulative number is also what the account-level
Target/Stop/Trail is measured on — an unrelated strategy's drawdown must not
flatten this tool's rows. The browser's Risk/MTM panel shows whole-account P&L
and so can differ; the page stands its own scheduler down whenever this worker
is running, so only one of the two is ever acting.

Status on the config row is written by this worker too: `entered` on a
successful entry, `exited` once every leg is gone. Leaving status at `armed`
was how a finished cycle immediately re-entered on the next tick.

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
# Page writes this when it sees the broker already flat on a leg the worker
# still pins (auth-failed reconcile, manual square-off elsewhere). Same
# consume-and-delete shape as STOP_TRIGGER.
DROP_LEGS_FILE = os.path.join(DEBUG_DIR, 'focus_tool_drop_legs.json')
# Per-request drop files from the page (Exit All races a shared JSON queue).
DROP_LEGS_GLOB = os.path.join(DEBUG_DIR, 'focus_tool_drop_*.json')
LOG_FILE     = os.path.join(DEBUG_DIR, 'focus_tool_rows_worker.log')

# Spot AND every armed/open option leg arrive over the WebSocket (see
# ensure_legs_subscribed). get_ltp prefers live_data, so quotes are CPU-only
# once subscribed. Tick stays at 2s in this pass — tightening cadence is a
# separate follow-up now that the REST-rate-limit reason for 2s is gone.
TICK_SECONDS = 2.0

# Market-feed segment / packet codes (same as focus_tool_ws.py).
NSE_FNO_FEED = 2
BSE_FNO_FEED = 8
FEED_FULL = 21

# How long a freshly opened leg is exempt from reconciliation. The position book
# lags a fill by a second or two, and reading that lag as "the broker shows
# nothing" would drop a live leg from the ledger moments after opening it.
RECONCILE_GRACE_SECONDS = 20.0

# How long to wait for an entry order to reach a terminal status before giving
# up and recording the leg as unconfirmed. Market orders on an index option fill
# in well under this; the wait exists so a slow fill is not mistaken for a
# failed one.
FILL_TIMEOUT_SECONDS = 20

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


def evaluate_row_exit(row, spot, premium, entry_premium, pnl, vwap, vwap_close):
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

    # Checked against the last CLOSED candle's premium, not the live tick — a
    # spurious wick shouldn't fire a real exit. vwapBufferPct additionally
    # requires the close to clear VWAP by more than a % margin before it
    # counts as a breach; blank/0 means no buffer. This tool only ever opens
    # with a SELL, so it is hurt by premium EXPANDING through VWAP.
    if row.get('levelVw') and vwap_close is not None and vwap_close > 0 and vwap is not None and vwap > 0:
        buffer_pct = num(row.get('vwapBufferPct')) or 0.0
        threshold = vwap * (1 + buffer_pct / 100.0)
        if vwap_close >= threshold:
            return f'VW breached: closed premium {vwap_close:.2f} ≥ VWAP+buffer {threshold:.2f}'

    sl_rs = num(row.get('slRupees'))
    if sl_rs is not None and sl_rs > 0 and pnl <= -sl_rs:
        return f'SL ₹{js_num(sl_rs)} hit (P&L ₹{pnl:.0f})'

    sl_mult = num(row.get('slMultiplier'))
    if sl_mult is not None and sl_mult > 1:
        if entry_premium > 0 and premium > 0 and premium >= entry_premium * sl_mult:
            return (f'SL ×{js_num(sl_mult)} hit '
                    f'(premium {premium:.2f} vs entry {entry_premium:.2f})')
    return None


def broker_avg_trusted(broker_qty, own_qty):
    """Safe to treat the broker's live position average as THIS row's own
    entry price for one leg?

    Only when the broker's whole position at that security exactly equals
    what this row's own ledger claims — i.e. this row can fully account for
    it. A broker qty larger than our own means something else also holds
    this leg: another row's own ledger (two straddles parked on the same ATM
    strike is a legitimate shape, and Dhan nets them into one blended
    average that is neither row's own true entry price), OR an untracked
    residual with no ledger entry at all (a leg-wise SL close, a ghost-pin
    drop, a partial fill that never fully reconciled) — the kind of sharing
    a same-row-id count alone cannot see. A broker qty SMALLER than our own
    means the snapshot/ledger disagree (a stale read). Neither is a safe
    "this average is only mine" signal.

    `broker_qty` is None when the security wasn't found in the snapshot at
    all (unknown, not zero) — also untrusted.
    """
    return broker_qty is not None and broker_qty == own_qty


def side_premium_entry(fill, leg_ltp, broker_avg=None):
    """Qty-weighted average (premium, entry_premium) across held legs.

    Mirrors sidePremium / the qty-weighted `entryPremium` FocusTool.tsx stamps
    onto RowLive, unit for unit: `num += price * qty; den += qty; num / den`.
    The pair SL x rule compares premium against entry_premium, so both MUST be
    on the same scale — a raw CE+PE sum compared against a weighted average
    (or vice versa) breaches at roughly double or half the intended level, and
    is unrelated to what the equal-notional case happens to look like. This
    used to feed evaluate_exit a plain sum (`premium += ltp` in the tick loop)
    against the ledger's own sum-at-entry `entryPremium` field — self
    consistent in isolation, but not what the browser's evaluateRowExit
    actually computes once sidePremium became qty-weighted, so the same row
    could breach on one engine and not the other.

    `broker_avg`, when given, is preferred per leg over the ledger's own
    entryPrice for the entry side — see evaluate_leg_exit's doc comment.
    """
    num_p = den_p = 0.0
    num_e = den_e = 0.0
    for leg in ('CE', 'PE'):
        held = (fill or {}).get(leg)
        if not held:
            continue
        qty = abs(float(held.get('qty') or 0))
        if not (qty > 0):
            continue
        ltp = float((leg_ltp or {}).get(leg) or 0.0)
        if ltp > 0:
            num_p += ltp * qty
            den_p += qty
        av = (broker_avg or {}).get(leg)
        entry = float(av) if av else float(held.get('entryPrice') or 0.0)
        if entry > 0:
            num_e += entry * qty
            den_e += qty
    premium = num_p / den_p if den_p > 0 else 0.0
    entry_premium = num_e / den_e if den_e > 0 else 0.0
    return premium, entry_premium


def evaluate_exit(row, group, fill, now_minutes, spot, premium, entry_premium, vwap, vwap_close, pnl):
    """(exit, reason) for one row this worker holds open. First match wins:

        1. the 15:17 intraday bell (MIS rows only)
        2. the group's Book Exit spot level
        3. the row's own exit time
        4. everything in evaluate_row_exit — H-up / L-down / VWAP / SL

    The first three are clock- and group-driven and belong to the worker's
    scheduler; the browser evaluates them in its own tick loop for the same
    reason. Only the fourth is a shared, tested rule.

    `premium`/`entry_premium` must already be the qty-weighted pair from
    side_premium_entry — see its doc comment for why a plain sum does not
    parity-match the browser's sidePremium/entryPremium.
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
        row, spot, premium, entry_premium, pnl, vwap, vwap_close)
    return (True, reason) if reason else (False, '')


def evaluate_leg_exit(row, leg, fill, ltp, broker_avg=None):
    """(exit, reason) for one leg's OWN SL x — independent of the pair-level
    slMultiplier/slRupees in evaluate_exit, and independent of row['side']: a
    leftover position on a leg the row no longer trades still deserves its own
    stop. Only fires while that leg is actually held; a closed leg has no
    entry price left to compare against.

    `broker_avg`, when given and positive, is the broker's own LIVE position
    average (sellAvg for a short) and is preferred over the ledger's own
    `entryPrice`. This worker's ledger only ever records the price of the
    order IT placed; if this leg's average has since moved because of a fill
    the ledger never saw (an add from elsewhere, a reconcile write-down), the
    ledger price silently diverges from what the position is actually costed
    at — and the page's own SL x display already reads the broker average
    (legStopPremium in focusToolRules.ts), so the two disagreed about where
    the stop sits. Falls back to the ledger price when unavailable (position
    call failed this tick, or the fill is too fresh to appear yet).
    """
    held = (fill or {}).get(leg)
    if not held:
        return False, ''
    mult = num(row.get('ceSlMultiplier' if leg == 'CE' else 'peSlMultiplier'))
    if mult is None or mult <= 1 or not (ltp > 0):
        return False, ''
    entry = float(broker_avg) if broker_avg else float(held.get('entryPrice') or 0.0)
    # Short: hurt by this leg's own premium expanding through a multiple of
    # what it was sold for.
    if entry > 0 and ltp >= entry * mult:
        return True, (f'{leg} SL ×{js_num(mult)} hit '
                      f'(premium {ltp:.2f} vs entry {entry:.2f})')
    return False, ''


def bank_closed_leg(held, ltp, entry_override=None):
    """Realised P&L for qty this worker is about to drop off the pin.

    Short only (this tool opens with SELL): profit when premium falls below
    entry. Returns 0 when LTP or entry is missing — never silently bank a
    fabricated flat, which is how closed-leg money used to vanish from the
    row after a leg-wise SL (see tests/test_focus_tool_booked_pnl.py).

    `entry_override`, when given and positive, is the broker's own live
    position average — see evaluate_leg_exit's doc comment for why this is
    preferred over the ledger's own `entryPrice`.
    """
    if not held:
        return 0.0
    qty = abs(float(held.get('qty') or 0))
    entry = float(entry_override) if entry_override else float(held.get('entryPrice') or 0.0)
    mark = float(ltp or 0.0)
    if not (qty > 0 and entry > 0 and mark > 0):
        return 0.0
    return (entry - mark) * qty


def cumulative_row_pnl(fill, leg_ltp, broker_avg=None):
    """booked (closed/rolled) + live MTM on still-open legs.

    This is what the status snapshot and the account budget must report after
    a leg-wise SL: without `bookedPnl`, the closed CE's loss disappears the
    moment the pin drops it and the row shows only the leftover PE.
    """
    if not fill:
        return 0.0
    pnl = float(fill.get('bookedPnl') or 0.0)
    for leg in ('CE', 'PE'):
        held = fill.get(leg)
        if not held:
            continue
        ltp = float((leg_ltp or {}).get(leg) or 0.0)
        if ltp > 0:
            pnl += bank_closed_leg(held, ltp, (broker_avg or {}).get(leg))
    return pnl


def apply_leg_drop(fills, row_id, leg):
    """Drop one leg from the ledger (ghost clear / already-flat close).

    Returns (changed, booked_released). `booked_released` is the fill's
    bookedPnl when the row goes fully flat and is popped — callers add it to
    the session realised total so the account budget keeps counting it.
    """
    fill = (fills or {}).get(row_id)
    if not fill or not fill.get(leg):
        return False, 0.0
    del fill[leg]
    if not any(k in fill for k in ('CE', 'PE')):
        booked = float(fill.get('bookedPnl') or 0.0)
        fills.pop(row_id, None)
        return True, booked
    return True, 0.0


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
        self.fills = {}            # row id -> {'CE'|'PE': {...}, 'entryPremium': float, 'bookedPnl': float}
        self.peak_pnl = 0.0
        self.lock_floor = None
        self.trail_state = 'INACTIVE'
        # Realised P&L from rows that have fully closed this session. Survives
        # the fill being popped so Target/Stop/Trail keep counting a finished
        # cycle instead of resetting to zero the moment the last leg flats.
        self.session_booked_pnl = 0.0
        self.events = []           # recent (ts, level, message) for the dashboard
        self._warned_orphans = set()   # ledger ids already reported as orphaned
        self._warned_stale_arm = False # yesterday's live arm reported once
        self.started_at = datetime.now().isoformat()
        self._chain_cache = {}     # (underlying, expiry) -> (minute_key, chain)
        self._vwap_cache = {}      # (underlying, expiry, ce, pe, side) -> (minute_key, vwap)
        # Option security ids already on the market-feed WebSocket:
        # sid -> (seg, sid, FEED_FULL). Segment must match subscribe or
        # unsubscribe leaves the instrument on the reconnect list.
        self._subscribed = {}
        # self.fills is mutated by the tick thread AND by the order-update
        # callback thread (see on_order_update), so every mutation takes this.
        self._fills_lock = threading.RLock()
        self._pending = {}         # order id -> (row id, leg), awaiting a fill

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

    def start_order_feed(self):
        """Subscribe to Dhan's order-update WebSocket and settle fills on it.

        This is what keeps fill confirmation OFF the tick thread. An entry
        records its order id and returns immediately; when the socket reports a
        terminal status, on_order_update settles the real traded price and
        quantity. Best-effort and Dhan-only: with the socket down, legs stay
        unconfirmed and reconcile() sizes them off the position book.
        """
        if self.dry_run:
            return
        try:
            self.helper.start_order_update_websocket(on_update=self.on_order_update)
            self.log('info', 'Order-update feed subscribed')
        except Exception as e:
            self.log('warning', f'Order-update WebSocket unavailable, fills settle '
                                f'from the position book instead: {e}')

    def on_order_update(self, payload):
        """Settle one pending leg against its real fill. Runs on the SOCKET
        thread — every ledger mutation here takes the lock, and nothing in it
        may block on wait_for_fill or place an order."""
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
                    return   # closed or rolled while the fill was in flight
                if fill:
                    held['qty'] = int(fill['qty'])
                    held['entryPrice'] = float(fill['price'])
                    held['confirmed'] = True
                    entry = self.fills.get(row_id) or {}
                    qty_sum = sum(int((entry.get(k) or {}).get('qty') or 0)
                                  for k in ('CE', 'PE') if entry.get(k))
                    if qty_sum > 0:
                        entry['entryPremium'] = sum(
                            float((entry.get(k) or {}).get('entryPrice') or 0.0)
                            * int((entry.get(k) or {}).get('qty') or 0)
                            for k in ('CE', 'PE') if entry.get(k)
                        ) / qty_sum
                self.save_state()
            if fill:
                self.log('info', f"{row_id[-4:]} {leg}: filled {fill['qty']} @ {fill['price']:.2f}")
        except Exception as e:
            logger.warning(f'Order update handling failed: {e}')

    def ensure_legs_subscribed(self, wanted):
        """Put every quoted option leg on the market-feed WebSocket.

        `wanted` is an iterable of (underlying, master_list_row). get_ltp
        already prefers helper.live_data, so once a SID is subscribed the tick
        quote path is a dict read instead of a blocking REST call. Legs that
        drop out of the armed/open set are unsubscribed so the socket does not
        accumulate every strike ever touched.
        """
        if not self.helper:
            return
        desired = {}
        for u, row in wanted or []:
            if not row:
                continue
            try:
                sid = str(int(row['SECURITY_ID']))
            except (KeyError, TypeError, ValueError):
                continue
            exch = UNDERLYING_EXCHANGE.get(u, 'NSE')
            seg = BSE_FNO_FEED if exch == 'BSE' else NSE_FNO_FEED
            desired[sid] = (seg, sid, FEED_FULL)

        to_add = [desired[s] for s in desired if s not in self._subscribed]
        to_drop = [self._subscribed[s] for s in list(self._subscribed) if s not in desired]

        if to_add:
            try:
                self.helper.subscribe_instruments(to_add)
                for _seg, sid, _code in to_add:
                    self._subscribed[sid] = desired[sid]
                self.log('info', f'Subscribed {len(to_add)} option leg(s) on market feed')
            except Exception as e:
                self.log('warning', f'Option leg subscribe failed: {e}')
        if to_drop:
            try:
                self.helper.unsubscribe_instruments(to_drop)
                for _seg, sid, _code in to_drop:
                    self._subscribed.pop(sid, None)
            except Exception as e:
                self.log('warning', f'Option leg unsubscribe failed: {e}')

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
            IDX_SEGMENT, FEED_QUOTE = 0, 17
            instruments = [(IDX_SEGMENT, str(sid), FEED_QUOTE)
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
            self.session_booked_pnl = float(st.get('sessionBookedPnl') or 0.0)
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
            'sessionBookedPnl': self.session_booked_pnl,
            'updatedAt': datetime.now().isoformat(),
        })

    def set_row_status(self, row_id, status):
        """Patch one row's status on disk so evaluate_entry and the page agree.

        The worker used to leave status at `armed` forever. After a full exit
        (or a reconcile that dropped the last leg) that meant the next tick
        immediately re-entered — the 09:19 re-entry on 2026-08-25. Mirrors the
        page's own enter→entered / flat→exited transitions.
        """
        cfg = read_json(CONFIG_FILE)
        if not isinstance(cfg, dict):
            return
        rows = cfg.get('rows') or []
        changed = False
        for r in rows:
            if r.get('id') == row_id and r.get('status') != status:
                r['status'] = status
                r['updatedAt'] = datetime.now().isoformat()
                changed = True
                break
        if not changed:
            return
        cfg['rows'] = rows
        cfg['updatedAt'] = datetime.now().isoformat()
        if atomic_write(CONFIG_FILE, cfg):
            # Force reload on next load_config — we just wrote the file ourselves.
            try:
                self._cfg_mtime = os.path.getmtime(CONFIG_FILE)
            except OSError:
                self._cfg_mtime = None
            self.cfg = cfg

    def release_row_booked(self, fill):
        """Move a fully-closed row's bookedPnl into the session total."""
        if not fill:
            return
        self.session_booked_pnl += float(fill.get('bookedPnl') or 0.0)

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

    def side_vwap(self, underlying, expiry, ce_strike, pe_strike, legs, interval='1'):
        """Session VWAP of the premium of just `legs`, recomputed once a minute.

        Side-aware for the same reason evaluate_exit is: a CE-only row compared
        against a combined CE+PE VWAP would cross at the wrong premium. Uses
        only closed bars so the number matches what TradingView and the broker
        terminal show (see scripts/tools/focus_tool_vwap.py, same construction).
        `interval` mirrors the row's vwapInterval setting from the dashboard.
        """
        key = (underlying, expiry, ce_strike, pe_strike, tuple(legs), interval)
        minute = datetime.now().strftime('%Y-%m-%d %H:%M')
        hit = self._vwap_cache.get(key)
        if hit and hit[0] == minute:
            return hit[1]

        vwap = None
        vwap_close = None
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
                    instrument_type='OPTIDX', interval=interval, from_date=today, to_date=tomorrow)
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
                    # Combined premium of the LAST closed bar — what the exit
                    # rule actually compares against vwap, not a live tick, so
                    # a spurious wick can't fire the exit on its own.
                    try:
                        vwap_close = sum(float(df.iloc[n - 1]['close']) for df in per_leg)
                    except (KeyError, TypeError, ValueError):
                        vwap_close = None
            _ = now
        except Exception as e:
            logger.warning(f'VWAP failed for {key}: {e}')
            vwap = None
            vwap_close = None

        result = (vwap, vwap_close)
        self._vwap_cache[key] = (minute, result)
        return result

    # -- trading -----------------------------------------------------

    def enter_row(self, row, group, expiry, ce_strike, pe_strike, reason):
        """Open every leg this row trades. Records only the legs that actually
        got through — a half-filled entry leaves a ledger describing exactly
        what is open, so the exit path closes that and nothing more.

        place() returns as soon as the broker ACKs. The real traded price and
        quantity arrive later on the order-update socket (on_order_update); until
        then the leg is flagged unconfirmed and sized off an LTP estimate /
        reconcile.
        """
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
        pending_regs = []
        for leg in legs_of(row):
            strike = ce_strike if leg == 'CE' else pe_strike
            if strike is None:
                continue
            ok, detail, order_id = self.router.place(u, expiry, strike, leg, 'SELL', qty, product)
            if not ok:
                self.log('error', f"{u} {row['id'][-4:]} {int(strike)}{leg}: entry failed — {detail}")
                continue
            # ACK only — never a confirmed fill on this thread. LTP is the best
            # entry price available until on_order_update / reconcile settles.
            price = self.market.ltp(u, self.market.leg(u, expiry, strike, leg))
            got = qty
            if got <= 0:
                self.log('error', f"{u} {row['id'][-4:]} {int(strike)}{leg}: nothing filled — not recorded")
                continue
            leg_rec = {
                'strike': int(strike), 'qty': got, 'entryPrice': price,
                'confirmed': False, 'openedTs': time.time(),
            }
            if order_id:
                leg_rec['orderId'] = str(order_id)
                pending_regs.append((str(order_id), leg))
            opened[leg] = leg_rec
            self.log('info', f"{u} {row['id'][-4:]}: SELL {got} {int(strike)}{leg} @ "
                             f"~{price:.2f} ({detail})")

        if not opened:
            self.log('error', f"{u} {row['id'][-4:]}: entry aborted — no leg opened")
            return

        opened['expiry'] = expiry
        opened['product'] = product
        opened['underlying'] = u
        qty_sum = sum(int(v['qty']) for k, v in opened.items() if k in ('CE', 'PE'))
        if qty_sum > 0:
            opened['entryPremium'] = sum(
                float(v['entryPrice']) * int(v['qty']) for k, v in opened.items() if k in ('CE', 'PE')
            ) / qty_sum
        else:
            opened['entryPremium'] = 0.0
        opened['enteredAt'] = datetime.now().isoformat()
        opened['bookedPnl'] = 0.0
        with self._fills_lock:
            self.fills[row['id']] = opened
            for oid, leg in pending_regs:
                self._pending[oid] = (row['id'], leg)
            self.save_state()
        self.set_row_status(row['id'], 'entered')
        self.log('info', f"{u} {row['id'][-4:]}: ENTERED ({reason}) — "
                         f"combined entry {opened['entryPremium']:.2f}")

    def exit_row(self, row, reason, broker_avg=None):
        """Close every leg the ledger says this row holds. The ledger entry is
        dropped only once every leg reports closed, so a partial failure leaves
        the remainder tracked and retried on the next tick instead of being
        forgotten while still open.

        `broker_avg`, when given, maps leg -> the broker's live position
        average — see evaluate_leg_exit's doc comment. Callers that don't have
        a fresh snapshot handy (the account-risk sweep) pass nothing and this
        falls back to the ledger's own entryPrice per leg, same as before."""
        fill = self.fills.get(row['id'])
        if not fill:
            return
        u = row['underlying']
        expiry = fill.get('expiry') or ''
        product = fill.get('product') or 'INTRADAY'
        self.log('info', f"{u} {row['id'][-4:]}: exiting — {reason}")

        remaining = {}
        booked = float(fill.get('bookedPnl') or 0.0)
        for leg in ('CE', 'PE'):
            held = fill.get(leg)
            if not held:
                continue
            # Mark against live LTP before the close so the realised slice
            # survives the pin drop — same banking the page does on reduce.
            ltp = self.market.ltp(u, self.market.leg(u, expiry, held['strike'], leg))
            ok, detail = self.router.close(
                u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product)
            if ok:
                booked += bank_closed_leg(held, ltp, (broker_avg or {}).get(leg))
                self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
            else:
                self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: exit FAILED — {detail}")
                remaining[leg] = held

        with self._fills_lock:
            if remaining:
                remaining['expiry'] = expiry
                remaining['product'] = product
                remaining['entryPremium'] = fill.get('entryPremium')
                remaining['enteredAt'] = fill.get('enteredAt')
                remaining['underlying'] = fill.get('underlying')
                remaining['bookedPnl'] = booked
                self.fills[row['id']] = remaining
            else:
                self.session_booked_pnl += booked
                self.fills.pop(row['id'], None)
                self.set_row_status(row['id'], 'exited')
            self.save_state()

    def exit_leg(self, row, leg, reason, ltp=None, broker_avg=None):
        """Close just ONE leg on its own SL x breach, leaving the other leg —
        and the row itself — exactly as it was. Mirrors exit_row's
        retry-on-failure shape but only ever touches this one leg's ledger
        entry; the other leg (and its own rules) is untouched.

        `ltp` is the premium that triggered the breach when the caller already
        has it — banking against that mark keeps bookedPnl aligned with what
        the rule actually saw, rather than a second quote a tick later.
        `broker_avg`, when given, is the broker's own live position average
        for this leg — see evaluate_leg_exit's doc comment.
        """
        fill = self.fills.get(row['id'])
        held = (fill or {}).get(leg)
        if not held:
            return
        u = row['underlying']
        expiry = fill.get('expiry') or ''
        product = fill.get('product') or 'INTRADAY'
        self.log('info', f"{u} {row['id'][-4:]}: leg-exit {leg} — {reason}")

        mark = float(ltp or 0.0)
        if not (mark > 0):
            mark = self.market.ltp(u, self.market.leg(u, expiry, held['strike'], leg))
        ok, detail = self.router.close(u, expiry, held['strike'], leg, 'BUY', int(held['qty']), product)
        if ok:
            with self._fills_lock:
                # Re-read under the lock — on_order_update may have settled
                # qty/price between the close and now.
                fill = self.fills.get(row['id'])
                held = (fill or {}).get(leg)
                if not fill or not held:
                    return
                fill['bookedPnl'] = float(fill.get('bookedPnl') or 0.0) + bank_closed_leg(held, mark, broker_avg)
                self.log('info', f"{u} {row['id'][-4:]} {held['strike']}{leg}: closed ({detail})")
                del fill[leg]
                if not any(k in fill for k in ('CE', 'PE')):
                    self.release_row_booked(fill)
                    self.fills.pop(row['id'], None)
                    self.set_row_status(row['id'], 'exited')
                self.save_state()
        else:
            self.log('error', f"{u} {row['id'][-4:]} {held['strike']}{leg}: leg-exit FAILED — {detail}")
            # Left in the ledger untouched — evaluate_leg_exit re-fires next
            # tick and retries, same as exit_row's partial-failure path.

    def _broker_avg(self, snapshot, u, expiry, strike, leg):
        """The broker's live position average for one leg, or None.

        None means "use the ledger's own entryPrice" — a missing/failed
        snapshot, or a leg not (yet) visible in it, must fall back rather than
        be read as a genuine zero average.
        """
        if not snapshot:
            return None
        key = self.router.position_key(u, expiry, strike, leg)
        if not key:
            return None
        row = snapshot.get(key)
        if not row:
            return None
        qty = int(row.get('qty') or 0)
        if qty == 0:
            return None
        avg = row.get('sellAvg') if qty < 0 else row.get('buyAvg')
        return float(avg) if avg else None

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

        Returns the raw snapshot (or None) so the caller can reuse the SAME
        broker call for the leg-exit rules' entry-price lookup rather than
        spending a second position request on the same tick.
        """
        if not self.fills:
            return None
        underlyings = {f.get('underlying') for f in self.fills.values()}
        snapshot = self.router.net_positions(underlyings=[u for u in underlyings if u])
        if snapshot is None:
            # Unknown, not empty. Leaving the ledger untouched is the only safe
            # reading of a failed position call.
            return None

        now = time.time()
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
                    broker_qty = abs(int((snapshot.get(key) or {}).get('qty', 0)))
                    own_qty = int(held.get('qty') or 0)
                    if broker_qty >= own_qty:
                        continue
                    changed = True
                    if broker_qty <= 0:
                        # Closed elsewhere — drop without banking. We did not place
                        # the close, so we have no trustworthy exit mark; inventing
                        # one from the current LTP poisons the session budget.
                        # exit_leg / exit_row bank when THIS worker closes.
                        self.log('warning',
                                 f"{u} {rid[-4:]} {held['strike']}{leg}: broker shows no position but the "
                                 f"ledger held {own_qty} — dropping the leg (closed elsewhere, or the "
                                 f"entry never filled).")
                        del fill[leg]
                    else:
                        self.log('warning',
                                 f"{u} {rid[-4:]} {held['strike']}{leg}: ledger {own_qty} vs broker "
                                 f"{broker_qty} — writing the ledger down.")
                        held['qty'] = broker_qty
                if not any(k in fill for k in ('CE', 'PE')):
                    self.release_row_booked(fill)
                    self.fills.pop(rid, None)
                    self.set_row_status(rid, 'exited')
            if changed:
                self.save_state()
        return snapshot

    def apply_drop_requests(self):
        """Consume page-written ghost-leg drops (broker already flat).

        Accepts the legacy single-queue file and the per-request
        `focus_tool_drop_*.json` files the page writes so Exit All's parallel
        CE+PE clears cannot overwrite each other.
        """
        import glob
        reqs = []
        legacy = read_json(DROP_LEGS_FILE)
        if legacy:
            try:
                os.remove(DROP_LEGS_FILE)
            except OSError:
                pass
            reqs.extend(legacy if isinstance(legacy, list) else [legacy])
        for path in glob.glob(DROP_LEGS_GLOB):
            # Don't pick up the legacy queue name if it somehow matches.
            if path.replace('\\', '/').endswith('focus_tool_drop_legs.json'):
                continue
            one = read_json(path)
            try:
                os.remove(path)
            except OSError:
                pass
            if one:
                reqs.append(one)

        if not reqs:
            return
        changed = False
        with self._fills_lock:
            for req in reqs:
                if not isinstance(req, dict):
                    continue
                rid = req.get('rowId')
                leg = req.get('leg')
                if not rid or leg not in ('CE', 'PE'):
                    continue
                dropped, booked_out = apply_leg_drop(self.fills, rid, leg)
                if not dropped:
                    continue
                changed = True
                self.session_booked_pnl += booked_out
                if rid not in self.fills:
                    self.set_row_status(rid, 'exited')
                self.log('info', f"{rid[-4:]}: dropped ghost {leg} (page reported broker flat)")
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
        self._warned_orphans &= set(self.fills)
        known = {r.get('id') for r in rows}
        out = []
        for rid, fill in self.fills.items():
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
        # The snapshot is reused below for the leg-exit rules' entry price —
        # one position call, not two, off the same account-wide REST budget.
        position_snapshot = self.reconcile()
        # Page-requested ghost clears (Exit on an already-flat broker leg).
        self.apply_drop_requests()
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
        tick_legs = []   # (underlying, master_list_row) quoted this tick → WS feed

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
            # Broker's own live position average per held leg — preferred over
            # this worker's remembered entryPrice for every entry comparison
            # below (SL x, booked P&L). See evaluate_leg_exit's and
            # broker_avg_trusted's doc comments for why: the ledger price is
            # only ever what THIS worker's own order traded at, and the
            # broker average is only safe to adopt when this row's own
            # ledger can fully account for the whole position at that
            # security.
            broker_avg = {}
            if fill:
                for leg in ('CE', 'PE'):
                    held = fill.get(leg)
                    if not held:
                        continue
                    key = self.router.position_key(u, expiry, held['strike'], leg)
                    snap = position_snapshot.get(key) if position_snapshot and key else None
                    broker_qty = abs(int(snap.get('qty') or 0)) if snap is not None else None
                    own_qty = int(held.get('qty') or 0)
                    if not broker_avg_trusted(broker_qty, own_qty):
                        continue
                    av = self._broker_avg(position_snapshot, u, expiry, held['strike'], leg)
                    if av:
                        broker_avg[leg] = av
            needs_quotes = bool(fill) or str(row.get('status')) == 'armed'
            if needs_quotes:
                for leg in legs:
                    strike = (fill.get(leg) or {}).get('strike') if fill else (
                        ce_strike if leg == 'CE' else pe_strike)
                    if strike is None:
                        continue
                    leg_row = self.market.leg(u, expiry, strike, leg)
                    if leg_row is not None:
                        tick_legs.append((u, leg_row))
                    ltp = self.market.ltp(u, leg_row)
                    leg_ltp[leg] = ltp
                    premium += ltp
            if fill:
                # booked (closed CE on SL ×, etc.) + live MTM on still-open legs.
                pnl = cumulative_row_pnl(fill, leg_ltp, broker_avg)
                total_pnl += pnl

            vwap = None
            vwap_close = None
            if row.get('levelVw') and fill:
                ce_s = (fill.get('CE') or {}).get('strike', ce_strike)
                pe_s = (fill.get('PE') or {}).get('strike', pe_strike)
                if ce_s is not None and pe_s is not None:
                    vwap, vwap_close = self.side_vwap(u, expiry, ce_s, pe_s, legs, row.get('vwapInterval') or '1')

            snapshot.append({
                'id': row['id'], 'underlying': u, 'status': row.get('status'),
                # The strikes actually HELD once open, not the live ATM
                # resolution — the page pins its position lookup to these, and
                # a drifting ATM would point it at a strike nobody holds.
                'ceStrike': (fill.get('CE') or {}).get('strike') if fill else ce_strike,
                'peStrike': (fill.get('PE') or {}).get('strike') if fill else pe_strike,
                'ceQty': int((fill.get('CE') or {}).get('qty') or 0) if fill else 0,
                'peQty': int((fill.get('PE') or {}).get('qty') or 0) if fill else 0,
                'bookedPnl': round(float((fill or {}).get('bookedPnl') or 0.0), 2),
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
                    do_leg_exit, leg_reason = evaluate_leg_exit(
                        row, leg, fill, leg_ltp.get(leg, 0.0), broker_avg.get(leg))
                    if do_leg_exit:
                        self.exit_leg(row, leg, leg_reason, ltp=leg_ltp.get(leg, 0.0),
                                      broker_avg=broker_avg.get(leg))
                        leg_exit_sent = True
                        break
                if leg_exit_sent:
                    continue

                # Qty-weighted, NOT the `premium` sum above (that one is the
                # display figure, matching the browser's own combinedLtp) —
                # see side_premium_entry's doc comment for why the pair SL x
                # needs the same weighting the browser's sidePremium uses.
                weighted_premium, weighted_entry = side_premium_entry(fill, leg_ltp, broker_avg)
                do_exit, reason = evaluate_exit(
                    row, group, fill, now_minutes, spot, weighted_premium, weighted_entry,
                    vwap, vwap_close, pnl)
                if do_exit:
                    self.exit_row(row, reason, broker_avg=broker_avg)
            else:
                dte = dte_for(expiry, today)
                ready = any((ce_strike if l == 'CE' else pe_strike) is not None for l in legs)
                do_enter, _reason = evaluate_entry(row, group, now_minutes, dte, ready, flat=True)
                if do_enter:
                    self.enter_row(row, group, expiry, ce_strike, pe_strike, _reason)

        # Anything quoted this tick joins the feed, so subsequent ticks are free.
        self.ensure_legs_subscribed(tick_legs)

        # Account-level budget, measured on this worker's own rows — including
        # realised from cycles that have already fully closed this session.
        total_pnl += self.session_booked_pnl
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
