import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOptionBreakdown,
  evaluateUnderlyingTrend,
  rankBreakdownSignals,
  evaluatePositionRisk,
  type OptionBreakdownState,
  type UnderlyingTrend,
} from './breakdownScalper.ts';
import type { Bar } from './volumeProfile.ts';

test('evaluateUnderlyingTrend: Bullish requires Spot > VWAP and EMA9 > EMA20', () => {
  const t = evaluateUnderlyingTrend(25000, 24950, 24980, 24940, 'AUTO');
  assert.equal(t.trend, 'BULLISH');
  assert.equal(t.eligibleSide, 'PE');
});

test('evaluateUnderlyingTrend: Bearish requires Spot < VWAP and EMA9 < EMA20', () => {
  const t = evaluateUnderlyingTrend(24800, 24850, 24820, 24860, 'AUTO');
  assert.equal(t.trend, 'BEARISH');
  assert.equal(t.eligibleSide, 'CE');
});

test('evaluateUnderlyingTrend: Sideways / Unclear blocks new trades in AUTO mode', () => {
  // Spot > VWAP but EMA9 < EMA20 (conflicting alignment)
  const t = evaluateUnderlyingTrend(25000, 24950, 24920, 24940, 'AUTO');
  assert.equal(t.trend, 'SIDEWAYS');
  assert.equal(t.eligibleSide, 'NONE');
});

test('evaluateUnderlyingTrend: BYPASS mode allows BOTH sides', () => {
  const t = evaluateUnderlyingTrend(25000, 24950, 24980, 24940, 'BYPASS');
  assert.equal(t.eligibleSide, 'BOTH');
});

test('rankBreakdownSignals: Ranks fresh breakdown higher and filters by market trend', () => {
  const bullTrend: UnderlyingTrend = {
    spot: 25000,
    vwap: 24950,
    ema9: 24980,
    ema20: 24940,
    spread: 40,
    trend: 'BULLISH',
    eligibleSide: 'PE',
    headline: 'Bullish',
    detail: 'Bullish trend',
  };

  const freshState: OptionBreakdownState = {
    indicators: { close: 100, stLine: 120, stDir: -1, vwap: 115, ema: 110, barTime: '2026-10-17 10:00:00', barsUsed: 50 },
    belowSt: true,
    belowVwap: true,
    belowEma: true,
    isBreakdown: true,
    wasBreakdownPrev: false,
    isFreshBreakdown: true,
    barsSinceBreakdown: 1,
    pctBelowSt: 16.6,
    pctBelowVwap: 13.0,
    pctBelowEma: 9.0,
    avgPctBelow: 12.8,
  };

  const staleState: OptionBreakdownState = {
    indicators: { close: 80, stLine: 130, stDir: -1, vwap: 120, ema: 115, barTime: '2026-10-17 10:00:00', barsUsed: 50 },
    belowSt: true,
    belowVwap: true,
    belowEma: true,
    isBreakdown: true,
    wasBreakdownPrev: true,
    isFreshBreakdown: false,
    barsSinceBreakdown: 8,
    pctBelowSt: 38.4,
    pctBelowVwap: 33.3,
    pctBelowEma: 30.4,
    avgPctBelow: 34.0,
  };

  const candidates = [
    {
      strike: 25000,
      option: 'CE' as const, // In a Bullish market, CE is blocked!
      contractKey: '25000CE',
      ltp: 120,
      volume: 10000,
      oi: 20000,
      state: freshState,
    },
    {
      strike: 24900,
      option: 'PE' as const, // Fresh breakdown PE
      contractKey: '24900PE',
      ltp: 100,
      volume: 12000,
      oi: 25000,
      state: freshState,
    },
    {
      strike: 24800,
      option: 'PE' as const, // Stale breakdown PE
      contractKey: '24800PE',
      ltp: 80,
      volume: 8000,
      oi: 15000,
      state: staleState,
    },
  ];

  const ranked = rankBreakdownSignals(candidates, 25000, 25000, 50, bullTrend, new Set());

  // First candidate should be eligible and PE
  assert.equal(ranked[0].contractKey, '24900PE');
  assert.equal(ranked[0].isEligible, true);

  // CE should NOT be eligible under Bullish trend
  const ceSignal = ranked.find((r) => r.contractKey === '25000CE');
  assert.equal(ceSignal?.isEligible, false);
  assert.match(ceSignal?.blockReason ?? '', /only PE selling/i);

  // Fresh PE should score higher than stale PE
  const stalePeSignal = ranked.find((r) => r.contractKey === '24800PE');
  assert.ok(ranked[0].rankScore > (stalePeSignal?.rankScore ?? 0));
});

test('evaluatePositionRisk: Initial SL, Trailing SL ratcheting, Target exit', () => {
  const entry = 100;
  const slPct = 25; // SL at 125
  const trailPct = 15;
  const targetPct = 30; // Target at 70

  // 1. Just entered: LTP = 100, lowest = 100 -> Trailing SL is at initial SL (125)
  const r1 = evaluatePositionRisk(entry, 100, 100, slPct, trailPct, targetPct, 110, 108);
  assert.equal(r1.initialSl, 125);
  assert.equal(r1.trailingSl, 125); // protects with full initial SL until profit begins
  assert.equal(r1.targetPrice, 70);
  assert.equal(r1.shouldExit, false);

  // 2. Price falls to 80 (favorable for short): lowest drops to 80, trailing SL ratchets down to 92
  const r2 = evaluatePositionRisk(entry, 80, 80, slPct, trailPct, targetPct, 105, 102, false, 125);
  assert.equal(r2.lowestPrice, 80);
  assert.equal(r2.trailingSl, 92); // 80 * 1.15 = 92 (ratcheted down below entry!)
  assert.equal(r2.shouldExit, false);
  assert.equal(r2.lowestPrice, 80);
  assert.equal(r2.trailingSl, 92); // 80 * 1.15 = 92 (ratcheted down below entry!)
  assert.equal(r2.shouldExit, false);

  // 3. Price bounces up to 93: hits trailing SL at 92!
  const r3 = evaluatePositionRisk(entry, 93, 80, slPct, trailPct, targetPct, 105, 102);
  assert.equal(r3.isTrailingSlHit, true);
  assert.equal(r3.shouldExit, true);
  assert.match(r3.exitReason ?? '', /TRAILING SL HIT/i);

  // 4. Target hit scenario: price falls to 69 <= 70
  const r4 = evaluatePositionRisk(entry, 69, 69, slPct, trailPct, targetPct, 95, 90);
  assert.equal(r4.isTargetHit, true);
  assert.equal(r4.shouldExit, true);
  assert.match(r4.exitReason ?? '', /TARGET HIT/i);
});
