import { test } from 'node:test';
import assert from 'node:assert';
import { isDhanFnoSegment, planFnoExits } from './exitAllPlan.ts';

const row = (tradingSymbol: string, exchangeSegment: string, netQty: number) =>
  ({ tradingSymbol, exchangeSegment, netQty } as Record<string, unknown>);

test('isDhanFnoSegment covers index/stock F&O and MCX, not cash equity', () => {
  assert.ok(isDhanFnoSegment('NSE_FNO'));
  assert.ok(isDhanFnoSegment('BSE_FNO'));
  assert.ok(isDhanFnoSegment('MCX_COMM'));
  assert.ok(!isDhanFnoSegment('NSE_EQ'));
  assert.ok(!isDhanFnoSegment('BSE_EQ'));
  assert.ok(!isDhanFnoSegment(undefined));
});

test('planFnoExits keeps MCX crude legs in scope', () => {
  const plan = planFnoExits([row('CRUDEOIL-Oct2026-5500-CE', 'MCX_COMM', -1), row('RELIANCE', 'NSE_EQ', 10)]);
  assert.deepStrictEqual(plan.map(p => p.tradingSymbol), ['CRUDEOIL-Oct2026-5500-CE']);
});

test('planFnoExits buys back shorts before selling longs and skips flat rows', () => {
  const plan = planFnoExits([
    row('NIFTY-Oct2026-26500-CE', 'NSE_FNO', 65),     // long hedge
    row('NIFTY-Oct2026-25500-CE', 'NSE_FNO', -130),   // short
    row('NIFTY-Oct2026-25000-PE', 'NSE_FNO', 0),      // closed earlier
    row('SENSEX-Oct2026-82000-PE', 'BSE_FNO', -20),   // short
  ]);
  assert.deepStrictEqual(plan.map(p => p.tradingSymbol),
    ['NIFTY-Oct2026-25500-CE', 'SENSEX-Oct2026-82000-PE', 'NIFTY-Oct2026-26500-CE']);
});

test('planFnoExits does not reorder the caller\'s array', () => {
  const input = [row('A', 'NSE_FNO', 65), row('B', 'NSE_FNO', -65)];
  planFnoExits(input);
  assert.deepStrictEqual(input.map(p => p.tradingSymbol), ['A', 'B']);
});
