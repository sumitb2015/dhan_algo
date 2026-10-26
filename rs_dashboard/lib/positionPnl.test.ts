import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleBrokerPnl } from './positionPnl.ts';

// Rows as Dhan returned them on 2026-10-26.
const closedMcx = { tradingSymbol: 'CRUDEOILM-17Nov2026-9700-PE', exchangeSegment: 'MCX_COMM', netQty: 0, buyQty: 3, sellQty: 3, buyAvg: 579.45, sellAvg: 586.6667, realizedProfit: 216.5, unrealizedProfit: 0 };
const openMcx = { tradingSymbol: 'CRUDEOILM-17Nov2026-9000-PE', exchangeSegment: 'MCX_COMM', netQty: -5, buyQty: 0, sellQty: 5, buyAvg: 0, sellAvg: 275.44, realizedProfit: 0, unrealizedProfit: 47.45 };

test('MCX realized P&L is Dhan\'s already-multiplied figure: not multiplied again', () => {
  assert.equal(scaleBrokerPnl(closedMcx).realizedProfit, 216.5);
});

test('MCX unrealized P&L is per lot and is multiplied by the barrels per lot', () => {
  const r = scaleBrokerPnl(openMcx);
  assert.equal(r.unrealizedProfit, 474.5);
  assert.equal(r.realizedProfit, 0);
});

test('a partly closed MCX position books realized on the closed lots only', () => {
  const r = scaleBrokerPnl({ ...openMcx, buyQty: 2, sellQty: 7, buyAvg: 270, sellAvg: 275, realizedProfit: 100 });
  assert.equal(r.realizedProfit, 100);          // 2 lots x 5 pts x 10 bbl
});

test('a row without fills keeps Dhan\'s realized figure unscaled; non-MCX rows are untouched', () => {
  assert.equal(scaleBrokerPnl({ tradingSymbol: 'CRUDEOILM-X', exchangeSegment: 'MCX_COMM', realizedProfit: 50, unrealizedProfit: 1 }).realizedProfit, 50);
  const nse = { tradingSymbol: 'NIFTY-Nov2026-22000-PE', exchangeSegment: 'NSE_FNO', buyQty: 195, sellQty: 195, buyAvg: 163.66667, sellAvg: 114.23809, realizedProfit: -9638.57, unrealizedProfit: 0 };
  assert.equal(scaleBrokerPnl(nse), nse);
});
