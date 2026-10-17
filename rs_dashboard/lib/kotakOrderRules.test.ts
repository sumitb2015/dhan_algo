import { test } from 'node:test';
import assert from 'node:assert';
import { sourceLotCapError, snapToTick } from './kotakOrderRules.ts';

test('the Advanced Scalper cap is 100 lots of the contract, and an uncapped caller (a close) is never refused', () => {
  assert.strictEqual(sourceLotCapError(6500, 'as', 'NIFTY26O1923150CE', 65), null);       // exactly 100 lots
  assert.match(sourceLotCapError(6565, 'as', 'NIFTY26O1923150CE', 65) ?? '', /101 lots\) exceeds the as per-order cap of 100 lots/);
  assert.strictEqual(sourceLotCapError(1000, 'as', 'CRUDEOILM17NOV268800PE', 10), null);   // 100 CRUDEOILM lots (10 bbl)
  assert.match(sourceLotCapError(1010, 'as', 'CRUDEOILM17NOV268800PE', 10) ?? '', /exceeds/);
  // No source (closes, other desks) or an unknown one: uncapped, even huge, even with no contract.
  assert.strictEqual(sourceLotCapError(999_999, undefined, 'X', null), null);
  assert.strictEqual(sourceLotCapError(999_999, 'other', 'X', null), null);
});

test('a capped order whose contract is unknown fails closed', () => {
  assert.match(sourceLotCapError(65, 'as', 'NIFTY26O1923150CE', null) ?? '', /not in the Kotak instrument cache/);
  assert.match(sourceLotCapError(65, 'as', 'NIFTY26O1923150CE', 0) ?? '', /not in the Kotak instrument cache/);
});

test('snapToTick uses the contract tick, 0.05 when unknown', () => {
  assert.strictEqual(snapToTick(9387.4, 1), '9387.00');     // MCX future
  assert.strictEqual(snapToTick(9387.6, 1), '9388.00');
  assert.strictEqual(snapToTick(110.53, 0.05), '110.55');   // option
  assert.strictEqual(snapToTick(110.53, null), '110.55');   // no tick in the cache
  assert.strictEqual(snapToTick(23150.04, 0.1), '23150.00'); // NIFTY future
});
