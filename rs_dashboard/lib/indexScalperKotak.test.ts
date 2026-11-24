import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
