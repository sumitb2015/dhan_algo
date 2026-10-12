"""Dhan account-health rules for strategy launch pre-flight.

Pure functions (no SDK import) mirroring rs_dashboard/lib/dhanHealth.ts: token validity
from GET /profile, kill switch from GET /killswitch, and the static-IP whitelist from
GET /ip/getIP against this machine's public IP.

UNCONFIRMED against live responses: the exact kill-switch status text and the
`tokenValidity` format. Parsers are lenient and return None rather than guess.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

IST = timezone(timedelta(hours=5, minutes=30))
TOKEN_WARN = timedelta(hours=2)


def unwrap(res: Any) -> Optional[Dict[str, Any]]:
    """dhan_http wrappers return {'status','data'|'remarks'}; raw REST returns the body. Accept both."""
    if not isinstance(res, dict):
        return None
    if res.get("status") == "failure":
        return None
    data = res.get("data")
    return data if isinstance(data, dict) else res


def parse_dhan_datetime(raw: Any) -> Optional[datetime]:
    """'DD/MM/YYYY HH:mm' (IST) or anything ISO; tz-aware or None."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$", s)
    if m:
        d, mo, y, h, mi, se = (int(x) if x else 0 for x in m.groups())
        return datetime(y, mo, d, h, mi, se, tzinfo=IST)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=IST)


def kill_switch_active(body: Optional[Dict[str, Any]]) -> Optional[bool]:
    """True/False when the text is clear, None otherwise. 'deactivated' wins over 'activated'."""
    if not body:
        return None
    raw = body.get("killSwitchStatus", body.get("status"))
    if not isinstance(raw, str):
        return None
    s = raw.lower()
    if "deactivat" in s:
        return False
    if "activat" in s or "active" in s:
        return True
    return None


def evaluate_preflight(
    profile: Optional[Dict[str, Any]],
    kill_switch: Optional[Dict[str, Any]],
    static_ip: Optional[Dict[str, Any]] = None,
    public_ip: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Tuple[List[str], List[str]]:
    """Return (blockers, warnings). Blockers should stop a --live launch; unknowns only warn."""
    now = now or datetime.now(IST)
    blockers: List[str] = []
    warnings: List[str] = []

    if profile is None:
        warnings.append("Dhan profile unavailable - token validity not verified")
    else:
        exp = parse_dhan_datetime(profile.get("tokenValidity"))
        if exp is None:
            warnings.append(f"Unreadable tokenValidity: {profile.get('tokenValidity')!r}")
        elif exp <= now:
            blockers.append(f"Dhan access token expired at {exp:%Y-%m-%d %H:%M} IST - run login.py")
        elif exp - now < TOKEN_WARN:
            warnings.append(f"Dhan access token expires at {exp:%H:%M} IST ({int((exp - now).total_seconds() // 60)}m left)")

    ks = kill_switch_active(kill_switch)
    if ks is True:
        blockers.append("Dhan kill switch is ACTIVE - every order will be rejected today")
    elif ks is None:
        warnings.append("Dhan kill switch status unavailable or unrecognised")

    if static_ip is not None:
        primary = (static_ip.get("primaryIP") or "").strip()
        secondary = (static_ip.get("secondaryIP") or "").strip()
        if not primary and not secondary:
            blockers.append("No static IP registered with Dhan - order APIs will be rejected")
        elif public_ip and public_ip not in (primary, secondary):
            blockers.append(f"Public IP {public_ip} is not the registered static IP ({primary or secondary}) - orders will fail with DH-905")
        elif not public_ip:
            warnings.append("Could not look up this machine's public IP - static IP not verified")
    return blockers, warnings


def lookup_public_ip(timeout: float = 4.0) -> Optional[str]:
    try:
        import requests
        r = requests.get("https://api.ipify.org?format=json", timeout=timeout)
        ip = r.json().get("ip")
        return ip if r.ok and isinstance(ip, str) and re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip) else None
    except Exception:
        return None
