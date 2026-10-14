import { test } from 'node:test';
import assert from 'node:assert';
import { applyOp, legPnl, LedgerError, type BsPosition, type LedgerFile } from './bearishLedger.ts';

const base = (over: Partial<BsPosition> = {}): BsPosition => ({
  id: 'a', mode: 'SIM', underlying: 'NIFTY', expiry: '2026-10-20', option: 'CE', strike: 24500, side: 'S',
  lotSize: 65, qty: 65, avgPrice: 100, status: 'OPEN', openedAt: 1, filledAt: 1, realized: 0, ...over,
});
const empty: LedgerFile = { rev: 0, positions: [] };

test('open then duplicate contract is refused', () => {
  const f = applyOp(empty, { op: 'open', position: base() });
  assert.throws(() => applyOp(f, { op: 'open', position: base({ id: 'b' }) }), (e: unknown) => e instanceof LedgerError && e.status === 409);
  // a different mode is a different row
  assert.doesNotThrow(() => applyOp(f, { op: 'open', position: base({ id: 'c', mode: 'REAL', securityId: '1' }) }));
});

test('REAL needs a securityId', () => {
  assert.throws(() => applyOp(empty, { op: 'open', position: base({ mode: 'REAL' }) }));
});

test('add re-averages, reduce books short P&L and never exits more than owned', () => {
  let f = applyOp(empty, { op: 'open', position: base() });
  f = applyOp(f, { op: 'add', id: 'a', qty: 65, price: 80, at: 2 });
  assert.strictEqual(f.positions[0].qty, 130);
  assert.strictEqual(f.positions[0].avgPrice, 90);
  f = applyOp(f, { op: 'reduce', id: 'a', qty: 65, price: 70, at: 3 });
  assert.strictEqual(f.positions[0].realized, 20 * 65);
  f = applyOp(f, { op: 'reduce', id: 'a', qty: 9999, price: 70, at: 4 });
  assert.strictEqual(f.positions[0].status, 'CLOSED');
  assert.strictEqual(f.positions[0].qty, 0);
});

test('clamp is down-only', () => {
  let f = applyOp(empty, { op: 'open', position: base() });
  f = applyOp(f, { op: 'clamp', id: 'a', qty: 500, at: 2 });
  assert.strictEqual(f.positions[0].qty, 65);
  f = applyOp(f, { op: 'clamp', id: 'a', qty: 0, at: 3 });
  assert.strictEqual(f.positions[0].status, 'CLOSED');
});

test('legPnl is null without a live price, never zero', () => {
  assert.strictEqual(legPnl(base(), null), null);
  assert.strictEqual(legPnl(base(), 90), 650);
});

test('only SIM rows can be removed', () => {
  const f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '1' }) });
  assert.throws(() => applyOp(f, { op: 'remove', id: 'a' }));
});

test('awaiting placeholder: qty 0 open is allowed only with a pending order, settle books the fill', () => {
  const pend = { orderId: 'o1', kind: 'entry' as const, side: 'SELL' as const, qty: 65, at: 1 };
  assert.throws(() => applyOp(empty, { op: 'open', position: base({ qty: 0, avgPrice: 0 }) }));
  let f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '9', qty: 0, avgPrice: 0, pendingOrders: [pend] }) });
  f = applyOp(f, { op: 'settle', id: 'a', orderId: 'o1', filledQty: 65, avgPrice: 100, at: 2 });
  assert.strictEqual(f.positions[0].qty, 65);
  assert.strictEqual(f.positions[0].avgPrice, 100);
  assert.strictEqual(f.positions[0].pendingOrders, undefined);
  // settling again is a no-op (idempotent by order id)
  assert.strictEqual(applyOp(f, { op: 'settle', id: 'a', orderId: 'o1', filledQty: 65, avgPrice: 100, at: 3 }).positions[0].qty, 65);
});

test('rejected entry closes the placeholder; settled exit books P&L', () => {
  const pend = { orderId: 'o1', kind: 'entry' as const, side: 'SELL' as const, qty: 65, at: 1 };
  let f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '9', qty: 0, avgPrice: 0, pendingOrders: [pend] }) });
  f = applyOp(f, { op: 'settle', id: 'a', orderId: 'o1', filledQty: 0, avgPrice: 0, at: 2 });
  assert.strictEqual(f.positions[0].status, 'CLOSED');
  assert.strictEqual(f.positions[0].note, 'order did not fill');

  let g = applyOp(empty, { op: 'open', position: base() });
  g = applyOp(g, { op: 'pending', id: 'a', pending: { orderId: 'x1', kind: 'exit', side: 'BUY', qty: 65, at: 5 } });
  g = applyOp(g, { op: 'settle', id: 'a', orderId: 'x1', filledQty: 65, avgPrice: 60, at: 6 });
  assert.strictEqual(g.positions[0].status, 'CLOSED');
  assert.strictEqual(g.positions[0].realized, 40 * 65);
});

test('CRUDEOILM P&L is scaled by 10 barrels per lot (Dhan qty is in lots)', () => {
  const p = base({ underlying: 'CRUDEOILM', lotSize: 1, qty: 10, avgPrice: 42.4 });
  assert.ok(Math.abs((legPnl(p, 42.35) ?? 0) - 0.05 * 10 * 10) < 1e-9);
  const f = applyOp({ rev: 0, positions: [p] }, { op: 'reduce', id: p.id, qty: 10, price: 42.2, at: 2 });
  assert.ok(Math.abs(f.positions[0].realized - 0.2 * 10 * 10) < 1e-9);
});

test('low only ever moves down and ignores closed rows', () => {
  let f = applyOp(empty, { op: 'open', position: base() });
  f = applyOp(f, { op: 'low', id: 'a', low: 80 });
  f = applyOp(f, { op: 'low', id: 'a', low: 90 });
  assert.strictEqual(f.positions[0].low, 80);
  f = applyOp(f, { op: 'low', id: 'a', low: 70 });
  assert.strictEqual(f.positions[0].low, 70);
});
