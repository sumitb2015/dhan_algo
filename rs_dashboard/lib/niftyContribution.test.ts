import test from 'node:test';
import assert from 'node:assert/strict';
import { computeContributions, parseWeightsCsv, type SeedRow } from './niftyContribution.ts';

// Hand-built 3-stock "index": q = weight / refPrice = 0.5, 0.15, 0.4, so the divisor-free index is
// sum(q * price). prev = 100, today = 100.7 -> a 1000-point index closes at 1007 (+7).
const SEED: SeedRow[] = [
  { symbol: 'A', name: 'Alpha', weightPct: 50, refPrice: 100 },
  { symbol: 'B', name: 'Beta', weightPct: 30, refPrice: 200 },
  { symbol: 'C', name: 'Gamma', weightPct: 20, refPrice: 50 },
];
const NIFTY = { prevClose: 1000, ltp: 1007, change: 7 };

test('contributions reconcile to the index change', () => {
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 50 },
  }, NIFTY);
  const pts = Object.fromEntries(r.rows.map((x) => [x.symbol, x.points]));
  assert.ok(Math.abs(pts.A - 10) < 1e-9);
  assert.ok(Math.abs(pts.B - -3) < 1e-9);
  assert.ok(Math.abs(pts.C) < 1e-9);
  assert.ok(Math.abs(r.net - 7) < 1e-9);
  assert.ok(Math.abs(r.positiveSum - 10) < 1e-9);
  assert.ok(Math.abs(r.negativeSum - -3) < 1e-9);
  assert.ok(r.residual !== null && Math.abs(r.residual) < 1e-9);
  assert.equal(r.residualFlag, false);
  assert.deepEqual(r.missing, []);
});

test('rows are sorted by points, pullers and draggers split on sign', () => {
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 50 },
  }, NIFTY);
  assert.deepEqual(r.rows.map((x) => x.symbol), ['A', 'C', 'B']);
  assert.deepEqual(r.pullers.map((x) => x.symbol), ['A']);
  assert.deepEqual(r.draggers.map((x) => x.symbol), ['B']);
});

test('live weight drifts with price', () => {
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 50 },
  }, NIFTY);
  const a = r.rows.find((x) => x.symbol === 'A')!;
  assert.ok(Math.abs(a.weightPct - (51 / 100.7) * 100) < 1e-9);
  const sum = r.rows.reduce((s, x) => s + x.weightPct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);
});

test('a symbol with no usable prev close is reported missing, never counted as zero', () => {
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 0 },
  }, NIFTY);
  assert.deepEqual(r.missing, ['C']);
  assert.equal(r.rows.some((x) => x.symbol === 'C'), false);
  assert.ok(Math.abs(r.net - 7) < 1e-9);
});

test('a symbol absent from the feed is reported missing', () => {
  const r = computeContributions(SEED, { A: { ltp: 102, prevClose: 100 } }, NIFTY);
  assert.deepEqual(r.missing.sort(), ['B', 'C']);
});

test('a stale seed trips the residual flag', () => {
  // Same stock moves, but the index printed +40: the weights no longer describe the index.
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 50 },
  }, { prevClose: 1000, ltp: 1040, change: 40 });
  assert.ok(r.residual !== null && Math.abs(r.residual - -33) < 1e-9);
  assert.equal(r.residualFlag, true);
});

test('no index quote -> residual is null, not zero', () => {
  const r = computeContributions(SEED, {
    A: { ltp: 102, prevClose: 100 },
    B: { ltp: 198, prevClose: 200 },
    C: { ltp: 50, prevClose: 50 },
  }, null);
  assert.equal(r.residual, null);
  assert.equal(r.residualFlag, false);
  assert.deepEqual(r.rows, []);
});

test('concentration: one heavyweight carrying the move is narrow', () => {
  const seed: SeedRow[] = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, name: `S${i}`, weightPct: 10, refPrice: 100 }));
  const quotes: Record<string, { ltp: number; prevClose: number }> = {};
  seed.forEach((s, i) => { quotes[s.symbol] = { ltp: i === 0 ? 110 : 100.1, prevClose: 100 }; });
  const r = computeContributions(seed, quotes, { prevClose: 1000, ltp: 1010, change: 10 });
  assert.equal(r.concentration, 'narrow');
  const even = computeContributions(seed, Object.fromEntries(seed.map((s) => [s.symbol, { ltp: 101, prevClose: 100 }])), { prevClose: 1000, ltp: 1010, change: 10 });
  assert.equal(even.concentration, 'broad');
});

test('parseWeightsCsv reads the seed file and rejects bad rows', () => {
  const csv = 'symbol,name,weight_pct,ref_price,as_of\nHDFCBANK,HDFC Bank,10.5,1700,2026-10-27\nBAD,Bad,abc,10,2026-10-27\nZERO,Zero,1,0,2026-10-27\n';
  const { rows, asOf } = parseWeightsCsv(csv);
  assert.deepEqual(rows, [{ symbol: 'HDFCBANK', name: 'HDFC Bank', weightPct: 10.5, refPrice: 1700 }]);
  assert.equal(asOf, '2026-10-27');
});
