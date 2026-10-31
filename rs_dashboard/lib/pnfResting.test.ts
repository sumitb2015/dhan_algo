import test from 'node:test';
import assert from 'node:assert/strict';
import { paperStep, planResting, reached, snapToTick } from './pnfResting.ts';

test('snapToTick: up / down / nearest on the tick grid', () => {
  assert.equal(snapToTick(100.07, 0.05, 'down'), 100.05);
  assert.equal(snapToTick(100.07, 0.05, 'up'), 100.1);
  assert.equal(snapToTick(100.07, 0.05, 'nearest'), 100.05);
  assert.equal(snapToTick(23123.4, 0.1, 'down'), 23123.4);
  assert.equal(snapToTick(9887.5, 1, 'up'), 9888);
});

test('planResting: the ladder rule - BUY below / SELL above = LIMIT, the other side = SL-limit with a buffer', () => {
  const buyLow = planResting({ side: 'BUY', level: 99.97, ref: 101, tick: 0.05 });
  assert.deepEqual(buyLow, { side: 'BUY', kind: 'limit', level: 99.97, price: 99.95 });   // never pays more than the box
  const sellHigh = planResting({ side: 'SELL', level: 102.02, ref: 101, tick: 0.05 });
  assert.deepEqual(sellHigh, { side: 'SELL', kind: 'limit', level: 102.02, price: 102.05 });
  const buyHigh = planResting({ side: 'BUY', level: 102.02, ref: 101, tick: 0.05, bufferPct: 2 });
  assert.ok(!('error' in buyHigh) && buyHigh.kind === 'stop');
  assert.ok(!('error' in buyHigh) && buyHigh.trigger === 102.05 && buyHigh.price > buyHigh.trigger!, 'a BUY stop-limit sits above its trigger');
  const sellLow = planResting({ side: 'SELL', level: 99.97, ref: 101, tick: 0.05 });
  assert.ok(!('error' in sellLow) && sellLow.kind === 'stop' && sellLow.trigger === 99.95 && sellLow.price < sellLow.trigger!);
});

test('planResting refuses the current price and a level far from it', () => {
  assert.ok('error' in planResting({ side: 'BUY', level: 101, ref: 101, tick: 0.05 }));
  assert.ok('error' in planResting({ side: 'BUY', level: 70, ref: 101, tick: 0.05 }));
});

test('reached: limits on their side of the level, stops past it', () => {
  assert.equal(reached('BUY', 'limit', 100, 100.5), false);
  assert.equal(reached('BUY', 'limit', 100, 100), true);
  assert.equal(reached('BUY', 'stop', 100, 99.5), false);
  assert.equal(reached('BUY', 'stop', 100, 100.2), true);
  assert.equal(reached('SELL', 'limit', 100, 100.2), true);
  assert.equal(reached('SELL', 'stop', 100, 99.9), true);
});

test('paperStep: a limit fills at its limit or better; an SL-limit triggers, then fills while inside its limit', () => {
  assert.deepEqual(paperStep({ side: 'BUY', kind: 'limit', price: 100 }, 100.4), { fill: false, triggered: false });
  assert.deepEqual(paperStep({ side: 'BUY', kind: 'limit', price: 100 }, 99.6), { fill: true, price: 99.6 });     // gapped through: better
  const stop = { side: 'BUY' as const, kind: 'stop' as const, trigger: 102, price: 104.05 };
  assert.deepEqual(paperStep(stop, 101.9), { fill: false, triggered: false });
  assert.deepEqual(paperStep(stop, 102.4), { fill: true, price: 102.4 });
  assert.deepEqual(paperStep(stop, 105), { fill: false, triggered: true }, 'jumped past the limit: triggered, not filled');
  assert.deepEqual(paperStep({ ...stop, triggered: true }, 103), { fill: true, price: 103 });
  assert.deepEqual(paperStep({ side: 'SELL', kind: 'stop', trigger: 98, price: 96.05 }, 97.5), { fill: true, price: 97.5 });
});
