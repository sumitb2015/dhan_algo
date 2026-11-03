import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveGuard, noteBoxes, rupeesPerBox } from './pnfGuardBoxes.ts';
import { cleanGuard, evalGuard, type LadderGuard } from './priceLadderGuard.ts';

test('rupeesPerBox: box points x lots x rupees per point per lot; unknown inputs give null, never 0', () => {
  assert.equal(rupeesPerBox(5, 2, 10), 100);          // CRUDEOILM: 5-pt box, 2 lots, 10 barrels per lot
  assert.equal(rupeesPerBox(5, 0, 10), null);
  assert.equal(rupeesPerBox(null, 2, 10), null);
  assert.equal(rupeesPerBox(5, 2, undefined), null);
});

test('effectiveGuard folds box levels into the rupee ones, the lower of the two wins, and leaves the rest alone', () => {
  const g: LadderGuard = { on: true, target: 1000, targetBoxes: 10, stopBoxes: 5, trailBy: 300 };
  const e = effectiveGuard(g, 100);                    // a box is worth Rs 100
  assert.equal(e.target, 1000);                        // 10 boxes = 1000 = the rupee target
  assert.equal(e.stop, 500);                           // 5 boxes = Rs 500, no rupee stop
  assert.equal(e.trailBy, 300);
  assert.equal(effectiveGuard({ ...g, target: 5000 }, 100).target, 1000, 'the boxes are the lower level');
  assert.equal(effectiveGuard({ ...g, target: 600 }, 100).target, 600, 'the rupees are the lower level');
  assert.equal(effectiveGuard(g, null), g, 'no box value: unchanged (box levels wait for a position)');
  const plain: LadderGuard = { on: true, target: 1000 };
  assert.equal(effectiveGuard(plain, 100), plain);
});

test('evaluated with the folded levels, whichever of the rupee and box levels is reached first exits', () => {
  const g: LadderGuard = { on: true, target: 1000, stop: 1000, targetBoxes: 10, stopBoxes: 5 };
  const e = effectiveGuard(g, 100);
  assert.equal(evalGuard(e, 400).reason, null);
  assert.match(evalGuard(e, -500).reason ?? '', /stop-loss/);                 // 5 boxes of loss
  assert.match(evalGuard(e, 1000).reason ?? '', /target/);
  assert.equal(noteBoxes(g, 100, evalGuard(e, -500).reason!), 'MTM stop-loss ₹500 hit (5 boxes)');
  assert.equal(noteBoxes(g, 100, evalGuard(e, 1000).reason!), 'MTM target ₹1,000 hit (10 boxes)');
  assert.equal(noteBoxes({ ...g, targetBoxes: 20 }, 100, 'MTM target ₹1,000 hit'), 'MTM target ₹1,000 hit', 'the rupee target tripped, not the boxes');
});

test('cleanGuard accepts box levels as the only rule and rejects a bad one', () => {
  const g = cleanGuard({ on: true, targetBoxes: '10', stopBoxes: 5 });
  assert.equal(typeof g, 'object');
  assert.deepEqual([(g as LadderGuard).targetBoxes, (g as LadderGuard).stopBoxes], [10, 5]);
  assert.equal(typeof cleanGuard({ on: true }), 'string');
  assert.equal((cleanGuard({ on: true, stopBoxes: -3, target: 100 }) as LadderGuard).stopBoxes, undefined);
});
