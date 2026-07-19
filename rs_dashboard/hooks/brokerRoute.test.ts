import { test } from 'node:test';
import assert from 'node:assert';
import { brokerRoute } from './useBrokerSelector.ts';

test('brokerRoute picks the Dhan path by default', () => {
  assert.strictEqual(brokerRoute('dhan', '/api/scalper/all', '/api/scalper/zerodha/all'), '/api/scalper/all');
});

test('brokerRoute picks the Zerodha path when selected', () => {
  assert.strictEqual(brokerRoute('zerodha', '/api/scalper/all', '/api/scalper/zerodha/all'), '/api/scalper/zerodha/all');
});
