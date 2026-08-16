import { test } from 'node:test';
import assert from 'node:assert';
import { underlyingOfSymbol, isAnalyticsUnderlying } from './analyticsUnderlyings.ts';

test('underlyingOfSymbol matches real derivative symbol shapes', () => {
  assert.strictEqual(underlyingOfSymbol('NIFTY-Aug2026-25000-CE'), 'NIFTY');
  assert.strictEqual(underlyingOfSymbol('NIFTY18AUG2624400CE'), 'NIFTY');
  assert.strictEqual(underlyingOfSymbol('SENSEX20AUG2678000PE'), 'SENSEX');
});

test('underlyingOfSymbol requires a digit/hyphen boundary, not a bare prefix', () => {
  // NIFTYNXT50 is a distinct instrument — a plain startsWith('NIFTY') would
  // file its legs into the NIFTY book against the wrong spot.
  assert.strictEqual(underlyingOfSymbol('NIFTYNXT5030AUG2612000CE'), null);
});

test('underlyingOfSymbol returns null for unsupported or unrecognized symbols', () => {
  assert.strictEqual(underlyingOfSymbol('BANKNIFTY-Aug2026-50000-CE'), null);
  assert.strictEqual(underlyingOfSymbol('RELIANCE'), null);
  assert.strictEqual(underlyingOfSymbol(''), null);
});

test('isAnalyticsUnderlying is case-insensitive', () => {
  assert.strictEqual(isAnalyticsUnderlying('nifty'), true);
  assert.strictEqual(isAnalyticsUnderlying('SENSEX'), true);
  assert.strictEqual(isAnalyticsUnderlying('BANKNIFTY'), false);
});
