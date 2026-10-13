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
