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
    realised: 0,
    unrealised: 787.5,
    product: 'MIS',
  };
  assert.deepStrictEqual(shapeZerodhaPosition(raw), {
    tradingSymbol: 'NIFTY26JUL23900PE',
    securityId: '12345',
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
