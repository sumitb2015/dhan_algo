# Multi-Leg Focus Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/multi-leg-focus` page: dropdown-based N-leg option strategy builder seeded from Baskets' preset templates, broker-aware order placement, and a browser-polled live P&L view with manual per-leg/whole-basket exit — styled to match `FocusTool.tsx`'s visual shell, without FocusTool's server worker, automated SL/target, or atomic strike-roll machinery.

**Architecture:** New data model (`lib/multiLegFocus.ts`) and new components, reusing `Baskets`' preset/order infrastructure (`lib/basketStrategies.ts`, `components/basket/StrategyCardGrid.tsx`, `lib/basketOrders.ts`) unchanged, and reusing the broker-position-matching helpers (`lib/positionProduct.ts`) already shared by Scalper/FocusTool. Pure logic lives in `lib/` and is unit-tested with `node --test`; the persistence layer and React components are verified manually in the browser, matching this codebase's existing convention (`lib/focusToolRows.ts`'s fs I/O and every FocusTool/Baskets/Scalper component are untested the same way).

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind, `node --test` for pure-logic unit tests.

**Spec:** `docs/superpowers/specs/2026-09-01-multi-leg-focus-design.md`

## Global Constraints

- Never hardcode a colour — use the zinc ramp/tokens per `CLAUDE.md`'s theming rules; no slash-opacity on text colors.
- Table headers: `text-xs font-bold text-white` on solid `bg-zinc-800`.
- No new backend routes beyond `app/api/multi-leg-focus/baskets/route.ts`; no changes to `FocusTool.tsx`, `Baskets.tsx`, or any file under `components/basket/`.
- Single front-month expiry only. The `Calendar` category from `STRATEGY_CATEGORIES` (far-expiry legs) is not supported by this page — `StrategyCardGrid` is reused unmodified and still lists it, so selecting a Calendar template must show a toast explaining it isn't supported here and leave the leg list untouched, rather than silently placing a far-expiry leg on the front expiry.
- No automated SL/target, no server worker, no shutdown-trigger file, no atomic strike-roll. A basket that needs a different strike is closed and a new one opened manually.
- Every task that touches `.ts`/`.tsx` files ends with `cd rs_dashboard && npx tsc --noEmit` passing before commit.

---

## Task 1: Multi-leg data model & pure ledger/P&L helpers

**Files:**
- Create: `rs_dashboard/lib/multiLegFocus.ts`
- Test: `rs_dashboard/lib/multiLegFocus.test.ts`

**Interfaces:**
- Consumes: `nearestStrike`, `type LegSide`, `type OptionType`, `type StrategyTemplate` from `./basketStrategies`; `positionProduct`, `findLivePosition`, `type LiveMatch` from `./positionProduct`.
- Produces: `type MultiLegStatus = 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED'`, `interface MultiLegLeg { id: string, side: LegSide, option: OptionType, strike: number, lots: number, type: 'MARKET'|'LIMIT', price?: number, fill?: { qty: number, avgPrice: number }, orderRef?: { securityId?: string, symbol?: string }, status: MultiLegStatus }`, `interface MultiLegBasket { id: string, underlying: string, expiry: string, broker: string, presetKey?: string, legs: MultiLegLeg[], createdAt: string, updatedAt: string }`, `resolveTemplateLegs(template: StrategyTemplate, atmStrike: number, allStrikes: number[], step: number): MultiLegLeg[]`, `reconcileLegFillDown(leg: MultiLegLeg, brokerAbsQty: number | null): MultiLegLeg`, `legPnl(leg: MultiLegLeg, ltp: number): number`, `basketTotalPnl(legs: MultiLegLeg[], ltpFor: (leg: MultiLegLeg) => number): number`, `sortLegsForExit<T extends { side: LegSide }>(legs: T[]): T[]`, `findLegPosition(broker: string, leg: MultiLegLeg, rows: Record<string, unknown>[]): LiveMatch`.

- [ ] **Step 1: Write the failing tests**

Create `rs_dashboard/lib/multiLegFocus.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveTemplateLegs, reconcileLegFillDown, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  type MultiLegLeg,
} from './multiLegFocus.ts';
import type { StrategyTemplate } from './basketStrategies.ts';

test('resolveTemplateLegs resolves offsets to nearest listed strikes and seeds DRAFT status', () => {
  const template: StrategyTemplate = {
    key: 'short-strangle', name: 'Short Strangle',
    legs: [{ side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 2 }],
  };
  const strikes = [23600, 23800, 24000, 24200, 24400];
  const legs = resolveTemplateLegs(template, 24000, strikes, 200);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].strike, 24400);
  assert.strictEqual(legs[0].option, 'CE');
  assert.strictEqual(legs[0].lots, 1);
  assert.strictEqual(legs[1].strike, 23600);
  assert.strictEqual(legs[1].lots, 2);
  assert.ok(legs.every(l => l.status === 'DRAFT' && l.type === 'MARKET' && !l.fill));
  assert.notStrictEqual(legs[0].id, legs[1].id);
});

test('reconcileLegFillDown shrinks a leg\'s fill qty to a smaller broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 50);
  assert.strictEqual(out.fill?.qty, 50);
  assert.strictEqual(out.status, 'OPEN');
});

test('reconcileLegFillDown never grows a leg\'s fill qty upward from a larger broker quantity', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 150);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown leaves the leg alone when the broker quantity is unknown (null)', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, null);
  assert.strictEqual(out.fill?.qty, 75);
});

test('reconcileLegFillDown marks the leg CLOSED once the broker quantity reaches zero', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  const out = reconcileLegFillDown(leg, 0);
  assert.strictEqual(out.fill?.qty, 0);
  assert.strictEqual(out.status, 'CLOSED');
});

test('legPnl: a filled SELL leg profits as LTP falls below the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 120 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (120-100) * 75
});

test('legPnl: a filled BUY leg profits as LTP rises above the entry average', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 80 } };
  assert.strictEqual(legPnl(leg, 100), 1500); // (100-80) * 75
});

test('legPnl returns 0 for a leg with no fill yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'B', option: 'PE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.strictEqual(legPnl(leg, 100), 0);
});

test('basketTotalPnl sums legPnl across every leg using the caller-supplied LTP lookup', () => {
  const legs: MultiLegLeg[] = [
    { id: '1', side: 'S', option: 'CE', strike: 24400, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 40 } },
    { id: '2', side: 'S', option: 'PE', strike: 23600, lots: 1, type: 'MARKET', status: 'OPEN', fill: { qty: 75, avgPrice: 35 } },
  ];
  const ltpFor = (l: MultiLegLeg) => (l.option === 'CE' ? 30 : 50);
  // CE: (40-30)*75=750, PE: (35-50)*75=-1125
  assert.strictEqual(basketTotalPnl(legs, ltpFor), 750 + -1125);
});

test('sortLegsForExit orders all SELL legs before all BUY legs, preserving relative order within each group', () => {
  const legs = [
    { side: 'B' as const, id: 1 }, { side: 'S' as const, id: 2 },
    { side: 'B' as const, id: 3 }, { side: 'S' as const, id: 4 },
  ];
  assert.deepStrictEqual(sortLegsForExit(legs).map(l => l.id), [2, 4, 1, 3]);
});

test('findLegPosition matches a Dhan leg by securityId, ignoring symbol', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { securityId: '999' } };
  const rows = [{ securityId: '999', tradingSymbol: 'NIFTY24721C24000', productType: 'MARGIN', netQty: -75 }];
  const match = findLegPosition('dhan', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition matches a non-Dhan leg by symbol and product', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', orderRef: { symbol: 'NIFTY24721C24000' } };
  const rows = [{ tradingSymbol: 'NIFTY24721C24000', product: 'MIS', netQty: -75 }];
  const match = findLegPosition('zerodha', leg, rows);
  assert.strictEqual(match.kind, 'match');
});

test('findLegPosition reports flat for a leg with no orderRef yet', () => {
  const leg: MultiLegLeg = { id: '1', side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'DRAFT' };
  assert.deepStrictEqual(findLegPosition('dhan', leg, []), { kind: 'flat' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rs_dashboard && node --test lib/multiLegFocus.test.ts`
Expected: FAIL — `Cannot find module './multiLegFocus.ts'`.

- [ ] **Step 3: Write the implementation**

Create `rs_dashboard/lib/multiLegFocus.ts`:

```ts
// Data model, preset resolution, and pure ledger/P&L math for the Multi-Leg
// Focus terminal. Order placement itself reuses lib/basketOrders.ts unchanged;
// this module only owns what's new — an N-leg fill ledger and its own
// broker-position matching (Dhan's scalper lookup route returns securityId,
// not a trading symbol, so lib/positionProduct.ts's symbol-only matcher can't
// be used for Dhan legs as-is).

import { nearestStrike, type LegSide, type OptionType, type StrategyTemplate } from './basketStrategies';
import { positionProduct, findLivePosition, type LiveMatch } from './positionProduct';

export type MultiLegStatus = 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface MultiLegLeg {
  id: string;
  side: LegSide;
  option: OptionType;
  strike: number;
  lots: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;              // manual override, only used when type === 'LIMIT'
  /** This basket's own fill ledger for this leg — never derived from broker net qty. */
  fill?: { qty: number; avgPrice: number };
  /** Captured from the order response at placement time; used to match this
   *  leg's own broker position row on every monitoring poll. */
  orderRef?: { securityId?: string; symbol?: string };
  status: MultiLegStatus;
}

export interface MultiLegBasket {
  id: string;
  underlying: string;
  expiry: string;
  broker: string;
  presetKey?: string;
  legs: MultiLegLeg[];
  createdAt: string;
  updatedAt: string;
}

let _legSeq = 0;
function newLegId(): string {
  _legSeq += 1;
  return `mll_${Date.now().toString(36)}_${_legSeq.toString(36)}`;
}

/** Resolves a preset template's ATM-relative legs to real strikes, producing a
 *  fresh draft leg list. Does not place any orders. */
export function resolveTemplateLegs(
  template: StrategyTemplate,
  atmStrike: number,
  allStrikes: number[],
  step: number,
): MultiLegLeg[] {
  return template.legs.map(tl => ({
    id: newLegId(),
    side: tl.side,
    option: tl.option,
    strike: nearestStrike(allStrikes, atmStrike + tl.offset * step) ?? atmStrike,
    lots: tl.ratio,
    type: 'MARKET' as const,
    status: 'DRAFT' as const,
  }));
}

/**
 * Reconciles a leg's own fill ledger against the broker's live position,
 * strictly downward — same rule as FocusRowFill in lib/focusToolRows.ts.
 * `brokerAbsQty` of `null` means the broker position couldn't be resolved
 * this tick; the ledger is left untouched rather than guessed at.
 */
export function reconcileLegFillDown(leg: MultiLegLeg, brokerAbsQty: number | null): MultiLegLeg {
  if (brokerAbsQty == null || !leg.fill) return leg;
  if (brokerAbsQty >= leg.fill.qty) return leg;
  return {
    ...leg,
    fill: { ...leg.fill, qty: brokerAbsQty },
    status: brokerAbsQty === 0 ? 'CLOSED' : leg.status,
  };
}

/** This leg's own P&L against `ltp`, sized off its own fill ledger only. */
export function legPnl(leg: MultiLegLeg, ltp: number): number {
  if (!leg.fill || leg.fill.qty <= 0) return 0;
  const perUnit = leg.side === 'B' ? ltp - leg.fill.avgPrice : leg.fill.avgPrice - ltp;
  return perUnit * leg.fill.qty;
}

export function basketTotalPnl(legs: MultiLegLeg[], ltpFor: (leg: MultiLegLeg) => number): number {
  return legs.reduce((sum, l) => sum + legPnl(l, ltpFor(l)), 0);
}

/** SELL legs first, then BUY legs — closing a SELL leg is a risk-reducing BUY,
 *  so this exits the higher-margin-risk side first, mirroring the intent of
 *  basketOrders.sortLegsForPlacement's BUY-first entry ordering in reverse. */
export function sortLegsForExit<T extends { side: LegSide }>(legs: T[]): T[] {
  return [...legs.filter(l => l.side === 'S'), ...legs.filter(l => l.side === 'B')];
}

/**
 * Locates a leg's own live broker position row.
 *
 * Dhan legs carry only `orderRef.securityId` (the scalper lookup route never
 * returns a trading symbol for Dhan), so they're matched directly by
 * securityId rather than through lib/positionProduct's symbol-based
 * findLivePosition. Every other broker carries `orderRef.symbol` and is
 * matched via findLivePosition exactly as Scalper.tsx already does.
 */
export function findLegPosition(
  broker: string,
  leg: MultiLegLeg,
  rows: Record<string, unknown>[],
): LiveMatch {
  if (!leg.orderRef) return { kind: 'flat' };

  if (broker === 'dhan' && leg.orderRef.securityId) {
    const matches = rows.filter(r => String(r.securityId ?? '') === leg.orderRef!.securityId);
    if (matches.length === 0) return { kind: 'flat' };
    if (matches.length > 1) return { kind: 'ambiguous', count: matches.length };
    return { kind: 'match', row: matches[0] };
  }

  if (leg.orderRef.symbol) {
    return findLivePosition(rows, { tradingSymbol: leg.orderRef.symbol });
  }
  return { kind: 'flat' };
}

// Re-exported for callers that only need to inspect a matched row's product
// without importing lib/positionProduct.ts separately.
export { positionProduct };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/multiLegFocus.test.ts`
Expected: `pass 12`, `fail 0`.

- [ ] **Step 5: Type-check and commit**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

```bash
git add rs_dashboard/lib/multiLegFocus.ts rs_dashboard/lib/multiLegFocus.test.ts
git commit -m "feat(multi-leg-focus): add N-leg data model and pure ledger/P&L helpers"
```

---

## Task 2: Basket persistence (JSON file store)

**Files:**
- Create: `rs_dashboard/lib/multiLegFocusStore.ts`

**Interfaces:**
- Consumes: `type MultiLegBasket` from `./multiLegFocus` (Task 1); `PROJECT_ROOT` from `./pyExec`.
- Produces: `readBaskets(): MultiLegBasket[]`, `writeBaskets(baskets: MultiLegBasket[]): void`, `upsertBasket(basket: Partial<MultiLegBasket> & { id?: string }): MultiLegBasket[]`, `deleteBasket(id: string): MultiLegBasket[]`, `newBasketId(): string`.

**Why untested:** this file's job is fs I/O against `debug/multi_leg_baskets.json`, the same category of code as `lib/focusToolRows.ts`'s `readFocusConfig`/`writeFocusConfig` — which has no test file in this codebase. Verified manually via the API route in Task 3 and the browser in Task 8.

- [ ] **Step 1: Write the implementation**

Create `rs_dashboard/lib/multiLegFocusStore.ts`:

```ts
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import type { MultiLegBasket } from './multiLegFocus';

const STORE_FILE = path.join(PROJECT_ROOT, 'debug', 'multi_leg_baskets.json');

interface Store {
  baskets: MultiLegBasket[];
}

function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readBaskets(): MultiLegBasket[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Partial<Store>;
    return Array.isArray(raw.baskets) ? raw.baskets : [];
  } catch {
    return [];
  }
}

export function writeBaskets(baskets: MultiLegBasket[]): void {
  writeJsonAtomic(STORE_FILE, { baskets });
}

/** Upsert one basket — full-basket save or a smaller patch merged onto the
 *  existing record. Last-write-wins, matching focusToolRows.ts's rationale:
 *  this is a single-user local tool saving from many independent places
 *  (place, exit-leg, exit-basket), and an optimistic-concurrency reject would
 *  discard a real user action more often than it would prevent a real
 *  collision. */
export function upsertBasket(basket: Partial<MultiLegBasket> & { id?: string }): MultiLegBasket[] {
  const baskets = readBaskets();
  const now = new Date().toISOString();
  const idx = basket.id ? baskets.findIndex(b => b.id === basket.id) : -1;
  if (idx >= 0) {
    baskets[idx] = { ...baskets[idx], ...basket, updatedAt: now } as MultiLegBasket;
  } else {
    baskets.push({
      id: basket.id ?? newBasketId(),
      underlying: basket.underlying ?? 'NIFTY',
      expiry: basket.expiry ?? '',
      broker: basket.broker ?? 'dhan',
      presetKey: basket.presetKey,
      legs: basket.legs ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }
  writeBaskets(baskets);
  return baskets;
}

export function deleteBasket(id: string): MultiLegBasket[] {
  const baskets = readBaskets().filter(b => b.id !== id);
  writeBaskets(baskets);
  return baskets;
}

let _basketSeq = 0;
export function newBasketId(): string {
  _basketSeq += 1;
  return `mlf_${Date.now().toString(36)}_${_basketSeq.toString(36)}`;
}
```

- [ ] **Step 2: Type-check and commit**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

```bash
git add rs_dashboard/lib/multiLegFocusStore.ts
git commit -m "feat(multi-leg-focus): add JSON-file basket persistence store"
```

---

## Task 3: Basket persistence API route

**Files:**
- Create: `rs_dashboard/app/api/multi-leg-focus/baskets/route.ts`

**Interfaces:**
- Consumes: `readBaskets`, `upsertBasket`, `deleteBasket` from `@/lib/multiLegFocusStore` (Task 2); `type MultiLegBasket` from `@/lib/multiLegFocus` (Task 1).
- Produces: `GET` → `{ success: true, data: MultiLegBasket[] }`; `POST` (body: `Partial<MultiLegBasket> & { id?: string }`) → upserts, returns `{ success: true, data: MultiLegBasket[] }`; `DELETE` (body: `{ id: string }`) → `{ success: true, data: MultiLegBasket[] }`.

- [ ] **Step 1: Write the route**

Create `rs_dashboard/app/api/multi-leg-focus/baskets/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { readBaskets, upsertBasket, deleteBasket } from '@/lib/multiLegFocusStore';
import type { MultiLegBasket } from '@/lib/multiLegFocus';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: readBaskets() });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as Partial<MultiLegBasket> & { id?: string };
    const baskets = upsertBasket(body);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await req.json() as { id: string };
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const baskets = deleteBasket(id);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check and manually verify**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

With the dev server running and a valid `dhan_session` cookie (see `dashboard-api-auth-testing` memory / `docs/API_GOTCHAS.md`), run:

```bash
curl -s http://localhost:3000/api/multi-leg-focus/baskets -H "Cookie: dhan_session=<token>"
```

Expected: `{"success":true,"data":[]}` (empty until Task 8's page can create one).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/app/api/multi-leg-focus/baskets/route.ts
git commit -m "feat(multi-leg-focus): add basket persistence API route"
```

---

## Task 4: Leg row component (dropdown-based leg editor)

**Files:**
- Create: `rs_dashboard/components/multiLegFocus/MultiLegLegRow.tsx`

**Interfaces:**
- Consumes: `type MultiLegLeg`, `legPnl` from `@/lib/multiLegFocus` (Task 1).
- Produces: default export `MultiLegLegRow(props: { leg: MultiLegLeg, allStrikes: number[], ltp: number, editable: boolean, onChange: (patch: Partial<MultiLegLeg>) => void, onRemove: () => void, onExit: () => void })` — a single `<tr>` meant to be rendered inside the parent's `<table>`.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/multiLegFocus/MultiLegLegRow.tsx`:

```tsx
'use client';

import React from 'react';
import { X } from 'lucide-react';
import { legPnl, type MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '@/components/Scalper';

const SELECT_CLASS = `h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

const STATUS_STYLE: Record<MultiLegLeg['status'], string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

interface MultiLegLegRowProps {
  leg: MultiLegLeg;
  allStrikes: number[];
  ltp: number;
  editable: boolean;
  onChange: (patch: Partial<MultiLegLeg>) => void;
  onRemove: () => void;
  onExit: () => void;
}

export default function MultiLegLegRow({
  leg, allStrikes, ltp, editable, onChange, onRemove, onExit,
}: MultiLegLegRowProps) {
  const pnl = leg.fill ? legPnl(leg, ltp) : 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400';

  return (
    <tr className="border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">
      <td className="px-3 py-2">
        <select value={leg.side} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ side: e.target.value as MultiLegLeg['side'] })}>
          <option value="B">BUY</option>
          <option value="S">SELL</option>
        </select>
      </td>
      <td className="px-2 py-2">
        <select value={leg.option} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ option: e.target.value as MultiLegLeg['option'] })}>
          <option value="CE">CE</option>
          <option value="PE">PE</option>
        </select>
      </td>
      <td className="px-2 py-2">
        <select value={leg.strike} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ strike: Number(e.target.value) })}>
          {!allStrikes.includes(leg.strike) && <option value={leg.strike}>{leg.strike}</option>}
          {allStrikes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className="px-2 py-2">
        <input type="number" min={1} value={leg.lots} disabled={!editable}
          onChange={e => onChange({ lots: Math.max(1, Number(e.target.value) || 1) })}
          className={`h-8 w-16 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded-lg px-2 text-center focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`} />
      </td>
      <td className="px-2 py-2">
        <select value={leg.type} disabled={!editable} className={SELECT_CLASS}
          onChange={e => onChange({ type: e.target.value as MultiLegLeg['type'] })}>
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
        </select>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300 tabular-nums">
        {ltp > 0 ? ltp.toFixed(2) : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs font-bold tabular-nums">
        {leg.fill ? <span className={pnlColor}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}</span> : <span className="text-zinc-600">—</span>}
      </td>
      <td className="px-2 py-2 text-center">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[leg.status]}`}>
          {leg.status}
        </span>
      </td>
      <td className="px-2 py-2 text-center">
        {leg.status === 'OPEN' ? (
          <button onClick={onExit} aria-label="Exit this leg" title="Exit this leg"
            className={`text-[10px] font-bold text-rose-400 hover:text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30 hover:bg-rose-500/10 ${FOCUS_RING}`}>
            EXIT
          </button>
        ) : editable ? (
          <button onClick={onRemove} aria-label="Remove leg" title="Remove leg"
            className={`w-6 h-6 inline-flex items-center justify-center text-zinc-500 hover:text-rose-300 ${FOCUS_RING}`}>
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors. (Not wired into any page yet — visually verified in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/multiLegFocus/MultiLegLegRow.tsx
git commit -m "feat(multi-leg-focus): add dropdown-based leg editor row"
```

---

## Task 5: Page shell — bootstrap, preset picker, leg editor

**Files:**
- Create: `rs_dashboard/components/MultiLegFocus.tsx`

**Interfaces:**
- Consumes: `NavBar` (default export) from `./NavBar`; `type Toast` from `./Scalper`; `useLiveOptionsWS` from `@/lib/useLiveOptionsWS`; `useBrokerSelector`, `scalperRoute`, `BROKER_LABELS`, `type Broker` from `@/hooks/useBrokerSelector`; `STRATEGY_CATEGORIES`, `type StrategyCategory`, `type StrategyTemplate`, `nearestStrike`, `strikeStep` from `@/lib/basketStrategies`; `type StrikeIdentifier` from `@/lib/basketOrders`; `StrategyCardGrid` (default export) from `./basket/StrategyCardGrid`; `resolveTemplateLegs`, `type MultiLegLeg`, `type MultiLegBasket` from `@/lib/multiLegFocus`; `MultiLegLegRow` (default export) from `./multiLegFocus/MultiLegLegRow`.
- Produces: default export `MultiLegFocus()` — the page component. State/handlers this task establishes (`legs`, `setLegs`, `addBlankLeg`, `applyTemplate`, `removeLeg`, `updateLeg`) are consumed by Tasks 6 and 7, which append to this same file.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/MultiLegFocus.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import NavBar from './NavBar';
import { type Toast, FOCUS_RING } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate, nearestStrike, strikeStep,
} from '@/lib/basketStrategies';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import StrategyCardGrid from './basket/StrategyCardGrid';
import MultiLegLegRow from './multiLegFocus/MultiLegLegRow';
import {
  resolveTemplateLegs, reconcileLegFillDown, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  positionProduct, type MultiLegLeg, type MultiLegBasket,
} from '@/lib/multiLegFocus';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = typeof UNDERLYINGS[number];

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function MultiLegFocus() {
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker } = useBrokerSelector();
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [allStrikes, setAllStrikes] = useState<number[]>([]);
  const [chainSpot, setChainSpot] = useState(0);
  const [strikeMap, setStrikeMap] = useState<Record<string, StrikeIdentifier>>({});
  const [lotSize, setLotSize] = useState<number | null>(null);

  const { liveQuotes } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);
  const spot = liveQuotes?.spot ?? chainSpot;
  const step = useMemo(() => strikeStep(allStrikes), [allStrikes]);
  const atmStrike = useMemo(() => (spot > 0 ? nearestStrike(allStrikes, spot) : null), [allStrikes, spot]);

  const ltpFor = useCallback((leg: MultiLegLeg): number => {
    const entry = liveQuotes?.strikes?.[String(leg.strike)];
    return (leg.option === 'CE' ? entry?.ce?.ltp : entry?.pe?.ltp) ?? 0;
  }, [liveQuotes]);

  const [category, setCategory] = useState<StrategyCategory>('Range Bound');
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [legs, setLegs] = useState<MultiLegLeg[]>([]);
  const [basketId, setBasketId] = useState<string | null>(null);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  const expiryRef = useRef(''); useEffect(() => { expiryRef.current = expiry; }, [expiry]);
  const underlyingRef = useRef<Underlying>(underlying); useEffect(() => { underlyingRef.current = underlying; }, [underlying]);

  // Any leg already placed (has an orderRef) locks the whole editor — a basket
  // is placed once, then only monitored/exited, never edited mid-flight.
  const hasPlacedLeg = legs.some(l => l.status !== 'DRAFT');

  // ── Expiries: reload on broker/underlying change ────────────────
  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(prev => j.data!.includes(prev) ? prev : j.data![0]);
        }
      })
      .catch(() => {});
  }, [broker, underlying]);

  // ── Option chain: strikes + spot ─────────────────────────────────
  useEffect(() => {
    if (!expiry) return;
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { strikes?: number[]; spot?: number } }) => {
        if (j.success && j.data) {
          setAllStrikes(j.data.strikes ?? []);
          setChainSpot(j.data.spot ?? 0);
        }
      })
      .catch(() => {});
  }, [broker, underlying, expiry]);

  // ── Strike -> order-identifier lookup ────────────────────────────
  useEffect(() => {
    if (!expiry) { setStrikeMap({}); return; }
    const lookupUrl = `${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIdentifier> } }) => {
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes ?? {});
          setLotSize(j.data.lotSize ?? null);
        }
      })
      .catch(() => {});
  }, [broker, underlying, expiry]);

  // ── Preset -> legs ────────────────────────────────────────────────
  const applyTemplate = useCallback((tpl: StrategyTemplate) => {
    if (hasPlacedLeg) return;
    if (tpl.legs.some(l => l.expiryRole === 'far')) {
      addToast('error', 'Not supported here', `${tpl.name} needs a second expiry — use the Baskets page for calendar/diagonal spreads`);
      return;
    }
    if (atmStrike == null) {
      addToast('error', 'Cannot apply template', 'Option chain not loaded yet — retry in a moment');
      return;
    }
    setPresetKey(tpl.key);
    setLegs(resolveTemplateLegs(tpl, atmStrike, allStrikes, step));
    setBasketId(null);
  }, [hasPlacedLeg, atmStrike, allStrikes, step, addToast]);

  const addBlankLeg = useCallback(() => {
    if (hasPlacedLeg) return;
    if (atmStrike == null) {
      addToast('error', 'Cannot add leg', 'Option chain not loaded yet — retry in a moment');
      return;
    }
    setPresetKey(null);
    setLegs(prev => [...prev, ...resolveTemplateLegs(
      { key: 'manual', name: 'Manual', legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }] },
      atmStrike, allStrikes, step,
    )]);
  }, [hasPlacedLeg, atmStrike, allStrikes, step, addToast]);

  const removeLeg = useCallback((id: string) => {
    if (hasPlacedLeg) return;
    setLegs(prev => prev.filter(l => l.id !== id));
  }, [hasPlacedLeg]);

  const updateLeg = useCallback((id: string, patch: Partial<MultiLegLeg>) => {
    if (hasPlacedLeg) return;
    setLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, [hasPlacedLeg]);

  const clearBasket = useCallback(() => {
    if (hasPlacedLeg) return;
    setLegs([]); setPresetKey(null); setBasketId(null);
  }, [hasPlacedLeg]);

  return (
    <div className="min-h-screen bg-zinc-950">
      <NavBar />

      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success' ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-80 mt-0.5">{t.detail}</p>}
          </div>
        ))}
      </div>

      {!hasAuthenticatedBroker && (
        <div className="z-20 bg-amber-900/95 border-b border-amber-500/40 px-4 py-2 text-center">
          <p className="text-xs font-bold text-amber-200">No broker logged in — log in to fetch live data and place orders.</p>
        </div>
      )}

      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select value={broker} onChange={e => setBroker(e.target.value as Broker)}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}>
            {(Object.keys(BROKER_LABELS) as Broker[]).map(b => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
          </select>
          <select value={underlying} onChange={e => setUnderlying(e.target.value as Underlying)} disabled={hasPlacedLeg}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}>
            {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={expiry} onChange={e => setExpiry(e.target.value)} disabled={hasPlacedLeg}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}>
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <span className="h-8 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
            Spot {spot > 0 ? spot.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
          </span>
        </div>

        <div className="mt-2 pt-2 border-t border-zinc-800">
          <StrategyCardGrid
            category={category}
            onCategoryChange={setCategory}
            selectedKey={presetKey}
            onSelectTemplate={applyTemplate}
            disabled={hasPlacedLeg}
          />
        </div>
      </div>

      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">
            Legs{legs.length > 0 ? ` · ${legs.length}` : ''}
          </span>
          <button onClick={addBlankLeg} disabled={hasPlacedLeg}
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS_RING}`}>
            <Plus className="w-3 h-3" /> Add Leg
          </button>
          {legs.length > 0 && !hasPlacedLeg && (
            <button onClick={clearBasket}
              className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:bg-zinc-800 ${FOCUS_RING}`}>
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      </div>

      {legs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-1.5">
          <p className="text-sm font-semibold text-zinc-400">No legs yet</p>
          <p className="text-xs text-zinc-500">Pick a predefined strategy above or add legs manually</p>
        </div>
      ) : (
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[14%]" />
            <col className="w-[8%]" /><col className="w-[12%]" /><col className="w-[12%]" />
            <col className="w-[14%]" /><col className="w-[12%]" /><col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
              <th className="px-3 py-2.5 text-left">Side</th>
              <th className="px-2 py-2.5 text-left">CE/PE</th>
              <th className="px-2 py-2.5 text-left">Strike</th>
              <th className="px-2 py-2.5 text-left">Lots</th>
              <th className="px-2 py-2.5 text-left">Type</th>
              <th className="px-2 py-2.5 text-right">LTP</th>
              <th className="px-2 py-2.5 text-right">P&L</th>
              <th className="px-2 py-2.5 text-center">Status</th>
              <th className="px-2 py-2.5 text-center"></th>
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => (
              <MultiLegLegRow
                key={leg.id}
                leg={leg}
                allStrikes={allStrikes}
                ltp={ltpFor(leg)}
                editable={!hasPlacedLeg}
                onChange={patch => updateLeg(leg.id, patch)}
                onRemove={() => removeLeg(leg.id)}
                onExit={() => {}}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors. (`onExit={() => {}}` is a temporary no-op replaced in Task 7; `sortLegsForPlacement`, `resolveOrderRequest`, `reconcileLegFillDown`, `legPnl`, `basketTotalPnl`, `sortLegsForExit`, `findLegPosition`, `positionProduct`, `MultiLegBasket`, `basketId` are imported/declared here for Task 6/7 to use and are expected to show as unused in this task only if your linter runs in strict unused-import mode — if so, keep them; Task 6 starts consuming them immediately after.)

- [ ] **Step 3: Manually verify in the browser**

Run `cd rs_dashboard && npm run dev`, open `http://localhost:3000/multi-leg-focus` (404 is expected until Task 8 adds the route — for this step, temporarily render `<MultiLegFocus />` from any existing page, e.g. swap it in for `<Baskets />` in `app/baskets/page.tsx`, verify, then revert that temporary edit before committing).

Confirm: category chips switch, selecting "Short Strangle" under Range Bound populates 2 legs at the expected strikes, selecting "Iron Condor" populates 4 legs, "Add Leg" appends a blank ATM CE buy leg, each leg's Side/Option/Strike/Type dropdowns and Lots input are editable, Remove (X) removes a leg, Clear empties the table.

- [ ] **Step 4: Commit**

```bash
git add rs_dashboard/components/MultiLegFocus.tsx
git commit -m "feat(multi-leg-focus): add page shell with preset picker and leg editor"
```

---

## Task 6: Order placement

**Files:**
- Modify: `rs_dashboard/components/MultiLegFocus.tsx` (append state/handlers, add a Place button to the header)

**Interfaces:**
- Consumes: everything from Task 5's file, plus `sortLegsForPlacement`, `resolveOrderRequest` (already imported in Task 5).
- Produces: `placeBasket` (wired to a new "Place Basket" button), `rollbackPlacedLegs` — both closures inside `MultiLegFocus`. After this task, a successful leg order sets that leg's `status: 'OPEN'`, `fill: { qty, avgPrice }`, and `orderRef`; the basket is persisted via `POST /api/multi-leg-focus/baskets` after every leg outcome (success or failure), matching a real order sequence even if the page is closed mid-basket.

- [ ] **Step 1: Add placement state and handlers**

In `rs_dashboard/components/MultiLegFocus.tsx`, add below the `clearBasket` callback (still inside `MultiLegFocus`):

```tsx
  const [placing, setPlacing] = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const placingRef = useRef(false);

  const persistBasket = useCallback((nextLegs: MultiLegLeg[], id: string | null) => {
    const body: Partial<MultiLegBasket> & { id?: string } = {
      id: id ?? undefined, underlying, expiry, broker, presetKey: presetKey ?? undefined, legs: nextLegs,
    };
    fetch('/api/multi-leg-focus/baskets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (j.success && j.data && !id) {
          const created = j.data[j.data.length - 1];
          if (created) setBasketId(created.id);
        }
      })
      .catch(() => {});
  }, [underlying, expiry, broker, presetKey]);

  // Best-effort flatten of already-placed legs when a basket stops mid-way —
  // ported from Baskets.tsx's rollbackPlacedLegs, adapted to MultiLegLeg.
  const rollbackPlacedLegs = useCallback(async (placedIds: string[], currentLegs: MultiLegLeg[]) => {
    if (!placedIds.length) return;
    addToast('error', `Auto-flattening ${placedIds.length} placed leg(s)`, 'Reversing with market orders — verify in Orders/Positions after');
    for (const id of [...placedIds].reverse()) {
      const leg = currentLegs.find(l => l.id === id);
      if (!leg?.fill) continue;
      const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
      const reverseReq = resolveOrderRequest(broker, {
        side: leg.side === 'B' ? 'S' : 'B', option: leg.option, strike: leg.strike, qty: leg.fill.qty, type: 'MARKET', underlying,
        productType: 'MARGIN',
      }, strikeMap);
      if (!reverseReq) {
        addToast('error', `Could not auto-reverse ${label}`, 'No order identifier — close manually from Orders/Positions');
        continue;
      }
      try {
        const res = await fetch(reverseReq.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reverseReq.body),
        });
        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) addToast('success', `Reversed ${label}`, `ID: ${j.order_id}`);
        else addToast('error', `Reverse failed for ${label}`, `${j.error ?? 'Unknown error'} — close manually from Orders/Positions`);
      } catch (e) {
        addToast('error', `Reverse UNCONFIRMED for ${label}`, `Close manually from Orders/Positions: ${String(e)}`);
      }
    }
  }, [broker, underlying, strikeMap, addToast]);

  const placeBasket = useCallback(async () => {
    if (!legs.length || !expiry) return;
    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing a basket');
      return;
    }
    if (!lotSize || lotSize <= 0) {
      addToast('error', 'Cannot place basket', `Lot size for ${underlying} not resolved yet — retry in a moment`);
      return;
    }
    for (const leg of legs) {
      if (leg.type === 'LIMIT' && (!leg.price || leg.price <= 0)) {
        addToast('error', 'Invalid limit price', `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.strike} ${leg.option}`);
        return;
      }
    }
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    if (placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);

    const ordered = sortLegsForPlacement(legs);
    let working = legs.map(l => ({ ...l, status: 'PLACING' as const }));
    const placedIds: string[] = [];

    try {
      for (const leg of ordered) {
        const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
        const qty = leg.lots * lotSize;
        const req = resolveOrderRequest(broker, {
          side: leg.side, option: leg.option, strike: leg.strike, qty, type: leg.type,
          price: leg.type === 'LIMIT' ? leg.price : undefined, underlying, productType: 'MARGIN',
        }, strikeMap);
        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — basket stopped');
          working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
          setLegs(working); persistBasket(working, basketId);
          await rollbackPlacedLegs(placedIds, working);
          return;
        }
        try {
          const res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
          const j = await res.json() as { success: boolean; order_id?: string; error?: string };
          if (j.success) {
            const orderRef = broker === 'dhan' ? { securityId: String(req.body.securityId) } : { symbol: String(req.body.tradingsymbol) };
            // The order routes only return order_id, never a fill price — a MARKET
            // order's ack isn't its fill (see dhan-terminal-position-ownership).
            // Use the live LTP at send-time as the entry estimate, same convention
            // FocusRowFill.ceEntry/peEntry documents for FocusTool.
            const avgPrice = leg.type === 'LIMIT' ? (leg.price ?? ltpFor(leg)) : ltpFor(leg);
            working = working.map(l => (l.id === leg.id
              ? { ...l, status: 'OPEN' as const, fill: { qty, avgPrice }, orderRef }
              : l));
            placedIds.push(leg.id);
            addToast('success', `${label} placed`, `ID: ${j.order_id}`);
          } else {
            // Mark the failing leg AND every leg not yet attempted as FAILED —
            // leaving them at 'PLACING' would strand them there forever, since
            // the loop returns immediately and never revisits them.
            working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
            addToast('error', `${label} failed — basket stopped`, j.error ?? 'Unknown error');
            setLegs(working); persistBasket(working, basketId);
            await rollbackPlacedLegs(placedIds, working);
            return;
          }
        } catch (e) {
          working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
          addToast('error', `${label} UNCONFIRMED — basket stopped`, `Check Orders before retrying: ${String(e)}`);
          setLegs(working); persistBasket(working, basketId);
          await rollbackPlacedLegs(placedIds, working);
          return;
        }
      }
      setLegs(working);
      persistBasket(working, basketId);
      addToast('success', `Basket complete: ${placedIds.length}/${legs.length} legs placed`);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }, [legs, expiry, hasAuthenticatedBroker, lotSize, underlying, confirmPlace, broker, strikeMap, basketId, addToast, persistBasket, rollbackPlacedLegs, ltpFor]);
```

- [ ] **Step 2: Wire the Place button into the header**

In the same file, inside the "Legs" header `<div>` from Task 5 (the one containing "Add Leg"/"Clear"), add after the Clear button:

```tsx
          {legs.length > 0 && !hasPlacedLeg && (
            <button onClick={placeBasket} disabled={placing}
              className={`h-7 ml-auto px-3 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border transition-all disabled:opacity-50 ${
                confirmPlace ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20'
              } ${FOCUS_RING}`}>
              {placing ? 'Placing…' : confirmPlace ? 'Click again to confirm' : 'Place Basket'}
            </button>
          )}
```

- [ ] **Step 3: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify**

Using the same temporary-swap technique from Task 5 Step 3 (or wait for Task 8's real route), with a broker authenticated: build a small basket (e.g. Buy Call), click "Place Basket" once (button shows "Click again to confirm"), click again, confirm a toast reports the order placed and the leg's Status badge turns `OPEN` with a P&L column now showing a value. Confirm `GET /api/multi-leg-focus/baskets` now returns this basket. If your broker session allows it, deliberately trigger a failure (e.g. temporarily break `strikeMap` by selecting an expiry with no chain loaded) and confirm the basket halts and any already-placed legs get reversed with toasts.

- [ ] **Step 5: Commit**

```bash
git add rs_dashboard/components/MultiLegFocus.tsx
git commit -m "feat(multi-leg-focus): add sequenced order placement with rollback and persistence"
```

---

## Task 7: Live monitoring, P&L, and exits

**Files:**
- Modify: `rs_dashboard/components/MultiLegFocus.tsx` (append polling effect + exit handlers, restore the basket on mount, wire `onExit`)

**Interfaces:**
- Consumes: everything already imported in Task 5/6, plus `findLegPosition`, `reconcileLegFillDown`, `basketTotalPnl`, `sortLegsForExit`, `positionProduct` (already imported, unused until now).
- Produces: `exitLeg(id: string)`, `exitBasket()`; a polling effect that keeps `legs` reconciled against live broker positions whenever any leg is `OPEN`; a mount effect that restores the most recent open basket from `GET /api/multi-leg-focus/baskets`.

- [ ] **Step 1: Add the position-polling effect**

In `rs_dashboard/components/MultiLegFocus.tsx`, add after the `placeBasket` callback (still inside `MultiLegFocus`):

```tsx
  const legsRef = useRef(legs); useEffect(() => { legsRef.current = legs; }, [legs]);

  useEffect(() => {
    if (!legs.some(l => l.status === 'OPEN')) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'positions'));
        const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (cancelled || !j.success || !j.data) return;
        const rows = j.data;
        setLegs(prev => prev.map(leg => {
          if (leg.status !== 'OPEN') return leg;
          const match = findLegPosition(broker, leg, rows);
          const absQty = match.kind === 'match' ? Math.abs(Number(match.row.netQty) || 0) : (match.kind === 'flat' ? 0 : null);
          return reconcileLegFillDown(leg, absQty);
        }));
      } catch {
        // transient network/broker error — leave the ledger untouched this tick
      }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [broker, legs.some(l => l.status === 'OPEN')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restore the most recently updated open basket on mount ───────
  useEffect(() => {
    fetch('/api/multi-leg-focus/baskets')
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (!j.success || !j.data?.length) return;
        const open = [...j.data].filter(b => b.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING'))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!open) return;
        setBasketId(open.id);
        setUnderlying(open.underlying as Underlying);
        setExpiry(open.expiry);
        setPresetKey(open.presetKey ?? null);
        setLegs(open.legs);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPnl = useMemo(() => basketTotalPnl(legs, ltpFor), [legs, ltpFor]);
```

- [ ] **Step 2: Add exit handlers**

In the same file, add after the polling/restore effects:

```tsx
  const [exiting, setExiting] = useState<Set<string>>(new Set());

  const exitOneLeg = useCallback(async (leg: MultiLegLeg): Promise<boolean> => {
    if (leg.status !== 'OPEN') return true;
    setExiting(prev => new Set([...prev, leg.id]));
    setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSING' as const } : l)));
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;

    try {
      const res = await fetch(scalperRoute(broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (!j.success || !j.data) {
        addToast('error', `Cannot exit ${label}`, 'Failed to fetch live positions — try again');
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
        return false;
      }
      const match = findLegPosition(broker, leg, j.data);
      if (match.kind !== 'match') {
        // Never fall back to the local ledger qty once the broker match fails —
        // guessing the exit size here is exactly what the ownership rule forbids.
        addToast('error', `Cannot exit ${label}`, match.kind === 'ambiguous' ? `${match.count} rows share this symbol — close manually from Orders/Positions` : 'No matching broker position found — it may already be closed');
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: match.kind === 'flat' ? 'CLOSED' as const : 'OPEN' as const } : l)));
        return match.kind === 'flat';
      }
      const netQty = Number(match.row.netQty) || 0;
      if (netQty === 0) {
        addToast('success', `${label} already flat`);
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)));
        return true;
      }
      const product = positionProduct(match.row);
      const closeFields = broker === 'dhan' ? { productType: product } : { product };
      const side = netQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(netQty);
      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const body = broker === 'dhan'
        ? { securityId: leg.orderRef?.securityId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: match.row.exchangeSegment ?? 'NSE_FNO', ...closeFields }
        : { tradingsymbol: leg.orderRef?.symbol, quantity: qty, side, orderType: 'MARKET', exchange: match.row.exchange ?? 'NFO', ...closeFields };

      const res2 = await fetch(orderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j2 = await res2.json() as { success: boolean; order_id?: string; error?: string };
      if (j2.success) {
        addToast('success', `Exited ${label}`, `ID: ${j2.order_id}`);
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)));
        return true;
      }
      addToast('error', `Exit failed for ${label}`, j2.error ?? 'Unknown error');
      setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
      return false;
    } catch (e) {
      addToast('error', `Exit UNCONFIRMED for ${label}`, `Check Orders/Positions manually: ${String(e)}`);
      setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
      return false;
    } finally {
      setExiting(prev => { const next = new Set(prev); next.delete(leg.id); return next; });
    }
  }, [broker, addToast]);

  const exitLeg = useCallback((id: string) => {
    const leg = legsRef.current.find(l => l.id === id);
    if (leg) exitOneLeg(leg).then(() => persistBasket(legsRef.current, basketId));
  }, [exitOneLeg, persistBasket, basketId]);

  const exitBasket = useCallback(async () => {
    const ordered = sortLegsForExit(legsRef.current.filter(l => l.status === 'OPEN'));
    for (const leg of ordered) {
      await exitOneLeg(leg);
    }
    persistBasket(legsRef.current, basketId);
  }, [exitOneLeg, persistBasket, basketId]);
```

- [ ] **Step 3: Wire `onExit` and add the total P&L tile + Exit Basket button**

In the same file:
1. Replace `onExit={() => {}}` in the `<MultiLegLegRow>` mapping (from Task 5) with `onExit={() => exitLeg(leg.id)}`.
2. In the header `<div>` that holds "Legs · N" / Add Leg / Clear / Place Basket (from Tasks 5 and 6), add a P&L tile and Exit Basket button, shown once any leg has opened:

```tsx
          {legs.some(l => l.status === 'OPEN' || l.status === 'CLOSING') && (
            <>
              <span className={`h-7 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums border ${
                totalPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
              }`}>
                {totalPnl >= 0 ? '+' : ''}{fmtMoney(totalPnl)}
              </span>
              <button onClick={exitBasket}
                className={`h-7 px-3 text-[11px] font-bold rounded-lg border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 ${FOCUS_RING}`}>
                Exit Basket
              </button>
            </>
          )}
```

- [ ] **Step 4: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify**

With a basket placed from Task 6's verification still open: confirm the P&L tile appears and updates every ~3s as the underlying LTP moves; click a single leg's EXIT and confirm only that leg closes (Status → `CLOSED`) while the rest of the basket and its P&L are unaffected; then click "Exit Basket" and confirm all remaining open legs close in SELL-then-BUY order. Refresh the page mid-basket (before exiting) and confirm the open basket and its live P&L reappear via the mount-restore effect.

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/components/MultiLegFocus.tsx
git commit -m "feat(multi-leg-focus): add live P&L polling, per-leg exit, and exit-basket"
```

---

## Task 8: Route, navigation, and end-to-end verification

**Files:**
- Create: `rs_dashboard/app/multi-leg-focus/page.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx` (add nav entry to the Derivatives/terminals group alongside `/scalper`, `/focus-tool`, `/baskets`)

**Interfaces:**
- Consumes: `MultiLegFocus` (default export) from `@/components/MultiLegFocus` (Task 7).
- Produces: the page at `/multi-leg-focus`.

- [ ] **Step 1: Create the page**

Create `rs_dashboard/app/multi-leg-focus/page.tsx`:

```tsx
import MultiLegFocus from '@/components/MultiLegFocus';

export const metadata = { title: 'Multi-Leg Focus' };

export default function MultiLegFocusPage() {
  return <MultiLegFocus />;
}
```

- [ ] **Step 2: Add the NavBar entry**

In `rs_dashboard/components/NavBar.tsx`, find the group containing:

```ts
      { href: '/baskets', label: 'Baskets', desc: 'Predefined option strategies with payoff diagram & quick basket order entry' },
```

Add immediately after it:

```ts
      { href: '/multi-leg-focus', label: 'Multi-Leg Focus', desc: 'N-leg strategy builder from presets — live P&L monitor with manual exits' },
```

- [ ] **Step 3: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: If Task 5 Step 3 used the temporary swap-into-`/baskets` technique, revert it now**

Confirm `rs_dashboard/app/baskets/page.tsx` renders `<Baskets />` again (not `<MultiLegFocus />`).

- [ ] **Step 5: Full manual end-to-end verification**

With the dev server running and at least Dhan authenticated:
- Navigate via NavBar to "Multi-Leg Focus" and confirm the page loads at `/multi-leg-focus`.
- Apply a 3-leg preset (e.g. Jade Lizard under Lizard) and a 4-leg preset (Iron Condor under Range Bound); confirm strikes resolve correctly for both.
- Select a Calendar-category template (e.g. Calendar Call Spread) and confirm it's rejected with a toast rather than silently applied.
- Add/remove legs freely on a draft basket.
- Place a small basket, confirm live P&L, exit one leg then Exit Basket.
- If Zerodha and/or Kotak are authenticated, repeat placement + monitor + exit on each to confirm the broker-branching holds (per the spec's Testing section).

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/app/multi-leg-focus/page.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(multi-leg-focus): add page route and navigation entry"
```
