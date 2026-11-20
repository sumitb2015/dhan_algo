import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClientOp, closeRow, emptyLedger, normalizeLedger, realisedToday, sanitizeConfigPatch, trimRows, type OrbLedger, type OrbRow,
} from './signalOrbLedger.ts';

const target = { kind: 'futures' as const, symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-17' };
const row = (extra: Partial<OrbRow> = {}): OrbRow => ({
  id: 'r1', mode: 'SIM', broker: 'dhan', target, side: 'LONG', lots: 1, units: 0, unitsPerLot: 10, entry: 6000, entryAt: 1, day: '2026-11-19', status: 'open', ...extra,
});
const withRow = (r: OrbRow): OrbLedger => ({ ...emptyLedger(), rows: [r] });

test('config: no lot cap, bounds and time order', () => {
  const cur = emptyLedger().config;
  const big = sanitizeConfigPatch({ lots: 250 }, cur);
  assert.ok(typeof big !== 'string' && big.lots === 250);
  assert.equal(typeof sanitizeConfigPatch({ lots: 0 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ lots: 1.5 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ timeframe: 2 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ entryStart: '23:10' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ entryEnd: '9:00' }, cur), 'string');
  const ok = sanitizeConfigPatch({ stopPts: 25, timeframe: 3, trailStartPts: 20, trailGapPts: 10 }, cur);
  assert.ok(typeof ok !== 'string' && ok.stopPts === 25 && ok.timeframe === 3 && ok.trailStartPts === 20 && ok.trailGapPts === 10);
  assert.equal(typeof sanitizeConfigPatch({ trailStartPts: -5 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ trailGapPts: 0 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ indicators: [{ id: 'a', kind: 'ema', period: 9 }, { id: 'a', kind: 'rsi' }] }, cur), 'string');
});

test('mode switch refused with a live row, and lands paused', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'setMode', mode: 'REAL' }, 1).ok, false);
  const r = applyClientOp({ ...emptyLedger(), engineActive: true }, { op: 'setMode', mode: 'REAL' }, 1);
  assert.ok(r.ok && r.ledger.mode === 'REAL' && r.ledger.engineActive === false);
});

test('REAL engine needs a stop; an UNKNOWN row blocks the engine', () => {
  const l = { ...emptyLedger(), mode: 'REAL' as const, config: { ...emptyLedger().config, stopPts: 0 } };
  assert.equal(applyClientOp(l, { op: 'setEngine', active: true }, 1).ok, false);
  assert.equal(applyClientOp(withRow(row({ status: 'unknown' })), { op: 'setEngine', active: true }, 1).ok, false);
  assert.ok(applyClientOp(emptyLedger(), { op: 'setEngine', active: true }, 1).ok);
});

test('symbol, instrument and strike offset: bounded, defaults keep CRUDEOILM futures ATM', () => {
  const cur = emptyLedger().config;
  assert.equal(cur.symbol, 'CRUDEOILM');
  assert.equal(cur.instrument, 'futures');
  assert.equal(cur.strikeOffset, 0);
  const ok = sanitizeConfigPatch({ symbol: 'CRUDEOIL', instrument: 'options', strikeOffset: -2 }, cur);
  assert.ok(typeof ok !== 'string' && ok.symbol === 'CRUDEOIL' && ok.instrument === 'options' && ok.strikeOffset === -2);
  assert.equal(typeof sanitizeConfigPatch({ symbol: 'NIFTY' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ instrument: 'spread' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ strikeOffset: 11 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ strikeOffset: 0.5 }, cur), 'string');
  // a ledger written before these fields existed reads as the old behaviour
  const old = normalizeLedger({ config: { lots: 1, broker: 'dhan' } });
  assert.equal(old.config.symbol, 'CRUDEOILM');
  assert.equal(old.config.instrument, 'futures');
});

test('symbol, instrument, strike are pinned while a position is open; lots may change', () => {
  for (const patch of [{ symbol: 'CRUDEOIL' }, { instrument: 'options' }, { strikeOffset: 1 }]) {
    assert.equal(applyClientOp(withRow(row()), { op: 'setConfig', patch }, 1).ok, false, JSON.stringify(patch));
    assert.ok(applyClientOp(emptyLedger(), { op: 'setConfig', patch }, 1).ok);
  }
});

test('an options row is booked as a sold option', () => {
  const opt = { kind: 'options' as const, symbol: 'CRUDEOIL', name: 'CRUDEOIL', expiry: '2026-12-14', strike: 5600, side: 'PE' as const };
  const l = closeRow(withRow(row({ target: opt, side: 'LONG', entry: 80, unitsPerLot: 100, lots: 2, signalEntry: 5650 })), 'r1', 65, 'x', 2);
  assert.equal(l.rows[0].pnl, 3000);
});

test('broker is pinned while a position is open', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'setConfig', patch: { broker: 'kotak' } }, 1).ok, false);
  assert.ok(applyClientOp(emptyLedger(), { op: 'setConfig', patch: { broker: 'kotak' } }, 1).ok);
});

test('resolve an UNKNOWN row: open, failed or closed at a price', () => {
  const l = withRow(row({ status: 'unknown', mode: 'REAL' }));
  const a = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'open' }, 1);
  assert.ok(a.ok && a.ledger.rows[0].status === 'open');
  const c = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed', price: 6020 }, 1);
  assert.ok(c.ok && c.ledger.rows[0].status === 'closed' && c.ledger.rows[0].pnl === 200);
  assert.equal(applyClientOp(withRow(row({ status: 'sending' })), { op: 'resolve', id: 'r1', as: 'failed' }, 1).ok, false);
});

test('closeRow P&L and realised P&L by mode and day', () => {
  let l = withRow(row({ side: 'SHORT' }));
  l = closeRow(l, 'r1', 5990, 'x', 2);
  assert.equal(l.rows[0].pnl, 100);
  l = { ...l, rows: [...l.rows, { ...row({ id: 'r2', mode: 'REAL' }), status: 'closed', pnl: -500 }, { ...row({ id: 'r3', day: '2026-11-18' }), status: 'closed', pnl: -900 }] };
  assert.equal(realisedToday(l, 'SIM', '2026-11-19'), 100);
  assert.equal(realisedToday(l, 'REAL', '2026-11-19'), -500);
});

test('trimRows never drops a live row; normalizeLedger survives junk', () => {
  const rows = Array.from({ length: 205 }, (_, i) => row({ id: `r${i}`, status: i === 0 ? 'open' : 'closed' }));
  const t = trimRows(rows);
  assert.equal(t.length, 200);
  assert.equal(t[0].id, 'r0');
  const n = normalizeLedger({ mode: 'X', config: 'junk', rows: 'no' });
  assert.equal(n.mode, 'SIM');
  assert.deepEqual(n.rows, []);
  assert.equal(n.config.indicators.length, 2);
});

test('resetSim refuses with a SIM position open', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'resetSim' }, 1).ok, false);
  const r = applyClientOp(withRow(row({ status: 'closed' })), { op: 'resetSim' }, 1);
  assert.ok(r.ok && r.ledger.rows.length === 0);
});

test('a row stuck in flight past STUCK_MS can be resolved; a fresh one cannot', () => {
  const l = withRow(row({ status: 'sending', mode: 'REAL', entryAt: 1_000, sentAt: 1_000 }));
  assert.equal(applyClientOp(l, { op: 'resolve', id: 'r1', as: 'failed' }, 2_000).ok, false);
  const r = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'failed' }, 1_000 + 91_000);
  assert.ok(r.ok && r.ledger.rows[0].status === 'failed');
  assert.equal(applyClientOp(l, { op: 'setEngine', active: true }, 1_000 + 91_000).ok, false);
});
