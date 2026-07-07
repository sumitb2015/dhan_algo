# % OTM Strangle Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "% Strangle" tab to the Strategy Builder that lets the user sell a NIFTY strangle by specifying independent percentage distances from spot for the CE and PE strikes, with live order placement.

**Architecture:** A new self-contained `PctStrangleTab` component handles all state and logic; it receives read-only shared data (spot, chainOc, expiries) from the parent `StrategyBuilder`. Three minimal edits to `StrategyBuilder.tsx` wire the tab in. No existing builder logic is touched.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, Tailwind CSS, Recharts (via existing PayoffDiagram), existing `/api/options/order` route.

## Global Constraints

- NIFTY only — `LOT_SIZE = 75`, `STRIKE_STEP = 50`
- Strike rounding: `round(rawTarget / 50) * 50`
- No changes to existing builder tab state, handlers, effects, or render paths
- Follow existing dashboard text-color conventions: no Tailwind slash-opacity on text (use `text-zinc-400` not `text-zinc-400/70`)
- Table headers: `text-xs font-bold text-white bg-zinc-800`
- Working directory for all commands: `c:\dhan_algo\dhan_algo\rs_dashboard`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `components/strategy/PctStrangleTab.tsx` | **Create** | Full % strangle UI: controls, strike chips, leg table, stats, payoff, order actions |
| `components/StrategyBuilder.tsx` | **Modify** (3 lines) | Add `'pct_strangle'` to tab type, tab button, render branch |

---

## Task 1: Create `PctStrangleTab.tsx`

**Files:**
- Create: `rs_dashboard/components/strategy/PctStrangleTab.tsx`

**Interfaces:**
- Consumes from `@/lib/optionsStrategy`: `ChainOc`, `ResolvedLeg`, `STRIKE_STEP`, `computePayoffStats`, `buildPayoffCurve`, `findBreakevens`
- Consumes: `StrategySummaryPanel` (props: `stats`, `targetBreakevens`, `breakevenMode`, `onBreakevenModeChange`, `margin`, `marginLoading`, `spot`)
- Consumes: `PayoffDiagram` (props: `curve`, `currentSpot`, `breakevens`)
- Consumes: `/api/options/order` POST `{ legs: [{securityId, quantity, side}], mode }`
- Produces: `export default function PctStrangleTab(props: PctStrangleTabProps)` — used by Task 2

- [ ] **Step 1: Create the file with full implementation**

Create `rs_dashboard/components/strategy/PctStrangleTab.tsx` with this exact content:

```tsx
'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  ChainOc, ResolvedLeg,
  computePayoffStats, buildPayoffCurve, findBreakevens,
  STRIKE_STEP,
} from '@/lib/optionsStrategy';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';

const LOT_SIZE = 75;

export interface PctStrangleTabProps {
  spot: number;
  chainOc: ChainOc;
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string;
}

function resolveToLeg(
  spot: number,
  pct: number,
  type: 'CE' | 'PE',
  chainOc: ChainOc,
  lots: number,
  strikeOverride?: number,
): ResolvedLeg | null {
  const raw = type === 'CE' ? spot * (1 + pct / 100) : spot * (1 - pct / 100);
  const strike = strikeOverride ?? Math.round(raw / STRIKE_STEP) * STRIKE_STEP;
  const entry =
    chainOc[String(strike)] ??
    Object.entries(chainOc).find(([k]) => Math.abs(parseFloat(k) - strike) < 0.01)?.[1];
  const legData = type === 'CE' ? entry?.ce : entry?.pe;
  if (!legData || typeof legData.last_price !== 'number') return null;
  return {
    strike,
    type,
    side: 'SELL',
    qtyLots: lots,
    price: legData.last_price,
    delta: legData.greeks?.delta ?? null,
    iv: legData.implied_volatility ?? null,
    securityId: legData.security_id ? String(legData.security_id) : null,
  };
}

export default function PctStrangleTab({ spot, chainOc, expiries, selectedExpiry }: PctStrangleTabProps) {
  const [cePct, setCePct] = useState(3.0);
  const [pePct, setPePct] = useState(2.0);
  const [lots, setLots] = useState(1);
  const [mode, setMode] = useState<'intraday' | 'positional'>('intraday');
  const [tradingType, setTradingType] = useState<'demo' | 'live'>('demo');
  const [ceStrikeOverride, setCeStrikeOverride] = useState<number | undefined>(undefined);
  const [peStrikeOverride, setPeStrikeOverride] = useState<number | undefined>(undefined);
  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [orderResult, setOrderResult] = useState<{ success: boolean; message: string } | null>(null);
  const [breakevenMode, setBreakevenMode] = useState<'target' | 'expiry'>('expiry');

  const celeg = useMemo(
    () => resolveToLeg(spot, cePct, 'CE', chainOc, lots, ceStrikeOverride),
    [spot, cePct, chainOc, lots, ceStrikeOverride],
  );
  const peleg = useMemo(
    () => resolveToLeg(spot, pePct, 'PE', chainOc, lots, peStrikeOverride),
    [spot, pePct, chainOc, lots, peStrikeOverride],
  );

  const resolvedLegs = useMemo<ResolvedLeg[]>(
    () => [celeg, peleg].filter((l): l is ResolvedLeg => l !== null),
    [celeg, peleg],
  );

  const stats = useMemo(
    () => (resolvedLegs.length === 2 ? computePayoffStats(resolvedLegs, spot, LOT_SIZE) : null),
    [resolvedLegs, spot],
  );

  const curve = useMemo(
    () => (resolvedLegs.length === 2 ? buildPayoffCurve(resolvedLegs, spot, LOT_SIZE) : []),
    [resolvedLegs, spot],
  );

  const breakevens = useMemo(() => findBreakevens(curve), [curve]);

  const ceDefaultStrike = Math.round((spot * (1 + cePct / 100)) / STRIKE_STEP) * STRIKE_STEP;
  const peDefaultStrike = Math.round((spot * (1 - pePct / 100)) / STRIKE_STEP) * STRIKE_STEP;
  const ceActualStrike = ceStrikeOverride ?? ceDefaultStrike;
  const peActualStrike = peStrikeOverride ?? peDefaultStrike;
  const ceActualPct = spot > 0 ? ((ceActualStrike - spot) / spot * 100) : 0;
  const peActualPct = spot > 0 ? ((spot - peActualStrike) / spot * 100) : 0;

  const handleNudgeStrike = useCallback((type: 'CE' | 'PE', dir: 1 | -1) => {
    setOrderResult(null);
    if (type === 'CE') {
      setCeStrikeOverride(prev => (prev ?? ceDefaultStrike) + dir * STRIKE_STEP);
    } else {
      setPeStrikeOverride(prev => (prev ?? peDefaultStrike) + dir * STRIKE_STEP);
    }
  }, [ceDefaultStrike, peDefaultStrike]);

  const handleCePctChange = (v: number) => {
    setCePct(v);
    setCeStrikeOverride(undefined);
    setOrderResult(null);
  };

  const handlePePctChange = (v: number) => {
    setPePct(v);
    setPeStrikeOverride(undefined);
    setOrderResult(null);
  };

  const canEnter = resolvedLegs.length === 2 && resolvedLegs.every(l => l.securityId !== null) && !entering;
  const canExit = resolvedLegs.length === 2 && resolvedLegs.every(l => l.securityId !== null) && !exiting;

  const handleEnterTrade = useCallback(() => {
    if (!canEnter) return;
    setEntering(true);
    setOrderResult(null);

    if (tradingType === 'demo') {
      setTimeout(() => {
        setOrderResult({ success: true, message: 'Demo strangle entered (Paper Trade).' });
        setEntering(false);
      }, 500);
      return;
    }

    const legsPayload = resolvedLegs.map(l => ({
      securityId: l.securityId,
      quantity: l.qtyLots * LOT_SIZE,
      side: l.side,
    }));

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: { orderId: string }[]; error?: string }) => {
        if (json.success) {
          const ids = (json.data ?? []).map(o => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strangle entered. Order IDs: ${ids}` });
        } else {
          setOrderResult({ success: false, message: json.error ?? 'Order failed.' });
        }
      })
      .catch((err: unknown) => setOrderResult({ success: false, message: String(err) }))
      .finally(() => setEntering(false));
  }, [canEnter, tradingType, resolvedLegs, mode]);

  const handleExitTrade = useCallback(() => {
    if (!canExit) return;
    setExiting(true);
    setOrderResult(null);

    const legsPayload = resolvedLegs.map(l => ({
      securityId: l.securityId,
      quantity: l.qtyLots * LOT_SIZE,
      side: (l.side === 'BUY' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
    }));

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: { orderId: string }[]; error?: string }) => {
        if (json.success) {
          const ids = (json.data ?? []).map(o => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strangle exited. Order IDs: ${ids}` });
        } else {
          setOrderResult({ success: false, message: json.error ?? 'Exit failed.' });
        }
      })
      .catch((err: unknown) => setOrderResult({ success: false, message: String(err) }))
      .finally(() => setExiting(false));
  }, [canExit, resolvedLegs, mode]);

  const expiry = selectedExpiry || expiries[0]?.date || '';

  return (
    <div className="space-y-6">

      {/* Controls row */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="flex flex-wrap items-end gap-4">

          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Call OTM %</label>
            <input
              type="number" step="0.1" min="0.1" max="20"
              value={cePct}
              onChange={e => handleCePctChange(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="w-24 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm font-mono text-emerald-400 text-center focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Put OTM %</label>
            <input
              type="number" step="0.1" min="0.1" max="20"
              value={pePct}
              onChange={e => handlePePctChange(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="w-24 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm font-mono text-rose-400 text-center focus:outline-none focus:border-rose-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Lots</label>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setLots(l => Math.max(1, l - 1))}
                className="w-7 h-7 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded text-zinc-300 hover:bg-zinc-700 font-bold"
              >−</button>
              <span className="w-8 text-center font-mono text-sm text-white">{lots}</span>
              <button
                onClick={() => setLots(l => l + 1)}
                className="w-7 h-7 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded text-zinc-300 hover:bg-zinc-700 font-bold"
              >+</button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Mode</label>
            <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
              {(['intraday', 'positional'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={`px-3 py-1.5 font-medium capitalize ${mode === m ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                >{m}</button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Type</label>
            <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
              <button onClick={() => setTradingType('demo')}
                className={`px-3 py-1.5 font-medium ${tradingType === 'demo' ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
              >Demo</button>
              <button onClick={() => setTradingType('live')}
                className={`px-3 py-1.5 font-medium ${tradingType === 'live' ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
              >Live</button>
            </div>
          </div>

        </div>
      </div>

      {/* Strike preview chips */}
      <div className="flex flex-wrap items-center gap-4">
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold ${
          celeg ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-950 border-rose-800 text-rose-300'
        }`}>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">CE SELL</span>
          {celeg
            ? <><span className="font-mono">{ceActualStrike}</span><span className="text-zinc-400 text-xs ml-1">(+{ceActualPct.toFixed(1)}%)</span></>
            : <span className="text-xs">Strike {ceActualStrike} not in chain</span>
          }
        </div>

        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold ${
          peleg ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-rose-950 border-rose-800 text-rose-300'
        }`}>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400">PE SELL</span>
          {peleg
            ? <><span className="font-mono">{peActualStrike}</span><span className="text-zinc-400 text-xs ml-1">(−{peActualPct.toFixed(1)}%)</span></>
            : <span className="text-xs">Strike {peActualStrike} not in chain</span>
          }
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          <span>Expiry:</span>
          <span className="font-mono text-zinc-300">{expiry}</span>
        </div>
      </div>

      {/* Leg table */}
      {resolvedLegs.length > 0 && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider border-b border-zinc-800 pb-2">Strategy Legs</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-800">
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">B/S</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">Expiry</th>
                  <th className="px-3 py-2 text-center w-40 text-xs font-bold text-white">Strike</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">Type</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">LTP</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">IV</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">Delta</th>
                  <th className="px-3 py-2 text-left text-xs font-bold text-white">Lots</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/40">
                {resolvedLegs.map((leg, idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-3 py-3">
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20">
                        SELL
                      </span>
                    </td>
                    <td className="px-3 py-3 text-zinc-300 font-mono">{expiry}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => handleNudgeStrike(leg.type, -1)}
                          className="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 font-semibold"
                        >−</button>
                        <span className="font-mono font-bold text-zinc-100 w-16 text-center">{leg.strike}</span>
                        <button
                          onClick={() => handleNudgeStrike(leg.type, 1)}
                          className="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 font-semibold"
                        >+</button>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`font-semibold font-mono ${leg.type === 'CE' ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {leg.type}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-zinc-200">₹{leg.price.toFixed(2)}</td>
                    <td className="px-3 py-3 font-mono text-zinc-400">
                      {leg.iv !== null ? `${(leg.iv * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-3 font-mono text-zinc-400">
                      {leg.delta !== null ? leg.delta.toFixed(2) : '—'}
                    </td>
                    <td className="px-3 py-3 text-zinc-300">{leg.qtyLots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stats + payoff diagram */}
      {stats && (
        <>
          <StrategySummaryPanel
            stats={stats}
            targetBreakevens={null}
            breakevenMode={breakevenMode}
            onBreakevenModeChange={setBreakevenMode}
            margin={null}
            marginLoading={false}
            spot={spot}
          />
          <PayoffDiagram
            curve={curve}
            currentSpot={spot}
            breakevens={breakevens}
          />
        </>
      )}

      {/* Action bar */}
      {resolvedLegs.length === 2 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleEnterTrade}
            disabled={!canEnter}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            {entering ? 'Entering…' : 'Enter Trade'}
          </button>
          <button
            onClick={handleExitTrade}
            disabled={!canExit}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-rose-700 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            {exiting ? 'Exiting…' : 'Exit Trade'}
          </button>
          {tradingType === 'live' && (
            <span className="text-xs text-amber-400 font-semibold">⚡ LIVE MODE — real orders will be placed</span>
          )}
        </div>
      )}

      {/* Result banner */}
      {orderResult && (
        <div className={`border rounded-lg px-4 py-2.5 text-xs font-semibold ${
          orderResult.success
            ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
            : 'bg-rose-950/80 border-rose-800 text-rose-300'
        }`}>
          {orderResult.message}
        </div>
      )}

    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

Run from `rs_dashboard/`:
```powershell
npx tsc --noEmit
```
Expected: zero errors. If you see errors about `ChainLegData` or `ResolvedLeg` not being exported from `@/lib/optionsStrategy`, check that those types are exported in that file — they are defined but may lack the `export` keyword on the interface. Add `export` if missing.

- [ ] **Step 3: Commit**

```powershell
git add rs_dashboard/components/strategy/PctStrangleTab.tsx
git commit -m "feat(strategy-builder): add PctStrangleTab component"
```

---

## Task 2: Wire `PctStrangleTab` into `StrategyBuilder.tsx`

**Files:**
- Modify: `rs_dashboard/components/StrategyBuilder.tsx` (lines 23, 420–431, 436)

**Interfaces:**
- Consumes: `PctStrangleTab` exported from `@/components/strategy/PctStrangleTab`
- Props passed: `spot={spot}`, `chainOc={chainOc}`, `expiries={expiries}`, `selectedExpiry={selectedExpiry}`

**Constraint:** Only the three edits below are permitted. No other line in this file changes.

- [ ] **Step 1: Add import at top of `StrategyBuilder.tsx`**

After the existing import block (around line 10), add:

```tsx
import PctStrangleTab from '@/components/strategy/PctStrangleTab';
```

- [ ] **Step 2: Widen the `activeTab` type (line 23)**

Find:
```tsx
const [activeTab, setActiveTab] = useState<'builder' | 'saved' | 'positions'>('builder');
```

Replace with:
```tsx
const [activeTab, setActiveTab] = useState<'builder' | 'saved' | 'positions' | 'pct_strangle'>('builder');
```

- [ ] **Step 3: Add tab button to the tab bar (around line 420)**

Find:
```tsx
{(['builder', 'saved', 'positions'] as const).map((t) => (
  <button
    key={t}
    onClick={() => setActiveTab(t)}
    className={`px-3 py-1 font-medium capitalize ${
      activeTab === t ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
    }`}
  >
    {t === 'builder' ? 'Builder' : t === 'saved' ? 'Saved Strategies' : 'Positions'}
  </button>
))}
```

Replace with:
```tsx
{(['builder', 'pct_strangle', 'saved', 'positions'] as const).map((t) => (
  <button
    key={t}
    onClick={() => setActiveTab(t)}
    className={`px-3 py-1 font-medium capitalize ${
      activeTab === t ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
    }`}
  >
    {t === 'builder' ? 'Builder' : t === 'pct_strangle' ? '% Strangle' : t === 'saved' ? 'Saved Strategies' : 'Positions'}
  </button>
))}
```

- [ ] **Step 4: Add render branch (around line 436)**

Find:
```tsx
{activeTab === 'positions' ? (
  <PositionalTradesTab />
) : activeTab === 'saved' ? (
  <SavedStrategiesTab />
) : (
```

Replace with:
```tsx
{activeTab === 'positions' ? (
  <PositionalTradesTab />
) : activeTab === 'saved' ? (
  <SavedStrategiesTab />
) : activeTab === 'pct_strangle' ? (
  <PctStrangleTab
    spot={spot}
    chainOc={chainOc}
    expiries={expiries}
    selectedExpiry={selectedExpiry}
  />
) : (
```

- [ ] **Step 5: Verify TypeScript compiles without errors**

```powershell
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 6: Start dev server and do a manual smoke test**

```powershell
npm run dev
```

Navigate to `http://localhost:3000/strategy-builder`. Verify:

1. Tab bar shows: **Builder | % Strangle | Saved Strategies | Positions**
2. Clicking **% Strangle** renders the new tab without any console errors
3. Existing **Builder** tab works exactly as before — select a template (e.g. Short Straddle), click Analyze, verify legs and payoff appear normally
4. In **% Strangle** tab: change Call OTM % to `3.0` and Put OTM % to `2.0` — strike chips update immediately showing computed strikes
5. Leg table appears with LTP, IV, and delta populated from the chain (if market is open) or shows "not in chain" if chain data isn't loaded
6. Enter Trade button is disabled in Demo mode when chain data is missing; enabled when both legs resolve
7. Clicking Enter Trade (Demo) shows success banner after ~500ms

- [ ] **Step 7: Commit**

```powershell
git add rs_dashboard/components/StrategyBuilder.tsx
git commit -m "feat(strategy-builder): wire % Strangle tab into builder"
```
