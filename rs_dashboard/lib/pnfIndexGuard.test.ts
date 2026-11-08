import test from 'node:test';
import assert from 'node:assert/strict';
import { autoIndexLeg, indexGuardPosition, ownMarkLeg, rupeeLevels, stepOwnMark } from './pnfIndexGuard.ts';

test('autoIndexLeg: the option row\'s own side and lots, P&L from its premium, entry P&L 0; no option = no leg', () => {
  assert.deepEqual(autoIndexLeg({ lots: 2, traded: { action: 'SELL' } }, -150), { side: 'SHORT', lots: 2, pnl: -150, entryPnl: 0 });
  assert.deepEqual(autoIndexLeg({ lots: 1, traded: { action: 'BUY' } }, null), { side: 'LONG', lots: 1, pnl: null, entryPnl: 0 });
  assert.equal(autoIndexLeg({ lots: 1 }, 10), null, 'a row without a traded option is not an index row');
});

test('stepOwnMark: the chart\'s own units, filled at the live premium on each change; ownMarkLeg prices them', () => {
  const held = { id: 'h1', action: 'BUY' as const, units: 65 };
  const m1 = stepOwnMark(null, held, 65, 120, 65)!;                         // first sight: 1 lot at 120
  assert.deepEqual(ownMarkLeg(m1, 130, 65), { side: 'LONG', lots: 1, pnl: 650 });
  const m2 = stepOwnMark(m1, { ...held, units: 130 }, 65, 130, 65)!;        // this chart adds a lot at 130
  assert.equal(ownMarkLeg(m2, 130, 65)!.pnl, 650, 'the add starts flat at its own premium');
  const m3 = stepOwnMark(m2, { ...held, units: 65 }, 65, 140, 65)!;         // reduces a lot at 140: the realised part stays in the mark
  assert.equal(ownMarkLeg(m3, 140, 65)!.pnl, 1950);                         // (140-125) x 65 realised + (140-125) x 65 open
  assert.equal(stepOwnMark(m3, m3 && { ...held, units: 65 }, 65, 140, 65), m3, 'unchanged units: the same mark');
  assert.equal(stepOwnMark(m3, null, 65, 140, 65), null, 'flat');
  assert.equal(stepOwnMark(m3, { ...held, id: 'h2' }, 65, 100, 65)!.leg.avg, 100, 'a new held row starts its own mark');
  assert.equal(stepOwnMark(m1, { ...held, units: 130 }, 65, null, 65), m1, 'no premium: the last mark is kept');
  assert.equal(stepOwnMark(null, held, 65, null, 65), null, 'never priced yet: nothing to value');
  const s1 = stepOwnMark(null, { id: 's', action: 'SELL', units: 75 }, 75, 90, 75)!;
  assert.deepEqual(ownMarkLeg(s1, 80, 75), { side: 'SHORT', lots: 1, pnl: 750 });
  assert.equal(ownMarkLeg(s1, null, 75)!.pnl, null);
});

test('two charts holding the SAME strike keep independent marks: one chart\'s add or close never moves the other\'s P&L', () => {
  let c1 = stepOwnMark(null, { id: 'a', action: 'BUY', units: 65 }, 65, 120, 65);
  let c2 = stepOwnMark(null, { id: 'b', action: 'BUY', units: 65 }, 65, 140, 65);
  c2 = stepOwnMark(c2, { id: 'b', action: 'BUY', units: 195 }, 65, 150, 65);   // chart 2 adds 2 lots at 150
  c2 = stepOwnMark(c2, null, 65, 160, 65);                                     // ...and closes everything
  c1 = stepOwnMark(c1, { id: 'a', action: 'BUY', units: 65 }, 65, 160, 65);
  assert.equal(ownMarkLeg(c1, 160, 65)!.pnl, 40 * 65, 'chart 1 = its own lot from 120, nothing of chart 2');
  assert.equal(c2, null);
});

test('indexGuardPosition: flat, one part, both parts; MIXED on opposite sides; null P&L unless all priced', () => {
  const a = { side: 'SHORT' as const, lots: 1, pnl: -100, entryPnl: 0 };
  const h = { side: 'SHORT' as const, lots: 2, pnl: 300 };
  assert.equal(indexGuardPosition(null, null), null);
  assert.deepEqual(indexGuardPosition(a, null), { side: 'SHORT', lots: 1, avg: null, pnl: -100, entryPnl: 0 });
  assert.deepEqual(indexGuardPosition(null, h), { side: 'SHORT', lots: 2, avg: null, pnl: 300 }, 'a hand-held part has no known entry P&L');
  assert.deepEqual(indexGuardPosition(a, h), { side: 'SHORT', lots: 3, avg: null, pnl: 200 });
  assert.equal(indexGuardPosition(a, { ...h, side: 'LONG' })!.side, 'MIXED');
  assert.equal(indexGuardPosition(a, { ...h, pnl: null })!.pnl, null);
});

test('rupeeLevels drops box levels and keeps the rest', () => {
  assert.deepEqual(rupeeLevels({ on: true, target: 500, targetBoxes: 10, stopBoxes: 10, trailBy: 200 }), { on: true, target: 500, trailBy: 200 });
  const g = { on: false, stop: 100 };
  assert.equal(rupeeLevels(g), g);
});
