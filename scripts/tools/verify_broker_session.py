"""Verify session validity for a broker.

Usage:
    python scripts/tools/verify_broker_session.py <broker>

Outputs JSON to stdout:
    {"status": "ok", "broker": "...", "message": "..."} (exit code 0)
    {"status": "error", "broker": "...", "message": "..."} (exit code 1)
"""

import sys
import os
import json

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)


def _dhan_preflight(dhan):
    """Token validity, kill switch and static-IP checks. Blockers fail the launch; unknowns only warn."""
    from lib.dhan_health import unwrap, evaluate_preflight, lookup_public_ip
    http = getattr(dhan, "dhan_http", None)
    if http is None:
        return True, "Dhan session is valid (health checks skipped: dhan_http unavailable)"

    def get(path):
        try:
            return unwrap(http.get(path))
        except Exception:
            return None

    static_ip = get("/ip/getIP")
    blockers, warnings = evaluate_preflight(
        get("/profile"), get("/killswitch"), static_ip,
        lookup_public_ip() if static_ip is not None else None,
    )
    if blockers:
        return False, "; ".join(blockers)
    return True, "Dhan session is valid" + (f" (warnings: {'; '.join(warnings)})" if warnings else "")


def verify(broker: str):
    broker = str(broker).lower().strip()
    if broker == "dhan":
        try:
            from login import get_dhan_client
            dhan = get_dhan_client()
            if not dhan:
                return False, "Failed to initialize Dhan client (check access token / credentials)"
            return _dhan_preflight(dhan)
        except Exception as e:
            return False, f"Dhan verification failed: {e}"

    elif broker in ("zerodha", "kotak"):
        try:
            from scripts.tools.child_brokers import create_broker
            child = create_broker(broker, log=lambda *_: None)
            ok, msg = child.verify_session()
            return ok, msg
        except Exception as e:
            return False, f"{broker.capitalize()} session error: {e}"

    else:
        return False, f"Unknown broker: {broker}"


def main():
    if len(sys.argv) < 2:
        res = {"status": "error", "broker": "unknown", "message": "Missing broker argument"}
        print(json.dumps(res))
        sys.exit(1)

    broker = sys.argv[1].lower().strip()
    ok, msg = verify(broker)
    res = {
        "status": "ok" if ok else "error",
        "broker": broker,
        "message": msg
    }
    print(json.dumps(res))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
