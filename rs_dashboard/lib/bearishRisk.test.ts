import { test } from 'node:test';
import assert from 'node:assert';
import { riskHit, riskLevels, NO_RISK, pageLossState } from './bearishRisk.ts';

const cfg = { sl: 30, tgt: 50, trail: 5 };   // trail = 5 points

test('everything off never fires', () => assert.strictEqual(riskHit(100, 50, 500, NO_RISK), null));
test('SL at +30% of avg', () => { assert.strictEqual(riskHit(100, null, 129.9, cfg), null); assert.strictEqual(riskHit(100, null, 130, cfg), 'SL'); });
test('target at -50% of avg', () => { assert.strictEqual(riskHit(100, 60, 50.1, { ...cfg, trail: 0 }), null); assert.strictEqual(riskHit(100, 50, 50, { ...cfg, trail: 0 }), 'TARGET'); });
test('trail follows the low and is armed only below entry', () => {
  assert.strictEqual(riskLevels(100, 100, cfg).trail, null);          // never traded below entry: not armed
  assert.strictEqual(riskLevels(100, 60, cfg).trail, 65);             // 60 + 5 points
  assert.strictEqual(riskLevels(100, 59, cfg).trail, 64);             // 1 point lower low = stop 1 point lower
  assert.strictEqual(riskHit(100, 60, 64.9, { ...cfg, tgt: 0 }), null);
  assert.strictEqual(riskHit(100, 60, 65, { ...cfg, tgt: 0 }), 'TRAIL');
});
test('no price, no decision', () => assert.strictEqual(riskHit(100, 60, null, cfg), null));

test('page max loss: off when 0, hit at or below -cap, closed rows count their realized', () => {
  assert.strictEqual(pageLossState([{ open: true, pnl: -9000 }], 0).state, 'off');
  assert.strictEqual(pageLossState([{ open: true, pnl: -4000 }, { open: false, pnl: -999 }], 5000).state, 'ok');
  const hit = pageLossState([{ open: true, pnl: -4000 }, { open: false, pnl: -1000 }], 5000);
  assert.deepStrictEqual(hit, { state: 'hit', total: -5000, unpriced: 0 });
  assert.strictEqual(pageLossState([{ open: true, pnl: -6000 }, { open: true, pnl: 2000 }], 5000).state, 'ok');
});
test('page max loss never fires on a partial total: an unpriced open row makes it unknown', () => {
  const r = pageLossState([{ open: true, pnl: -9000 }, { open: true, pnl: null }], 5000);
  assert.deepStrictEqual(r, { state: 'unknown', total: -9000, unpriced: 1 });
  assert.strictEqual(pageLossState([], 5000).state, 'ok');
});
