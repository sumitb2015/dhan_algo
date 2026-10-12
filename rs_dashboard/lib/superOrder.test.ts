import { test } from 'node:test';
import assert from 'node:assert';
import { buildPlacePayload, validateModify, validateSuperOrder, type SuperOrderInput } from './superOrder.ts';

const buy: SuperOrderInput = {
  securityId: '12345', exchangeSegment: 'NSE_FNO', side: 'BUY', productType: 'INTRADAY',
  orderType: 'LIMIT', quantity: 75, price: 100, targetPrice: 120, stopLossPrice: 90,
};

test('a well-formed BUY and SELL bracket pass', () => {
  assert.strictEqual(validateSuperOrder(buy), null);
  assert.strictEqual(validateSuperOrder({ ...buy, side: 'SELL', targetPrice: 80, stopLossPrice: 110 }), null);
});

test('target/stop on the wrong side of entry are rejected', () => {
  assert.match(validateSuperOrder({ ...buy, stopLossPrice: 105 })!, /BUY needs/);
  assert.match(validateSuperOrder({ ...buy, side: 'SELL' })!, /SELL needs/);
});

test('MARKET entry validates against refPrice and needs one', () => {
  const mkt = { ...buy, orderType: 'MARKET', price: undefined };
  assert.match(validateSuperOrder(mkt)!, /refPrice/);
  assert.strictEqual(validateSuperOrder({ ...mkt, refPrice: 100 }), null);
  assert.strictEqual(buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1').price, 100);   // never 0: Dhan's SDK refuses it
  assert.ok(!('refPrice' in buildPlacePayload({ ...mkt, refPrice: 100 }, 'c1')));
});

test('quantity, product, segment and security id are enforced', () => {
  assert.match(validateSuperOrder({ ...buy, quantity: 0 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 7.5 })!, /quantity/i);
  assert.match(validateSuperOrder({ ...buy, quantity: 99999 })!, /cap/);
  assert.match(validateSuperOrder({ ...buy, productType: 'CO' })!, /productType/);
  assert.match(validateSuperOrder({ ...buy, exchangeSegment: 'IDX_I' })!, /exchangeSegment/);
  assert.match(validateSuperOrder({ ...buy, exchangeSegment: 'NSE_EQ' })!, /exchangeSegment/);   // equity bypasses equity-order's caps
  assert.match(validateSuperOrder({ ...buy, securityId: 'NIFTY' })!, /securityId/);
});

test('trailing jump must be smaller than the stop distance', () => {
  assert.strictEqual(validateSuperOrder({ ...buy, trailingJump: 5 }), null);
  assert.match(validateSuperOrder({ ...buy, trailingJump: 10 })!, /trailingJump/);
  assert.match(validateSuperOrder({ ...buy, trailingJump: -1 })!, /trailingJump/);
});

test('each leg only accepts its own fields on modify', () => {
  assert.strictEqual(validateModify({ legName: 'TARGET_LEG', targetPrice: 125 }), null);
  assert.match(validateModify({ legName: 'ENTRY_LEG', price: 101 })!, /orderType/);
  assert.strictEqual(validateModify({ legName: 'ENTRY_LEG', orderType: 'LIMIT', price: 101 }), null);
  assert.match(validateModify({ legName: 'TARGET_LEG', stopLossPrice: 95 })!, /cannot change/);
  assert.strictEqual(validateModify({ legName: 'STOP_LOSS_LEG', stopLossPrice: 95, trailingJump: 0 }), null);
  assert.match(validateModify({ legName: 'STOP_LOSS_LEG' })!, /Nothing/);
});

import { hasUnmatchableActive, legsToCancel, resolveBracket } from './superOrder.ts';

const tk = { securityId: '12345', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', quantity: 75, targetPts: 10, slPts: 8, trailPts: 0 };

test('resolveBracket: BUY and SELL levels around the LTP, tick-rounded', () => {
  const b = resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 100.07 });
  assert.ok(b.ok);
  assert.deepStrictEqual([b.order.refPrice, b.order.targetPrice, b.order.stopLossPrice], [100.05, 110.05, 92.05]);
  const s = resolveBracket({ ...tk, side: 'SELL', orderType: 'LIMIT', limitPrice: 100, ltp: 90 });
  assert.ok(s.ok);
  assert.deepStrictEqual([s.order.price, s.order.targetPrice, s.order.stopLossPrice], [100, 90, 108]);
});

test('resolveBracket: refuses without a price, with a stop through zero, or a trail >= stop distance', () => {
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 0 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 5, slPts: 8 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'MARKET', ltp: 100, trailPts: 8 }).ok);
  assert.ok(!resolveBracket({ ...tk, side: 'BUY', orderType: 'LIMIT', ltp: 100 }).ok);
});

test('legsToCancel: live exit legs and an unfilled entry; terminal legs and other securities ignored', () => {
  const rows = [
    { orderId: '1', securityId: '12345', legDetails: [
      { legName: 'ENTRY_LEG', orderStatus: 'TRADED' },
      { legName: 'TARGET_LEG', orderStatus: 'PENDING' },
      { legName: 'STOP_LOSS_LEG', orderStatus: 'TRIGGER_PENDING' } ] },
    { orderId: '2', securityId: '12345', legDetails: [
      { legName: 'ENTRY_LEG', orderStatus: 'PENDING' },
      { legName: 'TARGET_LEG', orderStatus: 'CANCELLED' } ] },
    { orderId: '3', securityId: '999', legDetails: [{ legName: 'TARGET_LEG', orderStatus: 'PENDING' }] },
    { orderId: '4', securityId: '12345', orderStatus: 'PENDING' },
  ];
  assert.deepStrictEqual(legsToCancel(rows, '12345'), [
    { orderId: '1', leg: 'TARGET_LEG' }, { orderId: '1', leg: 'STOP_LOSS_LEG' },
    { orderId: '2', leg: 'ENTRY_LEG' }, { orderId: '4', leg: 'ENTRY_LEG' },
  ]);
});

test('hasUnmatchableActive flags a live row without a securityId, ignores finished ones', () => {
  assert.ok(hasUnmatchableActive([{ orderId: '9', orderStatus: 'PENDING' }]));
  assert.ok(!hasUnmatchableActive([{ orderId: '9', orderStatus: 'TRADED' }, { orderId: '8', securityId: '1', orderStatus: 'PENDING' }]));
});

// ─── bracketLevelsByContract / bracketsForRow / reuseUnchanged ────────────
import { bracketLevelsByContract, bracketRowKey, bracketsForRow, reuseUnchanged } from './superOrder.ts';

const L = (legName: string, orderStatus: string, extra: Record<string, unknown> = {}) => ({ legName, orderStatus, ...extra });

test('bracketLevelsByContract: resting exit legs give levels; finished legs and other states show none', () => {
  const rows = [
    { orderId: '1', securityId: '111', productType: 'MARGIN', targetPrice: 120.5, stopLossPrice: '80', trailingJump: 2,
      legDetails: [L('ENTRY_LEG', 'TRADED'), L('TARGET_LEG', 'PENDING'), L('STOP_LOSS_LEG', 'TRIGGER_PENDING')] },
    { orderId: '2', securityId: '222', targetPrice: 50, stopLossPrice: 30,
      legDetails: [L('ENTRY_LEG', 'TRADED'), L('TARGET_LEG', 'TRADED'), L('STOP_LOSS_LEG', 'PENDING')] },
    { orderId: '3', securityId: '333', targetPrice: 50, stopLossPrice: 30, legDetails: [L('TARGET_LEG', 'CANCELLED'), L('STOP_LOSS_LEG', 'TRADED')] },
    { orderId: '4', securityId: '444', orderStatus: 'PENDING' },
    { orderId: '5', legDetails: [L('TARGET_LEG', 'PENDING')], targetPrice: 9 },
  ];
  assert.deepStrictEqual(bracketLevelsByContract(rows), {
    '111|MARGIN': [{ orderId: '1', productType: 'MARGIN', entryPending: false, target: 120.5, stop: 80, trail: 2 }],
    '222|': [{ orderId: '2', productType: null, entryPending: false, target: null, stop: 30, trail: null }],
  });
});

test('levels prefer the leg\'s own price (what a trailing stop moves) over the order-level original', () => {
  const rows = [{ orderId: '1', securityId: '9', stopLossPrice: 80, targetPrice: 120, trailingJump: 2,
    legDetails: [L('TARGET_LEG', 'PENDING', { price: 118 }), L('STOP_LOSS_LEG', 'TRIGGER_PENDING', { triggerPrice: 88.5, trailingJump: 1.5 })] }];
  assert.deepStrictEqual(bracketLevelsByContract(rows)['9|'], [{ orderId: '1', productType: null, entryPending: false, target: 118, stop: 88.5, trail: 1.5 }]);
});

test('falls back to the order-level prices, rejects junk, keeps several brackets on one contract', () => {
  const rows = [
    { orderId: '1', securityId: '9', targetPrice: 77, stopLossPrice: '55.5', legDetails: [L('TARGET_LEG', 'PENDING'), L('STOP_LOSS_LEG', 'PENDING')] },
    { orderId: '2', securityId: '9', targetPrice: 0, stopLossPrice: 'abc', legDetails: [L('TARGET_LEG', 'OPEN'), L('STOP_LOSS_LEG', 'PENDING')] },
  ];
  assert.deepStrictEqual(bracketLevelsByContract(rows)['9|'], [
    { orderId: '1', productType: null, entryPending: false, target: 77, stop: 55.5, trail: null },
    { orderId: '2', productType: null, entryPending: false, target: null, stop: null, trail: null },   // live but unreadable: null
  ]);
});

test('an unfilled ENTRY leg marks the bracket entryPending (its exits protect nothing yet)', () => {
  const rows = [{ orderId: '1', securityId: '9', targetPrice: 120, stopLossPrice: 80,
    legDetails: [L('ENTRY_LEG', 'PENDING'), L('TARGET_LEG', 'PENDING'), L('STOP_LOSS_LEG', 'PENDING')] },
    { orderId: '2', securityId: '9', targetPrice: 120, stopLossPrice: 80,
      legDetails: [L('ENTRY_LEG', 'PART_TRADED'), L('TARGET_LEG', 'PENDING')] }];
  const got = bracketLevelsByContract(rows)['9|'];
  assert.equal(got[0].entryPending, true);
  assert.equal(got[1].entryPending, true);
});

test('bracketsForRow matches the row\'s product, plus unlabeled brackets; another product never leaks in', () => {
  const rows = [
    { orderId: '1', securityId: '9', productType: 'INTRADAY', targetPrice: 120, stopLossPrice: 80, legDetails: [L('TARGET_LEG', 'PENDING')] },
    { orderId: '2', securityId: '9', productType: 'MARGIN', targetPrice: 130, stopLossPrice: 70, legDetails: [L('TARGET_LEG', 'PENDING')] },
    { orderId: '3', securityId: '9', targetPrice: 140, stopLossPrice: 60, legDetails: [L('TARGET_LEG', 'PENDING')] },
  ];
  const m = bracketLevelsByContract(rows);
  assert.deepStrictEqual(bracketsForRow(m, '9', 'INTRADAY')!.map(b => b.orderId), ['1', '3']);
  assert.deepStrictEqual(bracketsForRow(m, '9', 'margin')!.map(b => b.orderId), ['2', '3']);   // case-insensitive
  assert.deepStrictEqual(bracketsForRow(m, '9', 'CNC')!.map(b => b.orderId), ['3']);
  assert.equal(bracketsForRow(m, '8', 'MARGIN'), undefined);
  assert.equal(bracketsForRow(undefined, '9', 'MARGIN'), undefined);
  assert.equal(bracketRowKey(9, ' margin '), '9|MARGIN');
});

test('reuseUnchanged keeps previous arrays for untouched contracts and returns prev when nothing changed', () => {
  const b = (id: string, t: number) => ({ orderId: id, productType: null, entryPending: false, target: t, stop: 1, trail: null });
  const prev = { '1|': [b('a', 10)], '2|': [b('b', 20)] };
  const same = reuseUnchanged(prev, { '1|': [b('a', 10)], '2|': [b('b', 20)] });
  assert.equal(same, prev);
  const one = reuseUnchanged(prev, { '1|': [b('a', 10)], '2|': [b('b', 25)] });
  assert.notEqual(one, prev);
  assert.equal(one['1|'], prev['1|']);                    // untouched contract: same array (its row will not re-render)
  assert.notEqual(one['2|'], prev['2|']);
  assert.equal(reuseUnchanged(prev, {}) === prev, false);  // everything gone
  assert.deepStrictEqual(reuseUnchanged(prev, {}), {});
  assert.deepStrictEqual(reuseUnchanged({}, {}), {});
  const added = reuseUnchanged(prev, { ...prev, '3|': [b('c', 5)] });
  assert.equal(added['1|'], prev['1|']);
  assert.ok(added['3|']);
});
