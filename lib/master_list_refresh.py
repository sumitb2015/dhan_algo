"""
Keeps master_list.csv current. It used to be downloaded only when missing or empty, so a file from months ago was used as
is: every future in it had expired ("NIFTY has no live futures") and an NSE-only rewrite (tests/test_11_maintenance.py)
silently dropped MCX. Both broke contract lookups everywhere until someone noticed.

`refresh_if_stale(helper)` re-downloads it when it is stale:
  - the file's last write is on an earlier IST day than today (Dhan lists new contracts daily), or
  - its content is unusable: no MCX rows, or no live NIFTY future (expiry today or later).

Safety rules:
  - One download at a time across processes: an O_EXCL lock file in debug/ (a lock older than LOCK_STALE_S is a crashed
    holder and is taken over). A process that finds the lock held just keeps the file it has.
  - A download that misses any segment, or comes back far smaller than the file on disk, never replaces it
    (fetch_security_list(require_all=True) + MIN_ROW_RATIO).
  - Never raises: a failed refresh logs and the caller carries on with the existing file.

Run by DhanHelper.__init__ (unless DHAN_MASTER_LIST_AUTO_REFRESH=0 or skip_session_validation=True), by the dashboard's
scheduler (rs_dashboard/lib/masterListRefresh.ts) through scripts/tools/refresh_master_list.py, and by hand with --force.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
SEGMENTS = ['NSE_EQ', 'NSE_FNO', 'BSE_EQ', 'BSE_FNO', 'MCX_COMM']
LOCK_STALE_S = 600
MIN_ROW_RATIO = 0.5
ENV_SWITCH = 'DHAN_MASTER_LIST_AUTO_REFRESH'


def ist_date(ts: float) -> str:
    return datetime.fromtimestamp(ts, IST).strftime('%Y-%m-%d')


def age_problem(path: str, now: Optional[float] = None) -> Optional[str]:
    """Why the file is stale by date alone, or None. A missing file is stale."""
    now = time.time() if now is None else now
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return 'master list file is missing'
    written, today = ist_date(mtime), ist_date(now)
    return f'master list was written on {written}, today is {today}' if written < today else None


def content_problem(df, today_iso: str) -> Optional[str]:
    """Why a loaded master list cannot serve today's lookups, or None. Pure: `df` is the frame DhanHelper loaded."""
    if df is None or len(df) == 0:
        return 'master list is empty'
    if 'EXCH_ID' in df.columns and not (df['EXCH_ID'].astype(str).str.upper() == 'MCX').any():
        return 'master list has no MCX rows'
    need = {'INSTRUMENT', 'UNDERLYING_SYMBOL', 'SM_EXPIRY_DATE'}
    if need.issubset(df.columns):
        fut = df[(df['INSTRUMENT'].astype(str).str.upper() == 'FUTIDX')
                 & (df['UNDERLYING_SYMBOL'].astype(str).str.upper() == 'NIFTY')]
        expiries = fut['SM_EXPIRY_DATE'].astype(str).str.slice(0, 10)
        if not (expiries >= today_iso).any():
            return 'master list has no live NIFTY future'
    return None


def stale_reason(helper, now: Optional[float] = None) -> Optional[str]:
    now = time.time() if now is None else now
    return age_problem(helper._master_list_path, now) or content_problem(helper._master_list, ist_date(now))


def _lock_path(master_path: str) -> str:
    return os.path.join(os.path.dirname(master_path), 'debug', 'master_list_refresh.lock')


def _take_lock(lock: str, now: float) -> bool:
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, 'w') as f:
                f.write(f'{os.getpid()} {now:.0f}')
            return True
        except FileExistsError:
            try:
                if now - os.path.getmtime(lock) > LOCK_STALE_S:
                    os.remove(lock)          # a crashed holder: take it over (second loop pass)
                    continue
            except OSError:
                continue                     # it vanished between the two calls: try again
            return False
    return False


def refresh_if_stale(helper, force: bool = False, now: Optional[float] = None) -> dict:
    """Re-download master_list.csv when it is stale (or `force`). Returns {status, reason?, rows?}; never raises.

    status: 'fresh' (nothing to do) | 'refreshed' | 'busy' (another process holds the lock) | 'failed' | 'disabled'.
    """
    try:
        if not force and os.environ.get(ENV_SWITCH, '1') == '0':
            return {'status': 'disabled'}
        now = time.time() if now is None else now
        reason = 'forced' if force else stale_reason(helper, now)
        if not reason:
            return {'status': 'fresh'}
        lock = _lock_path(helper._master_list_path)
        if not _take_lock(lock, now):
            logger.info(f'Master list is stale ({reason}) but another process is refreshing it; using the file on disk')
            return {'status': 'busy', 'reason': reason}
        try:
            # another process may have finished a refresh while we were deciding: re-check before downloading 29 MB
            if not force and age_problem(helper._master_list_path, now) is None:
                helper._load_master_list(reload=True)
                if content_problem(helper._master_list, ist_date(now)) is None:
                    return {'status': 'fresh'}
            before = len(helper._master_list) if helper._master_list is not None else 0
            logger.info(f'Refreshing master list: {reason}')
            ok = helper.fetch_security_list(SEGMENTS, require_all=True,
                                            min_rows=int(before * MIN_ROW_RATIO))
            if not ok:
                logger.warning('Master list refresh failed; keeping the existing file')
                return {'status': 'failed', 'reason': reason}
            return {'status': 'refreshed', 'reason': reason, 'rows': len(helper._master_list)}
        finally:
            try:
                os.remove(lock)
            except OSError:
                pass
    except Exception as e:                      # a refresh must never break the caller
        logger.warning(f'Master list refresh skipped: {e}')
        return {'status': 'failed', 'reason': str(e)}
