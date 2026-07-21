import { test } from 'node:test';
import assert from 'node:assert';
import { legToOffset, offsetToStrike } from './basketStorage.ts';

test('legToOffset computes an ATM-relative step offset', () => {
  assert.strictEqual(legToOffset(24200, 24000, 50), 4);
  assert.strictEqual(legToOffset(23800, 24000, 50), -4);
  assert.strictEqual(legToOffset(24000, 24000, 50), 0);
});

test('offsetToStrike re-anchors an offset to a new ATM using the nearest listed strike', () => {
  const strikes = [23800, 23850, 23900, 23950, 24000, 24050, 24100];
  assert.strictEqual(offsetToStrike(2, 24000, strikes, 50), 24100);
  assert.strictEqual(offsetToStrike(-2, 23900, strikes, 50), 23800);
});

test('offsetToStrike falls back to the ATM strike itself when the strike list is empty', () => {
  assert.strictEqual(offsetToStrike(3, 24000, [], 50), 24000);
});
