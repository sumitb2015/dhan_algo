import { test } from 'node:test';
import assert from 'node:assert';
import { brokerRoute, scalperRoute } from './useBrokerSelector.ts';

const PATHS = {
  dhan: '/api/scalper/all',
  zerodha: '/api/scalper/zerodha/all',
  kotak: '/api/scalper/kotak/all',
};

test('brokerRoute picks the Dhan path by default', () => {
  assert.strictEqual(brokerRoute('dhan', PATHS), '/api/scalper/all');
});

test('brokerRoute picks the Zerodha path when selected', () => {
  assert.strictEqual(brokerRoute('zerodha', PATHS), '/api/scalper/zerodha/all');
});

test('brokerRoute picks the Kotak path when selected', () => {
  assert.strictEqual(brokerRoute('kotak', PATHS), '/api/scalper/kotak/all');
});

// The whole reason brokerRoute takes a map: with the old positional pair, a
// broker with no entry silently resolved to the Zerodha path. Falling back to
// Dhan is the safe direction — it is the one broker always present.
test('brokerRoute falls back to Dhan when a broker has no entry', () => {
  assert.strictEqual(brokerRoute('kotak', { dhan: '/api/scalper/all' }), '/api/scalper/all');
});

test('scalperRoute nests every broker except Dhan', () => {
  assert.strictEqual(scalperRoute('dhan', 'poll'), '/api/scalper/poll');
  assert.strictEqual(scalperRoute('zerodha', 'poll'), '/api/scalper/zerodha/poll');
  assert.strictEqual(scalperRoute('kotak', 'poll'), '/api/scalper/kotak/poll');
});
