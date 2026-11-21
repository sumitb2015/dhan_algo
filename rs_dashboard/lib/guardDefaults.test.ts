import { test } from 'node:test';
import assert from 'node:assert';
import { parseGuardDefaults, validateGuardDefaults, DEFAULT_GUARD_DEFAULTS } from './guardDefaults.ts';

test('a missing or garbled file gives the built-in daily default: Rs 10,000 loss on all three products, enabled', () => {
  for (const raw of [null, undefined, 'x', 5, {}, { loss: 'abc' }]) {
    const d = parseGuardDefaults(raw);
    assert.strictEqual(d.enabled, true);
    assert.strictEqual(d.loss, DEFAULT_GUARD_DEFAULTS.loss);
    assert.deepStrictEqual(d.products, ['INTRADAY', 'MARGIN', 'CNC']);
  }
});

test('a stored value is honoured, product names are normalised (MIS/NRML), and an explicit off survives with no levels', () => {
  const d = parseGuardDefaults({ enabled: true, loss: -25000, profit: 0, products: ['MIS', 'NRML', 'MIS'] });
  assert.deepStrictEqual([d.loss, d.products], [25000, ['INTRADAY', 'MARGIN']]);
  const off = parseGuardDefaults({ enabled: false, loss: 0, profit: 0, products: [] });
  assert.strictEqual(off.enabled, false);
});

test('validate: enabling needs a level and a product; disabling needs neither', () => {
  assert.strictEqual(validateGuardDefaults({ enabled: true, loss: 0, profit: 0, products: ['MIS'] }).ok, false);
  assert.strictEqual(validateGuardDefaults({ enabled: true, loss: 5000, products: [] }).ok, false);
  assert.strictEqual(validateGuardDefaults({ enabled: true, loss: 5000, products: ['NRML'] }).ok, true);
  assert.strictEqual(validateGuardDefaults({ enabled: false }).ok, true);
});
