import { test } from 'node:test';
import assert from 'node:assert';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from './zerodhaShape.ts';

test('shapeZerodhaPosition maps Kite fields to the UI position shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    instrument_token: 12345,
    quantity: -75,
    buy_quantity: 0,
    sell_quantity: 75,
    buy_price: 0,
    sell_price: 120.5,
    last_price: 110,
    pnl: 787.5,
    realised: 0,
    unrealised: 787.5,
    product: 'MIS',
  };
  assert.deepStrictEqual(shapeZerodhaPosition(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    securityId: '12345',
    exchange: 'NFO',
    netQty: -75,
    buyQty: 0,
    sellQty: 75,
    buyAvg: 0,
    sellAvg: 120.5,
    lastTradedPrice: 110,
    realizedProfit: 0,
    unrealizedProfit: 787.5,
    productType: 'MIS',
  });
});

test('closed intraday position: full pnl is realized, unrealized is 0 (no double count)', () => {
  // Regression: Kite can report realised AND unrealised both equal to the day
  // P&L on a flat position; summing them showed exactly double in the UI.
  const raw = {
    tradingsymbol: 'NIFTY2672124350CE',
    instrument_token: 999,
    quantity: 0,
    buy_quantity: 65,
    sell_quantity: 65,
    buy_price: 23.9,
    sell_price: 29.1,
    last_price: 27.4,
    pnl: 338,
    realised: 338,
    unrealised: 338,
    product: 'MIS',
  };
  const shaped = shapeZerodhaPosition(raw);
  assert.strictEqual(shaped.realizedProfit, 338);
  assert.strictEqual(shaped.unrealizedProfit, 0);
  assert.strictEqual(shaped.realizedProfit + shaped.unrealizedProfit, 338);
});

test('shapeZerodhaOrder maps Kite fields to the UI order shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    status: 'COMPLETE',
    transaction_type: 'SELL',
    quantity: 75,
    price: 0,
    order_type: 'MARKET',
    order_timestamp: '2026-07-19 15:30:00',
  };
  assert.deepStrictEqual(shapeZerodhaOrder(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    orderStatus: 'COMPLETE',
    transactionType: 'SELL',
    quantity: 75,
    price: 0,
    orderType: 'MARKET',
    createTime: '2026-07-19 15:30:00',
  });
});

test('shapeZerodhaTrade maps Kite fields to the UI trade shape', () => {
  const raw = {
    tradingsymbol: 'NIFTY26JUL23900PE',
    transaction_type: 'SELL',
    quantity: 75,
    average_price: 120.5,
    fill_timestamp: '2026-07-19 15:30:01',
  };
  assert.deepStrictEqual(shapeZerodhaTrade(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    transactionType: 'SELL',
    tradedQuantity: 75,
    tradedPrice: 120.5,
    createTime: '2026-07-19 15:30:01',
  });
});
