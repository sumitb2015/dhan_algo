import test from 'node:test';
import assert from 'node:assert/strict';
import { entryFilter, type FilterInput } from './orbFilters.ts';
import type { PivotSet } from './pivotLevels.ts';

const piv: PivotSet = { p: 100, tc: 102, bc: 98, r1: 110, r2: 120, r3: 130, r4: 140, s1: 90, s2: 80, s3: 70, s4: 60 };
const base: FilterInput = { side: 'LONG', tf: 1, htfConfirm: 0, htfSignal: null, levelGuardPts: 0, price: 105, pivots: piv };

test('entryFilter: both filters off lets everything through', () => {
  assert.equal(entryFilter(base), null);
  assert.equal(entryFilter({ ...base, side: 'SHORT' }), null);
});

test('entryFilter: the higher timeframe must show the entry colour; not ready blocks; a confirm at or below the trading timeframe is ignored', () => {
  const h = { ...base, htfConfirm: 15 };
  assert.equal(entryFilter({ ...h, htfSignal: 'BULL' }), null);
  assert.match(entryFilter({ ...h, htfSignal: 'NEUTRAL' })!, /15m is NEUTRAL, not BULL/);
  assert.match(entryFilter({ ...h, side: 'SHORT', htfSignal: 'BULL' })!, /not BEAR/);
  assert.match(entryFilter({ ...h, htfSignal: null })!, /not ready/);
  assert.equal(entryFilter({ ...h, tf: 15, htfSignal: 'BEAR' }), null);
});

test('entryFilter: pivot guard blocks a LONG just under a level and a SHORT just over one, nearest level named', () => {
  const g = { ...base, levelGuardPts: 6 };
  assert.match(entryFilter({ ...g, price: 105 })!, /R1 110 is 5\.0 pts above - no LONG/);
  assert.equal(entryFilter({ ...g, price: 103 }), null);                          // R1 7 pts away, TC already below
  assert.match(entryFilter({ ...g, side: 'SHORT', price: 95 })!, /S1 90 is 5\.0 pts below/);
  assert.match(entryFilter({ ...g, price: 101 })!, /TC 102 is 1\.0 pts above/);  // nearest of TC and R1
  assert.equal(entryFilter({ ...g, pivots: null }), null);                        // no previous session: not filtered
  assert.equal(entryFilter({ ...g, price: 110 }), null);                          // exactly on a level: not ahead of it
});
