import test from 'node:test';
import assert from 'node:assert/strict';
import { clampQuickSettings, DEFAULT_QUICK, lotsToRemove, strikesAroundAtm, visibleStrikeRows } from './indexScalperQuickTrade.ts';

const STRIKES = Array.from({ length: 41 }, (_, i) => 24500 + i * 50); // 24500..26500

test('settings: whole lots within 1..20, fractions round down, junk falls back to defaults', () => {
  assert.deepEqual(clampQuickSettings({ buyLots: 2, sellLots: 5, product: 'MARGIN', range: 4, stepLots: 3 }), { buyLots: 2, sellLots: 5, product: 'MARGIN', range: 4, stepLots: 3 });
  assert.deepEqual(clampQuickSettings({ buyLots: 99, sellLots: 0 }), { buyLots: 20, sellLots: 1, product: 'INTRADAY', range: 10, stepLots: 1 });
  assert.equal(clampQuickSettings({ stepLots: 99 }).stepLots, 20);
  assert.equal(clampQuickSettings({ stepLots: 2.7 }).stepLots, 2);
  assert.equal(clampQuickSettings({ range: 5 }).stepLots, 1); // saved before the setting existed
  assert.equal(clampQuickSettings({ buyLots: 2.9 }).buyLots, 2); // never a bigger order than asked
  assert.equal(clampQuickSettings({ sellLots: '3' }).sellLots, 3);
  assert.deepEqual(clampQuickSettings(null), DEFAULT_QUICK);
  assert.deepEqual(clampQuickSettings({ buyLots: 'x', product: 'CO' }), DEFAULT_QUICK);
});

test('every strike in view when they are far enough apart; off-screen strikes dropped', () => {
  // 1 point = 1 px, 25400 at y = 100: strikes 50 px apart, plot 300 px tall -> 25100..25400 visible
  const yOf = (p: number) => 100 + (25400 - p);
  const { rows, step } = visibleStrikeRows(STRIKES, yOf, 300, 25350);
  assert.equal(step, 1);
  assert.deepEqual(rows.map(r => r.strike), [25200, 25250, 25300, 25350, 25400, 25450, 25500]);
  assert.equal(rows.find(r => r.strike === 25350)!.atm, true);
  assert.equal(rows.filter(r => r.atm).length, 1);
});

test('zoomed out: thinned by doubling steps from ATM, ATM always kept, gaps >= the minimum', () => {
  // 10 points per px: strikes 5 px apart -> step 8 gives 40 px
  const yOf = (p: number) => 300 + (25350 - p) / 10;
  const { rows, step } = visibleStrikeRows(STRIKES, yOf, 600, 25350);
  assert.equal(step, 8);
  assert.ok(rows.some(r => r.strike === 25350 && r.atm));
  for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i].y - rows[i - 1].y) >= 24);
  for (const r of rows) assert.equal(Math.abs(((r.strike - 25350) / 50) % 8), 0);
});

test('no ATM known: counts from the middle strike in view; nothing in view -> empty', () => {
  const yOf = (p: number) => 300 + (25350 - p) / 10;
  const { rows } = visibleStrikeRows(STRIKES, yOf, 600, null);
  assert.ok(rows.length > 0);
  assert.equal(rows.some(r => r.atm), false);
  assert.deepEqual(visibleStrikeRows(STRIKES, () => null, 600, 25350), { rows: [], step: 1 });
  assert.deepEqual(visibleStrikeRows([], () => 10, 600, 25350), { rows: [], step: 1 });
});

test('Quick Trade range: clamped to 1..50, default 10; ATM ± n listed strikes', () => {
  assert.equal(clampQuickSettings({}).range, 10);
  assert.equal(clampQuickSettings({ range: 0 }).range, 1);
  assert.equal(clampQuickSettings({ range: 500 }).range, 50);
  assert.equal(clampQuickSettings({ range: '7' }).range, 7);
  const s = [25500, 25300, 25350, 25400, 25450, 25250, 25200];
  assert.deepEqual(strikesAroundAtm(s, 25350, 1), [25300, 25350, 25400]);
  assert.deepEqual(strikesAroundAtm(s, 25250, 2), [25200, 25250, 25300, 25350]); // clipped at the low end
  assert.deepEqual(strikesAroundAtm(s, null, 1), [...s].sort((a, b) => a - b));
});

test('the chip\'s "-" takes off the step but never the last lot', () => {
  assert.equal(lotsToRemove(2, 5), 2);
  assert.equal(lotsToRemove(5, 3), 2); // step larger than the leg: leaves one lot
  assert.equal(lotsToRemove(3, 1), 0); // one lot: Exit closes it
  assert.equal(lotsToRemove(1, 0), 0);
  assert.equal(lotsToRemove(Number.NaN, 4), 0);
});
