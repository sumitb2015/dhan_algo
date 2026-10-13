import { test } from 'node:test';
import assert from 'node:assert';
import { buildDexRows, dexLevels, dexSummary, ratioLabel } from './dex.ts';

const oc = {
  '22300.000000': { ce: { oi: 5433480, greeks: { delta: 0.68057 } }, pe: { oi: 10592010, greeks: { delta: -0.37846 } } },
  '22350.000000': { ce: { oi: 8413925, greeks: { delta: 0.54487 } }, pe: { oi: 5402150, greeks: { delta: -0.46817 } } },
};

test('DEX = delta x OI units x spot; puts negative (app: 22300 call 8,279 Cr, 22350 call 10,262 Cr)', () => {
  const rows = buildDexRows(oc, 22363.35);
  assert.strictEqual(rows.length, 2);
  assert.ok(Math.abs(rows[0].ceGex / 1e7 - 8269.66) < 0.01);
  assert.ok(Math.abs(rows[1].ceGex / 1e7 - 10252.47) < 0.01);
  assert.ok(rows[0].peGex < 0);
  assert.strictEqual(rows[0].netGex, rows[0].ceGex + rows[0].peGex);
});

test('a put delta reported with a positive sign is still negative exposure', () => {
  const rows = buildDexRows({ '100.000000': { pe: { oi: 10, greeks: { delta: 0.4 } } } }, 100);
  assert.strictEqual(rows[0].peGex, -400);
});

test('no spot or no OI gives no rows', () => {
  assert.deepStrictEqual(buildDexRows(oc, 0), []);
  assert.deepStrictEqual(buildDexRows({ '1.000000': { ce: { oi: 0, greeks: { delta: 0.5 } } } }, 100), []);
});

test('summary ratio is |put| / call and the word follows it', () => {
  const s = dexSummary(buildDexRows(oc, 22363.35));
  assert.ok(s.ratio != null && s.ratio > 0);
  assert.strictEqual(ratioLabel(0.57), 'Bullish');
  assert.strictEqual(ratioLabel(0.95), 'Balanced');
  assert.strictEqual(ratioLabel(1.5), 'Bearish');
  assert.strictEqual(ratioLabel(null), null);
});

test('levels: largest call = resistance, largest put = support, flip between the negative and positive net strikes', () => {
  const rows = buildDexRows(oc, 22363.35);
  const lv = dexLevels(rows, 22363.35);
  assert.strictEqual(lv.callResistance, 22350);
  assert.strictEqual(lv.putSupport, 22300);
  assert.strictEqual(lv.flip, 22325);
});

test('summary values: call and put totals, net and ratio over the rows given', () => {
  const s = dexSummary(buildDexRows(oc, 100));
  const calls = (0.68057 * 5433480 + 0.54487 * 8413925) * 100;
  const puts = -(0.37846 * 10592010 + 0.46817 * 5402150) * 100;
  assert.ok(Math.abs(s.call - calls) < 1e-3 * calls);
  assert.ok(Math.abs(s.put - puts) < 1e-3 * Math.abs(puts));
  assert.ok(Math.abs(s.net - (calls + puts)) < 1);
  assert.ok(Math.abs((s.ratio ?? 0) - -puts / calls) < 1e-9);
  assert.strictEqual(dexSummary([]).ratio, null);
});

test('a strike with only one side still builds, and a missing delta gives zero exposure', () => {
  const rows = buildDexRows({ '100.000000': { ce: { oi: 50, greeks: { delta: 0.5 } } }, '150.000000': { ce: { oi: 50, greeks: null }, pe: { oi: 10, greeks: { delta: -0.3 } } } }, 10);
  assert.strictEqual(rows[0].peGex, -0);
  assert.strictEqual(rows[0].ceGex, 250);
  assert.strictEqual(rows[1].ceGex, 0);
  assert.strictEqual(rows[1].peGex, -30);
});

test('with two flips the one nearest spot is reported', () => {
  const mk = (k: number, ce: number, pe: number) => ({ [`${k}.000000`]: { ce: { oi: 1, greeks: { delta: ce } }, pe: { oi: 1, greeks: { delta: pe } } } });
  const rows = buildDexRows({ ...mk(100, 0.1, -0.9), ...mk(150, 0.9, -0.1), ...mk(200, 0.1, -0.9), ...mk(250, 0.9, -0.1) }, 1);
  assert.strictEqual(dexLevels(rows, 240).flip, 225);
  assert.strictEqual(dexLevels(rows, 110).flip, 125);
});

test('put support skips the call-resistance strike: app 2026-10-13 09:22, largest put 22400 (-15,341) is also the largest call, support = 22500', () => {
  const g = (strike: number, ceGex: number, peGex: number) => ({ strike, ceOi: 1, peOi: 1, ceGamma: 0, peGamma: 0, ceGex, peGex, netGex: ceGex + peGex });
  const rows = [g(22300, 8356.72, -10369.10), g(22350, 9362.51, -8200.97), g(22400, 17806.66, -15340.84), g(22450, 15011.68, -10122.17), g(22500, 16784.12, -10443.66)];
  const lv = dexLevels(rows, 22439.95);
  assert.strictEqual(lv.callResistance, 22400);
  assert.strictEqual(lv.putSupport, 22500);
  assert.strictEqual(lv.flip, 22325);
});
