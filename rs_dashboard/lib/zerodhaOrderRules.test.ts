import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zerodhaContractFromRows, zerodhaLotCapError, zerodhaSnapPrice, zerodhaUnderlyingOf } from './zerodhaOrderRules.ts';

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
