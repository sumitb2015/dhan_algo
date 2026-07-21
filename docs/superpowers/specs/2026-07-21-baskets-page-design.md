# Baskets Page — Design Spec

**Date:** 2026-07-21
**Status:** Approved

## Problem / Goal

Add a new "Baskets" page: a quick-entry, predefined-strategy option order builder with a live payoff diagram, modeled on the Basket Order page from the sibling `kotak_algo` project (`kotak_algo/kotak_dashboard/components/Basket.tsx`, `lib/strategies.ts`, `PayoffChart.tsx`). This is distinct from the existing `/strategy-builder` page (`components/StrategyBuilder.tsx`), which is a deeper per-template analysis tool (margin, IV/Delta, backend-saved strategies) with a fixed leg count per template and no free-form leg editing. Baskets is the fast, free-form counterpart: pick a category → pick a template → legs populate instantly → tweak freely → place.

## Scope

- **In scope**: a new `/baskets` page with category-tabbed predefined strategy templates, a free-form leg table (add/remove/flip any leg), a live payoff-at-expiry chart, a multiplier control, localStorage save/load of baskets, and buy-then-sell sequenced order placement across both Dhan and Zerodha.
- **Out of scope**: margin calculation (not available from either broker's API in this flow, same limitation Kotak's page already accepts), T+0 (today's) payoff curve — expiry payoff only, backend-persisted baskets (localStorage only, per Q&A below), and any changes to `/strategy-builder` or its components.

## Architecture

Port Kotak's UI and payoff math wholesale; replace only the data-fetching and order-placement layer with this dashboard's existing infrastructure.

### Page & navigation
- `rs_dashboard/app/baskets/page.tsx` — thin wrapper, same pattern as `app/scalper/page.tsx`, rendering `<Baskets />`.
- `rs_dashboard/components/Baskets.tsx` — the page component; renders `<NavBar />` itself (pages don't get NavBar from the root layout).
- Add `{ href: '/baskets', label: 'Baskets', desc: '...' }` to the "Derivatives" group in `NavBar.tsx`, alongside `/scalper` and `/strategy-builder`.

### Templates & payoff math
- New `rs_dashboard/lib/basketStrategies.ts` — direct port of Kotak's `lib/strategies.ts`: the 4 categories (`Bullish`, `Bearish`, `Range Bound`, `Big Move`), all 17 templates, and the pure functions `computePayoff`, `legPnlAtExpiry`, `nearestStrike`, `strikeStep`, `daysToExpiry`. No broker/API dependency — ports verbatim.
- New `rs_dashboard/components/BasketPayoffChart.tsx` — direct port of Kotak's `PayoffChart.tsx` (pure SVG, zero external deps, only needs `{points, breakevens, spot}`).

### Data layer
- Broker selection: `useBrokerSelector()` (existing hook), same as `Scalper.tsx`.
- Underlying selection: new dropdown state, options `NIFTY | BANKNIFTY | SENSEX` (matching Scalper's existing underlying list).
- Expiry list: `GET /api/options/expiries?underlying=...&broker=...` (existing route, already broker-aware).
- Option chain (strikes, prev close, spot): `GET /api/options/chain?underlying=...&expiry=...&broker=...` (existing route, already broker-aware).
- Live LTP: `useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying)` (existing hook).
- Strike → order-identifier lookup, branched by broker:
  - Dhan: `GET /api/scalper/lookup?underlying=...&expiry=...` → `{ lotSize, strikes: { [strike]: { ceId?, peId? } } }`.
  - Zerodha: `GET /api/scalper/zerodha/lookup?underlying=...&expiry=...` → `{ lotSize, strikes: { [strike]: { ceSymbol?, peSymbol? } } }`.
- Funds display: `GET /api/scalper/funds` for Dhan, `GET /api/scalper/zerodha/funds` for Zerodha, branched the same way `Scalper.tsx` already does. If the selected broker's funds call fails or returns an unrecognized shape, hide the funds tile rather than showing a wrong/zero value.

### Legs table (free-form, ported from Kotak)
- Each leg: side (B/S, click to flip), option (CE/PE, click to flip), strike (stepper through `allStrikes`), lots (stepper), order type (MARKET/LIMIT dropdown), price (manual override input, empty = follow live LTP), live LTP display, remove button.
- "Add Leg" button appends a blank ATM leg; any leg can be removed independently — this is the key difference from Strategy Builder's fixed-leg-count-per-template model.
- Applying a template replaces all current legs with the template's legs, each strike resolved as `nearestStrike(allStrikes, atmStrike + offset * step)`.
- A multiplier stepper (1–20) scales every leg's quantity (`lots * multiplier * lotSize`) without needing to re-pick a template.

### Payoff panel
- Metrics tiles: Net Premium (credit/debit), Max Profit, Max Loss, Breakeven(s), Risk:Reward, Days Left — same as Kotak's, computed from `computePayoff`.
- `BasketPayoffChart` renders the expiry P&L curve, spot marker, breakeven markers, and a hover crosshair/tooltip.

### Save / load (localStorage)
- Key: `basket_saved_v2` (reuse Kotak's key/version — no migration needed since this is a new page in a different project with no existing data).
- Each saved basket stores `{ name, category, strategy, multiplier, underlying, legs: [{ side, option, lots, type, offset }] }` — legs stored as ATM-relative offsets, not absolute strikes.
- **New vs. Kotak**: `underlying` is stored per basket (Kotak only ever has NIFTY). On load, if the saved basket's `underlying` differs from the currently selected one, switch the page's underlying selector to match before re-anchoring offsets to the new ATM — never silently apply e.g. a NIFTY-derived offset basket against BANKNIFTY strikes.
- Re-anchoring on load: `strike = nearestStrike(allStrikes, atmStrike + offset * step)`, same as Kotak.

### Order placement
- Confirm-before-placing double-click guard (click "Place Basket" once arms a 4-second confirm state, second click within that window actually places), same as Kotak.
- Order sequencing: all BUY legs first, then all SELL legs (margin-friendly ordering) — matches Kotak.
- Stop-on-first-failure: if any leg's order fails or comes back `unknown` (ambiguous — e.g. timeout after submission), halt the remaining legs immediately and surface a toast telling the user to check Orders manually before retrying. Do not attempt automatic rollback of already-placed legs (matches Kotak's existing behavior — a partially-filled basket needs human judgment, not an automated unwind that could itself fail or double-execute).
- Broker branching per leg:
  - Dhan: resolve `ceId`/`peId` from the Dhan lookup response, place via `POST /api/scalper/fast-order` with `{ securityId, quantity, side, orderType, price? }`.
  - Zerodha: resolve `ceSymbol`/`peSymbol` from the Zerodha lookup response, place via `POST /api/scalper/zerodha/order` with `{ tradingsymbol, quantity, side, orderType, price? }`.

## Error handling / edge cases

- Strikes/chain not yet loaded when the user tries to apply a template or add a leg: toast error, no-op (matches Kotak).
- LIMIT leg with no resolvable price (manual override empty and no live/prev-close LTP available): block placement with a toast identifying the specific leg.
- Saving a basket before the option chain has loaded (ATM unknown, so offsets can't be computed): blocked with a toast.
- Broker token expired mid-session: the relevant lookup/order call fails and surfaces as a toast, same as every other broker-aware page in this dashboard — no special-case handling.
- Zerodha's lookup cache miss/stale (per-underlying instrument cache older than 24h or missing): existing `/api/scalper/zerodha/lookup` route already regenerates it on demand; Baskets doesn't need to special-case this, just handle a `{success:false}` response as "chain not ready" the same way it handles a slow Dhan lookup.

## Testing

- Manual, both brokers authenticated: apply each of the 17 templates under each category and confirm legs populate at the expected ATM-relative strikes; confirm the payoff chart and metrics tiles update correctly for at least one credit strategy (short straddle) and one debit strategy (long strangle).
- Save a basket under NIFTY, switch underlying to BANKNIFTY, confirm loading the saved basket switches back to NIFTY and re-anchors correctly to the current ATM.
- Place a 1-lot dry confirmation-only test (do not actually submit in production) to confirm the buy-then-sell sequencing and confirm-before-placing guard behave as designed; verify a deliberately-triggered failed leg (e.g. invalid LIMIT price) halts the basket and leaves remaining legs unplaced.
- Confirm broker switch mid-session (if the user switches broker after loading the chain) re-resolves lookups against the new broker rather than reusing stale Dhan/Zerodha identifiers.
