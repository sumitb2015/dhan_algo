# API Gotchas

Deep detail behind the one-line warnings in `CLAUDE.md` → Critical API Conventions.
Read the relevant section only when you're actually touching that code path.

## SENSEX splits three ways

Every wrong id/segment combination fails **silently** (empty chain, `0.0` LTP, or `DH-905`) rather than erroring:

- Option chain + expiry list key on security id **`1`** / segment **`BSE_FNO`**.
- The index's own id `51` is only for spot/candles, served under **`IDX_I`** — `BSE_IDX`
  returns `DH-905` for history and an empty payload for quotes, so
  `get_ltp("SENSEX", exchange="BSE")` returns `0.0`.
- Master-list option contracts need `find_option(..., exchange="BSE")`; the default
  `exchange="NSE"` matches nothing.

Always pass the **numeric id**, never the bare symbol `"SENSEX"` — it resolves to `51`,
whose chain is empty. The `UNDERLYINGS` tables in `scripts/tools/options_data_fetch.py`
and `options_chart_fetch.py` encode the correct combinations.

`get_option_chain()` caches 5 s on `(security_id, expiry)` — a bad combination can look
like it works off a prior call's cache entry when re-probing.

## `previous_close_price`, not `previous_close`

`get_option_chain()`'s per-strike `oc[strike]['ce'/'pe']` dict names the previous-day
close field `previous_close_price` — only the close field has the `_price` suffix
(`previous_oi` is spelled as expected). Reading `previous_close` silently returns
`None`/0 with no error, which then reads as "no previous close" everywhere downstream
(e.g. a buildup-classifier's prev-day fallback going permanently 0%). This typo has been
copied between scripts more than once (`live_options_ws.py`, `focus_tool_ws.py`) —
verify the field name against a live response before trusting it in new code.

## `find_future()` and expired contracts

Dhan's master list keeps expired futures rows for days after expiry, sorted by expiry
date — picking the earliest-sorted match without an `SM_EXPIRY_DATE >= today` filter can
resolve a dead security ID with no live OHLC/quote data. `find_future()` must filter
expired contracts out before picking nearest.

## Silent Data API failures

Historical/intraday data methods return empty results on API errors (e.g. `DH-902` when
the Data API subscription lapses), with no exception raised. Check
`helper.last_api_error` after an empty response before concluding "no data" / "up to
date"; scripts that report freshness must surface it.

## DH-905 is IP-whitelist-only on transaction endpoints

`DH-905 "Invalid IP"` is enforced **only** on transaction endpoints (POST `/v2/orders`,
DELETE `/v2/orders/{id}`, modify). Read endpoints (GET `/v2/orders`, `/v2/positions`,
`/v2/profile`, quotes) keep returning 200 from a non-whitelisted IP — so "the API works"
is not evidence that orders will go through.

To test whether DH-905 is an IP problem, probe a transaction endpoint with zero market
risk — DELETE an already-CANCELLED order id. DH-905 back = IP block; an OMS "already
cancelled" error = IP is fine. Never diagnose this from a read call. There is no API
workaround while blocked: fix the whitelist at web.dhan.co (DhanHQ Trading APIs → IP
whitelist), then re-run `login.py`; close open positions manually from the Dhan app
meanwhile.

## Kotak quirks

All handled in `lib/kotak/`:

- Auth failures and "no data" arrive as 200-OK bodies (`stCode 5203` = empty book, not
  an error).
- Positions report no net quantity — compute it from the four `cf*`/`fl*` legs.
- Strikes are ×100 scaled in the scrip master.
- The REST base URL is per-user and comes from the login response.
- The SDK issues every HTTP call with **no timeout**, so
  `lib.kotak.authentication.install_timeouts()` must run before any API use.

**Expiry epochs differ per segment.** `nse_fo`/`bse_fo` use a **1980-based epoch** (add
10 calendar years). `mcx_fo` does **not** — its timestamps are a genuine epoch and must
be read in **UTC** (Kotak stamps 23:59:59 UTC, so local parsing rolls every expiry
forward a day). Applying the NSE rule to commodities returns 2036. Both branches live in
`scripts/tools/kotak_instruments_cache.py`.

**MCX quantity semantics differ by 100x between brokers.** Dhan takes MCX order quantity
in **lots** (its master reports `LOT_SIZE=1`); Kotak's `qt` is **absolute** (100 per
CRUDEOIL lot, 10 per CRUDEOILM). Always send a position's reported `netQty` verbatim when
squaring off. MCX options are `OPTFUT` in both masters — the equity `OPTIDX`/`OPTSTK`
filter drops them.

## Dashboard: kotak-pnl import precedence

`kotak-pnl/` (the Trader's Diary's Kotak source) is not a broker sync — Kotak Neo has no
historical trade endpoint, so the user drops statement exports into
`debug/kotak_pnl_reports/` and POST `{action:"import"}` runs
`scripts/tools/import_kotak_pnl_reports.py` over them. Two formats:

- **Transaction Statement** (sheet `On Market`) — one row per fill, FIFO-matched into
  exact daily P&L.
- **Gain/Loss** export — per-scrip over a date range with no per-trade date, so it
  collapses to one end-stamped point. It also **omits the commodity segment entirely**
  (hid −₹5,048 of MCX crude on the first real pair).

Where both cover the same dates the transaction statement wins. Read the import script's
docstring before touching either parser: the Gain/Loss "Realised P&L" column is already
net of GST/brokerage/misc (true gross is the separate
`Gross P&L (T + (C + D + E))` column), and the transaction statement's "Total Charges"
*excludes* STT while the Gain/Loss column of the same name includes it.
