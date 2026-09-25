import { test } from 'node:test';
import assert from 'node:assert';
import {
  strikeRuleApplies, isFarExpiry, strikeAllowed, allowedStrikes, snapToAllowed, assessSpread,
} from './farExpiryRules.ts';

const EXP = ['2026-09-29', '2026-10-06', '2026-10-13', '2026-10-27'];

test('first two expiries are not far, third onward is', () => {
  assert.strictEqual(isFarExpiry('2026-09-29', EXP), false);
  assert.strictEqual(isFarExpiry('2026-10-06', EXP), false);
  assert.strictEqual(isFarExpiry('2026-10-13', EXP), true);
  assert.strictEqual(isFarExpiry('2026-10-27', EXP), true);
});

test('unknown expiry or unloaded list is never far', () => {
  assert.strictEqual(isFarExpiry('2027-01-01', EXP), false);
  assert.strictEqual(isFarExpiry('2026-10-27', []), false);
  assert.strictEqual(isFarExpiry('', EXP), false);
});

test('far expiry only allows multiples of 100; near expiries allow all', () => {
  assert.strictEqual(strikeAllowed('NIFTY', '2026-10-27', EXP, 23450), false);
  assert.strictEqual(strikeAllowed('NIFTY', '2026-10-27', EXP, 23500), true);
  assert.strictEqual(strikeAllowed('NIFTY', '2026-10-06', EXP, 23450), true);
});

test('MCX underlyings are exempt from the rule', () => {
  assert.strictEqual(strikeAllowed('CRUDEOIL', '2026-10-27', EXP, 5450), true);
});

test('allowedStrikes filters only on far expiries', () => {
  const s = [23400, 23450, 23500, 23550];
  assert.deepStrictEqual(allowedStrikes('NIFTY', '2026-10-27', EXP, s), [23400, 23500]);
  assert.deepStrictEqual(allowedStrikes('NIFTY', '2026-10-06', EXP, s), s);
});

test('snapToAllowed picks the nearest allowed strike, lower on a tie', () => {
  const s = [23400, 23450, 23500, 23550, 23600];
  assert.strictEqual(snapToAllowed('NIFTY', '2026-10-27', EXP, 23450, s), 23400);
  assert.strictEqual(snapToAllowed('NIFTY', '2026-10-27', EXP, 23550, s), 23500);
  assert.strictEqual(snapToAllowed('NIFTY', '2026-10-27', EXP, 23500, s), 23500);
  assert.strictEqual(snapToAllowed('NIFTY', '2026-10-06', EXP, 23450, s), 23450);
});

test('assessSpread: ok / wide needs both % and absolute floor', () => {
  assert.strictEqual(assessSpread({ bid: 201.5, ask: 202.7 }).status, 'ok');
  assert.strictEqual(assessSpread({ bid: 10, ask: 12 }).status, 'wide');       // 18%, Rs 2
  assert.strictEqual(assessSpread({ bid: 2.0, ask: 2.3 }).status, 'ok');       // 14% but only Rs 0.30
});

test('assessSpread: zero side is no_market, missing data is unknown', () => {
  assert.strictEqual(assessSpread({ bid: 0, ask: 5 }).status, 'no_market');
  assert.strictEqual(assessSpread({ bid: 5, ask: 0 }).status, 'no_market');
  assert.strictEqual(assessSpread(undefined).status, 'unknown');
  assert.strictEqual(assessSpread({ bid: null, ask: 5 }).status, 'unknown');
  assert.strictEqual(assessSpread({ bid: NaN, ask: 5 }).status, 'unknown');
});

test('strikeRuleApplies covers index underlyings only', () => {
  assert.strictEqual(strikeRuleApplies('NIFTY'), true);
  assert.strictEqual(strikeRuleApplies('SENSEX'), true);
  assert.strictEqual(strikeRuleApplies('CRUDEOIL'), false);
});
