---
name: dhan-api-errors
description: Dhan API error codes (Trading API DH-901..DH-910 and Data API 800..814) mapped to what they mean in this repo, how the helper records and classifies them (last_api_error, is_fatal_error), and a symptom-to-cause table for empty data, 0.0 LTP, rejected orders and "API works but orders fail". Use whenever an API call returns a DH- or 8xx code, a data fetch comes back empty or zero, an order is rejected, a script must decide whether to retry or stop, or code needs to branch on an error code. Use before concluding "no data" or "market closed" from an empty response.
---

# Dhan API Errors

Dhan often fails **silently**: an empty DataFrame, a `0.0` LTP or an empty option chain, with the reason only in the
response `remarks`. Most "the data is missing" bugs here were an error nobody read. Read the code first, then decide
whether to retry, stop, or fix the request.

## Official codes
Source: DhanHQ v2 annexure (`dhanhq.co/docs/v2/annexure`), fetched 2026-09-21. The docs publish no numeric rate limits.

**Trading API**
| Code | Type | Official meaning |
|---|---|---|
| DH-901 | Invalid Authentication | client id or access token invalid or expired |
| DH-902 | Invalid Access | no Data API subscription, or no access to Trading APIs |
| DH-903 | User Account | account problem; check the required segments are activated |
| DH-904 | Rate Limit | too many requests from one user |
| DH-905 | Input Exception | missing required fields, bad parameter values |
| DH-906 | Order Error | incorrect order request, cannot be processed |
| DH-907 | Data Error | cannot fetch data: bad parameters or no data |
| DH-908 | Internal Server Error | server could not process the request (rare) |
| DH-909 | Network Error | API could not reach the backend |
| DH-910 | Others | other reasons |

**Data API**
| Code | Meaning |
|---|---|
| 800 | Internal server error |
| 804 | Requested instrument count exceeds the limit |
| 805 | Too many requests or connections; further requests may block you |
| 806 | Data APIs not subscribed |
| 807 | Access token expired |
| 808 | Authentication failed: client id or token invalid |
| 809 | Access token invalid |
| 810 | Client id invalid |
| 811 | Invalid expiry date |
| 812 | Invalid date format |
| 813 | Invalid security id |
| 814 | Invalid request |

## What this repo has observed (differs from, or adds to, the table)
- **DH-905 covers much more than bad fields.** It is what a wrong id/segment pair returns (`BSE_IDX` history for SENSEX,
  `docs/API_GOTCHAS.md`), what a missing `dhanClientId` on a hand-rolled `/v2/margincalculator/multi` call returns, and what
  passing the raw master-list segment value `"E"` returned (`dhan_helper.py` comment). It also means **`"Invalid IP"`**: enforced only on
  transaction endpoints (POST/DELETE/modify `/v2/orders`). Read endpoints still return 200 from a non-whitelisted IP, so
  "the API works" is no evidence that orders will. Probe by DELETEing an already-CANCELLED order id: DH-905 back is an IP block.
  Fix at web.dhan.co (IP whitelist), then re-run `login.py`.
- **DH-902 on a data call is silent.** A lapsed Data API subscription makes history and intraday methods return an empty
  frame with no exception.
- **DH-906 appears on unrelated calls when the token is stale** (a newer login elsewhere revoked it before its claimed
  expiry), although the official meaning is an order error. See `dhan-auth-token-lifecycle`.
- **Which codes the helper treats as fatal**: `DhanHelper.is_fatal_error(err)` returns True for `DH-901`, `DH-902`, `DH-906`,
  error types `invalid_access` / `invalid_authentication`, and messages containing "invalid token", "token expired" or
  "unauthorized". Retrying other symbols or windows after a fatal error fails identically, so scripts stop.
  Callers: `csp_scanner.py`, `download_expired_options.py`, `trending_oi_fetch.py`.
- **HTTP 429** is backed off (30 s) by the helper, and the market-feed WebSocket reconnects with exponential backoff and jitter
  (the SDK's own loop otherwise sits in the 429 indefinitely). The quote API is about 1 request per second; batch with
  `helper.get_ltps()`.

## How errors reach your code
```python
df = helper.get_historical_data(...)
if df.empty:
    err = helper.last_api_error          # {"method", "code", "type", "message"} or None
    if DhanHelper.is_fatal_error(err):   # auth / subscription: stop, do not report "no data"
        raise RuntimeError(f"Dhan data API refused the request: {err}")
    # otherwise: genuinely no rows, or a per-request problem
```
The methods that record `last_api_error` set it back to `None` when they next succeed, so read it immediately after the empty result. `_record_api_error`
stores `code`, `type`, `message` from the response `remarks`, and uses `""` (not `None`) when Dhan sends null fields.
Scripts that report freshness ("up to date", "last sync") must surface it, or a lapsed subscription looks like a quiet market.

## Symptom to cause
| Symptom | Check first | Likely fix |
|---|---|---|
| Empty history / candles, no exception | `helper.last_api_error` | 902/806: subscription; 901/807-809: run `login.py`; 813: wrong security id or segment |
| LTP is `0.0` | market open? symbol/segment pair? WebSocket subscribed? | `instrument=` and `exchange=` on `get_ltp()`; SENSEX needs `IDX_I` id 51 for spot |
| Option chain empty | expiry format, underlying id | NIFTY options underlying is `26000`, SENSEX chain `1` / `BSE_FNO`; 811/812 for the expiry string |
| Reads work, orders fail with 905 | IP whitelist (transaction endpoints only) | whitelist the host; probe with the DELETE-a-cancelled-order trick |
| 906 on a call that has nothing to do with orders | token age | `dhan-auth-token-lifecycle`: revoked or previous-session token |
| 904 / 805 / HTTP 429 | how many pollers share the account | slow down, batch, use the WebSocket (`dhan-polling-guards` #6 and #11) |
| Order rejected, position not what you expect | your own tracked quantity vs broker net | `resolve_exit_qty*` (`dhan-new-strategy`), never the account net |
| 908 / 909 / 800 | transient | retry with backoff, cap retries, log the code |

## Rules
1. **Never treat an empty response as "no data".** Check `last_api_error` first (CLAUDE.md, "Data API failures are silent").
2. **Classify before retrying.** Fatal (auth, subscription) stops the run; rate limit backs off; input errors are your bug and
   retrying only burns quota.
3. **Do not branch on message text when a code exists**, but do keep the whole `last_api_error` in the log line.
4. **A failed order call is a stop, not a warning.** An order that returns no id must not be walked past
   (`dhan-new-strategy`, its `references/order-safety.md`).
5. **Do not probe with a real trade.** Use a zero-risk transaction probe (above) to test IP or permission problems.

## Related
`docs/API_GOTCHAS.md` (id/segment traps, SENSEX, DH-905 IP), `dhan-auth-token-lifecycle` (stale tokens, 06:00 IST cutoff),
`dhan-polling-guards` (rate limits, silent failures), `dhan-new-strategy` (order-failure handling).
