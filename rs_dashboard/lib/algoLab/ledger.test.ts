import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptyState, normalizeState } from './ledger.ts';
import { defaultsOf, fieldsOf } from './configSchema.ts';
import { AlgoError, type AlgoPosition, type Side } from './types.ts';

const def = { schema: [], defaults: {} };
const fields = fieldsOf(def);
const defaults = defaultsOf(def);
const base = () => emptyState('s1', defaults);

const position = (id: string, side: Side = 'BUY', extra: Partial<AlgoPosition> = {}): AlgoPosition => ({
  id, strategy: 's1', mode: 'SIM', broker: 'dhan', tag: 'AUTO', underlying: 'NIFTY', expiry: '2026-10-20', side,
  legs: [{ strike: 25000, option: 'CE', side, qty: 65, lotSize: 65, entryPrice: 100 }],
  initialStop: side === 'BUY' ? 80 : 120, stop: side === 'BUY' ? 80 : 120, best: 100, target: null, state: null, entryCols: {},
  status: 'OPEN', openedAt: 1, realized: 0, ...extra,
});

test('open: duplicate open contract is 409, another strategy is refused', () => {
  const f = applyOp(base(), { op: 'open', position: position('a') }, fields, defaults);
  assert.equal(f.rev, 1);
  assert.throws(() => applyOp(f, { op: 'open', position: position('b') }, fields, defaults), (e: AlgoError) => e.status === 409);
  assert.throws(() => applyOp(base(), { op: 'open', position: { ...position('c'), strategy: 'other' } }, fields, defaults), AlgoError);
});

test('open: v1 refuses multi-leg, fractional lots and too many lots', () => {
  const p = position('a');
  assert.throws(() => applyOp(base(), { op: 'open', position: { ...p, legs: [p.legs[0], p.legs[0]] } }, fields, defaults), /one leg/);
  assert.throws(() => applyOp(base(), { op: 'open', position: { ...p, legs: [{ ...p.legs[0], qty: 70 }] } }, fields, defaults), /whole number/);
  assert.throws(() => applyOp(base(), { op: 'open', position: { ...p, legs: [{ ...p.legs[0], qty: 65 * 21 }] } }, fields, defaults), /20 lots/);
  assert.throws(() => applyOp(base(), { op: 'open', position: { ...p, mode: 'REAL', broker: 'zerodha' } }, fields, defaults), /not supported/);
});

test('updateRisk: stops only tighten and best only improves, by side', () => {
  let f = applyOp(base(), { op: 'open', position: position('b', 'BUY') }, fields, defaults);
  f = applyOp(f, { op: 'updateRisk', updates: [{ id: 'b', stop: 70, best: 90 }] }, fields, defaults);
  assert.equal(f.positions[0].stop, 80);
  assert.equal(f.positions[0].best, 100);
  f = applyOp(f, { op: 'updateRisk', updates: [{ id: 'b', stop: 95, best: 120 }] }, fields, defaults);
  assert.equal(f.positions[0].stop, 95);
  assert.equal(f.positions[0].best, 120);

  let s = applyOp(base(), { op: 'open', position: position('s', 'SELL') }, fields, defaults);
  s = applyOp(s, { op: 'updateRisk', updates: [{ id: 's', stop: 130, best: 110 }] }, fields, defaults);
  assert.equal(s.positions[0].stop, 120);
  assert.equal(s.positions[0].best, 100);
});

test('close: realized by side, closing twice is a no-op', () => {
  let f = applyOp(base(), { op: 'open', position: position('s', 'SELL') }, fields, defaults);
  f = applyOp(f, { op: 'close', id: 's', exitPrice: 90, exitKind: 'TARGET', exitReason: '', at: 2 }, fields, defaults);
  assert.equal(f.positions[0].realized, 650);
  assert.equal(applyOp(f, { op: 'close', id: 's', exitPrice: 50, exitKind: 'X', exitReason: '', at: 3 }, fields, defaults), f);
});

test('setConfig: validated, and an engine halt is never refused', () => {
  const on = applyOp(base(), { op: 'setConfig', config: { engineActive: true } }, fields, defaults);
  assert.throws(() => applyOp(on, { op: 'setConfig', config: { lotsPerTrade: 50 } }, fields, defaults), AlgoError);
  const off = applyOp(on, { op: 'setConfig', config: { engineActive: false } }, fields, defaults);
  assert.equal(off.config.engineActive, false);
});

test('normalizeState: garbage in, valid file out', () => {
  const s = normalizeState('s1', fields, defaults, { rev: 'x', mode: 'LIVE', config: { lotsPerTrade: 'many' }, positions: 3 });
  assert.equal(s.rev, 0);
  assert.equal(s.mode, 'SIM');
  assert.equal(s.config.lotsPerTrade, defaults.lotsPerTrade);
  assert.deepEqual(s.positions, []);
});
