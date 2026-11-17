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

test('the 2026-11-17 case: an outside close BETWEEN two of the page\'s own orders is priced (NRML)', () => {
  const D = Date.parse('2026-11-17T11:19:18+05:30');
  const at = (hms: string) => Date.parse(`2026-11-17T${hms}+05:30`);
  const b = { ...base, strike: 25700, securityId: 'NIFTY26N1725700PE', product: 'NRML' } as const;
  let i = 0;
  const o = (hms: string, side: 'BUY' | 'SELL', filled: number, px: number | null, id: string | null, extra: Partial<FmOrder> = {}) =>
    ({ ...b, id: `n${++i}`, ts: at(hms), side, qty: Math.max(filled, 65), close: side === 'SELL', orderId: id,
      state: filled ? 'filled' : 'rejected', filledQty: filled, avgPrice: px, ...extra }) as unknown as FmOrder;
  const orders = [
    o('11:19:18', 'BUY', 65, 245.7, '342573'), o('11:37:01', 'BUY', 65, 258.1, '378083'),
    o('11:58:31', 'BUY', 65, 210.15, '414318'), o('12:06:18', 'BUY', 65, 216.7, '433347'),
    o('12:07:54', 'SELL', 65, 207.35, '436600'), o('12:37:39', 'SELL', 65, 234.15, '484723'),
    o('12:37:56', 'SELL', 0, null, '485326'), o('12:38:37', 'SELL', 65, 230.1, '486978'),
  ];
  const rec = o('12:39:00', 'SELL', 65, null, null, { external: true });
  const sym = 'NIFTY26N1725700PE';
  const book: BookFill[] = [
    { orderId: '484016', symbol: sym, side: 'SELL', filledQty: 0, avgPrice: 0, ts: at('12:37:23'), product: 'NRML' },   // rejected app order
    { orderId: '485701', symbol: sym, side: 'SELL', filledQty: 65, avgPrice: 226.25, ts: at('12:38:05'), product: 'NRML' },
    { orderId: '486978', symbol: sym, side: 'SELL', filledQty: 65, avgPrice: 230.1, ts: at('12:38:37'), product: 'NRML' }, // the page's own
  ];
  assert.ok(D < at('12:39:00'));
  assert.deepEqual(priceExternalClose(rec, [...orders, rec], book, 'NRML'), { avgPrice: 226.25, orderIds: ['485701'] });
  // An app order from BEFORE this position was opened (flat at 10:00) is still never used.
  const early: BookFill = { orderId: 'old', symbol: sym, side: 'SELL', filledQty: 65, avgPrice: 99, ts: at('10:00:00'), product: 'NRML' };
  assert.deepEqual(priceExternalClose(rec, [...orders, rec], [early, ...book], 'NRML'), { avgPrice: 226.25, orderIds: ['485701'] });
  // Two candidates of the close's size inside the window: ambiguous, stays unknown.
  const twin: BookFill = { ...book[1], orderId: 'twin', ts: at('12:20:00') };
  assert.equal(priceExternalClose(rec, [...orders, rec], [...book, twin], 'NRML'), null);
});
