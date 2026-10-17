import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterExit, exitPlan, stampPlacedLegs, EXIT_FLAT_GRACE_MS, type LegOrder } from './optionsMonitorOrders.ts';

const T0 = 1_792_000_000_000;
type TLeg = { id: string; strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; underlying?: string; expiry?: string; isEntered?: boolean; order?: LegOrder };
const leg = (over: Partial<TLeg> = {}): TLeg => ({ id: 'a', strike: 25100, type: 'CE', side: 'SELL', underlying: 'NIFTY', expiry: '2026-10-27', isEntered: false, ...over });
const placed = (over: Record<string, unknown> = {}) => ({
  strike: 25100, optionType: 'CE' as const, action: 'SELL' as const, qty: 65, productType: 'INTRADAY' as const,
  securityId: '', tradingSymbol: 'NIFTY26O2725100CE', exchangeSegment: 'nse_fo', ...over,
});
const B = { underlying: 'NIFTY', expiry: '2026-10-27' };

test('only the legs the ticket placed get an order record; an add on the same contract grows it', () => {
  const legs = [leg(), leg({ id: 'b', strike: 24900, type: 'PE' })];
  const out = stampPlacedLegs(legs, [placed()], 'kotak', B, B, T0);
  assert.deepEqual(out[0].order, { broker: 'kotak', qty: 65, productType: 'INTRADAY', ident: 'NIFTY26O2725100CE', exchange: 'nse_fo', at: T0 });
  assert.equal(out[0].isEntered, true);
  assert.equal(out[1], legs[1], 'the PE was not placed: untouched');
  const again = stampPlacedLegs(out, [placed({ qty: 130 })], 'kotak', B, B, T0 + 1);
  assert.equal(again[0].order!.qty, 195);
  // Another expiry's basket does not touch this leg.
  assert.equal(stampPlacedLegs(legs, [placed()], 'kotak', { ...B, expiry: '2026-11-03' }, B, T0)[0], legs[0]);
});

const order = (over: Partial<LegOrder> = {}): LegOrder => ({ broker: 'kotak', qty: 130, productType: 'INTRADAY', ident: 'NIFTY26O2725100CE', exchange: 'nse_fo', at: T0, ...over });
const row = (netQty: number, productType = 'MIS') => ({ tradingSymbol: 'NIFTY26O2725100CE', securityId: '777', productType, netQty });

test('exit closes min(own qty, broker qty) on the leg\'s own product, matched by Kotak symbol', () => {
  assert.deepEqual(exitPlan(order(), 'SELL', [row(-195)], T0 + 60_000), { kind: 'send', qty: 130, side: 'BUY' });
  assert.deepEqual(exitPlan(order(), 'SELL', [row(-65)], T0 + 60_000), { kind: 'send', qty: 65, side: 'BUY' });
  // NRML is another position: not this leg's.
  assert.deepEqual(exitPlan(order(), 'SELL', [row(-195, 'NRML')], T0 + 60_000), { kind: 'flat', lag: false });
  assert.deepEqual(exitPlan(order(), 'SELL', [row(65)], T0 + 60_000), { kind: 'opposite' });
  // Dhan matches by security id.
  assert.deepEqual(exitPlan(order({ broker: 'dhan', ident: '51321' }), 'BUY', [{ securityId: '51321', productType: 'INTRADAY', netQty: 65 }], T0 + 60_000),
    { kind: 'send', qty: 65, side: 'SELL' });
});

test('a flat book right after the order is lag, not a close', () => {
  assert.deepEqual(exitPlan(order(), 'SELL', [], T0 + 5_000), { kind: 'flat', lag: true });
  assert.deepEqual(exitPlan(order(), 'SELL', [], T0 + EXIT_FLAT_GRACE_MS + 1), { kind: 'flat', lag: false });
});

test('after an exit the remainder stays tracked; a full exit un-enters the leg', () => {
  const l = { ...leg({ isEntered: true }), order: order() };
  assert.equal(afterExit(l, 65, T0 + 1).order!.qty, 65);
  const done = afterExit(l, 130, T0 + 1);
  assert.equal(done.order, undefined);
  assert.equal(done.isEntered, false);
});
