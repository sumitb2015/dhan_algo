import test from 'node:test';
import assert from 'node:assert/strict';
import { paperEodReason, paperEodRows } from './pnfPaperEod.ts';
import type { AutoRow } from './pnfAutoLedger.ts';

/** Epoch seconds of an IST wall-clock time. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const row = (over: Partial<AutoRow> = {}): AutoRow => ({
  id: 'r', day: '2026-11-27', chart: 1, target: { kind: 'index', symbol: 'NIFTY', name: 'NIFTY' }, mode: 'PAPER', broker: 'dhan', side: 'BUY',
  lots: 1, unitsPerPoint: 65, legs: [], entryT: ist('2026-11-27T10:00:00'), entryBarT: ist('2026-11-27T10:00:00'), entryPrice: 25600,
  targetKey: 'index|NIFTY|||', state: 'open', ...over,
} as AutoRow);

test('a PAPER row from an earlier day is reset, whatever the time now', () => {
  assert.match(paperEodReason(row(), ist('2026-11-28T09:00:00'))!, /from 2026-11-27/);
  assert.match(paperEodReason(row({ day: '2026-11-25' }), ist('2026-11-27T10:00:00'))!, /never carries/);
});

test('a PAPER row of today stays open during the session and is reset after its market closes', () => {
  const r = row({ day: '2026-11-27' });
  assert.equal(paperEodReason(r, ist('2026-11-27T15:29:00')), null);
  assert.ok(paperEodReason(r, ist('2026-11-27T15:30:00')), 'NSE closes 15:30');
  assert.equal(paperEodReason({ ...r, market: 'NSE_FNO' }, ist('2026-11-27T15:35:00')), null, 'F&O trades to 15:40');
  assert.ok(paperEodReason({ ...r, market: 'NSE_FNO' }, ist('2026-11-27T15:40:00')));
});

test('an MCX PAPER row of today is not reset at the NSE close', () => {
  const r = row({ market: 'MCX', target: { kind: 'futures', symbol: 'CRUDEOILM', name: 'MCX', expiry: '2026-12-17' } as AutoRow['target'] });
  assert.equal(paperEodReason(r, ist('2026-11-27T16:00:00')), null);
  assert.ok(paperEodReason(r, ist('2026-11-27T23:59:00')));
});

test('REAL rows and closed rows are never touched', () => {
  const t = ist('2026-11-28T10:00:00');
  assert.equal(paperEodReason(row({ mode: 'REAL' }), t), null);
  assert.equal(paperEodReason(row({ state: 'closed' }), t), null);
  assert.deepEqual(paperEodRows([row({ id: 'a' }), row({ id: 'b', mode: 'REAL' }), row({ id: 'c', state: 'closed' })], t).map(x => x.row.id), ['a']);
});

test('the reset the engine sends closes a stale PAPER row in the ledger, at P&L 0, and frees the chart', async () => {
  const { applyAutoOp, isLive } = await import('./pnfAutoLedger.ts');
  const led = { rev: 1, rows: [row({ id: 'p1' }), row({ id: 'r1', chart: 2, mode: 'REAL' })], log: [] };
  const nowS = ist('2026-11-28T09:20:00');
  const due = paperEodRows(led.rows, nowS);
  assert.deepEqual(due.map(d => d.row.id), ['p1']);
  const r = applyAutoOp(led, { op: 'close', id: 'p1', exitT: nowS, exitPrice: due[0].row.entryPrice, reason: 'eod', note: due[0].why });
  assert.ok(r.ok);
  if (!r.ok) return;
  const p1 = r.ledger.rows.find(x => x.id === 'p1')!;
  assert.equal(p1.state, 'closed');
  assert.equal(p1.pnl, 0);
  assert.equal(r.ledger.rows.find(x => x.chart === 1 && isLive(x)), undefined, 'chart 1 has no live AUTO row: nothing locks it');
  assert.equal(r.ledger.rows.find(x => x.id === 'r1')!.state, 'open', 'the REAL row is untouched');
});
