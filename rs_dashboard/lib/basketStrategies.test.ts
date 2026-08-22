import { test } from 'node:test';
import assert from 'node:assert';
import {
  legPnlAtExpiry, computePayoff, nearestStrike, strikeStep, daysToExpiry,
} from './basketStrategies.ts';

test('legPnlAtExpiry: short call ITM loses intrinsic minus premium collected', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -15); // premium(5) - intrinsic(20) = -15
});

test('legPnlAtExpiry: long put OTM loses only the premium paid', () => {
  const leg = { side: 'B' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 2 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -10); // (0 - 5) * qty(2)
});

test('computePayoff: short straddle has bounded profit and unlimited right-side loss', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 },
    { side: 'S' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.netPremium, 10);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.strictEqual(result.rightWing, 'loss');
  assert.ok(Math.abs(result.maxProfit - 10) < 1e-6);
  assert.strictEqual(result.breakevens.length, 2);
  assert.ok(Math.abs(result.breakevens[0] - 90) < 1);
  assert.ok(Math.abs(result.breakevens[1] - 110) < 1);
});

test('computePayoff: bull call spread has bounded profit AND bounded loss', () => {
  const legs = [
    { side: 'B' as const, option: 'CE' as const, strike: 100, premium: 8, qty: 1 },
    { side: 'S' as const, option: 'CE' as const, strike: 120, premium: 3, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.ok(Math.abs(result.maxLoss - -5) < 1e-6);   // net debit paid
  assert.ok(Math.abs(result.maxProfit - 15) < 1e-6); // (120-100) - 5 net debit
});

test('computePayoff: long put profit is bounded by the zero underlying floor', () => {
  const result = computePayoff([
    { side: 'B' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.strictEqual(result.maxProfit, 95);
  assert.strictEqual(result.maxLoss, -5);
  assert.strictEqual(result.rightWing, null);
});

test('computePayoff: short put loss is bounded by the zero underlying floor', () => {
  const result = computePayoff([
    { side: 'S' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.strictEqual(result.maxProfit, 5);
  assert.strictEqual(result.maxLoss, -95);
  assert.strictEqual(result.rightWing, null);
});

test('computePayoff: short call keeps unlimited right-side loss', () => {
  const result = computePayoff([
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.strictEqual(result.rightWing, 'loss');
});

test('nearestStrike picks the closest listed strike', () => {
  assert.strictEqual(nearestStrike([100, 150, 200], 170), 150);
});

test('nearestStrike returns null for an empty strike list', () => {
  assert.strictEqual(nearestStrike([], 100), null);
});

test('strikeStep returns the median gap between strikes', () => {
  assert.strictEqual(strikeStep([100, 150, 200, 250]), 50);
});

test('strikeStep defaults to 50 with fewer than two strikes', () => {
  assert.strictEqual(strikeStep([100]), 50);
});

test('daysToExpiry counts calendar days, 0 on the expiry date itself', () => {
  const now = new Date(2026, 6, 21); // 2026-07-21
  assert.strictEqual(daysToExpiry('2026-07-21', now), 0);
  assert.strictEqual(daysToExpiry('2026-07-24', now), 3);
});

test('daysToExpiry returns null for an unparseable expiry string', () => {
  assert.strictEqual(daysToExpiry('not-a-date'), null);
});
