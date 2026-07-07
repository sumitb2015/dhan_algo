# % OTM Strangle Tab — Design Spec

**Date:** 2026-07-07  
**Status:** Approved  
**Scope:** Add a "% Strangle" tab to the existing Strategy Builder page (`/strategy-builder`). No changes to any existing builder tab behaviour.

---

## 1. Goal

Allow the user to sell a NIFTY strangle where each leg's strike is selected by specifying a percentage distance from the current spot price, rather than a fixed number of strike steps from ATM. The CE and PE percentages are set independently (asymmetric strangle). The tab supports live order placement, demo mode, and a payoff diagram — reusing all existing builder infrastructure.

---

## 2. Constraint: Zero impact on existing builder

The existing `'builder'`, `'saved'`, and `'positions'` tabs must be completely unmodified. All their state, handlers, and render paths remain exactly as they are today. The only mutations to `StrategyBuilder.tsx` are:

1. Widen the `activeTab` type from `'builder' | 'saved' | 'positions'` to include `'pct_strangle'`.
2. Add one tab button (`% Strangle`) to the tab bar.
3. Add one `else if (activeTab === 'pct_strangle')` render branch that mounts `<PctStrangleTab>`.

No existing state, `useEffect`, or callback is touched.

---

## 3. Architecture

```
StrategyBuilder.tsx          ← minimal changes only (see §2)
  └── PctStrangleTab.tsx     ← new, self-contained component
        uses:
          StrategySummaryPanel   (existing, unchanged)
          PayoffDiagram          (existing, unchanged)
          /api/options/order     (existing API route, unchanged)
```

`PctStrangleTab` receives read-only props derived from state already computed by the parent:

```ts
interface PctStrangleTabProps {
  spot: number;          // live Nifty spot price
  chainOc: ChainOc;      // option chain for selectedExpiry
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string; // nearest expiry (expiries[0].date)
}
```

The parent's `selectedExpiry` is already set to `expiries[0].date` on load by the existing `useEffect`, so the chain for the nearest expiry is ready when this tab is first rendered. No additional fetch is triggered by switching to this tab.

---

## 4. Strike Resolution

```
ceTargetRaw = spot × (1 + cePct / 100)
peTargetRaw = spot × (1 − pePct / 100)

ceStrike = round(ceTargetRaw / 50) × 50
peStrike = round(peTargetRaw / 50) × 50
```

Both strikes are looked up in `chainOc` (same map the builder uses) to retrieve:
- `last_price` (LTP)
- `implied_volatility`
- `greeks.delta`
- `security_id`

Resolution is **reactive** — no "Analyze" button. Legs recompute via `useMemo` whenever `cePct`, `pePct`, `lots`, or `chainOc` changes. If a computed strike is absent from the chain a clear inline warning is shown and the Enter Trade button is disabled.

---

## 5. `PctStrangleTab` Own State

| State | Type | Default | Purpose |
|---|---|---|---|
| `cePct` | number | 3.0 | % above spot for call strike |
| `pePct` | number | 2.0 | % below spot for put strike |
| `lots` | number | 1 | lot multiplier |
| `mode` | `'intraday' \| 'positional'` | `'intraday'` | order product type |
| `tradingType` | `'demo' \| 'live'` | `'demo'` | demo paper trade or real broker order |
| `entering` | boolean | false | order in-flight guard |
| `exiting` | boolean | false | exit order in-flight guard |
| `orderResult` | `{success, message} \| null` | null | result banner |

---

## 6. UI Layout (top to bottom)

### 6a. Controls row
Inline, single row:
- **Call OTM %** — numeric input (step 0.1, min 0.1, max 20), labelled "Call OTM %"
- **Put OTM %** — numeric input (step 0.1, min 0.1, max 20), labelled "Put OTM %"
- **Lots** — stepper (− / number / +), min 1
- **Mode** — segmented toggle: Intraday | Positional
- **Type** — segmented toggle: Demo | Live (Live shown in amber when active)

### 6b. Strike preview chips
Live chips that update as the % inputs change:

```
SELL CE  24750  +3.1% from spot    |    SELL PE  23500  −2.1% from spot
```

Each chip shows: option type badge, resolved strike (bold), actual % distance from spot (so user sees the exact % after rounding to the nearest 50).

If a strike is missing from the chain: chip turns red with text "Not in chain".

### 6c. Leg table
Same columns as the builder leg table:

| B/S | Expiry | Strike (with ±50 nudge buttons) | Type | LTP | IV | Delta | Lots |
|---|---|---|---|---|---|---|---|

The ±50 nudge buttons let the user fine-tune the strike after the % computes the initial value. Nudging updates `chainOc` lookup and recomputes stats.

### 6d. Stats + payoff
Renders `<StrategySummaryPanel>` and `<PayoffDiagram>` with the resolved legs — identical to how the builder uses them. Shows max profit (= net premium collected), max loss (Unlimited), breakevens, net premium per lot, POP.

### 6e. Action bar
- **Enter Trade** button — disabled when any leg is missing `securityId` or `entering` is true
- **Exit Trade** button — disabled when any leg is missing `securityId` or `exiting` is true
- Result banner (success = emerald, error = rose) — same styling as builder

---

## 7. Order Placement

Identical to the builder. POST to `/api/options/order`:

```json
{
  "legs": [
    { "securityId": "...", "quantity": lots * 75, "side": "SELL" },
    { "securityId": "...", "quantity": lots * 75, "side": "SELL" }
  ],
  "mode": "intraday"
}
```

Guard: if any leg has a null `securityId`, show error banner and do not send the request.

Demo mode: 500ms fake delay, sets success banner — no broker call. No localStorage persistence (unlike builder's positional demo trades — this tab is intraday-focused by default and doesn't need the Positions tab integration).

---

## 8. What is NOT in scope

- Expiry picker — always uses nearest expiry (already loaded by parent)
- Target / stoploss inputs — not needed for this simple strangle entry
- Save to Saved Strategies — not in scope
- Positional trades tab integration — not in scope
- BankNifty or other underlyings — NIFTY only, same as builder

---

## 9. Files changed

| File | Change |
|---|---|
| `rs_dashboard/components/StrategyBuilder.tsx` | Add `'pct_strangle'` tab (3 minimal edits, no existing logic touched) |
| `rs_dashboard/components/strategy/PctStrangleTab.tsx` | New component |
