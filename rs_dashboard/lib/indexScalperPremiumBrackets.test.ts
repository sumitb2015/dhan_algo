import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPremiumLevel, legPremiumPnl, premiumBracketError, premiumBracketsFor, premiumPnlAt, snapPremium } from './indexScalperPremiumBrackets.ts';
import type { ScalperLeg } from './indexScalperPositions.ts';

const leg = (o: Partial<ScalperLeg> = {}): ScalperLeg => ({
  id: '302|INTRADAY', securityId: '302', product: 'INTRADAY', symbol: 'NIFTY-Dec2026-25350-CE', strike: 25350, type: 'CE',
  netQty: 65, avg: 200, ltp: 210, sim: false, ...o,
});
const ord = (o: Record<string, unknown>) => ({ id: 'O1', securityId: '302', side: 'SELL', orderType: 'LIMIT', price: 250, trigger: null, ...o }) as never;

test('brackets: SIM levels first; else this contract\'s closing orders, a stop = SL and a limit = TP', () => {
  assert.deepEqual(premiumBracketsFor(leg(), [], { tp: 240, sl: 180 }), { tp: { price: 240, sim: true }, sl: { price: 180, sim: true } });
  const b = premiumBracketsFor(leg(), [ord({}), ord({ id: 'O2', orderType: 'STOP_LOSS_MARKET', price: null, trigger: 185 })]);
  assert.deepEqual(b, { tp: { price: 250, orderId: 'O1', sim: false }, sl: { price: 185, orderId: 'O2', sim: false } });
  // another contract, the opening side, or no price: ignored
  assert.deepEqual(premiumBracketsFor(leg(), [ord({ securityId: '303' }), ord({ side: 'BUY' }), ord({ price: null })]), {});
  // a short closes with BUY orders
  assert.equal(premiumBracketsFor(leg({ netQty: -65 }), [ord({ side: 'BUY', orderType: 'SL-M', price: null, trigger: 240 })]).sl?.price, 240);
});

test('validation: right side of the LIVE premium, on the tick, positive; no live premium = refuse', () => {
  assert.equal(premiumBracketError('TP', 250, true, 210, 0.05), null);
  assert.equal(premiumBracketError('SL', 180, true, 210, 0.05), null);
  assert.match(premiumBracketError('TP', 200, true, 210, 0.05)!, /above the live premium/);
  assert.match(premiumBracketError('SL', 220, true, 210, 0.05)!, /below the live premium/);
  assert.equal(premiumBracketError('TP', 180, false, 210, 0.05), null); // short: target below
  assert.match(premiumBracketError('SL', 200, false, 210, 0.05)!, /above the live premium/);
  assert.match(premiumBracketError('TP', 250.03, true, 210, 0.05)!, /tick/);
  assert.match(premiumBracketError('TP', 0, true, 210, 0.05)!, /above 0/);
  assert.match(premiumBracketError('TP', 250, true, null, 0.05)!, /No live premium/);
  assert.match(premiumBracketError('TP', 210, true, 210, 0.05)!, /above the live premium/);
});

test('P&L at a level, snapping, default levels', () => {
  assert.equal(premiumPnlAt(250, 200, 65, true), 3250);
  assert.equal(premiumPnlAt(250, 200, 65, false), -3250);
  assert.equal(snapPremium(250.03, 0.05), 250.05);
  assert.equal(snapPremium(7505.17, 1), 7505);
  assert.equal(defaultPremiumLevel('TP', true, 210, 200, 0.05), 252);
  assert.equal(defaultPremiumLevel('SL', true, 210, 200, 0.05), 168);
  assert.equal(defaultPremiumLevel('TP', false, 210, 200, 0.05), 168); // short target below
  assert.equal(defaultPremiumLevel('SL', true, 210, 200, 0.05, 190), 190); // the existing level
  assert.equal(defaultPremiumLevel('TP', true, null, 0, 0.05), null);
});

test('leg P&L from premiums only: null without a live premium', () => {
  assert.deepEqual(legPremiumPnl(leg()), { pnl: 650, pct: 5 });
  const s = legPremiumPnl(leg({ netQty: -65 }))!;
  assert.equal(s.pnl, -650);
  assert.equal(s.pct, -5);
  assert.equal(legPremiumPnl(leg({ ltp: null })), null);
});
