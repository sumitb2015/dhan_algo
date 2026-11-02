import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPosition, realPosition } from './pnfLadderPosition.ts';
import { bookPnl } from './pnfAccount.ts';

test('paper: a short straddle is SHORT with the combined entry premium and a live P&L', () => {
  const p = paperPosition([{ lots: -2, avg: 100, realised: 0 }, { lots: -2, avg: 90, realised: 0 }], [95, 85], [65, 65]);
  assert.equal(p?.side, 'SHORT'); assert.equal(p?.avg, 190); assert.equal(p?.lots, 2);
  assert.equal(p?.pnl, ((95 - 100) * -2 + (85 - 90) * -2) * 65);
});

test('paper: flat has no position, one leg open is MIXED with no entry, a missing price makes P&L unknown', () => {
  assert.equal(paperPosition([{ lots: 0, avg: 0, realised: 500 }], [100], [65]), null);
  assert.deepEqual(paperPosition([{ lots: 1, avg: 100, realised: 0 }, { lots: 0, avg: 0, realised: 0 }], [100, 90], [65, 65])?.side, 'MIXED');
  assert.equal(paperPosition([{ lots: 1, avg: 100, realised: 0 }], [null], [65])?.pnl, null);
});

test('real: entry is the broker buy / sell average of the side the leg is open on; unpriced legs hide the P&L', () => {
  const rows = [
    { securityId: '1', netQty: -130, sellAvg: 100, buyAvg: 0, realizedProfit: 0, unrealizedProfit: 300, lastTradedPrice: 98 },
    { securityId: '2', netQty: -130, sellAvg: 90, buyAvg: 0, realizedProfit: 0, unrealizedProfit: 200, lastTradedPrice: 88 },
  ];
  const p = realPosition(rows, false, ['1', '2'], [-2, -2], bookPnl(rows));
  assert.deepEqual(p, { side: 'SHORT', lots: 2, avg: 190, pnl: 500 });
  const un = [{ ...rows[0], lastTradedPrice: 0 }, rows[1]];
  assert.equal(realPosition(un, false, ['1', '2'], [-2, -2], bookPnl(un))?.pnl, null);
});

test('real on Kotak (no live price in the book): the open legs are valued at the chart price against the broker average', () => {
  // SHORT 1 lot (65 units) of a single option sold at 42.60, realised -150 earlier today; the chart shows 42.05
  const rows = [{ tradingSymbol: 'NIFTY26N0322900PE', netQty: -65, sellAvg: 42.6, buyAvg: 0, realizedProfit: -150, unrealizedProfit: 0, lastTradedPrice: 0 }];
  const p = realPosition(rows, true, ['NIFTY26N0322900PE'], [-1], bookPnl(rows), { prices: [42.05], unitsPerLot: [65] });
  assert.equal(p?.avg, 42.6);
  assert.equal(p?.pnl, Math.round((-150 + -1 * 65 * (42.05 - 42.6)) * 100) / 100);   // -150 + 35.75
  // no chart price yet: still unknown, never 0
  assert.equal(realPosition(rows, true, ['NIFTY26N0322900PE'], [-1], bookPnl(rows), { prices: [null], unitsPerLot: [65] })?.pnl, null);
  // a broker that prices its rows keeps its own figure
  const priced = [{ ...rows[0], lastTradedPrice: 42.05, unrealizedProfit: 35.75 }];
  assert.equal(realPosition(priced, true, ['NIFTY26N0322900PE'], [-1], bookPnl(priced), { prices: [50], unitsPerLot: [65] })?.pnl, -114.25);
});

test('real straddle on Kotak: both legs are valued from the chart; one leg without a price keeps the P&L unknown', () => {
  const rows = [
    { tradingSymbol: 'CE1', netQty: -65, sellAvg: 100, buyAvg: 0, realizedProfit: 0, lastTradedPrice: 0 },
    { tradingSymbol: 'PE1', netQty: -65, sellAvg: 90, buyAvg: 0, realizedProfit: 0, lastTradedPrice: 0 },
  ];
  const book = bookPnl(rows);
  assert.equal(realPosition(rows, true, ['CE1', 'PE1'], [-1, -1], book, { prices: [98, 88], unitsPerLot: [65, 65] })?.pnl, 260);
  assert.equal(realPosition(rows, true, ['CE1', 'PE1'], [-1, -1], book, { prices: [98, null], unitsPerLot: [65, 65] })?.pnl, null);
});
