import test from 'node:test';
import assert from 'node:assert/strict';
import { bookPnl, fmtFunds, priceOpenRows } from './pnfAccount.ts';

test('bookPnl sums realised and unrealised over every row, scaling MCX rows by the lot multiplier', () => {
  const nse = { tradingSymbol: 'NIFTY-Nov2026-23000-CE', exchangeSegment: 'NSE_FNO', netQty: -65, realizedProfit: 100, unrealizedProfit: 250, lastTradedPrice: 120 };
  // Dhan reports MCX P&L per lot: 1 lot CRUDEOILM (10 bbl) marked 2.05 below entry -> 20.5 rupees, not 2.05
  const mcx = { tradingSymbol: 'CRUDEOILM-Nov2026-9800-CE', exchangeSegment: 'MCX_COMM', netQty: -1, buyQty: 0, sellQty: 1, buyAvg: 0, sellAvg: 175.55,
    realizedProfit: 0, unrealizedProfit: 2.05, lastTradedPrice: 173.5 };
  const b = bookPnl([nse, mcx]);
  assert.equal(b.realised, 100);
  assert.ok(Math.abs(b.unrealised - (250 + 20.5)) < 1e-9);
  assert.ok(Math.abs(b.total - (b.realised + b.unrealised)) < 1e-9);
  assert.equal(b.unpriced, 0);
});

test('an open leg without a price is counted as unpriced (its unrealised P&L is unknown, not zero); a flat one is not', () => {
  const kotakOpen = { tradingSymbol: 'NIFTY25N0423000CE', netQty: -75, realizedProfit: 0, unrealizedProfit: 0, lastTradedPrice: 0 };
  const kotakFlat = { tradingSymbol: 'NIFTY25N0423100CE', netQty: 0, realizedProfit: 500, unrealizedProfit: 0, lastTradedPrice: 0 };
  const b = bookPnl([kotakOpen, kotakFlat]);
  assert.equal(b.unpriced, 1);
  assert.equal(b.realised, 500);
  assert.deepEqual(bookPnl([]), { total: 0, realised: 0, unrealised: 0, unpriced: 0 });
});

test('fmtFunds shows crores, lakhs or rupees', () => {
  assert.equal(fmtFunds(12_500_000), '₹1.25Cr');
  assert.equal(fmtFunds(250_000), '₹2.50L');
  assert.equal(fmtFunds(9_876.4), '₹9,876');
});

test('legPositions: the chart legs only, units to lots, every product summed, matched by id on Dhan and symbol elsewhere', async () => {
  const { legPositions } = await import('./pnfAccount.ts');
  const dhan = [
    { securityId: '111', netQty: -65, realizedProfit: 0, unrealizedProfit: 100, lastTradedPrice: 50 },
    { securityId: '111', netQty: -65, realizedProfit: 0, unrealizedProfit: 20, lastTradedPrice: 50 },
    { securityId: '999', netQty: 65, realizedProfit: 0, unrealizedProfit: 5000, lastTradedPrice: 50 },
  ];
  const d = legPositions(dhan, false, ['111'], [65]);
  assert.deepEqual(d.lots, [-2]);
  assert.equal(d.book.total, 120);
  const kotak = [{ tradingSymbol: 'NIFTY26N2425000CE', netQty: 75, realizedProfit: 0, unrealizedProfit: 0, lastTradedPrice: 10 }];
  assert.deepEqual(legPositions(kotak, true, ['NIFTY26N2425000CE', 'NIFTY26N2425000PE'], [75, 75]).lots, [1, 0]);
});

// Kotak's position book as it came back on 2026-11-04: open legs with no price (lastTradedPrice 0, unrealizedProfit 0).
const kotakBook = () => [
  { tradingSymbol: 'CRUDEOILM19NOV26FUT', netQty: -20, buyQty: 240, sellQty: 260, buyAvg: 9085.291666666666, sellAvg: 9087.923076923076, lastTradedPrice: 0, realizedProfit: 631.5384615384392, unrealizedProfit: 0 },
  { tradingSymbol: 'NIFTY26NOV23750CE', netQty: 0, buyQty: 130, sellQty: 130, buyAvg: 365.45, sellAvg: 387.325, lastTradedPrice: 0, realizedProfit: 2843.75, unrealizedProfit: 0 },
  { tradingSymbol: 'NIFTY26NOV23900CE', netQty: 0, buyQty: 325, sellQty: 325, buyAvg: 340.17, sellAvg: 331.23, lastTradedPrice: 0, realizedProfit: -2905.5, unrealizedProfit: 0 },
  { tradingSymbol: 'NIFTY26NOV24000CE', netQty: -65, buyQty: 520, sellQty: 585, buyAvg: 237.3, sellAvg: 238.85555555555555, lastTradedPrice: 0, realizedProfit: 808.8888888888823, unrealizedProfit: 0 },
];

test('priceOpenRows: an unpriced Kotak book was realised-only (open legs counted as 0); the charts\' prices add their unrealised', () => {
  const before = bookPnl(kotakBook());
  assert.equal(before.unpriced, 2);
  assert.equal(Math.round(before.total), 1379, 'the header showed realised only');
  const prices = new Map([['CRUDEOILM19NOV26FUT', 9060], ['NIFTY26NOV24000CE', 225]]);
  const after = bookPnl(priceOpenRows(kotakBook(), true, prices));
  assert.equal(after.unpriced, 0);
  // short 20 barrels from 9087.92 to 9060 = +558.46; short 65 from 238.86 to 225 = +900.61
  assert.equal(Math.round(after.unrealised), Math.round(20 * (9087.923076923076 - 9060) + 65 * (238.85555555555555 - 225)));
  assert.equal(Math.round(after.total), Math.round(before.realised + after.unrealised));
});

test('priceOpenRows: a leg no chart prices stays unpriced (never 0); a priced or flat row, or a Dhan id book, is left alone', () => {
  const half = bookPnl(priceOpenRows(kotakBook(), true, new Map([['CRUDEOILM19NOV26FUT', 9060]])));
  assert.equal(half.unpriced, 1);
  const priced = [{ tradingSymbol: 'X', securityId: '7', netQty: 10, buyAvg: 100, sellAvg: 0, lastTradedPrice: 105, unrealizedProfit: 50 }];
  assert.deepEqual(priceOpenRows(priced, true, new Map([['X', 200]])), priced, 'the broker\'s own price wins');
  const own = [{ tradingSymbol: 'X', netQty: 10, buyAvg: 100, sellAvg: 0, lastTradedPrice: 0, unrealizedProfit: 2.05 }];
  assert.deepEqual(priceOpenRows(own, true, new Map([['X', 104]])), own, 'a broker unrealised figure is never replaced');
  const book = kotakBook();
  assert.equal(priceOpenRows(book, true, new Map()), book, 'no prices: the same rows back');
});
