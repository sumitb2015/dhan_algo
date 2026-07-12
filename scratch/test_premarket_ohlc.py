import sys, json
sys.path.insert(0, '.')
from login import get_dhan_client
dhan = get_dhan_client()
r = dhan.ohlc_data({"NSE_IDX": [13, 21]})
print(json.dumps(r, indent=2)[:2000])
