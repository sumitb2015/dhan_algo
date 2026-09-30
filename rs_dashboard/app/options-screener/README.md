# Options Screener — how to use

Shows **what changed in the last 1–30 minutes** across index, stock and MCX options. A background collector snapshots the option chains once a minute; the page compares the latest snapshot with earlier ones.

## 1. Start the collector

- Click **Start** in the header. The chip turns **Collector RUNNING**; the first rows appear after one scan (about a minute).
- The 1–30 min change columns fill in as history builds — a 30-min column needs 30 minutes of running.
- It scans ATM ±10 strikes × the nearest 2 expiries, and **only the underlyings your open tabs are showing** (the **SCANNING:** chip). Pick segment **All** with no symbols to scan everything.
- Exchange chips: green = live, amber = stale (snapshot older than 3 min), grey = market closed.
- **DHAN THROTTLED** means Dhan returned a 429 and every caller is being slowed down; it eases back on its own.
- If the collector stops with an error, the Dhan token has usually expired: run `login.py`, then click Start again. The log is `debug/options_screener_collector.log`.

## 2. Choose what to look at

- **Segment** — All, Indices, Stocks or MCX.
- **Symbols** — comma-separated (e.g. `NIFTY, BANKNIFTY, RELIANCE`). Leave empty for every underlying in the segment. Press Enter or click away to apply. A newly added symbol gets data on the collector's next cycle.
- **Watchlist** — type symbols, then choose **+ Save typed symbols…** to reuse them later.
- **Expiry** — All, Nearest, Next, or a specific date.
- **Type** — CE + PE, CE only, or PE only.
- **Strikes from ATM** — ATM only, ±1 … ±7, or Any (±10).
- **Columns window** — which look-back (1, 3, 5, 10, 15 or 30 min) the table's change columns show.

## 3. Custom scan (left panel)

- Build up to 8 conditions; **all of them must be true** for a contract to show.
- Each condition is: metric, window (for change metrics), ≥ or ≤, and a value. Example: *Volume (lots) in 5 min ≥ 50* **and** *OI change % in 5 min ≥ 10*.
- **Save…** stores the condition set; **Load…** and **Delete…** manage saved scans.
- Results are ranked by score. Rows keep their place while you watch; click **Re-sort** to re-rank.

## 4. Preset scans (right panel)

- Tick any of the ready-made scans. **Match: Any** shows contracts hitting at least one ticked preset; **All** needs every one.
- Hover a preset to see its exact rule. The number beside it is how many contracts hit it right now.
- Groups: **Buildup & writing** (long buildup, call/put writing, short covering, long unwinding), **Activity** (unusual volume, strike waking up, breakout, momentum, expiry-day gamma burst, big-ticket print), **Volatility** (IV spike/crush) and **Underlying** (PCR shift, ATM tilt, OI wall shift, straddle expansion/crush).
- Hits are **logged for the whole day**. New hits are highlighted and counted as "N new"; opening a row or **Mark all seen** clears the highlight. Dimmed rows matched earlier but no longer do.

## 5. Reading a row

- **PRICE** — premium and its % change over the columns window.
- **OI · Δ** — open interest and its change. **VOL · RVOL** — volume in the window and relative volume (window pace ÷ the contract's own session-average pace). **IV · Δ** — implied volatility and its change in vol points.
- OI and volume are in **lots**. IV is solved locally from the last traded price (Black-Scholes; Black-76 for MCX), so an untraded contract's IV drifts with spot.

## 6. Contract details and orders

- Click a row to open every look-back window for that contract, plus a Dhan order ticket.
- **Orders are real.** The ticket places a single-leg Dhan order (Market or Limit), capped at 25 lots. The first click arms the button; a second click confirms. Changing anything on the ticket cancels the pending confirmation.

## Good to know

- Your filters, saved scans, watchlists and "seen" marks are kept in this browser only.
- Stop the collector when you are done — it uses the shared Dhan quote rate limit that the other pages also use.
