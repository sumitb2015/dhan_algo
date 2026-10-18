import test from 'node:test';
import assert from 'node:assert/strict';
import { clampStop, fillOnSegment, firstCrossed, initialStop, lockAndTrail, pnlPts, stopHit, targetOf } from './risk.ts';

test('initialStop / targetOf are mirrored by side', () => {
  assert.equal(initialStop('SELL', 100, 25), 125);
  assert.equal(initialStop('BUY', 100, 25), 75);
  assert.equal(targetOf('SELL', 100, 35), 65);
  assert.equal(targetOf('BUY', 100, 35), 135);
  assert.equal(targetOf('BUY', 100, 0), null);
});

test('clampStop only tightens', () => {
  assert.equal(clampStop('SELL', 120, 130), 120);
  assert.equal(clampStop('SELL', 120, 110), 110);
  assert.equal(clampStop('BUY', 80, 70), 80);
  assert.equal(clampStop('BUY', 80, 90), 90);
  assert.equal(clampStop('BUY', 80, NaN), 80);
});

test('lockAndTrail SELL: initial until trigger, then cost, then steps down', () => {
  // entry 100, start 15% => trigger at best 85; step 5 pts, by 2 pts
  assert.equal(lockAndTrail('SELL', 100, 90, 125, 15, 5, 2), 125);
  assert.equal(lockAndTrail('SELL', 100, 85, 125, 15, 5, 2), 100);
  assert.equal(lockAndTrail('SELL', 100, 80, 125, 15, 5, 2), 98);
  assert.equal(lockAndTrail('SELL', 100, 70, 125, 15, 5, 2), 94);
});

test('lockAndTrail BUY: mirror image', () => {
  assert.equal(lockAndTrail('BUY', 100, 110, 80, 15, 5, 2), 80);
  assert.equal(lockAndTrail('BUY', 100, 115, 80, 15, 5, 2), 100);
  assert.equal(lockAndTrail('BUY', 100, 125, 80, 15, 5, 2), 104);
});

test('stopHit / pnlPts by side', () => {
  assert.equal(stopHit('SELL', 125, 125), true);
  assert.equal(stopHit('BUY', 80, 80), true);
  assert.equal(stopHit('BUY', 81, 80), false);
  assert.equal(pnlPts('SELL', 100, 90), 10);
  assert.equal(pnlPts('BUY', 100, 90), -10);
});

test('firstCrossed: moving up the lowest level, moving down the highest', () => {
  const ex = [{ level: 110 }, { level: 105 }];
  assert.equal(firstCrossed(100, 120, ex)?.level, 105);
  assert.equal(firstCrossed(120, 100, ex)?.level, 110);
  assert.equal(firstCrossed(100, 120, []), null);
});

test('fillOnSegment: level inside the move fills at the level, a gap past it fills at the price', () => {
  assert.equal(fillOnSegment(100, 120, 110), 110);
  assert.equal(fillOnSegment(120, 120, 110), 120); // gap at the open
  assert.equal(fillOnSegment(100, 108, 110), 108); // ratcheted level already behind the price
});
