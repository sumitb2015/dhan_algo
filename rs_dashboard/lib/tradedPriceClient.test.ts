import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalAvgOf, fullFillAvg } from './tradedPriceClient.ts';

test('finalAvgOf: only a final order status gives its average', () => {
  assert.equal(finalAvgOf({ status: 'TRADED', filledQty: 650, avg: 101.2 }), 101.2);
  assert.equal(finalAvgOf({ status: 'PART_TRADED', filledQty: 325, avg: 100 }), 0);   // still working: partial average
  assert.equal(finalAvgOf({ status: 'TRANSIT', filledQty: 0, avg: 0 }), 0);
  assert.equal(finalAvgOf({ status: 'CANCELLED', filledQty: 325, avg: 100.5 }), 100.5); // final, part-filled
  assert.equal(finalAvgOf({ status: 'CANCELLED', filledQty: 0, avg: 0 }), 0);
  assert.equal(finalAvgOf({ status: 'traded', filledQty: 65, avg: 50 }), 50);          // case-insensitive
  assert.equal(finalAvgOf(null), 0);
});

test('fullFillAvg: only an order that fully TRADED the quantity counts (a partial, a cancelled remainder or a first slice does not)', () => {
  assert.equal(fullFillAvg({ status: 'TRADED', filledQty: 650, avg: 101.2 }, 650), 101.2);
  assert.equal(fullFillAvg({ status: 'TRADED', filledQty: 700, avg: 101.2 }, 650), 101.2, 'more than asked is still the whole position');
  assert.equal(fullFillAvg({ status: 'CANCELLED', filledQty: 325, avg: 100 }, 650), 0, 'a partial fill whose rest was cancelled');
  assert.equal(fullFillAvg({ status: 'TRADED', filledQty: 325, avg: 100 }, 650), 0, 'the first slice of a split order');
  assert.equal(fullFillAvg({ status: 'PART_TRADED', filledQty: 650, avg: 100 }, 650), 0);
  assert.equal(fullFillAvg({ status: 'TRADED', filledQty: 650, avg: 0 }, 650), 0);
  assert.equal(fullFillAvg(null, 650), 0);
});
