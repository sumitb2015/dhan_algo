import { test } from 'node:test';
import assert from 'node:assert';
import {
  classify, percentileRanks, quantile, buildPoints, clipRange, topByGoal,
  getMoneyness, computeChainSummary, directionalBias, bearishIntensity, lastSessionDate, describeExpiries,
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

test('getMoneyness: ATM band is half a strike step; CE/PE ITM sides are mirrored', () => {
  assert.strictEqual(getMoneyness(24500, 'CE', 24510, 50), 'ATM');
  assert.strictEqual(getMoneyness(24400, 'CE', 24510, 50), 'ITM');
  assert.strictEqual(getMoneyness(24600, 'CE', 24510, 50), 'OTM');
  assert.strictEqual(getMoneyness(24600, 'PE', 24510, 50), 'ITM');
  assert.strictEqual(getMoneyness(24400, 'PE', 24510, 50), 'OTM');
});

test('computeChainSummary uses the whole chain, not the filtered points', () => {
  const oc = chain();
  // A strike the point filters would drop (tiny OI) must still count toward totals.
  oc['25000'].ce = side(1, 1, 500, 400, 15, 0.1);
  const all = computeChainSummary(oc, 24510)!;
  const filtered = buildPoints(oc, { spot: 24510, strikeWindow: 1, minOiPct: 10, minLtp: 5 });
  assert.ok(filtered.length < 22);                      // the point filters really do cut the chain
  assert.strictEqual(all.atmStrike, 24500);
  assert.strictEqual(all.ceCount, 11);
  assert.strictEqual(all.peCount, 11);
  assert.strictEqual(all.totalPeOi, 11 * 120000);
  assert.strictEqual(all.totalCeOi, 10 * 100000 + 500);
  assert.strictEqual(all.pcr, Number(((11 * 120000) / (10 * 100000 + 500)).toFixed(2)));
  assert.strictEqual(all.maxPeOiStrike, 24000);         // ties resolve to the first strike seen
});

test('computeChainSummary needs a valid spot', () => {
  assert.strictEqual(computeChainSummary(chain(), 0), null);
});

test('buildPoints tags moneyness using the ATM strike step', () => {
  const pts = buildPoints(chain(), { spot: 24500, strikeWindow: 0, minOiPct: 0, minLtp: 0 });
  assert.strictEqual(pts.find(p => p.key === '24500CE')!.moneyness, 'ATM');
  assert.strictEqual(pts.find(p => p.key === '24300CE')!.moneyness, 'ITM');
  assert.strictEqual(pts.find(p => p.key === '24700CE')!.moneyness, 'OTM');
});

test('directionalBias: writing calls / buying puts are bearish, writing puts / buying calls bullish', () => {
  const pt = (side: 'CE' | 'PE', signal: Parameters<typeof directionalBias>[0]['signal']) =>
    directionalBias({ side, signal, priceChg: -30, oiChg: 60 });
  assert.strictEqual(pt('CE', 'Short buildup').dir, 'bearish');
  assert.strictEqual(pt('PE', 'Short buildup').dir, 'bullish');   // put writing is NOT bearish
  assert.strictEqual(pt('PE', 'Long buildup').dir, 'bearish');
  assert.strictEqual(pt('CE', 'Long buildup').dir, 'bullish');
  assert.strictEqual(pt('CE', 'Long unwinding').dir, 'bearish');
  assert.strictEqual(pt('PE', 'Long unwinding').dir, 'bullish');
  assert.strictEqual(pt('CE', 'Short covering').dir, 'bullish');
  assert.strictEqual(pt('PE', 'Short covering').dir, 'bearish');
});

test('directionalBias: strength grows with the move, weak signals carry half, always 5-100', () => {
  const small = directionalBias({ side: 'CE', signal: 'Short buildup', priceChg: -6, oiChg: 12 });
  const big = directionalBias({ side: 'CE', signal: 'Short buildup', priceChg: -60, oiChg: 120 });
  const weak = directionalBias({ side: 'CE', signal: 'Long unwinding', priceChg: -60, oiChg: -120 });
  assert.ok(small.strength < big.strength);
  assert.strictEqual(big.strength, 100);
  assert.strictEqual(weak.strength, 50);
  assert.strictEqual(directionalBias({ side: 'CE', signal: 'Short buildup', priceChg: 0, oiChg: 0 }).strength, 5);
});

test('bearishIntensity is zero for bullish structures', () => {
  assert.strictEqual(bearishIntensity({ side: 'PE', signal: 'Short buildup', priceChg: -50, oiChg: 100 }), 0);
  assert.ok(bearishIntensity({ side: 'CE', signal: 'Short buildup', priceChg: -50, oiChg: 100 }) > 50);
});

test('lastSessionDate rolls weekends and pre-open back to the prior weekday (IST)', () => {
  // IST = UTC+5:30
  assert.strictEqual(lastSessionDate(new Date('2026-09-22T04:30:00Z')), '2026-09-22'); // Tue 10:00 IST
  assert.strictEqual(lastSessionDate(new Date('2026-09-22T02:30:00Z')), '2026-09-21'); // Tue 08:00 IST, pre-open
  assert.strictEqual(lastSessionDate(new Date('2026-09-21T02:30:00Z')), '2026-09-18'); // Mon 08:00 IST -> Fri
  assert.strictEqual(lastSessionDate(new Date('2026-09-20T09:00:00Z')), '2026-09-18'); // Sun -> Fri
  assert.strictEqual(lastSessionDate(new Date('2026-09-19T09:00:00Z')), '2026-09-18'); // Sat -> Fri
  assert.strictEqual(lastSessionDate(new Date('2026-09-22T03:44:00Z')), '2026-09-21'); // 09:14 IST, still pre-open
  assert.strictEqual(lastSessionDate(new Date('2026-09-22T03:45:00Z')), '2026-09-22'); // 09:15 IST, open
});

test('describeExpiries: DTE, weekday, and Weekly vs Monthly (last expiry listed in its month)', () => {
  const opts = describeExpiries(['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-27', '2026-12-29'], '2026-09-20');
  const by = Object.fromEntries(opts.map(o => [o.value, o]));
  assert.strictEqual(by['2026-09-22'].dte, 2);
  assert.strictEqual(by['2026-09-22'].kind, 'Weekly');     // 09-29 is later in September
  assert.strictEqual(by['2026-09-29'].kind, 'Monthly');
  assert.strictEqual(by['2026-10-06'].kind, 'Weekly');
  assert.strictEqual(by['2026-10-27'].kind, 'Monthly');
  assert.strictEqual(by['2026-12-29'].kind, 'Monthly');    // only one listed that month
  assert.strictEqual(by['2026-09-22'].label, '22 Sep 2026 · Tue · 2d · Weekly');
});

test('describeExpiries: expiry day and month/year rollover', () => {
  const [a] = describeExpiries(['2026-09-22'], '2026-09-22');
  assert.strictEqual(a.dte, 0);
  assert.ok(a.label.includes('expiry day'));
  const [b] = describeExpiries(['2027-01-05'], '2026-12-30');
  assert.strictEqual(b.dte, 6);
});
