import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBsGreeks,
  scoreShortCall,
  calculateRequiredShortLots,
  calculatePortfolioGreeks,
  recommendDiagonalStrikes,
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
