import { test } from 'node:test';
import assert from 'node:assert';
import {
  guardProductOf, evaluateSoftPnlGuard, validateSoftPnlGuard, softBracketLevels, matchPendingBracket, type SoftPnlGuard,
} from './softGuards.ts';

const g = (o: Partial<SoftPnlGuard> = {}): SoftPnlGuard => ({ profit: 5000, loss: 2000, products: ['INTRADAY'], date: '2026-10-17', ...o });

test('guardProductOf maps Dhan, Kite and Neo product names onto the guard chips', () => {
  assert.strictEqual(guardProductOf('MIS'), 'INTRADAY');
  assert.strictEqual(guardProductOf('intraday'), 'INTRADAY');
  assert.strictEqual(guardProductOf('NRML'), 'MARGIN');
  assert.strictEqual(guardProductOf('MARGIN'), 'MARGIN');
  assert.strictEqual(guardProductOf('CNC'), 'CNC');
  assert.strictEqual(guardProductOf(undefined), '');
});

test('evaluateSoftPnlGuard fires at the target and at the loss limit, and only then', () => {
  assert.deepStrictEqual(evaluateSoftPnlGuard(g(), 4999, '2026-10-17'), { fire: false });
  assert.strictEqual(evaluateSoftPnlGuard(g(), 5000, '2026-10-17').fire, true);
  assert.deepStrictEqual(evaluateSoftPnlGuard(g(), -1999, '2026-10-17'), { fire: false });
  assert.strictEqual(evaluateSoftPnlGuard(g(), -2000, '2026-10-17').fire, true);
});

test('evaluateSoftPnlGuard ignores an unset level, a stale day, no guard and a non-finite P&L', () => {
  assert.deepStrictEqual(evaluateSoftPnlGuard(g({ profit: 0 }), 99999, '2026-10-17'), { fire: false });
  assert.deepStrictEqual(evaluateSoftPnlGuard(g({ loss: 0 }), -99999, '2026-10-17'), { fire: false });
  assert.deepStrictEqual(evaluateSoftPnlGuard(g(), 99999, '2026-10-18'), { fire: false });
  assert.deepStrictEqual(evaluateSoftPnlGuard(null, 99999, '2026-10-17'), { fire: false });
  assert.deepStrictEqual(evaluateSoftPnlGuard(g(), NaN, '2026-10-17'), { fire: false });
});

test('validateSoftPnlGuard needs a level and a product', () => {
  assert.ok(validateSoftPnlGuard(0, 0, ['INTRADAY']));
  assert.ok(validateSoftPnlGuard(100, 0, []));
  assert.strictEqual(validateSoftPnlGuard(100, 0, ['INTRADAY']), null);
  assert.strictEqual(validateSoftPnlGuard(0, 100, ['MARGIN']), null);
});

test('softBracketLevels: a long targets up and stops down, a short is the mirror, on the tick grid', () => {
  assert.deepStrictEqual(softBracketLevels({ side: 'BUY', ref: 100.03, targetPts: 10, slPts: 8, tick: 0.05 }), { ok: true, target: 110.05, sl: 92.05 });
  assert.deepStrictEqual(softBracketLevels({ side: 'SELL', ref: 100, targetPts: 10, slPts: 8, tick: 0.05 }), { ok: true, target: 90, sl: 108 });
  assert.deepStrictEqual(softBracketLevels({ side: 'BUY', ref: 100, targetPts: 10, slPts: 8, tick: 0.1 }), { ok: true, target: 110, sl: 92 });
});

test('softBracketLevels refuses missing inputs and levels at or below zero', () => {
  assert.strictEqual(softBracketLevels({ side: 'BUY', ref: 0, targetPts: 10, slPts: 8, tick: 0.05 }).ok, false);
  assert.strictEqual(softBracketLevels({ side: 'BUY', ref: 100, targetPts: 10, slPts: 8, tick: 0 }).ok, false);
  assert.strictEqual(softBracketLevels({ side: 'BUY', ref: 100, targetPts: 0, slPts: 8, tick: 0.05 }).ok, false);
  assert.strictEqual(softBracketLevels({ side: 'BUY', ref: 100, targetPts: 10, slPts: 0, tick: 0.05 }).ok, false);
  assert.strictEqual(softBracketLevels({ side: 'BUY', ref: 5, targetPts: 10, slPts: 8, tick: 0.05 }).ok, false);   // SL 5-8 < 0
  assert.strictEqual(softBracketLevels({ side: 'SELL', ref: 5, targetPts: 10, slPts: 8, tick: 0.05 }).ok, false);  // target 5-10 < 0
});

test('matchPendingBracket needs the same symbol, product and direction', () => {
  const pending = [{ symbol: 'NIFTY26OCT24500CE', product: 'INTRADAY' as const, dir: -1 as const, target: 80, sl: 120, trail: false, at: 1, ttlMs: 1000, qtyBefore: 0 }];
  const row = { tradingSymbol: 'NIFTY26OCT24500CE', productType: 'MIS', netQty: -75 };
  assert.strictEqual(matchPendingBracket(pending, row), pending[0]);
  assert.strictEqual(matchPendingBracket(pending, { ...row, netQty: 75 }), null);          // opposite direction
  assert.strictEqual(matchPendingBracket(pending, { ...row, productType: 'NRML' }), null); // other product
  assert.strictEqual(matchPendingBracket(pending, { ...row, tradingSymbol: 'X' }), null);
  assert.strictEqual(matchPendingBracket(pending, { ...row, netQty: 0 }), null);           // flat
});

test('matchPendingBracket waits for the position to GROW: a rejected entry never re-levels the position already open', () => {
  const mk = (qtyBefore: number) => [{ symbol: 'S', product: 'INTRADAY' as const, dir: -1 as const, target: 80, sl: 120, trail: false, at: 1, ttlMs: 1000, qtyBefore }];
  const row = (netQty: number) => ({ tradingSymbol: 'S', productType: 'MIS', netQty });
  // Already short 75 when the add was sent: still 75 = the add has not landed (or was rejected).
  assert.strictEqual(matchPendingBracket(mk(-75), row(-75)), null);
  assert.ok(matchPendingBracket(mk(-75), row(-150)));
  // Was long 75 and a SELL 150 flips it short: -75 is more short than "before" (+75).
  assert.ok(matchPendingBracket(mk(75), row(-75)));
  assert.strictEqual(matchPendingBracket(mk(75), row(50)), null);
});

test('evaluateSoftPnlGuard with unpriced legs: the loss limit may fire, the profit target may not', () => {
  assert.strictEqual(evaluateSoftPnlGuard(g(), -2500, '2026-10-17', false).fire, true);
  assert.deepStrictEqual(evaluateSoftPnlGuard(g(), 9000, '2026-10-17', false), { fire: false });
  assert.strictEqual(evaluateSoftPnlGuard(g(), 9000, '2026-10-17', true).fire, true);
});

import { softEntryEffect } from './softGuards.ts';
test('softEntryEffect: a close only reduces; an add, a fresh entry and a FLIP open exposure', () => {
  assert.strictEqual(softEntryEffect('SELL', 75, 75), 'closes');
  assert.strictEqual(softEntryEffect('SELL', 25, 75), 'closes');
  assert.strictEqual(softEntryEffect('BUY', 75, -75), 'closes');
  assert.strictEqual(softEntryEffect('SELL', 150, 75), 'opens');   // flips long 75 into short 75
  assert.strictEqual(softEntryEffect('BUY', 150, -75), 'opens');
  assert.strictEqual(softEntryEffect('SELL', 75, 0), 'opens');
  assert.strictEqual(softEntryEffect('SELL', 75, -75), 'opens');   // adds to a short
  assert.strictEqual(softEntryEffect('BUY', 75, 75), 'opens');
});
