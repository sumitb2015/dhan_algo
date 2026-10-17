import { test } from 'node:test';
import assert from 'node:assert';
import { kotakUnderlyingOf, kotakContractRequests, type KotakSymbolMap } from './kotakPositionContracts.ts';

test('kotakUnderlyingOf takes the longest root and needs a digit after it', () => {
  assert.strictEqual(kotakUnderlyingOf('CRUDEOILM17NOV268800PE'), 'CRUDEOILM');
  assert.strictEqual(kotakUnderlyingOf('CRUDEOIL17NOV268800PE'), 'CRUDEOIL');
  assert.strictEqual(kotakUnderlyingOf('CRUDEOILM19NOV26FUT'), 'CRUDEOILM');
  assert.strictEqual(kotakUnderlyingOf('BANKNIFTY26OCT48000CE'), 'BANKNIFTY');
  assert.strictEqual(kotakUnderlyingOf('NIFTY26OCT22500PE'), 'NIFTY');
  assert.strictEqual(kotakUnderlyingOf('NIFTYBEES-EQ'), null);
  assert.strictEqual(kotakUnderlyingOf('RELIANCE-EQ'), null);
});

test('kotakContractRequests sends every open leg the map knows, across underlyings, futures with strike 0', () => {
  // The 2026-10-17 Kotak book: two NIFTY options on different expiries, a CRUDEOILM option and a CRUDEOILM future.
  const map: KotakSymbolMap = {
    NIFTY26OCT22500PE: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
    NIFTY27MAR24000PE: { underlying: 'NIFTY', expiry: '2027-03-30', strike: 24000, side: 'PE' },
    CRUDEOILM17NOV268800PE: { underlying: 'CRUDEOILM', expiry: '2026-11-17', strike: 8800, side: 'PE' },
    CRUDEOILM19NOV26FUT: { underlying: 'CRUDEOILM', expiry: '2026-11-19', strike: 0, side: 'FUT' },
  };
  const reqs = kotakContractRequests([
    { tradingSymbol: 'NIFTY26OCT22500PE', netQty: -390 },
    { tradingSymbol: 'NIFTY27MAR24000PE', netQty: 130 },
    { tradingSymbol: 'CRUDEOILM19NOV26FUT', netQty: -150 },
    { tradingSymbol: 'CRUDEOILM17NOV268800PE', netQty: -140 },
    { tradingSymbol: 'CRUDEOILM17NOV268800PE', netQty: -140 },   // duplicate row
    { tradingSymbol: 'NIFTY26OCT23000CE', netQty: 0 },           // closed
    { tradingSymbol: 'UNKNOWN26OCT1CE', netQty: 5 },             // not in any cache
  ], map);
  assert.deepStrictEqual(reqs, [
    { key: 'CRUDEOILM17NOV268800PE', underlying: 'CRUDEOILM', expiry: '2026-11-17', strike: 8800, side: 'PE' },
    { key: 'CRUDEOILM19NOV26FUT', underlying: 'CRUDEOILM', expiry: '2026-11-19', strike: 0, side: 'FUT' },
    { key: 'NIFTY26OCT22500PE', underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
    { key: 'NIFTY27MAR24000PE', underlying: 'NIFTY', expiry: '2027-03-30', strike: 24000, side: 'PE' },
  ]);
});
