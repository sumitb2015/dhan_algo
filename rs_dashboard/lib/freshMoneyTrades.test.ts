import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPositions, closeQty, contractHold, dueForCheck, effectiveState, nextCheckDelay, sessionGate, slices, stateFromBroker,
  unconfirmedQty, inFlightReducing, contractSettling, reconcileDownQty, UNCONFIRMED_COUNT_MS, RECONCILE_GRACE_MS, hhmmToMin, sessionMessage, NSE_WINDOW, SENDING_STALE_MS, UNKNOWN_HOLD_MS, PENDING_HOLD_MS, type FmOrder,
} from './freshMoneyTrades.ts';

let n = 0;
const ord = (p: Partial<FmOrder>): FmOrder => ({
  id: `o${++n}`, ts: n * 1000, underlying: 'NIFTY', expiry: '2026-11-17', strike: 25000, opt: 'CE', securityId: '111',
  lot: 65, side: 'BUY', qty: 65, close: false, correlationId: `fm${n}aaaaaaa`, orderId: `X${n}`, state: 'filled',
  filledQty: 65, avgPrice: 100, ...p,
});

test('long position: average cost and live P&L', () => {
  const pos = buildPositions([ord({ avgPrice: 100 }), ord({ avgPrice: 110 })], { '111': 120 }, 1e6);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].netQty, 130);
  assert.equal(pos[0].avgPrice, 105);
  assert.equal(pos[0].unrealised, 15 * 130);
  assert.equal(pos[0].pnl, 15 * 130);
});

test('short then partial cover books realised P&L on the covered units', () => {
  const pos = buildPositions([
    ord({ side: 'SELL', qty: 130, filledQty: 130, avgPrice: 200 }),
    ord({ side: 'BUY', qty: 65, filledQty: 65, avgPrice: 150 }),
  ], { '111': 160 }, 1e6)[0];
  assert.equal(pos.netQty, -65);
  assert.equal(pos.realised, 50 * 65);
  assert.equal(pos.avgPrice, 200);
  assert.equal(pos.unrealised, (160 - 200) * -65);
  assert.equal(pos.pnl, 50 * 65 + 40 * 65);
});

test('a reversal through flat opens the remainder at the reversing price', () => {
  const pos = buildPositions([
    ord({ side: 'BUY', qty: 65, filledQty: 65, avgPrice: 100 }),
    ord({ side: 'SELL', qty: 195, filledQty: 195, avgPrice: 90 }),
  ], {}, 1e6)[0];
  assert.equal(pos.netQty, -130);
  assert.equal(pos.realised, -10 * 65);
  assert.equal(pos.avgPrice, 90);
  assert.equal(pos.unrealised, null, 'no LTP: unknown, not 0');
  assert.equal(pos.pnl, null);
});

test('unfilled, rejected and pending orders add no quantity', () => {
  const pos = buildPositions([
    ord({ state: 'rejected', filledQty: 0, avgPrice: null }),
    ord({ state: 'pending', filledQty: 0, avgPrice: null }),
  ], { '111': 50 }, 1e6)[0];
  assert.equal(pos.netQty, 0);
  assert.equal(pos.pnl, 0);
});

test('a fill with no price yet keeps the quantity and makes the basis unknown, never 0', () => {
  const pos = buildPositions([ord({ avgPrice: 100 }), ord({ avgPrice: null })], { '111': 120 }, 1e6)[0];
  assert.equal(pos.netQty, 130);
  assert.equal(pos.avgPrice, null);
  assert.equal(pos.pnl, null);
});

test('partial fill counts only the filled units', () => {
  const pos = buildPositions([ord({ qty: 650, filledQty: 130, state: 'partial', avgPrice: 100 })], { '111': 101 }, 1e6)[0];
  assert.equal(pos.netQty, 130);
  assert.equal(pos.unrealised, 130);
});

test('broker statuses map to ledger states; filled only once quantity AND price are known', () => {
  assert.equal(stateFromBroker('TRADED', 65, 65, 100), 'filled');
  assert.equal(stateFromBroker('TRADED', 0, 65, 100), 'partial', 'TRADED with no filledQty must be read again');
  assert.equal(stateFromBroker('TRADED', 65, 65, null), 'partial', 'TRADED before the price lands must be read again');
  assert.equal(stateFromBroker('PART_TRADED', 10, 65, 100), 'partial');
  assert.equal(stateFromBroker('REJECTED', 0, 65, null), 'rejected');
  assert.equal(stateFromBroker('CANCELLED', 0, 65, null), 'cancelled');
  assert.equal(stateFromBroker('CANCELLED', 30, 65, 101), 'filled');
  assert.equal(stateFromBroker('CANCELLED', 30, 65, null), 'partial');
  assert.equal(stateFromBroker('TRANSIT', 0, 65, null), 'pending');
  assert.equal(stateFromBroker('PENDING', 0, 65, null), 'pending');
});

test('a stale sending record is unknown; unknown and pending orders hold the contract for a while', () => {
  const now = 1_000_000;
  const sending = ord({ ts: now - SENDING_STALE_MS - 1, state: 'sending', orderId: null, filledQty: 0, avgPrice: null });
  assert.equal(effectiveState(sending, now), 'unknown');
  assert.equal(contractHold([sending], '111', now), 'unknown');
  assert.equal(contractHold([sending], '111', now + UNKNOWN_HOLD_MS), null);
  assert.equal(contractHold([sending], '222', now), null);
  const pending = ord({ ts: now - 1000, state: 'pending', filledQty: 0, avgPrice: null });
  assert.equal(contractHold([pending], '111', now), 'pending');
  assert.equal(contractHold([pending], '111', now + PENDING_HOLD_MS), null);
});

test('square-off is clamped down to the broker, never up or the wrong way', () => {
  assert.equal(closeQty(130, null), 130);
  assert.equal(closeQty(130, 260), 130);
  assert.equal(closeQty(130, 65), 65);
  assert.equal(closeQty(130, -65), 0);
  assert.equal(closeQty(-130, -65), 65);
  assert.equal(closeQty(-130, 0), 0);
});

test('large closes are sliced under the per-order lot cap', () => {
  assert.deepEqual(slices(65 * 45, 65, 20), [1300, 1300, 325]);
  assert.deepEqual(slices(65, 65, 20), [65]);
});

test('an unpriced opening fill keeps the round trip unknown after the position goes flat (never a firm +0)', () => {
  const pos = buildPositions([
    ord({ side: 'BUY', avgPrice: null }),
    ord({ side: 'SELL', avgPrice: 120 }),
  ], {}, 1e6)[0];
  assert.equal(pos.netQty, 0);
  assert.equal(pos.realised, null);
  assert.equal(pos.pnl, null);
  // A later, fully priced trade on the same contract does not make the day's booked figure known again.
  const later = buildPositions([
    ord({ side: 'BUY', avgPrice: null }), ord({ side: 'SELL', avgPrice: 120 }),
    ord({ side: 'BUY', avgPrice: 100 }),
  ], { '111': 110 }, 1e6)[0];
  assert.equal(later.avgPrice, 100, 'the new open lot has a known basis');
  assert.equal(later.unrealised, 650);
  assert.equal(later.realised, null);
  assert.equal(later.pnl, null);
});

test('a close at an unknown price makes booked P&L unknown', () => {
  const pos = buildPositions([ord({ side: 'BUY', avgPrice: 100 }), ord({ side: 'SELL', avgPrice: null })], {}, 1e6)[0];
  assert.equal(pos.netQty, 0);
  assert.equal(pos.realised, null);
});

test('unconfirmed orders count toward exposure as if they fill', () => {
  const now = 1_000_000;
  const orders = [
    ord({ ts: now - 120_000, side: 'SELL', qty: 1300, filledQty: 0, state: 'unknown', orderId: null, avgPrice: null }),
    ord({ ts: now - 1_000, side: 'SELL', qty: 650, filledQty: 130, state: 'partial', avgPrice: 90 }),
    ord({ ts: now - 1_000, side: 'BUY', qty: 65, filledQty: 65, state: 'filled', avgPrice: 90 }),
    ord({ ts: now - 1_000, securityId: '999', side: 'BUY', qty: 65, filledQty: 0, state: 'pending', avgPrice: null }),
  ];
  assert.equal(unconfirmedQty(orders, '111', now), -(1300 + 520));
  assert.equal(unconfirmedQty(orders, '999', now), 65);
});

test('order re-reads are due oldest first, capped, with backoff', () => {
  const now = 1_000_000;
  const a = ord({ id: 'a', ts: 1, state: 'unknown', orderId: null, filledQty: 0, avgPrice: null });
  const b = ord({ id: 'b', ts: 2, state: 'pending', filledQty: 0, avgPrice: null });
  const c = ord({ id: 'c', ts: 3, state: 'pending', filledQty: 0, avgPrice: null });
  const done = ord({ id: 'd', ts: 0, state: 'filled' });
  const next = new Map([['b', now + 5_000]]);
  assert.deepEqual(dueForCheck([c, b, a, done], next, now, 2).map(o => o.id), ['a', 'c']);
  assert.deepEqual(dueForCheck([c, b, a, done], new Map(), now, 10).map(o => o.id), ['a', 'b', 'c']);
  assert.equal(nextCheckDelay(1), 4_000);
  assert.equal(nextCheckDelay(20), 60_000);
});

test('session gate: NSE opens 09:15-15:17 IST, closes only to 15:30, nothing on a holiday', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 10, h, m) - 19_800_000;
  assert.equal(sessionGate(at(9, 14), NSE_WINDOW), 'closed');
  assert.equal(sessionGate(at(9, 15), NSE_WINDOW), 'open');
  assert.equal(sessionGate(at(15, 16), NSE_WINDOW), 'open');
  assert.equal(sessionGate(at(15, 17), NSE_WINDOW), 'close-only');
  assert.equal(sessionGate(at(15, 29), NSE_WINDOW), 'close-only');
  assert.equal(sessionGate(at(15, 30), NSE_WINDOW), 'closed');
  assert.equal(sessionGate(at(11, 0), null), 'closed');
  assert.match(sessionMessage('closed', null, 'NSE')!, /closed today/);
  assert.equal(sessionMessage('open', NSE_WINDOW, 'NSE'), null);
});

test('session gate: an MCX window runs into the evening', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 12, h, m) - 19_800_000;
  const mcx = { open: hhmmToMin(900), cutoff: hhmmToMin(2340), close: hhmmToMin(2355) };
  assert.equal(sessionGate(at(8, 59), mcx), 'closed');
  assert.equal(sessionGate(at(9, 0), mcx), 'open');
  assert.equal(sessionGate(at(18, 30), mcx), 'open');
  assert.equal(sessionGate(at(23, 40), mcx), 'close-only');
  assert.equal(sessionGate(at(23, 55), mcx), 'closed');
  assert.equal(sessionMessage('close-only', mcx, 'MCX'), 'After 23:40 IST: closing only (×), no new positions');
  assert.equal(sessionMessage('closed', mcx, 'MCX'), 'MCX closed — orders are taken 09:00-23:55 IST');
});

test('MCX P&L: quantity is lots, rupees scale by barrels per lot', () => {
  const mcx = { segment: 'MCX_COMM' as const, securityId: 'C1', lot: 1, mult: 10 };
  const pos = buildPositions([
    ord({ ...mcx, side: 'SELL', qty: 3, filledQty: 3, avgPrice: 200 }),
    ord({ ...mcx, side: 'BUY', qty: 1, filledQty: 1, avgPrice: 190 }),
  ], { C1: 195 }, 1e6)[0];
  assert.equal(pos.segment, 'MCX_COMM');
  assert.equal(pos.netQty, -2);                    // 2 lots short
  assert.equal(pos.realised, 10 * 1 * 10);          // 10 points x 1 lot x 10 barrels
  assert.equal(pos.unrealised, (195 - 200) * -2 * 10);
  // CRUDEOIL: 100 barrels per lot
  const big = buildPositions([ord({ ...mcx, securityId: 'C2', mult: 100, side: 'BUY', qty: 1, filledQty: 1, avgPrice: 300 })], { C2: 304 }, 1e6)[0];
  assert.equal(big.pnl, 400);
});

test('records written before MCX support read as NSE with multiplier 1', () => {
  const o = ord({ avgPrice: 100 });
  delete (o as Partial<FmOrder>).segment;
  delete (o as Partial<FmOrder>).mult;
  const pos = buildPositions([o], { '111': 101 }, 1e6)[0];
  assert.equal(pos.segment, 'NSE_FNO');
  assert.equal(pos.mult, 1);
  assert.equal(pos.unrealised, 65);
});

test('a close already in flight is not sent twice (× sizes only what is left)', () => {
  const now = 1_000_000;
  const orders = [
    ord({ ts: now - 300_000, side: 'BUY', qty: 130, filledQty: 130, avgPrice: 100 }),
    // the first × went out; its confirmation is slow (still pending)
    ord({ ts: now - 45_000, side: 'SELL', qty: 130, filledQty: 0, state: 'pending', avgPrice: null, close: true }),
  ];
  assert.equal(inFlightReducing(orders, '111', 130, now), 130);
  // part confirmed: only the unfilled rest is in flight
  orders[1] = { ...orders[1], filledQty: 65, state: 'partial', avgPrice: 101 };
  assert.equal(inFlightReducing(orders, '111', 65, now), 65);
  // an adding order on the same side is not a reduction
  assert.equal(inFlightReducing([ord({ ts: now - 1000, side: 'BUY', state: 'pending', filledQty: 0, avgPrice: null })], '111', 130, now), 0);
  // after the count window the broker clamp takes over
  assert.equal(inFlightReducing(orders, '111', 65, now + UNCONFIRMED_COUNT_MS), 0);
});

test('unconfirmed exposure stops counting after the window (an UNKNOWN never resolved cannot block forever)', () => {
  const now = 1_000_000;
  const o = ord({ ts: now - 1_000, state: 'unknown', orderId: null, filledQty: 0, avgPrice: null });
  assert.equal(unconfirmedQty([o], '111', now), 65);
  assert.equal(unconfirmedQty([o], '111', now + UNCONFIRMED_COUNT_MS), 0);
});

test('down-only reconcile: reduce to what the broker holds, never up, never while settling', () => {
  assert.equal(reconcileDownQty(130, 0, false), 130);       // auto square-off: all gone
  assert.equal(reconcileDownQty(130, 65, false), 65);       // half closed elsewhere
  assert.equal(reconcileDownQty(130, 260, false), 0);       // broker holds more (another desk): never adopt it
  assert.equal(reconcileDownQty(-130, 65, false), 130);     // broker now long: our short is gone
  assert.equal(reconcileDownQty(-130, -65, false), 65);
  assert.equal(reconcileDownQty(130, null, false), 0);      // positions read failed
  assert.equal(reconcileDownQty(130, 0, true), 0);          // settling
  assert.equal(reconcileDownQty(0, 0, false), 0);
});

test('a contract is settling right after an order and while one is unconfirmed', () => {
  const now = 1_000_000;
  assert.equal(contractSettling([ord({ ts: now - 5_000 })], '111', now), true);
  assert.equal(contractSettling([ord({ ts: now - RECONCILE_GRACE_MS - 1 })], '111', now), false);
  assert.equal(contractSettling([ord({ ts: now - 60_000, state: 'pending', filledQty: 0, avgPrice: null })], '111', now), true);
  assert.equal(contractSettling([ord({ ts: now - 60_000, state: 'pending', filledQty: 0, avgPrice: null })], '222', now), false);
});

test('an external (reconciled) close flattens the position and makes booked P&L unknown', () => {
  const pos = buildPositions([
    ord({ side: 'BUY', qty: 130, filledQty: 130, avgPrice: 100 }),
    ord({ side: 'SELL', qty: 130, filledQty: 130, avgPrice: null, external: true, close: true, orderId: null }),
  ], { '111': 120 }, 1e6)[0];
  assert.equal(pos.netQty, 0);
  assert.equal(pos.realised, null);
  assert.equal(pos.pnl, null);
});
