import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_INDICES,
  indexRows,
  stockRows,
  pickStockQuotes,
  weightedPull,
  feedState,
  sortRows,
  WATCH_STALE_MS,
} from './indexScalperMarketWatch.ts';
import { NIFTY_TOP10_BY_WEIGHT } from './nifty50.ts';

test('index rows: every headline index keeps a row; an unpriced one is null, never 0', () => {
  const rows = indexRows({ NIFTY: { ltp: 25500, prev_close: 25000, high: 25600, low: 24900 } });
  assert.equal(rows.length, WATCH_INDICES.length);
  const nifty = rows.find(r => r.key === 'NIFTY')!;
  assert.equal(nifty.ltp, 25500);
  assert.equal(nifty.change, 500);
  assert.equal(nifty.changePct, 2);
  const bank = rows.find(r => r.key === 'BANKNIFTY')!;
  assert.equal(bank.ltp, null);
  assert.equal(bank.changePct, null);
  assert.equal(indexRows(null).every(r => r.ltp === null), true);
});

test('no genuine previous close: the move is unknown, not flat', () => {
  // live_equity_ws.py writes prev_close 0 when Dhan's close flipped to today's.
  const [r] = stockRows({ HDFCBANK: { ltp: 1700, prev_close: 0 } }, [NIFTY_TOP10_BY_WEIGHT[0]]);
  assert.equal(r.ltp, 1700);
  assert.equal(r.change, null);
  assert.equal(r.changePct, null);
});

test('stock rows follow the top-10 list with weights; a missing symbol is a dash row', () => {
  const rows = stockRows({ RELIANCE: { ltp: 1500, prev_close: 1515 } });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map(r => r.key), NIFTY_TOP10_BY_WEIGHT.map(w => w.symbol));
  const rel = rows.find(r => r.key === 'RELIANCE')!;
  assert.equal(rel.weight, 8);
  assert.ok(Math.abs(rel.changePct! - (-0.990099)) < 1e-5);
  assert.equal(rows.find(r => r.key === 'HDFCBANK')!.ltp, null);
});

test('pickStockQuotes keeps only the top-10 symbols', () => {
  const out = pickStockQuotes({ HDFCBANK: { ltp: 1 }, WIPRO: { ltp: 2 }, ITC: { ltp: 3 } });
  assert.deepEqual(Object.keys(out).sort(), ['HDFCBANK', 'ITC']);
});

test('weighted pull sums weight x change over priced rows only', () => {
  const list = [
    { symbol: 'A', name: 'A', weight: 10 },
    { symbol: 'B', name: 'B', weight: 5 },
    { symbol: 'C', name: 'C', weight: 3 },
  ];
  const rows = stockRows({ A: { ltp: 102, prev_close: 100 }, B: { ltp: 99, prev_close: 100 } }, list);
  const { pct, priced } = weightedPull(rows);
  assert.equal(priced, 2);
  assert.ok(Math.abs(pct! - (0.2 - 0.05)) < 1e-9);
  assert.deepEqual(weightedPull(stockRows({}, list)), { pct: null, priced: 0 });
});

test('feed state: OFF without data, LIVE while fresh, STALE after the threshold', () => {
  const now = Date.parse('2026-11-25T10:00:00+05:30');
  assert.equal(feedState(null, now).state, 'OFF');
  assert.equal(feedState('garbage', now).state, 'OFF');
  assert.equal(feedState('2026-11-25T09:59:58+05:30', now).state, 'LIVE');
  const s = feedState(new Date(now - WATCH_STALE_MS - 1000).toISOString(), now);
  assert.equal(s.state, 'STALE');
  assert.equal(s.ageMs, WATCH_STALE_MS + 1000);
});

test('sorting puts unknown values last in both directions', () => {
  const rows = indexRows({
    NIFTY: { ltp: 101, prev_close: 100 },
    BANKNIFTY: { ltp: 97, prev_close: 100 },
    IT: { ltp: 103, prev_close: 100 },
  });
  const desc = sortRows(rows, 'changePct', 'desc').map(r => r.key);
  assert.deepEqual(desc.slice(0, 3), ['IT', 'NIFTY', 'BANKNIFTY']);
  const asc = sortRows(rows, 'changePct', 'asc').map(r => r.key);
  assert.deepEqual(asc.slice(0, 3), ['BANKNIFTY', 'NIFTY', 'IT']);
  assert.equal(sortRows(rows, 'name', 'asc')[0].name, 'Bank Nifty');
});
