import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveOrderSlot, KOTAK_ORDER_GAP_MS } from './kotakToken.ts';

test('orders take consecutive slots a gap apart: a burst is spread out, an idle lane sends at once', () => {
  const st = { nextOrderAt: 0 };
  assert.equal(reserveOrderSlot(st, 1000), 0, 'the first order goes immediately');
  assert.equal(reserveOrderSlot(st, 1000), KOTAK_ORDER_GAP_MS, 'the second, in the same instant, waits one gap');
  assert.equal(reserveOrderSlot(st, 1050), 2 * KOTAK_ORDER_GAP_MS - 50, 'the third waits for the slot after the second');
  assert.equal(reserveOrderSlot(st, 5000), 0, 'long after the burst the lane is free again');
  assert.equal(reserveOrderSlot(st, 5000), KOTAK_ORDER_GAP_MS);
});
