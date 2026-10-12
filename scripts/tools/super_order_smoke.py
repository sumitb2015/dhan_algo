"""
Live smoke test for Dhan Super Orders - turns "unconfirmed" into "confirmed" with ONE command.

What it does (REAL account, REAL order, but it cannot fill and is cancelled in a `finally`):
  1. Finds the nearest NIFTY expiry's ATM call and its LTP.
  2. Places a 1-lot BUY LIMIT super order at ~50% of LTP (far below the market, so it rests unfilled), with a
     target above and a stop below the entry.
  3. Reads GET /super/orders and checks every shape assumption the repo's code relies on
     (lib/super_order.check_list_shape: securityId, correlationId, legDetails/legName/orderStatus).
  4. Modifies the TARGET_LEG, then cancels the whole bracket via ENTRY_LEG and confirms nothing is left live.
Everything observed is written to debug/super_order_smoke_<timestamp>.json (no tokens) and printed.

NOT covered, on purpose: a MARKET entry (it would fill and open a real position). Verify that one by hand
with a 1-lot bracket from the Scalper once this passes.

Safety: it does nothing without --i-understand-this-places-a-real-order, only runs during NSE hours, refuses
an option priced under Rs 2 (offsets would collapse onto the tick), and a leftover live leg is reported loudly.

Usage:
    venv\\Scripts\\python.exe scripts/tools/super_order_smoke.py                                          # plan only
    venv\\Scripts\\python.exe scripts/tools/super_order_smoke.py --i-understand-this-places-a-real-order
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.super_order import check_list_shape  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
LIVE_STATUSES = {"PENDING", "TRANSIT", "OPEN", "TRIGGER_PENDING", "PART_TRADED"}


def tick(x: float) -> float:
    return round(round(x / 0.05) * 0.05, 2)


def in_nse_hours(now: datetime) -> bool:
    return now.weekday() < 5 and (9, 15) <= (now.hour, now.minute) < (15, 30)


def run(helper, apply: bool, now: datetime = None, sleep=time.sleep) -> dict:
    """Returns the report dict; report['ok'] is True only when every check passed and nothing was left live."""
    now = now or datetime.now(IST)
    rep = {"started": now.isoformat(), "apply": apply, "steps": [], "ok": False}

    def step(name, ok, detail=None):
        rep["steps"].append({"step": name, "ok": ok, "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -  {detail}" if detail not in (None, '') else ""))
        return ok

    if apply and not in_nse_hours(now):
        step("market hours", False, f"{now:%a %H:%M} IST is outside NSE hours; a resting order would behave differently")
        return rep

    spot = helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
    expiry = helper.get_nearest_expiry("NIFTY")
    if not spot or not expiry:
        step("find contract", False, f"spot={spot} expiry={expiry}")
        return rep
    strike = round(spot / 50) * 50
    info = helper.get_option_id("NIFTY", strike, "CE", expiry)
    sec_id = str((info or {}).get("security_id") or (info or {}).get("SECURITY_ID") or (info or {}).get("securityId") or "")
    ltp = helper.get_option_ltp("NIFTY", strike, "CE", expiry)
    lot = helper.get_lot_size("NIFTY")
    if not sec_id or ltp < 2 or not lot:
        step("find contract", False, f"strike={strike} security_id={sec_id!r} ltp={ltp} lot={lot} (need ltp >= 2)")
        return rep
    entry = tick(ltp * 0.5)
    target, stop = tick(entry * 1.5), tick(entry * 0.7)
    step("contract", True, f"NIFTY {strike} CE {expiry} sec={sec_id} ltp={ltp} lot={lot}; BUY 1 lot LIMIT {entry} tgt {target} sl {stop}")
    rep["plan"] = {"security_id": sec_id, "entry": entry, "target": target, "stop": stop, "lot": lot}
    if not apply:
        print("\nPlan only. Re-run with --i-understand-this-places-a-real-order to place it.")
        rep["ok"] = True
        return rep

    order_id = None
    placed = {}
    try:
        placed = helper.place_super_order(
            security_id=sec_id, exchange_segment="NSE_FNO", side="BUY", product_type="INTRADAY",
            quantity=lot, target_price=target, stop_loss_price=stop, order_type="LIMIT", price=entry)
        order_id = placed.get("order_id")
        if not step("place LIMIT bracket", bool(placed.get("ok")), placed.get("error") or f"orderId={order_id} status={placed.get('status')}"):
            if placed.get("unknown"):
                step("OUTCOME UNKNOWN", False, f"correlation_id={placed.get('correlation_id')} - check Dhan Orders by hand")
            return rep
        sleep(1.0)
        rows = helper.get_super_orders()
        results = check_list_shape(rows, order_id, placed.get("correlation_id"), sec_id)
        for ok, msg in results:
            step("list shape", ok, msg)
        rep["list_row"] = next((r for r in rows if isinstance(r, dict) and str(r.get("orderId")) == str(order_id)), None)
        step("modify TARGET_LEG", helper.modify_super_order(order_id, "TARGET_LEG", targetPrice=tick(target + 0.5)))
    except Exception as e:                                    # noqa: BLE001 - report, then fall through to cancel
        step("unexpected error", False, repr(e))
    finally:
        if order_id:
            step("cancel bracket (ENTRY_LEG)", helper.cancel_super_order(order_id, "ENTRY_LEG"))
            sleep(1.0)
            left = [r for r in helper.get_super_orders() if isinstance(r, dict) and str(r.get("orderId")) == str(order_id)]
            live = [l for r in left for l in (r.get("legDetails") or []) if str(l.get("orderStatus", "")).upper() in LIVE_STATUSES]
            step("nothing left live", not live, f"leftover legs: {live}" if live else "all legs terminal or gone")
            rep["after_cancel"] = left
    rep["ok"] = all(s["ok"] for s in rep["steps"])
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--i-understand-this-places-a-real-order", dest="apply", action="store_true")
    args = ap.parse_args()
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    helper = DhanHelper(get_dhan_client())
    rep = run(helper, args.apply)
    if args.apply:
        os.makedirs(os.path.join(ROOT, "debug"), exist_ok=True)
        path = os.path.join(ROOT, "debug", f"super_order_smoke_{datetime.now():%Y%m%d_%H%M%S}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2, default=str)
        print(f"\nreport: {path}")
    print("\nRESULT:", "ALL CHECKS PASSED" if rep["ok"] else "FAILED - do not rely on the unconfirmed assumptions yet")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
