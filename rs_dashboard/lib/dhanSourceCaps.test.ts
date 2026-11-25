import test from 'node:test';
import assert from 'node:assert/strict';
import { dhanSourceCapError } from './dhanSourceCaps.ts';

test('Index Scalper caps on Dhan MCX (quantity in lots): isx 20 (CRUDEOILM), isxc 5 (CRUDEOIL)', () => {
  assert.equal(dhanSourceCapError(20, 'isx', 'MCX_COMM'), null);
  assert.notEqual(dhanSourceCapError(21, 'isx', 'MCX_COMM'), null);
  assert.equal(dhanSourceCapError(5, 'isxc', 'MCX_COMM'), null);
  assert.match(dhanSourceCapError(6, 'isxc', 'MCX_COMM')!, /isxc per-order cap of 5/);
  assert.equal(dhanSourceCapError(1300, 'isx', 'NSE_FNO'), null); // NIFTY 20 x 65
});

test('isxx (the Index Scalper\'s closing orders) is uncapped: a 10-lot CRUDEOIL position can always be closed', () => {
  assert.equal(dhanSourceCapError(10, 'isxx', 'MCX_COMM'), null);
  assert.equal(dhanSourceCapError(5000, 'isxx', 'NSE_FNO'), null);
});
