import test from 'node:test';
import assert from 'node:assert/strict';
import { bookPnl, fmtFunds } from './pnfAccount.ts';

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
