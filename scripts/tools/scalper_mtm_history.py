"""Rebuild today's true intraday MTM curve for the Scalper / Advanced Scalper "Mtm" tab.

The dashboard previously drew this curve in the browser from the trade book alone, which
can only reconstruct *realized* P&L: it books profit when a fill reduces or closes
quantity and is otherwise blind to what an open position is doing. On a two-legged book
that produces a badly wrong shape - closing the losing leg prints the whole loss as a
cliff while the winning leg's offsetting gain stays invisible until it too is closed, so
the curve plunges and then teleports back up. Day Low and Max Drawdown were both read off
that artefact.

This script fixes it by marking the open book to market at every minute of the session:

    MTM(t) = realized(t) + SUM over open symbols of  qty(t) * (close(t) - avgCost(t)) * mult

which needs 1-minute candles for every contract traded today - a Dhan Data API call per
distinct security, hence Python rather than the browser.

Input: one JSON object, either from the file named by argv[1] or from stdin:

    {"broker": "dhan"|"zerodha"|"kotak", "trades": [ ...trade-book rows... ]}

Trades are passed in (rather than fetched here) so that a Zerodha/Kotak curve does not
need a second login - the dashboard already holds those books.

Output: one JSON line on stdout, logs on stderr.

    {"success": true,
     "points": [{"time": "<ISO+05:30>", "pnl": 0.0, "realized": 0.0, "unrealized": 0.0}],
     "unresolved": ["SYMBOL"], "truncated": 0, "error": null}

`unresolved` lists contracts whose Dhan security id could not be found; they are marked at
their last traded price instead of a candle close, so their leg of the curve is flat
rather than silently dropped. Brokerage/STT/charges are NOT modelled - the curve is
pre-charges, matching the tab's live tail.

Usage:
    venv\\Scripts\\python.exe scripts/tools/scalper_mtm_history.py debug/mtm_request.json
    venv\\Scripts\\python.exe scripts/tools/scalper_mtm_history.py < debug/mtm_request.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client              # noqa: E402
from lib.dhan_helper import DhanHelper         # noqa: E402

IST = ZoneInfo("Asia/Kolkata")
DEBUG_DIR = os.path.join(ROOT, "debug")

# NSE/BSE F&O settles at 15:30. MCX runs to 23:30, so a book holding any MCX leg must not
# be truncated at the equity close.
SESSION_END_FNO = (15, 30)
SESSION_END_MCX = (23, 30)
SESSION_START_FNO = (9, 15)
SESSION_START_MCX = (9, 0)

# One Data API call per distinct contract. A pathological book would otherwise stall the
# request for minutes; anything beyond this is reported in `truncated` rather than dropped
# in silence.
MAX_SECURITIES = 60

BARE_TIME = re.compile(r"^\d{2}:\d{2}:\d{2}$")

# Mirrors rs_dashboard/lib/positionPnl.ts - Dhan reports MCX quantity in LOTS with the
# barrels-per-lot multiplier left off. Deliberately keyed on the exact segment string
# "MCX_COMM", which only Dhan rows carry: Kotak's MCX quantity (exSeg "mcx_fo") is already
# absolute, so it must NOT be multiplied.
MCX_LOT_MULTIPLIER = {"CRUDEOIL": 100, "CRUDEOILM": 10}

# Underlying -> (master-list EXCH_ID, Dhan segment, instrument types to try in order).
# Used only for the non-Dhan brokers, whose trade rows carry no Dhan security id.
UNDERLYING_MARKET = {
    "SENSEX":    ("BSE", "BSE_FNO", ("OPTIDX",)),
    "CRUDEOIL":  ("MCX", "MCX_COMM", ("OPTFUT", "OPTCOM")),
    "CRUDEOILM": ("MCX", "MCX_COMM", ("OPTFUT", "OPTCOM")),
}
DEFAULT_MARKET = ("NSE", "NSE_FNO", ("OPTIDX", "OPTSTK"))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


# ── Input ────────────────────────────────────────────────────────────────────

def read_request() -> dict:
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


# ── Fill normalisation (mirrors MtmChart.tsx's buildTradeMtmSeries) ──────────

def contract_multiplier(row: dict) -> float:
    segment = str(row.get("exchangeSegment") or row.get("exchange") or "")
    if segment != "MCX_COMM":
        return 1.0
    trading_symbol = str(row.get("tradingSymbol") or row.get("customSymbol") or row.get("tradingsymbol") or row.get("symbol") or "")
    underlying = trading_symbol.split("-")[0].upper()
    return float(MCX_LOT_MULTIPLIER.get(underlying, 1))


def parse_fill_time(raw: str, today: str) -> datetime | None:
    """Kotak stamps a fill as a bare HH:MM:SS with no date at all, unlike Dhan and Zerodha
    which both carry a full date. Give it today's IST date and an explicit +05:30 so it
    parses the same way regardless of the machine's timezone."""
    text = str(raw or "").strip()
    if not text:
        return None
    if BARE_TIME.match(text):
        text = f"{today}T{text}+05:30"
    try:
        dt = pd.Timestamp(text)
    except (ValueError, TypeError):
        return None
    if pd.isna(dt):
        return None
    dt = dt.tz_localize(IST) if dt.tzinfo is None else dt.tz_convert(IST)
    return dt.to_pydatetime()


def normalize_fills(trades: list, today: str) -> list[dict]:
    fills = []
    for row in trades:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("tradingSymbol") or row.get("customSymbol") or row.get("tradingsymbol") or row.get("symbol") or "")
        side = str(row.get("transactionType") or "").upper()
        try:
            qty = float(row.get("tradedQuantity") or row.get("quantity") or 0)
            price = float(row.get("tradedPrice") or row.get("price") or 0)
        except (TypeError, ValueError):
            continue
        when = parse_fill_time(row.get("createTime") or row.get("exchangeTime") or row.get("fill_timestamp") or "", today)
        if not symbol or qty <= 0 or price <= 0 or when is None or side not in ("BUY", "SELL"):
            continue
        fills.append({
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "price": price,
            "time": when,
            "mult": contract_multiplier(row),
            "security_id": str(row.get("securityId") or row.get("security_id") or row.get("instrument_token") or ""),
            "segment": str(row.get("exchangeSegment") or row.get("exchange") or ""),
        })
    fills.sort(key=lambda f: f["time"])
    return fills


def extract_starting_positions(broker: str, positions: list) -> dict[str, dict]:
    """Extract opening carry-forward (overnight) positions at the start of today's session."""
    starting: dict[str, dict] = {}
    for p in positions:
        if not isinstance(p, dict):
            continue
        sym = str(p.get("tradingSymbol") or p.get("customSymbol") or p.get("tradingsymbol") or p.get("symbol") or "")
        if not sym:
            continue
        mult = contract_multiplier(p)
        sec_id = str(p.get("securityId") or p.get("security_id") or p.get("instrument_token") or "")
        segment = str(p.get("exchangeSegment") or p.get("exchange") or "")
        instrument = str(p.get("drvOptionType") or p.get("instrumentType") or p.get("instrument") or "OPTIDX")

        cf_buy = float(p.get("carryForwardBuyQty") or p.get("cfBuyQty") or 0)
        cf_sell = float(p.get("carryForwardSellQty") or p.get("cfSellQty") or 0)
        cf_buy_val = float(p.get("carryForwardBuyValue") or p.get("cfBuyAmt") or 0)
        cf_sell_val = float(p.get("carryForwardSellValue") or p.get("cfSellAmt") or 0)

        # Kite-specific overnight quantity check if carryForward* was not set directly
        overnight = p.get("overnight_quantity") or p.get("overnightQuantity")
        if overnight is not None and cf_buy == 0 and cf_sell == 0:
            try:
                oq = float(overnight)
                if oq > 0:
                    cf_buy = oq
                    cf_buy_val = oq * float(p.get("buy_price") or p.get("buyAvg") or 0)
                elif oq < 0:
                    cf_sell = abs(oq)
                    cf_sell_val = abs(oq) * float(p.get("sell_price") or p.get("sellAvg") or 0)
            except (TypeError, ValueError):
                pass

        if cf_buy > 0:
            avg_unit = (cf_buy_val / (cf_buy * mult)) if (cf_buy > 0 and mult > 0 and cf_buy_val > 0) else float(p.get("buyAvg") or 0)
            starting[sym] = {
                "qty": cf_buy,
                "avg_price": avg_unit,
                "mult": mult,
                "security_id": sec_id,
                "segment": segment,
                "instrument": instrument,
            }
        elif cf_sell > 0:
            avg_unit = (cf_sell_val / (cf_sell * mult)) if (cf_sell > 0 and mult > 0 and cf_sell_val > 0) else float(p.get("sellAvg") or 0)
            starting[sym] = {
                "qty": -cf_sell,
                "avg_price": avg_unit,
                "mult": mult,
                "security_id": sec_id,
                "segment": segment,
                "instrument": instrument,
            }

    return starting


# ── Contract resolution: broker symbol -> Dhan (security id, segment, instrument) ────

def load_broker_instruments(broker: str) -> dict[str, dict]:
    """Index every cached contract for this broker by trading symbol.

    The caches (debug/<broker>_<underlying>_instruments.json, written by
    {zerodha,kotak}_instruments_cache.py) share one row shape on purpose, and the
    underlying comes from the filename - so a broker symbol is never parsed or rebuilt.
    Kotak mixes monthly (NIFTY26SEP29200PE) and weekly (NIFTY2680429350PE) formats and a
    hand-built symbol silently resolves to nothing."""
    index: dict[str, dict] = {}
    prefix = f"{broker}_"
    suffix = "_instruments.json"
    try:
        names = os.listdir(DEBUG_DIR)
    except OSError:
        return index
    for name in names:
        if not (name.startswith(prefix) and name.endswith(suffix)):
            continue
        underlying = name[len(prefix):-len(suffix)].upper()
        try:
            with open(os.path.join(DEBUG_DIR, name), "r", encoding="utf-8") as fh:
                rows = json.load(fh)
        except (OSError, ValueError):
            log(f"[mtm] could not read instrument cache {name}")
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            symbol = str(row.get("tradingsymbol") or "").upper()
            if symbol:
                index[symbol] = {**row, "underlying": underlying}
    return index


def resolve_contracts(helper: DhanHelper, broker: str, fills: list[dict],
                      starting_positions: dict[str, dict]) -> tuple[dict, list[str]]:
    """symbol -> {security_id, segment, instrument}; plus the symbols that could not be resolved."""
    resolved: dict[str, dict] = {}
    unresolved: list[str] = []
    symbols = list(dict.fromkeys([f["symbol"] for f in fills] + list(starting_positions.keys())))

    if broker == "dhan":
        # Dhan trade rows and position rows carry securityId and segment.
        master = helper._load_master_list()
        by_sid = master.copy()
        by_sid["_sid"] = by_sid["SECURITY_ID"].apply(lambda v: str(int(float(v))) if pd.notna(v) else "")
        by_sid = by_sid.set_index("_sid")
        for symbol in symbols:
            fill = next((f for f in fills if f["symbol"] == symbol), None)
            if fill and fill.get("security_id") and fill.get("segment"):
                sid, segment = fill["security_id"], fill["segment"]
            else:
                sp = starting_positions.get(symbol, {})
                sid, segment = sp.get("security_id", ""), sp.get("segment", "")

            if not sid or not segment:
                unresolved.append(symbol)
                continue
            try:
                value = by_sid.loc[sid, "INSTRUMENT"]
                instrument = str(value.iloc[0] if hasattr(value, "iloc") else value)
            except (KeyError, TypeError, ValueError):
                instrument = "OPTIDX"
            resolved[symbol] = {"security_id": sid, "segment": segment, "instrument": instrument}
        return resolved, unresolved

    instruments = load_broker_instruments(broker)
    for symbol in symbols:
        cached = instruments.get(symbol.upper())
        if not cached:
            unresolved.append(symbol)
            continue
        underlying = str(cached.get("underlying") or "").upper()
        exch, segment, instrument_types = UNDERLYING_MARKET.get(underlying, DEFAULT_MARKET)
        expiry = str(cached.get("expiry") or "")
        opt_type = str(cached.get("instrument_type") or "").upper()
        try:
            strike = float(cached.get("strike") or 0)
        except (TypeError, ValueError):
            strike = 0.0
        row = None
        for instrument in instrument_types:
            row = helper.find_option(underlying, expiry, strike, opt_type,
                                     exchange=exch, instrument=instrument)
            if row:
                break
        if not row:
            unresolved.append(symbol)
            continue
        resolved[symbol] = {
            # SECURITY_ID arrives as a float in the master frame, and Dhan's intraday API
            # rejects a "65891.0"-shaped id with DH-905.
            "security_id": str(int(float(row["SECURITY_ID"]))),
            "segment": segment,
            "instrument": str(row.get("INSTRUMENT") or instrument),
        }
    return resolved, unresolved


# ── Candles ──────────────────────────────────────────────────────────────────

_last_intraday_call = 0.0


def fetch_minute_closes(helper: DhanHelper, security_id: str, segment: str,
                        instrument: str, to_dt: datetime) -> dict[str, float]:
    """{'HH:MM': close} for today, or {} on failure. Same calling conventions as
    options_chart_fetch.py's _fetch_intraday, which were probed against the live API."""
    global _last_intraday_call

    # Dhan's intraday_minute_data rejects a same-day-only range with DH-905 - it wants
    # plain YYYY-MM-DD dates spanning at least two calendar days, so ask for a window and
    # filter to today below.
    from_date = (to_dt - timedelta(days=4)).strftime("%Y-%m-%d")
    to_date = to_dt.strftime("%Y-%m-%d")

    def call() -> pd.DataFrame:
        global _last_intraday_call
        # 0.35s between calls: empirically the floor before DH-904 rate limits kick in.
        elapsed = time.time() - _last_intraday_call
        if elapsed < 0.35:
            time.sleep(0.35 - elapsed)
        _last_intraday_call = time.time()
        return helper.get_intraday_minute_data(
            security_id=security_id, exchange_segment=segment,
            instrument_type=instrument, interval="1",
            from_date=from_date, to_date=to_date,
        )

    try:
        df = call()
        if df.empty and helper.last_api_error:
            blob = f"{helper.last_api_error.get('code', '')}{helper.last_api_error.get('message', '')}"
            if "904" in blob:
                time.sleep(1.0)
                df = call()
    except Exception as exc:  # noqa: BLE001 - one bad leg must not kill the whole curve
        log(f"[mtm] candles failed for {security_id}: {exc}")
        return {}

    if df.empty or "timestamp" not in df.columns or "close" not in df.columns:
        # Data API failures are silent by default - surface the reason rather than
        # letting the caller conclude "no trades that minute".
        if helper.last_api_error:
            log(f"[mtm] no candles for {security_id}: {helper.last_api_error}")
        return {}

    today_str = to_dt.strftime("%Y-%m-%d")
    times = pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST)
    closes: dict[str, float] = {}
    for ts, close in zip(times, df["close"]):
        if ts.strftime("%Y-%m-%d") != today_str:
            continue
        try:
            closes[ts.strftime("%H:%M")] = float(close)
        except (TypeError, ValueError):
            continue
    return closes


# ── The curve ────────────────────────────────────────────────────────────────

def build_minute_grid(start: datetime, end: datetime) -> list[datetime]:
    grid, cursor = [], start
    while cursor <= end:
        grid.append(cursor)
        cursor += timedelta(minutes=1)
    return grid


def build_points(fills: list[dict], starting_positions: dict[str, dict],
                 closes_by_symbol: dict[str, dict[str, float]],
                 grid: list[datetime]) -> list[dict]:
    """Walk the session minute by minute, applying fills as they land and marking whatever
    is still open against that minute's candle close."""
    book: dict[str, dict] = {}          # symbol -> {qty, avg_price, mult, last_price}
    for sym, sp in starting_positions.items():
        book[sym] = {
            "qty": sp["qty"],
            "avg_price": sp["avg_price"],
            "mult": sp["mult"],
            "last_price": sp["avg_price"],
        }

    realized = 0.0
    idx = 0
    points: list[dict] = []
    last_known_close: dict[str, float] = {}

    for minute in grid:
        key = minute.strftime("%H:%M")
        while idx < len(fills) and fills[idx]["time"] <= minute + timedelta(seconds=59):
            fill = fills[idx]
            idx += 1
            pos = book.setdefault(fill["symbol"], {"qty": 0.0, "avg_price": 0.0,
                                                   "mult": fill["mult"], "last_price": fill["price"]})
            pos["last_price"] = fill["price"]
            pos["mult"] = fill["mult"]
            signed = fill["qty"] if fill["side"] == "BUY" else -fill["qty"]
            if pos["qty"] == 0 or (pos["qty"] > 0) == (signed > 0):
                # Opening or adding in the same direction - roll the average cost.
                new_qty = pos["qty"] + signed
                pos["avg_price"] = (pos["avg_price"] * abs(pos["qty"]) + fill["price"] * fill["qty"]) / abs(new_qty)
                pos["qty"] = new_qty
            else:
                # Reducing, closing, or reversing through zero.
                closing_qty = min(abs(pos["qty"]), fill["qty"])
                closing_sign = 1.0 if pos["qty"] > 0 else -1.0
                realized += closing_sign * closing_qty * (fill["price"] - pos["avg_price"]) * fill["mult"]
                remaining = fill["qty"] - closing_qty
                pos["qty"] += signed
                if remaining > 0:
                    pos["avg_price"] = fill["price"]

        unrealized = 0.0
        for symbol, pos in book.items():
            if pos["qty"] == 0:
                continue
            mark = closes_by_symbol.get(symbol, {}).get(key)
            if mark is not None:
                last_known_close[symbol] = mark
            else:
                mark = last_known_close.get(symbol)
            if mark is None:
                mark = pos["avg_price"]
            unrealized += pos["qty"] * (mark - pos["avg_price"]) * pos["mult"]

        points.append({
            "time": minute.isoformat(),
            "pnl": round(realized + unrealized, 2),
            "realized": round(realized, 2),
            "unrealized": round(unrealized, 2),
        })
    return points


def main() -> None:
    try:
        request = read_request()
    except (OSError, ValueError) as exc:
        emit({"success": False, "points": [], "unresolved": [], "truncated": 0,
              "error": f"bad request: {exc}"})
        return

    broker = str(request.get("broker") or "dhan").lower()
    trades = request.get("trades") or []
    positions = request.get("positions") or []
    now = datetime.now(IST)
    today = now.strftime("%Y-%m-%d")

    fills = normalize_fills(trades, today)
    starting_positions = extract_starting_positions(broker, positions)

    if not fills and not starting_positions:
        emit({"success": True, "points": [], "unresolved": [], "truncated": 0, "error": None})
        return

    dhan = get_dhan_client()
    if not dhan:
        emit({"success": False, "points": [], "unresolved": [], "truncated": 0,
              "error": "Failed to authenticate with Dhan"})
        return
    helper = DhanHelper(dhan)

    resolved, unresolved = resolve_contracts(helper, broker, fills, starting_positions)
    if unresolved:
        log(f"[mtm] {len(unresolved)} contract(s) unresolved: {unresolved}")
    if not resolved:
        # Nothing resolved at all - a missing instrument cache, or a payload from a different
        # broker than the one named.
        emit({"success": False, "points": [], "unresolved": unresolved, "truncated": 0,
              "error": f"could not resolve any of {len(unresolved)} contract(s) for broker '{broker}'"})
        return

    truncated = 0
    wanted = list(resolved.items())
    if len(wanted) > MAX_SECURITIES:
        truncated = len(wanted) - MAX_SECURITIES
        log(f"[mtm] {truncated} contract(s) beyond the {MAX_SECURITIES} cap left unpriced")
        wanted = wanted[:MAX_SECURITIES]

    closes_by_symbol: dict[str, dict[str, float]] = {}
    for symbol, contract in wanted:
        closes_by_symbol[symbol] = fetch_minute_closes(
            helper, contract["security_id"], contract["segment"], contract["instrument"], now)
        if not closes_by_symbol[symbol] and symbol not in unresolved:
            unresolved.append(symbol)

    is_mcx = any(f["segment"] == "MCX_COMM" for f in fills) or \
        any(sp["segment"] == "MCX_COMM" for sp in starting_positions.values()) or \
        any(c["segment"] == "MCX_COMM" for c in resolved.values())
    start_h, start_m = SESSION_START_MCX if is_mcx else SESSION_START_FNO
    end_h, end_m = SESSION_END_MCX if is_mcx else SESSION_END_FNO
    start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
    end = min(now.replace(hour=end_h, minute=end_m, second=0, microsecond=0),
              now.replace(second=0, microsecond=0))
    # A fill stamped before the nominal open (or a clock skew) must not fall off the left edge.
    if fills:
        start = min(start, fills[0]["time"].replace(second=0, microsecond=0))
    if end < start:
        end = start

    points = build_points(fills, starting_positions, closes_by_symbol, build_minute_grid(start, end))
    emit({"success": True, "points": points, "unresolved": unresolved,
          "truncated": truncated, "error": None})


if __name__ == "__main__":
    main()
