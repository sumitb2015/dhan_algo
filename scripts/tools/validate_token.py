"""
Validates a Dhan client_id + access_token pair by calling the fund limits endpoint.
Called by the Next.js /api/auth/login route.

Usage: python validate_token.py <client_id> <access_token>
Output: JSON on stdout — {"success": true} or {"success": false, "error": "<message>"}
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: validate_token.py <client_id> <access_token>"}))
        sys.exit(1)

    client_id = sys.argv[1].strip()
    access_token = sys.argv[2].strip()

    if not client_id or not access_token:
        print(json.dumps({"success": False, "error": "client_id and access_token are required"}))
        sys.exit(1)

    try:
        from dhanhq import DhanContext, dhanhq

        dhan_context = DhanContext(client_id, access_token)
        dhan = dhanhq(dhan_context)

        result = dhan.get_fund_limits()

        if isinstance(result, dict):
            status = result.get("status", "")
            error_msg = str(result.get("error_message") or result.get("remarks") or "")
            if status == "error" or ("invalid" in error_msg.lower() and "token" in error_msg.lower()):
                print(json.dumps({"success": False, "error": "Invalid or expired token"}))
                sys.exit(0)

        print(json.dumps({"success": True}))

    except Exception as e:
        err = str(e)
        # Don't leak internal SDK details — surface a clean message
        if "invalid" in err.lower() or "token" in err.lower() or "unauthorized" in err.lower():
            print(json.dumps({"success": False, "error": "Invalid or expired access token"}))
        elif "connect" in err.lower() or "timeout" in err.lower():
            print(json.dumps({"success": False, "error": "Could not reach Dhan API — check your network connection"}))
        else:
            print(json.dumps({"success": False, "error": "Authentication failed — please check your credentials"}))
        sys.exit(0)


if __name__ == "__main__":
    main()
