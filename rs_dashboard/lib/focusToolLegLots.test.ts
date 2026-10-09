/**
 * Per-leg lots (AlgoTest Leg Builder: "enter the desired quantity in terms of
 * lots … for each leg"): a row's CE and PE may trade different lot counts.
 *
 *     node --test lib/focusToolLegLots.test.ts
 *
 * What is covered: the sizing rule (legLots), the entry gate, the quantity an
 * entry order carries (with the Quantity Multiplier) for NIFTY and CRUDEOILM,
 * the overall SL / target / trail rules on an uneven book, and a source guard
 * that no FocusTool entry path went back to the row-wide `row.lots`.
 * The order placement itself (placeLeg) needs the page; it is exercised by the
 * source guard and by a SIM row, not by a unit test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  legLots, hasLegLots, multipliedLots, evaluateEntry, evaluateOverallExit, nextOverallPeak,
  entryPremiumWeighted, sidePremium, EMPTY_ROW_LIVE, type RowLive,
} from './focusToolRules.ts';
import { UNDERLYING_META } from './focusToolUnderlyings.ts';

const MARKETS = [
  { u: 'NIFTY' as const, lot: 75, ce: 170, pe: 130 },
  { u: 'CRUDEOILM' as const, lot: UNDERLYING_META.CRUDEOILM.unitsPerLot, ce: 170, pe: 130 },
];

// ── legLots ──────────────────────────────────────────────────────────────────
test('legLots: a row with no per-leg lots trades the row lots on both legs (every row saved before this)', () => {
  assert.equal(legLots({ lots: 2 }, 'CE'), 2);
  assert.equal(legLots({ lots: 2 }, 'PE'), 2);
  assert.equal(hasLegLots({ lots: 2 }), false);
});

test('legLots: each leg uses its own count, the other keeps the row lots', () => {
  const row = { lots: 1, ceLots: 3 };
  assert.equal(legLots(row, 'CE'), 3);
  assert.equal(legLots(row, 'PE'), 1);
  assert.equal(hasLegLots(row), true);
  assert.equal(legLots({ lots: 1, ceLots: 3, peLots: 5 }, 'PE'), 5);
});

test('legLots: 0, negative, blank and NaN overrides fall back to the row lots; fractions truncate', () => {
  for (const bad of [0, -2, NaN, undefined, null as never]) {
    assert.equal(legLots({ lots: 2, ceLots: bad as number }, 'CE'), 2, String(bad));
  }
  assert.equal(legLots({ lots: 2, ceLots: 3.9 }, 'CE'), 3);
  assert.equal(legLots({ lots: 0 }, 'CE'), 0);        // no lots anywhere stays 0, never a surprise 1
  assert.equal(hasLegLots({ lots: 2, ceLots: 2, peLots: 2 }), false);   // an override equal to the row is not "uneven"
});

// ── entry gate ───────────────────────────────────────────────────────────────
const ctx = { nowHm: '09:30', groupEnabled: true, product: 'INTRADAY' as const, backstopHm: '15:17', dte: 0, strikesReady: true, flat: true, tradingDay: true };
const base = { status: 'armed' as const, lots: 1, dte: 'Any' as const, entryTime: '09:20', exitTime: '15:00' };

test('evaluateEntry: lots must be > 0 for every leg the row trades', () => {
  assert.equal(evaluateEntry({ ...base, lots: 0 }, ctx).enter === false, true);
  assert.match(evaluateEntry({ ...base, lots: 0 }, ctx).reason, /lots must be > 0/);
  // a per-leg count rescues a zero row lots only on that leg: a BOTH row still needs the other leg
  assert.match(evaluateEntry({ ...base, lots: 0, ceLots: 2, side: 'BOTH' }, ctx).reason, /lots must be > 0/);
  assert.equal(evaluateEntry({ ...base, lots: 0, ceLots: 2, peLots: 1, side: 'BOTH' }, ctx).enter, true);
  // a CE-only row does not care about the PE leg
  assert.equal(evaluateEntry({ ...base, lots: 0, ceLots: 2, side: 'CE' }, ctx).enter, true);
});

test('evaluateEntry: an uneven row enters like any other', () => {
  assert.equal(evaluateEntry({ ...base, lots: 1, ceLots: 3, peLots: 1, side: 'BOTH' }, ctx).enter, true);
});

// ── the quantity an entry order carries ──────────────────────────────────────
for (const m of MARKETS) {
  const tag = `[${m.u}]`;

  test(`${tag} entry quantity: CE 3 lots, PE 1 lot → 3 × and 1 × the lot size, ×Qty multiplier on both`, () => {
    const row: { lots: number; ceLots: number; peLots: number; qtyMultiplier?: number } = { lots: 1, ceLots: 3, peLots: 1 };
    assert.equal(multipliedLots(row, legLots(row, 'CE')) * m.lot, 3 * m.lot);
    assert.equal(multipliedLots(row, legLots(row, 'PE')) * m.lot, 1 * m.lot);
    const x2 = { ...row, qtyMultiplier: 2 };
    assert.equal(multipliedLots(x2, legLots(x2, 'CE')), 6);
    assert.equal(multipliedLots(x2, legLots(x2, 'PE')), 2);
  });

  // ── an uneven book through the overall rules ───────────────────────────────
  // 3 lots CE @170 + 1 lot PE @130: weighted entry = 3·170 + 130 = 640 points.
  const ceQ = 3 * m.lot, peQ = 1 * m.lot;
  const row = (o: object = {}) => ({
    side: 'BOTH', slRupees: '', slMultiplier: '', exitTime: '', noReEntryAfter: '', lots: 1, ceLots: 3, peLots: 1,
    fill: { ceQty: ceQ, peQty: peQ, ceStrike: 1, peStrike: 1, ceEntry: m.ce, peEntry: m.pe, ts: '' },
    ...o,
  } as never);
  const ENTRY = entryPremiumWeighted([{ premium: m.ce, qty: ceQ }, { premium: m.pe, qty: peQ }], m.lot);

  /** Both legs' premiums scaled together; returns the live state when the weighted book has `pts` points of profit. */
  const liveAt = (pts: number): RowLive => {
    const k = (ENTRY - pts) / ENTRY;
    const ceLtp = m.ce * k, peLtp = m.pe * k;
    return {
      ...EMPTY_ROW_LIVE,
      ceStrike: 1, peStrike: 1, ltpCe: ceLtp, ltpPe: peLtp,
      cePosition: { netQty: -ceQ, sellAvg: m.ce } as never,
      pePosition: { netQty: -peQ, sellAvg: m.pe } as never,
      pnl: (m.ce - ceLtp) * ceQ + (m.pe - peLtp) * peQ,
      entryPremium: ENTRY, lotSize: m.lot,
    };
  };

  test(`${tag} uneven book: the combined entry premium is lot-weighted (640 points, not 300)`, () => {
    assert.equal(ENTRY, 3 * m.ce + m.pe);
    assert.equal(sidePremium(row(), liveAt(0), undefined, m.lot), ENTRY);
  });

  const replay = (r: object, path: number[]) => {
    let peak = { pnl: 0, pts: 0 };
    for (let i = 0; i < path.length; i++) {
      const live = liveAt(path[i]);
      peak = nextOverallPeak(peak, { pnl: live.pnl, pts: path[i] });
      const ov = evaluateOverallExit(r as never, live, peak, undefined, m.lot);
      if (ov) return { tick: i, kind: ov.kind, reason: ov.reason };
    }
    return null;
  };

  test(`${tag} uneven book: Overall Target % of premium fires at 5% of the 640-point weighted premium (32 points)`, () => {
    const r = row({ overallTarget: { enabled: true, mode: 'premiumPct', value: '5' } });
    assert.equal(replay(r, [0, 20, 31.9]), null);
    const hit = replay(r, [0, 20, 32.01]);
    assert.equal(hit?.tick, 2);
    assert.equal(hit?.kind, 'target');
  });

  test(`${tag} uneven book: Overall Target MTM fires on the book's rupee P&L`, () => {
    // 10 weighted points = 10 × lot rupees (the sum of leg P&L across 3 + 1 lots)
    const r = row({ overallTarget: { enabled: true, mode: 'mtm', value: String(10 * m.lot) } });
    assert.equal(replay(r, [0, 9.9]), null);
    assert.equal(replay(r, [0, 10.01])?.tick, 1);
  });

  test(`${tag} uneven book: Lock exits at the lock after the reach, on the rupee P&L`, () => {
    const r = row({ overallTrail: { enabled: true, kind: 'lock', reach: String(20 * m.lot), lock: String(10 * m.lot), every: '', by: '' } });
    assert.equal(replay(r, [0, 20.01, 12]), null);
    assert.equal(replay(r, [0, 20.01, 12, 9.99])?.tick, 3);
  });

  test(`${tag} uneven book: Overall Trail SL (% of premium) tightens off the weighted premium`, () => {
    // SL 10% of 640 = 64 pts; trail every 5% (32 pts) by 2% (12.8 pts): peak 32 → SL 51.2 pts
    const r = row({ slMultiplier: '1.1', overallTrail: { enabled: true, kind: 'trailSl', reach: '', lock: '', every: '5', by: '2' } });
    assert.equal(replay(r, [0, 32.01, -51.1]), null);
    assert.equal(replay(r, [0, 32.01, -51.3])?.kind, 'sl');
  });
}

// ── nothing bypasses the per-leg size ────────────────────────────────────────
test('FocusTool sizes every entry order off legLots, never the row-wide lots', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', 'components', 'FocusTool.tsx'), 'utf-8');
  assert.equal(/multipliedLots\(\s*(row|fresh)\s*,\s*(row|fresh)\.lots\s*\)/.test(src), false,
    'an entry path sizes with multipliedLots(row, row.lots) — it must use legLots(row, leg)');
  assert.ok((src.match(/multipliedLots\(row, legLots\(row, leg\)\)/g) ?? []).length >= 4);
  assert.match(src, /<RowLotsControl row=\{row\} onUpdate=\{onUpdate\} \/>/);
});
