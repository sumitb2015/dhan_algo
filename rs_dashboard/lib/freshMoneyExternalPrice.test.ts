import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceExternalClose, type BookFill } from './freshMoneyExternalPrice.ts';
import type { FmOrder } from './freshMoneyTrades.ts';

const T = Date.parse('2026-11-13T15:12:56+05:30');
const base = { underlying: 'NIFTY', expiry: '2026-11-17', strike: 24900, opt: 'PE', securityId: 'NIFTY26N1724900PE', broker: 'kotak',
  priceId: '45383', segment: 'NSE_FNO', lot: 65, mult: 1, correlationId: 'c', reason: undefined } as const;
const own = { ...base, id: 'o1', ts: T, side: 'BUY', qty: 130, close: false, orderId: '559556', state: 'filled', filledQty: 130, avgPrice: 47.8 } as unknown as FmOrder;
const ext = { ...base, id: 'x1', ts: T + 32_000, side: 'SELL', qty: 130, close: true, external: true, orderId: null, state: 'filled', filledQty: 130, avgPrice: null } as unknown as FmOrder;
const fill = (o: Partial<BookFill>): BookFill => ({ orderId: '559923', symbol: 'NIFTY26N1724900PE', side: 'SELL', filledQty: 130, avgPrice: 47.02, ts: T + 23_000, product: 'MIS', ...o });

test('the 2026-11-13 case: the Kotak app SELL 130 @ 47.02 prices the external close', () => {
  const book = [fill({}), fill({ orderId: '559556', side: 'BUY', avgPrice: 47.8, ts: T })];
  assert.deepEqual(priceExternalClose(ext, [own, ext], book, 'MIS'), { avgPrice: 47.02, orderIds: ['559923'] });
});

test('never a guess: ambiguous, wrong size, before the window, own order, other product, unreadable time', () => {
  const p = (book: BookFill[]) => priceExternalClose(ext, [own, ext], book, 'MIS');
  assert.equal(p([fill({}), fill({ orderId: 'b' })]), null, 'two orders of exactly that size');
  assert.equal(p([fill({ filledQty: 65 })]), null, 'does not add up');
  assert.equal(p([fill({ ts: T - 60_000 })]), null, 'before the page\'s last own order');
  assert.equal(p([fill({ orderId: '559556' })]), null, 'an order this ledger sent');
  assert.equal(p([fill({ product: 'NRML' })]), null, 'not intraday');
  assert.equal(p([fill({ ts: null })]), null, 'time unreadable');
  assert.equal(p([fill({ side: 'BUY' })]), null, 'other side');
  assert.equal(priceExternalClose({ ...ext, segment: 'MCX_COMM' } as FmOrder, [own, ext], [fill({})], 'MIS'), null, 'MCX unit differs');
  const used = { ...ext, id: 'x0', avgPrice: 47.02, externalOrderIds: ['559923'] } as FmOrder;
  assert.equal(priceExternalClose(ext, [own, used, ext], [fill({})], 'MIS'), null, 'already used by another record');
});

test('several outside orders that add up exactly are averaged by quantity', () => {
  const r = priceExternalClose(ext, [own, ext], [fill({ orderId: 'a', filledQty: 65, avgPrice: 47 }), fill({ orderId: 'b', filledQty: 65, avgPrice: 48 })], 'MIS');
  assert.deepEqual(r, { avgPrice: 47.5, orderIds: ['a', 'b'] });
});
