import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PNF_LOTS,
  validatePnfOrder,
  calculateLegQty,
  buildPaperFills,
  type PnfLegInput,
} from './pnfOrderLogic.ts';

test('PnfOrderLogic: MAX_PNF_LOTS hard ceiling is 20 lots', () => {
  assert.equal(MAX_PNF_LOTS, 20);
});

test('PnfOrderLogic: validates positive lots and valid action', () => {
  const v = validatePnfOrder({
    action: 'BUY',
    lots: 2,
    legs: [{ securityId: '1001', segment: 'NSE_FNO', lot: 65 }],
  });
  assert.equal(v.valid, true);
  assert.equal(v.lotsNum, 2);
});

test('PnfOrderLogic: rejects lot sizing > MAX_PNF_LOTS (20)', () => {
  const v = validatePnfOrder({
    action: 'BUY',
    lots: 25,
    legs: [{ securityId: '1001', segment: 'NSE_FNO', lot: 65 }],
  });
  assert.equal(v.valid, false);
  assert.match(v.error!, /exceeds max allowed size/);
});

test('PnfOrderLogic: rejects invalid lots (0, negative, non-numeric)', () => {
  assert.equal(validatePnfOrder({ action: 'BUY', lots: 0, legs: [{ securityId: '1', segment: 'NSE_EQ' }] }).valid, false);
  assert.equal(validatePnfOrder({ action: 'BUY', lots: -1, legs: [{ securityId: '1', segment: 'NSE_EQ' }] }).valid, false);
  assert.equal(validatePnfOrder({ action: 'BUY', lots: NaN, legs: [{ securityId: '1', segment: 'NSE_EQ' }] }).valid, false);
});

test('PnfOrderLogic: rejects empty legs or invalid action', () => {
  assert.equal(validatePnfOrder({ action: 'INVALID' as never, lots: 1, legs: [{ securityId: '1', segment: 'NSE_EQ' }] }).valid, false);
  assert.equal(validatePnfOrder({ action: 'BUY', lots: 1, legs: [] }).valid, false);
});

test('PnfOrderLogic: calculates quantity per segment and broker', () => {
  const eqLeg: PnfLegInput = { securityId: '1', segment: 'NSE_EQ', lot: 1 };
  assert.equal(calculateLegQty(eqLeg, 50, 'dhan'), 50);

  const fnoLeg: PnfLegInput = { securityId: '2', segment: 'NSE_FNO', lot: 65 };
  assert.equal(calculateLegQty(fnoLeg, 2, 'dhan'), 130);

  const mcxLeg: PnfLegInput = { securityId: '3', segment: 'MCX_COMM', lot: 10 };
  assert.equal(calculateLegQty(mcxLeg, 2, 'dhan'), 2); // Dhan uses lots
  assert.equal(calculateLegQty(mcxLeg, 2, 'kotak'), 20); // Kotak uses units
});

test('PnfOrderLogic: buildPaperFills creates simulated fill records', () => {
  const legs: PnfLegInput[] = [
    { securityId: '1001', segment: 'NSE_FNO', displayName: 'NIFTY 24000 CE', lot: 65 },
    { securityId: '1002', segment: 'NSE_FNO', displayName: 'NIFTY 24000 PE', lot: 65 },
  ];
  const fills = buildPaperFills(legs, 'SELL', 3, 'dhan');
  assert.equal(fills.length, 2);
  assert.equal(fills[0].side, 'SELL');
  assert.equal(fills[0].lots, 3);
  assert.equal(fills[0].quantity, 195);
  assert.equal(fills[0].status, 'FILLED');
  assert.match(fills[0].orderId, /^sim-pnf-/);
});
