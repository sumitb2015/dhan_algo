import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBsGreeks,
  scoreShortCall,
  calculateRequiredShortLots,
  calculatePortfolioGreeks,
  recommendDiagonalStrikes,
  isMonthlyExpiry,
  monthlyExpiries,
} from './diagonalStrikeAdvisor.ts';

test('computeBsGreeks: computes accurate Call Delta, Gamma, Theta, and Vega', () => {
  const spot = 22421.95;
  const strike = 23200;
  const dte = 23;
  const iv = 0.138;
  const greeks = computeBsGreeks(spot, strike, dte, iv, 0.07, 'CE');

  assert.ok(greeks.delta > 0.15 && greeks.delta < 0.22, `Delta should be in target range 0.15-0.22, got ${greeks.delta}`);
  assert.ok(greeks.gamma > 0 && greeks.gamma < 0.001, `Gamma should be positive, got ${greeks.gamma}`);
  assert.ok(greeks.thetaDay < 0, `ThetaDay should be negative for long option, got ${greeks.thetaDay}`);
  assert.ok(greeks.vega > 0, `Vega should be positive, got ${greeks.vega}`);
});

test('scoreShortCall: returns positive efficiency score for decaying call', () => {
  const thetaDay = -3.5;
  const gamma = 0.0003;
  const score = scoreShortCall(thetaDay, gamma);
  assert.equal(Math.round(score), Math.round(3.5 / 0.0003));
});

test('calculateRequiredShortLots: correctly sizes lots and respects ceilings', () => {
  // 3 lots Nifty (lot size 65) with 0.58 delta = 3 * 65 * 0.58 = 113.1 delta shares
  const longDeltaShares = 113.1;
  const targetNetDeltaShares = 35; // leaves 78.1 delta shares to be shorted
  const shortCallDelta = 0.18;
  const lotSize = 65;

  const shortLots = calculateRequiredShortLots(
    longDeltaShares,
    targetNetDeltaShares,
    shortCallDelta,
    lotSize,
    1.25,
    6,
  );

  // 78.1 / (0.18 * 65) = 78.1 / 11.7 = 6.67 -> clamped by max_short_lots 6
  assert.ok(shortLots >= 4 && shortLots <= 6, `Expected 4-6 lots, got ${shortLots}`);
});

test('calculatePortfolioGreeks: aggregates long and short positions and reports safety', () => {
  const spot = 22421.95;
  const lotSize = 65;

  const longLeg = { strike: 23000, dte: 85, lots: 3, iv: 0.14 };
  const shortLeg = { strike: 23200, dte: 23, lots: 4, iv: 0.138 };

  const port = calculatePortfolioGreeks(longLeg, shortLeg, spot, lotSize);

  assert.ok(port.longDeltaShares > 0);
  assert.ok(port.shortDeltaShares > 0);
  assert.ok(port.portfolioGamma > -0.15, `Gamma should be safe above -0.15, got ${port.portfolioGamma}`);
  assert.ok(port.gammaStatus === 'EXCELLENT' || port.gammaStatus === 'ACCEPTABLE');
});

test('recommendDiagonalStrikes: identifies optimal strike and ranks candidates', () => {
  const spot = 22421.95;
  const strikes = [22800, 22900, 23000, 23100, 23200, 23300, 23400, 23500];

  const rec = recommendDiagonalStrikes({
    spot,
    frontExpiry: '2026-10-27',
    frontDte: 23,
    strikes,
    longLeg: {
      strike: 23000,
      expiry: '2026-12-29',
      dte: 85,
      lots: 3,
      iv: 0.14,
    },
  });

  assert.ok(rec.bestCandidate !== null);
  assert.equal(rec.bestCandidate?.classification, 'optimal');
  assert.ok(rec.bestCandidate.delta >= 0.15 && rec.bestCandidate.delta <= 0.22);
  assert.ok(rec.bestCandidate.score > 0);
});

test('isMonthlyExpiry: last weekday of month is monthly, others are weekly', () => {
  for (const e of ['2026-10-27', '2026-11-24', '2026-12-29']) assert.equal(isMonthlyExpiry(e), true, e);
  for (const e of ['2026-10-13', '2026-11-03', '2026-11-10']) assert.equal(isMonthlyExpiry(e), false, e);
});

test('recommendDiagonalStrikes: ranks by closeness to 0.18 delta, not the high-delta band edge', () => {
  const spot = 22421.95;
  const strikes: number[] = [];
  for (let k = 22800; k <= 24200; k += 50) strikes.push(k);
  const rec = recommendDiagonalStrikes({
    spot,
    frontExpiry: '2026-11-24',
    frontDte: 40,
    strikes,
    longLeg: { strike: 23000, expiry: '2026-12-29', dte: 85, lots: 3, iv: 0.14 },
  });
  assert.ok(rec.bestCandidate);
  assert.ok(Math.abs(rec.bestCandidate.delta - 0.18) <= 0.035, `best delta ${rec.bestCandidate.delta}`);
  assert.deepEqual(rec.summary.warnings, []);
});

test('recommendDiagonalStrikes: warns on weekly front expiry and short outliving the long', () => {
  const rec = recommendDiagonalStrikes({
    spot: 22421.95,
    frontExpiry: '2027-01-05',
    frontDte: 40,
    strikes: [23200, 23300],
    longLeg: { strike: 23000, expiry: '2026-12-29', dte: 85, lots: 3, iv: 0.14 },
  });
  assert.equal(rec.summary.warnings.length, 2);
});

test('recommendDiagonalStrikes: lots are trimmed so projected gamma stays inside the budget', () => {
  const rec = recommendDiagonalStrikes({
    spot: 22421.95,
    frontExpiry: '2026-11-24',
    frontDte: 40,
    strikes: [22600, 22700, 22800],
    longLeg: { strike: 23000, expiry: '2026-12-29', dte: 85, lots: 3, iv: 0.14 },
    maxShortLots: 25,
    maxShortRatio: 5,
  });
  for (const c of rec.candidates) {
    assert.ok(c.recommendedLots === 1 || c.resultingNetGamma >= -0.15, `${c.strike}: ${c.recommendedLots} lots gamma ${c.resultingNetGamma}`);
  }
});

test('monthlyExpiries: latest listed expiry per month, robust to holiday-shifted monthlies', () => {
  // 2026-08: last Tuesday would be the 25th; holiday moves the monthly to Monday the 24th while Monday the 31st exists.
  const listed = ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-24', '2026-09-29'];
  const m = monthlyExpiries(listed);
  assert.equal(m.has('2026-08-24'), true);
  assert.equal(m.has('2026-08-18'), false);
  assert.equal(m.has('2026-09-29'), true);
  assert.equal(isMonthlyExpiry('2026-08-24'), false); // the heuristic gets this wrong; the list-based rule does not
});

test('recommendDiagonalStrikes: listedExpiries removes the false weekly warning on a shifted monthly', () => {
  const base = {
    spot: 22421.95, frontExpiry: '2026-08-24', frontDte: 40, strikes: [23200, 23300],
    longLeg: { strike: 23000, expiry: '2026-12-29', dte: 85, lots: 3, iv: 0.14 },
  };
  assert.equal(recommendDiagonalStrikes(base).summary.warnings.length, 1);
  const withList = recommendDiagonalStrikes({ ...base, listedExpiries: ['2026-08-18', '2026-08-24', '2026-09-29'] });
  assert.equal(withList.summary.warnings.length, 0);
});
