# Baskets Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/baskets` page: predefined option-strategy templates grouped by category, a free-form leg table, a live expiry payoff chart, a lots multiplier, localStorage save/load, and broker-aware (Dhan/Zerodha) sequenced order placement.

**Architecture:** Port the proven UI and pure payoff math from the sibling `kotak_algo` project's Basket page, replacing only the data-fetching/order-placement layer with this dashboard's existing broker-aware infrastructure (`useBrokerSelector`, `useLiveOptionsWS`, `/api/options/*`, `/api/scalper/*`). No new backend routes are needed — every API call the page makes already exists. Pure logic (payoff math, templates, offset/anchor math, order-request building) lives in `lib/` and is unit-tested with `node --test`; React components are verified manually in the browser per this project's existing convention (no component test harness is configured).

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind, `node --test` for pure-logic unit tests (see `hooks/brokerRoute.test.ts` for the existing pattern — no test framework dependency needed, Node 24's native TS support runs `.test.ts` files directly).

## Global Constraints

- Table headers must use `text-xs font-bold text-white` on a solid `bg-zinc-800` (not `bg-zinc-950/40` or similar translucent header, and not `text-zinc-500` — those are Kotak's classes and violate this dashboard's convention).
- Never use Tailwind slash-opacity notation on **text** colors (e.g. `text-zinc-300/90`, `placeholder:text-zinc-300/90`) — use solid zinc shades (`text-zinc-500`, `text-zinc-400`, etc.) instead. Opacity modifiers on **backgrounds** (`bg-emerald-500/10`) remain fine and are used throughout.
- All new files are TypeScript (`.ts`/`.tsx`), strict-mode compatible with the rest of `rs_dashboard`.
- Every task that touches `.ts`/`.tsx` files ends with `cd rs_dashboard && npx tsc --noEmit` passing (no new type errors) before commit.
- No new backend routes, no changes to `/strategy-builder` or its components.

---

## Task 1: Strategy templates & payoff math library

**Files:**
- Create: `rs_dashboard/lib/basketStrategies.ts`
- Test: `rs_dashboard/lib/basketStrategies.test.ts`

**Interfaces:**
- Produces: `LegSide` (`'B'|'S'`), `OptionType` (`'CE'|'PE'`), `StrategyCategory` (`'Bullish'|'Bearish'|'Range Bound'|'Big Move'`), `TemplateLeg { side, option, offset: number, ratio: number }`, `StrategyTemplate { key: string, name: string, legs: TemplateLeg[] }`, `STRATEGY_CATEGORIES: Record<StrategyCategory, StrategyTemplate[]>`, `BasketLeg { id: string, side: LegSide, option: OptionType, strike: number, lots: number, type: 'MARKET'|'LIMIT', price: string }`, `PayoffLeg { side, option, strike: number, premium: number, qty: number }`, `PayoffResult { points: {x,y}[], breakevens: number[], maxProfit: number, maxLoss: number, maxProfitUnlimited: boolean, maxLossUnlimited: boolean, netPremium: number }`, functions `legPnlAtExpiry(leg: PayoffLeg, underlying: number): number`, `computePayoff(legs: PayoffLeg[], lo: number, hi: number, samples?: number): PayoffResult`, `nearestStrike(strikes: number[], target: number): number | null`, `strikeStep(strikes: number[]): number`, `daysToExpiry(expiry: string, now?: Date): number | null`.
- Consumes: nothing (pure module, no imports beyond none needed).

- [ ] **Step 1: Write the failing tests**

Create `rs_dashboard/lib/basketStrategies.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  legPnlAtExpiry, computePayoff, nearestStrike, strikeStep, daysToExpiry,
} from './basketStrategies.ts';

test('legPnlAtExpiry: short call ITM loses intrinsic minus premium collected', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -15); // premium(5) - intrinsic(20) = -15
});

test('legPnlAtExpiry: long put OTM loses only the premium paid', () => {
  const leg = { side: 'B' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 2 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -10); // (0 - 5) * qty(2)
});

test('computePayoff: short straddle has bounded profit, unlimited loss both wings', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 },
    { side: 'S' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.netPremium, 10);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.ok(Math.abs(result.maxProfit - 10) < 1e-6);
  assert.strictEqual(result.breakevens.length, 2);
  assert.ok(Math.abs(result.breakevens[0] - 90) < 1);
  assert.ok(Math.abs(result.breakevens[1] - 110) < 1);
});

test('computePayoff: bull call spread has bounded profit AND bounded loss', () => {
  const legs = [
    { side: 'B' as const, option: 'CE' as const, strike: 100, premium: 8, qty: 1 },
    { side: 'S' as const, option: 'CE' as const, strike: 120, premium: 3, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.ok(Math.abs(result.maxLoss - -5) < 1e-6);   // net debit paid
  assert.ok(Math.abs(result.maxProfit - 15) < 1e-6); // (120-100) - 5 net debit
});

test('nearestStrike picks the closest listed strike', () => {
  assert.strictEqual(nearestStrike([100, 150, 200], 170), 150);
});

test('nearestStrike returns null for an empty strike list', () => {
  assert.strictEqual(nearestStrike([], 100), null);
});

test('strikeStep returns the median gap between strikes', () => {
  assert.strictEqual(strikeStep([100, 150, 200, 250]), 50);
});

test('strikeStep defaults to 50 with fewer than two strikes', () => {
  assert.strictEqual(strikeStep([100]), 50);
});

test('daysToExpiry counts calendar days, 0 on the expiry date itself', () => {
  const now = new Date(2026, 6, 21); // 2026-07-21
  assert.strictEqual(daysToExpiry('2026-07-21', now), 0);
  assert.strictEqual(daysToExpiry('2026-07-24', now), 3);
});

test('daysToExpiry returns null for an unparseable expiry string', () => {
  assert.strictEqual(daysToExpiry('not-a-date'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rs_dashboard && node --test lib/basketStrategies.test.ts`
Expected: FAIL — `Cannot find module './basketStrategies.ts'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `rs_dashboard/lib/basketStrategies.ts`:

```ts
// Predefined option strategy templates and pure payoff math for the Baskets page.
// Templates express strikes relative to ATM in units of the strike step
// (e.g. offset +2 on NIFTY with a 50-pt step = ATM + 100).

export type LegSide = 'B' | 'S';
export type OptionType = 'CE' | 'PE';

export interface TemplateLeg {
  side: LegSide;
  option: OptionType;
  offset: number;   // strike steps relative to ATM
  ratio: number;    // lots multiplier within the template
}

export interface StrategyTemplate {
  key: string;
  name: string;
  legs: TemplateLeg[];
}

export type StrategyCategory = 'Bullish' | 'Bearish' | 'Range Bound' | 'Big Move';

export interface BasketLeg {
  id: string;
  side: LegSide;
  option: OptionType;
  strike: number;
  lots: number;
  type: 'MARKET' | 'LIMIT';
  price: string;   // empty = follow live LTP
}

export const STRATEGY_CATEGORIES: Record<StrategyCategory, StrategyTemplate[]> = {
  Bullish: [
    { key: 'buy-call',          name: 'Buy Call',               legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }] },
    { key: 'bull-call-spread',  name: 'Bull Call Spread',       legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'CE', offset: 4, ratio: 1 }] },
    { key: 'bull-put-spread',   name: 'Bull Put Spread',        legs: [{ side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'call-ratio-back',   name: 'Call Ratio Back Spread', legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 2 }] },
    { key: 'long-synthetic',    name: 'Long Synthetic Future',  legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'range-forward',     name: 'Range Forward',          legs: [{ side: 'B', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
  ],
  Bearish: [
    { key: 'buy-put',           name: 'Buy Put',                legs: [{ side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'bear-put-spread',   name: 'Bear Put Spread',        legs: [{ side: 'B', option: 'PE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'bear-call-spread',  name: 'Bear Call Spread',       legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 1 }] },
    { key: 'put-ratio-back',    name: 'Put Ratio Back Spread',  legs: [{ side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 2 }] },
    { key: 'short-synthetic',   name: 'Short Synthetic Future', legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
  ],
  'Range Bound': [
    { key: 'short-straddle',    name: 'Short Straddle',         legs: [{ side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'S', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'short-strangle',    name: 'Short Strangle',         legs: [{ side: 'S', option: 'CE', offset: 4, ratio: 1 }, { side: 'S', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'iron-condor',       name: 'Iron Condor',            legs: [
      { side: 'S', option: 'CE', offset: 3, ratio: 1 }, { side: 'B', option: 'CE', offset: 6, ratio: 1 },
      { side: 'S', option: 'PE', offset: -3, ratio: 1 }, { side: 'B', option: 'PE', offset: -6, ratio: 1 },
    ] },
    { key: 'iron-butterfly',    name: 'Iron Butterfly',         legs: [
      { side: 'S', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'CE', offset: 4, ratio: 1 },
      { side: 'S', option: 'PE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 },
    ] },
  ],
  'Big Move': [
    { key: 'long-straddle',     name: 'Long Straddle',          legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }, { side: 'B', option: 'PE', offset: 0, ratio: 1 }] },
    { key: 'long-strangle',     name: 'Long Strangle',          legs: [{ side: 'B', option: 'CE', offset: 4, ratio: 1 }, { side: 'B', option: 'PE', offset: -4, ratio: 1 }] },
    { key: 'long-iron-condor',  name: 'Long Iron Condor',       legs: [
      { side: 'B', option: 'CE', offset: 3, ratio: 1 }, { side: 'S', option: 'CE', offset: 6, ratio: 1 },
      { side: 'B', option: 'PE', offset: -3, ratio: 1 }, { side: 'S', option: 'PE', offset: -6, ratio: 1 },
    ] },
  ],
};

// ─── Payoff math ─────────────────────────────────────────────────

/** A fully materialised basket leg. `qty` is in units (lots × lotSize). */
export interface PayoffLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  premium: number;  // per-unit premium
  qty: number;      // units
}

export function legPnlAtExpiry(leg: PayoffLeg, underlying: number): number {
  const intrinsic = leg.option === 'CE'
    ? Math.max(0, underlying - leg.strike)
    : Math.max(0, leg.strike - underlying);
  const perUnit = leg.side === 'B' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return perUnit * leg.qty;
}

export interface PayoffResult {
  points: { x: number; y: number }[];
  breakevens: number[];
  maxProfit: number;        // ignored when maxProfitUnlimited
  maxLoss: number;          // negative number; ignored when maxLossUnlimited
  maxProfitUnlimited: boolean;
  maxLossUnlimited: boolean;
  netPremium: number;       // >0 net credit received, <0 net debit paid (total ₹)
}

export function computePayoff(legs: PayoffLeg[], lo: number, hi: number, samples = 240): PayoffResult {
  // Sample a uniform grid plus every strike, so the kinks (where max
  // profit/loss actually sit) are evaluated exactly, not interpolated past.
  const xs = new Set<number>();
  const step = (hi - lo) / Math.max(1, samples - 1);
  for (let i = 0; i < samples; i++) xs.add(lo + i * step);
  for (const l of legs) if (l.strike >= lo && l.strike <= hi) xs.add(l.strike);
  const points = [...xs].sort((a, b) => a - b).map(x => ({
    x, y: legs.reduce((sum, l) => sum + legPnlAtExpiry(l, x), 0),
  }));

  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.y < 0 && b.y >= 0) || (a.y >= 0 && b.y < 0)) {
      const t = a.y === b.y ? 0 : -a.y / (b.y - a.y);
      breakevens.push(a.x + t * (b.x - a.x));
    }
  }

  // Beyond the outermost strike the curve is linear; its slope tells us
  // whether profit/loss is unbounded on either wing.
  const pnlAt = (x: number) => legs.reduce((sum, l) => sum + legPnlAtExpiry(l, x), 0);
  const strikes = legs.map(l => l.strike);
  const far = Math.max(hi, ...strikes) * 2 + 1000;
  const slopeUpWing = pnlAt(far + 1) - pnlAt(far);
  const nearZero = Math.max(0, Math.min(lo, ...strikes) / 2);
  const slopeDownWing = pnlAt(nearZero) - pnlAt(nearZero + 1); // pnl gain per point of fall
  const upWingPnl = pnlAt(far);
  const downWingPnl = pnlAt(Math.max(0, nearZero));

  let maxProfit = Math.max(...points.map(p => p.y), upWingPnl, downWingPnl);
  let maxLoss   = Math.min(...points.map(p => p.y), upWingPnl, downWingPnl);
  // Convention: a wing that keeps gaining/losing as the underlying moves is
  // shown as "Unlimited" even though the downside is technically floored at 0.
  const maxProfitUnlimited = slopeUpWing > 1e-9 || slopeDownWing > 1e-9;
  const maxLossUnlimited   = slopeUpWing < -1e-9 || slopeDownWing < -1e-9;
  if (maxProfitUnlimited) maxProfit = Infinity;
  if (maxLossUnlimited) maxLoss = -Infinity;

  const netPremium = legs.reduce((sum, l) =>
    sum + (l.side === 'S' ? l.premium : -l.premium) * l.qty, 0);

  return { points, breakevens, maxProfit, maxLoss, maxProfitUnlimited, maxLossUnlimited, netPremium };
}

/** Nearest listed strike to a target price. */
export function nearestStrike(strikes: number[], target: number): number | null {
  if (!strikes.length) return null;
  return strikes.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best);
}

/** Typical gap between adjacent strikes (median of diffs, robust to gaps). */
export function strikeStep(strikes: number[]): number {
  if (strikes.length < 2) return 50;
  const diffs = [];
  for (let i = 1; i < strikes.length; i++) diffs.push(strikes[i] - strikes[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 50;
}

/** Calendar days until an expiry string, "2026-07-21" or "21-Jul-2026". 0 on the expiry date itself. */
export function daysToExpiry(expiry: string, now = new Date()): number | null {
  let y = 0, mi = -1, d = 0;
  const iso = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = expiry.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (iso) {
    y = Number(iso[1]); mi = Number(iso[2]) - 1; d = Number(iso[3]);
  } else if (dmy) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    y = Number(dmy[3]); mi = months.indexOf(dmy[2].toLowerCase()); d = Number(dmy[1]);
  }
  if (mi < 0) return null;
  const startOfDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diff = startOfDay(new Date(y, mi, d)).getTime() - startOfDay(now).getTime();
  return Math.max(0, Math.round(diff / 86_400_000));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/basketStrategies.test.ts`
Expected: `pass 10`, `fail 0` (10 tests across the file).

- [ ] **Step 5: Type-check and commit**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

```bash
git add rs_dashboard/lib/basketStrategies.ts rs_dashboard/lib/basketStrategies.test.ts
git commit -m "feat(baskets): add strategy templates and payoff math library"
```

---

## Task 2: Save/load pure helpers (localStorage basket persistence)

**Files:**
- Create: `rs_dashboard/lib/basketStorage.ts`
- Test: `rs_dashboard/lib/basketStorage.test.ts`

**Interfaces:**
- Consumes: `nearestStrike` from `./basketStrategies.ts` (Task 1); `LegSide`, `OptionType`, `StrategyCategory` types from `./basketStrategies.ts`.
- Produces: `SavedLeg { side: LegSide, option: OptionType, offset: number, lots: number, type: 'MARKET'|'LIMIT' }`, `SavedBasket { name: string, category: StrategyCategory, strategy: string|null, multiplier: number, underlying: string, legs: SavedLeg[] }`, `legToOffset(strike: number, atmStrike: number, step: number): number`, `offsetToStrike(offset: number, atmStrike: number, allStrikes: number[], step: number): number`, `loadSavedBaskets(): SavedBasket[]`, `persistSavedBaskets(baskets: SavedBasket[]): void`, `SAVED_BASKETS_KEY: string`.

- [ ] **Step 1: Write the failing tests**

Create `rs_dashboard/lib/basketStorage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { legToOffset, offsetToStrike } from './basketStorage.ts';

test('legToOffset computes an ATM-relative step offset', () => {
  assert.strictEqual(legToOffset(24200, 24000, 50), 4);
  assert.strictEqual(legToOffset(23800, 24000, 50), -4);
  assert.strictEqual(legToOffset(24000, 24000, 50), 0);
});

test('offsetToStrike re-anchors an offset to a new ATM using the nearest listed strike', () => {
  const strikes = [23800, 23850, 23900, 23950, 24000, 24050, 24100];
  assert.strictEqual(offsetToStrike(2, 24000, strikes, 50), 24100);
  assert.strictEqual(offsetToStrike(-2, 23900, strikes, 50), 23800);
});

test('offsetToStrike falls back to the ATM strike itself when the strike list is empty', () => {
  assert.strictEqual(offsetToStrike(3, 24000, [], 50), 24000);
});
```

Note: `loadSavedBaskets`/`persistSavedBaskets` are not unit-tested here — they touch `window.localStorage`, which isn't available under `node --test` without a DOM shim, and this project has no such shim configured. They're covered by manual browser verification in Task 8.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rs_dashboard && node --test lib/basketStorage.test.ts`
Expected: FAIL — `Cannot find module './basketStorage.ts'`.

- [ ] **Step 3: Write the implementation**

Create `rs_dashboard/lib/basketStorage.ts`:

```ts
import { nearestStrike, type LegSide, type OptionType, type StrategyCategory } from './basketStrategies';

export interface SavedLeg {
  side: LegSide;
  option: OptionType;
  offset: number;   // strike minus ATM at save time, in strike-step units
  lots: number;
  type: 'MARKET' | 'LIMIT';
}

export interface SavedBasket {
  name: string;
  category: StrategyCategory;
  strategy: string | null;
  multiplier: number;
  underlying: string;
  legs: SavedLeg[];
}

export const SAVED_BASKETS_KEY = 'baskets_saved_v1';

/** ATM-relative offset (in strike-step units) for a strike at save time. */
export function legToOffset(strike: number, atmStrike: number, step: number): number {
  return Math.round((strike - atmStrike) / (step || 50));
}

/** Re-anchor a saved offset to the current ATM, snapping to the nearest listed strike. */
export function offsetToStrike(offset: number, atmStrike: number, allStrikes: number[], step: number): number {
  return nearestStrike(allStrikes, atmStrike + offset * step) ?? atmStrike;
}

export function loadSavedBaskets(): SavedBasket[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_BASKETS_KEY);
    return raw ? (JSON.parse(raw) as SavedBasket[]) : [];
  } catch {
    return []; // corrupt storage — start fresh rather than throwing
  }
}

export function persistSavedBaskets(baskets: SavedBasket[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SAVED_BASKETS_KEY, JSON.stringify(baskets));
  } catch {
    /* storage full or disabled — save silently fails, UI still works this session */
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/basketStorage.test.ts`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Type-check and commit**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

```bash
git add rs_dashboard/lib/basketStorage.ts rs_dashboard/lib/basketStorage.test.ts
git commit -m "feat(baskets): add localStorage save/load helpers with ATM-relative offsets"
```

---

## Task 3: Order-placement pure helpers (broker-branching leg resolution)

**Files:**
- Create: `rs_dashboard/lib/basketOrders.ts`
- Test: `rs_dashboard/lib/basketOrders.test.ts`

**Interfaces:**
- Consumes: `LegSide`, `OptionType` types from `./basketStrategies.ts`; `Broker` type from `@/hooks/useBrokerSelector`.
- Produces: `OrderLeg { side: LegSide, option: OptionType, strike: number, qty: number, type: 'MARKET'|'LIMIT', price?: number }`, `StrikeIdentifier { ceId?: string, peId?: string, ceSymbol?: string, peSymbol?: string }`, `ResolvedOrder { broker: Broker, url: string, body: Record<string, unknown> }`, `sortLegsForPlacement<T extends {side: LegSide}>(legs: T[]): T[]`, `resolveOrderRequest(broker: Broker, leg: OrderLeg, strikeMap: Record<string, StrikeIdentifier>): ResolvedOrder | null`.

- [ ] **Step 1: Write the failing tests**

Create `rs_dashboard/lib/basketOrders.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { sortLegsForPlacement, resolveOrderRequest } from './basketOrders.ts';

test('sortLegsForPlacement orders all buys before all sells, preserving relative order within each group', () => {
  const legs = [
    { side: 'S' as const, id: 1 }, { side: 'B' as const, id: 2 },
    { side: 'S' as const, id: 3 }, { side: 'B' as const, id: 4 },
  ];
  assert.deepStrictEqual(sortLegsForPlacement(legs).map(l => l.id), [2, 4, 1, 3]);
});

test('resolveOrderRequest builds a Dhan fast-order request from a CE leg', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  const strikeMap = { '24000': { ceId: '12345', peId: '67890' } };
  const req = resolveOrderRequest('dhan', leg, strikeMap);
  assert.deepStrictEqual(req, {
    broker: 'dhan', url: '/api/scalper/fast-order',
    body: { securityId: '12345', quantity: 75, side: 'SELL', orderType: 'MARKET' },
  });
});

test('resolveOrderRequest builds a Zerodha order request from a PE leg, snapping a limit price to the 0.05 tick', () => {
  const leg = { side: 'B' as const, option: 'PE' as const, strike: 24000, qty: 75, type: 'LIMIT' as const, price: 123.456 };
  const strikeMap = { '24000': { ceSymbol: 'NIFTY24721C24000', peSymbol: 'NIFTY24721P24000' } };
  const req = resolveOrderRequest('zerodha', leg, strikeMap);
  assert.deepStrictEqual(req, {
    broker: 'zerodha', url: '/api/scalper/zerodha/order',
    body: { tradingsymbol: 'NIFTY24721P24000', quantity: 75, side: 'BUY', orderType: 'LIMIT', price: 123.45 },
  });
});

test('resolveOrderRequest returns null when the strike has no identifier for the requested option', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  assert.strictEqual(resolveOrderRequest('dhan', leg, {}), null);
});

test('resolveOrderRequest returns null when the strike exists but lacks the requested option side identifier', () => {
  const leg = { side: 'S' as const, option: 'PE' as const, strike: 24000, qty: 75, type: 'MARKET' as const };
  const strikeMap = { '24000': { ceId: '12345' } }; // no peId
  assert.strictEqual(resolveOrderRequest('dhan', leg, strikeMap), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rs_dashboard && node --test lib/basketOrders.test.ts`
Expected: FAIL — `Cannot find module './basketOrders.ts'`.

- [ ] **Step 3: Write the implementation**

Create `rs_dashboard/lib/basketOrders.ts`:

```ts
import type { LegSide, OptionType } from './basketStrategies';
import type { Broker } from '@/hooks/useBrokerSelector';

export interface OrderLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  qty: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;
}

/** Unified strike->identifier shape, matching what /api/scalper/lookup and
 *  /api/scalper/zerodha/lookup both populate into the same strikeMap state
 *  (see components/Scalper.tsx's strikeMap type for precedent). */
export interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface ResolvedOrder {
  broker: Broker;
  url: string;
  body: Record<string, unknown>;
}

/** BUY legs first, then SELL legs — margin-friendly ordering for a multi-leg basket. */
export function sortLegsForPlacement<T extends { side: LegSide }>(legs: T[]): T[] {
  return [...legs.filter(l => l.side === 'B'), ...legs.filter(l => l.side === 'S')];
}

/** Resolves one leg into a ready-to-fetch order request for the given broker, or
 *  null if the strike/option combination has no known order identifier yet. */
export function resolveOrderRequest(
  broker: Broker,
  leg: OrderLeg,
  strikeMap: Record<string, StrikeIdentifier>,
): ResolvedOrder | null {
  const ident = strikeMap[String(leg.strike)];
  if (!ident) return null;

  const side = leg.side === 'B' ? 'BUY' : 'SELL';
  const limitPrice = leg.type === 'LIMIT' && leg.price != null
    ? Math.round(leg.price * 20) / 20   // snap to 0.05 tick
    : undefined;

  if (broker === 'dhan') {
    const securityId = leg.option === 'CE' ? ident.ceId : ident.peId;
    if (!securityId) return null;
    return {
      broker, url: '/api/scalper/fast-order',
      body: {
        securityId, quantity: leg.qty, side, orderType: leg.type,
        ...(limitPrice != null ? { price: limitPrice } : {}),
      },
    };
  }

  const tradingsymbol = leg.option === 'CE' ? ident.ceSymbol : ident.peSymbol;
  if (!tradingsymbol) return null;
  return {
    broker, url: '/api/scalper/zerodha/order',
    body: {
      tradingsymbol, quantity: leg.qty, side, orderType: leg.type,
      ...(limitPrice != null ? { price: limitPrice } : {}),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rs_dashboard && node --test lib/basketOrders.test.ts`
Expected: `pass 5`, `fail 0`.

- [ ] **Step 5: Type-check and commit**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

```bash
git add rs_dashboard/lib/basketOrders.ts rs_dashboard/lib/basketOrders.test.ts
git commit -m "feat(baskets): add broker-branching order-request resolver"
```

---

## Task 4: Export `formatFundsValue` from Scalper.tsx

**Files:**
- Modify: `rs_dashboard/components/Scalper.tsx` (the `formatFundsValue` function, currently module-private around line 1907)

**Interfaces:**
- Produces: `export function formatFundsValue(val: number): string` (was previously unexported, same file).
- Consumes: nothing new.

**Why this task exists:** Baskets needs to render the same "Rs. X" funds tile as Scalper. Rather than duplicating the formatting logic, export the existing function. This is a one-line change with no behavior change to Scalper itself.

- [ ] **Step 1: Locate and modify the function signature**

In `rs_dashboard/components/Scalper.tsx`, find:

```ts
function formatFundsValue(val: number): string {
```

Change to:

```ts
export function formatFundsValue(val: number): string {
```

- [ ] **Step 2: Verify Scalper.tsx still compiles and the page still renders**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors (exporting a previously-private function never breaks existing callers in the same file).

Run: `cd rs_dashboard && npm run dev` (if not already running), then open `http://localhost:3000/scalper` in a browser and confirm the funds tile in the top bar still shows a value exactly as before (no visual change expected — this step only adds an `export` keyword).

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/Scalper.tsx
git commit -m "refactor(scalper): export formatFundsValue for reuse by the Baskets page"
```

---

## Task 5: Payoff chart component

**Files:**
- Create: `rs_dashboard/components/BasketPayoffChart.tsx`

**Interfaces:**
- Consumes: nothing beyond React and its own props (pure presentational component, no data fetching).
- Produces: default export `BasketPayoffChart(props: { points: {x:number,y:number}[], breakevens: number[], spot: number })` — a self-contained SVG chart, no external chart library dependency.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/BasketPayoffChart.tsx`:

```tsx
'use client';

import React, { useMemo, useRef, useState } from 'react';

interface BasketPayoffChartProps {
  points: { x: number; y: number }[];   // expiry P&L curve
  breakevens: number[];
  spot: number;
}

const W = 760;
const H = 344;
const PAD = { top: 28, right: 20, bottom: 40, left: 64 };

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1000
    ? abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : abs.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return `${n < 0 ? '-' : ''}₹${s}`;
}

/** "Nice" tick values covering [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

export default function BasketPayoffChart({ points, breakevens, spot }: BasketPayoffChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const model = useMemo(() => {
    if (points.length < 2) return null;
    const xLo = points[0].x;
    const xHi = points[points.length - 1].x;
    let yLo = Math.min(0, ...points.map(p => p.y));
    let yHi = Math.max(0, ...points.map(p => p.y));
    if (yHi === yLo) { yHi += 1; yLo -= 1; }
    const yPadding = (yHi - yLo) * 0.08;
    yLo -= yPadding; yHi += yPadding;

    const sx = (x: number) => PAD.left + ((x - xLo) / (xHi - xLo)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 5),
    };
  }, [points]);

  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center h-80 gap-1.5 text-zinc-500">
        <p className="text-sm font-semibold text-zinc-400">No payoff to show yet</p>
        <p className="text-xs">Pick a strategy or add legs with valid prices</p>
      </div>
    );
  }

  const { sx, sy, xLo, xHi, zeroY } = model;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    if (frac < 0 || frac > 1) { setHover(null); return; }
    const x = xLo + frac * (xHi - xLo);

    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].x < x) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(points[lo - 1].x - x) < Math.abs(points[lo].x - x)) lo -= 1;
    setHover(points[lo]);
  };

  const hoverLeft = hover ? sx(hover.x) > W * 0.62 : false;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto select-none"
      role="img"
      aria-label="Strategy payoff at expiry"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <clipPath id="basket-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
        <clipPath id="basket-clip-loss"><rect x={0} y={zeroY} width={W} height={H - zeroY} /></clipPath>
      </defs>

      {model.yTicks.map(t => (
        <g key={`y${t}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke="#27272a" strokeWidth={1} />
          <text x={PAD.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={11} fill="#71717a" className="font-mono">
            {Math.abs(t) >= 1000 ? `${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}k` : t.toFixed(0)}
          </text>
        </g>
      ))}
      {model.xTicks.map(t => (
        <text key={`x${t}`} x={sx(t)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={11} fill="#71717a" className="font-mono">
          {t.toLocaleString('en-IN')}
        </text>
      ))}

      <g clipPath="url(#basket-clip-profit)">
        <path d={model.area} fill="#34d399" fillOpacity={0.22} />
      </g>
      <g clipPath="url(#basket-clip-loss)">
        <path d={model.area} fill="#fb7185" fillOpacity={0.22} />
      </g>
      <g clipPath="url(#basket-clip-profit)">
        <path d={model.line} fill="none" stroke="#34d399" strokeWidth={2} />
      </g>
      <g clipPath="url(#basket-clip-loss)">
        <path d={model.line} fill="none" stroke="#fb7185" strokeWidth={2} />
      </g>

      <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="#52525b" strokeWidth={1.25} />

      {spot >= xLo && spot <= xHi && (
        <g>
          <line x1={sx(spot)} x2={sx(spot)} y1={PAD.top} y2={H - PAD.bottom} stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 3" />
          <text x={sx(spot)} y={PAD.top - 8} textAnchor="middle" fontSize={10} fill="#38bdf8" className="font-mono font-bold">
            {spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
          </text>
        </g>
      )}

      {breakevens.map(be => (
        <g key={be}>
          <circle cx={sx(be)} cy={zeroY} r={4} fill="#fbbf24" stroke="#18181b" strokeWidth={2} />
          <text x={sx(be)} y={zeroY - 8} textAnchor="middle" fontSize={9.5} fill="#fbbf24" className="font-mono">
            {be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </text>
        </g>
      ))}

      {hover && (
        <g pointerEvents="none">
          <line x1={sx(hover.x)} x2={sx(hover.x)} y1={PAD.top} y2={H - PAD.bottom} stroke="#a1a1aa" strokeWidth={1} strokeDasharray="2 3" />
          <circle cx={sx(hover.x)} cy={sy(hover.y)} r={4.5}
            fill={hover.y >= 0 ? '#34d399' : '#fb7185'} stroke="#18181b" strokeWidth={2} />
          <g transform={`translate(${hoverLeft ? sx(hover.x) - 148 : sx(hover.x) + 10}, ${PAD.top + 4})`}>
            <rect width={138} height={44} rx={8} fill="#18181b" stroke="#3f3f46" />
            <text x={10} y={17} fontSize={10} fill="#a1a1aa" className="font-mono">
              At {hover.x.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </text>
            <text x={10} y={33} fontSize={12} fontWeight={700} className="font-mono"
              fill={hover.y >= 0 ? '#34d399' : '#fb7185'}>
              {fmtInr(hover.y)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors. (No manual browser check yet — this component isn't wired into any page until Task 9. It will be visually verified there.)

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/BasketPayoffChart.tsx
git commit -m "feat(baskets): add expiry payoff chart component"
```

---

## Task 6: Strategy card grid subcomponent (category tabs + template picker)

**Files:**
- Create: `rs_dashboard/components/basket/StrategyCardGrid.tsx`

**Interfaces:**
- Consumes: `STRATEGY_CATEGORIES`, `StrategyCategory`, `StrategyTemplate`, `PayoffLeg`, `computePayoff` from `@/lib/basketStrategies` (Task 1).
- Produces: default export `StrategyCardGrid(props: { category: StrategyCategory, onCategoryChange: (c: StrategyCategory) => void, selectedKey: string | null, onSelectTemplate: (tpl: StrategyTemplate) => void, disabled: boolean })`.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/basket/StrategyCardGrid.tsx`:

```tsx
'use client';

import React, { useMemo } from 'react';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type PayoffLeg, computePayoff,
} from '@/lib/basketStrategies';

const CATEGORIES = Object.keys(STRATEGY_CATEGORIES) as StrategyCategory[];

const CATEGORY_COLORS: Record<StrategyCategory, string> = {
  Bullish:       'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  Bearish:       'bg-rose-500/10 text-rose-300 border-rose-500/40',
  'Range Bound': 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  'Big Move':    'bg-sky-500/10 text-sky-300 border-sky-500/40',
};

/** Tiny payoff-shape glyph for a strategy card, using placeholder strikes/premiums
 *  purely to visualize the SHAPE of the payoff (bullish/bearish/wings/etc.) — not
 *  a real quote. */
function StrategyGlyph({ template }: { template: StrategyTemplate }) {
  const path = useMemo(() => {
    const legs: PayoffLeg[] = template.legs.map(l => ({
      side: l.side, option: l.option, strike: 100 + l.offset * 5, premium: 3 * l.ratio, qty: l.ratio,
    }));
    const { points } = computePayoff(legs, 60, 140, 48);
    const ys = points.map(p => p.y);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const span = yHi - yLo || 1;
    return points.map((p, i) => {
      const x = (i / (points.length - 1)) * 72 + 4;
      const y = 30 - ((p.y - yLo) / span) * 24;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join('');
  }, [template]);
  return (
    <svg viewBox="0 0 80 36" className="w-full h-12">
      <line x1={4} x2={76} y1={18} y2={18} stroke="#3f3f46" strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="#34d399" strokeWidth={1.75} />
    </svg>
  );
}

interface StrategyCardGridProps {
  category: StrategyCategory;
  onCategoryChange: (c: StrategyCategory) => void;
  selectedKey: string | null;
  onSelectTemplate: (tpl: StrategyTemplate) => void;
  disabled: boolean;
}

export default function StrategyCardGrid({
  category, onCategoryChange, selectedKey, onSelectTemplate, disabled,
}: StrategyCardGridProps) {
  return (
    <div className="flex items-start gap-3 flex-wrap">
      <div className="flex flex-col gap-1.5 flex-none pt-0.5">
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => onCategoryChange(cat)}
            className={`px-4 py-1.5 text-xs font-bold rounded-lg border text-left transition-all ${
              category === cat ? CATEGORY_COLORS[cat] : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:text-zinc-100'
            }`}>
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 flex gap-2.5 overflow-x-auto pb-1 min-w-0">
        {STRATEGY_CATEGORIES[category].map(tpl => (
          <button key={tpl.key} onClick={() => onSelectTemplate(tpl)}
            disabled={disabled}
            className={`flex-none w-40 p-3 rounded-xl border transition-all text-left disabled:opacity-40 ${
              selectedKey === tpl.key
                ? 'border-emerald-500/50 bg-emerald-500/5'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600'
            }`}>
            <StrategyGlyph template={tpl} />
            <p className="text-xs font-bold text-zinc-300 mt-1.5 leading-tight">{tpl.name}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/basket/StrategyCardGrid.tsx
git commit -m "feat(baskets): add category-tabbed strategy template picker"
```

---

## Task 7: Legs table subcomponent (free-form leg editing)

**Files:**
- Create: `rs_dashboard/components/basket/LegsTable.tsx`

**Interfaces:**
- Consumes: `BasketLeg`, `LegSide`, `OptionType` types from `@/lib/basketStrategies` (Task 1); `Button`, `Input` from `@/components/ui/button`, `@/components/ui/input`.
- Produces: default export `LegsTable(props)` with props: `legs: BasketLeg[]`, `atmStrike: number | null`, `allStrikes: number[]`, `autoPremium: (strike: number, option: OptionType) => number`, `onUpdateLeg: (id: string, patch: Partial<BasketLeg>) => void`, `onStepStrike: (id: string, dir: 1 | -1) => void`, `onAddLeg: () => void`, `onRemoveLeg: (id: string) => void`, `onClearAll: () => void`.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/basket/LegsTable.tsx`:

```tsx
'use client';

import React from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BasketLeg, OptionType } from '@/lib/basketStrategies';

/** Compact −/+ stepper used in the legs table. */
function Stepper({ value, onDec, onInc, valueClass = '' }: {
  value: React.ReactNode; onDec: () => void; onInc: () => void; valueClass?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <button onClick={onDec}
        className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
        <span className="text-xs font-bold">−</span>
      </button>
      <span className={`font-mono font-bold text-xs tabular-nums text-center px-1 ${valueClass}`}>{value}</span>
      <button onClick={onInc}
        className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

interface LegsTableProps {
  legs: BasketLeg[];
  atmStrike: number | null;
  allStrikes: number[];
  autoPremium: (strike: number, option: OptionType) => number;
  onUpdateLeg: (id: string, patch: Partial<BasketLeg>) => void;
  onStepStrike: (id: string, dir: 1 | -1) => void;
  onAddLeg: () => void;
  onRemoveLeg: (id: string) => void;
  onClearAll: () => void;
}

export default function LegsTable({
  legs, atmStrike, autoPremium, onUpdateLeg, onStepStrike, onAddLeg, onRemoveLeg, onClearAll,
}: LegsTableProps) {
  return (
    <>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/40 flex-wrap">
        <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">
          Legs{legs.length > 0 ? ` · ${legs.length}` : ''}
        </span>
        <Button size="sm" onClick={onAddLeg} className="h-7 px-2.5 text-[11px]">
          <Plus className="w-3 h-3" /> Add Leg
        </Button>
        {legs.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onClearAll}
            className="h-7 px-2.5 text-[11px] hover:text-rose-300">
            <X className="w-3 h-3" /> Clear
          </Button>
        )}
      </div>

      {legs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-1.5">
          <p className="text-sm font-semibold text-zinc-400">No legs yet</p>
          <p className="text-xs text-zinc-500">Pick a predefined strategy above or add legs manually</p>
        </div>
      ) : (
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-[9%]" /><col className="w-[20%]" /><col className="w-[10%]" />
            <col className="w-[16%]" /><col className="w-[12%]" /><col className="w-[15%]" />
            <col className="w-[12%]" /><col className="w-[6%]" />
          </colgroup>
          <thead>
            <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
              <th className="px-3 py-2.5 text-left">B/S</th>
              <th className="px-2 py-2.5 text-center">Strike</th>
              <th className="px-2 py-2.5 text-center">CE/PE</th>
              <th className="px-2 py-2.5 text-center">Lots</th>
              <th className="px-2 py-2.5 text-center">Type</th>
              <th className="px-2 py-2.5 text-right">Price</th>
              <th className="px-3 py-2.5 text-right">LTP</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => {
              const ltp = autoPremium(leg.strike, leg.option);
              return (
                <tr key={leg.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">
                  <td className="px-3 py-2.5">
                    <button onClick={() => onUpdateLeg(leg.id, { side: leg.side === 'B' ? 'S' : 'B' })}
                      title={leg.side === 'B' ? 'Buy — click to flip to Sell' : 'Sell — click to flip to Buy'}
                      className={`w-8 h-8 rounded-lg font-bold border transition-all ${
                        leg.side === 'B'
                          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                          : 'bg-rose-500/10 text-rose-300 border-rose-500/40'
                      }`}>
                      {leg.side}
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <Stepper
                      value={
                        <span className={`w-14 inline-block ${leg.strike === atmStrike ? 'text-yellow-300' : 'text-zinc-200'}`}>
                          {leg.strike}
                        </span>
                      }
                      onDec={() => onStepStrike(leg.id, -1)}
                      onInc={() => onStepStrike(leg.id, 1)}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <button onClick={() => onUpdateLeg(leg.id, { option: leg.option === 'CE' ? 'PE' : 'CE', price: '' })}
                      className={`w-10 h-8 rounded-lg font-bold border transition-all ${
                        leg.option === 'CE'
                          ? 'bg-sky-500/10 text-sky-300 border-sky-500/40'
                          : 'bg-violet-500/10 text-violet-300 border-violet-500/40'
                      }`}>
                      {leg.option}
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <Stepper
                      value={<span className="w-5 inline-block">{leg.lots}</span>}
                      onDec={() => onUpdateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                      onInc={() => onUpdateLeg(leg.id, { lots: Math.min(100, leg.lots + 1) })}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <select value={leg.type}
                      onChange={e => onUpdateLeg(leg.id, { type: e.target.value as 'MARKET' | 'LIMIT' })}
                      className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-semibold rounded-lg px-1.5 focus:outline-none focus:border-emerald-500">
                      <option value="MARKET">MKT</option>
                      <option value="LIMIT">LMT</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <Input type="number" min="0" step="0.05" value={leg.price}
                      placeholder={ltp > 0 ? ltp.toFixed(2) : '—'}
                      onChange={e => onUpdateLeg(leg.id, { price: e.target.value })}
                      className="h-8 w-24 max-w-full ml-auto text-[11px] text-right placeholder:text-zinc-500" />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-300">
                    {ltp > 0 ? ltp.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <button onClick={() => onRemoveLeg(leg.id)}
                      className="text-zinc-600 hover:text-rose-400 transition-all p-1" aria-label="Remove leg">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
```

Note: table header changed from Kotak's `text-[10px] uppercase tracking-widest text-zinc-500 ... bg-zinc-950/40` to `text-xs font-bold text-white ... bg-zinc-800`, and the price input's placeholder class changed from `placeholder:text-zinc-300/90` to `placeholder:text-zinc-500` — both per this project's Global Constraints (solid header style, no text-opacity modifiers).

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/basket/LegsTable.tsx
git commit -m "feat(baskets): add free-form legs table component"
```

---

## Task 8: Saved-baskets panel subcomponent

**Files:**
- Create: `rs_dashboard/components/basket/SavedBasketsPanel.tsx`

**Interfaces:**
- Consumes: `SavedBasket` type from `@/lib/basketStorage` (Task 2); `Button`, `Input` from `@/components/ui`.
- Produces: default export `SavedBasketsPanel(props)` with props: `saveName: string`, `onSaveNameChange: (v: string) => void`, `onSave: () => void`, `saved: SavedBasket[]`, `open: boolean`, `onToggleOpen: () => void`, `onLoad: (b: SavedBasket) => void`, `onDelete: (name: string) => void`.

- [ ] **Step 1: Create the component**

Create `rs_dashboard/components/basket/SavedBasketsPanel.tsx`:

```tsx
'use client';

import React from 'react';
import { Save, FolderOpen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SavedBasket } from '@/lib/basketStorage';

interface SavedBasketsPanelProps {
  saveName: string;
  onSaveNameChange: (v: string) => void;
  onSave: () => void;
  saved: SavedBasket[];
  open: boolean;
  onToggleOpen: () => void;
  onLoad: (b: SavedBasket) => void;
  onDelete: (name: string) => void;
}

export default function SavedBasketsPanel({
  saveName, onSaveNameChange, onSave, saved, open, onToggleOpen, onLoad, onDelete,
}: SavedBasketsPanelProps) {
  return (
    <>
      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
        <Input value={saveName} onChange={e => onSaveNameChange(e.target.value)} placeholder="Basket name"
          className="h-7 w-32 text-[11px] font-sans placeholder:text-zinc-500" />
        <Button size="sm" variant="outline" onClick={onSave} className="h-7 px-2.5 text-[11px]">
          <Save className="w-3 h-3" /> Save
        </Button>
        <Button size="sm" variant="outline" onClick={onToggleOpen}
          className={`h-7 px-2.5 text-[11px] ${open ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : ''}`}>
          <FolderOpen className="w-3 h-3" /> Load{saved.length > 0 ? ` (${saved.length})` : ''}
        </Button>
      </div>

      {open && (
        <div className="w-full px-4 py-2 border-t border-zinc-800 bg-zinc-950/40 flex flex-col gap-1">
          {saved.length === 0 && <p className="text-[11px] text-zinc-500">No saved baskets yet — name this one and press Save.</p>}
          {saved.map(b => (
            <div key={b.name} className="flex items-center gap-2">
              <button onClick={() => onLoad(b)}
                className="text-[11px] font-semibold text-zinc-300 hover:text-emerald-300 transition-all">
                {b.name}
              </button>
              <span className="text-[10px] text-zinc-600">
                {b.underlying} · {b.category} · {b.legs.length} legs · ×{b.multiplier}
              </span>
              <button onClick={() => onDelete(b.name)}
                className="ml-auto text-zinc-600 hover:text-rose-400 transition-all" aria-label={`Delete basket ${b.name}`}>
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add rs_dashboard/components/basket/SavedBasketsPanel.tsx
git commit -m "feat(baskets): add saved-baskets load/save panel component"
```

---

## Task 9: Baskets page orchestrator, route, and nav entry

**Files:**
- Create: `rs_dashboard/components/Baskets.tsx`
- Create: `rs_dashboard/app/baskets/page.tsx`
- Modify: `rs_dashboard/components/NavBar.tsx` (add one entry to the `Derivatives` group)

**Interfaces:**
- Consumes: everything from Tasks 1-8 — `lib/basketStrategies.ts`, `lib/basketStorage.ts`, `lib/basketOrders.ts`, `components/BasketPayoffChart.tsx`, `components/basket/StrategyCardGrid.tsx`, `components/basket/LegsTable.tsx`, `components/basket/SavedBasketsPanel.tsx`, plus existing `hooks/useBrokerSelector.ts`, `lib/useLiveOptionsWS.ts`, `components/NavBar.tsx`, `components/Scalper.tsx` (`formatFundsValue`, `ChainOcEntry`, `Toast`).
- Produces: the `/baskets` route, fully wired.

- [ ] **Step 1: Create the orchestrator component**

Create `rs_dashboard/components/Baskets.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import NavBar from './NavBar';
import { ShoppingBasket, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatFundsValue, type ChainOcEntry, type Toast } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type BasketLeg, type OptionType, type PayoffLeg,
  computePayoff, nearestStrike, strikeStep, daysToExpiry,
} from '@/lib/basketStrategies';
import {
  type SavedBasket, loadSavedBaskets, persistSavedBaskets, legToOffset, offsetToStrike,
} from '@/lib/basketStorage';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import BasketPayoffChart from './BasketPayoffChart';
import StrategyCardGrid from './basket/StrategyCardGrid';
import LegsTable from './basket/LegsTable';
import SavedBasketsPanel from './basket/SavedBasketsPanel';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = typeof UNDERLYINGS[number];

function fmtMoney(n: number): string {
  return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function MetricTile({ label, value, tone = 'neutral' }: {
  label: string; value: React.ReactNode; tone?: 'neutral' | 'profit' | 'loss';
}) {
  const color = tone === 'profit' ? 'text-emerald-400' : tone === 'loss' ? 'text-rose-400' : 'text-zinc-100';
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">{label}</p>
      <p className={`text-sm font-bold font-mono tabular-nums mt-1 leading-tight ${color}`}>{value}</p>
    </div>
  );
}

export default function Baskets() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry]     = useState('');

  const [allStrikes, setAllStrikes] = useState<number[]>([]);
  const [prevClose, setPrevClose]   = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]   = useState(0);
  const [strikeMap, setStrikeMap]   = useState<Record<string, StrikeIdentifier>>({});
  const [lotSize, setLotSize]       = useState(75);

  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);

  const [category, setCategory]   = useState<StrategyCategory>('Bullish');
  const [strategy, setStrategy]   = useState<string | null>(null);
  const [legs, setLegs]           = useState<BasketLeg[]>([]);
  const [multiplier, setMultiplier] = useState(1);

  const [toasts, setToasts]           = useState<Toast[]>([]);
  const [placing, setPlacing]         = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);

  const [saveOpen, setSaveOpen]   = useState(false);
  const [saveName, setSaveName]   = useState('');
  const [saved, setSaved]         = useState<SavedBasket[]>([]);

  const [fundsData, setFundsData] = useState<Record<string, number> | null>(null);

  const legCounterRef  = useRef(0);
  const placingRef     = useRef(false);
  const expiryRef      = useRef('');
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);

  const spot = liveQuotes?.spot ?? chainSpot;
  const step = useMemo(() => strikeStep(allStrikes), [allStrikes]);
  const atmStrike = useMemo(
    () => (spot > 0 ? nearestStrike(allStrikes, spot) : null),
    [allStrikes, spot]);

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ── Bootstrap: saved baskets ────────────────────────────────────
  useEffect(() => {
    setSaved(loadSavedBaskets());
  }, []);

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

  // ── Funds tile: reload on broker change ──────────────────────────
  useEffect(() => {
    const url = broker === 'zerodha' ? '/api/scalper/zerodha/funds' : '/api/scalper/funds';
    fetch(url)
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, number> }) => {
        setFundsData(j.success ? (j.data ?? null) : null);
      })
      .catch(() => setFundsData(null));
  }, [broker]);

  // ── Per-expiry: chain + lookup + live feed ──────────────────────
  useEffect(() => {
    if (!expiry) return;

    setLegs([]);
    setStrategy(null);
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});
    setChainSpot(0);

    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        const pc: Record<string, { ce: number; pe: number }> = {};
        for (const [sk, entry] of Object.entries(oc)) {
          pc[sk] = { ce: entry.ce?.previous_close ?? 0, pe: entry.pe?.previous_close ?? 0 };
        }
        setPrevClose(pc);
        if ((j.data.spot ?? 0) > 0) setChainSpot(j.data.spot);
      })
      .catch(() => {});

    const requestedExpiry = expiry;
    const lookupUrl = broker === 'zerodha'
      ? `/api/scalper/zerodha/lookup?underlying=${underlying}&expiry=${expiry}`
      : `/api/scalper/lookup?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, StrikeIdentifier> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});

    for (const b of authenticatedBrokers) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, broker, authenticatedBrokers]);

  // ── Pricing helpers ─────────────────────────────────────────────
  const autoPremium = useCallback((strike: number, option: OptionType): number => {
    const key = String(strike);
    const live = liveQuotes?.strikes?.[key]?.[option === 'CE' ? 'ce' : 'pe']?.ltp ?? 0;
    if (live > 0) return live;
    return prevClose[key]?.[option === 'CE' ? 'ce' : 'pe'] ?? 0;
  }, [liveQuotes, prevClose]);

  const effectivePremium = useCallback((leg: BasketLeg): number => {
    const manual = Number(leg.price);
    if (leg.price.trim() !== '' && !isNaN(manual) && manual > 0) return manual;
    return autoPremium(leg.strike, leg.option);
  }, [autoPremium]);

  // ── Leg operations ──────────────────────────────────────────────
  const newLegId = () => `leg-${++legCounterRef.current}`;

  const applyTemplate = useCallback((tpl: StrategyTemplate) => {
    if (atmStrike == null || !allStrikes.length) {
      addToast('error', 'Strikes still loading', 'Wait for the option chain, then pick a strategy');
      return;
    }
    setStrategy(tpl.key);
    setLegs(tpl.legs.map(l => {
      const target = atmStrike + l.offset * step;
      const strike = nearestStrike(allStrikes, target) ?? atmStrike;
      return { id: newLegId(), side: l.side, option: l.option, strike, lots: l.ratio, type: 'MARKET' as const, price: '' };
    }));
  }, [atmStrike, allStrikes, step, addToast]);

  const updateLeg = useCallback((id: string, patch: Partial<BasketLeg>) => {
    setLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const stepStrike = useCallback((id: string, dir: 1 | -1) => {
    setLegs(prev => prev.map(l => {
      if (l.id !== id) return l;
      const idx = allStrikes.indexOf(l.strike);
      const nextIdx = idx < 0 ? -1 : idx + dir;
      if (nextIdx < 0 || nextIdx >= allStrikes.length) return l;
      return { ...l, strike: allStrikes[nextIdx], price: '' };
    }));
  }, [allStrikes]);

  const addLeg = useCallback(() => {
    if (atmStrike == null) {
      addToast('error', 'Strikes still loading');
      return;
    }
    setLegs(prev => [...prev, {
      id: newLegId(), side: 'B', option: 'CE', strike: atmStrike, lots: 1, type: 'MARKET', price: '',
    }]);
  }, [atmStrike, addToast]);

  const removeLeg = useCallback((id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  // ── Payoff + metrics ────────────────────────────────────────────
  const payoffLegs = useMemo<PayoffLeg[]>(() => legs.map(l => ({
    side: l.side, option: l.option, strike: l.strike,
    premium: effectivePremium(l), qty: l.lots * multiplier * lotSize,
  })), [legs, multiplier, lotSize, effectivePremium]);

  const payoff = useMemo(() => {
    if (!payoffLegs.length || payoffLegs.some(l => l.premium <= 0)) return null;
    const strikes = payoffLegs.map(l => l.strike);
    const center = spot > 0 ? spot : (Math.min(...strikes) + Math.max(...strikes)) / 2;
    const lo = Math.min(Math.min(...strikes) - 6 * step, center * 0.94);
    const hi = Math.max(Math.max(...strikes) + 6 * step, center * 1.06);
    return computePayoff(payoffLegs, lo, hi);
  }, [payoffLegs, spot, step]);

  const riskReward = useMemo(() => {
    if (!payoff || payoff.maxProfitUnlimited || payoff.maxLossUnlimited) return null;
    if (payoff.maxLoss >= 0) return null;
    return payoff.maxProfit / Math.abs(payoff.maxLoss);
  }, [payoff]);

  const daysLeft = useMemo(() => (expiry ? daysToExpiry(expiry) : null), [expiry]);

  // ── Order placement ─────────────────────────────────────────────
  const placeBasket = useCallback(async () => {
    if (!legs.length || !expiry) return;
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    if (placingRef.current) return;

    for (const leg of legs) {
      if (leg.type === 'LIMIT' && effectivePremium(leg) <= 0) {
        addToast('error', 'Invalid limit price', `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.strike} ${leg.option}`);
        return;
      }
    }

    placingRef.current = true;
    setPlacing(true);

    const ordered = sortLegsForPlacement(legs);
    let placedCount = 0;
    try {
      for (const leg of ordered) {
        const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
        const qty = leg.lots * multiplier * lotSize;
        const price = leg.type === 'LIMIT' ? effectivePremium(leg) : undefined;

        const req = resolveOrderRequest(broker, { side: leg.side, option: leg.option, strike: leg.strike, qty, type: leg.type, price }, strikeMap);
        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — basket stopped');
          return;
        }

        try {
          const res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
          });
          const j = await res.json() as { success: boolean; order_id?: string; error?: string };
          if (j.success) {
            placedCount += 1;
            addToast('success', `${label} placed`, `ID: ${j.order_id}`);
          } else {
            addToast('error', `${label} failed — basket stopped`, j.error ?? 'Unknown error');
            return;
          }
        } catch (e) {
          addToast('error', `${label} UNCONFIRMED — basket stopped`, `Check Orders before retrying: ${String(e)}`);
          return;
        }
      }
      addToast('success', `Basket complete: ${placedCount}/${legs.length} legs placed`);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }, [legs, expiry, confirmPlace, multiplier, lotSize, strikeMap, broker, effectivePremium, addToast]);

  // ── Save / load ───────────────────────────────────────────────
  const persistSaved = (next: SavedBasket[]) => {
    setSaved(next);
    persistSavedBaskets(next);
  };

  const saveBasket = () => {
    const name = saveName.trim();
    if (!name || !legs.length) {
      addToast('error', !legs.length ? 'Nothing to save — add legs first' : 'Enter a basket name');
      return;
    }
    if (atmStrike == null) {
      addToast('error', 'Cannot save yet', 'Wait for the option chain to load so ATM is known');
      return;
    }
    const isUpdate = saved.some(s => s.name === name);
    const entry: SavedBasket = {
      name, category, strategy, multiplier, underlying,
      legs: legs.map(({ side, option, strike, lots, type }) => ({
        side, option, lots, type, offset: legToOffset(strike, atmStrike, step),
      })),
    };
    persistSaved([...saved.filter(s => s.name !== name), entry]);
    setSaveName('');
    addToast('success', isUpdate ? `Basket "${name}" updated` : `Basket "${name}" saved`);
  };

  // Holds a basket whose underlying didn't match the current selection at the
  // moment Load was clicked. The effect below finishes applying it once the
  // newly-selected underlying's chain (atmStrike/allStrikes) is ready — the
  // user clicks Load once, even across an underlying switch.
  const pendingLoadRef = useRef<SavedBasket | null>(null);

  const applyLoadedBasket = useCallback((b: SavedBasket, atm: number, strikes: number[]) => {
    setCategory(b.category);
    setStrategy(b.strategy);
    setMultiplier(b.multiplier);
    setLegs(b.legs.map(l => ({
      id: newLegId(),
      side: l.side, option: l.option, lots: l.lots, type: l.type,
      strike: offsetToStrike(l.offset, atm, strikes, step),
      price: '',
    })));
    setSaveOpen(false);
    addToast('success', `Basket "${b.name}" loaded`, `Re-anchored to current ATM ${atm}`);
  }, [step, addToast]);

  const loadBasket = (b: SavedBasket) => {
    if (b.underlying !== underlying) {
      pendingLoadRef.current = b;
      setUnderlying(b.underlying as Underlying);
      addToast('success', `Switched underlying to ${b.underlying}`, `Loading basket "${b.name}" once its chain is ready`);
      return;
    }
    if (atmStrike == null || !allStrikes.length) {
      addToast('error', 'Chain not loaded yet', 'Wait for strikes to load, then load the basket');
      return;
    }
    applyLoadedBasket(b, atmStrike, allStrikes);
  };

  // Completes a cross-underlying load once the new underlying's chain settles.
  useEffect(() => {
    const pending = pendingLoadRef.current;
    if (!pending || pending.underlying !== underlying) return;
    if (atmStrike == null || !allStrikes.length) return;
    pendingLoadRef.current = null;
    applyLoadedBasket(pending, atmStrike, allStrikes);
  }, [underlying, atmStrike, allStrikes, applyLoadedBasket]);

  const totalQty = legs.reduce((s, l) => s + l.lots, 0) * multiplier;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success' ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
              <ShoppingBasket className="w-3.5 h-3.5 text-emerald-400" />
              BASKETS
            </h1>
            <NavBar />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select value={underlying} onChange={e => setUnderlying(e.target.value as Underlying)}
              className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
              {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>

            {authenticatedBrokers.length > 1 && (
              <select value={broker} onChange={e => setBroker(e.target.value as 'dhan' | 'zerodha')}
                className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
                {authenticatedBrokers.map(b => <option key={b} value={b}>{b === 'dhan' ? 'Dhan' : 'Zerodha'}</option>)}
              </select>
            )}

            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>

            <div className="flex items-center gap-2 h-8 bg-zinc-900 border border-zinc-700 rounded-lg px-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Multiplier</span>
              <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
                <button onClick={() => setMultiplier(m => Math.max(1, m - 1))}
                  className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                  <span className="text-xs font-bold">−</span>
                </button>
                <span className="font-mono font-bold text-xs tabular-nums text-center px-1 w-5 inline-block">{multiplier}</span>
                <button onClick={() => setMultiplier(m => Math.min(20, m + 1))}
                  className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                  <span className="text-xs font-bold">+</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                transport === 'ws' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className="text-[10px] text-zinc-500 font-mono">{lastUpdated}</span>}
            </div>

            {spot > 0 && (
              <span className="h-8 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
                {underlying}&nbsp;{spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}

            {fundsData && (
              <span className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
                <Wallet className="w-3 h-3 text-sky-400" />
                Rs. {formatFundsValue(Number(fundsData.availabelBalance) || 0)}
              </span>
            )}
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-zinc-800">
          <StrategyCardGrid
            category={category}
            onCategoryChange={setCategory}
            selectedKey={strategy}
            onSelectTemplate={applyTemplate}
            disabled={atmStrike == null}
          />
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-4 p-4 items-start">
        <Card className="overflow-hidden">
          <LegsTable
            legs={legs}
            atmStrike={atmStrike}
            allStrikes={allStrikes}
            autoPremium={autoPremium}
            onUpdateLeg={updateLeg}
            onStepStrike={stepStrike}
            onAddLeg={addLeg}
            onRemoveLeg={removeLeg}
            onClearAll={() => { setLegs([]); setStrategy(null); }}
          />

          <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900/40 flex-wrap">
            <SavedBasketsPanel
              saveName={saveName}
              onSaveNameChange={setSaveName}
              onSave={saveBasket}
              saved={saved}
              open={saveOpen}
              onToggleOpen={() => setSaveOpen(o => !o)}
              onLoad={loadBasket}
              onDelete={name => persistSaved(saved.filter(s => s.name !== name))}
            />
          </div>

          {legs.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-3 border-t border-zinc-800 bg-zinc-950/30 flex-wrap">
              <Button onClick={placeBasket} disabled={placing}
                className={`${confirmPlace ? 'animate-pulse' : ''}`}>
                {placing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShoppingBasket className="w-3.5 h-3.5" />}
                {placing ? 'Placing…' : confirmPlace ? `Confirm ${legs.length} legs ×${multiplier}?` : 'Place Basket'}
              </Button>
              <Button size="sm" variant="outline" disabled={placing}
                onClick={() => { setLegs([]); setStrategy(null); setConfirmPlace(false); }}
                className="h-9 px-3 text-[11px] border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 hover:border-rose-400/60 transition-all">
                Clear All
              </Button>
              <div className="ml-auto text-[11px] text-zinc-500 leading-snug text-right">
                <p className="font-semibold text-zinc-400">{totalQty} lots · {totalQty * lotSize} qty total</p>
                <p>Buys placed before sells · {lotSize} qty per lot</p>
              </div>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/40 flex items-baseline justify-between">
            <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">Payoff at Expiry</span>
            <span className="text-[10px] text-zinc-500">premiums from live LTP — override in the Price column</span>
          </div>

          <div className="grid grid-cols-3 divide-x divide-zinc-800 border-b border-zinc-800">
            <MetricTile label="Net Premium"
              tone={!payoff ? 'neutral' : payoff.netPremium >= 0 ? 'profit' : 'loss'}
              value={payoff ? `${payoff.netPremium >= 0 ? 'Credit' : 'Debit'} ${fmtMoney(payoff.netPremium)}` : '—'} />
            <MetricTile label="Max Profit" tone="profit"
              value={!payoff ? '—' : payoff.maxProfitUnlimited ? 'Unlimited' : fmtMoney(payoff.maxProfit)} />
            <MetricTile label="Max Loss" tone="loss"
              value={!payoff ? '—' : payoff.maxLossUnlimited ? 'Unlimited' : fmtMoney(payoff.maxLoss)} />
          </div>
          <div className="grid grid-cols-3 divide-x divide-zinc-800 border-b border-zinc-800">
            <MetricTile label="Breakeven"
              value={payoff && payoff.breakevens.length
                ? payoff.breakevens.map(b => b.toLocaleString('en-IN', { maximumFractionDigits: 1 })).join(' / ')
                : '—'} />
            <MetricTile label="Risk : Reward"
              value={riskReward != null ? `1 : ${riskReward.toFixed(2)}` : '—'} />
            <MetricTile label="Days Left" value={daysLeft ?? '—'} />
          </div>

          <div className="p-4">
            <BasketPayoffChart
              points={payoff?.points ?? []}
              breakevens={payoff?.breakevens ?? []}
              spot={spot}
            />
            <p className="text-[10px] text-zinc-600 mt-2">
              Expiry payoff only (no T+0 curve) · margin calculation not available from broker
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the page route**

Create `rs_dashboard/app/baskets/page.tsx`:

```tsx
import Baskets from '@/components/Baskets';

export const metadata = { title: 'Baskets' };

export default function BasketsPage() {
  return <Baskets />;
}
```

- [ ] **Step 3: Add the nav entry**

In `rs_dashboard/components/NavBar.tsx`, in the `Derivatives` group's `links` array, add a new entry immediately before the `/scalper` entry:

```ts
      { href: '/baskets', label: 'Baskets', desc: 'Predefined option strategies with payoff diagram & quick basket order entry' },
      { href: '/scalper', label: 'Scalper', desc: 'Multi-window active trading & scalping order ticket' },
```

- [ ] **Step 4: Type-check**

Run: `cd rs_dashboard && npx tsc --noEmit`
Expected: no errors. Fix any type mismatches surfaced between the orchestrator and the subcomponents from Tasks 5-8 before proceeding (e.g. prop name drift) — this is the first point where all the pieces compile together.

- [ ] **Step 5: Manual browser verification**

Run: `cd rs_dashboard && npm run dev`, open `http://localhost:3000/baskets`.

Verify:
- NavBar renders and the new "Baskets" link appears under Derivatives and navigates correctly.
- Underlying dropdown defaults to NIFTY; switching to BANKNIFTY/SENSEX reloads expiries and the option chain without a console error.
- Picking a category tab switches the template cards shown; picking a template (e.g. "Short Straddle") populates two legs (S CE, S PE) at the current ATM strike.
- The Payoff panel updates: Net Premium shows a credit, Max Profit is bounded, Max Loss shows "Unlimited", two breakevens are listed, and the chart renders a curve with a blue spot marker and yellow breakeven dots.
- Adding a leg via "Add Leg" appends a new ATM CE buy leg; removing a leg via the trash icon removes it; flipping B/S and CE/PE via the leg buttons works.
- Save a basket, confirm it appears in the Load list with the correct underlying/category/leg-count/multiplier summary; reload the page and confirm the saved basket persists (localStorage).
- Save a basket under NIFTY, switch the underlying dropdown to BANKNIFTY, then click Load on the NIFTY-saved basket: confirm the underlying dropdown snaps back to NIFTY and the legs populate automatically once that chain is ready — no second click on Load should be required.
- If both Dhan and Zerodha are authenticated, confirm the broker dropdown appears and switching it re-resolves the strike lookup (watch the Network tab for a new `/api/scalper/lookup` or `/api/scalper/zerodha/lookup` call).

- [ ] **Step 6: Commit**

```bash
git add rs_dashboard/components/Baskets.tsx rs_dashboard/app/baskets/page.tsx rs_dashboard/components/NavBar.tsx
git commit -m "feat(baskets): add Baskets page orchestrator, route, and nav entry"
```

---

## Task 10: End-to-end order placement verification

**Files:** none (verification-only task, no new files).

**Interfaces:** N/A.

This task exists separately from Task 9 because placing a real order is a higher-risk, market-hours-only verification step that shouldn't be bundled into the same checkpoint as the UI wiring — per this project's testing conventions (see `docs/superpowers/specs/2026-07-19-scalper-broker-selector-design.md`'s Testing section for precedent: broker-order-placement changes get their own manual real-order verification pass).

- [ ] **Step 1: Dry-run the confirm-before-place guard**

During market hours, with the dev server running and a template applied (e.g. Bull Call Spread, 1 lot, MARKET):
- Click "Place Basket" once — confirm the button changes to "Confirm 2 legs ×1?" and pulses, without any network call to `/api/scalper/fast-order` or `/api/scalper/zerodha/order` yet (check Network tab).
- Wait 5 seconds without clicking again — confirm the button reverts to "Place Basket" (the 4-second confirm window expired) and still no order call was made.

- [ ] **Step 2: Verify buy-then-sell sequencing and real order placement**

Apply a small, low-risk template (1 lot). Click "Place Basket" twice within 4 seconds to confirm. In the Network tab, confirm:
- The BUY leg's order request fires before the SELL leg's.
- Each request goes to the correct broker route (`/api/scalper/fast-order` with `securityId` for Dhan, or `/api/scalper/zerodha/order` with `tradingsymbol` for Zerodha) matching the currently selected broker.
- Both legs return `{success: true, order_id: ...}` and a green success toast appears for each, then a final "Basket complete: 2/2 legs placed" toast.
- Confirm the resulting orders appear in the broker's own order book (Dhan app / Kite app) at the expected strikes and quantities.

- [ ] **Step 3: Verify stop-on-failure behavior**

Set one leg to LIMIT with a deliberately invalid price (e.g. clear the price field on a leg whose LTP is currently 0/unavailable, or type `0`). Click Place Basket twice to confirm. Verify:
- The basket halts before any order is sent (the pre-flight LIMIT-price validation catches it) and a red toast identifies the specific leg.
- No partial orders were placed (check Network tab — zero calls to the order endpoints).

- [ ] **Step 4: No commit needed**

This is a verification-only task. If any issue is found, fix it in the relevant task's file, re-run that task's Step 4 (`npx tsc --noEmit`) and this task's checks, then commit the fix with a message like `fix(baskets): <what was wrong>`.

---

## Self-Review Notes (completed during plan authoring)

1. **Spec coverage**: page & nav (Task 9) · templates & payoff math (Task 1) · legs table free-form editing (Task 7) · payoff panel (Task 5, wired in Task 9) · save/load with per-underlying re-anchoring (Task 2, wired in Task 9) · order placement with broker branching and buy-then-sell sequencing (Task 3, wired in Task 9, verified in Task 10) · error handling for unresolvable strikes, invalid limit prices, and stop-on-failure (Task 9 + Task 10). All spec sections have a corresponding task.
2. **Placeholder scan**: no TBD/TODO markers; every step has complete, runnable code or exact manual verification steps.
3. **Type consistency**: `BasketLeg`, `LegSide`, `OptionType`, `StrategyCategory`, `PayoffLeg` all defined once in `lib/basketStrategies.ts` (Task 1) and imported identically by every later task — no redefinition drift. `StrikeIdentifier` defined once in `lib/basketOrders.ts` (Task 3) and reused in `Baskets.tsx` (Task 9). `SavedBasket`/`SavedLeg` defined once in `lib/basketStorage.ts` (Task 2).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-baskets-page.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
