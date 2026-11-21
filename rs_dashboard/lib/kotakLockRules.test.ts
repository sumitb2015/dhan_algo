import { test } from 'node:test';
import assert from 'node:assert';
import { orderAddsExposure } from './kotakLockRules.ts';

test('orders that open or add exposure are refused on a locked day', () => {
  assert.strictEqual(orderAddsExposure('S', 65, 0), true);    // new short
  assert.strictEqual(orderAddsExposure('B', 65, 0), true);    // new long
  assert.strictEqual(orderAddsExposure('S', 65, -65), true);  // add to a short
  assert.strictEqual(orderAddsExposure('B', 65, 130), true);  // add to a long
});

test('a reducing or closing order always passes; an oversize one that would flip through flat does not', () => {
  assert.strictEqual(orderAddsExposure('B', 65, -65), false); // cover a short fully
  assert.strictEqual(orderAddsExposure('B', 30, -65), false); // partial cover
  assert.strictEqual(orderAddsExposure('S', 65, 65), false);  // sell a long
  assert.strictEqual(orderAddsExposure('B', 130, -65), true); // would flip to long 65
  assert.strictEqual(orderAddsExposure('S', 0, 65), false);   // zero quantity adds nothing
});
