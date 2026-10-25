import test from 'node:test';
import assert from 'node:assert/strict';
import { historyQuery, tickAcceptable } from './straddlePnfLoad.ts';

test('a fresh load or a Re-center asks for the current ATM', () => {
  assert.equal(historyQuery('2026-10-27', true, null), 'expiry=2026-10-27&atm=auto');
  assert.equal(historyQuery('2026-10-27', true, 25000), 'expiry=2026-10-27&atm=auto');
});

test('a quiet refresh keeps the strikes the page loaded with, however far spot has moved', () => {
  assert.equal(historyQuery('2026-10-27', false, 25000), 'expiry=2026-10-27&atm=25000');
});

test('a quiet refresh with nothing loaded yet falls back to auto', () => {
  assert.equal(historyQuery('2026-10-27', false, null), 'expiry=2026-10-27&atm=auto');
});

test('an explicit typed ATM is preserved across fresh loads and quiet refreshes', () => {
  assert.equal(historyQuery('2026-10-27', true, null, '24500'), 'expiry=2026-10-27&atm=24500');
  assert.equal(historyQuery('2026-10-27', false, 24500, '24500'), 'expiry=2026-10-27&atm=24500');
});

test('ticks fold only into the expiry that is loaded', () => {
  assert.equal(tickAcceptable('2026-10-27', '2026-10-27', '2026-10-27'), true);
  assert.equal(tickAcceptable('2026-10-27', '2026-10-27', undefined), true);     // quote carries no expiry: trust the page
  assert.equal(tickAcceptable('2026-11-24', '2026-10-27', '2026-11-24'), false); // page switched, history still the old expiry
  assert.equal(tickAcceptable('2026-11-24', '2026-11-24', '2026-10-27'), false); // bridge still on the old expiry
  assert.equal(tickAcceptable('', '2026-10-27', '2026-10-27'), false);
});
