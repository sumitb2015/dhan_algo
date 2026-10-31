import test from 'node:test';
import assert from 'node:assert/strict';
import { clockOf, daySummary, newestFirst, orderState, toOrderRow, toPositionRow, toTradeRow } from './pnfBooks.ts';

test('clockOf reads the time out of every broker stamp', () => {
  assert.equal(clockOf('2026-10-30 10:12:01'), '10:12:01');
  assert.equal(clockOf('30-Oct-2026 09:15:07'), '09:15:07');
  assert.equal(clockOf('2026-10-30T9:05:00+05:30'), '09:05:00');
  assert.equal(clockOf(''), '');
});

test('toPositionRow: open side average, MCX P&L rescaled, unpriced open leg has unknown unrealised (not zero)', () => {
  const short = toPositionRow({ tradingSymbol: 'NIFTY-Nov2026-25000-CE', productType: 'INTRADAY', netQty: -65, buyAvg: 0, sellAvg: 120, lastTradedPrice: 110, realizedProfit: 0, unrealizedProfit: 650 });
  assert.equal(short.avg, 120);
  assert.equal(short.unrealised, 650);
  const mcx = toPositionRow({ tradingSymbol: 'CRUDEOILM-Nov2026-9800-CE', exchangeSegment: 'MCX_COMM', netQty: -1, sellQty: 1, buyQty: 0, sellAvg: 175.55, buyAvg: 0, lastTradedPrice: 173.5, realizedProfit: 0, unrealizedProfit: 2.05 });
  assert.ok(Math.abs((mcx.unrealised ?? 0) - 20.5) < 1e-9);
  const kotak = toPositionRow({ tradingSymbol: 'NIFTY26N2425000CE', netQty: -75, sellAvg: 50, lastTradedPrice: 0, unrealizedProfit: 0 });
  assert.equal(kotak.unrealised, null);
  assert.equal(kotak.ltp, null);
});

test('orderState folds every broker vocabulary', () => {
  assert.equal(orderState('TRADED'), 'done');
  assert.equal(orderState('complete'), 'done');
  assert.equal(orderState('REJECTED'), 'rejected');
  assert.equal(orderState('CANCELLED'), 'cancelled');
  assert.equal(orderState('PART_TRADED'), 'open');
  assert.equal(orderState('TRIGGER PENDING'), 'open');
});

test('toOrderRow / toTradeRow read Dhan raw and shaped Kotak / Zerodha rows alike', () => {
  const dhan = toOrderRow({ orderId: '1', createTime: '2026-10-30 10:00:00', tradingSymbol: 'X', transactionType: 'SELL', quantity: 65, filledQty: 65, price: 0, averageTradedPrice: 101.5, orderType: 'MARKET', productType: 'INTRADAY', orderStatus: 'TRADED' });
  assert.equal(dhan.price, null);
  assert.equal(dhan.avg, 101.5);
  assert.equal(dhan.state, 'done');
  const kotak = toOrderRow({ orderId: '2', createTime: '30-Oct-2026 10:01:00', tradingSymbol: 'Y', transactionType: 'BUY', quantity: 75, price: 0, averagePrice: 0, orderType: 'MARKET', orderStatus: 'REJECTED', reason: 'RMS: margin' });
  assert.equal(kotak.filled, null, 'an absent fill is unknown, not 0');
  assert.equal(kotak.reason, 'RMS: margin');
  const t = toTradeRow({ orderId: '1', tradeId: 'T1', createTime: '10:00:02', tradingSymbol: 'X', transactionType: 'SELL', tradedQuantity: 65, tradedPrice: 101.5 });
  assert.deepEqual([t.time, t.side, t.qty, t.price], ['10:00:02', 'SELL', 65, 101.5]);
  assert.deepEqual(newestFirst([{ time: '09:00:00' }, { time: '' }, { time: '10:00:00' }]).map(r => r.time), ['10:00:00', '09:00:00', '']);
});

test('daySummary: P&L, worst symbol first, unpriced legs, order counts and turnover', () => {
  const positions = [
    toPositionRow({ tradingSymbol: 'A', netQty: 0, realizedProfit: 500, unrealizedProfit: 0 }),
    toPositionRow({ tradingSymbol: 'B', netQty: 0, realizedProfit: -800, unrealizedProfit: 0 }),
    toPositionRow({ tradingSymbol: 'C', netQty: -65, sellAvg: 50, lastTradedPrice: 40, realizedProfit: 0, unrealizedProfit: 650 }),
    toPositionRow({ tradingSymbol: 'D', netQty: -75, sellAvg: 50, lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0 }),
  ];
  const orders = ['TRADED', 'TRADED', 'REJECTED', 'PENDING'].map((s, i) => toOrderRow({ orderId: String(i), orderStatus: s, quantity: 1 }));
  const trades = [toTradeRow({ transactionType: 'BUY', tradedQuantity: 10, tradedPrice: 5 }), toTradeRow({ transactionType: 'SELL', tradedQuantity: 10, tradedPrice: 7 })];
  const s = daySummary(positions, orders, trades);
  assert.equal(s.realised, -300);
  assert.equal(s.unrealised, 650);
  assert.equal(s.total, 350);
  assert.equal(s.unpriced, 1);
  assert.equal(s.open, 2);
  assert.deepEqual([s.closed, s.winners, s.losers], [2, 1, 1]);
  assert.equal(s.bySymbol[0].symbol, 'B');
  assert.equal(s.bySymbol.find(r => r.symbol === 'D')?.unrealised, null);
  assert.deepEqual(s.orders, { total: 4, done: 2, open: 1, rejected: 1, cancelled: 0 });
  assert.deepEqual([s.buyValue, s.sellValue, s.trades], [50, 70, 2]);
});

test('rows carry the broker key: Dhan security id, else the trading symbol (what "This chart" filters on)', () => {
  assert.equal(toPositionRow({ securityId: '43211', tradingSymbol: 'NIFTY-Nov2026-25000-CE', netQty: 0 }).key, '43211');
  assert.equal(toPositionRow({ tradingSymbol: 'NIFTY26NOV25000CE', netQty: 0 }).key, 'NIFTY26NOV25000CE');
  assert.equal(toOrderRow({ securityId: '43211', orderId: '1' }).key, '43211');
  assert.equal(toTradeRow({ tradingSymbol: 'X', tradedQuantity: 1 }).key, 'X');
});
