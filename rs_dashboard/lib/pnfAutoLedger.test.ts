import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_LEDGER, applyAutoOp, dayStats, parseLedger, type AutoLedger, type AutoOp } from './pnfAutoLedger.ts';

const fut = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' } as const;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', day: '2026-10-30', chart: 1 as const, target: fut, mode: 'PAPER' as const, broker: 'dhan', side: 'SELL' as const, lots: 1,
  unitsPerPoint: 65, legs: [{ label: 'NIFTY NOV FUT', key: null, units: 65 }], entryT: 1000, entryBarT: 960, entryPrice: 100, ...over,
});
function run(led: AutoLedger, op: AutoOp): AutoLedger {
  const r = applyAutoOp(led, op);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.ledger;
}

test('open, then close books P&L for a short and bumps rev each time', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row() });
  assert.equal(l.rev, 1);
  assert.equal(l.rows[0].state, 'open');
  assert.equal(l.rows[0].targetKey, 'futures|NIFTY|2026-11-24||');
  l = run(l, { op: 'close', id: 'r1', exitT: 2000, exitPrice: 90, reason: 'reversal' });
  assert.equal(l.rev, 2);
  assert.equal(l.rows[0].pnl, 650);                          // (100 - 90) x 65 for a short
});

test('one live row per chart: a second open on the same chart is refused (409), the other chart is fine', () => {
  const l = run(EMPTY_LEDGER, { op: 'open', row: row() });
  const again = applyAutoOp(l, { op: 'open', row: row({ id: 'r2' }) });
  assert.ok(!again.ok && again.status === 409);
  assert.ok(applyAutoOp(l, { op: 'open', row: row({ id: 'r3', chart: 2 }) }).ok);
});

test('REAL is reserved before send: entering blocks the chart, confirmEntry opens it, voidEntry closes it at zero', () => {
  const real = row({ mode: 'REAL', state: 'entering' });
  assert.ok(!applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row({ mode: 'REAL' }) }).ok, 'a REAL row must be opened as entering');
  let l = run(EMPTY_LEDGER, { op: 'open', row: real });
  assert.equal(l.rows[0].state, 'entering');
  assert.ok(!applyAutoOp(l, { op: 'open', row: row({ id: 'r2' }) }).ok, 'the chart is blocked while the order is out');
  l = run(l, { op: 'confirmEntry', id: 'r1', legs: [{ label: 'F', key: '111', units: 65 }] });
  assert.equal(l.rows[0].state, 'open');
  assert.equal(l.rows[0].legs[0].key, '111');
  const v = run(run(EMPTY_LEDGER, { op: 'open', row: real }), { op: 'voidEntry', id: 'r1', t: 5, note: 'rejected' });
  assert.equal(v.rows[0].state, 'closed');
  assert.equal(v.rows[0].pnl, 0);
});

test('REAL exit: beginExit reserves, close books it; a refused exit goes back to open; an unknown one waits for the user', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ mode: 'REAL', state: 'entering' }) });
  l = run(l, { op: 'confirmEntry', id: 'r1', legs: [{ label: 'F', key: '111', units: 65 }] });
  assert.ok(!applyAutoOp(l, { op: 'close', id: 'r1', exitT: 1, exitPrice: 95, reason: 'reversal' }).ok, 'a REAL close needs beginExit first');
  l = run(l, { op: 'beginExit', id: 'r1', t: 1500 });
  assert.ok(!applyAutoOp(l, { op: 'beginExit', id: 'r1', t: 1500 }).ok, 'an exit already on the wire is never started twice');
  const back = run(l, { op: 'abortExit', id: 'r1', note: 'rejected' });
  assert.equal(back.rows[0].state, 'open');
  const unk = run(l, { op: 'markUnknown', id: 'r1', note: 'timeout' });
  assert.equal(unk.rows[0].state, 'unknownExit');
  assert.ok(!applyAutoOp(unk, { op: 'close', id: 'r1', exitT: 1, exitPrice: 95, reason: 'reversal' }).ok);
  const done = run(unk, { op: 'resolve', id: 'r1', as: 'flat', exitPrice: 95, t: 9 });
  assert.equal(done.rows[0].pnl, 325);
  l = run(l, { op: 'close', id: 'r1', exitT: 2, exitPrice: 95, reason: 'reversal' });
  assert.equal(l.rows[0].pnl, 325);
});

test('a stale entering row (the tab died mid-order) is resolved by the user, flat at zero P&L', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ mode: 'REAL', state: 'entering' }) });
  l = run(l, { op: 'resolve', id: 'r1', as: 'flat', t: 9 });
  assert.equal(l.rows[0].state, 'closed');
  assert.equal(l.rows[0].pnl, 0);
  assert.ok(!applyAutoOp(l, { op: 'resolve', id: 'r1', as: 'flat', t: 9 }).ok);
});

test('validation: index targets, bad lots and unknown charts are refused', () => {
  assert.ok(!applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row({ target: { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' } }) }).ok);
  assert.ok(!applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row({ lots: 21 }) }).ok);
  assert.ok(!applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row({ chart: 3 }) }).ok);
});

test('resetPaper drops PAPER rows only; dayStats counts one day and one mode', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row() });
  l = run(l, { op: 'close', id: 'r1', exitT: 2, exitPrice: 110, reason: 'reversal' });
  l = run(l, { op: 'open', row: row({ id: 'r2', chart: 2, mode: 'REAL', state: 'entering' }) });
  assert.deepEqual(dayStats(l, '2026-10-30', 'PAPER')[1], { pnl: -650, trades: 1 });
  assert.deepEqual(dayStats(l, '2026-10-30', 'REAL')[2], { pnl: 0, trades: 1 });
  l = run(l, { op: 'resetPaper' });
  assert.deepEqual(l.rows.map(r => r.id), ['r2']);
  assert.deepEqual(parseLedger('junk'), EMPTY_LEDGER);
});

test('autoDaySummary: booked P&L of closed rows plus open rows marked at the chart price, one day and one mode', async () => {
  const { autoDaySummary } = await import('./pnfAutoLedger.ts');
  let l = run(EMPTY_LEDGER, { op: 'open', row: row() });
  l = run(l, { op: 'close', id: 'r1', exitT: 2, exitPrice: 90, reason: 'reversal' });            // +650
  l = run(l, { op: 'open', row: row({ id: 'r2', side: 'BUY', entryPrice: 50 }) });               // open long, marked below
  l = run(l, { op: 'open', row: row({ id: 'r3', chart: 2, target: { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-11-19' } }) });
  const price = (k: string) => (k.startsWith('futures|NIFTY') ? 52 : null);
  const s = autoDaySummary(l.rows, '2026-10-30', 'PAPER', price);
  assert.equal(s.realised, 650);
  assert.equal(s.unrealised, (52 - 50) * 65);
  assert.equal(s.total, 650 + 130);
  assert.deepEqual([s.open, s.closed, s.wins, s.losses, s.unpriced], [2, 1, 1, 0, 1]);
  assert.equal(autoDaySummary(l.rows, '2026-10-30', 'REAL', price).total, 0);
  assert.equal(autoDaySummary(l.rows, '2026-10-31', 'PAPER', price).closed, 0, 'another day counts nothing');
});

test('autoMarkers: entry on the signal bar, exit on the reversal bar (or the bar before the decision on older rows)', async () => {
  const { autoMarkers } = await import('./pnfAutoLedger.ts');
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ entryBarT: 1920, entryT: 1985 }) });
  l = run(l, { op: 'close', id: 'r1', exitT: 2105, exitPrice: 90, reason: 'reversal', exitBarT: 2040 });
  l = run(l, { op: 'open', row: row({ id: 'r2', entryBarT: 2160, entryT: 2222, side: 'BUY' }) });
  l = run(l, { op: 'close', id: 'r2', exitT: 2290, exitPrice: 95, reason: 'reversal' });           // no exitBarT: older row
  const m = autoMarkers(l.rows, 'futures|NIFTY|2026-11-24||');
  assert.deepEqual(m.map(x => [x.action, x.t]), [['SELL', 1920], ['BUY', 2040], ['BUY', 2160], ['SELL', 2280 - 60]]);
  assert.deepEqual(autoMarkers(l.rows, 'futures|CRUDEOILM|2026-11-19||'), []);
});

test('autoMarkers sit on the confirmed boxes when the row has them (REAL books the live price, the marker stays on the box)', async () => {
  const { autoMarkers } = await import('./pnfAutoLedger.ts');
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ entryPrice: 100.4, entryBox: 100 }) });
  l = run(l, { op: 'close', id: 'r1', exitT: 2105, exitPrice: 103.2, exitBox: 103, reason: 'reversal', exitBarT: 2040 });
  assert.deepEqual(autoMarkers(l.rows, 'futures|NIFTY|2026-11-24||').map(m => m.price), [100, 103]);
  assert.equal(l.rows[0].exitBox, 103);
});

test('a stop must sit on the losing side of the entry: a short needs it above, a long below', () => {
  const bad = (over: Record<string, unknown>) => { const r = applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row(over) }); return !r.ok && r.status === 400; };
  assert.ok(bad({ side: 'SELL', stop: 95 }));
  assert.ok(bad({ side: 'BUY', stop: 105 }));
  assert.ok(bad({ side: 'BUY', stop: Number.NaN }));
  const l = run(EMPTY_LEDGER, { op: 'open', row: row({ side: 'BUY', stop: 90 }) });
  assert.equal(l.rows[0].stop, 90);
});

test('an AUTO row keeps its market; an unknown market is refused', () => {
  const l = run(EMPTY_LEDGER, { op: 'open', row: row({ market: 'MCX' }) });
  assert.equal(l.rows[0].market, 'MCX');
  assert.ok(!applyAutoOp(EMPTY_LEDGER, { op: 'open', row: row({ market: 'LSE' }) } as AutoOp).ok);
  assert.equal(run(EMPTY_LEDGER, { op: 'open', row: row() }).rows[0].market, undefined, 'older clients send none');
});

test('REAL fills: the broker\'s average replaces the decision price, P&L is recomputed, a second fill is ignored, PAPER and bad prices are refused', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ mode: 'REAL', state: 'entering', side: 'BUY', entryPrice: 100, unitsPerPoint: 65 }) });
  l = run(l, { op: 'confirmEntry', id: 'r1', legs: [{ label: 'NIFTY NOV FUT', key: 'k', units: 65 }], orderIds: ['O1', '', 7 as unknown as string] });
  assert.deepEqual(l.rows[0].entryOrderIds, ['O1'], 'only real, non-empty ids are kept');
  assert.ok(!applyAutoOp(l, { op: 'fillPrice', id: 'r1', which: 'exit', price: 99 }).ok, 'no exit fill while the row is open');
  l = run(l, { op: 'fillPrice', id: 'r1', which: 'entry', price: 100.4 });          // bought a little worse than the 100 it decided on
  assert.deepEqual([l.rows[0].entryPrice, l.rows[0].entryDecision, l.rows[0].entryFilled], [100.4, 100, true]);
  l = run(l, { op: 'beginExit', id: 'r1', t: 2000 });
  l = run(l, { op: 'close', id: 'r1', exitT: 3000, exitPrice: 110, reason: 'reversal', orderIds: ['O2'] });
  assert.equal(l.rows[0].pnl, (110 - 100.4) * 65, 'the close books against the FILLED entry');
  assert.deepEqual(l.rows[0].exitOrderIds, ['O2']);
  l = run(l, { op: 'fillPrice', id: 'r1', which: 'exit', price: 109.7 });           // sold a little worse than the 110
  assert.deepEqual([l.rows[0].exitPrice, l.rows[0].exitDecision, l.rows[0].exitFilled], [109.7, 110, true]);
  assert.ok(Math.abs(l.rows[0].pnl! - (109.7 - 100.4) * 65) < 1e-9);
  const rev = l.rev;
  const again = run(l, { op: 'fillPrice', id: 'r1', which: 'exit', price: 50 });
  assert.equal(again.rows[0].exitPrice, 109.7, 'a price already filled stays');
  assert.equal(again.rev, rev, 'and nothing is written');
  assert.ok(!applyAutoOp(l, { op: 'fillPrice', id: 'r1', which: 'entry', price: 0 }).ok);
  assert.ok(!applyAutoOp(l, { op: 'fillPrice', id: 'nope', which: 'entry', price: 1 }).ok);
  const paper = run(EMPTY_LEDGER, { op: 'open', row: row({ id: 'p1' }) });
  assert.ok(!applyAutoOp(paper, { op: 'fillPrice', id: 'p1', which: 'entry', price: 99 }).ok, 'PAPER has no broker fills');
});

test('a late entry fill re-prices an already closed row\'s P&L', () => {
  let l = run(EMPTY_LEDGER, { op: 'open', row: row({ mode: 'REAL', state: 'entering', side: 'SELL', entryPrice: 100, unitsPerPoint: 10 }) });
  l = run(l, { op: 'confirmEntry', id: 'r1', legs: [{ label: 'x', key: 'k', units: 10 }], orderIds: ['O1'] });
  l = run(l, { op: 'beginExit', id: 'r1', t: 2 });
  l = run(l, { op: 'close', id: 'r1', exitT: 3, exitPrice: 95, reason: 'reversal' });
  assert.equal(l.rows[0].pnl, 50);
  l = run(l, { op: 'fillPrice', id: 'r1', which: 'entry', price: 99 });              // the short really sold at 99
  assert.equal(l.rows[0].pnl, 40);
});
