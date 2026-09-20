import { test } from 'node:test';
import assert from 'node:assert';
import {
  classify, percentileRanks, quantile, buildPoints, clipRange, topByGoal,
  type OcEntry,
} from './optionScatter3d.ts';

test('classify maps price/OI direction to the four buildup signals', () => {
  assert.strictEqual(classify(5, 10), 'Long buildup');
  assert.strictEqual(classify(-5, 10), 'Short buildup');
  assert.strictEqual(classify(5, -10), 'Short covering');
  assert.strictEqual(classify(-5, -10), 'Long unwinding');
});

test('percentileRanks spans 0..1 and shares rank across ties', () => {
  assert.deepStrictEqual(percentileRanks([10, 20, 30]), [0, 0.5, 1]);
  assert.deepStrictEqual(percentileRanks([5, 5, 9]), [0.25, 0.25, 1]);
  assert.deepStrictEqual(percentileRanks([7]), [0.5]);
});

test('quantile interpolates', () => {
  assert.strictEqual(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(quantile([0, 10], 0.25), 2.5);
});

function side(ltp: number, prev: number, oi: number, prevOi: number, iv: number, delta: number) {
  return { last_price: ltp, previous_close_price: prev, oi, previous_oi: prevOi, implied_volatility: iv, greeks: { delta } };
}

function chain(): Record<string, OcEntry> {
  const oc: Record<string, OcEntry> = {};
  for (let k = 24000; k <= 25000; k += 100) {
    const d = (k - 24500) / 500;
    oc[String(k)] = {
      ce: side(200 - d * 100, 190 - d * 100, 100000, 80000, 14 + Math.abs(d), 0.5 - d * 0.4),
      pe: side(180 + d * 100, 200 + d * 100, 120000, 100000, 15 + Math.abs(d), -(0.5 + d * 0.4)),
    };
  }
  return oc;
}

test('buildPoints drops rows with no base for a % change or below the filters', () => {
  const oc = chain();
  oc['24500'].ce = side(200, 0, 100000, 80000, 15, 0.5);          // no previous close
  oc['24600'].pe = side(1, 1, 100000, 80000, 15, -0.3);           // premium under minLtp
  oc['24700'].ce = side(50, 40, 10, 8, 15, 0.3);                  // OI far below 2% of max
  const pts = buildPoints(oc, { spot: 24500, strikeWindow: 0, minOiPct: 2, minLtp: 2 });
  const keys = new Set(pts.map(p => p.key));
  assert.ok(!keys.has('24500CE'));
  assert.ok(!keys.has('24600PE'));
  assert.ok(!keys.has('24700CE'));
  assert.ok(keys.has('24500PE'));
});

test('strikeWindow keeps only strikes near ATM', () => {
  const pts = buildPoints(chain(), { spot: 24500, strikeWindow: 1, minOiPct: 0, minLtp: 0 });
  assert.deepStrictEqual([...new Set(pts.map(p => p.strike))].sort(), [24400, 24500, 24600]);
});

test('scores are 0-100 and the delta gate nulls out deep ITM buys / ATM-and-deeper sells', () => {
  const pts = buildPoints(chain(), { spot: 24500, strikeWindow: 0, minOiPct: 0, minLtp: 0 });
  for (const p of pts) {
    for (const s of [p.buyScore, p.sellScore]) {
      if (s !== null) assert.ok(s >= 0 && s <= 100);
    }
  }
  const deepItmCe = pts.find(p => p.key === '24000CE')!; // delta 0.9
  assert.strictEqual(deepItmCe.buyScore, null);
  const atmCe = pts.find(p => p.key === '24500CE')!;     // delta 0.5
  assert.strictEqual(atmCe.sellScore, null);
  assert.notStrictEqual(atmCe.buyScore, null);
});

test('ivResidual is positive for a strike richer than its neighbours', () => {
  const oc = chain();
  oc['24500'].ce!.implied_volatility = 30;
  const pts = buildPoints(oc, { spot: 24500, strikeWindow: 0, minOiPct: 0, minLtp: 0 });
  assert.ok(pts.find(p => p.key === '24500CE')!.ivResidual > 10);
});

test('clipRange clamps to the 2-98 percentile band and counts what it cut', () => {
  const vals = [...Array.from({ length: 98 }, (_, i) => i), 5000, -5000];
  const c = clipRange(vals, true);
  assert.ok(c.hi < 200 && c.lo > -200);
  assert.strictEqual(c.clipped, 4);
  assert.deepStrictEqual(clipRange(vals, false), { lo: -5000, hi: 5000, clipped: 0 });
});

test('topByGoal sorts by the goal score and skips gated points', () => {
  const pts = buildPoints(chain(), { spot: 24500, strikeWindow: 0, minOiPct: 0, minLtp: 0 });
  const top = topByGoal(pts, 'buy', 3);
  assert.strictEqual(top.length, 3);
  assert.ok((top[0].buyScore as number) >= (top[1].buyScore as number));
  assert.ok(top.every(p => p.buyScore !== null));
});
