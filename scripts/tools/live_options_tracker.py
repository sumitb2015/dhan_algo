"""
live_options_tracker.py
=======================
Advanced Excel-based live options monitoring and trading sheet.

Sheets:
  1. Live Options   — Input + live LTP, P&L, Greeks (Delta/Gamma/Theta/Vega), IV%, DTE, ATM Distance
  2. Dashboard      — KPI tiles (Net P&L, CE/PE exposure, positions count) + live positions table
  3. Options Chain  — Real-time Nifty ATM ±10 strike chain (CE | Strike | PE)
  4. Order Log      — Full audit trail of every order placed in this session

Fix applied: helper.WS_NSE / helper.WS_NSE_FNO do NOT exist on DhanHelper.
             Correct constants are on dhanhq.marketfeed.MarketFeed:
               MarketFeed.IDX     = 0  (Index feed for Nifty canary)
               MarketFeed.NSE     = 1
               MarketFeed.NSE_FNO = 2
               MarketFeed.Full    = 21 (Full packet with OI)
"""

import xlwings as xw
import time
import sys
import os
import math
import logging
import pandas as pd
from datetime import datetime, date, timedelta

# SDK imports
from dhanhq.marketfeed import MarketFeed

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Colour palette
# ---------------------------------------------------------------------------
NAVY        = (31,  73, 125)
WHITE       = (255, 255, 255)
LIGHT_GRAY  = (242, 243, 244)
DARK_GRAY   = (52,  73,  94)
PROFIT_GREEN= (0,  150,   0)
PROFIT_BG   = (220, 255, 220)
LOSS_RED    = (200,   0,   0)
LOSS_BG     = (255, 220, 220)
TEAL_BG     = (232, 246, 243)
RED_BG      = (253, 237, 236)
YELLOW_BG   = (255, 245, 157)
BLUE_HDR    = (41,  128, 185)
ORANGE_HDR  = (192,  57,  43)
SLATE       = (44,   62,  80)

# ---------------------------------------------------------------------------
# Black-Scholes helpers (pure Python — no scipy dependency)
# ---------------------------------------------------------------------------

def _f(val, default: float = 0.0) -> float:
    """
    Safely coerce a WebSocket field value to float.
    The Dhan SDK returns most numeric fields (LTP, open, high, low, close,
    avg_price …) as *formatted strings* like '"245.50"'.  We must call
    float() before doing any arithmetic.
    """
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _norm_cdf(x: float) -> float:
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)

def calc_iv(S: float, K: float, T: float, r: float,
            market_price: float, opt_type: str = "CE") -> float:
    """
    Newton-Raphson implied-volatility solver.
    Returns IV as a percentage (e.g. 18.5 means 18.5%).
    Returns 0 if it cannot converge.
    """
    if T <= 0 or market_price <= 0 or S <= 0 or K <= 0:
        return 0.0
    sigma = 0.30  # initial guess
    for _ in range(200):
        try:
            d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
            d2 = d1 - sigma * math.sqrt(T)
            if opt_type.upper() == "CE":
                price = S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
            else:
                price = K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)
            vega = S * _norm_pdf(d1) * math.sqrt(T)
            if vega < 1e-10:
                break
            diff = price - market_price
            sigma -= diff / vega
            if sigma <= 0:
                sigma = 1e-4
            if abs(diff) < 0.01:
                break
        except Exception:
            break
    return round(sigma * 100.0, 2)


def bs_greeks(S: float, K: float, T: float, r: float,
              sigma_pct: float, opt_type: str = "CE"):
    """
    Compute Black-Scholes Greeks.
    sigma_pct: IV as a percentage (e.g. 18.5)
    Returns: (delta, gamma, theta_per_day, vega_per_1pct)
    """
    sigma = sigma_pct / 100.0
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0, 0.0, 0.0, 0.0
    try:
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        d2 = d1 - sigma * math.sqrt(T)
        gamma = _norm_pdf(d1) / (S * sigma * math.sqrt(T))
        vega  = S * _norm_pdf(d1) * math.sqrt(T) / 100.0   # per 1% IV move
        if opt_type.upper() == "CE":
            delta = _norm_cdf(d1)
            theta = (-(S * _norm_pdf(d1) * sigma) / (2.0 * math.sqrt(T))
                     - r * K * math.exp(-r * T) * _norm_cdf(d2)) / 365.0
        else:
            delta = _norm_cdf(d1) - 1.0
            theta = (-(S * _norm_pdf(d1) * sigma) / (2.0 * math.sqrt(T))
                     + r * K * math.exp(-r * T) * _norm_cdf(-d2)) / 365.0
        return round(delta, 4), round(gamma, 6), round(theta, 2), round(vega, 2)
    except Exception:
        return 0.0, 0.0, 0.0, 0.0


def get_valid_expiries(helper, underlying: str = "NIFTY") -> list:
    """
    Return sorted list of real expiry date strings (YYYY-MM-DD) from the
    master list for the given underlying index options.
    """
    try:
        ml = helper._master_list
        mask = (
            (ml["UNDERLYING_SYMBOL"].str.upper() == underlying.upper()) &
            (ml["INSTRUMENT"] == "OPTIDX")
        )
        expiries = sorted(
            ml.loc[mask, "SM_EXPIRY_DATE"].dropna().unique().tolist()
        )
        # Only return future (or today's) expiries
        today_str = date.today().strftime("%Y-%m-%d")
        return [e for e in expiries if str(e) >= today_str]
    except Exception:
        return []


def snap_to_nearest_expiry(helper, expiry_str: str,
                            underlying: str = "NIFTY") -> str:
    """
    If expiry_str is not a valid expiry in the master list, return the
    nearest valid expiry date string on or after today. Otherwise return
    expiry_str unchanged.
    """
    valid = get_valid_expiries(helper, underlying)
    if not valid:
        return expiry_str
    if expiry_str in valid:
        return expiry_str
    # Pick nearest valid expiry >= requested date
    future = [e for e in valid if str(e) >= expiry_str]
    return future[0] if future else valid[0]

# ---------------------------------------------------------------------------
# Excel helper utilities
# ---------------------------------------------------------------------------

def apply_header(rng, bg=NAVY):
    rng.color = bg
    rng.font.color = WHITE
    rng.font.bold = True
    try:
        rng.api.HorizontalAlignment = -4108  # xlCenter
    except Exception:
        pass


def fmt_pnl(cell, pnl: float):
    if pnl > 0:
        cell.font.color = PROFIT_GREEN
        cell.color      = PROFIT_BG
    elif pnl < 0:
        cell.font.color = LOSS_RED
        cell.color      = LOSS_BG
    else:
        cell.font.color = (0, 0, 0)
        cell.color      = WHITE


def set_col_widths(sheet, mapping: dict):
    """mapping: {'A': 12, 'B:C': 9, ...}"""
    for col_spec, width in mapping.items():
        sheet.range(f"{col_spec}:{col_spec}").column_width = width

# ---------------------------------------------------------------------------
# Sheet setup functions
# ---------------------------------------------------------------------------

def setup_sheet1(wb) -> tuple:
    """
    Sheet 1 — Live Options

    Column layout (A → AD):
    ┌─ Inputs ────────────────────────────────────────────────────────────────┐
    │ A  Underlying │ B  Strike │ C  Type │ D  Expiry │ E  Action │ F  Lots  │
    │ G  Execute?   │ H  Exit?  │ I  Avg Price                               │
    ├─ Resolved ──────────────────────────────────────────────────────────────┤
    │ J  Trading Symbol │ K  Lot Size                                         │
    ├─ Live Data ─────────────────────────────────────────────────────────────┤
    │ L  LTP │ M  Total Value │ N  P&L                                       │
    ├─ Analytics ─────────────────────────────────────────────────────────────┤
    │ O  DTE │ P  ATM Dist │ Q  IV% │ R  Delta │ S  Gamma │ T  Theta │ U Vega│
    ├─ OHLC + Market ─────────────────────────────────────────────────────────┤
    │ V  Open │ W  High │ X  Low │ Y  Close │ Z  OI │ AA  Volume             │
    ├─ Order Feedback ────────────────────────────────────────────────────────┤
    │ AB  Order ID │ AC  Trade Msg │ AD  Status                              │
    └─────────────────────────────────────────────────────────────────────────┘
    """
    sheet = wb.sheets[0]
    sheet.name = "Live Options"
    try:
        sheet.api.Application.ActiveWindow.DisplayGridlines = False
    except Exception:
        pass

    sheet.range("A:AD").font.name = "Segoe UI"
    sheet.range("A:AD").font.size = 9

    # ── Row 1: Title + Nifty ticker ──────────────────────────────────────────
    sheet.range("A1:D1").merge()
    sheet.range("A1").value = "⚡  NIFTY OPTIONS LIVE TRACKER"
    sheet.range("A1").font.bold  = True
    sheet.range("A1").font.size  = 15
    sheet.range("A1").font.color = NAVY

    sheet.range("E1").value = "NIFTY SPOT:"
    sheet.range("E1").font.bold = True

    sheet.range("F1:H1").merge()
    sheet.range("F1").value      = "FETCHING…"
    sheet.range("F1").font.bold  = True
    sheet.range("F1").font.size  = 13

    sheet.range("I1").value = "ATM:"
    sheet.range("I1").font.bold = True
    sheet.range("J1").value = "—"
    sheet.range("J1").font.bold = True

    sheet.range("K1").value = "Market:"
    sheet.range("K1").font.bold = True
    sheet.range("L1").value = "—"

    sheet.range("N1").value = "Updated:"
    sheet.range("O1:P1").merge()
    sheet.range("O1").value = "—"

    sheet.range("A1:AD1").color = (240, 244, 248)
    sheet.range("1:1").row_height = 22

    # ── Row 2: separator ─────────────────────────────────────────────────────
    sheet.range("A2:AD2").color = NAVY

    # ── Row 3: Table headers ─────────────────────────────────────────────────
    HDR_ROW = 3
    headers = [
        # Inputs  A–I
        "Underlying", "Strike", "Type", "Expiry",
        "Action", "Lots", "Execute?", "Exit?", "Avg Price",
        # Resolved  J–K
        "Trading Symbol", "Lot Size",
        # Live Data  L–N
        "LTP", "Total Value", "P&L",
        # Analytics  O–U
        "DTE", "ATM Dist", "IV %", "Delta", "Gamma", "Theta", "Vega",
        # OHLC  V–AA
        "Open", "High", "Low", "Close", "OI", "Volume",
        # Orders  AB–AD
        "Order ID", "Trade Msg", "Status",
    ]
    sheet.range(f"A{HDR_ROW}").value = headers

    apply_header(sheet.range(f"A{HDR_ROW}:AD{HDR_ROW}"))
    sheet.range(f"A{HDR_ROW}:I{HDR_ROW}").color  = DARK_GRAY    # inputs
    sheet.range(f"J{HDR_ROW}:K{HDR_ROW}").color  = BLUE_HDR     # resolved
    sheet.range(f"L{HDR_ROW}:N{HDR_ROW}").color  = NAVY         # live data
    sheet.range(f"O{HDR_ROW}:U{HDR_ROW}").color  = (52, 152, 219) # analytics
    sheet.range(f"V{HDR_ROW}:AA{HDR_ROW}").color = SLATE        # OHLC
    sheet.range(f"AB{HDR_ROW}:AD{HDR_ROW}").color = (127, 140, 141) # orders
    sheet.range(f"{HDR_ROW}:{HDR_ROW}").row_height = 20

    # ── Column widths ─────────────────────────────────────────────────────────
    cw = {
        "A": 12, "B": 9,  "C": 6,  "D": 13, "E": 8,
        "F": 6,  "G": 9,  "H": 8,  "I": 10, "J": 26,
        "K": 9,  "L": 10, "M": 12, "N": 12, "O": 6,
        "P": 10, "Q": 8,  "R": 8,  "S": 8,  "T": 8,
        "U": 8,  "V": 10, "W": 10, "X": 10, "Y": 10,
        "Z": 12, "AA": 12,"AB": 16,"AC": 16,"AD": 12,
    }
    for col, width in cw.items():
        sheet.range(f"{col}:{col}").column_width = width

    # Pre-fill 2 default rows — expiry snapped to nearest valid date at runtime
    # (2026-06-23 is the nearest NSE weekly Thursday as of today)
    DATA_ROW = HDR_ROW + 1       # row 4
    defaults = [
        ["NIFTY", 24000, "CE", "2026-06-23", "SELL", 1, "", "", 0],
        ["NIFTY", 24000, "PE", "2026-06-23", "SELL", 1, "", "", 0],
    ]
    sheet.range(f"A{DATA_ROW}").value = defaults
    sheet.range(f"A{DATA_ROW}:I{DATA_ROW + 19}").color = LIGHT_GRAY

    # ── Freeze panes (keep rows 1–3 and columns A–B visible) ─────────────────
    try:
        sheet.api.Application.ActiveWindow.FreezePanes = False
        sheet.activate()
        sheet.range(f"C{DATA_ROW}").select()
        sheet.api.Application.ActiveWindow.FreezePanes = True
    except Exception:
        pass

    return sheet, HDR_ROW


def setup_dashboard(wb):
    """Sheet 2 — Portfolio Dashboard."""
    name = "Dashboard"
    if name not in [s.name for s in wb.sheets]:
        d = wb.sheets.add(name)
    else:
        d = wb.sheets[name]

    try:
        d.api.Application.ActiveWindow.DisplayGridlines = False
    except Exception:
        pass
    d.range("A:N").font.name = "Segoe UI"
    d.range("A:N").color = WHITE

    # Title
    d.range("A1:L1").merge()
    d.range("A1").value = "📊  TRADING PORTFOLIO DASHBOARD"
    d.range("A1").font.size  = 16
    d.range("A1").font.bold  = True
    d.range("A1").font.color = NAVY
    d.range("A1").color      = (240, 244, 248)
    d.range("1:1").row_height = 28

    # KPI tile definitions: (label_cell, label_text, value_cell, bg)
    tiles = [
        ("A3", "NET P&L",          "A4", (235, 245, 251)),
        ("C3", "CE TOTAL VALUE",   "C4", TEAL_BG),
        ("E3", "PE TOTAL VALUE",   "E4", RED_BG),
        ("G3", "GROSS EXPOSURE",   "G4", (253, 243, 226)),
        ("I3", "ACTIVE POSITIONS", "I4", (237, 234, 246)),
        ("K3", "MARKET STATUS",    "K4", (240, 244, 248)),
    ]
    for lc, lt, vc, bg in tiles:
        d.range(lc).value = lt
        d.range(lc).font.bold  = True
        d.range(lc).font.size  = 8
        d.range(lc).font.color = DARK_GRAY
        d.range(vc).value = "₹ —"
        d.range(vc).font.bold = True
        d.range(vc).font.size = 16
        # Shade 2-col × 3-row tile
        col_idx = ord(lc[0]) - ord('A')
        end_col = chr(ord(lc[0]) + 1)
        d.range(f"{lc[0]}3:{end_col}5").color = bg
        d.range("3:3").row_height = 14
        d.range("4:4").row_height = 24
        d.range("5:5").row_height = 10

    # Separator
    d.range("A6:L6").color = NAVY
    d.range("6:6").row_height = 4

    # Positions table (populated at runtime)
    d.range("A7").value      = "LIVE NET POSITIONS"
    d.range("A7").font.bold  = True
    d.range("A7").font.color = NAVY

    # Column widths
    for col, w in {"A": 22, "B": 12, "C": 10, "D": 10, "E": 10,
                   "F": 12, "G": 12, "H": 14, "I": 14}.items():
        d.range(f"{col}:{col}").column_width = w

    return d


def setup_options_chain(wb):
    """Sheet 3 — Live ATM ±10 Options Chain."""
    name = "Options Chain"
    if name not in [s.name for s in wb.sheets]:
        c = wb.sheets.add(name)
    else:
        c = wb.sheets[name]

    try:
        c.api.Application.ActiveWindow.DisplayGridlines = False
    except Exception:
        pass
    c.range("A:N").font.name = "Segoe UI"
    c.range("A:N").font.size = 9
    c.range("A:N").color = WHITE

    # Title
    c.range("A1:N1").merge()
    c.range("A1").value = "🔗  NIFTY OPTIONS CHAIN  —  ATM ± 10 Strikes"
    c.range("A1").font.size  = 13
    c.range("A1").font.bold  = True
    c.range("A1").font.color = NAVY
    c.range("A1").color      = (240, 244, 248)
    c.range("1:1").row_height = 22

    # Sub-info row
    for cell, label in [("A2","Spot:"),("D2","ATM:"),("G2","Expiry:"),("J2","Refreshed:")]:
        c.range(cell).value = label
        c.range(cell).font.bold = True
    c.range("B2").value = "—"
    c.range("E2").value = "—"
    c.range("H2").value = "—"
    c.range("K2").value = "—"
    c.range("A2:N2").color = LIGHT_GRAY

    # Chain column headers (Row 4)
    #   CE side (A-F) reversed so CE LTP is adjacent to Strike | Strike (G) | PE side (H-M) | Note (N)
    chain_hdrs = [
        "CE Chg", "CE Vol", "CE OI", "CE Delta", "CE IV%", "CE LTP",
        "STRIKE",
        "PE LTP", "PE IV%", "PE Delta", "PE OI", "PE Vol", "PE Chg",
        "Note",
    ]
    c.range("A4").value = chain_hdrs
    apply_header(c.range("A4:N4"))
    c.range("A4:F4").color = BLUE_HDR    # CE = blue
    c.range("G4").color    = SLATE       # Strike = dark
    c.range("H4:M4").color = ORANGE_HDR  # PE = red-orange
    c.range("N4").color    = DARK_GRAY
    c.range("4:4").row_height = 18

    # Column widths
    for col, w in {"A": 9, "B": 8, "C": 8, "D": 11, "E": 10, "F": 9,
                   "G": 11, "H": 9, "I": 8, "J": 8, "K": 11, "L": 10,
                   "M": 9, "N": 8}.items():
        c.range(f"{col}:{col}").column_width = w

    return c


def setup_order_log(wb) -> tuple:
    """Sheet 4 — Order audit log. Returns (sheet, next_log_row)."""
    name = "Order Log"
    if name not in [s.name for s in wb.sheets]:
        o = wb.sheets.add(name)
    else:
        o = wb.sheets[name]

    try:
        o.api.Application.ActiveWindow.DisplayGridlines = False
    except Exception:
        pass
    o.range("A:K").font.name = "Segoe UI"
    o.range("A:K").font.size = 9
    o.range("A:K").color = WHITE

    # Title
    o.range("A1:K1").merge()
    o.range("A1").value = "📋  ORDER AUDIT LOG  —  Session"
    o.range("A1").font.size  = 13
    o.range("A1").font.bold  = True
    o.range("A1").font.color = NAVY
    o.range("A1").color      = (240, 244, 248)
    o.range("1:1").row_height = 22

    log_hdrs = ["Timestamp", "Symbol", "Action", "Qty", "Lots",
                "Price at Order", "Order ID", "Status", "Message",
                "Session P&L", "Note"]
    o.range("A3").value = log_hdrs
    apply_header(o.range("A3:K3"))

    for col, w in {"A": 20, "B": 26, "C": 8, "D": 7, "E": 6,
                   "F": 14, "G": 16, "H": 10, "I": 25, "J": 13, "K": 14}.items():
        o.range(f"{col}:{col}").column_width = w

    return o, 4   # data starts at row 4

# ---------------------------------------------------------------------------
# Main tracker loop
# ---------------------------------------------------------------------------

def run_live_tracker():
    """
    Main entry point. Opens Excel, sets up 4 sheets, starts WebSocket,
    then loops updating live data every 0.5 s.
    """
    # ── 1. Dhan connection ────────────────────────────────────────────────────
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to connect to Dhan.")
        return
    helper = DhanHelper(dhan)

    # ── 2. Excel workbook ────────────────────────────────────────────────────
    logger.info("Opening Excel workbook…")
    wb = xw.Book()

    sheet,   HDR_ROW          = setup_sheet1(wb)
    d_sheet                   = setup_dashboard(wb)
    c_sheet                   = setup_options_chain(wb)
    o_sheet, order_log_row    = setup_order_log(wb)

    DATA_ROW   = HDR_ROW + 1   # first data row in Sheet 1
    MAX_ROWS   = 20             # max option legs to track
    RISK_FREE  = 0.065          # India ~6.5% risk-free rate

    # ── 3. Internal state ─────────────────────────────────────────────────────
    row_to_sid:     dict = {}   # row_idx → security_id str
    row_input_cache:dict = {}   # row_idx → input_key str
    subscribed_sids:set  = set()

    last_ui_update   = 0.0
    last_fallback    = 0.0
    last_heartbeat   = 0.0
    nifty_spot       = 0.0
    last_nifty_spot  = 0.0
    nifty_prev_close = 0.0   # fetched once at startup via get_prev_day_levels

    # ── 4. WebSocket — Nifty Index as canary ─────────────────────────────────
    # MarketFeed.IDX = 0  (index segment), security_id "13" = Nifty 50
    logger.info("Starting WebSocket (Nifty Index canary, IDX/13)…")
    helper.start_websocket(
        [(MarketFeed.IDX, "13", MarketFeed.Ticker)],
        on_message=lambda instance, data: None
    )

    # ── 4b. Fetch yesterday's Nifty close (per GEMINI.md: use get_prev_day_levels) ─
    logger.info("Fetching Nifty previous-day close for % change display…")
    try:
        _levels = helper.get_prev_day_levels("NIFTY")
        if _levels and _levels.get("close", 0) > 0:
            nifty_prev_close = float(_levels["close"])
            logger.info(f"Nifty PDC fetched: {nifty_prev_close:,.2f}")
        else:
            logger.warning("get_prev_day_levels returned no data; % change will use WS prev_close fallback.")
    except Exception as _e:
        logger.warning(f"Could not fetch Nifty PDC: {_e}")

    # ── 5. Main loop ──────────────────────────────────────────────────────────
    try:
        logger.info("Live tracker running. Press Ctrl+C to stop.")
        while True:
            try:
                is_open  = helper.is_market_open()
                now_ts   = time.time()
                now_str  = datetime.now().strftime("%H:%M:%S")

                # Heartbeat log every 30 s
                if now_ts - last_heartbeat > 30:
                    logger.info(
                        f"Active | Legs: {len(row_to_sid)} | "
                        f"WS points: {len(helper.live_data)} | "
                        f"Market: {'Open' if is_open else 'Closed'}"
                    )
                    last_heartbeat = now_ts

                # ==============================================================
                # PHASE A — Nifty spot price
                # ==============================================================
                nifty_ws = helper.live_data.get("13")
                if nifty_ws:
                    n_ltp = _f(nifty_ws.get("LTP")) or _f(nifty_ws.get("last_price"))
                else:
                    # Per GEMINI.md: use get_ltp() with exchange="IDX_I", instrument="INDEX"
                    n_ltp = helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")

                # Use startup-fetched PDC first; fall back to live WS prev_close field
                n_close = nifty_prev_close
                if n_close == 0 and nifty_ws:
                    n_close = (_f(nifty_ws.get("prev_close"))
                               or _f(nifty_ws.get("close"))
                               or _f((nifty_ws.get("ohlc") or {}).get("close")))

                if n_ltp > 0:
                    nifty_spot = n_ltp
                    n_chg  = n_ltp - n_close if n_close > 0 else 0
                    n_pct  = (n_chg / n_close * 100) if n_close > 0 else 0
                    color  = PROFIT_GREEN if n_chg >= 0 else LOSS_RED
                    atm_strike = round(n_ltp / 50) * 50

                    sheet.range("F1").value      = (
                        f"{n_ltp:,.2f}   ({n_chg:+.2f}  {n_pct:+.2f}%)"
                    )
                    sheet.range("F1").font.color = color
                    sheet.range("J1").value      = f"{atm_strike:,.0f}"
                    sheet.range("L1").value      = ("🟢 Open" if is_open
                                                     else "🔴 Closed")
                    sheet.range("O1").value      = now_str

                    if nifty_spot != last_nifty_spot:
                        logger.info(f"Nifty Spot Tick: {nifty_spot:,.2f} ({n_chg:+.2f}  {n_pct:+.2f}%)")
                        last_nifty_spot = nifty_spot

                # ==============================================================
                # PHASE B — Input processing + order placement
                # ==============================================================
                raw_inputs = sheet.range(
                    f"A{DATA_ROW}:I{DATA_ROW + MAX_ROWS - 1}"
                ).value

                for idx, row in enumerate(raw_inputs):
                    row_idx = idx + DATA_ROW
                    (underlying, strike, opt_type, expiry_raw,
                     action, lots, execute, exit_trigger, avg_price) = row

                    # Skip empty rows
                    if not (underlying and strike and opt_type and expiry_raw):
                        if row_idx in row_to_sid:
                            row_to_sid.pop(row_idx, None)
                            row_input_cache.pop(row_idx, None)
                        continue

                    # Validate strike is numeric
                    try:
                        strike_val = float(strike)
                    except (ValueError, TypeError):
                        continue

                    # Normalise expiry to YYYY-MM-DD
                    expiry = str(expiry_raw)
                    try:
                        if isinstance(expiry_raw, datetime):
                            expiry = expiry_raw.strftime("%Y-%m-%d")
                        elif "-" in expiry:
                            parts = expiry.split(" ")[0].split("-")
                            if len(parts[0]) == 4:
                                expiry = f"{parts[0]}-{parts[1]}-{parts[2]}"
                            else:
                                expiry = f"{parts[2]}-{parts[1]}-{parts[0]}"
                    except Exception:
                        pass

                    input_key = f"{underlying}_{int(strike_val)}_{opt_type}_{expiry}"

                    # Resolve option if input changed
                    if row_input_cache.get(row_idx) != input_key:
                        # Temporarily silence 'No matches' INFO logs from dhan_helper
                        _dh_log = logging.getLogger("lib.dhan_helper")
                        _prev_level = _dh_log.level
                        _dh_log.setLevel(logging.WARNING)
                        opt = helper.get_option_id(
                            str(underlying).upper(), strike_val,
                            str(opt_type).upper(), expiry
                        )
                        # Fallback: if not found, try nearest valid expiry
                        snapped_expiry = expiry
                        if opt is None:
                            snapped_expiry = snap_to_nearest_expiry(
                                helper, expiry, str(underlying).upper()
                            )
                            if snapped_expiry != expiry:
                                opt = helper.get_option_id(
                                    str(underlying).upper(), strike_val,
                                    str(opt_type).upper(), snapped_expiry
                                )
                                if opt:
                                    logger.info(
                                        f"Row {row_idx}: Expiry snapped "
                                        f"{expiry} → {snapped_expiry}"
                                    )
                        _dh_log.setLevel(_prev_level)
                        if opt:
                            sid = str(opt["SECURITY_ID"])
                            row_to_sid[row_idx]    = sid
                            row_input_cache[row_idx] = input_key

                            lot_size = helper.get_lot_size(sid)
                            sheet.range(f"J{row_idx}").value = opt["SYMBOL_NAME"]
                            sheet.range(f"K{row_idx}").value = lot_size

                            # DTE
                            try:
                                exp_date = datetime.strptime(expiry, "%Y-%m-%d").date()
                                dte = (exp_date - date.today()).days
                                sheet.range(f"O{row_idx}").value = max(dte, 0)
                            except Exception:
                                pass

                            # Subscribe to WebSocket
                            if sid not in subscribed_sids:
                                helper.subscribe_instruments(
                                    [(MarketFeed.NSE_FNO, sid, MarketFeed.Full)]
                                )
                                subscribed_sids.add(sid)
                        else:
                            sheet.range(f"J{row_idx}").value = "❌ NOT FOUND"
                            continue

                    sid = row_to_sid.get(row_idx)
                    if not sid:
                        continue

                    # ATM distance (live, updates every loop)
                    if nifty_spot > 0:
                        sheet.range(f"P{row_idx}").value = round(
                            strike_val - nifty_spot, 2
                        )

                    # Order placement logic
                    final_action = None
                    if str(exit_trigger).upper() == "YES":
                        final_action = "SELL" if str(action).upper() == "BUY" else "BUY"
                        sheet.range(f"H{row_idx}").value = "⏳ EXITING…"
                    elif str(execute).upper() == "YES":
                        final_action = str(action).upper()
                        sheet.range(f"G{row_idx}").value = "⏳ PLACING…"

                    if final_action:
                        ls   = sheet.range(f"K{row_idx}").value or 0
                        tqty = int((lots or 0) * ls)
                        if tqty > 0:
                            ltp_now = sheet.range(f"L{row_idx}").value or 0
                            sym_now = sheet.range(f"J{row_idx}").value or ""
                            oid = helper.place_order(
                                sid, helper.NSE_FNO, final_action,
                                tqty, helper.MARKET, helper.INTRA
                            )
                            if oid:
                                sheet.range(f"AB{row_idx}").value = oid
                                sheet.range(f"AC{row_idx}").value = "✅ SUCCESS"
                                # Record avg price on BUY execution
                                if str(execute).upper() == "YES":
                                    sheet.range(f"I{row_idx}").value = ltp_now

                                # Audit log entry
                                o_sheet.range(f"A{order_log_row}").value = [
                                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                    sym_now, final_action, tqty, int(lots or 0),
                                    ltp_now, oid, "SUCCESS", "", "", ""
                                ]
                                clr = TEAL_BG if final_action == "BUY" else RED_BG
                                o_sheet.range(f"A{order_log_row}:K{order_log_row}").color = clr
                                order_log_row += 1

                        sheet.range(f"G{row_idx}:H{row_idx}").value = ""

                # ==============================================================
                # PHASE C — Fetch missing data via REST fallback (max 1 req / 2 s)
                # ==============================================================
                active_sids  = list(row_to_sid.values())
                missing_sids = [s for s in active_sids if s not in helper.live_data]
                fallback_data: dict = {}
                if missing_sids and (now_ts - last_fallback > 2.0):
                    fallback_data = helper.get_quote_data(
                        {"NSE_FNO": [int(s) for s in missing_sids]}
                    )
                    last_fallback = now_ts

                # ==============================================================
                # PHASE D — Update Sheet 1 rows (LTP, P&L, Greeks)
                # ==============================================================
                for row_idx, sid in row_to_sid.items():
                    # Prefer WebSocket; fall back to REST snapshot
                    data = helper.live_data.get(sid)
                    if not data:
                        for seg in fallback_data.values():
                            if sid in seg:
                                data = seg[sid]
                                break

                    if not data:
                        sheet.range(f"AD{row_idx}").value = "⏳ Waiting…"
                        continue

                    ltp  = _f(data.get("LTP")) or _f(data.get("last_price"))
                    ohlc = data.get("ohlc") or {}

                    avg_p     = float(sheet.range(f"I{row_idx}").value or 0)
                    lots_val  = float(sheet.range(f"F{row_idx}").value or 0)
                    ls        = float(sheet.range(f"K{row_idx}").value or 0)
                    act       = str(sheet.range(f"E{row_idx}").value or "").upper()
                    str_val   = float(sheet.range(f"B{row_idx}").value or 0)
                    o_type    = str(sheet.range(f"C{row_idx}").value or "CE").upper()
                    dte_val   = float(sheet.range(f"O{row_idx}").value or 0)

                    # P&L
                    t_val = round(lots_val * ls * ltp, 2)
                    pnl   = 0.0
                    if avg_p > 0 and lots_val > 0 and ls > 0:
                        if act == "BUY":
                            pnl = round((ltp - avg_p) * lots_val * ls, 2)
                        elif act == "SELL":
                            pnl = round((avg_p - ltp) * lots_val * ls, 2)

                    # Trend arrow
                    prev_ltp = float(sheet.range(f"L{row_idx}").value or 0)
                    arrow    = "▲" if ltp > prev_ltp else "▼"

                    # Greeks & IV
                    iv_pct = 0.0
                    delta = gamma = theta = vega = 0.0
                    if nifty_spot > 0 and str_val > 0 and ltp > 0:
                        try:
                            T = max(dte_val, 0.5) / 365.0
                            iv_pct = calc_iv(nifty_spot, str_val, T, RISK_FREE, ltp, o_type)
                            if iv_pct > 0:
                                delta, gamma, theta, vega = bs_greeks(
                                    nifty_spot, str_val, T, RISK_FREE, iv_pct, o_type
                                )
                        except Exception:
                            pass

                    # OHLC — SDK returns these as formatted strings; use _f() to convert
                    ws_open  = _f(data.get("open"))  or _f(ohlc.get("open"))
                    ws_high  = _f(data.get("high"))  or _f(ohlc.get("high"))
                    ws_low   = _f(data.get("low"))   or _f(ohlc.get("low"))
                    ws_close = _f(data.get("close")) or _f(ohlc.get("close")) or _f(data.get("prev_close"))
                    ws_oi    = int(data.get("OI", 0) or data.get("oi", 0) or 0)
                    ws_vol   = int(data.get("volume", 0) or 0)

                    # Write to sheet — individual cell writes for smooth in-place update
                    sheet.range(f"L{row_idx}").value = ltp
                    sheet.range(f"M{row_idx}").value = t_val
                    sheet.range(f"N{row_idx}").value = pnl
                    sheet.range(f"Q{row_idx}").value = iv_pct or None
                    sheet.range(f"R{row_idx}").value = delta  or None
                    sheet.range(f"S{row_idx}").value = gamma  or None
                    sheet.range(f"T{row_idx}").value = theta  or None
                    sheet.range(f"U{row_idx}").value = vega   or None
                    sheet.range(f"V{row_idx}:AA{row_idx}").value = [
                        ws_open  or None,
                        ws_high  or None,
                        ws_low   or None,
                        ws_close or None,
                        ws_oi    or None,
                        ws_vol   or None,
                    ]
                    sheet.range(f"AD{row_idx}").value = (
                        f"{arrow} {'Live' if sid in helper.live_data else 'Snap'}"
                    )

                    # Colour-code P&L cell
                    fmt_pnl(sheet.range(f"N{row_idx}"), pnl)

                # ==============================================================
                # PHASE E — Dashboard & Options Chain (every 5 s)
                # ==============================================================
                if now_ts - last_ui_update > 5.0:

                    # ── Dashboard ──────────────────────────────────────────────
                    try:
                        df_pos = helper.get_positions()
                        if df_pos is not None and not df_pos.empty:
                            pos_sids_int = [int(s) for s in df_pos["securityId"].tolist()]
                            pos_quotes   = helper.get_quote_data({"NSE_FNO": pos_sids_int})

                            def _get_price(row):
                                s = str(row["securityId"])
                                d = helper.live_data.get(s)
                                if not d:
                                    for seg in pos_quotes.values():
                                        if s in seg:
                                            d = seg[s]
                                            break
                                if d:
                                    return (d.get("LTP", 0) or d.get("last_price", 0)
                                            or d.get("ohlc", {}).get("close", 0))
                                return float(row.get("lastTradedPrice", 0)
                                             or row.get("drvLastPrice", 0) or 0)

                            df_pos["lastPrice"]       = df_pos.apply(_get_price, axis=1)
                            df_pos["unrealizedProfit"]= (
                                (df_pos["lastPrice"] - df_pos["costPrice"]) * df_pos["netQty"]
                            )
                            df_pos["totalValue"]      = (
                                df_pos["netQty"] * df_pos["lastPrice"]
                            ).abs()

                            def _opt_side(sym):
                                s = str(sym).strip().upper()
                                if s.endswith("CE") or "CALL" in s: return "CE"
                                if s.endswith("PE") or "PUT"  in s: return "PE"
                                return "OTHER"

                            df_pos["side"] = df_pos["tradingSymbol"].apply(_opt_side)
                            ce_val   = df_pos[df_pos["side"] == "CE"]["totalValue"].sum()
                            pe_val   = df_pos[df_pos["side"] == "PE"]["totalValue"].sum()
                            total_exp= df_pos["totalValue"].sum()
                            active_n = len(df_pos[df_pos["netQty"] != 0])
                            real_pnl = df_pos.get("realizedProfit", pd.Series([0.0])).sum()
                            total_pnl= df_pos["unrealizedProfit"].sum() + real_pnl

                            # Update KPI tiles
                            d_sheet.range("A4").value      = f"₹ {total_pnl:+,.2f}"
                            d_sheet.range("A4").font.color = (
                                PROFIT_GREEN if total_pnl > 0
                                else (LOSS_RED if total_pnl < 0 else (0,0,0))
                            )
                            d_sheet.range("C4").value = f"₹ {ce_val:,.2f}"
                            d_sheet.range("E4").value = f"₹ {pe_val:,.2f}"
                            d_sheet.range("G4").value = f"₹ {total_exp:,.2f}"
                            d_sheet.range("I4").value = str(active_n)
                            d_sheet.range("K4").value = ("🟢 Open"
                                                          if is_open else "🔴 Closed")

                            # Positions table
                            pos_cols = [
                                "tradingSymbol", "positionType", "netQty",
                                "buyAvg", "sellAvg", "lastPrice",
                                "totalValue", "realizedProfit", "unrealizedProfit",
                            ]
                            avail = [c for c in pos_cols if c in df_pos.columns]
                            last_col = chr(ord("A") + len(avail) - 1)

                            d_sheet.range(f"A8:{last_col}200").clear_contents()
                            d_sheet.range(f"A8:{last_col}200").color = WHITE

                            d_sheet.range("A8").value = avail
                            apply_header(d_sheet.range(f"A8:{last_col}8"), bg=DARK_GRAY)

                            if not df_pos.empty:
                                d_sheet.range("A9").value = df_pos[avail].values.tolist()
                                for r in range(9, 9 + len(df_pos)):
                                    if r % 2 == 0:
                                        d_sheet.range(f"A{r}:{last_col}{r}").color = LIGHT_GRAY
                                    if "unrealizedProfit" in avail:
                                        u_col = chr(ord("A") + avail.index("unrealizedProfit"))
                                        pnl_v = df_pos.iloc[r - 9]["unrealizedProfit"] if (r-9) < len(df_pos) else 0
                                        fmt_pnl(d_sheet.range(f"{u_col}{r}"), pnl_v)

                    except Exception as dash_err:
                        logger.warning(f"Dashboard update skipped: {dash_err}")

                    # ── Options Chain ──────────────────────────────────────────
                    try:
                        if nifty_spot > 0:
                            atm_strike = round(nifty_spot / 50) * 50
                            valid_expiries = get_valid_expiries(helper, "NIFTY")
                            expiry_str = valid_expiries[0] if valid_expiries else date.today().strftime("%Y-%m-%d")
                            try:
                                exp_date_obj = datetime.strptime(expiry_str, "%Y-%m-%d").date()
                                days_left = (exp_date_obj - date.today()).days
                            except Exception:
                                days_left = 7
                            T_chain = max(days_left, 0.5) / 365.0

                            strikes = [atm_strike + i * 50 for i in range(-10, 11)]  # 21 rows

                            # ── Build the entire 21×14 grid in Python first ────────
                            # Collect data for every strike without touching Excel.
                            # Subscriptions for new SIDs are also registered here so
                            # no COM calls are made inside the strike loop.
                            _dh_log = logging.getLogger("lib.dhan_helper")
                            _dh_log.setLevel(logging.WARNING)

                            grid      = []   # 21 rows × 14 cols
                            atm_row   = None # 0-based index within grid
                            chg_data  = []   # (row_idx, ce_chg, pe_chg) for colour pass

                            for i, sk in enumerate(strikes):
                                is_atm = (sk == atm_strike)
                                if is_atm:
                                    atm_row = i

                                ce_opt = helper.get_option_id("NIFTY", sk, "CE", expiry_str)
                                pe_opt = helper.get_option_id("NIFTY", sk, "PE", expiry_str)

                                ce_d, pe_d = {}, {}

                                if ce_opt:
                                    ce_sid = str(ce_opt["SECURITY_ID"])
                                    ce_d   = helper.live_data.get(ce_sid) or {}
                                    if not ce_d and ce_sid not in subscribed_sids:
                                        helper.subscribe_instruments(
                                            [(MarketFeed.NSE_FNO, ce_sid, MarketFeed.Full)]
                                        )
                                        subscribed_sids.add(ce_sid)

                                if pe_opt:
                                    pe_sid = str(pe_opt["SECURITY_ID"])
                                    pe_d   = helper.live_data.get(pe_sid) or {}
                                    if not pe_d and pe_sid not in subscribed_sids:
                                        helper.subscribe_instruments(
                                            [(MarketFeed.NSE_FNO, pe_sid, MarketFeed.Full)]
                                        )
                                        subscribed_sids.add(pe_sid)

                                ce_ltp = _f(ce_d.get("LTP")) or _f(ce_d.get("last_price"))
                                pe_ltp = _f(pe_d.get("LTP")) or _f(pe_d.get("last_price"))
                                ce_oi  = int(ce_d.get("OI", 0) or ce_d.get("oi", 0) or 0)
                                pe_oi  = int(pe_d.get("OI", 0) or pe_d.get("oi", 0) or 0)
                                ce_vol = int(ce_d.get("volume", 0) or 0)
                                pe_vol = int(pe_d.get("volume", 0) or 0)

                                ce_iv  = calc_iv(nifty_spot, sk, T_chain, RISK_FREE, ce_ltp, "CE") if ce_ltp > 0 else 0
                                pe_iv  = calc_iv(nifty_spot, sk, T_chain, RISK_FREE, pe_ltp, "PE") if pe_ltp > 0 else 0
                                ce_del = bs_greeks(nifty_spot, sk, T_chain, RISK_FREE, ce_iv, "CE")[0] if ce_iv > 0 else 0
                                pe_del = bs_greeks(nifty_spot, sk, T_chain, RISK_FREE, pe_iv, "PE")[0] if pe_iv > 0 else 0

                                ce_prev = _f(ce_d.get("prev_close")) or _f((ce_d.get("ohlc") or {}).get("close")) or ce_ltp
                                pe_prev = _f(pe_d.get("prev_close")) or _f((pe_d.get("ohlc") or {}).get("close")) or pe_ltp
                                ce_chg  = round(ce_ltp - ce_prev, 2) if ce_ltp > 0 else 0
                                pe_chg  = round(pe_ltp - pe_prev, 2) if pe_ltp > 0 else 0

                                grid.append([
                                    # CE side reversed — CE LTP sits next to Strike (col G)
                                    ce_chg or None, ce_vol or None, ce_oi  or None,
                                    ce_del or None, ce_iv  or None, ce_ltp or None,
                                    sk,
                                    pe_ltp or None, pe_iv  or None, pe_del or None,
                                    pe_oi  or None, pe_vol or None, pe_chg or None,
                                    "◀ ATM" if is_atm else "",
                                ])
                                chg_data.append((i, ce_chg, pe_chg))

                            _dh_log.setLevel(logging.INFO)

                            # ── COM call 1: write header cells ─────────────────────
                            c_sheet.range("B2").value = f"{nifty_spot:,.2f}"
                            c_sheet.range("E2").value = f"{atm_strike:,.0f}"
                            c_sheet.range("H2").value = expiry_str
                            c_sheet.range("K2").value = now_str

                            # ── COM call 2: dump the entire 21×14 grid atomically ──
                            FIRST_ROW = 5
                            LAST_ROW  = FIRST_ROW + len(strikes) - 1   # row 25
                            c_sheet.range(f"A{FIRST_ROW}:N{LAST_ROW}").value = grid

                            # ── COM call 3: reset all background colours ────────────
                            c_sheet.range(f"A{FIRST_ROW}:N{LAST_ROW}").color = WHITE

                            # ── COM call 4: strike column always light-gray ─────────
                            c_sheet.range(f"G{FIRST_ROW}:G{LAST_ROW}").color      = LIGHT_GRAY
                            c_sheet.range(f"G{FIRST_ROW}:G{LAST_ROW}").font.color = DARK_GRAY

                            # ── COM call 5: ATM row highlight ──────────────────────
                            if atm_row is not None:
                                atm_xl = FIRST_ROW + atm_row
                                c_sheet.range(f"A{atm_xl}:N{atm_xl}").color = YELLOW_BG
                                c_sheet.range(f"G{atm_xl}").font.bold  = True
                                c_sheet.range(f"G{atm_xl}").font.color = NAVY

                            # ── COM call 6: change-cell font colours (A and M cols) ─
                            # CE Chg is now col A (reversed layout); PE Chg stays col M.
                            ce_green, ce_red, pe_green, pe_red = [], [], [], []
                            for i, ce_chg, pe_chg in chg_data:
                                xl_r = FIRST_ROW + i
                                if ce_chg > 0:   ce_green.append(f"A{xl_r}")
                                elif ce_chg < 0: ce_red.append(f"A{xl_r}")
                                if pe_chg > 0:   pe_green.append(f"M{xl_r}")
                                elif pe_chg < 0: pe_red.append(f"M{xl_r}")

                            def _set_font_color(cells, color):
                                if not cells:
                                    return
                                # Build a union address and set in one COM call
                                addr = ",".join(cells)
                                try:
                                    c_sheet.range(addr).font.color = color
                                except Exception:
                                    for c in cells:
                                        c_sheet.range(c).font.color = color

                            _set_font_color(ce_green, PROFIT_GREEN)
                            _set_font_color(ce_red,   LOSS_RED)
                            _set_font_color(pe_green, PROFIT_GREEN)
                            _set_font_color(pe_red,   LOSS_RED)

                    except Exception as chain_err:
                        logger.warning(f"Options chain update skipped: {chain_err}")

                    last_ui_update = now_ts

                # ── end of 5-s block ──────────────────────────────────────────
                time.sleep(0.5)

            except Exception as loop_err:
                # Suppress Excel COM automation errors (-2147352567)
                if "-2147352567" not in str(loop_err):
                    logger.error(f"Loop error: {loop_err}")
                time.sleep(2)

    finally:
        logger.info("Tracker stopped.")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    run_live_tracker()
