# Critical API Conventions

Non-obvious `DhanHelper`/SDK behaviors that have caused real runtime errors
(see GEMINI.md for more). Read this before writing or modifying any strategy
or script that calls `DhanHelper`, places orders, or touches the market-feed
WebSocket — not needed for dashboard-only or docs-only changes.

- **Use `get_ltp()`, not `ltp()`**. The simplified `ltp()` wrapper does not accept `instrument` or `exchange` keyword args.
- **Keyword is `exchange=`, not `exchange_segment=`**. Using the wrong name raises `TypeError`.
- **Always pass `instrument=`** (e.g. `"INDEX"`, `"EQUITY"`, `"OPTIDX"`) to `get_ltp()` / `find_*` to prevent the helper from defaulting to `"EQUITY"` and logging "Security not found" warnings.
- **NIFTY symbol**: use `"NIFTY"` (not `"NIFTY 50"`). Exchange `"IDX_I"` is mapped internally to `"NSE"` for master list lookups.
- **NIFTY options underlying ID is `26000`**, not `13` (which is the Nifty 50 index security ID used for spot price and expiry list calls).
- **SENSEX splits three ways and every wrong combination fails silently.** Option chain + expiry list key on security id **`1` / `BSE_FNO`**; the index's own id `51` is only for spot/candles, and those are served under **`IDX_I`** — `BSE_IDX` returns `DH-905` for history and an empty payload for quotes, so `get_ltp("SENSEX", exchange="BSE")` returns `0.0`. Pass the numeric id, never the bare symbol (which resolves to `51` and yields an empty chain). The tables in `scripts/tools/options_data_fetch.py` and `options_chart_fetch.py` encode this. When re-probing, note `get_option_chain` caches 5 s on `(security_id, expiry)` — a bad combination can appear to work off a prior call's cache entry.
- **Market feed WebSocket**: use `feed.run()` inside the background thread. `feed.run_forever()` returns immediately in the current SDK, causing a reconnection loop.
- **Lot sizes are dynamic** — fetch with `helper.get_lot_size("NIFTY")`. For index symbols, this automatically queries derivative contracts to return the option lot size, not the index placeholder of `1`.
- **Previous day levels**: use `helper.get_prev_day_levels("NIFTY")` — do not inline `get_historical_data()` calls for PDH/PDL/PDC. (It reads the returned row's actual date rather than assuming row-count offsets — Dhan's DAILY endpoint doesn't publish today's row until the session closes, so a fixed "step back N rows" offset returns the wrong day intraday.)
- **Data API failures are silent by default** — historical/intraday data methods return empty results on API errors (e.g. `DH-902` when the Data API subscription lapses). Check `helper.last_api_error` after an empty response before concluding "no data" / "up to date"; scripts that report freshness must surface it.
- **`find_future()` must filter out expired contracts before picking nearest.** Dhan's master list keeps expired futures rows for days after expiry, sorted by expiry date — picking the earliest-sorted match without an `SM_EXPIRY_DATE >= today` filter can resolve a dead security ID with no live OHLC/quote data.
- **`get_option_chain()`'s per-strike `oc[strike]['ce'/'pe']` dict names the previous-day close field `previous_close_price`, not `previous_close`.** `previous_oi` (OI) is spelled as you'd expect — only the close field has the `_price` suffix. Reading `previous_close` silently returns `None`/0 with no error, which then reads as "no previous close" everywhere downstream (e.g. a buildup-classifier's prev-day fallback going permanently 0%). This exact typo has been copied between scripts more than once (`live_options_ws.py`, `focus_tool_ws.py`) — verify the field name against a live response before trusting it in new code.
