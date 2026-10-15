import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComposite,
  currentSessionTicks,
  defaultComponents,
  influenceShares,
  toCandles,
  toLineCloses,
} from './indexComposite.ts';

const day = Date.UTC(2026, 9, 15) / 1000;
const at = (h: number, m: number, s = 0) => day + h * 3600 + m * 60 + s;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('sum mode is Σ w·price and forward-fills a symbol missing from a tick', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '2026-10-15T09:20:00',
    ticks: [
      { t: '09:15:00', NIFTY: 100, BANKNIFTY: 200 },
      { t: '09:15:20', NIFTY: 110 },
    ],
  }, [{ symbol: 'NIFTY', weight: 2 }, { symbol: 'BANKNIFTY', weight: -1 }], 'sum');
  assert.deepEqual(r.points, [
    { time: at(9, 15), value: 0 },
    { time: at(9, 15, 20), value: 20 },
  ]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.overlays, {});
});

test('equal mode opens at the NIFTY base and moves by the weighted-average % move', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [
      { t: '09:15:00', NIFTY: 25000, B: 50000 },
      { t: '09:16:00', NIFTY: 25500, B: 49000 },   // +2% and −2%
      { t: '09:17:00', NIFTY: 25500, B: 51000 },   // +2% and +2%
    ],
  }, [{ symbol: 'NIFTY', weight: 1 }, { symbol: 'B', weight: 1 }], 'equal');
  assert.equal(r.scale, 25000);
  assert.equal(r.points[0].value, 25000);
  assert.ok(close(r.points[1].value, 25000));
  assert.ok(close(r.points[2].value, 25500));
  // Overlays are S × P/B: every index starts at S, so they share the composite's axis.
  assert.deepEqual(r.overlays.B.map(p => p.value), [25000, 24500, 25500]);
  assert.deepEqual(r.overlays.NIFTY.map(p => p.value), [25000, 25500, 25500]);
});

test('equal mode without NIFTY uses base 100', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [{ t: '09:15:00', A: 830, B: 69000 }, { t: '09:16:00', A: 913, B: 69000 }],   // +10% and 0%
  }, [{ symbol: 'A', weight: 1 }, { symbol: 'B', weight: 1 }, { symbol: 'NIFTY', weight: 1, enabled: false }], 'equal');
  assert.equal(r.scale, 100);
  assert.ok(close(r.points[1].value, 105));
});

test('unticked and zero-weight rows are ignored; never-seen symbols are reported', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [{ t: '09:15:00', A: 1 }, { t: '09:15:20', A: 2, B: 3 }],
  }, [{ symbol: 'A', weight: 1 }, { symbol: 'B', weight: 1 }, { symbol: 'C', weight: 0 }, { symbol: 'D', weight: 1, enabled: false }], 'sum');
  assert.deepEqual(r.points, [{ time: at(9, 15, 20), value: 5 }]);
  const r2 = buildComposite({ session_date: '2026-10-15', updated_at: '', ticks: [{ t: '09:15:00', A: 1 }] },
    [{ symbol: 'A', weight: 1 }, { symbol: 'Z', weight: 1 }], 'sum');
  assert.deepEqual(r2.missing, ['Z']);
  assert.equal(r2.points.length, 0);
});

test('default set is every index except INDIA VIX at equal influence; shares sum to 100%', () => {
  const comps = defaultComponents(['NIFTY', 'BANKNIFTY', 'INDIA VIX', 'NIFTYIT']);
  assert.deepEqual(comps.map(c => c.symbol), ['NIFTY', 'BANKNIFTY', 'NIFTYIT']);
  assert.ok(comps.every(c => c.weight === 1 && c.enabled));
  const shares = influenceShares([...comps, { symbol: 'X', weight: 2, enabled: false }]);
  assert.ok(Object.values(shares).every(s => close(s, 100 / 3)));
  assert.deepEqual(influenceShares([{ symbol: 'A', weight: 1 }, { symbol: 'B', weight: -3 }]), { A: 25, B: -75 });
});

test('a bridge left running overnight: only the run after the last time wrap is kept, dated by updated_at', () => {
  const s = currentSessionTicks({
    session_date: '2026-10-14', updated_at: '2026-10-15T10:00:00',
    ticks: [{ t: '15:00:00', A: 1 }, { t: '19:00:00', A: 1 }, { t: '07:47:00', A: 9 }, { t: '09:15:00', A: 2 }, { t: '09:16:00', A: 3 }],
  });
  assert.equal(s.date, '2026-10-15');
  assert.deepEqual(s.ticks.map(x => x.tick.t), ['09:15:00', '09:16:00']); // pre-open 07:47 dropped too
});

test('a frozen opening stretch (dead feed) is skipped, so bases are the first live prices', () => {
  const frozen = { NIFTY: 100, B: 50 };
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [
      { t: '09:15:00', ...frozen }, { t: '09:30:00', ...frozen }, { t: '10:00:00', ...frozen },
      { t: '11:40:00', NIFTY: 110, B: 55 }, { t: '11:41:00', NIFTY: 121, B: 55 },
    ],
  }, [{ symbol: 'NIFTY', weight: 1 }, { symbol: 'B', weight: 1 }], 'equal');
  assert.equal(r.staleUntil, '11:40:00');
  assert.equal(r.scale, 110);
  assert.deepEqual(r.bases, { NIFTY: 110, B: 55 });
  assert.ok(close(r.points[1].value, 115.5)); // +10% and 0% → +5% of 110
  // A short unchanged run is just a quiet market: nothing is skipped.
  const quiet = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [{ t: '09:15:00', A: 1 }, { t: '09:15:20', A: 1 }, { t: '09:15:40', A: 2 }],
  }, [{ symbol: 'A', weight: 1 }], 'sum');
  assert.equal(quiet.staleUntil, undefined);
  assert.equal(quiet.points.length, 3);
});

test('candles and overlay closes align to the 09:15 open', () => {
  const pts = [
    { time: at(9, 15, 10), value: 5 },
    { time: at(9, 16, 0), value: 8 },
    { time: at(9, 17, 59), value: 3 },
    { time: at(9, 18, 0), value: 4 },
  ];
  assert.deepEqual(toCandles(pts, 180), [
    { time: at(9, 15), open: 5, high: 8, low: 3, close: 3 },
    { time: at(9, 18), open: 4, high: 4, low: 4, close: 4 },
  ]);
  assert.deepEqual(toLineCloses(pts, 180), [
    { time: at(9, 15), value: 3 },
    { time: at(9, 18), value: 4 },
  ]);
});
