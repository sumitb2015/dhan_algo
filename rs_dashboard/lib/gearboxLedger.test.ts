import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClientOp, emptyLedger, entryBlock, normalizeLedger, reservedUnits, rowPnl, type GbLedger, type GbRow } from './gearboxLedger.ts';
import { targetKey } from './pnfTarget.ts';

const target = { kind: 'options' as const, symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-15', strike: 6000, side: 'CE' as const };
const row = (x: Partial<GbRow> = {}): GbRow => ({
  id: 'r1', mode: 'REAL', broker: 'dhan', underlying: 'CRUDEOILM', dir: 'LONG', leg: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
  target, lots: 1, units: 10, unitsPerLot: 10, entry: 100, entryDecision: 100, entryAt: 1, day: '2026-11-20', status: 'open', ...x,
});
const withRows = (rows: GbRow[], mode: 'SIM' | 'REAL' = 'SIM'): GbLedger => ({ ...emptyLedger(), mode, rows });
const cfg = (l: GbLedger, patch: object) => applyClientOp(l, { op: 'setConfig', patch }, 1);

test('normalizeLedger of junk is the empty ledger', () => {
  assert.deepEqual(normalizeLedger('x'), emptyLedger());
  assert.deepEqual(normalizeLedger(null), emptyLedger());
});

test('lots cap per mode', () => {
  assert.equal(cfg({ ...emptyLedger(), mode: 'REAL' }, { lots: 2 }).ok, false);
  const r = cfg({ ...emptyLedger(), mode: 'REAL' }, { lots: 2 });
  assert.ok(!r.ok && r.status === 400);
  const s = cfg(emptyLedger(), { lots: 11 });
  assert.ok(!s.ok && s.status === 400);
  assert.ok(cfg(emptyLedger(), { lots: 10 }).ok);
});

test('config validation', () => {
  assert.equal(cfg(emptyLedger(), { broker: 'zerodha' }).ok, false);
  const leg = { action: 'BUY', opt: 'CE', offset: 4, expiry: 'nearest' };
  assert.equal(cfg(emptyLedger(), { map: { LONG: leg } }).ok, false);
  assert.ok(cfg(emptyLedger(), { map: { LONG: { ...leg, offset: -3 } } }).ok);
  assert.equal(cfg(emptyLedger(), { slPts: 0 }).ok, false);
  assert.equal(cfg(emptyLedger(), { tgtPts: -5 }).ok, false);
  const ok = cfg(emptyLedger(), { slPts: 10, maxLoss: null });
  assert.ok(ok.ok && ok.ledger.config.slPts === 10 && ok.ledger.config.maxLoss === null);
});

test('underlying / map / broker locked while a live row exists', () => {
  const l = withRows([row({ status: 'open' })]);
  const a = cfg(l, { underlying: 'CRUDEOIL' });
  assert.ok(!a.ok && a.status === 409);
  const b = cfg(l, { map: { SHORT: { action: 'SELL', opt: 'CE', offset: 1, expiry: 'nearest' } } });
  assert.ok(!b.ok && b.status === 409);
  assert.ok(cfg(l, { slPts: 5 }).ok);
});

test('setMode: lowers lots for REAL, refused while live', () => {
  const l = cfg(emptyLedger(), { lots: 5 });
  assert.ok(l.ok);
  const r = applyClientOp(l.ok ? l.ledger : emptyLedger(), { op: 'setMode', mode: 'REAL' }, 2);
  assert.ok(r.ok && r.ledger.mode === 'REAL' && r.ledger.config.lots === 1 && r.ledger.log.length === 1);
  const refused = applyClientOp(withRows([row()]), { op: 'setMode', mode: 'REAL' }, 2);
  assert.ok(!refused.ok && refused.status === 409);
});

test('resolve moves only an unknown row', () => {
  const l = withRows([row({ status: 'unknown' }), row({ id: 'r2', status: 'open' })]);
  const ok = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed', price: 105 }, 5);
  assert.ok(ok.ok && ok.ledger.rows[0].status === 'closed' && ok.ledger.rows[0].exit === 105);
  const no = applyClientOp(l, { op: 'resolve', id: 'r2', as: 'failed' }, 5);
  assert.ok(!no.ok && no.status === 409);
  assert.equal(applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed' }, 5).ok, false);
});

test('rowPnl signs by leg action', () => {
  assert.equal(rowPnl(row(), 110), 100);
  assert.equal(rowPnl(row({ leg: { action: 'SELL', opt: 'CE', offset: 0, expiry: 'nearest' } }), 110), -100);
  assert.equal(rowPnl(row({ status: 'closed', exit: 90 }), 200), -100);
  assert.equal(rowPnl(row(), null), null);
});

test('entryBlock on max loss and max trades', () => {
  const closed = row({ status: 'closed', exit: 90, mode: 'SIM' }); // -100
  const base = withRows([closed]);
  assert.equal(entryBlock(base, '2026-11-20'), null);
  const ml = { ...base, config: { ...base.config, maxLoss: 100 } };
  assert.match(entryBlock(ml, '2026-11-20') ?? '', /max loss/i);
  assert.equal(entryBlock(ml, '2026-11-21'), null);
  const mt = { ...base, config: { ...base.config, maxTrades: 1 } };
  assert.match(entryBlock(mt, '2026-11-20') ?? '', /trades/i);
});

test('reservedUnits sums only live REAL rows of the key', () => {
  const k = targetKey(target);
  const other = { ...target, strike: 6100 };
  const l = withRows([
    row({ id: 'a' }),
    row({ id: 'b', leg: { action: 'SELL', opt: 'CE', offset: 0, expiry: 'nearest' }, units: 4 }),
    row({ id: 'c', status: 'closed' }),
    row({ id: 'd', mode: 'SIM' }),
    row({ id: 'e', target: other }),
    row({ id: 'f', status: 'unknown', units: 20 }),
  ]);
  assert.equal(reservedUnits(l, 'dhan', k, targetKey), 10 - 4 + 20);
  assert.equal(reservedUnits(l, 'kotak', k, targetKey), 0);
});
