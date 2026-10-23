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


# --- Account-read diagnosis (scripts/testing/check_dhan_account_reads.py) -----------------------------------------
# Built from the 2026-10-23 incident: from ~09:10 to between 10:09 and 10:11 IST every account read (positions, orders,
# trades, funds, holdings, getIP) answered 400 DH-905 "Missing required fields..." while /profile, market data and
# order placement worked. Three fresh tokens failed the same way, then reads came back on their own with no change on
# our side. The verdicts below tell that pattern apart from a dead token, a rate limit and an IP problem.

ACCOUNT_READ_ENDPOINTS = ("/positions", "/orders", "/trades", "/fundlimit", "/holdings")
TOKEN_DEAD_CODES = ("DH-901", "DH-906")
RATE_LIMIT_CODES = ("DH-904",)

VERDICT_ADVICE = {
    "ok": "All reads OK.",
    "network": "No response from Dhan - check this machine's network before anything else.",
    "token_invalid": "Token rejected (DH-901/906 or 401). A newer mint kills the previous token at once, so check "
                     "nothing else minted one; otherwise run login.py. Dhan allows one mint per 2 minutes.",
    "rate_limited": "Rate-limited (429/DH-904). Wait and retry; do not mint a new token for this.",
    "account_reads_blocked": "Token works (/profile 200) but account reads return DH-905. This is the 2026-10-23 "
                             "pattern: not the token, headers, IP or code. Orders may still go through. Do not "
                             "re-mint tokens; re-check with --watch and raise it with Dhan support.",
    "partial": "Some account reads fail with a mix of errors - see the per-endpoint lines.",
    "ip_orders_blocked": "Reads work, but Dhan's static-IP check says orders are not allowed from this IP - "
                         "orders will fail with DH-905 until the whitelist at web.dhan.co is fixed.",
}


def dhan_error_code(body: Any) -> Optional[str]:
    """Dhan's error code from a raw REST error body ({'errorCode'}) or an SDK failure ({'remarks': {'error_code'}})."""
    if not isinstance(body, dict):
        return None
    code = body.get("errorCode")
    if code is None and isinstance(body.get("remarks"), dict):
        code = body["remarks"].get("error_code")
    return str(code) if code else None


def static_ip_problems(body: Any, public_ip: Optional[str] = None) -> List[str]:
    """Problems /ip/getIP reports for placing orders. Fields missing from the body are not guessed at."""
    if not isinstance(body, dict):
        return []
    out: List[str] = []
    primary = (body.get("primaryIP") or "").strip()
    secondary = (body.get("secondaryIP") or "").strip()
    detected = (body.get("detectedIP") or public_ip or "").strip()
    if not primary and not secondary:
        out.append("No static IP registered with Dhan")
    elif detected and detected not in (primary, secondary):
        out.append(f"Detected IP {detected} is not a registered static IP")
    if body.get("ordersAllowed") is False:
        out.append("Dhan reports ordersAllowed=false")
    return out


def diagnose_account_reads(
    results: Dict[str, Tuple[Optional[int], Any]],
    public_ip: Optional[str] = None,
) -> Tuple[str, List[str]]:
    """Classify one round of GETs. results[endpoint] = (HTTP status or None on a network error, parsed JSON body).

    Returns (verdict, notes); verdict is a key of VERDICT_ADVICE. Most specific cause first.
    """
    notes: List[str] = []
    statuses = {ep: st for ep, (st, _) in results.items()}
    if results and all(st is None for st in statuses.values()):
        return "network", notes

    codes = {ep: dhan_error_code(body) for ep, (st, body) in results.items() if st is not None and st >= 400}
    profile_status = statuses.get("/profile")
    if profile_status == 401 or any(c in TOKEN_DEAD_CODES for c in codes.values()):
        return "token_invalid", notes
    if any(st == 429 for st in statuses.values()) or any(c in RATE_LIMIT_CODES for c in codes.values()):
        return "rate_limited", notes

    failed_reads = [ep for ep in ACCOUNT_READ_ENDPOINTS if ep in results and statuses[ep] != 200]
    if failed_reads:
        if profile_status == 200 and all(codes.get(ep) == "DH-905" for ep in failed_reads):
            notes.append("DH-905 on: " + ", ".join(failed_reads))
            return "account_reads_blocked", notes
        return "partial", notes

    ip_status, ip_body = results.get("/ip/getIP", (None, None))
    if ip_status == 200:
        problems = static_ip_problems(ip_body, public_ip)
        if problems:
            notes.extend(problems)
            return "ip_orders_blocked", notes
    return ("ok" if all(st == 200 for st in statuses.values()) else "partial"), notes


def lookup_public_ip(timeout: float = 4.0) -> Optional[str]:
    try:
        import requests
        r = requests.get("https://api.ipify.org?format=json", timeout=timeout)
        ip = r.json().get("ip")
        return ip if r.ok and isinstance(ip, str) and re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip) else None
    except Exception:
        return None
