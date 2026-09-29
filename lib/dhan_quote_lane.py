"""
Cross-process lane for Dhan's market-quote bucket (POST /marketfeed/quote|ohlc|ltp).

Dhan allows about 1 quote request per second per ACCOUNT, but the callers live in
separate processes (the options-screener collector, the Next.js dashboard). Each one
pacing itself at 1.1 s still lets two of them collide. This lane shares one schedule
through debug/dhan_quote_lane.json:

  * reserve()   books the next free slot (never earlier than the last booking + gap) and
                returns how long to sleep before calling. The lock is held only for the
                read-modify-write, never while sleeping.
  * report(True)  (a 429) doubles the shared gap (max 20 s) and pushes the next slot out,
                so EVERY participant backs off, not just the one that got the 429.
  * report(False) relaxes the gap back toward 1.1 s (x0.7 per success).

The Node side (rs_dashboard/lib/dhanQuoteLaneFile.ts) implements the same file format;
keep the two in sync. Only processes that go through a lane participate — strategies that
call DhanHelper directly do not.

The lock is an O_EXCL lock file (portable to Windows); a lock older than LOCK_STALE_SEC is
treated as left behind by a crashed holder and taken over. Every failure here degrades to
"no shared pacing" (the caller still paces itself), never to an exception.
"""
import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG_DIR = os.path.join(ROOT, 'debug')
LANE_FILE = os.path.join(DEBUG_DIR, 'dhan_quote_lane.json')
LOCK_FILE = os.path.join(DEBUG_DIR, 'dhan_quote_lane.lock')

BASE_GAP_MS = 1100
MAX_GAP_MS = 20000
LOCK_STALE_SEC = 3.0
LOCK_WAIT_SEC = 2.0


def _now_ms() -> float:
    return time.time() * 1000.0


def _acquire() -> bool:
    deadline = time.monotonic() + LOCK_WAIT_SEC
    while True:
        try:
            fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return True
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK_FILE) > LOCK_STALE_SEC:
                    os.remove(LOCK_FILE)
                    continue
            except OSError:
                pass
        except OSError:
            return False
        if time.monotonic() > deadline:
            return False
        time.sleep(0.02)


def _release() -> None:
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def _read() -> dict:
    try:
        with open(LANE_FILE, 'r', encoding='utf-8') as f:
            s = json.load(f)
        nxt = float(s.get('next_at_ms', 0))
        gap = float(s.get('gap_ms', BASE_GAP_MS))
        return {'next_at_ms': nxt, 'gap_ms': min(MAX_GAP_MS, max(BASE_GAP_MS, gap))}
    except (OSError, ValueError, TypeError, AttributeError):
        return {'next_at_ms': 0.0, 'gap_ms': float(BASE_GAP_MS)}


def _write(state: dict) -> None:
    tmp = f'{LANE_FILE}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f)
    os.replace(tmp, LANE_FILE)


def reserve(min_gap_ms: float = BASE_GAP_MS) -> float:
    """Book the next shared slot; returns seconds to sleep before making the call."""
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
    except OSError:
        return min_gap_ms / 1000.0
    if not _acquire():
        return min_gap_ms / 1000.0          # lane unavailable: fall back to plain pacing
    try:
        s = _read()
        now = _now_ms()
        slot = max(now, s['next_at_ms'])
        s['next_at_ms'] = slot + max(min_gap_ms, s['gap_ms'])
        _write(s)
        return (slot - now) / 1000.0
    except OSError:
        return min_gap_ms / 1000.0
    finally:
        _release()


def report(rate_limited: bool) -> float:
    """Feed a call's outcome back to the shared gap; returns the gap now in force (ms)."""
    if not _acquire():
        return float(BASE_GAP_MS)
    try:
        s = _read()
        if rate_limited:
            s['gap_ms'] = min(MAX_GAP_MS, s['gap_ms'] * 2)
            s['next_at_ms'] = max(s['next_at_ms'], _now_ms() + s['gap_ms'])
        else:
            s['gap_ms'] = max(BASE_GAP_MS, round(s['gap_ms'] * 0.7))
        _write(s)
        return s['gap_ms']
    except OSError:
        return float(BASE_GAP_MS)
    finally:
        _release()
