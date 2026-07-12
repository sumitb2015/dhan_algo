import json
import os
import sys
import sqlite3

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

# AlgoTest reference data (date -> {ce: {strike, entry, exit, pnl}, pe: {strike, entry, exit, pnl}, total_pnl})
algotest = {
    "2026-04-01": {"ce": (23300, 154.30, 95.55, 3819),  "pe": (22500, 169.20, 217.75, -3156), "total": 663},
    "2026-04-02": {"ce": (22650, 139.55, 318.30, -11619), "pe": (21850, 156.90, 41.42, 7506),  "total": -4112},
    "2026-04-06": {"ce": (23050, 67.80, 151.30, -5428),  "pe": (22250, 83.65, 14.82, 4474),   "total": -954},
    "2026-04-07": {"ce": (23150, 7.40, 0.20, 468),       "pe": (22350, 5.25, 0.00, 341),       "total": 809},
    "2026-04-08": {"ce": (24300, 87.55, 93.75, -403),    "pe": (23500, 108.40, 67.20, 2678),   "total": 2275},
    "2026-04-09": {"ce": (24350, 52.50, 30.03, 1461),    "pe": (23550, 74.70, 96.45, -1414),   "total": 47},
    "2026-04-10": {"ce": (24350, 32.85, 39.45, -429),    "pe": (23550, 42.45, 25.65, 1092),    "total": 663},
    "2026-04-13": {"ce": (24000, 3.45, 0.05, 221),       "pe": (23200, 3.70, 0.00, 241),       "total": 462},
    "2026-04-15": {"ce": (24650, 65.05, 56.05, 585),     "pe": (23850, 88.95, 98.80, -640),    "total": -55},
    "2026-04-16": {"ce": (24800, 39.70, 17.39, 1450),    "pe": (24000, 75.45, 116.35, -2659),  "total": -1208},
    "2026-04-17": {"ce": (24600, 37.20, 58.45, -1381),   "pe": (23800, 55.05, 20.89, 2220),    "total": 839},
    "2026-04-20": {"ce": (24750, 16.95, 17.95, -65),     "pe": (23950, 32.55, 26.65, 384),     "total": 319},
    "2026-04-21": {"ce": (24850, 1.85, 0.10, 114),       "pe": (24050, 3.30, 0.10, 208),       "total": 322},
    "2026-04-22": {"ce": (24900, 67.05, 47.00, 1303),    "pe": (24100, 106.40, 113.90, -488),  "total": 816},
    "2026-04-23": {"ce": (24600, 61.60, 42.80, 1222),    "pe": (23800, 79.45, 69.80, 627),     "total": 1849},
    "2026-04-24": {"ce": (24500, 47.60, 20.63, 1753),    "pe": (23700, 39.45, 89.00, -3221),   "total": -1468},
    "2026-04-27": {"ce": (24400, 21.75, 18.20, 231),     "pe": (23600, 15.65, 5.10, 686),      "total": 917},
    "2026-04-28": {"ce": (24500, 1.70, 0.00, 111),       "pe": (23700, 1.60, 0.15, 94),        "total": 205},
    "2026-04-29": {"ce": (24500, 51.75, 70.30, -1206),   "pe": (23700, 62.70, 44.25, 1199),    "total": -7},
    "2026-04-30": {"ce": (24350, 49.55, 66.30, -1089),   "pe": (23550, 55.25, 42.10, 855),     "total": -234},
    "2026-05-06": {"ce": (24600, 57.00, 110.50, -3478),  "pe": (23800, 56.60, 30.00, 1729),    "total": -1749},
    "2026-05-13": {"ce": (23800, 92.95, 90.35, 169),     "pe": (23000, 81.90, 72.15, 634),     "total": 803},
    "2026-05-14": {"ce": (23950, 59.90, 68.70, -572),    "pe": (23150, 64.20, 32.11, 2086),    "total": 1514},
    "2026-05-29": {"ce": (24350, 26.65, 12.17, 941),     "pe": (23550, 19.00, 74.60, -3614),   "total": -2673},
    "2026-06-01": {"ce": (24050, 14.00, 1.61, 805),      "pe": (23250, 10.10, 25.20, -982),    "total": -176},
    "2026-06-10": {"ce": (23750, 50.40, 23.06, 1777),    "pe": (22950, 59.90, 74.75, -965),    "total": 812},
    "2026-06-12": {"ce": (23850, 16.30, 61.80, -2958),   "pe": (23050, 29.35, 9.62, 1283),     "total": -1675},
    "2026-06-24": {"ce": (24250, 34.10, 54.00, -1294),   "pe": (23450, 34.30, 11.35, 1491),    "total": 198},
    "2026-06-29": {"ce": (24500, 4.60, 1.05, 231),       "pe": (23700, 8.20, 11.55, -218),     "total": 13},
}

THRESHOLD = 5.0  # flag differences bigger than this in rupees

print(f"\n{'Date':<12} {'Field':<20} {'AlgoTest':>12} {'Ours':>12} {'Diff':>10}")
print("-" * 68)

complete = [c for c in res["cycles"] if c.get("is_complete") and c.get("exit_reason") != "NO_ENTRY"]
our_map = {}
for c in complete:
    date = c["entry_dt"][:10]
    our_map[date] = c

diffs_found = 0
for date, ref in sorted(algotest.items()):
    if date not in our_map:
        print(f"{date:<12} {'MISSING IN OURS':<20}")
        continue
    ours = our_map[date]
    our_legs = {l["option_type"]: l for l in ours["legs"]}

    for typ, key in [("CE", "ce"), ("PE", "pe")]:
        if typ not in our_legs:
            continue
        our_leg = our_legs[typ]
        ref_leg = ref[key]

        fields = [
            ("strike",     ref_leg[0],  our_leg["strike"]),
            ("entry_price", ref_leg[1], our_leg["entry_price"]),
            ("exit_price",  ref_leg[2], our_leg["exit_price"]),
            ("leg_pnl",     ref_leg[3], our_leg["pnl"]),
        ]
        for fname, rval, oval in fields:
            try:
                diff = abs(float(oval) - float(rval))
                if diff > THRESHOLD:
                    print(f"{date:<12} {typ+' '+fname:<20} {rval:>12} {oval:>12.2f} {diff:>+10.2f}  *** DIFF")
                    diffs_found += 1
            except:
                pass

    # Total P&L
    diff_total = abs(ours["pnl"] - ref["total"])
    if diff_total > THRESHOLD:
        print(f"{date:<12} {'TOTAL_PNL':<20} {ref['total']:>12} {ours['pnl']:>12.2f} {diff_total:>+10.2f}  *** DIFF")
        diffs_found += 1

print("-" * 68)
print(f"\nTotal differences > Rs.{THRESHOLD}: {diffs_found}")
conn.close()
