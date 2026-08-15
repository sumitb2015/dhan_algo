"""
Cash Secured Put scanner over the Nifty 500 F&O universe.

Long-running: the Dhan option-chain endpoint self-throttles to one call every
3 seconds, so a full sweep of ~200 F&O names takes ~10 minutes. The dashboard
spawns this detached and polls debug/csp_scan_status.json, the same way the
data refresh works.

Usage:
    python csp_scanner.py                      # full scan
    python csp_scanner.py --target-prob 0.85   # aim for a safer strike
    python csp_scanner.py --limit 20           # partial scan (testing)
"""
import sys
import os
import csv
import json
import math
import argparse
import warnings
from datetime import datetime, timezone, date, timedelta

warnings.filterwarnings("ignore")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "csp_scan_status.json")
RESULTS_FILE = os.path.join(DEBUG_DIR, "csp_scan_results.json")
STOP_FILE    = os.path.join(DEBUG_DIR, "csp_scan_stop.trigger")
N500_LIST    = os.path.join(PROJECT_ROOT, "ind_nifty500list.csv")
STOCKS_DIR   = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")

RISK_FREE_RATE = 0.065

os.makedirs(DEBUG_DIR, exist_ok=True)

_log_lines: list = []


def write_status(message: str, current: int = 0, total: int = 0,
                 done: bool = False, error: str = None):
    _log_lines.append(message)
    if len(_log_lines) > 200:
        _log_lines.pop(0)
    payload = {
        "pid":        os.getpid(),
        "message":    message,
        "current":    current,
        "total":      total,
        "done":       done,
        "error":      error,
        "log":        _log_lines[-60:],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Write-then-rename: the dashboard polls this file continuously, and a torn
    # read parses as null, which the client reads as "not running" and abandons
    # a live scan.
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, STATUS_FILE)
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, OSError):
        pass


def should_stop() -> bool:
    return os.path.exists(STOP_FILE)


# ── Math ─────────────────────────────────────────────────────────────────────
def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def prob_above(spot: float, strike: float, years: float, iv: float,
               r: float = RISK_FREE_RATE) -> float:
    """Risk-neutral probability spot finishes above strike — i.e. the PUT
    expires worthless. Mirrors riskNeutralProbAbove() in lib/optionsStrategy.ts."""
    if years <= 0 or iv <= 0 or spot <= 0 or strike <= 0:
        return 1.0 if spot > strike else 0.0
    d2 = (math.log(spot / strike) + (r - (iv * iv) / 2) * years) / (iv * math.sqrt(years))
    return norm_cdf(d2)


# ── Universe ─────────────────────────────────────────────────────────────────
def read_nifty500() -> list:
    symbols = []
    with open(N500_LIST, newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            sym = (row.get('Symbol') or '').strip().upper()
            if sym:
                symbols.append(sym)
    return symbols


def fo_universe(helper: DhanHelper, symbols: list) -> tuple:
    """Filter to symbols that actually have stock option contracts.

    Returns ({symbol: default_lot}, {(symbol, expiry): lot}). The per-expiry map
    matters because NSE revises lot sizes on a forward expiry while the near
    month keeps the old one — taking any single row's LOT_SIZE would then send
    the wrong quantity. Built in one master-list pass; a per-symbol filter over
    ~288K rows for 200 symbols would dominate the scan's runtime."""
    df = helper._load_master_list()
    fo = df[df['INSTRUMENT'] == 'OPTSTK']
    wanted = set(symbols)
    default_lot = {}
    by_expiry = {}
    for sym, group in fo.groupby('UNDERLYING_SYMBOL'):
        sym = str(sym).strip().upper()
        if sym not in wanted:
            continue
        lots = []
        for expiry, lot in zip(group['SM_EXPIRY_DATE'], group['LOT_SIZE']):
            try:
                lot = int(float(lot))
            except (ValueError, TypeError):
                continue
            if lot <= 0:
                continue
            lots.append(lot)
            by_expiry[(sym, str(expiry)[:10])] = lot
        if lots:
            default_lot[sym] = lots[0]
    return default_lot, by_expiry


# ── Price history (for the 1D / 5D / cycle move columns) ─────────────────────
def read_history(symbol: str) -> list:
    """Trailing (date, close) pairs, oldest first. Empty when the CSV is missing."""
    path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
    if not os.path.exists(path):
        return []
    out = []
    try:
        with open(path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    d = datetime.strptime(str(row['Datetime'])[:10], "%Y-%m-%d").date()
                    out.append((d, float(row['Close'])))
                except (ValueError, KeyError, TypeError):
                    continue
    except OSError:
        return []
    return out


def pct_move(closes: list, lookback: int) -> float:
    if len(closes) <= lookback:
        return 0.0
    prev = closes[-1 - lookback]
    if prev <= 0:
        return 0.0
    return (closes[-1] - prev) / prev * 100.0


def prev_monthly_expiry(expiry: date) -> date:
    """Previous month's expiry — the last same-weekday of the preceding month.
    Indian stock options are monthly, so the option 'cycle' runs from the day
    after one expiry to the next."""
    first_of_month = expiry.replace(day=1)
    last_prev_month = first_of_month - timedelta(days=1)
    offset = (last_prev_month.weekday() - expiry.weekday()) % 7
    return last_prev_month - timedelta(days=offset)


def cycle_start(history: list, expiry: date):
    """First trading day of the current option cycle and its close — i.e. the
    session after the previous monthly expiry. Returns (None, 0.0) when the
    CSV doesn't reach back that far."""
    if not history:
        return None, 0.0
    prev_exp = prev_monthly_expiry(expiry)
    for d, close in history:
        if d > prev_exp:
            return d, close
    return None, 0.0


def prob_touch(spot: float, strike: float, years: float, iv: float,
               r: float = RISK_FREE_RATE) -> float:
    """Probability the underlying trades at or below the strike at any point
    before expiry — always higher than the chance of merely *finishing* below,
    which is what makes it the honest 'will this position scare me' number.
    Closed-form first-passage probability for GBM."""
    if years <= 0 or iv <= 0 or spot <= 0 or strike <= 0:
        return 1.0 if spot <= strike else 0.0
    if spot <= strike:
        return 1.0
    nu = r - iv * iv / 2.0
    sig_t = iv * math.sqrt(years)
    log_bs = math.log(strike / spot)
    first = norm_cdf((log_bs - nu * years) / sig_t)
    second = math.exp(2.0 * nu * log_bs / (iv * iv)) * norm_cdf((log_bs + nu * years) / sig_t)
    return min(1.0, max(0.0, first + second))


# ── Expiry selection ─────────────────────────────────────────────────────────
def pick_expiry(expiries: list, min_dte: int = 5) -> str:
    """Nearest expiry at least min_dte away — a 1-day-out contract has almost no
    premium left and would dominate the yield ranking for the wrong reason."""
    today = date.today()
    best = None
    for e in expiries:
        try:
            d = datetime.strptime(str(e)[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        dte = (d - today).days
        if dte >= min_dte and (best is None or dte < best[0]):
            best = (dte, str(e)[:10])
    return best[1] if best else ''


# ── Per-symbol scan ──────────────────────────────────────────────────────────
def scan_symbol(helper: DhanHelper, symbol: str, lot_size: int,
                target_prob: float, min_oi: int, max_iv: float,
                lot_by_expiry: dict = None, min_no_hit: float = 40.0) -> list:
    """All sellable OTM put strikes for the symbol's nearest usable expiry,
    one row each. Returns [] when the symbol has nothing tradeable."""
    spot = float(helper.get_ltp(symbol, instrument="EQUITY") or 0)
    if spot <= 0:
        return []

    expiries = helper.get_expiries(symbol) or []
    expiry = pick_expiry(expiries)
    if not expiry:
        return []

    # The contract actually being quoted decides the lot, not the symbol.
    if lot_by_expiry:
        lot_size = lot_by_expiry.get((symbol, expiry), lot_size)

    df = helper.get_option_chain_df(symbol, expiry)
    if df.empty:
        return []

    dte = (datetime.strptime(expiry, "%Y-%m-%d").date() - date.today()).days
    years = max(dte, 1) / 365.0

    candidates = []
    for strike, row in df.iterrows():
        strike = float(strike)
        if strike >= spot:
            continue  # cash-secured puts are OTM by definition
        premium = float(row.get('pe_last_price', 0) or 0)
        iv = float(row.get('pe_implied_volatility', 0) or 0) / 100.0
        oi = int(row.get('pe_oi', 0) or 0)
        # A strike with no open interest cannot actually be sold at the quoted
        # price, and its stale quote back-solves to a nonsense IV (150%+ on a
        # large-cap) that makes a deep-OTM strike look far safer than it is.
        # Both filters are needed — without them the scan recommends untradeable
        # strikes with fabricated probabilities.
        if premium <= 0 or iv <= 0 or oi < min_oi or iv * 100 > max_iv:
            continue
        candidates.append({
            "strike": strike,
            "premium": premium,
            "iv": iv,
            "oi": oi,
            "noHitProb": prob_above(spot, strike, years, iv),
        })

    if not candidates:
        return []

    # Every strike at or above the floor is a real, sellable choice — emitting
    # only the one nearest the target hid the whole risk/premium curve, so a
    # 55%-safe strike paying 4x the premium was never visible.
    candidates = [c for c in candidates if c["noHitProb"] * 100 >= min_no_hit]
    if not candidates:
        return []

    # Marks the strike closest to the target so the UI can collapse to one row
    # per symbol without re-deriving the preference.
    pick = min(candidates, key=lambda c: abs(c["noHitProb"] - target_prob))

    history = read_history(symbol)
    closes = [c for _, c in history]
    move_1d = pct_move(closes, 1)
    move_5d = pct_move(closes, 5)

    # Anchored to the option cycle (day after the previous monthly expiry)
    # rather than a fixed 21-session lookback, so the move lines up with the
    # life of the contract being sold.
    cyc_date, cyc_spot = cycle_start(history, datetime.strptime(expiry, "%Y-%m-%d").date())
    move_cycle = ((spot - cyc_spot) / cyc_spot * 100.0) if cyc_spot > 0 else 0.0

    rows = []
    for c in candidates:
        capital = c["strike"] * lot_size
        premium_total = c["premium"] * lot_size
        yield_pct = (c["premium"] / c["strike"] * 100.0) if c["strike"] else 0.0
        distance_pct = (spot - c["strike"]) / spot * 100.0

        # Annualised so strikes on different expiries are comparable, and because
        # raw yield on a ~10-day contract (0.02%-2%) is too compressed to rank on.
        ann_yield_pct = yield_pct * (365.0 / max(dte, 1))

        # Heuristic blend of safety, return and liquidity, scaled to 0-100.
        # Capping annualised yield at 30% keeps one very rich strike from
        # swamping safety; capping OI at 5000 does the same for liquidity.
        # Risk is meant to be controlled by the no-hit filter, not by this
        # score — it ranks attractiveness *within* whatever band is selected.
        score = round(
            c["noHitProb"] * 45
            + min(ann_yield_pct / 30.0, 1.0) * 40
            + min(c["oi"] / 5000.0, 1.0) * 15
        )

        rows.append({
            "symbol": symbol,
            "score": score,
            "ltp": round(spot, 2),
            "expiry": expiry,
            "dte": dte,
            "lotSize": lot_size,
            "move1d": round(move_1d, 2),
            "move5d": round(move_5d, 2),
            "moveCycle": round(move_cycle, 2),
            "cycleStart": cyc_date.isoformat() if cyc_date else None,
            "cycleSpot": round(cyc_spot, 2) if cyc_spot > 0 else None,
            # Headroom measured from where the cycle opened, matching how the
            # move columns are anchored; distancePct below is the same gap from
            # today's spot.
            "toStrikePct": round((cyc_spot - c["strike"]) / cyc_spot * 100.0, 2) if cyc_spot > 0 else None,
            "touchProb": round(prob_touch(spot, c["strike"], years, c["iv"]) * 100, 1),
            "strike": c["strike"],
            "premium": round(c["premium"], 2),
            "premiumTotal": round(premium_total, 2),
            "noHitProb": round(c["noHitProb"] * 100, 1),
            "iv": round(c["iv"] * 100, 1),
            "oi": c["oi"],
            "yieldPct": round(yield_pct, 2),
            "annYieldPct": round(ann_yield_pct, 1),
            "distancePct": round(distance_pct, 2),
            "capitalRequired": round(capital, 2),
            "isPick": c is pick,
            "rationale": (
                f"5d {move_5d:+.1f}% · PE {c['strike']:g} ~{c['noHitProb'] * 100:.0f}% "
                f"no-delivery · prem ₹{c['premium']:.1f} · {distance_pct:.1f}% OTM"
            ),
        })

    return rows


def main():
    parser = argparse.ArgumentParser(description="Scan Nifty 500 F&O stocks for cash-secured-put candidates")
    parser.add_argument('--target-prob', type=float, default=0.80, dest='target_prob',
                        help="Target probability the sold PUT expires worthless (default 0.80)")
    parser.add_argument('--limit', type=int, default=0,
                        help="Scan only the first N symbols (0 = all)")
    parser.add_argument('--min-oi', type=int, default=100, dest='min_oi',
                        help="Skip strikes with less open interest than this (default 100)")
    parser.add_argument('--max-iv', type=float, default=100.0, dest='max_iv',
                        help="Skip strikes whose implied volatility exceeds this %% (default 100)")
    parser.add_argument('--min-no-hit', type=float, default=40.0, dest='min_no_hit',
                        help="Lowest no-hit %% to emit; every liquid strike at or "
                             "above this is listed (default 40)")
    args = parser.parse_args()

    if os.path.exists(STOP_FILE):
        os.remove(STOP_FILE)

    write_status("Authenticating with Dhan…")
    try:
        dhan = get_dhan_client()
        if not dhan:
            raise RuntimeError("Failed to authenticate with Dhan")
        helper = DhanHelper(dhan)
    except Exception as e:
        write_status(f"Auth failed: {e}", done=True, error=str(e))
        return 1

    write_status("Building F&O universe…")
    try:
        universe, lot_by_expiry = fo_universe(helper, read_nifty500())
    except Exception as e:
        write_status(f"Universe build failed: {e}", done=True, error=str(e))
        return 1

    symbols = sorted(universe)
    if args.limit > 0:
        symbols = symbols[:args.limit]
    total = len(symbols)
    write_status(f"Scanning {total} F&O symbols…", 0, total)

    results = []
    stopped = False
    for i, symbol in enumerate(symbols, 1):
        if should_stop():
            stopped = True
            write_status(f"Stopped after {i - 1}/{total}", i - 1, total, done=True)
            break
        try:
            rows = scan_symbol(helper, symbol, universe[symbol], args.target_prob,
                               args.min_oi, args.max_iv, lot_by_expiry, args.min_no_hit)
            results.extend(rows)
        except Exception as e:
            write_status(f"[{i}/{total}] {symbol} failed: {e}", i, total)
            continue
        write_status(f"[{i}/{total}] {symbol} — {len(results)} candidates", i, total)

    # An aborted scan must not replace a previous complete result set with a
    # partial one — the page has no way to tell the two apart.
    if stopped:
        write_status(f"Stopped — kept previous results ({len(results)} scanned, not saved)",
                     len(results), total, done=True)
        return 0

    results.sort(key=lambda r: r["score"], reverse=True)
    tmp = RESULTS_FILE + ".tmp"
    with open(tmp, "w", encoding='utf-8') as f:
        json.dump({
            "scannedAt": datetime.now(timezone.utc).isoformat(),
            "targetProb": args.target_prob,
            "minNoHit": args.min_no_hit,
            "symbolsScanned": total,
            "rows": results,
        }, f, indent=2)
    os.replace(tmp, RESULTS_FILE)

    write_status(f"Done — {len(results)} candidates from {total} symbols",
                 total, total, done=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
