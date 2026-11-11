import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGlobalAmount, parseGlobalDraft, stepGlobalAmount, totalPnl, globalBreach, nextGlobalAction, globalAfterClose,
  closeOrder, mustStopAfter, type FmGlobalExit,
} from './freshMoneyGlobalExit.ts';

const G = (o: Partial<FmGlobalExit> = {}): FmGlobalExit => ({ target: 5000, sl: 3000, armedAt: 0, state: 'watching', ...o });

test('amount validation', () => {
  assert.equal(validateGlobalAmount(null), null);
  assert.equal(validateGlobalAmount(''), null);
  assert.equal(validateGlobalAmount(2500), 2500);
  assert.ok('error' in (validateGlobalAmount(0) as object));
  assert.ok('error' in (validateGlobalAmount(-5) as object));
  assert.ok('error' in (validateGlobalAmount('5') as object));
  assert.ok('error' in (validateGlobalAmount(1e12) as object));
});

test('draft parsing never rewrites a bad value', () => {
  assert.equal(parseGlobalDraft(' '), null);
  assert.equal(parseGlobalDraft('5,000'), 5000);
  assert.ok('error' in (parseGlobalDraft('-5') as object));
  assert.ok('error' in (parseGlobalDraft('1e9') as object));
});

test('stepper', () => {
  assert.equal(stepGlobalAmount(null, 1), 500);
  assert.equal(stepGlobalAmount(null, -1), null);
  assert.equal(stepGlobalAmount(500, -1), null);
  assert.equal(stepGlobalAmount(1000, 1), 1500);
});

test('total is unknown when any P&L is unknown or an order is in flight', () => {
  assert.equal(totalPnl([{ pnl: 100, busy: null }, { pnl: -40, busy: null }]), 60);
  assert.equal(totalPnl([{ pnl: 100, busy: null }, { pnl: null, busy: null }]), null);
  assert.equal(totalPnl([{ pnl: 100, busy: 'pending' }]), null);
  assert.equal(totalPnl([]), 0);
});

test('breach: SL on the loss side, target on the profit side, SL wins a tie, unknown never', () => {
  assert.equal(globalBreach(-3000, G()), 'sl');
  assert.equal(globalBreach(-2999, G()), null);
  assert.equal(globalBreach(5000, G()), 'target');
  assert.equal(globalBreach(null, G()), null);
  assert.equal(globalBreach(-9999, G({ sl: null })), null);
});

test('fires only on the second consecutive breaching tick, with open positions', () => {
  const a1 = nextGlobalAction(G(), -3500, 2, null, 1000);
  assert.equal(a1.kind, 'streak');
  const s = (a1 as { streak: { level: 'target' | 'sl'; count: number; at: number } }).streak;
  assert.deepEqual(nextGlobalAction(G(), -3500, 2, s, 3000), { kind: 'fire', level: 'sl' });
  assert.deepEqual(nextGlobalAction(G(), -3500, 2, s, 20000), { kind: 'streak', streak: { level: 'sl', count: 1, at: 20000 } });
  assert.deepEqual(nextGlobalAction(G(), -3500, 0, null, 1000), { kind: 'streak', streak: null });
  assert.deepEqual(nextGlobalAction(G(), null, 2, null, 1000), { kind: 'streak', streak: null });
  assert.deepEqual(nextGlobalAction(G({ state: 'sent' }), -9999, 2, null, 1000), { kind: 'none' });
  assert.deepEqual(nextGlobalAction(G({ retryAt: 5000 }), -9999, 2, null, 1000), { kind: 'streak', streak: null });
});

test('a firing record goes unknown when stale', () => {
  assert.equal(nextGlobalAction(G({ state: 'firing', firedAt: 0 }), 0, 1, null, 10_000).kind, 'none');
  assert.equal(nextGlobalAction(G({ state: 'firing', firedAt: 0 }), 0, 1, null, 200_000).kind, 'mark-unknown');
});

test('outcome mapping', () => {
  const ok = { kind: 'placed', orderId: '1' } as const;
  const ref = { kind: 'refused', error: 'x', http: 409 } as const;
  assert.equal(globalAfterClose([ok, ok], 'sl', 1).state, 'sent');
  assert.equal(globalAfterClose([ref], 'sl', 1).state, 'watching');
  assert.equal(globalAfterClose([ok, ref], 'sl', 1).state, 'incomplete');
  assert.equal(globalAfterClose([ok, { kind: 'unknown', error: 'u', partial: false }], 'sl', 1).state, 'unknown');
  assert.equal(globalAfterClose([{ kind: 'rejected', error: 'r', http: 400 }], 'sl', 1).state, 'rejected');
});

test('shorts close first and a failed short cover stops the hedges', () => {
  const o = closeOrder([{ netQty: 50 }, { netQty: -50 }, { netQty: 25 }, { netQty: -25 }]);
  assert.deepEqual(o.map(p => p.netQty), [-50, -25, 50, 25]);
  assert.equal(mustStopAfter({ netQty: -50 }, { kind: 'refused', error: 'x', http: 409 }), true);
  assert.equal(mustStopAfter({ netQty: -50 }, { kind: 'placed', orderId: '1' }), false);
  assert.equal(mustStopAfter({ netQty: 50 }, { kind: 'refused', error: 'x', http: 409 }), false);
});
