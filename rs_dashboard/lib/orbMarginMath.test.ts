import test from 'node:test';
import assert from 'node:assert/strict';
import { boughtLegCost, marginVerdict } from './orbMarginMath.ts';

test('boughtLegCost: NSE is units x premium, MCX is lots x rupees per point per lot x premium, both +2%', () => {
  assert.ok(Math.abs(boughtLegCost({ mcx: false, lots: 2, lotUnits: 65, unitsPerLot: 65, premium: 100 }) - 2 * 65 * 100 * 1.02) < 1e-6);
  assert.ok(Math.abs(boughtLegCost({ mcx: true, lots: 3, lotUnits: 1, unitsPerLot: 10, premium: 120 }) - 3 * 10 * 120 * 1.02) < 1e-6);
  assert.ok(Math.abs(boughtLegCost({ mcx: true, lots: 3, lotUnits: 10, unitsPerLot: 10, premium: 120 }) - 3 * 10 * 120 * 1.02) < 1e-6);   // Kotak's barrels per lot do not change the rupee cost
});

test('marginVerdict: fits, does not fit, and every unreadable figure refuses (fail closed)', () => {
  assert.equal(marginVerdict({ funds: 200_000, margin: 150_000, buyPremium: 20_000, name: 'Kotak' }), null);
  assert.equal(marginVerdict({ funds: 170_000, margin: 150_000, buyPremium: 20_000, name: 'Kotak' }), null);          // exactly enough
  assert.match(String(marginVerdict({ funds: 169_999, margin: 150_000, buyPremium: 20_000, name: 'Kotak' })), /Needs about ₹1,70,000, Kotak has ₹1,69,999/);
  assert.match(String(marginVerdict({ funds: null, margin: 1, buyPremium: 0, name: 'Dhan' })), /Could not read Dhan funds/);
  assert.match(String(marginVerdict({ funds: Number.NaN, margin: 1, buyPremium: 0, name: 'Dhan' })), /Could not read Dhan funds/);
  assert.match(String(marginVerdict({ funds: 1e9, margin: null, buyPremium: 0, name: 'Dhan' })), /Could not read the margin/);
  assert.match(String(marginVerdict({ funds: 1e9, margin: 0, buyPremium: 0, name: 'Dhan' })), /Could not read the margin/);
  assert.match(String(marginVerdict({ funds: 0, margin: 1000, buyPremium: 0, name: 'Dhan' })), /Needs about/);       // zero funds is readable and too little
});
