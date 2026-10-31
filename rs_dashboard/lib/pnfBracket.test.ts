import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBracketSpec, planBracketChildren, trailedStop } from './pnfBracket.ts';

test('cleanBracketSpec: Single has none; Bracket needs SL and target; Cover only SL; bad numbers are refused', () => {
  assert.equal(cleanBracketSpec('Single', 5, 5), null);
  assert.deepEqual(cleanBracketSpec('Bracket', 10, 5), { style: 'Bracket', tgtPts: 10, slPts: 5 });
  assert.deepEqual(cleanBracketSpec('Cover', '', 5), { style: 'Cover', tgtPts: 0, slPts: 5 });
  assert.deepEqual(cleanBracketSpec('Bracket', 10, 5, 3), { style: 'Bracket', tgtPts: 10, slPts: 5, trailPts: 3 });
  for (const bad of [cleanBracketSpec('Bracket', 0, 5), cleanBracketSpec('Bracket', 10, ''), cleanBracketSpec('Cover', 0, -1), cleanBracketSpec('Bracket', 10, 5, 0)]) assert.equal(typeof bad, 'string');
});

test('planBracketChildren: a long stops below and targets above, a short the mirror, on the tick grid', () => {
  const long = planBracketChildren({ side: 'BUY', entry: 100, tick: 0.05, spec: { style: 'Bracket', tgtPts: 10, slPts: 4 } });
  assert.ok(Array.isArray(long));
  assert.deepEqual(long.map(c => [c.role, c.side, c.kind, c.level]), [['sl', 'SELL', 'stop', 96], ['target', 'SELL', 'limit', 110]]);
  assert.equal(long[0].trigger, 96);
  const short = planBracketChildren({ side: 'SELL', entry: 100, tick: 0.05, spec: { style: 'Bracket', tgtPts: 10, slPts: 4 } });
  assert.ok(Array.isArray(short));
  assert.deepEqual(short.map(c => [c.role, c.side, c.kind, c.level]), [['sl', 'BUY', 'stop', 104], ['target', 'BUY', 'limit', 90]]);
});

test('planBracketChildren: Cover is the stop only; a stop wider than the price is refused; trail is carried on the stop', () => {
  const cover = planBracketChildren({ side: 'BUY', entry: 100, tick: 0.05, spec: { style: 'Cover', tgtPts: 0, slPts: 4, trailPts: 2 } });
  assert.ok(Array.isArray(cover));
  assert.equal(cover.length, 1);
  assert.equal(cover[0].trailPts, 2);
  assert.equal(typeof planBracketChildren({ side: 'BUY', entry: 3, tick: 0.05, spec: { style: 'Cover', tgtPts: 0, slPts: 5 } }), 'string');
});

test('trailedStop: a long\'s stop only rises, a short\'s only falls, never past the price move', () => {
  assert.equal(trailedStop({ exitSide: 'SELL', trigger: 96, price: 103, trailPts: 4, tick: 0.05 }), 99);
  assert.equal(trailedStop({ exitSide: 'SELL', trigger: 96, price: 99, trailPts: 4, tick: 0.05 }), null);     // 95 < 96: not lowered
  assert.equal(trailedStop({ exitSide: 'BUY', trigger: 104, price: 97, trailPts: 4, tick: 0.05 }), 101);
  assert.equal(trailedStop({ exitSide: 'BUY', trigger: 104, price: 101, trailPts: 4, tick: 0.05 }), null);
});
