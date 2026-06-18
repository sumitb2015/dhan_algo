import xlwings as xw
import time
import sys
import os
import logging
import pandas as pd
from datetime import datetime

# Add parent directory to path to import login and lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- STYLING CONSTANTS ---
NAVY = (44, 62, 80)
WHITE = (255, 255, 255)
LIGHT_GRAY = (242, 243, 244)
DARK_GRAY = (52, 73, 94)
PROFIT_GREEN = (0, 150, 0)
PROFIT_BG = (220, 255, 220)
LOSS_RED = (200, 0, 0)
LOSS_BG = (255, 220, 220)

def apply_pro_header(range_obj):
    range_obj.color = NAVY
    range_obj.font.color = WHITE
    range_obj.font.bold = True
    range_obj.api.HorizontalAlignment = -4108 # Center

def run_live_tracker():
    """
    STABLE VERSION: 3-Sheets + Exit Column (H) + Intraday Trading
    Includes Professional Grade Styling and Cumulative Exposure.
    """
    # 1. Initialize Dhan
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to connect to Dhan.")
        return
    helper = DhanHelper(dhan)
    
    # 2. Initialize Excel
    logger.info("Opening Excel...")
    wb = xw.Book()
    
    # Global Settings: Remove gridlines and set font
    for s in wb.sheets:
        s.api.Application.ActiveWindow.DisplayGridlines = False
        s.range("A:Z").font.name = "Segoe UI"
        s.range("A:Z").font.size = 10
    
    # --- SHEET 1: LIVE OPTIONS ---
    sheet = wb.sheets[0]
    sheet.name = "Live Options"
    
    # Nifty Spot Header
    sheet.range("A1").value = "NIFTY 50"
    sheet.range("A1").font.bold = True
    sheet.range("A1").font.size = 14
    sheet.range("A1").font.color = NAVY
    sheet.range("B1").value = "FETCHING..."
    sheet.range("B1").font.size = 14
    sheet.range("B1").font.bold = True
    
    # Shift table down to row 4
    start_row = 4
    headers = [
        "Underlying", "Strike", "Type", "Expiry", 
        "Action", "Lots", "Execute?", "Exit?", "Avg Price",    # Inputs
        "Trading Symbol", "Lot Size", "LTP", "Total Value", "PnL", # Data
        "Open", "High", "Low", "Close", "OI", "Volume",        # Stats
        "Order ID", "Trade Msg", "Status"                      # Feedback
    ]
    sheet.range(f"A{start_row}").value = headers
    apply_pro_header(sheet.range(f"A{start_row}:W{start_row}"))
    
    # Group Coloring (Inputs vs Outputs)
    sheet.range(f"A{start_row}:I{start_row}").color = DARK_GRAY 
    sheet.range(f"J{start_row}:N{start_row}").color = NAVY      
    
    sheet.range("A:W").column_width = 12
    sheet.range("D:D").column_width = 15
    sheet.range("J:J").column_width = 25
    sheet.range("V:W").column_width = 15

    # Pre-fill defaults (Starting from start_row + 1)
    defaults = [
        ["NIFTY", 23000, "CE", "2026-06-30", "BUY", 1, "", "", 0],
        ["NIFTY", 23000, "PE", "2026-06-30", "SELL", 1, "", "", 0],
    ]
    sheet.range(f"A{start_row+1}").value = defaults
    sheet.range(f"A{start_row+1}:I{start_row+20}").color = LIGHT_GRAY 

    # --- SHEET 2: DASHBOARD ---
    if "Dashboard" not in [s.name for s in wb.sheets]: d_sheet = wb.sheets.add("Dashboard")
    else: d_sheet = wb.sheets["Dashboard"]
    d_sheet.range("A:Z").color = WHITE

    # --- SHEET 3: OPTIONS SUMMARY ---
    if "Options Summary" not in [s.name for s in wb.sheets]: s_sheet = wb.sheets.add("Options Summary")
    else: s_sheet = wb.sheets["Options Summary"]
    s_sheet.range("A:Z").color = WHITE

    # Internal state
    row_to_sid, row_input_cache, subscribed_sids = {}, {}, set()
    last_ui_update, last_fallback, last_heartbeat = 0, 0, 0
    
    logger.info("Connecting to WebSocket with HDFC Canary...")
    helper.start_websocket([(helper.WS_NSE, 1333, 15)], on_message=lambda instance, data: None)
    
    try:
        logger.info("Live dynamic trading started. Press Ctrl+C to stop.")
        while True:
            try:
                is_open = helper.is_market_open()
                now_ts = time.time()
                
                if now_ts - last_heartbeat > 30:
                    logger.info(f"Tracker Active. Active SIDs: {len(row_to_sid)} | WebSocket Data: {len(helper.live_data)}")
                    last_heartbeat = now_ts

                # --- PHASE 1: INPUT PROCESSING & TRADING ---
                # Data starts from start_row + 1 (Row 5)
                data_start = start_row + 1
                input_data = sheet.range(f"A{data_start}:I{data_start + 19}").value
                
                for idx, row in enumerate(input_data):
                    row_idx = idx + data_start
                    underlying, strike, opt_type, expiry_raw, action, lots, execute, exit_trigger, avg_price = row
                    if not (underlying and strike and opt_type and expiry_raw): 
                        if row_idx in row_to_sid: row_to_sid.pop(row_idx, None); row_input_cache.pop(row_idx, None)
                        continue
                    
                    # Safety check for non-numeric strike (like headers)
                    try:
                        strike_val = float(strike)
                    except (ValueError, TypeError):
                        continue
                        
                    input_key = f"{underlying}_{strike}_{opt_type}_{expiry_raw}"
                    if row_input_cache.get(row_idx) != input_key:
                        expiry = str(expiry_raw)
                        try:
                            if isinstance(expiry_raw, datetime): expiry = expiry_raw.strftime("%Y-%m-%d")
                            elif "-" in expiry:
                                parts = expiry.split(' ')[0].split('-')
                                expiry = f"{parts[0]}-{parts[1]}-{parts[2]}" if len(parts[0]) == 4 else f"{parts[2]}-{parts[1]}-{parts[0]}"
                        except: pass
                        
                        opt = helper.get_option_id(str(underlying).upper(), strike_val, str(opt_type).upper(), expiry, quiet=True)
                        if opt:
                            sid = str(opt['SECURITY_ID'])
                            row_to_sid[row_idx], row_input_cache[row_idx] = sid, input_key
                            sheet.range(f"J{row_idx}").value = opt['SYMBOL_NAME']
                            sheet.range(f"K{row_idx}").value = helper.get_lot_size(sid) 
                            if sid not in subscribed_sids:
                                helper.subscribe_instruments([(helper.WS_NSE_FNO, sid, 21)])
                                subscribed_sids.add(sid)
                        else:
                            sheet.range(f"J{row_idx}").value = "NOT FOUND"; continue

                    sid = row_to_sid.get(row_idx)
                    if not sid: continue

                    # Trading Logic
                    final_action = None
                    if str(exit_trigger).upper() == "YES":
                        final_action = "SELL" if str(action).upper() == "BUY" else "BUY"
                        sheet.range(f"H{row_idx}").value = "EXITING..."
                    elif str(execute).upper() == "YES":
                        final_action = str(action).upper()
                        sheet.range(f"G{row_idx}").value = "PLACING..."

                    if final_action:
                        ls = sheet.range(f"K{row_idx}").value or 0
                        tqty = int((lots or 0) * ls)
                        if tqty > 0:
                            oid = helper.place_order(sid, helper.NSE_FNO, final_action, tqty, helper.MARKET, helper.INTRA)
                            if oid:
                                sheet.range(f"U{row_idx}").value, sheet.range(f"V{row_idx}").value = oid, "SUCCESS"
                                if str(execute).upper() == "YES": sheet.range(f"I{row_idx}").value = sheet.range(f"L{row_idx}").value
                        sheet.range(f"G{row_idx}:H{row_idx}").value = "" 

                # --- PHASE 2: DATA FETCHING ---
                active_sids = list(row_to_sid.values())
                missing_sids = [s for s in active_sids if s not in helper.live_data]
                f_data = {}
                if missing_sids and (now_ts - last_fallback > 2.0):
                    f_data = helper.get_quote_data({"NSE_FNO": [int(s) for s in missing_sids]})
                    last_fallback = now_ts
                
                # --- PHASE 3: SHEET 1 UPDATE ---
                # 1. Update Nifty Spot Ticker at the top
                nifty_id = "13"
                nifty_data = helper.live_data.get(nifty_id)
                if not nifty_data:
                    # Fallback to HTTP for Nifty Spot
                    nifty_res = helper.get_ohlc("NIFTY 50")
                    if nifty_res:
                        nifty_data = nifty_res
                        nifty_data['LTP'] = nifty_res.get('last_price', 0)
                
                if nifty_data:
                    n_ltp = nifty_data.get('LTP', 0) or nifty_data.get('last_price', 0)
                    n_close = nifty_data.get('close', 0) or nifty_data.get('ohlc', {}).get('close', 0)
                    if n_ltp > 0 and n_close > 0:
                        n_change = n_ltp - n_close
                        n_pct = (n_change / n_close) * 100
                        color = PROFIT_GREEN if n_change >= 0 else LOSS_RED
                        sheet.range("B1").value = f"{n_ltp:,.2f}  ({n_change:+.2f} | {n_pct:+.2f}%)"
                        sheet.range("B1").font.color = color

                # 2. Update Table Rows
                for row_idx, sid in row_to_sid.items():
                    data = helper.live_data.get(sid)
                    if not data:
                        for seg in f_data.values():
                            if sid in seg: data = seg[sid]; break
                    
                    if data:
                        ltp = data.get('LTP', 0) or data.get('last_price', 0)
                        ohlc = data.get('ohlc', {})
                        avg, l, ls, act = (sheet.range(f"I{row_idx}").value or 0), (sheet.range(f"F{row_idx}").value or 0), (sheet.range(f"K{row_idx}").value or 0), str(sheet.range(f"E{row_idx}").value).upper()
                        
                        t_val = round(l * ls * ltp, 2)
                        pnl = round((ltp - avg) * l * ls if act == "BUY" else (avg - ltp) * l * ls if avg > 0 else 0, 2)
                        
                        curr_ltp_cell = sheet.range(f"L{row_idx}").value
                        status_icon = "▲" if ltp > (float(curr_ltp_cell) if curr_ltp_cell else 0) else "▼"
                        
                        # Update Row (L: LTP, M: Total Value, N: PnL, O-T: Stats, W: Status)
                        sheet.range(f"L{row_idx}").value = ltp
                        sheet.range(f"M{row_idx}").value = t_val
                        sheet.range(f"N{row_idx}").value = pnl
                        sheet.range(f"O{row_idx}:T{row_idx}").value = [data.get('open', 0) or ohlc.get('open', 0), data.get('high', 0) or ohlc.get('high', 0), data.get('low', 0) or ohlc.get('low', 0), data.get('close', 0) or ohlc.get('close', 0), data.get('OI', 0) or data.get('oi', 0), data.get('volume', 0)]
                        sheet.range(f"W{row_idx}").value = f"{status_icon} ({'Live' if sid in helper.live_data else 'Snap'})"
                        
                        if pnl > 0: sheet.range(f"N{row_idx}").font.color, sheet.range(f"N{row_idx}").color = PROFIT_GREEN, PROFIT_BG
                        elif pnl < 0: sheet.range(f"N{row_idx}").font.color, sheet.range(f"N{row_idx}").color = LOSS_RED, LOSS_BG
                        else: sheet.range(f"N{row_idx}").font.color, sheet.range(f"N{row_idx}").color = (0, 0, 0), WHITE
                    else:
                        sheet.range(f"W{row_idx}").value = "Waiting..."

                # --- PHASE 4: DASHBOARD & SUMMARY ---
                if now_ts - last_ui_update > 5:
                    try:
                        df_pos = helper.get_positions()
                        if not df_pos.empty:
                            pos_sids = [int(s) for s in df_pos['securityId'].tolist()]
                            pos_quotes = helper.get_quote_data({"NSE_FNO": pos_sids, "NSE_EQ": pos_sids})
                            def get_live_p(row):
                                sid = str(row['securityId'])
                                d = helper.live_data.get(sid)
                                if not d:
                                    for seg in pos_quotes.values():
                                        if sid in seg: d = seg[sid]; break
                                if d: return d.get('LTP', 0) or d.get('last_price', 0) or d.get('ohlc', {}).get('close', 0)
                                return row.get('lastTradedPrice', 0) or row.get('drvLastPrice', 0) or 0.0

                            df_pos['lastPrice'] = df_pos.apply(get_live_p, axis=1)
                            df_pos['unrealizedProfit'] = (df_pos['lastPrice'] - df_pos['costPrice']) * df_pos['netQty']
                            df_pos['totalValue'] = (df_pos['netQty'] * df_pos['lastPrice']).abs()
                            
                            # Dashboard Table
                            d_sheet.range("A1:I1").merge(); d_sheet.range("A1").value = "TRADING PORTFOLIO DASHBOARD"
                            d_sheet.range("A1").font.size, d_sheet.range("A1").font.bold, d_sheet.range("A1").font.color = 20, True, NAVY
                            
                            d_sheet.range("A6").value = "LIVE NET POSITIONS"; d_sheet.range("A6").font.bold = True
                            cols = ['tradingSymbol', 'positionType', 'netQty', 'buyAvg', 'sellAvg', 'lastPrice', 'totalValue', 'realizedProfit', 'unrealizedProfit']
                            available = [c for c in cols if c in df_pos.columns]
                            
                            d_sheet.range("A7").value = df_pos[available]
                            apply_pro_header(d_sheet.range("A7:I7"))
                            d_sheet.range("A7:I7").color = DARK_GRAY
                            
                            # Zebra Striping
                            for r in range(8, 8 + len(df_pos)):
                                if r % 2 == 0: d_sheet.range(f"A{r}:I{r}").color = LIGHT_GRAY
                            
                            total = df_pos['unrealizedProfit'].sum() + df_pos.get('realizedProfit', pd.Series([0.0])).sum()
                            d_sheet.range("A3").value = "TOTAL DAY PNL"; d_sheet.range("A3").font.bold = True
                            d_sheet.range("A4").value = f"Rs. {round(total, 2)}"
                            d_sheet.range("A4").font.size, d_sheet.range("A4").font.bold = 24, True
                            d_sheet.range("A4").font.color = PROFIT_GREEN if total > 0 else (LOSS_RED if total < 0 else (0,0,0))

                            # Options Summary
                            s_sheet.range("A1").value = "CUMULATIVE OPTIONS SUMMARY"; s_sheet.range("A1").font.size, s_sheet.range("A1").font.bold, s_sheet.range("A1").font.color = 18, True, NAVY
                            active = df_pos[df_pos['netQty'] != 0].copy()
                            if not active.empty:
                                def get_opt_type(symbol):
                                    s = str(symbol).strip().upper()
                                    if s.endswith('CE') or ' CALL' in s: return 'CE'
                                    if s.endswith('PE') or ' PUT' in s: return 'PE'
                                    return 'OTHER'
                                active['type'] = active['tradingSymbol'].apply(get_opt_type)
                                opt_only = active[active['type'].isin(['CE', 'PE'])]
                                summary_data = []
                                for t in ['CE', 'PE']:
                                    subset = opt_only[opt_only['type'] == t]
                                    if not subset.empty:
                                        tqty = subset['netQty'].abs().sum()
                                        avg_e = (subset['costPrice'] * subset['netQty'].abs()).sum() / tqty if tqty > 0 else 0
                                        avg_l = (subset['lastPrice'] * subset['netQty'].abs()).sum() / tqty if tqty > 0 else 0
                                        tpnl = subset['unrealizedProfit'].sum()
                                        tval = (subset['netQty'] * subset['lastPrice']).abs().sum()
                                        summary_data.append([t, len(subset), subset['netQty'].sum(), round(avg_e, 2), round(avg_l, 2), round(tval, 2), round(tpnl, 2)])
                                
                                s_sheet.range("A3:G10").clear_contents()
                                df_sum = pd.DataFrame(summary_data, columns=["Type", "Contracts", "Net Qty", "Avg Entry", "Current LTP", "Total Value", "PnL"])
                                s_sheet.range("A3").value = df_sum
                                apply_pro_header(s_sheet.range("A3:G3"))
                    except Exception as dash_err:
                        logger.warning(f"Dashboard Skip: {dash_err}")
                    last_ui_update = now_ts

                time.sleep(0.5)
            except Exception as e:
                if "-2147352567" not in str(e): logger.error(f"Loop Error: {e}")
                time.sleep(2)
    finally:
        logger.info("Tracker stopped.")

if __name__ == "__main__":
    run_live_tracker()
