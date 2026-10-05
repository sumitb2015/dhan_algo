"""Crash-safe position persistence.

The mechanics were copy-pasted into five strategies (save_position / load_position); only the field
set differed. The store owns the mechanics and the refusals, the strategy owns the payload dict.
"""
import json
import logging
import os
from datetime import date, datetime
from typing import Optional

from .files import atomic_write_json

logger = logging.getLogger(__name__)


class PositionFileError(RuntimeError):
    """The position file cannot be trusted. Let it propagate: the strategy must NOT start trading.

    Raised for an unreadable file, a paper/live mismatch, and a live position whose contracts have
    already expired. Each means the book is unknown, and trading blind is how legs get orphaned.
    """


class PositionStore:
    def __init__(self, path: str, dry_run: bool, log=None, version: int = 1, enforce_mode: bool = True):
        """enforce_mode=False skips the paper/live mismatch refusal in load() (dry_run is still written
        to the file). Only for a strategy that never refused before; turning it on is a deliberate,
        separate change, because a legacy file written without `dry_run` would then refuse a dry-run restart."""
        self.path, self.dry_run, self.version, self.enforce_mode = path, dry_run, version, enforce_mode
        self.log = log or logger

    def save(self, payload: dict) -> None:
        """Atomically write `payload` plus version, dry_run and updated_at.

        `dry_run` is persisted so a paper position can never be picked up by a live run (or the
        reverse); load() refuses the mismatch.
        """
        data = {"version": self.version, "dry_run": self.dry_run}
        data.update(payload)
        data["updated_at"] = datetime.now().isoformat(timespec="seconds")
        atomic_write_json(self.path, data)

    def load(self, expiry_field: Optional[str] = "expiry", today: Optional[date] = None) -> Optional[dict]:
        """Return the saved dict, or None when there is no file (start flat).

        Raises PositionFileError for an unreadable file, for an OPEN position saved by the other
        mode (paper vs live), and for an open LIVE position whose `expiry_field` (YYYY-MM-DD) has
        passed. An expired PAPER position is discarded: the returned dict has position_open=False
        and "discarded_expired"=True, and the file is rewritten flat.

        A closed-position file is returned as is, since some strategies keep cross-cycle memory
        (last cycle expiry, lifetime P&L) in it. Callers check data.get("position_open").
        """
        if not os.path.exists(self.path):
            self.log.info(f"No existing position file at {self.path}; starting flat.")
            return None
        try:
            with open(self.path) as f:
                data = json.load(f)
        except Exception as e:
            self.log.error(f"FATAL: position file {self.path} unreadable ({e}). Refusing to trade blind.")
            raise PositionFileError(f"{self.path} unreadable: {e}") from e

        if not data.get("position_open"):
            return data

        if self.enforce_mode and bool(data.get("dry_run")) != self.dry_run:
            saved, now = ("PAPER" if data.get("dry_run") else "LIVE"), ("DRY" if self.dry_run else "LIVE")
            self.log.error(f"FATAL: {self.path} holds a {saved} position but this run is {now}. "
                           "Move the file aside after checking the broker.")
            raise PositionFileError(f"{self.path}: {saved} position, {now} run")

        expiry = data.get(expiry_field) if expiry_field else None
        if expiry and expiry < (today or date.today()).strftime("%Y-%m-%d"):
            if self.dry_run:
                self.log.warning(f"Paper position for expiry {expiry} has already expired; discarding it.")
                data["position_open"] = False
                self.save({k: v for k, v in data.items()
                           if k not in ("version", "dry_run", "updated_at")})
                data["discarded_expired"] = True      # in-memory signal only; never written to disk
                return data
            self.log.error(f"FATAL: {self.path} holds a LIVE position whose expiry {expiry} has passed. "
                           "The contracts have settled; verify the broker, then move the file aside.")
            raise PositionFileError(f"{self.path}: live position expired {expiry}")
        return data


def load_today_state(state_path: str, log=None) -> dict:
    """Today's dashboard state file as a dict, or {} if absent, stale or unreadable.

    Daily caps (loss limit, trades-per-day) must survive a restart or a crash resets them (4aa3242).
    Read the keys you need from the result, e.g. `load_today_state(p).get("daily_pnl", 0.0)`.
    "Today" is the file's modification date, so yesterday's numbers never leak into a new session.
    """
    log = log or logger
    try:
        if not os.path.exists(state_path):
            return {}
        if datetime.fromtimestamp(os.path.getmtime(state_path)).date() != datetime.now().date():
            return {}
        with open(state_path) as f:
            return json.load(f)
    except Exception as e:
        log.warning(f"Could not restore daily state from {state_path}: {e}")
        return {}
