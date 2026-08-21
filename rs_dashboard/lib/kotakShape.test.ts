import { test } from 'node:test';
import assert from 'node:assert';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakTrade, shapeKotakFunds } from './kotakShape.ts';

test('shapeKotakOrder maps Kotak Neo fields to the UI order shape with ordEntTm/ordDtTm/exCfmTm timestamps', () => {
  const rawWithOrdEntTm = {
    trdSym: 'NIFTY28AUG24250CE',
    ordSt: 'REJECTED',
    trnsTp: 'S',
    qty: 65,
    prc: 102.35,
    prcTp: 'L',
    ordEntTm: '21-Aug-2026 10:15:22',
  };
  assert.deepStrictEqual(shapeKotakOrder(rawWithOrdEntTm), {
    tradingSymbol: 'NIFTY28AUG24250CE',
    orderStatus: 'REJECTED',
    transactionType: 'SELL',
    quantity: 65,
    price: 102.35,
    orderType: 'LIMIT',
    createTime: '21-Aug-2026 10:15:22',
  });

  const rawWithOrdDtTm = {
    trdSym: 'NIFTY28AUG24250CE',
    ordSt: 'COMPLETE',
    trnsTp: 'B',
    qty: 130,
    prc: 51.8,
    prcTp: 'MKT',
    ordDtTm: '2026-08-21 10:16:00',
  };
  assert.deepStrictEqual(shapeKotakOrder(rawWithOrdDtTm), {
    tradingSymbol: 'NIFTY28AUG24250CE',
    orderStatus: 'COMPLETE',
    transactionType: 'BUY',
    quantity: 130,
    price: 51.8,
    orderType: 'MARKET',
    createTime: '2026-08-21 10:16:00',
  });
});

test('shapeKotakTrade maps Kotak Neo fields to the UI trade shape', () => {
  const rawTrade = {
    trdSym: 'NIFTY28AUG24250CE',
    trnsTp: 'B',
    fldQty: 65,
    avgPrc: 104.3,
    flTm: '10:16:05',
  };
  assert.deepStrictEqual(shapeKotakTrade(rawTrade), {
    tradingSymbol: 'NIFTY28AUG24250CE',
    transactionType: 'BUY',
    tradedQuantity: 65,
    tradedPrice: 104.3,
    createTime: '10:16:05',
  });
});
