# Scalper WebSocket LTP Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the Positions tab's `lastTradedPrice` and `unrealizedProfit` fields with live WebSocket LTP instead of the 5-second REST poll, and propagate that live LTP into the guard monitor.

**Architecture:** Two new `useMemo`s in `Scalper`: one inverts `strikeMap` into a `securityId → { strike, side }` lookup, the second overlays WS LTP onto `positionsData`. Three existing references to `positionsData` are replaced with `enrichedPositions`. No new files, no new API routes, no prop changes to child components.

**Tech Stack:** React (useMemo), TypeScript, existing `liveQuotes` + `strikeMap` state already in `Scalper.tsx`

## Global Constraints

- All changes are in `rs_dashboard/components/Scalper.tsx` only — do not touch any other file.
- Never mutate `positionsData` or any position row object — always spread.
- Fall through to the original row on any missing/zero data — no crashes, no silent zeroes.
- The REST poll (`pollTabData`) must continue unchanged.
- Do not change `PositionsTable`, `TabTable`, `FundsView`, or any other sub-component signature.

---

### Task 1: Add `secIdToStrikeSide` inverted map

**Files:**
- Modify: `rs_dashboard/components/Scalper.tsx` — add one `useMemo` after the existing derived-values block (around line 133)

**Interfaces:**
- Consumes: `strikeMap: Record<string, { ceId?: string; peId?: string }>` (existing state)
- Produces: `secIdToStrikeSide: Record<string, { strike: number; side: 'ce' | 'pe' }>` (used by Task 2)

- [ ] **Step 1: Locate the insertion point**

Open `rs_dashboard/components/Scalper.tsx`. Find the `// ─── Derived values` comment block (around line 132). The block currently ends after the `pePct` calculation (around line 151) and before `totalPnl` (line 153). Insert the new memo between `pePct` and `totalPnl`.

- [ ] **Step 2: Add the `secIdToStrikeSide` useMemo**

Insert immediately after the `pePct` line (line ~151) and before `totalPnl`:

```typescript
  const secIdToStrikeSide = useMemo(() => {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    for (const [strike, ids] of Object.entries(strikeMap)) {
      if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
      if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
    }
    return map;
  }, [strikeMap]);
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no errors related to `secIdToStrikeSide`.

- [ ] **Step 4: Commit**

```powershell
git add rs_dashboard/components/Scalper.tsx
git commit -m "feat(scalper): add inverted strikeMap for secId → strike+side lookup"
```

---

### Task 2: Add `enrichedPositions` useMemo

**Files:**
- Modify: `rs_dashboard/components/Scalper.tsx` — add one `useMemo` immediately after `secIdToStrikeSide`

**Interfaces:**
- Consumes: `positionsData`, `liveQuotes`, `secIdToStrikeSide` (from Task 1)
- Produces: `enrichedPositions: Record<string, unknown>[]` — same shape as `positionsData`, with `lastTradedPrice` and `unrealizedProfit` overridden when WS data is available

- [ ] **Step 1: Add the `enrichedPositions` useMemo**

Insert immediately after the closing `}, [strikeMap]);` of `secIdToStrikeSide` (still inside the derived-values block, before `totalPnl`):

```typescript
  const enrichedPositions = useMemo(() => {
    if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
      return positionsData;

    return positionsData.map(pos => {
      const secId = String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
      const mapping = secIdToStrikeSide[secId];
      if (!mapping) return pos;

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

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/Scalper.tsx
git commit -m "feat(scalper): add enrichedPositions useMemo — overlays WS LTP onto positionsData"
```

---

### Task 3: Wire up `enrichedPositions` in three places

**Files:**
- Modify: `rs_dashboard/components/Scalper.tsx` — replace three references to `positionsData`

**Interfaces:**
- Consumes: `enrichedPositions` (from Task 2)

- [ ] **Step 1: Replace `totalPnl` source**

Find (around line 153):
```typescript
  const totalPnl = positionsData.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0);
```

Replace with:
```typescript
  const totalPnl = enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0);
```

- [ ] **Step 2: Replace `positionsRef` sync effect**

Find (around line 337):
```typescript
  useEffect(() => { positionsRef.current = positionsData; }, [positionsData]);
```

Replace with:
```typescript
  useEffect(() => { positionsRef.current = enrichedPositions; }, [enrichedPositions]);
```

- [ ] **Step 3: Replace `PositionsTable` data prop**

Find (around line 928):
```typescript
            <PositionsTable
              data={positionsData}
```

Replace with:
```typescript
            <PositionsTable
              data={enrichedPositions}
```

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```powershell
cd rs_dashboard
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Verify no remaining unintended uses of `positionsData` in JSX**

Search the file for `positionsData` — it should only appear in:
- `setPositionsData(...)` calls (state setter — correct)
- `fetchTabData` and `pollTabData` callbacks (setter — correct)
- The `enrichedPositions` useMemo dependency array (correct)
- Tab count badge: `positionsData` in the tab button label — this is intentional (shows count of rows, not LTP values), leave it as-is
- `positionsData.length > 0` check for the P&L chip visibility — leave as-is

```powershell
Select-String -Path rs_dashboard/components/Scalper.tsx -Pattern "positionsData" | Select-Object LineNumber, Line
```

Confirm none of the remaining hits are feeding LTP or P&L into the UI except through `enrichedPositions`.

- [ ] **Step 6: Manual smoke test**

Start the dashboard:
```powershell
cd rs_dashboard
npm run dev
```

Open `http://localhost:3000/scalper` with live market hours active. Confirm:
1. Positions tab shows LTP values updating in real-time (visibly changing faster than every 5s)
2. Unrealized P&L column changes in sync with LTP
3. Total P&L chip in the header updates in real-time
4. Positions with no WS match (none expected, but handle edge case) show `—` from original row, not 0
5. Orders, Trades, Funds tabs are unchanged
6. Guard monitor (if a SL or target is set) triggers within ~1s of price crossing the level

- [ ] **Step 7: Commit**

```powershell
git add rs_dashboard/components/Scalper.tsx
git commit -m "feat(scalper): wire enrichedPositions to table, guard monitor, and P&L chip"
```
