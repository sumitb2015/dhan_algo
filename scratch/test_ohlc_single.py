import sys, json
sys.path.insert(0, '.')
from login import get_dhan_client
from lib.dhan_helper import DhanHelper
dhan = get_dhan_client()

segments = ["MCX_COMM", "MCX", "MCX_COMMODITY", "NSE_FNO"]
for seg in segments:
    try:
        r = dhan.ohlc_data({seg: [520702]})
        print(f"Segment: {seg} -> {r}")
    except Exception as e:
        print(f"Segment: {seg} -> Exception: {e}")
