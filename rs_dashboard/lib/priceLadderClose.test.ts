import test from 'node:test';
import assert from 'node:assert/strict';
import { planClose, isClosePct, CloseGuard, CLOSE_COOLDOWN_MS } from './priceLadderClose.ts';

test('planClose: a short is closed with a BUY, a long with a SELL, 100% sends |net| verbatim', () => {
  assert.deepEqual(planClose(-195, 65, 100), { side: 'BUY', qty: 195 });
  assert.deepEqual(planClose(325, 65, 100), { side: 'SELL', qty: 325 });
  // a non-lot remainder stays fully closable
  assert.deepEqual(planClose(-100, 65, 100), { side: 'BUY', qty: 100 });
});

test('planClose: a share rounds down to whole lots and never reaches zero lots', () => {
  assert.deepEqual(planClose(-195, 65, 50), { side: 'BUY', qty: 65 });        // 3 lots x 50% = 1.5 -> 1
  assert.deepEqual(planClose(-325, 65, 25), { side: 'BUY', qty: 65 });        // 5 lots x 25% = 1.25 -> 1
  assert.equal(typeof planClose(-65, 65, 25), 'string');                      // 1 lot: 25% is under a lot
});

test('planClose: refuses a flat book, a bad share, and a partial with no lot size', () => {
  assert.match(planClose(0, 65, 100) as string, /flat/);
  assert.match(planClose(-130, 65, 30) as string, /pct must be/);
  assert.match(planClose(-130, null, 50) as string, /Lot size unknown/);
  assert.deepEqual(planClose(-130, null, 100), { side: 'BUY', qty: 130 });    // a full close needs no lot size
  assert.equal(isClosePct(75), true);
  assert.equal(isClosePct(60), false);
});

test('CloseGuard: one close per position at a time, then a cooldown while the book catches up', () => {
  const g = new CloseGuard();
  assert.equal(g.tryStart('k', 1000), true);
  assert.equal(g.tryStart('k', 1001), false);                                 // still running
  g.finish('k', 1500, true);
  assert.equal(g.tryStart('k', 1500 + CLOSE_COOLDOWN_MS - 1), false);         // just sent
  assert.equal(g.tryStart('k', 1500 + CLOSE_COOLDOWN_MS), true);
  g.finish('k', 20_000, false);                                               // nothing sent: no cooldown
  assert.equal(g.tryStart('k', 20_001), true);
  assert.equal(g.tryStart('other', 1000), true);
});
