import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { orderAddsExposure, lockGateDecision } from './kotakLockRules.ts';

test('orders that open or add exposure are refused on a locked day', () => {
  assert.strictEqual(orderAddsExposure('S', 65, 0), true);    // new short
  assert.strictEqual(orderAddsExposure('B', 65, 0), true);    // new long
  assert.strictEqual(orderAddsExposure('S', 65, -65), true);  // add to a short
  assert.strictEqual(orderAddsExposure('B', 65, 130), true);  // add to a long
});

test('a reducing or closing order always passes; an oversize one that would flip through flat does not', () => {
  assert.strictEqual(orderAddsExposure('B', 65, -65), false); // cover a short fully
  assert.strictEqual(orderAddsExposure('B', 30, -65), false); // partial cover
  assert.strictEqual(orderAddsExposure('S', 65, 65), false);  // sell a long
  assert.strictEqual(orderAddsExposure('B', 130, -65), true); // would flip to long 65
  assert.strictEqual(orderAddsExposure('S', 0, 65), false);   // zero quantity adds nothing
});

const LOCK = { products: ['INTRADAY', 'MARGIN'] };
const ord = (o: Partial<{ symbol: string; product: string; side: 'B' | 'S'; qty: number }> = {}) => ({ symbol: 'X', product: 'MARGIN', side: 'S' as const, qty: 65, ...o });
const book = (net: number, product = 'MARGIN') => [{ symbol: 'X', product, net }, { symbol: 'Y', product, net: -999 }];

test('gate: unlocked allows everything; locked refuses an add and allows a reduce', () => {
  assert.strictEqual(lockGateDecision(null, ord(), book(0)), 'allow');
  assert.strictEqual(lockGateDecision(LOCK, ord(), book(0)), 'refuse');                       // new short
  assert.strictEqual(lockGateDecision(LOCK, ord({ side: 'B' }), book(-65)), 'allow');         // cover it
  assert.strictEqual(lockGateDecision(LOCK, ord({ side: 'B', qty: 130 }), book(-65)), 'refuse'); // would flip
});

test('gate: another product, another symbol, and an unreadable book', () => {
  assert.strictEqual(lockGateDecision(LOCK, ord({ product: 'CNC' }), book(0)), 'allow');   // outside the lock scope
  assert.strictEqual(lockGateDecision(LOCK, ord({ symbol: 'Z' }), book(-65)), 'refuse');   // not in the book: opens a leg
  assert.strictEqual(lockGateDecision(LOCK, ord(), null), 'allow');                         // no book, no memory: never trap an exit
  assert.strictEqual(lockGateDecision(LOCK, ord(), book(-65, 'INTRADAY')), 'refuse');       // the same symbol under ANOTHER product is not this leg
});

test('tripwire: the guard\'s own flatten bypasses the lock it enforces, and placeKotakOrder honours the bypass', () => {
  // These modules import the broker client (@/ aliases), which node --test cannot load: check the wiring in the source.
  const server = readFileSync(new URL('./kotakGuardServer.ts', import.meta.url), 'utf8');
  assert.match(server, /placeKotakOrder\([\s\S]*?\{ bypassLock: true \}\)/);
  const place = readFileSync(new URL('./kotakPlaceOrder.ts', import.meta.url), 'utf8');
  assert.match(place, /if \(!opts\.bypassLock\)[\s\S]*?kotakLockRefusal\(payload\)/);
});
