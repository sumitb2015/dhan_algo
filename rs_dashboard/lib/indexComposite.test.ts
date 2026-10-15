import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComposite, currentSessionTicks, toCandles } from './indexComposite.ts';

const day = Date.UTC(2026, 9, 15) / 1000;
const at = (h: number, m: number, s = 0) => day + h * 3600 + m * 60 + s;

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
});

test('normalized mode is base-100 weighted performance, independent of price level', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [
      { t: '09:15:00', A: 100, B: 50000 },
      { t: '09:16:00', A: 110, B: 45000 },   // +10% and −10%
    ],
  }, [{ symbol: 'A', weight: 1 }, { symbol: 'B', weight: 1 }], 'normalized');
  assert.equal(r.points[0].value, 100);
  assert.ok(Math.abs(r.points[1].value - 100) < 1e-9);
});

test('ticks before every component has printed are skipped; never-seen symbols are reported', () => {
  const r = buildComposite({
    session_date: '2026-10-15', updated_at: '',
    ticks: [{ t: '09:15:00', A: 1 }, { t: '09:15:20', A: 2, B: 3 }],
  }, [{ symbol: 'A', weight: 1 }, { symbol: 'B', weight: 1 }, { symbol: 'C', weight: 0 }], 'sum');
  assert.deepEqual(r.points, [{ time: at(9, 15, 20), value: 5 }]);
  const r2 = buildComposite({ session_date: '2026-10-15', updated_at: '', ticks: [{ t: '09:15:00', A: 1 }] },
    [{ symbol: 'A', weight: 1 }, { symbol: 'Z', weight: 1 }], 'sum');
  assert.deepEqual(r2.missing, ['Z']);
  assert.equal(r2.points.length, 0);
});

test('a bridge left running overnight: only the run after the last time wrap is kept, dated by updated_at', () => {
  const s = currentSessionTicks({
    session_date: '2026-10-14', updated_at: '2026-10-15T10:00:00',
    ticks: [{ t: '15:00:00', A: 1 }, { t: '19:00:00', A: 1 }, { t: '07:47:00', A: 9 }, { t: '09:15:00', A: 2 }, { t: '09:16:00', A: 3 }],
  });
  assert.equal(s.date, '2026-10-15');
  assert.deepEqual(s.ticks.map(x => x.tick.t), ['09:15:00', '09:16:00']); // pre-open 07:47 dropped too
});

test('candles align to the 09:15 open and carry OHLC of the bucket', () => {
  const c = toCandles([
    { time: at(9, 15, 10), value: 5 },
    { time: at(9, 16, 0), value: 8 },
    { time: at(9, 17, 59), value: 3 },
    { time: at(9, 18, 0), value: 4 },
  ], 180);
  assert.deepEqual(c, [
    { time: at(9, 15), open: 5, high: 8, low: 3, close: 3 },
    { time: at(9, 18), open: 4, high: 4, low: 4, close: 4 },
  ]);
});
