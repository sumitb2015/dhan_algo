import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRecord, freezeSlices, resolveUnknowns, withResolvedUnknowns,
  dashProduct, heldByUnknown, kotakOrdersAsDhan, kotakProduct, legsFromKotakPositions, ownedQtyFromKotakOrders, recordedIds,
  todaysRecords, type KotakRecord,
} from './indexScalperKotak.ts';
import { sourceLotCapError } from './kotakOrderRules.ts';
import { ownedCloseOrder } from './indexScalperPositions.ts';

const SYM = 'NIFTY2612025350PE';
const rec = (orderId: string, side: 'BUY' | 'SELL', product = 'MIS'): KotakRecord => ({ orderId, symbol: SYM, side, product, at: 0 });
// lib/kotakShape.ts shapeKotakOrder rows
const ord = (orderId: string, side: string, qty: number, status: string, filled?: number, product = 'MIS') =>
  ({ orderId, tradingSymbol: SYM, transactionType: side, quantity: qty, orderStatus: status, productType: product, ...(filled !== undefined ? { filledQty: filled } : {}) });

test('Kotak ownership: only recorded order IDs, their filled qty, net of this page\'s own exits', () => {
  const book = [
    ord('K1', 'SELL', 65, 'COMPLETE', 65),           // ours
    ord('K2', 'SELL', 130, 'OPEN', 0),               // ours, not filled
    ord('K3', 'BUY', 65, 'COMPLETE'),                // ours, an exit; traded with no fill field -> its quantity
    ord('S1', 'SELL', 650, 'COMPLETE', 650),         // a strategy's: never counted
    ord('K4', 'SELL', 65, 'COMPLETE', 65, 'NRML'),   // ours, other product
  ];
  const own = ownedQtyFromKotakOrders(book, [rec('K1', 'SELL'), rec('K2', 'SELL'), rec('K3', 'BUY'), rec('K4', 'SELL', 'NRML')]);
  assert.equal(own.get(`${SYM}|INTRADAY`), 0); // sold 65, bought back 65
  assert.equal(own.get(`${SYM}|MARGIN`), -65);
  // with a strategy also short 650 on the same contract, Exit closes only our 65
  assert.deepEqual(ownedCloseOrder(-715, own.get(`${SYM}|MARGIN`)!), { side: 'BUY', units: 65 });
});

test('unknown outcomes hold exits on that symbol for 60 s, and are not counted as owned', () => {
  const recs: KotakRecord[] = [{ unknown: true, symbol: SYM, side: 'SELL', qty: 65, at: 1_000 }];
  assert.equal(heldByUnknown(recs, SYM, 30_000), true);
  assert.equal(heldByUnknown(recs, SYM, 61_001), false);
  assert.equal(heldByUnknown(recs, 'NIFTY2612025400CE', 30_000), false);
  assert.equal(recordedIds(recs).size, 0);
  assert.equal(ownedQtyFromKotakOrders([ord('X', 'SELL', 65, 'COMPLETE', 65)], recs).size, 0);
});

test('the day file is today\'s only; product mapping refuses anything else', () => {
  assert.deepEqual(todaysRecords({ day: '2026-11-24', records: [rec('A', 'BUY')] }, '2026-11-25'), []);
  assert.equal(todaysRecords({ day: '2026-11-25', records: [rec('A', 'BUY')] }, '2026-11-25').length, 1);
  assert.equal(kotakProduct('INTRADAY'), 'MIS');
  assert.equal(kotakProduct('MARGIN'), 'NRML');
  assert.equal(kotakProduct('CO'), null);
  assert.equal(dashProduct('NRML'), 'MARGIN');
});

test('Kotak positions become legs keyed by symbol + product, priced only through the live feed', () => {
  const symbols = { [SYM]: { expiry: '2026-12-01', strike: 25350, side: 'PE' as const }, 'NIFTY26DECFUT': { expiry: '2026-12-29', strike: 0, side: 'FUT' as const } };
  const legs = legsFromKotakPositions([
    { tradingSymbol: SYM, netQty: -65, sellAvg: 230, buyAvg: 0, productType: 'MIS' },
    { tradingSymbol: SYM, netQty: -65, sellAvg: 230, buyAvg: 0, productType: 'MIS' }, // duplicate row
    { tradingSymbol: 'NIFTY26DECFUT', netQty: 75, buyAvg: 25500, productType: 'NRML' }, // future: not an option leg
    { tradingSymbol: 'BANKNIFTY2612055000CE', netQty: 30, buyAvg: 10, productType: 'MIS' }, // not in the NIFTY map
  ], symbols, info => (info.strike === 25350 ? 210 : null));
  assert.equal(legs.length, 1);
  assert.deepEqual([legs[0].id, legs[0].securityId, legs[0].product, legs[0].strike, legs[0].type, legs[0].ltp], [`${SYM}|INTRADAY`, SYM, 'INTRADAY', 25350, 'PE', 210]);
  const unpriced = legsFromKotakPositions([{ tradingSymbol: SYM, netQty: 65, buyAvg: 100, productType: 'NRML' }], symbols, () => null);
  assert.equal(unpriced[0].ltp, null); // never the strike, never 0
});

test('Kotak CRUDEOILM positions include FUT leg and correct mult', () => {
  const symbols = {
    'CRUDEOILM26DECFUT': { expiry: '2026-12-18', strike: 0, side: 'FUT' as const },
    'CRUDEOILM26DEC6100CE': { expiry: '2026-12-15', strike: 6100, side: 'CE' as const },
  };
  const legs = legsFromKotakPositions([
    { tradingSymbol: 'CRUDEOILM26DECFUT', netQty: 10, buyAvg: 6120, productType: 'NRML' },
    { tradingSymbol: 'CRUDEOILM26DEC6100CE', netQty: -10, sellAvg: 110, productType: 'MIS' },
  ], symbols, info => (info.side === 'FUT' ? 6130 : 105), 'CRUDEOILM');
  assert.equal(legs.length, 2);
  const fut = legs.find(l => l.type === 'FUT');
  assert.ok(fut);
  assert.equal(fut.netQty, 10);
  assert.equal(fut.mult, 1);
  assert.equal(fut.strike, 0);
});

test('Kotak orders read as Dhan rows for the panel; Cancel only on this page\'s orders', () => {
  const symbols = { [SYM]: { expiry: '2026-12-01', strike: 25350, side: 'PE' as const } };
  const rows = kotakOrdersAsDhan([ord('K1', 'SELL', 65, 'OPEN', 0), ord('S1', 'SELL', 65, 'COMPLETE', 65, 'NRML')], symbols, new Set(['K1']));
  assert.equal(rows[0].orderStatus, 'PENDING');
  assert.equal(rows[0].correlationId, 'isx-kotak');
  assert.equal(rows[0].drvOptionType, 'PUT');
  assert.equal(rows[1].orderStatus, 'TRADED');
  assert.equal(rows[1].correlationId, '');
  assert.equal(rows[1].productType, 'MARGIN');
});

test('Kotak isx opening orders are capped at 20 lots', () => {
  assert.equal(sourceLotCapError(1300, 'isx', SYM, 65), null);
  assert.match(sourceLotCapError(1365, 'isx', SYM, 65) ?? '', /cap of 20 lots/);
});

const ist = (hms: string) => Date.parse(`2026-11-25T${hms}+05:30`);

test('an unknown outcome is resolved by exactly one matching order in the book, and then counts as owned', () => {
  const unknown: KotakRecord = { unknown: true, symbol: SYM, side: 'SELL', qty: 65, at: ist('10:20:03') };
  const book = [
    { orderId: 'K9', tradingSymbol: SYM, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS', createTime: '25-Nov-2026 10:20:05' },
    { orderId: 'S1', tradingSymbol: SYM, transactionType: 'SELL', quantity: 650, orderStatus: 'COMPLETE', filledQty: 650, productType: 'MIS', createTime: '25-Nov-2026 10:20:04' }, // other size
    { orderId: 'S2', tradingSymbol: SYM, transactionType: 'SELL', quantity: 65, orderStatus: 'COMPLETE', filledQty: 65, productType: 'MIS', createTime: '25-Nov-2026 09:10:00' },  // too early
  ];
  assert.deepEqual([...resolveUnknowns([unknown], book)], [[0, 'K9']]);
  assert.equal(ownedQtyFromKotakOrders(book, [unknown]).get(`${SYM}|INTRADAY`), -65);
  assert.equal(heldByUnknown([unknown], SYM, ist('10:20:30'), 60_000, book), false); // resolved: no hold
  assert.equal(heldByUnknown([unknown], SYM, ist('10:20:30'), 60_000, []), true);    // not in the book yet: held
  // two matching orders: ambiguous, stays unknown (and is not owned)
  const twin = [...book, { ...book[0], orderId: 'K10', createTime: '25-Nov-2026 10:20:06' }];
  assert.equal(resolveUnknowns([unknown], twin).size, 0);
  assert.equal(ownedQtyFromKotakOrders(twin, [unknown]).size, 0);
  // an order a recorded order already owns never resolves an unknown
  assert.equal(resolveUnknowns([rec('K9', 'SELL'), unknown], book).size, 0);
  assert.equal(withResolvedUnknowns([unknown], book)[0].orderId, 'K9');
});

test('closes above the freeze quantity are cut into whole-lot slices under it', () => {
  assert.deepEqual(freezeSlices(1300, 1800, 65), [1300]);
  assert.deepEqual(freezeSlices(2600, 1800, 65), [1755, 845]);   // 27 lots + 13 lots
  assert.deepEqual(freezeSlices(195, 130, 65), [130, 65]);
  assert.deepEqual(freezeSlices(195, null, 65), [195]);
  assert.deepEqual(freezeSlices(0, 1800, 65), []);
});

test('recording starts a new day file and appends within the day', () => {
  const a = appendRecord(null, '2026-11-25', rec('A', 'BUY'));
  assert.deepEqual(a.records.map(r => r.orderId), ['A']);
  const b = appendRecord(a, '2026-11-25', rec('B', 'SELL'));
  assert.deepEqual(b.records.map(r => r.orderId), ['A', 'B']);
  assert.deepEqual(appendRecord(b, '2026-11-26', rec('C', 'BUY')).records.map(r => r.orderId), ['C']);
});

test('Kotak stop orders carry their trigger into the panel row', () => {
  const rows = kotakOrdersAsDhan([{ ...ord('K1', 'SELL', 65, 'TRIGGER PENDING', 0), orderType: 'STOP_LOSS', triggerPrice: 180 }], {}, new Set(['K1']));
  assert.equal(rows[0].triggerPrice, 180);
  assert.equal(rows[0].orderStatus, 'PENDING');
});

test('shapeKotakOrder carries a stop order\'s trigger (trgPrc) and nothing for a plain order', async () => {
  const { shapeKotakOrder } = await import('./kotakShape.ts');
  assert.equal(shapeKotakOrder({ nOrdNo: '1', trdSym: SYM, ordSt: 'trigger pending', prcTp: 'SL', trgPrc: '180.00', qty: 65 }).triggerPrice, 180);
  assert.equal(shapeKotakOrder({ nOrdNo: '2', trdSym: SYM, ordSt: 'open', prcTp: 'L', trgPrc: '0', qty: 65 }).triggerPrice, undefined);
});
