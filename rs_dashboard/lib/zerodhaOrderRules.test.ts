import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zerodhaContractFromRows, zerodhaLotCapError, zerodhaSnapPrice, zerodhaUnderlyingOf, zerodhaOrderSlices } from './zerodhaOrderRules.ts';

const rows = [{ tradingsymbol: 'NIFTY26OCT24500CE', lot_size: 75, tick_size: 0.05 }, { tradingsymbol: 'OLD', lot_size: 30 }];

test('contract lookup by symbol; tick missing in an old cache is null', () => {
  assert.deepEqual(zerodhaContractFromRows(rows, 'NIFTY26OCT24500CE'), { lotSize: 75, tick: 0.05 });
  assert.deepEqual(zerodhaContractFromRows(rows, 'OLD'), { lotSize: 30, tick: null });
  assert.equal(zerodhaContractFromRows(rows, 'NOPE'), null);
});

test('lot cap: only a named source is capped, fails closed on unknown contract, names Zerodha', () => {
  const c = zerodhaContractFromRows(rows, 'NIFTY26OCT24500CE');
  assert.equal(zerodhaLotCapError(75 * 100, 'as', 'X', c), null);
  assert.match(zerodhaLotCapError(75 * 101, 'as', 'X', c) ?? '', /exceeds the as per-order cap of 100 lots/);
  assert.equal(zerodhaLotCapError(75 * 500, undefined, 'X', c), null);
  assert.match(zerodhaLotCapError(75, 'as', 'X', null) ?? '', /Zerodha instrument cache/);
});

test('price snaps to tick', () => {
  assert.equal(zerodhaSnapPrice(101.23, { lotSize: 75, tick: 0.05 }), 101.25);
  assert.equal(zerodhaSnapPrice(101.23, null), 101.25);
  assert.equal(zerodhaSnapPrice(101.4, { lotSize: 1, tick: 1 }), 101);
});

test('underlying root needs a digit after it', () => {
  assert.equal(zerodhaUnderlyingOf('NIFTY2610624500CE'), 'NIFTY');
  assert.equal(zerodhaUnderlyingOf('BANKNIFTY26OCT55000PE'), 'BANKNIFTY');
  assert.equal(zerodhaUnderlyingOf('NIFTYBEES'), null);
});

test('slices stay whole lots under the freeze quantity; unknown lot or underlying is one order', () => {
  assert.deepEqual(zerodhaOrderSlices(65 * 10, 'NIFTY', 65), [650]);                       // fits
  const big = zerodhaOrderSlices(65 * 100, 'NIFTY', 65);                                    // 6500 > 1800
  assert.equal(big.reduce((a, b) => a + b, 0), 6500);
  assert.ok(big.every(q => q <= 1800 && q % 65 === 0), JSON.stringify(big));
  assert.deepEqual(big.slice(0, -1).every(q => q === big[0]), true);
  assert.deepEqual(zerodhaOrderSlices(6500, 'NIFTY', null), [6500]);
  assert.deepEqual(zerodhaOrderSlices(6500, null, 65), [6500]);
  assert.deepEqual(zerodhaOrderSlices(65, 'SENSEX', 20), [65]);
});

import { pickZerodhaFuture } from './zerodhaOrderRules.ts';
const FUT_ROWS = [
  { tradingsymbol: 'CRUDEOILM26DECFUT', expiry: '2026-12-18', lot_size: 1 },
  { tradingsymbol: 'CRUDEOILM26OCTFUT', expiry: '2026-10-19', lot_size: 1 },
  { tradingsymbol: 'CRUDEOILM26NOVFUT', expiry: '2026-11-19', lot_size: 1 },
];
test('pickZerodhaFuture: nearest unexpired by default, the exact month when asked, nothing for an unlisted expiry', () => {
  assert.equal(pickZerodhaFuture(FUT_ROWS, null, '2026-10-19')?.tradingsymbol, 'CRUDEOILM26OCTFUT');   // expiry day: still live
  assert.equal(pickZerodhaFuture(FUT_ROWS, null, '2026-10-20')?.tradingsymbol, 'CRUDEOILM26NOVFUT');   // expired rows are skipped
  assert.equal(pickZerodhaFuture(FUT_ROWS, '2026-12-18', '2026-10-19')?.tradingsymbol, 'CRUDEOILM26DECFUT');
  assert.equal(pickZerodhaFuture(FUT_ROWS, '2026-11-18', '2026-10-19'), null);                          // never the nearest instead
  assert.equal(pickZerodhaFuture([], null, '2026-10-19'), null);
});
