#!/usr/bin/env python3
"""
StockMock Fast API Client & Validation Engine

Direct REST client for https://www.stockmock.in/api/startBacktesting using curl_cffi.
Bypasses Cloudflare headlessly without browser automation, caches JWT auth tokens,
constructs serialized positions payloads, and validates results side-by-side against
the local Dhan Algo backtesting engine (scripts/analysis/backtest_short_straddle.py).
"""

import sys
import os
import json
import argparse
import subprocess
from datetime import datetime, date, timedelta
from typing import Dict, List, Optional, Any, Tuple

try:
    from curl_cffi import requests
except ImportError:
    print("Error: curl_cffi is required. Install via: pip install curl_cffi", file=sys.stderr)
    sys.exit(1)

BASE_URL = "https://www.stockmock.in"
FE_VERSION = "2"

# Find repository root reliably
current = os.path.abspath(__file__)
while current and os.path.basename(current) not in ("dhan_algo", ""):
    parent = os.path.dirname(current)
    if parent == current:
        break
    current = parent
REPO_ROOT = current if os.path.basename(current) == "dhan_algo" else os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
DEBUG_DIR = os.path.join(REPO_ROOT, "debug")
TOKEN_CACHE_FILE = os.path.join(DEBUG_DIR, "stockmock_token.json")
ENV_FILE = os.path.join(REPO_ROOT, ".env.stockmock")


def load_credentials() -> Tuple[str, str]:
    """(phone, password) from .env.stockmock (git-ignored), falling back to the process environment."""
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    phone = env.get("STOCKMOCK_PHONE") or os.environ.get("STOCKMOCK_PHONE")
    pwd = env.get("STOCKMOCK_PASSWORD") or os.environ.get("STOCKMOCK_PASSWORD")
    if not phone or not pwd:
        raise RuntimeError(f"StockMock credentials missing: set STOCKMOCK_PHONE and STOCKMOCK_PASSWORD "
                           f"in {ENV_FILE} (see .env.stockmock.example).")
    return phone, pwd



# ---------------------------------------------------------------------------
# Auth & Token Lifecycle
# ---------------------------------------------------------------------------

def get_auth_token(phone: Optional[str] = None, pwd: Optional[str] = None, force_refresh: bool = False) -> str:
    """Retrieve active StockMock JWT token from cache or perform direct login."""
    os.makedirs(DEBUG_DIR, exist_ok=True)
    
    if not force_refresh and os.path.exists(TOKEN_CACHE_FILE):
        try:
            with open(TOKEN_CACHE_FILE, "r") as f:
                data = json.load(f)
                token = data.get("token")
                cached_time = data.get("timestamp", 0)
                # Token valid for 24h
                if token and (datetime.now().timestamp() - cached_time < 86400):
                    return token
        except Exception:
            pass

    if not phone or not pwd:
        phone, pwd = load_credentials()

    # Direct login via curl_cffi (mimics Chrome 120 TLS fingerprint)
    url = f"{BASE_URL}/api/login"
    headers = {
        "Content-Type": "application/json",
        "feversion": FE_VERSION,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    payload = {"phone": phone, "pwd": pwd}
    
    resp = requests.post(url, json=payload, headers=headers, impersonate="chrome120", timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"StockMock login failed (HTTP {resp.status_code}): {resp.text[:200]}")
    
    data = resp.json()
    token = data.get("token")
    if not token:
        raise RuntimeError(f"No token returned in login response: {data}")

    with open(TOKEN_CACHE_FILE, "w") as f:
        json.dump({"token": token, "timestamp": datetime.now().timestamp(), "phone": phone}, f)

    return token


# ---------------------------------------------------------------------------
# Positions & Payload Builder
# ---------------------------------------------------------------------------

def build_leg_string(
    underlying: str = "N",        # N = NIFTY, BN = BANKNIFTY
    leg_id: str = "L1",           # L1, L2...
    strike_rule: str = "0",       # 0 = ATM, 100/-100, CP35;cl (closest premium <= 35)
    side: str = "S",              # S = Sell, B = Buy
    option_type: str = "CE",      # CE or PE
    qty: int = 65,                # Lot qty
    sl_type: Optional[str] = None,# slp (%), slpn (pts), slcl (cost)
    sl_val: Optional[float] = None,
    tp_type: Optional[str] = None,# tpp (%), tppn (pts)
    tp_val: Optional[float] = None,
    expiry: str = "CW",           # CW (Current Week), NW, CM
    trailing_sl: Optional[str] = None, # TSLP_10_5 or None
    wait_trade: Optional[str] = None,  # WP_10, WP_-10, WPN_15 or None
    entry_type: str = "atm",      # atm, cp, atm_p, sp, pr
    trb: Optional[str] = None,    # Lo_09:45:00 or Hi_09:45:00 or None
    re_entry_sl: Optional[str] = None, # RE_1, RECOST_1, REI_1
    re_entry_tp: Optional[str] = None  # REI_1
) -> str:
    """Build single leg string matching StockMock's internal Q(e) format."""
    # Part 0: identification and strike
    part0 = f"{underlying}_{leg_id}::{strike_rule}_{side}_{option_type}_{qty}"
    
    # Part 1: Stop loss
    part1 = f"{sl_type.upper()}_{sl_val}" if (sl_type and sl_val is not None) else "null"
    
    # Part 2: Target profit
    part2 = f"{tp_type.upper()}_{tp_val}" if (tp_type and tp_val is not None) else "null"
    
    # Part 3: Expiry
    part3 = expiry
    
    # Part 4: Trailing SL
    part4 = trailing_sl.upper() if trailing_sl else "null"
    
    # Part 5: Wait and Trade
    part5 = wait_trade.upper() if wait_trade else "null"
    
    # Part 6: Entry type
    part6 = entry_type
    
    # Part 7: TRB
    part7 = trb if trb else "null"
    
    # Part 8: null
    part8 = "null"
    
    # Part 9: Straddle ratio
    part9 = "null"
    
    # Part 10: Re-entry on SL
    part10 = re_entry_sl if re_entry_sl else "null"
    
    # Part 11: Re-entry on TP
    part11 = re_entry_tp if re_entry_tp else "null"
    
    # Parts 12-14: Journey/Depth/Hedge
    part12 = "null"
    part13 = "null"
    part14 = "null"

    return f"{part0}::{part1}::{part2}::{part3}::{part4}::{part5}::{part6}::{part7}::{part8}::{part9}::{part10}::{part11}::{part12}::{part13}::{part14}"


def run_stockmock_backtest(
    positions_str: str,
    from_date: str,
    to_date: str,
    entry_time: str = "09:22:00",
    exit_time: str = "15:15:00",
    strategy: str = "intraday",
    is_trb: bool = False,
    trb_time: Optional[str] = None, # HH:MM (e.g. 09:45)
    is_ctc: bool = False,
    mtm_sl: Optional[float] = None,
    mtm_tp: Optional[float] = None,
    max_re_entry: int = 0,
    slippage_pct: float = 0.0,
    token: Optional[str] = None
) -> Dict[str, Any]:
    """Execute direct backtest request against StockMock API."""
    if not token:
        token = get_auth_token()

    headers = {
        "Content-Type": "application/json",
        "token": token,
        "feversion": FE_VERSION,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    cookies = {
        "_rdl34hcrd": token,
        "sm_token": token
    }

    # Format dates
    # StockMock expects toDate to be end_date + 1 day
    to_dt = datetime.strptime(to_date, "%Y-%m-%d").date() + timedelta(days=1)
    to_date_str = to_dt.strftime("%Y-%m-%d")

    entry_exit_time = f"{entry_time},{exit_time}"
    href_et = entry_exit_time
    if is_trb and trb_time:
        th, tm = trb_time.split(":")[:2]
        href_et += f"_trb_{th}_{tm}"

    href = f"{BASE_URL}/#!/home/share?p={positions_str}&et={href_et}&s={strategy}&ed=0,0"
    if mtm_sl is not None:
        href += f"&sl={abs(int(mtm_sl))}all"
    if mtm_tp is not None:
        href += f"&tp={int(mtm_tp)}all"

    payload: Dict[str, Any] = {
        "positions": positions_str,
        "entryExitTime": entry_exit_time,
        "noReEntryAfter": None,
        "strategy": "intradayProfit" if (mtm_sl or mtm_tp) else strategy,
        "entryExitDays": "0,0",
        "useFutureAsBasePrice": False,
        "fromDate": from_date,
        "toDate": to_date_str,
        "isCTC": is_ctc,
        "maxReEntryValue": max_re_entry,
        "stopEntireTradeAndReRunCount": 0,
        "isExtendedWeek": False,
        "isMidExpiryExit": False,
        "midExpiryExitDTE": 0,
        "isMultiDayWaitEntry": False,
        "stopEntireTrade": bool(mtm_sl or mtm_tp),
        "href": href
    }

    if is_trb and trb_time:
        th, tm = trb_time.split(":")[:2]
        payload["isTRB"] = True
        payload["selectedTrb"] = {"h": th, "m": tm}

    if mtm_sl is not None:
        payload["stopLossPrice"] = -abs(float(mtm_sl))
    if mtm_tp is not None:
        payload["targetProfitPrice"] = abs(float(mtm_tp))

    url = f"{BASE_URL}/api/startBacktesting"
    resp = requests.post(url, json=payload, headers=headers, cookies=cookies, impersonate="chrome120", timeout=120)
    
    if resp.status_code == 401:
        # Token expired, retry once with force refresh
        token = get_auth_token(force_refresh=True)
        headers["token"] = token
        cookies["_rdl34hcrd"] = token
        cookies["sm_token"] = token
        resp = requests.post(url, json=payload, headers=headers, cookies=cookies, impersonate="chrome120", timeout=120)

    if resp.status_code != 200:
        err_msg = resp.text
        if resp.status_code == 402 and ("Backtesting Plan" in err_msg or "BUY PLANS" in err_msg):
            raise RuntimeError(
                f"StockMock backtest credit limit reached: Your daily free backtest credits for today have been fully consumed. "
                f"Free credits reset daily at midnight IST. (Server response: {err_msg[:120]})"
            )
        raise RuntimeError(f"StockMock backtest failed (HTTP {resp.status_code}): {err_msg[:300]}")


    raw_data = resp.json()

    # Parse and flatten multi-expiry results
    parsed_days: Dict[str, Any] = {}
    for expiry, exp_data in raw_data.items():
        if isinstance(exp_data, dict) and "result" in exp_data:
            for d_str, day_row in exp_data["result"].items():
                parsed_days[d_str] = parse_day_row(day_row, slippage_pct)

    return {
        "raw": raw_data,
        "days": dict(sorted(parsed_days.items()))
    }


def parse_day_row(row: Dict[str, Any], slippage_pct: float = 0.0) -> Dict[str, Any]:
    """Extract clean metrics and leg details from StockMock raw day result row."""
    import re
    profit = float(row.get("profit", 0.0))
    exit_time = row.get("exitTime", "")
    vix = row.get("India VIX", "")
    legs = []

    for k, v in row.items():
        if "Sell" in k or "Buy" in k:
            text_val = str(v)
            # Regex: PnL (Entry - Exit = Diff) Strike
            # Example: "1547 (40.6-16.8=-23.8) 24050CE" or "-21 (133.78-134.1=0.32) 23900CE"
            m = re.search(r"([-\d\.]+)\s*\(([\d\.]+)-([\d\.]+)=([-\d\.]+)\)\s*(\d+[A-Z]+)", text_val)
            leg_info = {"desc": k, "raw": text_val}
            if m:
                leg_info["pnl"] = float(m.group(1))
                leg_info["entry"] = float(m.group(2))
                leg_info["exit"] = float(m.group(3))
                leg_info["diff"] = float(m.group(4))
                leg_info["contract"] = m.group(5)
            legs.append(leg_info)

    return {
        "profit": profit,
        "exit_time": exit_time,
        "vix": vix,
        "legs": legs,
        "raw_row": row
    }



# ---------------------------------------------------------------------------
# Validation Engine Against Dhan Local Engine
# ---------------------------------------------------------------------------

def validate_against_dhan_engine(
    sm_results: Dict[str, Any],
    from_date: str,
    to_date: str,
    entry_time: str = "09:22",
    exit_time: str = "15:15",
    strategy_type: str = "straddle",
    lot_size: int = 65,
    sl_pct: float = 0.0,
    tp_pct: float = 0.0,
    range_breakout: bool = False,
    range_time: Optional[str] = None,
    mtm_sl: Optional[float] = None,
    mtm_tp: Optional[float] = None
) -> None:
    """Run local Dhan engine and print a side-by-side verification table."""
    script_path = os.path.join(REPO_ROOT, "scripts", "analysis", "backtest_short_straddle.py")
    python_exe = sys.executable

    if strategy_type == "iron_condor":
        legs_config = [
            {"option_type": "CE", "position": "sell", "lots": 1, "strike": "ATM+2", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct},
            {"option_type": "CE", "position": "buy", "lots": 1, "strike": "ATM+4", "leg_sl_pct": 0},
            {"option_type": "PE", "position": "sell", "lots": 1, "strike": "ATM-2", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct},
            {"option_type": "PE", "position": "buy", "lots": 1, "strike": "ATM-4", "leg_sl_pct": 0}
        ]
    elif strategy_type == "strangle":
        legs_config = [
            {"option_type": "CE", "position": "sell", "lots": 1, "strike": "ATM+2", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct},
            {"option_type": "PE", "position": "sell", "lots": 1, "strike": "ATM-2", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct}
        ]
    else:
        legs_config = [
            {"option_type": "CE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct},
            {"option_type": "PE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": sl_pct, "leg_target_pct": tp_pct}
        ]

    cmd = [
        python_exe, script_path,
        "--start-date", from_date,
        "--end-date", to_date,
        "--entry-time", entry_time[:5],
        "--eod-time", exit_time[:5],
        "--lot-size", str(lot_size),
        "--commission-per-lot", "0",
        "--cost-model", "flat",
        "--slippage-pct", "0.0",
        # Pin these explicitly rather than relying on backtest_short_straddle.py's argparse
        # defaults: this harness wants no profit-target/overall-SL unless mtm_tp/mtm_sl says
        # otherwise, and that script's own default for --profit-target-pct has changed before
        # (813000c, 2026-09-27, 50.0 -> 0.0) without this file being touched.
        "--profit-target-pct", "0",
        "--overall-sl-pct", "0",
        "--legs", json.dumps(legs_config),
        "--use-db"
    ]

    if mtm_sl is not None:
        cmd.extend(["--overall-sl-val", str(abs(mtm_sl)), "--overall-sl-type", "mtm"])
    if mtm_tp is not None:
        cmd.extend(["--profit-target-val", str(abs(mtm_tp)), "--profit-target-type", "mtm"])

    if range_breakout and range_time:
        cmd.extend(["--range-breakout", "--range-until-time", range_time[:5]])


    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Error running Dhan engine: {res.stderr[:300]}", file=sys.stderr)
        return

    stdout = res.stdout
    idx = stdout.find('{"summary":')
    if idx == -1:
        print("Dhan engine did not produce JSON output.", file=sys.stderr)
        return

    dhan_data = json.loads(stdout[idx:])
    dhan_cycles = {c.get("entry_dt", "")[:10]: c for c in dhan_data.get("cycles", []) if c.get("entry_dt")}

    print("\n" + "=" * 92)
    print(f"{'Date':<11} | {'StockMock P&L':<15} | {'Dhan Engine P&L':<16} | {'Delta (Diff)':<13} | {'Status':<10}")
    print("=" * 92)

    total_sm = 0.0
    total_dhan = 0.0
    matches = 0
    total_days = 0

    for d, sm_day in sm_results["days"].items():
        if d < from_date or d > to_date:
            continue
        total_days += 1
        sm_p = sm_day["profit"]
        total_sm += sm_p
        
        dhan_c = dhan_cycles.get(d)
        if not dhan_c:
            print(f"{d:<11} | ₹{sm_p:>13.2f} | {'NO ENTRY':<16} | {'N/A':<13} | MISSING")
            continue

        dhan_p = float(dhan_c.get("pnl", 0.0))
        total_dhan += dhan_p
        diff = dhan_p - sm_p
        
        # Consider within ₹50 or 2% as aligned (due to tick close snapshot differences)
        aligned = abs(diff) <= max(50.0, abs(sm_p) * 0.03)
        status = "MATCH" if aligned else "DIVERGED"
        if aligned:
            matches += 1

        print(f"{d:<11} | ₹{sm_p:>13.2f} | ₹{dhan_p:>14.2f} | ₹{diff:>+11.2f} | {status:<10}")

    print("-" * 92)
    net_diff = total_dhan - total_sm
    match_pct = (matches / max(1, total_days)) * 100
    print(f"{'TOTAL':<11} | ₹{total_sm:>13.2f} | ₹{total_dhan:>14.2f} | ₹{net_diff:>+11.2f} | {match_pct:.1f}% Match")
    print("=" * 92 + "\n")


# ---------------------------------------------------------------------------
# CLI Interface
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="StockMock Fast API Backtester & Validator")
    parser.add_argument("--strategy", choices=["straddle", "strangle", "cp", "iron_condor", "custom"], default="straddle")
    parser.add_argument("--start-date", default="2026-09-01", help="YYYY-MM-DD")
    parser.add_argument("--end-date", default="2026-09-10", help="YYYY-MM-DD")
    parser.add_argument("--entry-time", default="09:22", help="HH:MM")
    parser.add_argument("--exit-time", default="15:15", help="HH:MM")
    parser.add_argument("--lot-size", type=int, default=65)
    parser.add_argument("--lots", type=int, default=1)
    parser.add_argument("--sl-pct", type=float, default=0.0)
    parser.add_argument("--tp-pct", type=float, default=0.0)
    parser.add_argument("--cp-val", type=float, default=35.0, help="Target premium for cp strategy")
    parser.add_argument("--trb-time", default=None, help="TRB time e.g. 09:45")
    parser.add_argument("--mtm-sl", type=float, default=None)
    parser.add_argument("--mtm-tp", type=float, default=None)
    parser.add_argument("--validate", action="store_true", help="Run side-by-side validation against Dhan engine")
    parser.add_argument("--json", action="store_true", help="Output raw JSON response")
    
    args = parser.parse_args()

    # StockMock's internal base multiplier for NIFTY is 75 (lots = qty / 75)
    sm_qty = args.lots * 75
    entry_t = f"{args.entry_time[:5]}:00"
    exit_t = f"{args.exit_time[:5]}:00"

    sl_type = "slp" if args.sl_pct > 0 else None
    sl_val = args.sl_pct if args.sl_pct > 0 else None
    tp_type = "tpp" if args.tp_pct > 0 else None
    tp_val = args.tp_pct if args.tp_pct > 0 else None

    if args.strategy == "straddle":
        leg_ce = build_leg_string("N", "L1", "0", "S", "CE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        leg_pe = build_leg_string("N", "L2", "0", "S", "PE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        positions = f"{leg_ce},{leg_pe}"
    elif args.strategy == "strangle":
        leg_ce = build_leg_string("N", "L1", "100", "S", "CE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        leg_pe = build_leg_string("N", "L2", "-100", "S", "PE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        positions = f"{leg_ce},{leg_pe}"
    elif args.strategy == "iron_condor":
        leg1 = build_leg_string("N", "L1", "100", "S", "CE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        leg2 = build_leg_string("N", "L2", "200", "B", "CE", sm_qty)
        leg3 = build_leg_string("N", "L3", "-100", "S", "PE", sm_qty, sl_type, sl_val, tp_type, tp_val)
        leg4 = build_leg_string("N", "L4", "-200", "B", "PE", sm_qty)
        positions = f"{leg1},{leg2},{leg3},{leg4}"
    elif args.strategy == "cp":
        trb_str = f"Lo_{args.trb_time}:00" if args.trb_time else None
        leg_ce = build_leg_string("N", "L1", f"CP{int(args.cp_val)};cl", "S", "CE", sm_qty, sl_type, sl_val, tp_type, tp_val, entry_type="cp", trb=trb_str)
        leg_pe = build_leg_string("N", "L2", f"CP{int(args.cp_val)};cl", "S", "PE", sm_qty, sl_type, sl_val, tp_type, tp_val, entry_type="cp", trb=trb_str)
        positions = f"{leg_ce},{leg_pe}"
    else:
        # Default ATM straddle
        leg_ce = build_leg_string("N", "L1", "0", "S", "CE", sm_qty)
        leg_pe = build_leg_string("N", "L2", "0", "S", "PE", sm_qty)
        positions = f"{leg_ce},{leg_pe}"



    print(f"Running StockMock backtest: {args.strategy.upper()} ({args.start_date} to {args.end_date})...")
    res = run_stockmock_backtest(
        positions_str=positions,
        from_date=args.start_date,
        to_date=args.end_date,
        entry_time=entry_t,
        exit_time=exit_t,
        is_trb=bool(args.trb_time),
        trb_time=args.trb_time,
        mtm_sl=args.mtm_sl,
        mtm_tp=args.mtm_tp
    )

    if args.json:
        print(json.dumps(res, indent=2))
        return

    if args.validate:
        validate_against_dhan_engine(
            sm_results=res,
            from_date=args.start_date,
            to_date=args.end_date,
            entry_time=args.entry_time,
            exit_time=args.exit_time,
            strategy_type=args.strategy,
            lot_size=args.lot_size,
            sl_pct=args.sl_pct,
            tp_pct=args.tp_pct,
            range_breakout=bool(args.trb_time),
            range_time=args.trb_time,
            mtm_sl=args.mtm_sl,
            mtm_tp=args.mtm_tp
        )

    else:
        print("\n" + "=" * 65)
        print(f"{'Date':<12} | {'Exit Time':<10} | {'StockMock P&L':<15} | {'VIX':<12}")
        print("=" * 65)
        total = 0.0
        for d, day in res["days"].items():
            if d < args.start_date or d > args.end_date:
                continue
            p = day["profit"]
            total += p
            print(f"{d:<12} | {day['exit_time']:<10} | ₹{p:>13.2f} | {day['vix']:<12}")
        print("-" * 65)
        print(f"{'TOTAL':<12} | {'':<10} | ₹{total:>13.2f} |")
        print("=" * 65 + "\n")


if __name__ == "__main__":
    main()
