import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayPnl, fundsView, holdingPnl, holdingRows, orderCounts, orderRows, positionRows, symbolLabel, timeLabel, toCsv,
} from './indexScalperAccount.ts';

// The shape Dhan's /orders really returns (2026-11-24), identifiers replaced. Its createTime is 09:47:40, while Dhan's own
// Orders tab showed 09:47:15 for this order: the UI time is not in this payload, so the panel shows 09:47:40.
const cancelled = {
  orderId: 'O1', correlationId: 'Z_CHART', orderStatus: 'CANCELLED', transactionType: 'SELL', exchangeSegment: 'NSE_FNO',
  productType: 'MARGIN', orderType: 'LIMIT', tradingSymbol: 'NIFTY-Dec2026-25550-CE', securityId: '47812', quantity: 65,
  price: 180.0, triggerPrice: 0.0, createTime: '2026-11-24 09:47:40', updateTime: '2026-11-24 09:47:40',
  drvExpiryDate: '2026-12-01', drvOptionType: 'CALL', drvStrikePrice: 25550.0, omsErrorDescription: '', averageTradedPrice: 0, filledQty: 0,
};

test('order row carries the contract handle and whether it is an option order', () => {
  const [r] = orderRows([cancelled]);
  assert.equal(r.securityId, '47812');
  assert.equal(r.isOption, true);
  const [f] = orderRows([{ ...cancelled, tradingSymbol: 'CRUDEOILM-18Dec2026-FUT', drvOptionType: 'XX', securityId: '9' }]);
  assert.equal(f.isOption, false);
  // Kotak rows (kotakOrdersAsDhan) have no drv fields when the symbol is unknown: the CE / PE suffix decides.
  const [k] = orderRows([{ orderId: 'K1', tradingSymbol: 'NIFTY2612025550PE', securityId: 'NIFTY2612025550PE', orderStatus: 'PENDING' }]);
  assert.equal(k.isOption, true);
  assert.equal(k.securityId, 'NIFTY2612025550PE');
});

test('order row reads like Dhan\'s panel', () => {
  const [r] = orderRows([cancelled]);
  assert.equal(r.symbol, 'NIFTY 01 DEC 25550 CALL');
  assert.equal(r.exchange, 'NSE');
  assert.equal(r.time, '24 Nov 2026, 09:47:40');
  assert.equal(r.side, 'SELL');
  assert.equal(r.orderType, 'Limit');
  assert.equal(r.product, 'Normal');
  assert.equal(r.qty, 65);
  assert.equal(r.tradedQty, 0);
  assert.equal(r.price, 180);
  assert.equal(r.trigger, null); // 0 trigger is "none", shown as —
  assert.equal(r.status, 'CANCELLED');
  assert.equal(r.cancellable, false);
  assert.deepEqual(orderCounts([r]).map(c => `${c.label} ${c.n}`), ['All 1', 'Cancelled 1']);
});

test('only this page\'s own working orders can be cancelled from the panel; newest first', () => {
  const rows = orderRows([
    { ...cancelled, orderId: 'A', orderStatus: 'PENDING', correlationId: 'isxk1', createTime: '2026-11-25 10:00:00' },
    { ...cancelled, orderId: 'B', orderStatus: 'PENDING', correlationId: 'sgx123', createTime: '2026-11-25 10:01:00' }, // a strategy's
    { ...cancelled, orderId: 'C', orderStatus: 'TRADED', correlationId: 'isxk2', createTime: '2026-11-25 09:59:00' },
  ]);
  assert.deepEqual(rows.map(r => r.id), ['B', 'A', 'C']);
  assert.deepEqual(rows.map(r => r.cancellable), [false, true, false]);
  assert.deepEqual(orderCounts(rows).map(c => `${c.label} ${c.n}`), ['All 3', 'Open 2', 'Executed 1']);
});

test('symbol and time labels: futures, equity, Dhan\'s 0001 placeholder', () => {
  assert.equal(symbolLabel({ tradingSymbol: 'NIFTY-Dec2026-FUT', drvExpiryDate: '2026-12-29' }), 'NIFTY DEC FUT');
  assert.equal(symbolLabel({ tradingSymbol: 'RELIANCE-EQ' }), 'RELIANCE');
  assert.equal(symbolLabel({ tradingSymbol: 'NIFTY-Dec2026-25350-PE', drvExpiryDate: '2026-12-01', drvOptionType: 'PUT', drvStrikePrice: 25350 }), 'NIFTY 01 DEC 25350 PUT');
  assert.equal(timeLabel('0001-01-01 00:00:00'), '');
  // Kotak: symbol without dashes, contract fields from its symbol map; its order-book time format
  assert.equal(symbolLabel({ tradingSymbol: 'NIFTY2612025350PE', drvExpiryDate: '2026-12-01', drvOptionType: 'PUT', drvStrikePrice: 25350 }), 'NIFTY 01 DEC 25350 PUT');
  assert.equal(timeLabel('25-Nov-2026 10:20:05'), '25 Nov 2026, 10:20:05');
  assert.equal(timeLabel('25/11/2026 10:20:05'), '25 Nov 2026, 10:20:05');
});

test('positions: live LTP marks the open part, realized is Dhan\'s, closed rows carry realized only', () => {
  const rows = positionRows([
    { tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: -65, buyQty: 65, sellQty: 130, buyAvg: 200, sellAvg: 230, realizedProfit: 1950, unrealizedProfit: 100 },
    { tradingSymbol: 'NIFTY-Dec2026-25400-CE', securityId: '403', exchangeSegment: 'NSE_FNO', productType: 'MARGIN',
      netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 100, sellAvg: 90, realizedProfit: -650, unrealizedProfit: 0 },
    { tradingSymbol: 'NIFTY-Dec2026-25450-CE', securityId: '404', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyQty: 65, sellQty: 0, buyAvg: 50, sellAvg: 0, realizedProfit: 0, unrealizedProfit: 325 },
  ], new Map([['402', 220]]));
  assert.equal(rows[0].avg, 230);
  assert.equal(rows[0].ltp, 220);
  assert.equal(rows[0].unrealized, 650); // short 65 from 230 marked at 220
  assert.equal(rows[0].pnl, 2600);
  assert.equal(rows[1].pnl, -650);
  assert.equal(rows[1].product, 'Normal');
  assert.equal(rows[2].ltp, null); // no live price: Dhan's own unrealized
  assert.equal(rows[2].pnl, 325);
  assert.deepEqual(dayPnl(rows), { pnl: 2275, unpriced: 0 });
  assert.deepEqual(dayPnl([]), { pnl: 0, unpriced: 0 }); // a book that was read and is empty: a real zero, as Dhan shows
  assert.deepEqual(dayPnl([], false), { pnl: null, unpriced: 0 }); // never read (pending / failed): unknown, not 0
  // an open row with no price at all is counted, so the total is flagged partial
  const unpriced = positionRows([{ tradingSymbol: 'X', securityId: '9', productType: 'INTRADAY', netQty: 65, buyAvg: 10, realizedProfit: 5 }], new Map());
  assert.deepEqual(dayPnl(unpriced), { pnl: 5, unpriced: 1 });
});

test('a position carried from an earlier day is valued from costPrice (Dhan\'s day averages are 0)', () => {
  const [r] = positionRows([{ tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'MARGIN',
    netQty: 65, buyQty: 0, sellQty: 0, buyAvg: 0, sellAvg: 0, costPrice: 150, realizedProfit: 0, unrealizedProfit: 1000 }], new Map([['402', 170]]));
  assert.equal(r.avg, 150);
  assert.equal(r.ltp, 170);
  assert.equal(r.unrealized, 1300);
});

test('holdings P&L from Dhan\'s lastTradedPrice; unknown price is no P&L, not a loss', () => {
  const rows = holdingRows([
    { tradingSymbol: 'NIFTYBEES', securityId: '1', totalQty: 10, avgCostPrice: 280, lastTradedPrice: 278.774 },
    { tradingSymbol: 'X', securityId: '2', totalQty: 5, avgCostPrice: 100, lastTradedPrice: 0 },
  ]);
  assert.equal(rows[0].pnl?.toFixed(2), '-12.26');
  assert.equal(rows[1].pnl, null);
  assert.equal(holdingPnl(rows)?.toFixed(2), '-12.26');
  assert.equal(holdingPnl([]), 0); // an empty demat that was read
  assert.equal(holdingPnl([], false), null); // never read
});

test('funds read Dhan\'s misspelt availabelBalance', () => {
  const f = fundsView({ availabelBalance: 4684089.17, utilizedAmount: 0, sodLimit: 1, withdrawableBalance: 2 });
  assert.equal(f.available, 4684089.17);
  assert.equal(f.used, 0);
  assert.equal(f.collateral, null);
});

test('csv quotes commas and quotes', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"'], [1, null]]), 'a,b\n"x,y","say ""hi"""\n1,');
});
