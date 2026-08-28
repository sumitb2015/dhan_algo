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


def verify(broker: str):
    broker = str(broker).lower().strip()
    if broker == "dhan":
        try:
            from login import get_dhan_client
            dhan = get_dhan_client()
            if not dhan:
                return False, "Failed to initialize Dhan client (check access token / credentials)"
            return True, "Dhan session is valid"
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
