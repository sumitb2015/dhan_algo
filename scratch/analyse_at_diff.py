import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# AlgoTest individual trade P&Ls exactly as shown in the table the user provided
algotest_trades = [
    # (date, total_pnl)
    # April
    ("2026-04-01", 663),
    ("2026-04-02", -4112),
    ("2026-04-06", -954),
    ("2026-04-07", 809),
    ("2026-04-08", 2275),
    ("2026-04-09", 47),
    ("2026-04-10", 663),
    ("2026-04-13", 462),
    ("2026-04-15", -55),
    ("2026-04-16", -1208),
    ("2026-04-17", 839),
    ("2026-04-20", 319),
    ("2026-04-21", 322),
    ("2026-04-22", 816),
    ("2026-04-23", 1849),
    ("2026-04-24", -1468),
    ("2026-04-27", 917),
    ("2026-04-28", 205),
    ("2026-04-29", -7),
    ("2026-04-30", -234),
    # May
    ("2026-05-04", 1242),
    ("2026-05-05", 322),
    ("2026-05-06", -1749),
    ("2026-05-07", 757),
    ("2026-05-08", 1420),
    ("2026-05-11", 1277),
    ("2026-05-12", 169),
    ("2026-05-13", 803),
    ("2026-05-14", 1514),
    ("2026-05-15", 1050),
    ("2026-05-18", 104),
    ("2026-05-19", 358),
    ("2026-05-20", 336),
    ("2026-05-21", 767),
    ("2026-05-22", 1294),
    ("2026-05-25", 478),
    ("2026-05-26", 189),
    ("2026-05-27", 1619),
    ("2026-05-29", -2673),
    # June
    ("2026-06-01", -176),
    ("2026-06-02", 241),
    ("2026-06-03", -822),
    ("2026-06-04", 1635),
    ("2026-06-05", 1359),
    ("2026-06-08", 1134),
    ("2026-06-09", 172),
    ("2026-06-10", 812),
    ("2026-06-11", 1177),
    ("2026-06-12", -1675),
    ("2026-06-15", 289),
    ("2026-06-16", 159),
    ("2026-06-17", 842),
    ("2026-06-18", 774),
    ("2026-06-19", 715),
    ("2026-06-22", 260),
    ("2026-06-23", 114),
    ("2026-06-24", 198),
    ("2026-06-25", 458),
    ("2026-06-29", 13),
    ("2026-06-30", 224),
]

# AlgoTest's own entry premiums per trade (sum of both legs), to estimate STT
# ce_entry + pe_entry per trade from the table:
ce_entries = [154.30,139.55,67.80,7.40,87.55,52.50,32.85,3.45,65.05,39.70,
              37.20,16.95,1.85,67.05,61.60,47.60,21.75,1.70,51.75,49.55,
              20.70,3.30,57.00,53.20,43.65,24.20,2.10,92.95,59.90,45.15,
              20.00,1.15,72.30,47.25,33.30,12.25,1.50,43.10,26.65,
              14.00,2.30,70.40,60.25,40.90,19.25,1.20,50.40,42.40,16.30,
              8.15,1.10,35.15,19.40,17.00,5.20,0.90,34.10,12.10,4.60,1.95]
pe_entries = [169.20,156.90,83.65,5.25,108.40,74.70,42.45,3.70,88.95,75.45,
              55.05,32.55,3.30,106.40,79.45,39.45,15.65,1.60,62.70,55.25,
              22.30,1.75,56.60,45.20,34.70,14.30,1.40,81.90,64.20,45.80,
              24.70,4.45,88.65,57.95,38.40,13.05,1.55,44.00,19.00,
              10.10,1.50,54.80,45.25,32.00,14.85,1.65,59.90,37.35,29.35,
              13.50,1.45,41.45,25.20,15.40,5.50,0.95,34.30,21.80,8.20,1.75]

LOT_SIZE = 65
NUM_LOTS = 1

monthly = {}
for date, pnl in algotest_trades:
    month = date[:7]
    monthly[month] = monthly.get(month, 0) + pnl

print("AlgoTest INDIVIDUAL TRADES summed by month:")
total = 0
for m, s in sorted(monthly.items()):
    print(f"  {m}: {s:>8,}")
    total += s
print(f"  TOTAL : {total:>8,}")

print("\nAlgoTest YEAR-WISE SUMMARY (from screenshot):")
print("  2026-04:     487")
print("  2026-05:   8,488")
print("  2026-06:   6,909")
print("  TOTAL  :  15,895")
print("  Max DD :  -6,506")

print("\nDifference (individual trades - year-wise summary):")
diffs = {"2026-04": 487, "2026-05": 8488, "2026-06": 6909}
for m, at_summary in sorted(diffs.items()):
    our_sum = monthly[m]
    diff = our_sum - at_summary
    n_trades = sum(1 for d, _ in algotest_trades if d.startswith(m))
    print(f"  {m}: individual={our_sum:>6} summary={at_summary:>6} diff={diff:>6}  ({n_trades} trades, diff/trade={diff/n_trades:.1f})")

total_diff = total - 15895
print(f"\n  Total difference: {total_diff:,} over 60 trades = {total_diff/60:.1f}/trade avg")

# Estimate STT impact
# STT on options SELL = 0.1% of (premium × lot_size × lots)
total_premium_sold = 0
for ce_ep, pe_ep in zip(ce_entries, pe_entries):
    total_premium_sold += (ce_ep + pe_ep) * LOT_SIZE * NUM_LOTS
stt = total_premium_sold * 0.001
print(f"\nEstimated STT (0.1% on sell premium): {stt:,.0f}")
print(f"  Total sell premium = {total_premium_sold:,.0f}")
print(f"  Explanation: diff={total_diff}, STT={stt:.0f}, ratio={total_diff/stt:.2f}")

# Default AlgoTest commission per lot (20 round-trip? )
total_lots = 60 * 2 * LOT_SIZE * NUM_LOTS  # 60 trades, 2 legs, entry+exit
print(f"\nIf commission accounts for the difference:")
print(f"  Total leg transactions = 60 trades x 2 legs x 2 sides = 240")
print(f"  Total lots = 240 x {LOT_SIZE} = {240*LOT_SIZE}")
print(f"  Implied commission per lot = {total_diff/(240*LOT_SIZE):.2f}")
print(f"  Implied commission per order (per leg per side) = {total_diff/240:.1f}")
