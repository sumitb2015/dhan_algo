import test from 'node:test';
import assert from 'node:assert/strict';
import { chimeFor } from './priceLadderChime.ts';

test('an entry fill is an entry, an exit is an exit', () => {
  assert.equal(chimeFor(['BUY 22450PE filled 65 @ 118.50']), 'entry');
  assert.equal(chimeFor(['SIM BUY 22450PE filled 65 @ 118.50']), 'entry');
  assert.equal(chimeFor(['Exited 65 @ 131.00 (Manual exit)']), 'exit');
  assert.equal(chimeFor(['SIM exit @ 131.00']), 'exit');
});

test('a problem outranks an exit, an exit outranks an entry', () => {
  assert.equal(chimeFor(['BUY 22450PE filled 65 @ 118.50', 'Exited 65 @ 131.00']), 'exit');
  assert.equal(chimeFor(['Exited 65 @ 131.00', 'Entry rejected: no margin']), 'warn');
  assert.equal(chimeFor(['Entry UNKNOWN — check Orders']), 'warn');
});

test('other events make no sound', () => {
  assert.equal(chimeFor(['Armed BUY 1 lot NIFTY 22450PE when NIFTY <= 22400', 'Lots changed to 2']), null);
  assert.equal(chimeFor([]), null);
});
