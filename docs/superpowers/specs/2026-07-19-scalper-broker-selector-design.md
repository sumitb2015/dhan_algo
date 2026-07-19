# Scalper Broker Selector — Design Spec

**Date:** 2026-07-19
**Status:** Approved

## Problem / Goal

The Scalper and Advanced Scalper terminals (`components/Scalper.tsx`, `components/AdvancedScalper.tsx`) are hardcoded to Dhan for every trading action: order entry, closing a position, Exit All, and the Positions/Orders/Trades/Funds polling that feeds the panel. Add a broker selector so the user can choose Dhan or Zerodha and have all of those actions route to that broker's own API — one broker in use per session, not simultaneous multi-broker trading. Only brokers with a currently valid/authenticated session should appear as choices.

## Scope

- **In scope**: order entry (buy/sell), closing a single position, Exit All, and the positions/orders/trades/funds panel — all routed to whichever broker is selected.
- **Out of scope**: live quotes / option-chain / strike data — these stay Dhan-sourced regardless of the selected broker (only execution switches, not market data).
- **Out of scope**: the dashboard-wide `/api/exit-all` route (kills Dhan strategy processes) is untouched; the Zerodha Exit All is a separate, scalper-local action with no process-killing behavior since Zerodha has no dashboard-tracked strategy processes today.

## Architecture

Add a broker dimension to the scalper's existing routes rather than rewriting them. Dhan's fast REST-call pattern (already proven: `/api/scalper/fast-order`, `/api/scalper/all`, `/api/scalper/poll`, `/api/scalper/funds`, `/api/exit-all`) is left untouched. Zerodha gets sibling routes and a sibling Node REST client under `/api/scalper/zerodha/*`, using the official Kite Connect REST API (confirmed working end-to-end as of this session — orders/positions/margins/instruments all functional under the renewed Kite Connect app). A `broker` state value (`'dhan' | 'zerodha'`) in each scalper component decides which route set every action calls.

## New backend pieces

1. **`GET /api/auth/broker-status`** → `{ dhan: boolean, zerodha: boolean }`.
   - Dhan: reuse `isDhanTokenValid()` from `rs_dashboard/lib/session.ts`.
   - Zerodha: new `isZerodhaTokenValid()` (same file or a new `lib/zerodhaSession.ts`), reading `zerodha_access_token.json` at `PROJECT_ROOT`, same expiry-check shape as Dhan's (`expiryTime < now` → false).
   - This is the single source of truth for "authenticated" — the broker dropdown only lists entries where this is `true`.

2. **`rs_dashboard/lib/zerodhaToken.ts`** (mirrors `dhanToken.ts`): reads `zerodha_access_token.json`, exposes `getZerodhaCredentials()` → `{ apiKey, accessToken }`, cached 5 minutes (re-read on TTL expiry, same pattern as `getDhanCredentials()`). All Zerodha REST calls authenticate via header `Authorization: token {apiKey}:{accessToken}`, base URL `https://api.kite.trade`.

3. **Zerodha instrument cache** (strike + expiry → tradingsymbol/instrument_token/lot_size, since Zerodha has no numeric securityId like Dhan):
   - New script `scripts/tools/zerodha_instruments_cache.py`: builds a `KiteConnect` session from the same access-token file, calls `kite.instruments("NFO")`, filters to `name == "NIFTY"` option rows, writes `debug/zerodha_nifty_instruments.json` (array of `{tradingsymbol, instrument_token, strike, expiry, instrument_type, lot_size}`).
   - New route `GET /api/scalper/zerodha/lookup?expiry=YYYY-MM-DD` reads that cache; if missing or older than 24h, regenerates it first by spawning the script (same `dedupe()` + in-memory TTL cache pattern already used in `/api/scalper/lookup/route.ts`). Response shape matches the existing lookup contract: `{ success, data: { lotSize, strikes: { [strike]: { ceSymbol?, peSymbol? } } } }` (using `ceSymbol`/`peSymbol` instead of Dhan's `ceId`/`peId`, since Zerodha orders are placed by tradingsymbol, not numeric ID).

4. **Order/position routes**, one Zerodha sibling per Dhan route the scalper already calls:
   - `POST /api/scalper/zerodha/order` — direct REST to Kite Connect's `POST /orders/regular`, given `{ tradingsymbol, quantity, side, orderType, price? }`. Mirrors `fast-order`'s validation (positive integer qty, BUY/SELL, LIMIT requires price>0).
   - `GET /api/scalper/zerodha/all` and `GET /api/scalper/zerodha/poll` — call Kite `GET /portfolio/positions`, `GET /orders`, `GET /orders/trades`, reshaped to the same `{ success, positions, orders, trades }` contract the panel already renders, so no changes needed to the table-rendering JSX.
   - `GET /api/scalper/zerodha/funds` — Kite `GET /user/margins`, reshaped to whatever subset of fields the funds tab currently reads from Dhan's `/fundlimit`.
   - `POST /api/scalper/zerodha/exit-all` — fetch `kite.positions()['net']` equivalent via REST, place one offsetting MARKET order per non-zero-quantity position. No strategy-process logic (that's Dhan-only and irrelevant here).

## Frontend changes (`Scalper.tsx` + `AdvancedScalper.tsx`, identical pattern in both)

- New `broker` state (`'dhan' | 'zerodha'`), always defaults to `'dhan'` on mount — no localStorage persistence.
- On mount, fetch `/api/auth/broker-status`; render the broker dropdown only if more than one broker is authenticated (if only Dhan, don't show a dropdown at all — nothing to choose).
- Every existing broker-specific fetch call gets a small branch on `broker`:
  - `placeOrder` → `/api/scalper/fast-order` vs `/api/scalper/zerodha/order`
  - `closePosition` / Exit All → Dhan path vs `/api/scalper/zerodha/exit-all`
  - `fetchTabData` / `pollTabData` / `pollFunds` → `/api/scalper/all|poll|funds` vs `/api/scalper/zerodha/all|poll|funds`
  - the strike→ID lookup effect → `/api/scalper/lookup` vs `/api/scalper/zerodha/lookup`
- **On broker switch**: immediately clear `positionsData`, `ordersData`, `tradesData`, `fundsData`, and `strikeMap` before the next poll lands, so stale data from the previous broker is never displayed or acted on as if it belonged to the newly selected one.
- Lot size for order sizing comes from whichever lookup response is active (`lotSize` field) rather than the hardcoded `75` — Zerodha's lot size for the same contract may differ from Dhan's.

## Error handling / edge cases

- Broker token expires mid-session (e.g. Zerodha session lapses while scalper is open): next poll/order attempt just surfaces the Kite REST auth error as a toast, same UX as an expired Dhan token today. No special-case handling needed.
- None of the new Zerodha routes require the Historical Data API permission (only `orders`/`positions`/`margins`/`instruments`) — already confirmed working under the renewed subscription.
- If the Zerodha instrument cache fails to build (e.g. no options found for requested expiry), `/api/scalper/zerodha/lookup` returns `{ success: false, error }` and the UI falls back to disabling the Buy/Sell buttons for that broker, same as today's Dhan "strikeMap not yet loaded" gating.

## Testing

- Manual, with both brokers authenticated: confirm the dropdown shows both; place a 1-lot Zerodha order during market hours and confirm it appears in Zerodha's Kite app; confirm Exit All only closes the selected broker's positions and leaves the other broker's positions/processes untouched.
- Re-run existing Dhan flows unchanged (fast-order, exit-all, position polling) to confirm zero regression — Dhan code paths are not modified, only added alongside.
- Confirm the broker dropdown is hidden/single-option when only one broker is authenticated (e.g. Zerodha token expired).
