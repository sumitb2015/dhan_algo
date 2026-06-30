# Scalper WebSocket LTP Enrichment

**Date:** 2026-06-30  
**File:** `rs_dashboard/components/Scalper.tsx`

## Problem

The Positions tab shows `lastTradedPrice` and `unrealizedProfit` from a REST poll that runs every 5 seconds. The options WebSocket bridge already streams live LTPs for all subscribed strikes at 100ms intervals into `liveQuotes.strikes`. The guard monitor reads `pos.lastTradedPrice` from the same stale REST data, making SL/target triggers up to 5s late.

## Goal

Use existing WS LTP data to enrich position rows in real-time — no new API routes, no new WebSocket connections, no prop changes to child components.

## Scope

- **In scope:** Positions tab LTP + unrealizedProfit columns; guard monitor LTP responsiveness
- **Out of scope:** Orders tab, Trades tab, funds tab

## Assumptions

- All open positions are always on the currently selected expiry (user confirmed)
- `strikeMap` is populated before positions are shown (loaded on expiry change)
- `liveQuotes` flows at 100ms; enrichment recalculates on every update

## Design

### 1. Inverted security ID map (`secIdToStrikeSide`)

```ts
const secIdToStrikeSide = useMemo(() => {
  const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
  for (const [strike, ids] of Object.entries(strikeMap)) {
    if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
    if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
  }
  return map;
}, [strikeMap]);
```

Rebuilt only when `strikeMap` changes (once per expiry).

### 2. Enriched positions (`enrichedPositions`)

```ts
const enrichedPositions = useMemo(() => {
  if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
    return positionsData;

  return positionsData.map(pos => {
    const secId = String(pos.securityId ?? pos.security_id ?? '');
    const mapping = secIdToStrikeSide[secId];
    if (!mapping) return pos;                         // not in WS data — pass through

    const strikeData = liveQuotes.strikes[String(mapping.strike)];
    if (!strikeData) return pos;

    const liveLtp = strikeData[mapping.side]?.ltp ?? 0;
    if (liveLtp <= 0) return pos;

    const netQty = Number(pos.netQty);
    const buyAvg = Number(pos.buyAvg);
    const sellAvg = Number(pos.sellAvg);
    const unrealizedProfit = netQty === 0
      ? Number(pos.unrealizedProfit)
      : netQty > 0
        ? netQty * (liveLtp - buyAvg)
        : Math.abs(netQty) * (sellAvg - liveLtp);

    return { ...pos, lastTradedPrice: liveLtp, unrealizedProfit };
  });
}, [positionsData, liveQuotes, secIdToStrikeSide]);
```

Falls back to the original row when:
- `liveQuotes` not yet available
- `strikeMap` not yet loaded
- Position's security ID not found in inverted map
- WS LTP is 0 or missing

### 3. Wire-up (three substitutions)

| Location | Before | After |
|---|---|---|
| `PositionsTable` prop | `data={positionsData}` | `data={enrichedPositions}` |
| `positionsRef` sync effect | `positionsRef.current = positionsData` | `positionsRef.current = enrichedPositions` |
| `totalPnl` calculation | `.reduce(... positionsData ...)` | `.reduce(... enrichedPositions ...)` |

### Side effects (free)

- Guard monitor reads `positionsRef.current` which now contains live LTPs → SL/target/trail triggers fire within ~100ms instead of up to 5s
- `totalPnl` chip in header reflects live unrealized P&L

## Safety constraints

- Never mutate original `positionsData` — always spread (`{ ...pos, ... }`)
- Fall through to original row on any missing data — no crashes, no zeroes
- `enrichedPositions` depends on `liveQuotes` which is already validated (stale guard, expiry guard, empty-strikes guard) before being set
- REST poll (`pollTabData`) continues unchanged — it keeps `positionsData` current for fields not in WS (buyAvg, sellAvg, netQty, realizedProfit, productType)
