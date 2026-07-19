# Task 10 Report: Wire broker selector into AdvancedScalper.tsx

## Summary

All 9 code steps from the brief applied to `rs_dashboard/components/AdvancedScalper.tsx`, mirroring Task 9's pattern in `Scalper.tsx`, adapted to the box-based UI.

## Steps applied

1. **Import** — added `import { useBrokerSelector, brokerRoute } from '@/hooks/useBrokerSelector';` after the `ProfitLock` import.
2. **strikeMap type + broker state** — `strikeMap` broadened to include `ceSymbol?`/`peSymbol?`; added `const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();` right after.
3. **Strike-lookup effect split** — proactively split out of the original expiry effect (chain-fetch + WS bridge start/stop stay keyed on `[expiry]` only) into a new effect keyed on `[expiry, broker]`:

```ts
// Re-resolves strikeMap (Dhan securityId / Zerodha tradingsymbol per strike)
// whenever the expiry OR the selected broker changes. Kept separate from
// the chain-fetch/WS-bridge effect above so a broker switch alone doesn't
// restart the live-quotes WebSocket bridge, which stays Dhan-sourced
// regardless of the selected broker.
useEffect(() => {
  if (!expiry) return;

  const requestedExpiry = expiry;
  const lookupUrl = brokerRoute(
    broker,
    `/api/scalper/lookup?underlying=NIFTY&expiry=${expiry}`,
    `/api/scalper/zerodha/lookup?expiry=${expiry}`,
  );
  fetch(lookupUrl)
    .then(r => r.json())
    .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }> } }) => {
      if (requestedExpiry !== expiryRef.current) return;
      if (j.success && j.data) {
        setStrikeMap(j.data.strikes);
        setLotSize(j.data.lotSize);
      }
    })
    .catch(() => {});
}, [expiry, broker]);
```

   The original expiry effect keeps its `setStrikeMap({})` reset (for immediate UI feedback on expiry change) and remains keyed on `[expiry]` only — the lookup fetch, its `requestedExpiry`/`expiryRef` staleness guard, and the surrounding logic were removed from it and moved verbatim (with `broker` branching added) into the new effect. The chain-fetch and WS bridge start/stop in the original effect are untouched.

4. **placeOrder branching** — `strikeMap[String(box.strike)]` captured once as `entry`; branches on `broker === 'zerodha'` to POST `tradingsymbol` to `/api/scalper/zerodha/order` (bailing out with a toast if `ceSymbol`/`peSymbol` isn't resolved yet), else keeps the existing Dhan fast-order/slow-order fallback logic unchanged. Dependency array updated to `[boxes, expiry, lotSize, strikeMap, orderMode, broker, addToast, fetchTabData]`.
5. **closePosition branching** — live-position refetch now uses `brokerRoute(broker, '/api/scalper/positions', '/api/scalper/zerodha/positions')`; the close order POST uses `brokerRoute(broker, '/api/scalper/fast-order', '/api/scalper/zerodha/order')` with body branching on `broker === 'zerodha'` (`tradingsymbol` vs `securityId`). Dependency array updated to `[broker, addToast, fetchTabData]`.
6. **handleExitAll branching** — branches on `broker === 'zerodha'` to POST `/api/scalper/zerodha/exit-all` (handles `{success, closed, errors}` shape) vs. the existing `/api/exit-all` broker_exit handling for Dhan. Dependency array updated to `[confirmExitAll, broker, addToast, fetchTabData]` per the brief.
7. **fetchTabData/pollTabData** — both now call `brokerRoute(broker, ...)` against `/api/scalper/all` / `/api/scalper/zerodha/all` and `/api/scalper/poll` / `/api/scalper/zerodha/poll` respectively, each with `broker` added to its own dependency array. Confirmed (per brief) there is no separate `pollFunds` in this file — funds come from `fetchTabData`'s `/api/scalper/all` response only, so no third function needed changing.
8. **Clear stale data on broker switch** — new effect added after the poll-loop effect and the ref-sync effects:

```ts
// Clear stale data immediately on broker switch so a Dhan position is
// never displayed or acted on as if it belonged to Zerodha (or vice versa).
useEffect(() => {
  setPositionsData([]);
  setOrdersData([]);
  setTradesData([]);
  setFundsData(null);
  setStrikeMap({});
}, [broker]);
```

9. **Broker dropdown** — inserted immediately before the `{/* Exit ALL Positions (broker-level nuclear) */}` comment:

```tsx
{/* Broker selector — only shown when more than one broker is authenticated */}
{authenticatedBrokers.length > 1 && (
  <select
    value={broker}
    onChange={e => setBroker(e.target.value as 'dhan' | 'zerodha')}
    className="px-2 py-1.5 rounded-lg text-xs font-bold bg-zinc-900 border border-zinc-700 text-zinc-300"
  >
    {authenticatedBrokers.includes('dhan') && <option value="dhan">Dhan</option>}
    {authenticatedBrokers.includes('zerodha') && <option value="zerodha">Zerodha</option>}
  </select>
)}
```

## Verification

- `npx tsc --noEmit` (from `rs_dashboard/`): only 3 pre-existing, unrelated errors surfaced (`hooks/brokerRoute.test.ts`, `lib/zerodhaShape.test.ts`, `lib/zerodhaToken.test.ts` — all TS5097 "import path can only end with .ts" in test files, unrelated to this task and not touched by it). Zero errors in `AdvancedScalper.tsx`.
- `curl -b "dhan_session=..." http://localhost:3000/advanced-scalper` → HTTP 200, `<title>NIFTY Advanced Scalper</title>` present, no `Failed to compile` / `Unhandled Runtime Error` / Next.js error-overlay markers in the response body.
- Grepped every `broker` occurrence in the final file (see below) to confirm all call sites branch on it and every `useCallback`/`useEffect` referencing `broker` in its body lists it in the dependency array: `[expiry, broker]` (lookup effect), `[broker]` (fetchTabData, pollTabData, clear-on-switch effect), `[boxes, expiry, lotSize, strikeMap, orderMode, broker, addToast, fetchTabData]` (placeOrder), `[broker, addToast, fetchTabData]` (closePosition), `[confirmExitAll, broker, addToast, fetchTabData]` (handleExitAll).

## Files changed

- `rs_dashboard/components/AdvancedScalper.tsx` (only file modified)

## Self-review findings

- No stray reference to the old single `secId`/no-`entry` pattern remains — `placeOrder` now reads `strikeMap[...]` once into `entry` and both branches derive from it, matching `Scalper.tsx`'s pattern exactly.
- `boxSecId` (used by `removeBox` and the box-position lookup) has been updated to branch on `broker`: for Zerodha, it looks up `ceSymbol` / `peSymbol` (tradingsymbol) from the strikeMap, matching the positions mapped by `positionJoinKey` (using `tradingSymbol`). This fixes the bug where boxes could never be removed under Zerodha because `ceId`/`peId` were always undefined.
- Confirmed the chain-fetch effect (kept keyed on `[expiry]` only) no longer contains any lookup/strikeMap-populating fetch — the `setStrikeMap({})` reset line remains there (immediate UI feedback that "loading" state should show on expiry change), while actual repopulation happens only in the new `[expiry, broker]` effect.
- Confirmed no edits were made to `Scalper.tsx`, `middleware.ts`, any Zerodha backend route file, or `useBrokerSelector.ts`.
- No live orders were placed; verification was via tsc, curl, and code reading only.

## Zerodha Box Join-Key Bugfix Details

The following changes were made to fix the join-key mismatch under Zerodha:
1. **`secIdToStrikeSide`**: Branched key population on `broker === 'zerodha'` to map from `ceSymbol`/`peSymbol` instead of `ceId`/`peId`.
2. **`positionJoinKey`**: Added a helper that returns `pos.tradingSymbol` for Zerodha, and `pos.securityId`/`pos.security_id` for Dhan.
3. **`enrichedPositions` & `positionsBySecId`**: Utilized `positionJoinKey(pos)` for identifying positions.
4. **`boxSecId`**: Branched to return `ceSymbol`/`peSymbol` for Zerodha, and `ceId`/`peId` for Dhan.

This ensures that under Dhan (`broker === 'dhan'`), all behavior remains exactly byte-for-byte identical to the original implementation (falling back to Dhan security IDs), while under Zerodha it correctly matches positions by their tradingsymbol strings.

## Concerns

None. The dev server was left running and untouched throughout.

