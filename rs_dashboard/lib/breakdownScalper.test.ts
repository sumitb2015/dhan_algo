import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateUnderlyingTrend,
  rankBreakdownSignals,
  evaluatePositionRisk,
  type OptionBreakdownState,
  type UnderlyingTrend,
} from './breakdownScalper.ts';

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

test('evaluatePositionRisk: Initial SL, Lock to cost, Trailing SL ratcheting, Target exit', () => {
  const entry = 100;
  const slPct = 25; // SL at 125
  const trailStartPct = 15; // locks to cost 100 at 15% profit (85)
  const trailStepPts = 5;
  const trailByPts = 2;
  const targetPct = 30; // Target at 70

  // 1. Just entered: LTP = 100, lowest = 100 -> Trailing SL is at initial SL (125)
  const r1 = evaluatePositionRisk(entry, 100, 100, slPct, 15, targetPct, 110, 108, false, undefined, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r1.initialSl, 125);
  assert.equal(r1.trailingSl, 125); // protects with full initial SL until profit threshold is reached
  assert.equal(r1.targetPrice, 70);
  assert.equal(r1.shouldExit, false);

  // 1b. Price drops to 90 (10% profit): still below 15% threshold -> Trailing SL stays at 125
  const r1b = evaluatePositionRisk(entry, 90, 90, slPct, 15, targetPct, 110, 108, false, 125, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r1b.trailingSl, 125);
  assert.equal(r1b.shouldExit, false);

  // 1c. Price drops to 85 (15% profit reached): locks to cost 100!
  const r1c = evaluatePositionRisk(entry, 85, 85, slPct, 15, targetPct, 110, 108, false, 125, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r1c.trailingSl, 100); // locked to cost!
  assert.equal(r1c.shouldExit, false);

  // 2. Price falls to 80 (5 pts gain beyond threshold): steps=1 -> trailing SL ratchets to 100 - (1*2) = 98
  const r2 = evaluatePositionRisk(entry, 80, 80, slPct, 15, targetPct, 105, 102, false, 100, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r2.lowestPrice, 80);
  assert.equal(r2.trailingSl, 98); // 100 - (1 * 2) = 98
  assert.equal(r2.shouldExit, false);

  // 3. Price bounces up to 99: hits trailing SL at 98!
  const r3 = evaluatePositionRisk(entry, 99, 80, slPct, 15, targetPct, 105, 102, false, 98, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r3.isTrailingSlHit, true);
  assert.equal(r3.shouldExit, true);
  assert.match(r3.exitReason ?? '', /TRAILING SL HIT/i);

  // 4. Target hit scenario: price falls to 69 <= 70
  const r4 = evaluatePositionRisk(entry, 69, 69, slPct, 15, targetPct, 95, 90, false, 98, trailStartPct, trailStepPts, trailByPts);
  assert.equal(r4.isTargetHit, true);
  assert.equal(r4.shouldExit, true);
  assert.match(r4.exitReason ?? '', /TARGET HIT/i);
});

test('rankBreakdownSignals: a stale breakdown is not eligible (no re-short after a stop-out)', () => {
  const trend: UnderlyingTrend = {
    spot: 25000, vwap: 24950, ema9: 24980, ema20: 24940, spread: 40,
    trend: 'BULLISH', eligibleSide: 'PE', headline: 'Bullish', detail: '',
  };
  const mk = (barsSinceBreakdown: number): OptionBreakdownState => ({
    indicators: { close: 100, stLine: 120, stDir: -1, vwap: 115, ema: 110, barTime: '2026-10-17 10:00:00', barsUsed: 50 },
    belowSt: true, belowVwap: true, belowEma: true, isBreakdown: true,
    wasBreakdownPrev: barsSinceBreakdown > 1, isFreshBreakdown: barsSinceBreakdown === 1,
    barsSinceBreakdown, pctBelowSt: 16, pctBelowVwap: 13, pctBelowEma: 9, avgPctBelow: 12.7,
  });
  const cand = (strike: number, bars: number) => ({
    strike, option: 'PE' as const, contractKey: `${strike}PE`, ltp: 100, volume: 5000, oi: 20000, state: mk(bars),
  });
  const ranked = rankBreakdownSignals([cand(24900, 2), cand(24850, 6)], 25000, 25000, 50, trend, new Set());
  assert.equal(ranked.find((r) => r.contractKey === '24900PE')?.isEligible, true);
  const stale = ranked.find((r) => r.contractKey === '24850PE');
  assert.equal(stale?.isEligible, false);
  assert.match(stale?.blockReason ?? '', /stale breakdown/i);
});

test('evaluatePositionRisk: a trailing stop seeded at the initial SL does not exit before the initial SL', () => {
  // slPct 25 -> SL 125, trailPct 15. At entry the trailing stop equals the initial stop (125), not 115.
  const r = evaluatePositionRisk(100, 118, 100, 25, 15, 35, null, null, false, 125);
  assert.equal(r.trailingSl, 125);
  assert.equal(r.shouldExit, false);
  const hit = evaluatePositionRisk(100, 126, 100, 25, 15, 35, null, null, false, 125);
  assert.equal(hit.shouldExit, true);
  assert.match(hit.exitReason ?? '', /INITIAL SL/);
});
