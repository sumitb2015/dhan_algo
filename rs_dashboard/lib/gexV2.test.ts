import { test } from 'node:test';
import assert from 'node:assert';
import type { GexRow } from './gex.ts';
import {
  dynamicFlip, emConfluence, expectedMove, mergeGexRows, netGexAtSpot, regimeNote, spotSideWalls, topWalls, wallRank, type GexLeg,
} from './gexV2.ts';

const row = (strike: number, ceGex: number, peGex: number): GexRow => ({
  strike, ceOi: 1, peOi: 1, ceGamma: 0, peGamma: 0, ceGex, peGex: -Math.abs(peGex), netGex: ceGex - Math.abs(peGex),
});

const rows = [
  row(23800, 900, 100),  // big call GEX BELOW spot: v1 would call it the call wall
  row(24000, 100, 500),
  row(24200, 200, 300),
  row(24400, 700, 50),
  row(24600, 400, 20),
];

test('call wall is the highest call GEX at or above spot, put wall the highest put GEX at or below', () => {
  const w = spotSideWalls(rows, 24250);
  assert.strictEqual(w.callWall, 24400);
  assert.strictEqual(w.putWall, 24000);
  // The global maximum is kept for comparison with v1.
  assert.strictEqual(w.callOverall, 23800);
  assert.strictEqual(w.putOverall, 24000);
});

test('no strike on a side of spot means no wall on that side', () => {
  const w = spotSideWalls([row(24000, 100, 500)], 24500);
  assert.strictEqual(w.callWall, null);
  assert.strictEqual(w.putWall, 24000);
  assert.deepStrictEqual(spotSideWalls(rows, 0).callWall, null);
});

test('top walls rank by size and flag a wall spot has crossed', () => {
  const t = topWalls(rows, 24250, 2);
  assert.deepStrictEqual(t.call.map(w => w.strike), [23800, 24400]);
  assert.deepStrictEqual(t.call.map(w => w.broken), [true, false]); // spot is above the 23,800 call wall
  assert.deepStrictEqual(t.put.map(w => w.strike), [24000, 24200]);
  assert.deepStrictEqual(t.put.map(w => w.broken), [false, false]); // both put walls are below spot: intact
  assert.deepStrictEqual(topWalls(rows, 24100, 2).put.map(w => w.broken), [false, true]); // spot fell below the 24,200 put wall
  assert.strictEqual(wallRank(t.call, 24400), 2);
  assert.strictEqual(wallRank(t.call, 99), null);
});

test('merging expiries sums per strike', () => {
  const m = mergeGexRows([[row(24000, 100, 50)], [row(24000, 20, 10), row(24100, 5, 5)]]);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].ceGex, 120);
  assert.strictEqual(m[0].peGex, -60);
  assert.strictEqual(m[0].netGex, 60);
});

// Calls concentrated high, puts concentrated low: net GEX is negative near the puts and positive near the calls,
// so the zero-gamma level sits between them.
const legs: GexLeg[] = [
  { type: 'CE', strike: 24500, oiUnits: 500_000, ivPct: 14, t: 5 / 365, fwdRatio: 1 },
  { type: 'PE', strike: 24000, oiUnits: 500_000, ivPct: 14, t: 5 / 365, fwdRatio: 1 },
];

test('dynamic flip is the zero crossing of net GEX re-priced at hypothetical spots', () => {
  assert.ok(netGexAtSpot(legs, 24450) > 0);
  assert.ok(netGexAtSpot(legs, 24050) < 0);
  const { flip, curve } = dynamicFlip(legs, 24250);
  assert.ok(flip != null && flip > 24050 && flip < 24450, String(flip));
  assert.strictEqual(curve.length, 61);
  // Symmetric book, symmetric around the midpoint (forward ratio 1): the crossing is close to 24,250.
  assert.ok(Math.abs(flip - 24250) < 60, String(flip));
});

test('dynamic flip ignores a sign change between near-zero points', () => {
  // A huge call position near spot plus a negligible put far away: the only sign changes are in the far tail, at noise level.
  const noisy: GexLeg[] = [
    { type: 'CE', strike: 24250, oiUnits: 5_000_000, ivPct: 14, t: 5 / 365, fwdRatio: 1 },
    { type: 'PE', strike: 19500, oiUnits: 1, ivPct: 14, t: 5 / 365, fwdRatio: 1 },
  ];
  assert.strictEqual(dynamicFlip(noisy, 24250, { minShare: 0.01 }).flip, null);
});

test('dynamic flip is null with no legs or no crossing', () => {
  assert.strictEqual(dynamicFlip([], 24250).flip, null);
  assert.strictEqual(dynamicFlip([legs[0]], 24250).flip, null); // calls only: net never negative
});

test('expected move is the ATM straddle (video example 120 + 110 = 230)', () => {
  const oc = {
    '24200': { ce: { last_price: 300 }, pe: { last_price: 40 } },
    '24250': { ce: { last_price: 120, implied_volatility: 14 }, pe: { last_price: 110, implied_volatility: 14 } },
    '24300': { ce: { last_price: 80 }, pe: { last_price: 160 } },
  };
  const em = expectedMove(oc, { spot: 24260, underlying: 24260, expiry: '2026-10-13' });
  assert.ok(em);
  assert.strictEqual(em.strike, 24250);
  assert.strictEqual(em.em, 230);
  assert.strictEqual(em.upper, 24490);
  assert.strictEqual(em.lower, 24030);
  assert.strictEqual(em.source, 'ltp');
});

test('expected move matches Dhan strike keys like "24250.000000"', () => {
  const em = expectedMove({ '24250.000000': { ce: { last_price: 100 }, pe: { last_price: 90 } } }, { spot: 24240, underlying: 24240, expiry: '2026-10-13' });
  assert.strictEqual(em?.em, 190);
});

test('expected move is null with no usable ATM data', () => {
  assert.strictEqual(expectedMove({ '24250': { ce: { last_price: 0 }, pe: { last_price: 0 } } }, { spot: 24250, underlying: 24250, expiry: '2026-10-13' }), null);
  assert.strictEqual(expectedMove({}, { spot: 24250, underlying: 24250, expiry: '2026-10-13' }), null);
});

test('confluence picks levels within the tolerance of an EM band, nearest first', () => {
  const em = { strike: 24250, em: 200, upper: 24450, lower: 24050, source: 'ltp' as const };
  const c = emConfluence([
    { label: 'Call wall', value: 24400 },   // 50 from upper, inside 0.25 x 200 = 50
    { label: 'Put wall', value: 24000 },    // 50 from lower
    { label: 'Flip', value: 24250 },        // 200 from both: no
    { label: 'Pin', value: null },
  ], em);
  assert.deepStrictEqual(c.map(x => `${x.label}:${x.band}`), ['Call wall:upper', 'Put wall:lower']);
});

test('regime note covers all regimes', () => {
  assert.match(regimeNote('positive'), /rotation/);
  assert.match(regimeNote('negative'), /faster/);
  assert.match(regimeNote('unknown'), /unknown/);
});
