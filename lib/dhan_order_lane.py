"""
Cross-process lane for Dhan's ORDER rate limit (about 10 order requests/second per ACCOUNT).

Order callers live in separate processes: every running strategy (via DhanHelper) and the Next.js
dashboard routes. Each one limiting itself still lets several of them burst past 10/s together, which
draws DH-904 rejections on exits at the worst moment. This lane shares ONE sliding window through
debug/dhan_order_lane.json: reserve() books a send time such that no 1-second window holds more than
`limit` bookings across all participants, and returns how long to sleep before sending.

The Node side (rs_dashboard/lib/dhanOrderLaneFile.ts) implements the same file format; keep the two in sync.

Safety rules (this is on the real-money path):
  * FAIL OPEN. Any lock/file problem returns "no wait" - an order is never blocked or dropped by the lane.
  * BOUNDED. wait_for_slot() sleeps at most MAX_WAIT_SEC, so a pile-up delays an exit by about a second,
    never indefinitely. Past that it sends anyway and accepts a possible DH-904 over a stuck order.
  * The lock is held only for the read-modify-write, never while sleeping. An O_EXCL lock file (portable to
    Windows) older than LOCK_STALE_SEC is taken over from a crashed holder.

DHAN_ORDER_LANE_DIR overrides the directory (tests).
"""
import json
import os
import time
from bisect import bisect_right

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.environ.get('DHAN_ORDER_LANE_DIR') or os.path.join(ROOT, 'debug')
LANE_FILE = os.path.join(DIR, 'dhan_order_lane.json')
LOCK_FILE = os.path.join(DIR, 'dhan_order_lane.lock')

LIMIT = 8                 # below Dhan's 10/s, for headroom
WINDOW_MS = 1000
MAX_WAIT_SEC = 2.0
LOCK_STALE_SEC = 3.0
LOCK_WAIT_SEC = 1.0
MAX_BOOKINGS = 64         # file size guard; far more than LIMIT bookings can ever be live


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
                    # Move it aside, then re-check what was moved: if another waiter already took the lock over,
                    # this moved ITS fresh lock and must put it back.
                    aside = f'{LOCK_FILE}.stale.{os.getpid()}.{time.monotonic_ns()}'
                    os.replace(LOCK_FILE, aside)
                    if time.time() - os.path.getmtime(aside) > LOCK_STALE_SEC:
                        os.remove(aside)
                        continue
                    try:
                        os.link(aside, LOCK_FILE)
                    except OSError:
                        pass
                    os.remove(aside)
            except OSError:
                pass
        except OSError:
            return False
        if time.monotonic() > deadline:
            return False
        time.sleep(0.005)


def _release() -> None:
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def _read() -> list:
    try:
        with open(LANE_FILE, 'r', encoding='utf-8') as f:
            raw = json.load(f).get('bookings', [])
        return sorted(float(t) for t in raw)
    except (OSError, ValueError, TypeError, AttributeError):
        return []


def _write(bookings: list) -> None:
    tmp = f'{LANE_FILE}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'bookings': bookings[-MAX_BOOKINGS:]}, f)
    os.replace(tmp, LANE_FILE)


def _within_limit(bookings: list, limit: int, window_ms: float) -> bool:
    """True when no booking's trailing window (t - window, t] holds more than `limit` bookings."""
    ts = sorted(bookings)
    for i, b in enumerate(ts):
        if (i + 1) - bisect_right(ts, b - window_ms) > limit:   # duplicates of b sit at i+1.. only after bisect; counted at the last one
            return False
    return True


def book(bookings: list, now: float, limit: int = LIMIT, window_ms: float = WINDOW_MS) -> float:
    """
    Pure: earliest time >= now at which one more send keeps EVERY 1-second window within `limit`.
    Mutates `bookings` (drops expired entries, appends the new one). The list is tiny (<= MAX_BOOKINGS),
    so the brute-force window check is cheap and obviously correct.
    """
    bookings[:] = [t for t in bookings if t > now - window_ms]
    t = now
    while not _within_limit(bookings + [t], limit, window_ms):
        # The window ending at t (or at a later booking) is full: step to just after its oldest member leaves.
        oldest = min(b for b in bookings if b > t - window_ms)
        t = oldest + window_ms
    bookings.append(t)
    bookings.sort()
    return t


def reserve_at_ms() -> float:
    """Book the next shared send slot; returns its ABSOLUTE time (ms since epoch). Lane unavailable: now."""
    try:
        os.makedirs(DIR, exist_ok=True)
    except OSError:
        return _now_ms()
    if not _acquire():
        return _now_ms()
    try:
        bookings = _read()
        t = book(bookings, _now_ms())
        _write(bookings)
        return t
    except OSError:
        return _now_ms()
    finally:
        _release()


def reserve() -> float:
    """Seconds to sleep before sending (0 if the slot is free or the lane is unavailable)."""
    return max(0.0, (reserve_at_ms() - _now_ms()) / 1000.0)


def wait_for_slot() -> float:
    """reserve() then sleep, capped at MAX_WAIT_SEC. Returns the seconds actually slept."""
    try:
        wait = min(reserve(), MAX_WAIT_SEC)
    except Exception:
        return 0.0
    if wait > 0:
        time.sleep(wait)
    return wait
