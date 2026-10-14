import { test } from 'node:test';
import assert from 'node:assert';
import { riskHit, riskLevels, NO_RISK } from './bearishRisk.ts';

const cfg = { sl: 30, tgt: 50, trail: 20 };

test('everything off never fires', () => assert.strictEqual(riskHit(100, 50, 500, NO_RISK), null));
test('SL at +30% of avg', () => { assert.strictEqual(riskHit(100, null, 129.9, cfg), null); assert.strictEqual(riskHit(100, null, 130, cfg), 'SL'); });
test('target at -50% of avg', () => { assert.strictEqual(riskHit(100, 60, 50.1, { ...cfg, trail: 0 }), null); assert.strictEqual(riskHit(100, 50, 50, { ...cfg, trail: 0 }), 'TARGET'); });
test('trail follows the low and is armed only below entry', () => {
  assert.strictEqual(riskLevels(100, 100, cfg).trail, null);          // never traded below entry: not armed
  assert.strictEqual(riskLevels(100, 60, cfg).trail, 72);             // 60 × 1.2
  assert.strictEqual(riskHit(100, 60, 71.9, { ...cfg, tgt: 0 }), null);
  assert.strictEqual(riskHit(100, 60, 72, { ...cfg, tgt: 0 }), 'TRAIL');
});
test('no price, no decision', () => assert.strictEqual(riskHit(100, 60, null, cfg), null));
