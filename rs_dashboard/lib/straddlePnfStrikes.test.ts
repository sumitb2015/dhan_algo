import test from 'node:test';
import assert from 'node:assert/strict';
import { roundToStep, strikesFor, parseAtmParam } from './straddlePnfStrikes.ts';

test('roundToStep snaps to the nearest 50', () => {
  assert.equal(roundToStep(25024.9), 25000);
  assert.equal(roundToStep(25025), 25050);
  assert.equal(roundToStep(25049.9), 25050);
});

test('strikesFor gives ATM-200, ATM and ATM+200', () => {
  assert.deepEqual(strikesFor(25000), [24800, 25000, 25200]);
});

test('parseAtmParam accepts auto or a positive number and rejects the rest', () => {
  assert.deepEqual(parseAtmParam('auto'), { auto: true });
  assert.deepEqual(parseAtmParam('25020'), { auto: false, atm: 25000 });
  assert.equal(parseAtmParam(''), null);
  assert.equal(parseAtmParam('abc'), null);
  assert.equal(parseAtmParam('-50'), null);
  assert.equal(parseAtmParam(null), null);
});
