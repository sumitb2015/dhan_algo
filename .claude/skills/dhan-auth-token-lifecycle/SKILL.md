---
name: dhan-auth-token-lifecycle
description: Use when touching login.py's get_dhan_client()/get_new_access_token*(), rs_dashboard/lib/session.ts's token/session helpers, scripts/tools/dhan_autologin.py, or debugging "Failed to authenticate with Dhan" / DH-906 / stale-token symptoms. Covers cached-token validation, the daily 6AM IST session cutoff, and keeping the Python and Node copies of this logic in sync.
---

# Dhan Auth Token Lifecycle

## Overview
Three same-day commits (`7c9addc`, `9682736`, `33db64b`) each fixed a bug in the same
narrow piece of logic: whether a cached `access_token.json` should be trusted or a
fresh login forced. Each fix uncovered the next — active-verification added a real
`dhanhq()` call that wasn't assigned to a variable (`UnboundLocalError`, breaking
*every* cached-token login), and the daily-session cutoff logic was duplicated
almost line-for-line into `rs_dashboard/lib/session.ts` because the dashboard mints
its own `access_token.json` writes independent of `login.py`. This is a narrow,
easy-to-regress piece of logic — read this before touching it again.

## When to Use
- Editing `get_dhan_client()`, `get_new_access_token()`, `get_new_access_token_via_totp()`,
  or the token-freshness helpers (`get_token_issue_time`, `get_current_session_start`,
  `is_token_from_current_session`) in `login.py`.
- Editing `rs_dashboard/lib/session.ts`'s `writeDhanTokenFile`, `isDhanTokenValid`,
  `getSessionStartIst`, or `getTokenIssuedAt`.
- Debugging "Failed to authenticate with Dhan — run login.py first" when the token
  looks otherwise valid, or a `DH-906` rejection on an unrelated API call.
- Extending the daily-session-enforcement concept to Zerodha/Kotak autologin.

## Invariants

1. **Cached `expiryTime` is not authoritative.** Dhan can revoke a token
   server-side (e.g. a newer login elsewhere replaces it) before its claimed
   expiry. `get_dhan_client()` must probe with a real call (`dhan.get_holdings()`)
   before trusting a cached token, not just compare timestamps (`7c9addc`).
2. **Build the client before you call it.** The verification probe needs a real
   `dhanhq(dhan_context)` instance assigned to a variable — `dhan_context =
   DhanContext(...)` alone is not a client. This exact omission broke *every*
   cached-token login with `UnboundLocalError` for one commit (`33db64b`) — when
   adding any new pre-flight check that calls the SDK, grep for where `dhan` is
   assigned in the same branch before assuming it exists.
3. **Sessions reset daily at 06:00 IST, not on a rolling 24h timer.** A token
   issued yesterday morning that hasn't technically expired yet is still stale for
   today's trading session. `get_current_session_start()` / `getSessionStartIst()`
   compute "today's 06:00 IST" (or yesterday's, if `now` is before 06:00 IST) and
   any token issued before that cutoff is rejected regardless of `expiryTime`
   (`9682736`).
4. **Token issuance time has a three-tier fallback**, identical in both languages:
   `createdAt` field (written at login time) → JWT `iat` claim decoded from the
   access token's payload → `expiryTime - 24h` estimate. Older cached tokens
   written before `createdAt` existed still need to resolve to *something* via
   the JWT or expiry fallback — don't assume `createdAt` is always present.
5. **`login.py` and `session.ts` are two independent implementations of the same
   rule**, because both the Python side and the Next.js dashboard's own login flow
   write `access_token.json`. A change to the session-cutoff or issuance-fallback
   logic in one **must** be mirrored in the other (`getSessionStartIst` mirrors
   `get_current_session_start`; `getTokenIssuedAt` mirrors `get_token_issue_time`).
   Grep both files before considering the change complete.
6. **Every write path must stamp `createdAt`.** `get_new_access_token()`,
   `get_new_access_token_via_totp()` (Python) and `writeDhanTokenFile()` (Node) all
   independently persist `access_token.json` — a new write path that skips
   `createdAt` breaks the primary tier of the issuance-time fallback for tokens it
   creates.

## Common Mistakes
- Adding a token-validity check that only compares `expiryTime` — always add the
  session-cutoff check too, or a token from a prior day survives past its stale
  point until it happens to hit a real expiry.
- Editing the cutoff/fallback logic in only one of `login.py` / `session.ts`.
- Introducing a new SDK pre-flight call without confirming the client variable it
  needs is actually constructed in that code path first.
- Forgetting `force_login` / equivalent bypass — `get_dhan_client(force_login=True)`
  must skip the cache read entirely, not just fail validation and fall through.
