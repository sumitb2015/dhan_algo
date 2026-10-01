import { test } from 'node:test';
import assert from 'node:assert';
import { parseBound, normalizeRange, inRange } from './priceRange.ts';

test('parseBound: empty, junk, zero and negatives mean no bound; numbers pass through', () => {
  for (const raw of ['', '  ', 'abc', '0', '-5', 'NaN']) assert.equal(parseBound(raw), null, raw);
  assert.equal(parseBound('250'), 250);
  assert.equal(parseBound('99.5'), 99.5);
});

test('normalizeRange swaps a reversed pair and leaves everything else alone', () => {
  assert.deepEqual(normalizeRange(500, 100), { min: 100, max: 500 });
  assert.deepEqual(normalizeRange(100, 500), { min: 100, max: 500 });
  assert.deepEqual(normalizeRange(300, 300), { min: 300, max: 300 });
  assert.deepEqual(normalizeRange(null, 100), { min: null, max: 100 });
  assert.deepEqual(normalizeRange(100, null), { min: 100, max: null });
});

test('inRange: both bounds are inclusive; a missing bound is open-ended; no bounds = all prices', () => {
  assert.equal(inRange(100, { min: 100, max: 500 }), true);
  assert.equal(inRange(500, { min: 100, max: 500 }), true);
  assert.equal(inRange(99.99, { min: 100, max: 500 }), false);
  assert.equal(inRange(500.01, { min: 100, max: 500 }), false);
  assert.equal(inRange(1_000_000, { min: 100, max: null }), true);
  assert.equal(inRange(0.5, { min: null, max: 100 }), true);
  assert.equal(inRange(123456, { min: null, max: null }), true);
});
