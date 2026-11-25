import test from 'node:test';
import assert from 'node:assert/strict';
import { qtyBook, tradeChimeFor } from './indexScalperChime.ts';

const book = (...legs: [string, number][]) => qtyBook(legs.map(([id, netQty]) => ({ id, netQty })));

test('no change is silent', () => {
  assert.equal(tradeChimeFor(book(['a', 75]), book(['a', 75])), null);
  assert.equal(tradeChimeFor(book(), book()), null);
});

test('opening or adding to a leg is an entry', () => {
  assert.equal(tradeChimeFor(book(), book(['a', 75])), 'entry');
  assert.equal(tradeChimeFor(book(['a', -75]), book(['a', -150])), 'entry');
  assert.equal(tradeChimeFor(book(['a', 75]), book(['a', 75], ['b', -75])), 'entry');
});

test('closing, reducing or flipping a leg is an exit', () => {
  assert.equal(tradeChimeFor(book(['a', 75]), book()), 'exit');
  assert.equal(tradeChimeFor(book(['a', -150]), book(['a', -75])), 'exit');
  assert.equal(tradeChimeFor(book(['a', 75]), book(['a', -75])), 'exit');
});

test('an exit wins over an entry in the same change', () => {
  assert.equal(tradeChimeFor(book(['a', 75]), book(['b', 75])), 'exit');
});

test('flat rows are ignored', () => {
  assert.equal(tradeChimeFor(book(['a', 0]), book()), null);
});
