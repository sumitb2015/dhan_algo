import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSample, contributionSummary, niftyBreadth, validSamples } from './indexScalperBreadth.ts';
import { computeContributions, type SeedRow } from './niftyContribution.ts';

const row = (symbol: string, changePct: number, weightPct = 10) =>
  ({ symbol, name: symbol, ltp: 100, prevClose: 100, changePct, weightPct, points: changePct });

test('niftyBreadth counts advances, declines and unchanged; missing apart', () => {
  const b = niftyBreadth({
    rows: [row('A', 1.2, 30), row('B', 0.3, 20), row('C', -0.5, 25), row('D', 0, 15), row('E', 0.001, 10)],
    missing: ['F', 'G'],
  });
  assert.equal(b.advances, 2);
  assert.equal(b.declines, 1);
  assert.equal(b.unchanged, 2);
  assert.equal(b.missing, 2);
  assert.equal(b.ratio, 2);
  assert.equal(b.advPct, 40);
  assert.equal(b.advWeightPct, 50);
  assert.equal(b.decWeightPct, 25);
});

test('niftyBreadth: no decliners gives a null ratio, nothing priced a null share', () => {
  assert.equal(niftyBreadth({ rows: [row('A', 1)], missing: [] }).ratio, null);
  const empty = niftyBreadth(null);
  assert.equal(empty.advPct, null);
  assert.equal(empty.advances + empty.declines + empty.unchanged + empty.missing, 0);
});

test('appendSample keeps a minimum gap and restarts on a new day', () => {
  const day = (t: number) => (t < 1_000_000 ? 'd1' : 'd2');
  let h = appendSample([], { t: 0, adv: 1, dec: 1 }, day);
  h = appendSample(h, { t: 10_000, adv: 2, dec: 1 }, day);
  assert.equal(h.length, 1);
  h = appendSample(h, { t: 30_000, adv: 3, dec: 1 }, day);
  assert.equal(h.length, 2);
  h = appendSample(h, { t: 2_000_000, adv: 4, dec: 1 }, day);
  assert.deepEqual(h, [{ t: 2_000_000, adv: 4, dec: 1 }]);
});

test('validSamples drops junk from storage', () => {
  assert.deepEqual(validSamples('x'), []);
  assert.deepEqual(validSamples([{ t: 1, adv: 2, dec: 3 }, { t: 'a' }, null]), [{ t: 1, adv: 2, dec: 3 }]);
});

test('contributionSummary takes the top n of each side and matches the totals', () => {
  const seed: SeedRow[] = [
    { symbol: 'A', name: 'A', weightPct: 40, refPrice: 100 },
    { symbol: 'B', name: 'B', weightPct: 35, refPrice: 100 },
    { symbol: 'C', name: 'C', weightPct: 25, refPrice: 100 },
  ];
  const r = computeContributions(seed, {
    A: { ltp: 102, prevClose: 100 }, B: { ltp: 99, prevClose: 100 }, C: { ltp: 101, prevClose: 100 },
  }, { prevClose: 1000, ltp: 1007.5, change: 7.5 });
  const s = contributionSummary(r, 1);
  assert.deepEqual(s.pullers.map(x => x.symbol), ['A']);
  assert.deepEqual(s.draggers.map(x => x.symbol), ['B']);
  assert.equal(s.totals.find(t => t.kind === 'net')?.value, r.net);
  assert.equal(s.maxAbs, Math.abs(r.pullers[0].points));
  assert.deepEqual(contributionSummary(null).totals, []);
});
