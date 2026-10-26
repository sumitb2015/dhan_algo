import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCharges } from './tradeCharges.ts';

const nifty = (side: string, qty: number, price: number, orderId: string) => ({ tradingSymbol: 'NIFTY26OCT22650PE', transactionType: side, tradedQuantity: qty, tradedPrice: price, orderId });

test('Kotak (no brokerage): one NSE option sell is STT + exchange + SEBI + GST on those two', () => {
  const r = computeCharges([nifty('S', 65, 100, 'o1')], 'kotak', false);   // turnover 6500
  assert.equal(r.orders, 1);
  assert.deepEqual(r.breakdown, { brokerage: 0, stt: 6.5, exchange: 3.25, gst: 0.59, stamp: 0, sebi: 0.01 });
  assert.equal(r.total, 10.34);
});

test('Dhan: Rs 20 per ORDER — fills of one order share it, and GST applies to the brokerage too', () => {
  const rows = [nifty('B', 65, 100, 'o1'), nifty('B', 65, 100, 'o1'), nifty('S', 130, 110, 'o2')];
  const r = computeCharges(rows, 'dhan', false);
  assert.equal(r.orders, 2);
  assert.equal(r.breakdown.brokerage, 40);
  assert.ok(r.breakdown.gst > 7.2);                  // 18% of the 40 alone
  assert.equal(r.breakdown.stamp, 0.39);             // 13000 x 0.003%
  assert.equal(r.breakdown.stt, 14.3);               // 14300 x 0.1%
});

test('MCX: Dhan lots become barrels (CRUDEOILM x10); Kotak quantity is already barrels', () => {
  const dhan = { tradingSymbol: 'CRUDEOILM-17Nov2026-10000-CE', transactionType: 'SELL', tradedQuantity: 2, tradedPrice: 400, exchangeSegment: 'MCX_COMM', orderId: 'd1' };
  const kotak = { tradingSymbol: 'CRUDEOILM17NOV2610000CE', transactionType: 'S', tradedQuantity: 20, tradedPrice: 400, orderId: 'k1' };
  const a = computeCharges([dhan], 'kotak', true), b = computeCharges([kotak], 'kotak', false);
  assert.equal(a.total, b.total);                    // both 8000 of turnover
  assert.equal(a.breakdown.stt, 4);                  // CTT 0.05% of 8000
  assert.equal(a.breakdown.exchange, 3.34);          // 0.0418%
});

test('futures use the futures rates; bad rows are skipped', () => {
  const f = computeCharges([{ tradingSymbol: 'CRUDEOILM-19Nov2026-FUT', transactionType: 'SELL', tradedQuantity: 1, tradedPrice: 9600, exchangeSegment: 'MCX_COMM', orderId: 'f1' }], 'kotak', true);
  assert.equal(f.breakdown.stt, 9.6);                // CTT 0.01% of 96000
  assert.equal(computeCharges([{ tradingSymbol: '', tradedQuantity: 1, tradedPrice: 1 }, nifty('S', 0, 5, 'x'), nifty('S', 5, 0, 'y')], 'dhan', false).orders, 0);
});
