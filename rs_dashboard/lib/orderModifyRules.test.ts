import test from 'node:test';
import assert from 'node:assert/strict';
import { kotakPriceType, modifyPriceError } from './orderModifyRules.ts';

test('modify price checks: SL-M needs only a trigger; Limit a price; SL-limit both', () => {
  assert.equal(modifyPriceError('STOP_LOSS_MARKET', 0, 180), null);
  assert.notEqual(modifyPriceError('STOP_LOSS_MARKET', 0, 0), null);
  assert.equal(modifyPriceError('LIMIT', 200, 0), null);
  assert.notEqual(modifyPriceError('LIMIT', 0, 0), null);
  assert.notEqual(modifyPriceError('LIMIT', 'x', 0), null);
  assert.equal(modifyPriceError('STOP_LOSS', 201, 200), null);
  assert.notEqual(modifyPriceError('STOP_LOSS', 201, 0), null);
});

test('Kotak price types: SL-M is its own code, not SL', () => {
  assert.equal(kotakPriceType('STOP_LOSS_MARKET'), 'SL-M');
  assert.equal(kotakPriceType('STOP_LOSS'), 'SL');
  assert.equal(kotakPriceType('LIMIT'), 'L');
  assert.equal(kotakPriceType('MARKET'), 'MKT');
});
