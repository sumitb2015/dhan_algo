"""Flatten every open F&O position on one child broker (Kotak or Zerodha).

Used by the dashboard's "Exit All Positions" nuclear button
(rs_dashboard/app/api/exit-all/route.ts): that route already flattens Dhan
directly via REST, but strategies launched with --broker kotak/zerodha
(lib/execution_broker.py) hold their positions at the CHILD broker instead,
so the Dhan-only sweep left them orphaned once the strategy process was
force-killed. This script closes what ChildBroker.positions_rows() reports,
via the same close_position() the copy-trade bridge's safety watchdog uses.

Usage:
    python scripts/tools/exit_all_broker_positions.py <kotak|zerodha>

Outputs JSON to stdout:
    {"status": "ok"|"error", "broker": "...", "closed": [...], "errors": [...]}
Exit code 0 unless the broker session itself could not be established;
per-position close failures are reported in "errors" but do not fail the
whole run (a nuclear exit must not stop at the first bad leg).
"""

import json
import os
import sys

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "broker": "unknown",
                          "closed": [], "errors": ["Missing broker argument"]}))
        sys.exit(1)

    broker_name = sys.argv[1].lower().strip()
    if broker_name not in ("kotak", "zerodha"):
        print(json.dumps({"status": "error", "broker": broker_name,
                          "closed": [], "errors": [f"Unsupported broker: {broker_name}"]}))
        sys.exit(1)

    from scripts.tools.child_brokers import create_broker

    try:
        child = create_broker(broker_name, log=lambda *_: None)
        child.init_instruments()
    except Exception as e:
        print(json.dumps({"status": "error", "broker": broker_name,
                          "closed": [], "errors": [f"Could not start {broker_name}: {e}"]}))
        sys.exit(1)

    ok, detail = child.verify_session()
    if not ok:
        print(json.dumps({"status": "error", "broker": broker_name,
                          "closed": [], "errors": [detail]}))
        sys.exit(1)

    closed = []
    errors = []
    try:
        rows = child.positions_rows()
    except Exception as e:
        print(json.dumps({"status": "error", "broker": broker_name,
                          "closed": [], "errors": [f"positions fetch failed: {e}"]}))
        sys.exit(1)

    for row in rows:
        qty = int(row.get("qty", 0) or 0)
        if qty == 0:
            continue
        side = "SELL" if qty > 0 else "BUY"
        try:
            order_id = child.close_position(row, abs(qty), side)
            closed.append({"symbol": row["symbol"], "qty": abs(qty), "side": side,
                           "order_id": order_id})
        except Exception as e:
            errors.append(f"close {row.get('symbol')}: {e}")

    print(json.dumps({
        "status": "ok" if not errors else "partial",
        "broker": broker_name,
        "closed": closed,
        "errors": errors,
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
