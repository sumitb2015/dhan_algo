import { test } from 'node:test';
import assert from 'node:assert';
import { symbolOnUnderlying } from './symbolUnderlying.ts';

test('symbolOnUnderlying matches every broker spelling of the same root', () => {
  assert.ok(symbolOnUnderlying('NIFTY-Oct2026-25000-CE', 'NIFTY'));   // Dhan
  assert.ok(symbolOnUnderlying('NIFTY26OCT25000CE', 'NIFTY'));        // Kotak / Zerodha monthly
  assert.ok(symbolOnUnderlying('nifty2610625000pe', 'NIFTY'));        // case-insensitive
  assert.ok(symbolOnUnderlying('CRUDEOIL-Nov2026-5500-CE', 'CRUDEOIL'));
});

test('symbolOnUnderlying rejects a different instrument sharing the prefix', () => {
  // FINNIFTY's monthly expiry is NIFTY's day and NIFTY's chain lists its strikes: an Add on this row once resolved
  // to a NIFTY contract.
  assert.ok(!symbolOnUnderlying('FINNIFTY-Oct2026-27000-CE', 'NIFTY'));
  assert.ok(!symbolOnUnderlying('NIFTYNXT50-Oct2026-70000-CE', 'NIFTY'));
  assert.ok(!symbolOnUnderlying('CRUDEOILM-Nov2026-5500-CE', 'CRUDEOIL'));
  assert.ok(!symbolOnUnderlying('BANKNIFTY26OCT55000CE', 'NIFTY'));
  assert.ok(!symbolOnUnderlying('', 'NIFTY'));
  assert.ok(!symbolOnUnderlying('NIFTY26OCT25000CE', ''));
});
