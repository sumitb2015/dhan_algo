import test from 'node:test';
import assert from 'node:assert/strict';
import { marginGateVerdict } from './marginGateClient.ts';

test('marginGateVerdict: enough funds pass; anything unreadable or short blocks', () => {
  assert.deepEqual(marginGateVerdict(100_000, 250_000), { ok: true, message: '' });
  assert.deepEqual(marginGateVerdict(100_000, 100_000), { ok: true, message: '' });   // exactly enough
  const short = marginGateVerdict(300_000, 250_000);
  assert.equal(short.ok, false);
  assert.match(short.message, /Insufficient margin: needs ~₹3,00,000, available ₹2,50,000/);
  // Fail closed: no margin, no funds, NaN.
  assert.equal(marginGateVerdict(undefined, 250_000).ok, false);
  assert.match(marginGateVerdict(undefined, 250_000).message, /Margin could not be verified/);
  assert.equal(marginGateVerdict(null, 250_000).ok, false);
  assert.equal(marginGateVerdict(NaN, 250_000).ok, false);
  assert.equal(marginGateVerdict(100_000, undefined).ok, false);
  assert.match(marginGateVerdict(100_000, NaN).message, /Available funds could not be read/);
  // Zero margin required is still a readable answer.
  assert.equal(marginGateVerdict(0, 10).ok, true);
});
