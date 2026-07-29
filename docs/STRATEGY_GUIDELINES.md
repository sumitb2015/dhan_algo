# Strategy Creation Guidelines

This document provides a detailed guide for creating new trading strategies within the `dhan_algo` framework.

## 1. Strategy Architecture

All strategies should follow a consistent structure to ensure reliability and ease of maintenance.

### Basic Template
Always start with `templates/strategy_template.py`. It includes:
- Initialization of `DhanHelper`.
- Market open/close checks.
- A main loop with error handling.
- Position management logic using net quantity.

## 2. Technical Indicators
Use `helper.get_indicators()` for all technical analysis. It supports:
- **EMA/SMA**: `EMA20`, `SMA50`.
- **RSI**: `RSI14`.
- **ATR**: `ATR10`.
- **Supertrend**: Custom implementation integrated for TradingView accuracy.

```python
df = helper.get_indicators(SYMBOL, indicators=['EMA20', 'RSI14', 'ATR10'])
```

## 3. Order Management

### Entry & Exit
- **Entry**: Use `helper.place_entry(symbol, qty, direction)`.
- **Exit**: Close with an **explicit quantity** you own — `helper.buy(security_id, lots * lot_size)` / `helper.sell(...)`. This is what every strategy in this repo does, and it nets correctly at the broker.
- **Stop Loss**: Always place an SL-M order immediately after entry using `helper.place_sl_market()`.

#### Account-wide helpers — handle with care
Three `DhanHelper` methods act on the **whole account**, not just your strategy. Two strategies
(or two `--instance-id` copies of one strategy) that touch the same instrument net into a single
broker position, so these will silently affect the other:

| Method | Scope | Use instead |
| --- | --- | --- |
| `close_position(symbol)` | Closes the full netted `abs(netQty)` for that symbol | `helper.buy/sell(id, my_lots * lot_size)` |
| `cancel_all_orders()` | Cancels every pending order on the account | `helper.cancel_order(order_id)` |
| `close_all_positions()` | Flattens everything | explicit per-leg exits |

Reserve them for genuine "flatten/cancel everything" semantics (e.g. a panic exit).

## 4. TODOs & DONTs

### TODOs (Best Practices)
- [x] **Check Market Hours**: Use `helper.is_market_open()` to avoid API errors during off-market hours.
- [x] **Use Logging**: Log every significant event (Signal, Order, Error) with `logger.info()`.
- [x] **Handle Multi-Day Data**: Use `get_historical_minute_data_long` if your strategy needs backtesting with more than 90 days of data.
- [x] **Dynamic Quantity**: Use `helper.get_lot_size(symbol)` to handle F&O lot sizes correctly.
- [x] **Use WebSocket for Prices**: Use `helper.start_websocket()` for sub-second price updates. The helper automatically prioritizes `live_data` in `get_ltp()`.
- [x] **After-Hours Operation**: Strategies can run after market hours for testing; `DhanHelper` automatically falls back to cached data from `master_list.csv` when API calls fail.

### DONTs (Pitfalls)
- [ ] **DON'T** poll faster than 1 second; use the WebSocket for high-frequency data instead.
- [ ] **DON'T** restart the WebSocket manager manually; the helper handles reconnections and rate-limit backoffs (HTTP 429).
- [ ] **DON'T** use `feed.run_forever()`; it is incompatible with the current background thread manager (use `run()` inside the helper).
- [ ] **DON'T** hardcode strike steps or expiries; use `helper.get_expiries()` and `helper.select_strike()`.
- [ ] **DON'T** assume an order is filled; use `helper.wait_for_fill(order_id)` if subsequent logic depends on it.
- [ ] **DON'T** ignore the `Datetime` index in DataFrames; ensure calculations are time-aware.
- [ ] **DON'T** confuse index security ID with options underlying ID (e.g., NIFTY 50 index has ID 13, but NIFTY options use underlying ID 26000).
- [ ] **DON'T** assume API calls will always succeed; `DhanHelper` has built-in fallbacks for after-hours operation.
- [ ] **DON'T** call `close_position()` / `cancel_all_orders()` / `close_all_positions()` for routine exits — they are account-wide (see §3).
- [ ] **DON'T** hardcode the strategy key when calling `save_strategy_state()` / `check_shutdown_trigger()`; use the instance-aware key (see §7), or duplicated runs will fight over one state file.

## 5. Verification Checklist
Before running a live strategy:
1. Verify symbol resolution with `helper.find_equity()` or `helper.find_index()`.
2. Test the logic on historical data using `get_latest_candles`.
3. Monitor the first few trades manually in the Dhan app.

## 6. After-Hours Development & Testing

### Fallback Mechanisms
`DhanHelper` includes automatic fallbacks for after-hours operation:
- **Expiry Lists**: `get_expiry_list()` extracts from `master_list.csv` when API fails
- **Symbol Resolution**: All lookups use cached master list data
- **Testing**: Strategies can be developed and tested after market hours

### Data Availability
When market is closed:
- ✅ **Available**: Symbol lookups, expiry lists, contract details, lot sizes
- ⚠️ **Limited**: Live quotes (LTP may be 0 or stale)
- ❌ **Unavailable**: Order placement, position updates, live WebSocket data

### Best Practices
```python
# Always check market status
if not helper.is_market_open():
    logger.warning("Market is closed. Running in observation mode.")

# Handle missing quote data gracefully
ltp = quote.get('last_price', 0) or quote.get('LTP', 0)
if ltp == 0:
    logger.warning("LTP is 0, market may be closed")
```

## 7. Multi-Instance Support (`--instance-id`)

The dashboard's **+ Add run** button on `/strategies-plus` launches a second concurrent copy
of a strategy with its own lot size, instead of stopping and resizing the running one. Each
copy is a separate OS process, isolated by an `--instance-id` suffix on its `debug/` files.

Every new strategy must support this. The pattern:

```python
# 1. argparse — alongside the other flags
parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                    help="Suffix for debug/state files to run a second concurrent copy of this strategy")

# 2. right after parse_args() — "" means the plain base key (unchanged single-instance behavior)
args = parser.parse_args()
STATE_KEY = f"my_strategy_{args.instance_id}" if args.instance_id else "my_strategy"

# 3. pass it in, store as self.state_key, and use it for BOTH state helpers
strat = MyStrategy(..., state_key=STATE_KEY)
save_strategy_state(self.state_key, state_dict)
check_shutdown_trigger(self.state_key)
```

Logging is configured at import time, before `parse_args()` runs, so the log filename uses a
separate `sys.argv` sniffer:

```python
from lib.strategy_state_helper import instance_log_suffix
FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"))
```

**Invariants**
- With no `--instance-id`, every filename is byte-for-byte what it was before this feature — never regress that.
- Instance ids are validated as `[A-Za-z0-9_-]{1,20}` (they become filenames).
- If your strategy is launchable from the dashboard, register its log folder in
  `rs_dashboard/app/api/strategies/logs/route.ts`, and the strategy itself in
  `rs_dashboard/lib/strategyRegistry.ts` (which also drives the **Exit All Positions** sweep).

**Operational cost of a second instance** — it is a second process with its own connections:
- Roughly doubles REST quote calls against Dhan's ~1 req/s limit; expect more 429 backoff. Prefer
  WebSocket-driven `get_ltp()` and avoid tight REST polling loops.
- Opens an additional market-feed WebSocket per account.
- Both instances net into the same broker position per instrument — see the account-wide warning in §3.
