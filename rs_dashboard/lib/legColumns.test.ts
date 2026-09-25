import { test } from 'node:test';
import assert from 'node:assert';
import { parseLegColumns, DEFAULT_LEG_COLUMNS } from './legColumns.ts';

test('nothing stored gives the defaults', () => {
  assert.deepStrictEqual(parseLegColumns(null), DEFAULT_LEG_COLUMNS);
  assert.deepStrictEqual(parseLegColumns(''), DEFAULT_LEG_COLUMNS);
});

test('stored booleans override defaults; missing keys keep their default', () => {
  const cols = parseLegColumns(JSON.stringify({ avg: false, qty: true }));
  assert.strictEqual(cols.avg, false);
  assert.strictEqual(cols.qty, true);
  assert.strictEqual(cols.exit, DEFAULT_LEG_COLUMNS.exit);
});

test('corrupt or wrongly-typed values fall back to defaults', () => {
  assert.deepStrictEqual(parseLegColumns('{not json'), DEFAULT_LEG_COLUMNS);
  assert.deepStrictEqual(parseLegColumns('[1,2]'), DEFAULT_LEG_COLUMNS);
  assert.deepStrictEqual(parseLegColumns(JSON.stringify({ avg: 'yes', junk: true })), DEFAULT_LEG_COLUMNS);
});
