import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseBlockers, reverseLotsError } from './indexScalperReverse.ts';

const o = (id: string, securityId: string, side: string, own: boolean, cancellable = true) => ({ id, securityId, side, own, cancellable });

test('a long: working SELL orders on that contract block (own to cancel, foreign refuse); BUY orders and other contracts do not', () => {
  const r = reverseBlockers([
    o('1', '302', 'SELL', true), o('2', '302', 'SELL', false), o('3', '302', 'BUY', true),
    o('4', '303', 'SELL', true), o('5', '302', 'SELL', true, false),
  ], '302', true);
  assert.deepEqual(r, { own: ['1'], foreign: ['2'] });
});

test('a short: its BUY orders are the ones that would add after the flip', () => {
  assert.deepEqual(reverseBlockers([o('1', 'X', 'BUY', true), o('2', 'X', 'SELL', true)], 'X', false), { own: ['1'], foreign: [] });
});

test('lots: unknown or above the per-order cap is refused', () => {
  assert.equal(reverseLotsError(3, 5), null);
  assert.match(reverseLotsError(6, 5)!, /above the 5-lot cap/);
  assert.match(reverseLotsError(null, 5)!, /whole number/);
});
