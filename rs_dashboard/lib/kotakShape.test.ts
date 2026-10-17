import { test } from 'node:test';
import assert from 'node:assert';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakOrderStatus, shapeKotakTrade, shapeKotakFunds } from './kotakShape.ts';

test('shapeKotakOrder maps Kotak Neo fields to the UI order shape with ordEntTm/ordDtTm/exCfmTm timestamps', () => {
  const rawWithOrdEntTm = {
    nOrdNo: '240821000123456',
    trdSym: 'NIFTY28AUG24250CE',
    ordSt: 'REJECTED',
    trnsTp: 'S',
    qty: 65,
    prc: 102.35,
    prcTp: 'L',
    ordEntTm: '21-Aug-2026 10:15:22',
  };
  assert.deepStrictEqual(shapeKotakOrder(rawWithOrdEntTm), {
    orderId: '240821000123456',
    tradingSymbol: 'NIFTY28AUG24250CE',
    orderStatus: 'REJECTED',
    transactionType: 'SELL',
    quantity: 65,
    price: 102.35,
    orderType: 'LIMIT',
    createTime: '21-Aug-2026 10:15:22',
    averagePrice: 0,
  });

  const rawWithOrdDtTm = {
    nOrdNo: '240821000123457',
    trdSym: 'NIFTY28AUG24250CE',
    ordSt: 'COMPLETE',
    trnsTp: 'B',
    qty: 130,
    prc: 51.8,
    prcTp: 'MKT',
    ordDtTm: '2026-08-21 10:16:00',
  };
  assert.deepStrictEqual(shapeKotakOrder(rawWithOrdDtTm), {
    orderId: '240821000123457',
    tradingSymbol: 'NIFTY28AUG24250CE',
    orderStatus: 'COMPLETE',
    transactionType: 'BUY',
    quantity: 130,
    price: 51.8,
    orderType: 'MARKET',
    createTime: '2026-08-21 10:16:00',
    averagePrice: 0,
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

test('shapeKotakOrderStatus folds Kotak statuses onto the Dhan vocabulary the confirm loops read', () => {
  const base = { nOrdNo: '77', qty: 65, avgPrc: '101.5', fldQty: 65 };
  assert.deepStrictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'complete' }), {
    orderId: '77', orderStatus: 'TRADED', quantity: 65, filledQty: 65, averageTradedPrice: 101.5, reason: '',
  });
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'rejected', fldQty: 0, rejRsn: 'RMS:Margin' }).orderStatus, 'REJECTED');
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'rejected', fldQty: 0, rejRsn: 'RMS:Margin' }).reason, 'RMS:Margin');
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'cancelled', fldQty: 0 }).orderStatus, 'CANCELLED');
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'open', fldQty: 0 }).orderStatus, 'PENDING');
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'trigger pending', fldQty: 0 }).orderStatus, 'PENDING');
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'open', fldQty: 20 }).orderStatus, 'PART_TRADED');
  // Not on the exchange yet: must read as unsettled, never as filled or dead.
  assert.strictEqual(shapeKotakOrderStatus({ ...base, ordSt: 'put order req received', fldQty: 0 }).orderStatus, 'TRANSIT');
  assert.strictEqual(shapeKotakOrderStatus({ nOrdNo: '9', ordSt: 'complete', qty: 10 }).filledQty, 10);
});

test('shapeKotakOrder reports filledQty only when the row carries fldQty (absent = unknown, not zero)', () => {
  assert.strictEqual('filledQty' in shapeKotakOrder({ nOrdNo: '1', ordSt: 'cancelled', qty: 10 }), false);
  assert.strictEqual(shapeKotakOrder({ nOrdNo: '1', ordSt: 'cancelled', qty: 10, fldQty: '4' }).filledQty, 4);
  assert.strictEqual(shapeKotakOrder({ nOrdNo: '1', ordSt: 'cancelled', qty: 10, fldQty: 0 }).filledQty, 0);
});

test('shapeKotakOrderStatus: a partially filled order reads PART_TRADED', () => {
  assert.strictEqual(shapeKotakOrderStatus({ nOrdNo: '1', ordSt: 'partially filled', qty: 10, fldQty: 4 }).orderStatus, 'PART_TRADED');
});

test('classifyKotakStatus uses exact Neo statuses: CANCEL PENDING is still live, unknown words are unsettled', () => {
  const c = (st: string, f = 0, q = 10) => shapeKotakOrderStatus({ nOrdNo: '1', ordSt: st, qty: q, fldQty: f }).orderStatus;
  assert.strictEqual(c('cancel pending'), 'TRANSIT');
  assert.strictEqual(c('Modify Pending'), 'TRANSIT');
  assert.strictEqual(c('after market order req received'), 'PENDING');
  assert.strictEqual(c('MODIFIED'), 'PENDING');
  assert.strictEqual(c('rej'), 'REJECTED');
  assert.strictEqual(c('can'), 'CANCELLED');
  assert.strictEqual(c('part traded', 4), 'PART_TRADED');
  assert.strictEqual(c('executed'), 'TRADED');
  assert.strictEqual(c('some new word', 0), 'TRANSIT');
  assert.strictEqual(c('some new word', 10), 'TRADED');      // a full fill settles it whatever the word
  assert.strictEqual(c('some new word', 4), 'TRANSIT');      // a partial one does not
  assert.strictEqual(c('', 0, 0), 'TRANSIT');
  assert.strictEqual(c('  open   ', 0), 'PENDING');
});

import { isKotakFnoPosition, parseKotakTime, findRecentKotakOrder } from './kotakShape.ts';

test('isKotakFnoPosition keeps F&O segments and drops cash equity', () => {
  for (const e of ['nse_fo', 'bse_fo', 'mcx_fo', 'cde_fo', 'NSE_FO']) assert.strictEqual(isKotakFnoPosition({ exchange: e }), true, e);
  for (const e of ['nse_cm', 'bse_cm', '', undefined]) assert.strictEqual(isKotakFnoPosition({ exchange: e }), false, String(e));
});

test('parseKotakTime reads every Kotak stamp format as IST and fails closed', () => {
  const ist = (s: string) => Date.parse(`${s}+05:30`);
  assert.strictEqual(parseKotakTime('21-Aug-2026 10:15:22'), ist('2026-08-21T10:15:22'));
  assert.strictEqual(parseKotakTime('21-08-2026 10:15:22'), ist('2026-08-21T10:15:22'));
  assert.strictEqual(parseKotakTime('2026-08-21 10:15:22'), ist('2026-08-21T10:15:22'));
  assert.strictEqual(parseKotakTime('10:15:22', ist('2026-08-21T12:00:00')), ist('2026-08-21T10:15:22'));
  assert.strictEqual(parseKotakTime('garbage'), null);
  assert.strictEqual(parseKotakTime(''), null);
  assert.strictEqual(parseKotakTime('5-Foo-2026 10:15:22'), null);
});

test('findRecentKotakOrder finds the order an unanswered placement became, and only that one', () => {
  const since = Date.parse('2026-10-17T10:00:00+05:30');
  const row = { nOrdNo: '777', trdSym: 'NIFTY26OCT24500CE', trnsTp: 'S', qty: 75, ordSt: 'open', ordEntTm: '17-Oct-2026 10:00:01' };
  const want = { symbol: 'NIFTY26OCT24500CE', side: 'SELL' as const, qty: 75, since };
  assert.strictEqual(findRecentKotakOrder([row], want), '777');
  assert.strictEqual(findRecentKotakOrder([{ ...row, trnsTp: 'B' }], want), null);                    // other side
  assert.strictEqual(findRecentKotakOrder([{ ...row, qty: 150 }], want), null);                       // other size
  assert.strictEqual(findRecentKotakOrder([{ ...row, ordEntTm: '17-Oct-2026 09:59:50' }], want), null); // before it was sent
  assert.strictEqual(findRecentKotakOrder([{ ...row, ordSt: 'rejected' }], want), null);
  assert.strictEqual(findRecentKotakOrder([{ ...row, ordEntTm: 'n/a' }], want), null);                // unparseable: fail closed
  assert.strictEqual(findRecentKotakOrder([row, { ...row, nOrdNo: '778' }], want), null);              // ambiguous
  assert.strictEqual(findRecentKotakOrder([{ ...row, ordSt: 'complete' }], want), '777');
});

import { shapeKotakHolding } from './kotakShape.ts';
test('shapeKotakHolding reads several field spellings, strips the series, caps sellable at held, drops unreadable rows', () => {
  assert.deepStrictEqual(shapeKotakHolding({ displaySymbol: 'NIFTYBEES', quantity: 500, sellableQuantity: 450, averagePrice: 270.5 }),
    { symbol: 'NIFTYBEES', qty: 500, sellableQty: 450, avgPrice: 270.5 });
  assert.deepStrictEqual(shapeKotakHolding({ trdSym: 'reliance-eq', qty: '10', avgPrc: '1400' }),
    { symbol: 'RELIANCE', qty: 10, sellableQty: 10, avgPrice: 1400 });
  assert.strictEqual(shapeKotakHolding({ symbol: 'X', sellableQuantity: 5 })?.qty, undefined);   // no qty field -> null
  assert.strictEqual(shapeKotakHolding({ symbol: 'X', sellableQuantity: 5 }), null);
  assert.strictEqual(shapeKotakHolding({ symbol: 'X', quantity: 5, sellableQuantity: 9 })?.sellableQty, 5);
});

import { kotakPendingSellQty } from './kotakShape.ts';
test('kotakPendingSellQty counts the unfilled part of open sells on that symbol and product only', () => {
  const rows = [
    { trdSym: 'RELIANCE-EQ', trnsTp: 'S', prod: 'CNC', qty: 10, fldQty: 4, ordSt: 'open' },
    { trdSym: 'RELIANCE-EQ', trnsTp: 'S', prod: 'CNC', qty: 5, ordSt: 'put order req received' },
    { trdSym: 'RELIANCE-EQ', trnsTp: 'S', prod: 'CNC', qty: 7, fldQty: 7, ordSt: 'complete' },
    { trdSym: 'RELIANCE-EQ', trnsTp: 'S', prod: 'CNC', qty: 9, ordSt: 'rejected' },
    { trdSym: 'RELIANCE-EQ', trnsTp: 'B', prod: 'CNC', qty: 100, ordSt: 'open' },
    { trdSym: 'RELIANCE-EQ', trnsTp: 'S', prod: 'MIS', qty: 3, ordSt: 'open' },
    { trdSym: 'TCS-EQ', trnsTp: 'S', prod: 'CNC', qty: 50, ordSt: 'open' },
  ];
  assert.strictEqual(kotakPendingSellQty(rows, 'RELIANCE-EQ', 'CNC'), 6 + 5);
  assert.strictEqual(kotakPendingSellQty(rows, 'RELIANCE-EQ', 'INTRADAY'), 3);
});

test('shapeKotakPosition ignores the ltp portfolio/v2/positions sends (it echoed the entry average on 2026-10-17)', () => {
  // A short CRUDEOILM put as v2 returned it: `ltp` equal to the sell average. Trusting it skipped the Dhan quote join
  // and showed LTP = average with zero P&L, so the price must stay unknown (0) for the join to fill.
  const pos = shapeKotakPosition({
    trdSym: 'CRUDEOILM17NOV268800PE', tok: '123', exSeg: 'mcx_fo', prod: 'NRML',
    cfBuyQty: '0', cfSellQty: '0', flBuyQty: '0', flSellQty: '140',
    cfBuyAmt: '0.00', cfSellAmt: '0.00', buyAmt: '0.00', sellAmt: '40145.00',
    stkPrc: '8800.00', ltp: '286.75', lotSz: '10',
  });
  assert.strictEqual(pos.netQty, -140);
  assert.strictEqual(pos.sellAvg, 286.75);
  assert.strictEqual(pos.lastTradedPrice, 0);
  assert.strictEqual(pos.unrealizedProfit, 0);
});

test('shapeKotakPosition carries lotSz as lotSize (same units as the quantities), and omits a missing or bad one', () => {
  const row = { trdSym: 'CRUDEOILM19NOV26FUT', exSeg: 'mcx_fo', cfSellQty: '150', cfSellAmt: '1408950' };
  assert.strictEqual(shapeKotakPosition({ ...row, lotSz: '10' }).lotSize, 10);
  assert.strictEqual(shapeKotakPosition(row).lotSize, undefined);
  assert.strictEqual(shapeKotakPosition({ ...row, lotSz: '0' }).lotSize, undefined);
  assert.strictEqual(shapeKotakPosition({ ...row, lotSz: 'x' }).lotSize, undefined);
});
