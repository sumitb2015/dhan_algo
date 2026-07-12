import json
import os
import sys
from datetime import datetime
import sqlite3

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from scripts.analysis.backtest_short_straddle import fetch_multi_leg_cycles, run_backtest, LegConfig, _load_vix

db_path = r"c:\dhan_algo\dhan_algo\Options Data\nifty_options.db"
conn = sqlite3.connect(db_path)

leg_configs = [
    LegConfig(option_type="CE", position="sell", lots=1, strike="ATM+8", leg_sl_pct=0, strike_type="offset"),
    LegConfig(option_type="PE", position="sell", lots=1, strike="ATM-8", leg_sl_pct=0, strike_type="offset"),
]

vix_map = _load_vix()
cycles = fetch_multi_leg_cycles("2026-04-01", "2026-06-30", leg_configs, db_conn=conn)

res = run_backtest(
    leg_configs=leg_configs,
    cycles=cycles,
    lot_size=65,
    commission_per_lot=0,
    slippage_pct=0,
    entry_time_str="09:20",
    eod_time_str="15:15",
    profit_target_pct=0,
    overall_sl_pct=0,
    vix_map=vix_map,
    start_date="2026-04-01",
    end_date="2026-06-30"
)

# Print a header
print(f"{'Idx':<4} {'Date':<10} {'Type':<4} {'Strike':<6} {'B/S':<3} {'Qty':<3} {'Entry':<8} {'Exit':<8} {'P/L':<10}")

# Let's count trades that are complete
idx = 1
for cycle in res["cycles"]:
    if not cycle.get("is_complete") or cycle.get("exit_reason") == "NO_ENTRY":
        continue
    
    dt_str = cycle["entry_dt"][:10]
    total_pnl = cycle["pnl"]
    
    # Print summary row
    print(f"{idx:<4} {dt_str:<10} {'—':<4} {'—':<6} {'—':<3} {'—':<3} {'—':<8} {'—':<8} {total_pnl:<10.2f}")
    
    # Print legs
    for sub_idx, leg in enumerate(cycle["legs"], 1):
        typ = leg["option_type"]
        strike = int(leg["strike"])
        bs = "Sell" if leg["position"] == "sell" else "Buy"
        qty = 65
        ep = leg["entry_price"]
        xp = leg["exit_price"]
        lpnl = leg["pnl"]
        print(f"  {idx}.{sub_idx} {dt_str:<10} {typ:<4} {strike:<6} {bs:<3} {qty:<3} {ep:<8.2f} {xp:<8.2f} {lpnl:<10.2f}")
        
    idx += 1

conn.close()
