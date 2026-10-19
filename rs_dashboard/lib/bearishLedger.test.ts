import { test } from 'node:test';
import assert from 'node:assert';
import { applyOp, legPnl, validateOp, LedgerError, type BsPosition, type LedgerFile } from './bearishLedger.ts';

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

import { applyOp as applyOpK, contractKey as contractKeyK, legPnl as legPnlK, pnlMultiplier as pnlMultiplierK } from './bearishLedger.ts';

test('Kotak rows: keyed apart from Dhan, need a trading symbol, and MCX P&L is not scaled (qty is already barrels)', () => {
  const base = { id: 'k1', mode: 'REAL' as const, underlying: 'CRUDEOILM', expiry: '2026-11-17', option: 'CE' as const, strike: 8500, side: 'S' as const,
    lotSize: 10, qty: 10, avgPrice: 100, status: 'OPEN' as const, openedAt: 1, filledAt: 1, realized: 0 };
  assert.notStrictEqual(contractKeyK({ ...base, broker: 'kotak' }), contractKeyK(base));
  assert.strictEqual(pnlMultiplierK('CRUDEOILM', 'kotak'), 1);
  assert.strictEqual(pnlMultiplierK('CRUDEOILM'), 10);
  // 10 barrels short, premium 100 -> 90: Rs 100 on Kotak.
  assert.strictEqual(legPnlK({ ...base, broker: 'kotak', symbol: 'CRUDEOILM17NOV268500CE' }, 90), 100);
  assert.throws(() => applyOpK({ rev: 0, positions: [] }, { op: 'open', position: { ...base, broker: 'kotak' } }), /Kotak trading symbol/);
  const ok = applyOpK({ rev: 0, positions: [] }, { op: 'open', position: { ...base, broker: 'kotak', symbol: 'CRUDEOILM17NOV268500CE' } });
  assert.strictEqual(ok.positions.length, 1);
  // The same contract on Dhan is a different account's position, not a duplicate.
  const both = applyOpK(ok, { op: 'open', position: { ...base, id: 'd1', underlying: 'NIFTY', securityId: '1' } });
  assert.strictEqual(both.positions.length, 2);
});

const is409 = (e: unknown) => e instanceof LedgerError && e.status === 409;
const exitOrder = (orderId: string, qty: number) => ({ orderId, kind: 'exit' as const, side: 'BUY' as const, qty, at: 1 });

test('exit reservations cannot exceed the owned qty (a second tab cannot send a second buy-back)', () => {
  let f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '9', qty: 130 }) });
  f = applyOp(f, { op: 'pending', id: 'a', pending: exitOrder('resv-1', 130) });
  assert.throws(() => applyOp(f, { op: 'pending', id: 'a', pending: exitOrder('resv-2', 65) }), is409);
  // swapping the reservation for the broker id is not double-counted
  f = applyOp(f, { op: 'pending', id: 'a', pending: exitOrder('o1', 130), clearOrderId: 'resv-1' });
  assert.deepStrictEqual(f.positions[0].pendingOrders?.map((o) => o.orderId), ['o1']);
});

test('no order can be recorded on a CLOSED row; a cleared placeholder reservation closes the row', () => {
  const entry = { orderId: 'resv-1', kind: 'entry' as const, side: 'SELL' as const, qty: 65, at: 1 };
  let f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '9', qty: 0, avgPrice: 0, pendingOrders: [entry] }) });
  f = applyOp(f, { op: 'pending', id: 'a', pending: null, clearOrderId: 'resv-1' });   // order never sent
  assert.strictEqual(f.positions[0].status, 'CLOSED');
  assert.strictEqual(f.positions[0].note, 'order not placed');
  assert.throws(() => applyOp(f, { op: 'pending', id: 'a', pending: { ...entry, orderId: 'resv-2' } }), is409);
});

test('an entry that fills on a row closed meanwhile reopens it', () => {
  const entry = { orderId: 'o2', kind: 'entry' as const, side: 'SELL' as const, qty: 65, at: 1 };
  let f = applyOp(empty, { op: 'open', position: base({ mode: 'REAL', securityId: '9', pendingOrders: [entry] }) });
  f = applyOp(f, { op: 'clamp', id: 'a', qty: 0, at: 2 });
  f.positions[0].status = 'CLOSED';                 // e.g. closed by another path while the order was working
  f = applyOp(f, { op: 'settle', id: 'a', orderId: 'o2', filledQty: 65, avgPrice: 90, at: 3 });
  assert.strictEqual(f.positions[0].status, 'OPEN');
  assert.strictEqual(f.positions[0].qty, 65);
});

test('clamp books the vanished qty at the given LTP; without a price it says P&L unknown', () => {
  let f = applyOp(empty, { op: 'open', position: base() });
  f = applyOp(f, { op: 'clamp', id: 'a', qty: 0, at: 2, price: 80 });
  assert.strictEqual(f.positions[0].realized, 20 * 65);
  assert.strictEqual(f.positions[0].exitPrice, 80);
  let g = applyOp(empty, { op: 'open', position: base() });
  g = applyOp(g, { op: 'clamp', id: 'a', qty: 0, at: 2 });
  assert.strictEqual(g.positions[0].realized, 0);
  assert.match(g.positions[0].note ?? '', /unknown/);
});

test('low reset may raise the anchor (trail just switched on)', () => {
  let f = applyOp(empty, { op: 'open', position: base() });
  f = applyOp(f, { op: 'low', id: 'a', low: 60 });
  f = applyOp(f, { op: 'low', id: 'a', low: 100 });
  assert.strictEqual(f.positions[0].low, 60);
  f = applyOp(f, { op: 'low', id: 'a', low: 100, reset: true });
  assert.strictEqual(f.positions[0].low, 100);
});

test('validateOp refuses non-numeric fields and unknown ops', () => {
  assert.throws(() => validateOp({ op: 'add', id: 'a', qty: '2', price: 1, at: 1 }), (e: unknown) => e instanceof LedgerError && e.status === 400);
  assert.throws(() => validateOp({ op: 'nope' }));
  assert.throws(() => validateOp(null));
  assert.throws(() => validateOp({ op: 'pending', id: 'a', pending: { orderId: 'x', kind: 'exit', side: 'BUY', qty: 0, at: 1 } }));
  assert.doesNotThrow(() => validateOp({ op: 'pending', id: 'a', pending: null, clearOrderId: 'resv-1' }));
  assert.doesNotThrow(() => validateOp({ op: 'open', position: base() }));
});

test('Zerodha rows: own contract key, MCX counts lots like Dhan, REAL needs a trading symbol', () => {
  const base = { id: 'z1', mode: 'REAL', underlying: 'CRUDEOILM', expiry: '2026-11-17', option: 'CE', strike: 8500, side: 'S', lotSize: 1,
    qty: 2, avgPrice: 100, status: 'OPEN', openedAt: 1, filledAt: 1, realized: 0, broker: 'zerodha' } as const;
  assert.notStrictEqual(contractKeyK(base as never), contractKeyK({ ...base, broker: 'dhan' } as never));
  assert.strictEqual(pnlMultiplierK('CRUDEOILM', 'zerodha'), 10);
  assert.strictEqual(legPnlK({ ...base, symbol: 'CRUDEOILM26NOV8500CE' } as never, 90), 200);   // 2 lots x 10 pts x 10 barrels
  assert.throws(() => applyOpK({ rev: 0, positions: [] }, { op: 'open', position: base as never }), /Zerodha trading symbol/);
  assert.doesNotThrow(() => validateOp({ op: 'open', position: { ...base, symbol: 'CRUDEOILM26NOV8500CE' } }));
});
