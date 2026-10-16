import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalAvgOf } from './tradedPriceClient.ts';

test('finalAvgOf: only a final order status gives its average', () => {
  assert.equal(finalAvgOf({ status: 'TRADED', filledQty: 650, avg: 101.2 }), 101.2);
  assert.equal(finalAvgOf({ status: 'PART_TRADED', filledQty: 325, avg: 100 }), 0);   // still working: partial average
  assert.equal(finalAvgOf({ status: 'TRANSIT', filledQty: 0, avg: 0 }), 0);
  assert.equal(finalAvgOf({ status: 'CANCELLED', filledQty: 325, avg: 100.5 }), 100.5); // final, part-filled
  assert.equal(finalAvgOf({ status: 'CANCELLED', filledQty: 0, avg: 0 }), 0);
  assert.equal(finalAvgOf({ status: 'traded', filledQty: 65, avg: 50 }), 50);          // case-insensitive
  assert.equal(finalAvgOf(null), 0);
});
