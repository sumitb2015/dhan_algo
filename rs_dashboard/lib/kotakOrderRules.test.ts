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

test('sourceLotCapError: the Breakdown Scalper (bds) is capped at 20 lots on opening orders', () => {
  assert.strictEqual(sourceLotCapError(65 * 20, 'bds', 'NIFTY26O2025000PE', 65), null);
  assert.match(sourceLotCapError(65 * 21, 'bds', 'NIFTY26O2025000PE', 65) ?? '', /21 lots\) exceeds the bds per-order cap of 20 lots/);
  assert.strictEqual(sourceLotCapError(65 * 99, undefined, 'NIFTY26O2025000PE', 65), null, 'a close names no source and is never capped');
});

test("'fts' (Focus Tool opens) is capped at FTS_KOTAK_MAX_ORDER_LOTS lots; a close sends no source and is never capped", async () => {
  const { FTS_KOTAK_MAX_ORDER_LOTS } = await import('./focusToolUnderlyings.ts');
  assert.equal(sourceLotCapError(FTS_KOTAK_MAX_ORDER_LOTS * 65, 'fts', 'NIFTY26O1925200PE', 65), null);
  assert.match(String(sourceLotCapError((FTS_KOTAK_MAX_ORDER_LOTS + 1) * 65, 'fts', 'NIFTY26O1925200PE', 65)), /fts per-order cap/);
  assert.equal(sourceLotCapError(10_000 * 65, undefined, 'NIFTY26O1925200PE', 65), null);
});

test("'bs' (Bearish Strikes sells on Kotak / Zerodha) is capped at 50 lots; MCX Kotak counts barrels per lot", () => {
  assert.strictEqual(sourceLotCapError(65 * 50, 'bs', 'NIFTY26O2025000CE', 65), null);
  assert.match(sourceLotCapError(65 * 51, 'bs', 'NIFTY26O2025000CE', 65) ?? '', /51 lots\) exceeds the bs per-order cap of 50 lots/);
  assert.strictEqual(sourceLotCapError(10 * 50, 'bs', 'CRUDEOILM26NOV8500CE', 10), null);
  assert.match(sourceLotCapError(65, 'bs', 'NIFTY26O2025000CE', null) ?? '', /cannot check the bs per-order cap/);
});

test('gbx (Gearbox Drive) is capped at 1 lot per order on Kotak', () => {
  assert.strictEqual(sourceLotCapError(10, 'gbx', 'CRUDEOILM', 10), null);
  assert.match(String(sourceLotCapError(20, 'gbx', 'CRUDEOILM', 10)), /gbx per-order cap of 1 lots/);
});

test('isxc (Index Scalper on full-size CRUDEOIL): 5 lots = 500 barrels on Kotak', async () => {
  const { sourceLotCapError } = await import('./kotakOrderRules.ts');
  assert.equal(sourceLotCapError(500, 'isxc', 'CRUDEOIL15JAN277900CE', 100), null);
  assert.match(sourceLotCapError(600, 'isxc', 'CRUDEOIL15JAN277900CE', 100)!, /cap of 5 lots/);
  assert.equal(sourceLotCapError(200, 'isx', 'CRUDEOILM15JAN2712800CE', 10), null); // the mini keeps 20 lots
});

test('pa (Price Alerts) Kotak opens are capped at 10 lots', () => {
  assert.equal(sourceLotCapError(650, 'pa', 'NIFTY26D0124000CE', 65), null);
  assert.match(String(sourceLotCapError(715, 'pa', 'NIFTY26D0124000CE', 65)), /cap of 10 lots/);
  assert.match(String(sourceLotCapError(1100, 'pa', 'CRUDEOILM17DEC26FUT', 10)), /cap of 10 lots/);
});
