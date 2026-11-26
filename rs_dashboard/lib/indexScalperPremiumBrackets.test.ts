import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPremiumLevel, optionStopLimit, placedOrderState, legPremiumPnl, parseBracketInput, premiumBracketError, premiumBracketsFor, premiumPnlAt, snapPremium } from './indexScalperPremiumBrackets.ts';
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

  // a stop-LIMIT is drawn at its trigger, never its limit: Dhan BUY STOP_LOSS trigger 82.00 / limit 86.10 (2026-11-26),
  // shown at 86.10 before the fix; Kotak's 'SL' the same
  assert.equal(premiumBracketsFor(leg({ netQty: -130 }), [ord({ side: 'BUY', orderType: 'STOP_LOSS', price: 86.1, trigger: 82 })]).sl?.price, 82);
  assert.equal(premiumBracketsFor(leg({ netQty: -130 }), [ord({ side: 'BUY', orderType: 'SL', price: 86.1, trigger: 82 })]).sl?.price, 82);
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

test('TP / SL box: a premium, or a % of the entry premium (ending in %) on the side that kind needs', () => {
  // long, entry 200: target +20% = 240, stop 20% = 160
  assert.deepEqual(parseBracketInput('20%', 'TP', true, 200, 0.05), { price: 240, pct: 20, error: null });
  assert.deepEqual(parseBracketInput(' 20 % ', 'SL', true, 200, 0.05), { price: 160, pct: 20, error: null });
  // short, entry 200: target is BELOW entry, stop above
  assert.equal(parseBracketInput('25%', 'TP', false, 200, 0.05).price, 150);
  assert.equal(parseBracketInput('25%', 'SL', false, 200, 0.05).price, 250);
  // snapped to the tick (0.05 NSE, 0.10 crude)
  assert.equal(parseBracketInput('10%', 'TP', true, 123.45, 0.05).price, 135.8);
  assert.equal(parseBracketInput('10%', 'TP', true, 123.45, 0.1).price, 135.8);
  // a plain number stays a premium (tick check is premiumBracketError's)
  assert.deepEqual(parseBracketInput('245.5', 'TP', true, 200, 0.05), { price: 245.5, pct: null, error: null });
  // refusals: no number, 0 / negative %, a stop 100 % below entry, no entry premium
  assert.notEqual(parseBracketInput('', 'TP', true, 200, 0.05).error, null);
  assert.notEqual(parseBracketInput('abc', 'TP', true, 200, 0.05).error, null);
  assert.notEqual(parseBracketInput('%', 'TP', true, 200, 0.05).error, null);
  assert.notEqual(parseBracketInput('0%', 'TP', true, 200, 0.05).error, null);
  assert.notEqual(parseBracketInput('-5%', 'SL', true, 200, 0.05).error, null);
  assert.notEqual(parseBracketInput('100%', 'SL', true, 200, 0.05).error, null); // long stop at 0
  assert.equal(parseBracketInput('150%', 'SL', false, 200, 0.05).price, 500); // a short's stop above entry has no cap
  assert.notEqual(parseBracketInput('20%', 'TP', true, 0, 0.05).error, null);
});

test('TP / SL box: plain decimals only, and a % never rounds onto (or past) the entry', () => {
  // Number() would read these as 1000 and 16
  for (const t of ['1e3', '0x10', '1e1%', '12abc', '1,5']) assert.notEqual(parseBracketInput(t, 'TP', true, 200, 0.05).error, null, t);
  assert.equal(parseBracketInput('.5', 'TP', true, 0.2, 0.05).price, 0.5);
  // cheap premium, entry 0.20, tick 0.05: 10% = 0.22 / 0.18 -> rounded AWAY from entry (0.25 / 0.15), never 0.20
  assert.equal(parseBracketInput('10%', 'TP', true, 0.2, 0.05).price, 0.25);
  assert.equal(parseBracketInput('10%', 'SL', true, 0.2, 0.05).price, 0.15);
  assert.equal(parseBracketInput('10%', 'TP', false, 0.2, 0.05).price, 0.15);
  // exact tick multiples stay put (no float drift up a tick)
  assert.equal(parseBracketInput('50%', 'TP', true, 0.2, 0.1).price, 0.3);
});

test('option stop = stop-limit with a 5% cushion beyond the trigger, on the tick (Kotak rejects SL-M on options)', () => {
  // the 2026-11-26 case: a short's BUY stop at 116.45
  assert.deepEqual(optionStopLimit('BUY', 116.45, 0.05), { price: 122.3, trigger: 116.45 });
  assert.deepEqual(optionStopLimit('SELL', 100, 0.05), { price: 95, trigger: 100 });
  // never closer than one tick, never below one tick
  assert.deepEqual(optionStopLimit('BUY', 0.5, 0.05), { price: 0.55, trigger: 0.5 });
  assert.deepEqual(optionStopLimit('SELL', 0.1, 0.05), { price: 0.05, trigger: 0.1 });
  assert.deepEqual(optionStopLimit('SELL', 0.05, 0.05), { price: 0.05, trigger: 0.05 });
  // MCX crude option tick 0.10
  assert.deepEqual(optionStopLimit('BUY', 50, 0.1), { price: 52.5, trigger: 50 });
  for (const t of [0.05, 0.1]) for (const trg of [1.15, 7.35, 33.3, 245.5]) {
    const b = optionStopLimit('BUY', trg, t), s = optionStopLimit('SELL', trg, t);
    assert.ok(b.price > b.trigger && s.price < s.trigger, `${trg}/${t}`);
    assert.equal(snapPremium(b.price, t), b.price);
    assert.equal(snapPremium(s.price, t), s.price);
  }
});

test('placed order state from the order book: RMS rejection after an accepted reply is caught', () => {
  const book = [
    { orderId: 'K1', orderStatus: 'REJECTED', reason: 'RMS:Blocked ... STOP LOSS MARKET ORDER NOT ALLOWED IN OPTIONS' },
    { orderId: 'D1', orderStatus: 'REJECTED', omsErrorDescription: '' },
    { orderId: 'K2', orderStatus: 'CANCELLED' },
    { orderId: 'D2', orderStatus: 'PENDING' },
    { orderId: 'D3', orderStatus: 'TRADED' },
    { orderId: 'K3', orderStatus: 'OPEN', reason: '--' },
  ];
  assert.deepEqual(placedOrderState(book, 'K1'), { state: 'rejected', reason: 'RMS:Blocked ... STOP LOSS MARKET ORDER NOT ALLOWED IN OPTIONS' });
  assert.deepEqual(placedOrderState(book, 'D1'), { state: 'rejected', reason: 'no reason given' });
  assert.equal(placedOrderState(book, 'K2').state, 'cancelled');
  assert.equal(placedOrderState(book, 'D2').state, 'live');
  assert.equal(placedOrderState(book, 'D3').state, 'live');
  assert.equal(placedOrderState(book, 'K3').state, 'live');
  assert.equal(placedOrderState(book, 'nope').state, 'missing');
});
