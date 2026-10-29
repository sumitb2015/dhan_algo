import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuery, matchIndices, isIndexSymbol, isSymbol } from './straddlePnfSearch.ts';

test('cleanQuery upper-cases and trims, and rejects empty or odd input', () => {
  assert.equal(cleanQuery('  reli '), 'RELI');
  assert.equal(cleanQuery('m&m'), 'M&M');
  assert.equal(cleanQuery(''), null);
  assert.equal(cleanQuery('a;b'), null);
  assert.equal(cleanQuery('x'.repeat(31)), null);
});

test('indices match by symbol prefix or by name', () => {
  assert.deepEqual(matchIndices('NIFTY').map(i => i.symbol), ['NIFTY', 'BANKNIFTY', 'FINNIFTY']);
  assert.deepEqual(matchIndices('BANK').map(i => i.symbol), ['BANKNIFTY']);
  assert.deepEqual(matchIndices('RELI'), []);
});

test('symbol validators', () => {
  assert.ok(isIndexSymbol('NIFTY'));
  assert.ok(!isIndexSymbol('SENSEX'));
  assert.ok(isSymbol('M&M'));
  assert.ok(!isSymbol('../x'));
});
