import test from 'node:test';
import assert from 'node:assert/strict';
import { dayChangeFromRows } from './momentumDayChange.ts';

const rows = [
  { date: '2026-11-18', close: 100 },
  { date: '2026-11-19', close: 110 },
  { date: '2026-11-20', close: 121 },
];

test('measures the latest session against the previous close', () => {
  const r = dayChangeFromRows(rows, { qty: 10, entry_price: 90, entry_date: '2026-11-10' });
  assert.equal(r.day_pnl, 110);
  assert.ok(Math.abs((r.day_pct ?? 0) - 10) < 1e-9);
  assert.equal(r.prev_close, 110);
  assert.equal(r.date, '2026-11-20');
});

test('a position bought on the latest session is measured from its entry price', () => {
  const r = dayChangeFromRows(rows, { qty: 4, entry_price: 118, entry_date: '2026-11-20' });
  assert.equal(r.day_pnl, 12);
  assert.equal(r.prev_close, 118);
});

test('a loss is negative', () => {
  const r = dayChangeFromRows([{ date: 'a', close: 50 }, { date: 'b', close: 45 }], { qty: 100, entry_price: 40 });
  assert.equal(r.day_pnl, -500);
  assert.ok((r.day_pct ?? 0) < 0);
});

test('no rows, or a single row with no entry-date baseline, gives zero and a null percent', () => {
  assert.deepEqual(dayChangeFromRows([], { qty: 1, entry_price: 10 }),
    { day_pnl: 0, day_pct: null, prev_close: null, date: null });
  const one = dayChangeFromRows([{ date: '2026-11-20', close: 10 }], { qty: 1, entry_price: 9, entry_date: '2026-11-01' });
  assert.equal(one.day_pnl, 0);
  assert.equal(one.day_pct, null);
  assert.equal(one.date, '2026-11-20');
});
