import test from 'node:test';
import assert from 'node:assert/strict';
import { clampQuickSettings, DEFAULT_QUICK, visibleStrikeRows } from './indexScalperQuickTrade.ts';

const STRIKES = Array.from({ length: 41 }, (_, i) => 24500 + i * 50); // 24500..26500

test('settings: whole lots within 1..20, fractions round down, junk falls back to defaults', () => {
  assert.deepEqual(clampQuickSettings({ buyLots: 2, sellLots: 5, product: 'MARGIN' }), { buyLots: 2, sellLots: 5, product: 'MARGIN' });
  assert.deepEqual(clampQuickSettings({ buyLots: 99, sellLots: 0 }), { buyLots: 20, sellLots: 1, product: 'INTRADAY' });
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
