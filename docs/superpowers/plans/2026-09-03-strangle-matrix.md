# Live Strangle Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new dashboard page showing a live-refreshing matrix of ATM-offset strangle premiums (rows) across the next 4 expiries (columns), with header filters and RoM-based conditional formatting.

**Architecture:** Extract the existing short-strangle premium/RoM/POP math out of `lib/ultimateScannerEngine.ts` into a shared pure function (`lib/strangleMath.ts`), reused by both the Scanner (no behavior change) and a new `/api/options/strangle-matrix` route that computes the full offset×expiry grid server-side. The client polls that route every 4s (paused when the tab is hidden) and applies all filter/threshold logic client-side over the already-fetched data — no re-fetch on filter changes.

**Tech Stack:** Next.js API routes (Node runtime), TypeScript, React client component, `node:test` for the pure-function unit tests, existing `lib/pyExec.ts` (`dedupe`/`spaced`) and `lib/ultimateScannerDhan.ts` (`fetchUnderlyingExpiries`/`fetchUnderlyingChain`) for Dhan data.

**Spec:** `docs/superpowers/specs/2026-09-03-strangle-matrix-design.md`

## Global Constraints

- No new color palette — only the existing zinc/emerald/cyan/amber/red Tailwind tokens (CLAUDE.md theming rules).
- No hardcoded colors (`#hex`, `rgb()`, `bg-black`, `text-white/NN` opacity) — zinc-ramp tokens only.
- Table headers: `text-xs font-bold text-white` on `bg-zinc-800`.
- REST poll only — no new Python WebSocket bridge process.
- RoM% uses the flat per-strategy margin estimate (same as Scanner's non-enriched candidates) — no live per-cell margin calculator calls.
- Filter/threshold changes (Min RoM, Risk Profile, Distance range, offset-row count) never trigger a re-fetch — client-side only over the already-polled matrix.

---

### Task 1: Extract shared strangle math into `lib/strangleMath.ts`

**Files:**
- Create: `rs_dashboard/lib/strangleMath.ts`
- Create: `rs_dashboard/lib/strangleMath.test.ts`
- Modify: `rs_dashboard/lib/ultimateScannerEngine.ts:21-39` (remove local `ChainStrikeQuote`, import from `strangleMath.ts`), `:440-500` (symmetric strangle loop calls `computeStrangleAtOffset`)

**Interfaces:**
- Produces: `ChainStrikeQuote` (moved, same shape as before), `StrangleCell` interface, `computeStrangleAtOffset(params): StrangleCell | null` — both consumed by Task 2's API route and (after this task) by `ultimateScannerEngine.ts`.

- [ ] **Step 1: Write `lib/strangleMath.ts`**

```typescript
import type { UnderlyingType } from './ultimateScannerTypes';

export interface ChainStrikeQuote {
  strike: number;
  ce: {
    ltp: number;
    oi?: number;
    oiChange?: number;
    iv?: number;
    delta?: number;
    securityId?: string;
  };
  pe: {
    ltp: number;
    oi?: number;
    oiChange?: number;
    iv?: number;
    delta?: number;
    securityId?: string;
  };
}

export interface StrangleCell {
  offset: number;
  putStrike: number;
  callStrike: number;
  putLtp: number;
  callLtp: number;
  netPremium: number;         // Total net credit in ₹ for 1 lot
  netPremiumPoints: number;   // Net premium in index points
  estMargin: number;          // Flat per-strategy margin estimate in ₹
  romPct: number;             // Return on Margin % per expiry cycle
  romAnnualizedPct: number;   // Annualized RoM %
  distancePct: number;        // Nearer leg's distance from spot, % OTM
  distancePoints: number;     // Nearer leg's distance from spot, in points
  popPct: number;             // Probability of Profit % (0-100)
  riskTier: 'Conservative' | 'Moderate' | 'Aggressive';
  breakevens: [number, number]; // [lower, upper]
  putSecurityId?: string;
  callSecurityId?: string;
}

const LOT_SIZES: Record<UnderlyingType, number> = {
  NIFTY: 65,
  SENSEX: 10,
  BANKNIFTY: 15,
};

/**
 * Premium/RoM/POP for a symmetric short strangle at `offset` strike-steps
 * out from ATM (e.g. offset=2 sells ATM-2*step PE and ATM+2*step CE).
 * Returns null when either leg's quote is missing or too illiquid
 * (ltp <= 1.0) to be a real fill.
 */
export function computeStrangleAtOffset(params: {
  underlying: UnderlyingType;
  atmStrike: number;
  offset: number;
  step: number;
  spot: number;
  dte: number;
  chainQuotes: Record<number, ChainStrikeQuote>;
  lotSize?: number; // defaults to LOT_SIZES[underlying]
}): StrangleCell | null {
  const { underlying, atmStrike, offset, step, spot, dte, chainQuotes } = params;
  const lotSize = params.lotSize ?? LOT_SIZES[underlying] ?? 65;

  const putStrike = atmStrike - offset * step;
  const callStrike = atmStrike + offset * step;

  const putQuote = chainQuotes[putStrike]?.pe;
  const callQuote = chainQuotes[callStrike]?.ce;
  if (!putQuote || !callQuote || putQuote.ltp <= 1.0 || callQuote.ltp <= 1.0) return null;

  const putDistPct = ((spot - putStrike) / spot) * 100;
  const callDistPct = ((callStrike - spot) / spot) * 100;
  const distancePct = Math.min(putDistPct, callDistPct);

  const totalCreditPts = putQuote.ltp + callQuote.ltp;
  const netPremium = totalCreditPts * lotSize;
  const estMargin = underlying === 'NIFTY' ? 120000 : underlying === 'SENSEX' ? 95000 : 130000;
  const romPct = (netPremium / estMargin) * 100;
  const romAnnualizedPct = (romPct / Math.max(1, dte)) * 365;

  const popPct = Math.min(94, Math.max(50, 88 - (1.0 / (distancePct + 0.1)) * 10));
  const riskTier = distancePct >= 2.5 ? 'Conservative' : distancePct >= 1.2 ? 'Moderate' : 'Aggressive';

  return {
    offset,
    putStrike,
    callStrike,
    putLtp: putQuote.ltp,
    callLtp: callQuote.ltp,
    netPremium: Math.round(netPremium),
    netPremiumPoints: Math.round(totalCreditPts * 100) / 100,
    estMargin: Math.round(estMargin),
    romPct: Math.round(romPct * 100) / 100,
    romAnnualizedPct: Math.round(romAnnualizedPct),
    distancePct: Math.round(distancePct * 100) / 100,
    distancePoints: Math.round(Math.min(spot - putStrike, callStrike - spot)),
    popPct: Math.round(popPct),
    riskTier,
    breakevens: [
      Math.round((putStrike - totalCreditPts) * 100) / 100,
      Math.round((callStrike + totalCreditPts) * 100) / 100,
    ],
    putSecurityId: putQuote.securityId,
    callSecurityId: callQuote.securityId,
  };
}
```

- [ ] **Step 2: Write the failing tests in `lib/strangleMath.test.ts`**

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { computeStrangleAtOffset, type ChainStrikeQuote } from './strangleMath.ts';

const quotes = (entries: Record<number, { pe?: number; ce?: number }>): Record<number, ChainStrikeQuote> => {
  const out: Record<number, ChainStrikeQuote> = {};
  for (const [strikeStr, { pe, ce }] of Object.entries(entries)) {
    const strike = Number(strikeStr);
    out[strike] = {
      strike,
      ce: { ltp: ce ?? 0 },
      pe: { ltp: pe ?? 0 },
    };
  }
  return out;
};

test('computeStrangleAtOffset: basic symmetric strangle math', () => {
  // spot=100, atm=100, step=10, offset=2 -> sell 80 PE / 120 CE, both @ ltp 5
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 80: { pe: 5 }, 120: { ce: 5 } }),
  });

  assert.ok(cell !== null);
  assert.strictEqual(cell!.putStrike, 80);
  assert.strictEqual(cell!.callStrike, 120);
  assert.strictEqual(cell!.netPremiumPoints, 10);
  assert.strictEqual(cell!.netPremium, 10); // lotSize=1
  assert.strictEqual(cell!.distancePct, 20); // both legs 20% OTM
  assert.strictEqual(cell!.estMargin, 120000); // flat NIFTY estimate
  assert.ok(Math.abs(cell!.romPct - (10 / 120000) * 100) < 1e-9);
  assert.deepStrictEqual(cell!.breakevens, [70, 130]);
});

test('computeStrangleAtOffset: returns null when the put leg quote is missing', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 120: { ce: 5 } }), // no 80 strike at all
  });
  assert.strictEqual(cell, null);
});

test('computeStrangleAtOffset: returns null when a leg is too illiquid (ltp <= 1.0)', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 80: { pe: 0.5 }, 120: { ce: 5 } }),
  });
  assert.strictEqual(cell, null);
});

test('computeStrangleAtOffset: SENSEX uses its own flat margin estimate', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'SENSEX',
    atmStrike: 80000,
    offset: 3,
    step: 100,
    spot: 80000,
    dte: 5,
    lotSize: 10,
    chainQuotes: quotes({ 79700: { pe: 40 }, 80300: { ce: 40 } }),
  });
  assert.ok(cell !== null);
  assert.strictEqual(cell!.estMargin, 95000);
});
```

- [ ] **Step 3: Run the tests to verify they fail (file doesn't compile yet correctly against implementation, or simply doesn't exist)**

Run: `cd rs_dashboard && node --test lib/strangleMath.test.ts`
Expected: FAIL — `lib/strangleMath.ts` does not exist yet (or, if Step 1 was already saved, this should now PASS — if so skip to Step 4's verification directly).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/strangleMath.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Refactor `ultimateScannerEngine.ts` to use the shared function**

In `rs_dashboard/lib/ultimateScannerEngine.ts`:

1. Delete the local `export interface ChainStrikeQuote { ... }` block (currently lines 21-39).
2. Add to the top import block:
   ```typescript
   import { computeStrangleAtOffset, type ChainStrikeQuote, type StrangleCell } from './strangleMath';
   ```
3. Replace the body of the symmetric-offset loop (currently the block starting `for (let offset = 1; offset <= maxOffsetSteps; offset++) {` through its closing `}`, i.e. the section between the `// 1) Systematic symmetric & near-symmetric strangles` comment and the `// 2) Also scan cross-strike OTM combinations` comment) with:

   ```typescript
   for (let offset = 1; offset <= maxOffsetSteps; offset++) {
     const cell: StrangleCell | null = computeStrangleAtOffset({
       underlying,
       atmStrike,
       offset,
       step,
       spot,
       dte,
       lotSize,
       chainQuotes,
     });
     if (!cell) continue;

     const score = Math.round(Math.min(100, (cell.romPct * 6.0) + (cell.popPct * 0.4) + (cell.distancePct * 5)));

     evaluateCandidate({
       id: `strangle_${underlying}_${cell.putStrike}_${cell.callStrike}_${expiry}`,
       name: `Short Strangle (${cell.putStrike} PE / ${cell.callStrike} CE [±${offset * step}pts])`,
       type: 'short_strangle',
       underlying,
       expiry,
       dte,
       spot,
       legs: [
         { strike: cell.putStrike, option: 'PE', side: 'SELL', ltp: cell.putLtp, lots: 1, lotSize, securityId: cell.putSecurityId },
         { strike: cell.callStrike, option: 'CE', side: 'SELL', ltp: cell.callLtp, lots: 1, lotSize, securityId: cell.callSecurityId },
       ],
       netPremium: cell.netPremium,
       netPremiumPoints: cell.netPremiumPoints,
       estMargin: cell.estMargin,
       romPct: cell.romPct,
       romAnnualizedPct: cell.romAnnualizedPct,
       distancePct: cell.distancePct,
       distancePoints: cell.distancePoints,
       popPct: cell.popPct,
       maxProfit: cell.netPremium,
       maxLoss: 0,
       maxLossUnlimited: true,
       riskRewardRatio: 0,
       breakevens: cell.breakevens,
       deltaNet: 0.0,
       sentiment: 'Range-Bound',
       riskTier: cell.riskTier,
       score,
       createdAt: new Date().toISOString(),
     });
   }
   ```

   Do not touch the `maxOffsetSteps` computation above this loop, or the "2) Also scan cross-strike OTM combinations" section below it — both are unchanged.

- [ ] **Step 6: Typecheck**

Run: `cd rs_dashboard && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If `node_modules` is missing in an isolated worktree, symlink it from the main checkout first: `ln -s /c/dhan_algo/dhan_algo/rs_dashboard/node_modules node_modules`, run tsc, then `rm -rf node_modules` afterward — do not commit the symlink or a copied `node_modules`.)

- [ ] **Step 7: Re-run the strangleMath tests plus the full lib test suite to confirm nothing else broke**

Run: `cd rs_dashboard && npm test`
Expected: all tests pass, including the new `strangleMath.test.ts` file (the `test` script is `node --test lib/*.test.ts`, which already picks up any `lib/*.test.ts` file — no `package.json` change needed).

- [ ] **Step 8: Manual regression check against the live Scanner (values must be unchanged by the refactor)**

This step needs a running dev/prod server and valid Dhan session; if neither is available, skip and note it in the task's completion summary rather than fabricating results.

Mint a signed `dhan_session` cookie (see `debug/session.json` for a UUID and `rs_dashboard/lib/auth.ts`'s `COOKIE_SECRET`/`SESSION_COOKIE` for the HMAC-SHA256 signing scheme — `cookieValue = uuid + '.' + hex(hmac_sha256(uuid, COOKIE_SECRET))`), then:

```bash
curl -s -X POST http://localhost:3000/api/ultimate-scanner/scan \
  -H "Content-Type: application/json" \
  -H "Cookie: dhan_session=<minted-cookie>" \
  -d '{"underlying":"NIFTY","minRom":0.5,"minDistancePct":0.2,"maxDistancePct":5.0,"riskProfile":"all","strategyTypes":["short_strangle"],"maxResults":50,"sortBy":"score"}'
```

Expected: `success: true`, a non-empty `candidates` array of `type: "short_strangle"` entries with sane `romPct`/`distancePct`/`netPremium` values (same shape and same order of magnitude as before this refactor — this is a smoke check, not a byte-for-byte diff).

- [ ] **Step 9: Commit**

```bash
git add rs_dashboard/lib/strangleMath.ts rs_dashboard/lib/strangleMath.test.ts rs_dashboard/lib/ultimateScannerEngine.ts
git commit -m "refactor(ultimate-scanner): extract shared strangle math into lib/strangleMath.ts

Pulls the short-strangle premium/RoM/POP calculation out of the
symmetric-offset loop in ultimateScannerEngine.ts into a standalone,
unit-tested pure function so the upcoming Live Strangle Matrix page can
reuse the exact same math instead of a second copy that could drift.
No behavior change to the Scanner."
```

---

### Task 2: `GET /api/options/strangle-matrix` route

**Files:**
- Create: `rs_dashboard/app/api/options/strangle-matrix/route.ts`

**Interfaces:**
- Consumes: `fetchUnderlyingExpiries(underlying: string): Promise<string[]>`, `fetchUnderlyingChain(underlying: string, expiry: string): Promise<{chain, spot, prevClose}>` (both from `@/lib/ultimateScannerDhan`, unchanged signatures); `parseChainQuotes(rawChain): {quotes, strikes}` and `calculateDte(expiryStr): number` (both from `@/lib/ultimateScannerEngine`, unchanged); `computeStrangleAtOffset` and `STRIKE_STEPS`/`LOT_SIZES`-equivalent (from `@/lib/strangleMath` — note `LOT_SIZES` in `strangleMath.ts` is NOT exported, only used internally as a default; this route must pass `lotSize` explicitly using `STRIKE_STEPS`/lot-size constants already exported from `ultimateScannerEngine.ts`, i.e. import `LOT_SIZES` and `STRIKE_STEPS` from `@/lib/ultimateScannerEngine`, not from `strangleMath`).
- Produces: JSON response consumed by Task 3's component —
  ```typescript
  interface StrangleMatrixResponse {
    success: boolean;
    error?: string;
    underlying: string;
    spot: number;
    expiries: { expiry: string; dte: number }[];
    rows: { offset: number; cells: (StrangleCell | null)[] }[]; // cells[i] pairs with expiries[i]
  }
  ```

- [ ] **Step 1: Write the route**

```typescript
// rs_dashboard/app/api/options/strangle-matrix/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { fetchUnderlyingExpiries, fetchUnderlyingChain } from '@/lib/ultimateScannerDhan';
import { parseChainQuotes, calculateDte, STRIKE_STEPS, LOT_SIZES } from '@/lib/ultimateScannerEngine';
import { computeStrangleAtOffset, type StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType } from '@/lib/ultimateScannerTypes';

const MAX_EXPIRIES = 4;
const MAX_OFFSET = 15;

export async function GET(request: NextRequest) {
  try {
    const underlyingParam = (request.nextUrl.searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
    if (underlyingParam !== 'NIFTY' && underlyingParam !== 'SENSEX') {
      return NextResponse.json({ success: false, error: 'underlying must be NIFTY or SENSEX' }, { status: 400 });
    }
    const underlying = underlyingParam as UnderlyingType;

    const allExpiries = await fetchUnderlyingExpiries(underlying);
    const targetExpiries = allExpiries.slice(0, MAX_EXPIRIES);
    if (targetExpiries.length === 0) {
      return NextResponse.json({ success: false, error: 'No expiries available' }, { status: 502 });
    }

    // Fetch every expiry's chain concurrently — same pattern as
    // /api/ultimate-scanner/scan's VIX+chain Promise.all.
    const chainResults = await Promise.all(
      targetExpiries.map(expiry => fetchUnderlyingChain(underlying, expiry)),
    );

    const step = STRIKE_STEPS[underlying];
    const lotSize = LOT_SIZES[underlying];

    // spot should agree across expiries (same underlying); use the first
    // non-zero one returned.
    const spot = chainResults.find(r => r.spot > 0)?.spot ?? 0;

    const expiries = targetExpiries.map((expiry, i) => ({
      expiry,
      dte: calculateDte(expiry),
    }));

    const rows: { offset: number; cells: (StrangleCell | null)[] }[] = [];

    if (spot > 0) {
      for (let offset = 1; offset <= MAX_OFFSET; offset++) {
        const cells: (StrangleCell | null)[] = targetExpiries.map((expiry, i) => {
          const { chain, spot: expirySpot } = chainResults[i];
          if (expirySpot <= 0) return null;
          const { quotes, strikes } = parseChainQuotes(chain);
          if (strikes.length === 0) return null;
          const atmStrike = strikes.reduce((prev, curr) =>
            Math.abs(curr - expirySpot) < Math.abs(prev - expirySpot) ? curr : prev
          );
          return computeStrangleAtOffset({
            underlying,
            atmStrike,
            offset,
            step,
            spot: expirySpot,
            dte: calculateDte(expiry),
            lotSize,
            chainQuotes: quotes,
          });
        });
        rows.push({ offset, cells });
      }
    }

    return NextResponse.json({
      success: true,
      underlying,
      spot,
      expiries,
      rows,
    });
  } catch (err) {
    console.error('[/api/options/strangle-matrix GET]', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd rs_dashboard && npx tsc --noEmit -p tsconfig.json` (symlink `node_modules` first if needed, as in Task 1 Step 6; remove it after).
Expected: no errors. If `STRIKE_STEPS` or `LOT_SIZES` are not currently exported from `ultimateScannerEngine.ts`, add `export` to their existing declarations there (they are declared as `export const LOT_SIZES` / `export const STRIKE_STEPS` already per the codebase as of this plan's writing — confirm before assuming a change is needed).

- [ ] **Step 3: Manual verification against the live route**

Requires a running dev/prod server (`npm run dev` from `rs_dashboard/`) and a valid Dhan session cookie (see Task 1 Step 8 for how to mint one). If neither is available, skip and note it rather than fabricating output.

```bash
curl -s "http://localhost:3000/api/options/strangle-matrix?underlying=NIFTY" \
  -H "Cookie: dhan_session=<minted-cookie>" | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    console.log('success:', data.success);
    console.log('spot:', data.spot);
    console.log('expiries:', data.expiries);
    console.log('row count:', data.rows.length);
    console.log('offset 1 cells:', JSON.stringify(data.rows[0], null, 2));
  "
```

Expected: `success: true`, `expiries` has 1-4 entries each with a real date and positive `dte`, `rows.length === 15`, and `rows[0].cells` has one entry per expiry — each either `null` (illiquid/missing) or a populated `StrangleCell` with sane `netPremium`/`romPct`/`distancePct`.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/app/api/options/strangle-matrix/route.ts
git commit -m "feat(strangle-matrix): add GET /api/options/strangle-matrix route

Computes the full 15-offset x up-to-4-expiry strangle grid server-side
in one request, reusing computeStrangleAtOffset from strangleMath.ts
and the existing fetchUnderlyingExpiries/fetchUnderlyingChain Dhan
helpers. No new Python process — same REST-poll pattern Ultimate
Scanner already uses."
```

---

### Task 3: `StrangleMatrixPage` component, page route, and nav entry

**Files:**
- Create: `rs_dashboard/components/StrangleMatrixPage.tsx`
- Create: `rs_dashboard/app/(options)/options/strangle-matrix/page.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx:71` (insert nav entry after the Strangle Analysis link)

**Interfaces:**
- Consumes: `GET /api/options/strangle-matrix?underlying=NIFTY|SENSEX` → `StrangleMatrixResponse` (defined in Task 2); `StrangleCell` type from `@/lib/strangleMath`.
- Produces: nothing consumed elsewhere — this is the leaf UI.

- [ ] **Step 1: Add the NavBar entry**

In `rs_dashboard/components/NavBar.tsx`, immediately after the existing line:
```typescript
      { href: '/strangle-analysis', label: 'Strangle Analysis', desc: 'OTM strangle premium patterns by offset, weekday, DTE & regime' },
```
insert:
```typescript
      { href: '/options/strangle-matrix', label: 'Live Strangle Matrix', desc: 'Live ATM-offset strangle premiums across expiries, ranked by RoM%' },
```

- [ ] **Step 2: Write the page wrapper**

```typescript
// rs_dashboard/app/(options)/options/strangle-matrix/page.tsx
import StrangleMatrixPage from '@/components/StrangleMatrixPage';

export const metadata = {
  title: 'Live Strangle Matrix · ATM-Offset Premiums Across Expiries',
  description: 'Live-refreshing table of ATM-offset short strangle premiums across the next expiries, with RoM% conditional formatting.',
};

export default function Page() {
  return <StrangleMatrixPage />;
}
```

- [ ] **Step 3: Write `components/StrangleMatrixPage.tsx`**

```typescript
'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Activity, Sliders, RefreshCw, Pause, Play } from 'lucide-react';
import NavBar from './NavBar';
import type { StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType, RiskProfile } from '@/lib/ultimateScannerTypes';

interface StrangleMatrixResponse {
  success: boolean;
  error?: string;
  // Only present when success is true — the route's error responses are
  // just { success: false, error }.
  underlying?: string;
  spot?: number;
  expiries?: { expiry: string; dte: number }[];
  rows?: { offset: number; cells: (StrangleCell | null)[] }[];
}

const POLL_MS = 4000;

// Same risk-profile admission rule as ultimateScannerEngine.ts's
// evaluateCandidate, applied client-side per cell instead of server-side
// per candidate — filter changes here never trigger a re-fetch.
function passesRiskProfile(cell: StrangleCell, profile: RiskProfile): boolean {
  if (profile === 'conservative') return cell.popPct >= 75 && cell.riskTier !== 'Aggressive';
  if (profile === 'moderate') return cell.popPct >= 60 && cell.riskTier !== 'Aggressive';
  if (profile === 'aggressive') return cell.riskTier !== 'Conservative';
  return true; // 'all'
}

export default function StrangleMatrixPage() {
  const [underlying, setUnderlying] = useState<UnderlyingType>('NIFTY');
  const [data, setData] = useState<StrangleMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Header filters — all client-side over the already-fetched matrix.
  const [offsetRowCount, setOffsetRowCount] = useState(10);
  const [minRomPct, setMinRomPct] = useState(0.5);
  const [minDistancePct, setMinDistancePct] = useState(0.2);
  const [maxDistancePct, setMaxDistancePct] = useState(6.0);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('all');
  const [goodRomPct, setGoodRomPct] = useState(1.0);
  const [greatRomPct, setGreatRomPct] = useState(2.5);

  const pollRequestId = useRef(0);

  const fetchMatrix = useCallback(async () => {
    const requestId = ++pollRequestId.current;
    try {
      const res = await fetch(`/api/options/strangle-matrix?underlying=${underlying}`);
      const json = (await res.json()) as StrangleMatrixResponse;
      if (requestId !== pollRequestId.current) return;
      if (json.success) {
        setData(json);
        setError(null);
        setLastPolledAt(new Date().toISOString());
      } else {
        setError(json.error ?? 'Failed to load strangle matrix');
      }
    } catch (err) {
      if (requestId !== pollRequestId.current) return;
      setError(String((err as Error).message ?? err));
    }
  }, [underlying]);

  // Poll loop, paused while the tab is hidden or the user pauses manually —
  // matches this repo's polling-guard convention (dhan-polling-guards skill).
  useEffect(() => {
    fetchMatrix();
    if (paused) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchMatrix, POLL_MS);
    };
    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        fetchMatrix();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchMatrix, paused]);

  const visibleRows = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows
      .filter(row => row.offset <= offsetRowCount)
      .filter(row => {
        // A row is shown if AT LEAST ONE cell in it falls within the
        // distance range — individual cells outside it are still muted,
        // not hidden, so a trader can see the row exists across expiries.
        return row.cells.some(cell => {
          if (!cell) return false;
          return cell.distancePct >= minDistancePct && cell.distancePct <= maxDistancePct;
        });
      });
  }, [data, offsetRowCount, minDistancePct, maxDistancePct]);

  function cellTone(cell: StrangleCell | null): { bg: string; text: string; muted: boolean } {
    if (!cell) return { bg: 'bg-zinc-900/40', text: 'text-zinc-600', muted: true };
    if (cell.distancePct < minDistancePct || cell.distancePct > maxDistancePct) {
      return { bg: 'bg-zinc-900/60', text: 'text-zinc-600', muted: true };
    }
    if (!passesRiskProfile(cell, riskProfile)) {
      return { bg: 'bg-zinc-900/60', text: 'text-zinc-500', muted: true };
    }
    if (cell.romPct < minRomPct) {
      return { bg: 'bg-zinc-900/80', text: 'text-zinc-300', muted: false };
    }
    if (cell.romPct >= greatRomPct) {
      return { bg: 'bg-emerald-500/20', text: 'text-emerald-200', muted: false };
    }
    if (cell.romPct >= goodRomPct) {
      return { bg: 'bg-emerald-500/10', text: 'text-emerald-300', muted: false };
    }
    return { bg: 'bg-zinc-900/80', text: 'text-zinc-300', muted: false };
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white font-sans">
      <NavBar />

      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Activity className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
              Live ATM-Offset Strangle Premiums
            </span>
            <h1 className="text-base font-bold text-white tracking-tight leading-none mt-0.5">
              Strangle Matrix
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-zinc-500">
            {lastPolledAt ? `Updated ${new Date(lastPolledAt).toLocaleTimeString('en-IN')}` : 'Loading…'}
          </span>
          <button
            onClick={() => setPaused(p => !p)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition-all"
          >
            {paused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
            {(['NIFTY', 'SENSEX'] as const).map(u => (
              <button
                key={u}
                onClick={() => setUnderlying(u)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  underlying === u
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="flex-1 flex flex-col px-6 py-6 max-w-7xl mx-auto w-full gap-5">
        {/* Filters panel */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4 shadow-xl">
          <div className="flex items-center gap-2 pb-3 border-b border-zinc-800">
            <Sliders className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white tracking-wide">Filters &amp; Thresholds</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Offset Rows: {offsetRowCount}
              </label>
              <input
                type="range" min="1" max="15" step="1"
                value={offsetRowCount}
                onChange={e => setOffsetRowCount(parseInt(e.target.value, 10))}
                className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Min RoM %: {minRomPct.toFixed(1)}%
              </label>
              <input
                type="range" min="0" max="8" step="0.25"
                value={minRomPct}
                onChange={e => setMinRomPct(parseFloat(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Distance % OTM: {minDistancePct.toFixed(1)}–{maxDistancePct.toFixed(1)}%
              </label>
              <div className="flex flex-col gap-1">
                <input
                  type="range" min="0.2" max="8" step="0.2"
                  value={minDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMinDistancePct(v);
                    if (v > maxDistancePct) setMaxDistancePct(v);
                  }}
                  className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
                <input
                  type="range" min="0.2" max="8" step="0.2"
                  value={maxDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMaxDistancePct(v);
                    if (v < minDistancePct) setMinDistancePct(v);
                  }}
                  className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Risk Profile
              </label>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
                {(['all', 'conservative', 'moderate', 'aggressive'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setRiskProfile(p)}
                    className={`flex-1 py-1.5 text-[11px] font-semibold capitalize rounded-lg transition-all ${
                      riskProfile === p
                        ? 'bg-zinc-800 text-white border border-zinc-700'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 pt-3 border-t border-zinc-800/80">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500/10 border border-emerald-500/30" />
              <label className="text-[11px] text-zinc-400">Good RoM ≥</label>
              <input
                type="number" step="0.1" min="0" value={goodRomPct}
                onChange={e => setGoodRomPct(parseFloat(e.target.value) || 0)}
                className="w-16 bg-zinc-950 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs"
              />
              <span className="text-[11px] text-zinc-500">%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500/25 border border-emerald-500/50" />
              <label className="text-[11px] text-zinc-400">Great RoM ≥</label>
              <input
                type="number" step="0.1" min="0" value={greatRomPct}
                onChange={e => setGreatRomPct(parseFloat(e.target.value) || 0)}
                className="w-16 bg-zinc-950 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs"
              />
              <span className="text-[11px] text-zinc-500">%</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-red-400 text-xs">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!data && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-zinc-500 text-xs">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading strangle matrix…
          </div>
        )}

        {data?.expiries && data.rows && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto shadow-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4 sticky left-0 bg-zinc-800 z-10">Offset</th>
                  {data.expiries.map(e => (
                    <th key={e.expiry} className="py-3 px-4 text-right">
                      {e.expiry}
                      <div className="text-[10px] font-normal text-zinc-400 normal-case">{e.dte}d</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {visibleRows.map(row => (
                  <tr key={row.offset} className="hover:bg-zinc-800/40 transition-colors group">
                    <td className="py-3 px-4 font-bold text-white sticky left-0 bg-zinc-900 group-hover:bg-zinc-800/40 z-10">
                      ATM±{row.offset}
                    </td>
                    {row.cells.map((cell, i) => {
                      const tone = cellTone(cell);
                      return (
                        <td key={data.expiries[i].expiry} className={`py-3 px-4 text-right tabular-nums ${tone.bg}`}>
                          {cell ? (
                            <>
                              <div className={`font-bold ${tone.text}`}>₹{cell.netPremium.toLocaleString('en-IN')}</div>
                              <div className="text-[10px] text-zinc-500">{cell.romPct.toFixed(2)}%</div>
                            </>
                          ) : (
                            <span className={tone.text}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd rs_dashboard && npx tsc --noEmit -p tsconfig.json` (symlink `node_modules` first if needed; remove it after).
Expected: no errors.

- [ ] **Step 5: Manual browser verification**

Requires a running dev server and valid Dhan session (log in via the dashboard's `/login` page, or if using `npm run dev` for the first time, the browser session cookie is set through the normal login flow — the curl-cookie-minting trick from Task 1/2 is for scripted checks, not needed here since a real browser session works normally).

1. `cd rs_dashboard && npm run dev`, open `http://localhost:3000/options/strangle-matrix`.
2. Confirm NavBar → "Options Analysis" → "Live Strangle Matrix" link navigates here.
3. Confirm the table renders with up to 4 expiry columns and 10 offset rows (default), all cells populated within a few seconds.
4. Watch two poll cycles (~8s) — confirm the "Updated HH:MM:SS" timestamp advances and cell values refresh without a full page flash.
5. Toggle NIFTY → SENSEX — confirm the table reloads for SENSEX strikes/step size.
6. Move the Offset Rows slider down to 3 — confirm only 3 rows show, instantly, with no new network request (check browser dev tools Network tab).
7. Raise Min RoM% above the current market's typical RoM — confirm most cells go neutral zinc; lower it back — confirm emerald tints reappear.
8. Switch Risk Profile to "conservative" — confirm cells whose POP/risk tier don't qualify go muted regardless of RoM%.
9. Click Pause — confirm the timestamp stops advancing; click Resume — confirm it starts again and immediately refetches.
10. Switch to another browser tab for 15+ seconds, return — confirm no errors occurred while hidden and the table refreshes promptly on return.

If no valid Dhan session/dev server is available in this environment, skip this step and say so explicitly in the task's completion summary rather than claiming it was verified.

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/components/StrangleMatrixPage.tsx rs_dashboard/app/\(options\)/options/strangle-matrix/page.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(strangle-matrix): add Live Strangle Matrix page under Options Analysis

New page at /options/strangle-matrix: a live-polling (4s, paused when
the tab is hidden) table of ATM-offset short strangle premiums across
the next 4 expiries, with client-side Min RoM/Risk Profile/Distance
filters and Good/Great RoM conditional formatting. All filter changes
apply instantly over the already-fetched matrix — no re-fetch."
```

---

## Post-Implementation

After all 3 tasks are committed on the worktree branch, push the branch, then merge into `master` and push — matching the pattern already established earlier in this session (`worktree-ultimate-scanner-*` branches, each merged with `--no-ff` and pushed after implementation). Report back: what was built, the route/page paths, any verification steps that were skipped due to no live server/session being available, and the one known pre-existing limitation carried over unchanged (RoM% uses the flat margin estimate, not live-per-cell margin).
