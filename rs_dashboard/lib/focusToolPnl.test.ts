/**
 * Focus Tool row P&L — strike-roll and partial-close cases.
 *
 * Reproduction for the morning bug: PREMIUM entry, then shift CE to a lower
 * strike while only part of the qty actually left the old strike. The pin
 * moved to the new strike, so leftover qty + realized on the old security
 * dropped out of the row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRowPnl, mtmForQty, ownShare, shiftMayReopen,
  canMarkMtm, shiftCloseConfirmed,
} from './focusToolPnl.ts';

test('mtmForQty: short leg profits when premium falls', () => {
  assert.equal(mtmForQty({
    netQty: -65, buyAvg: 0, sellAvg: 40, ltp: 30, qty: 65,
  }), 650);
});

test('mtmForQty: marks only the closed slice on a partial reduce', () => {
  // 2 lots short @ 40, close 1 lot while LTP is 30 → book +650 on the closed lot
  assert.equal(mtmForQty({
    netQty: -130, buyAvg: 0, sellAvg: 40, ltp: 30, qty: 65,
  }), 650);
});

test('ownShare apportions a netted broker position', () => {
  assert.equal(ownShare(65, 130), 0.5);
  assert.equal(ownShare(undefined, 130), 1);
  assert.equal(ownShare(0, 130), 1);
});

test('shiftMayReopen requires the full close — never a partial', () => {
  // 2 lots open, only 1 lot closed → must NOT reopen / move the pin
  assert.equal(shiftMayReopen(130, 65), false);
  assert.equal(shiftMayReopen(130, 130), true);
  assert.equal(shiftMayReopen(130, 0), false);
  // Over-report must not pass either (only exact full flat)
  assert.equal(shiftMayReopen(130, 195), false);
});

test('shiftMayReopen: full flat of this row share is enough even if others remain on the book', () => {
  // verifyLegClosed returns closedQty (= own 65) once remaining hit targetRemaining;
  // reopen is gated on that exact match, not on broker remaining === 0.
  assert.equal(shiftMayReopen(65, 65), true);
});

test('canMarkMtm refuses missing LTP or avg so bookedPnl cannot silently bank 0', () => {
  assert.equal(canMarkMtm({
    netQty: -65, buyAvg: 0, sellAvg: 40, ltp: 0, qty: 65,
  }), false);
  assert.equal(canMarkMtm({
    netQty: -65, buyAvg: 0, sellAvg: 0, ltp: 30, qty: 65,
  }), false);
  assert.equal(canMarkMtm({
    netQty: -65, buyAvg: 0, sellAvg: 40, ltp: 30, qty: 65,
  }), true);
});

test('shiftCloseConfirmed requires OUR fill AND book floor — not floor alone', () => {
  // Shared strike: book already at floor because someone else closed — our
  // fill is still 0 → must not reopen.
  assert.equal(shiftCloseConfirmed({
    requestedClose: 65, filled: 0, brokerQtyAfter: 65, targetRemaining: 65,
  }), false);
  // Our close filled fully and book at floor → ok
  assert.equal(shiftCloseConfirmed({
    requestedClose: 65, filled: 65, brokerQtyAfter: 65, targetRemaining: 65,
  }), true);
  // Our fill complete but book still above floor → not yet
  assert.equal(shiftCloseConfirmed({
    requestedClose: 65, filled: 65, brokerQtyAfter: 100, targetRemaining: 65,
  }), false);
  // Partial fill even if book looks right → no
  assert.equal(shiftCloseConfirmed({
    requestedClose: 130, filled: 65, brokerQtyAfter: 0, targetRemaining: 0,
  }), false);
});

test('computeRowPnl keeps booked P&L after a roll onto a new strike', () => {
  // Closed 65 @ old strike while short 40 → LTP 30: booked +650.
  // New strike pin still short 65 @ 35, LTP 32: live MTM +195.
  // Without bookedPnl the row would only show +195 and "lose" the roll.
  const pnl = computeRowPnl(650, [{
    netQty: -65, buyAvg: 0, sellAvg: 35, ltp: 32,
    unrealizedProfit: 195, ownQty: 65,
  }]);
  assert.equal(pnl, 650 + 195);
});

test('computeRowPnl: partial roll leftover must stay on the old pin (no reopen)', () => {
  // User had 130 short @ 40. Close only 65 (booked +650 at LTP 30). Pin must
  // remain on the OLD strike with ownQty 65 — row still sees the leftover.
  const booked = mtmForQty({
    netQty: -130, buyAvg: 0, sellAvg: 40, ltp: 30, qty: 65,
  });
  assert.equal(booked, 650);
  assert.equal(shiftMayReopen(130, 65), false);

  const pnl = computeRowPnl(booked, [{
    netQty: -65, buyAvg: 0, sellAvg: 40, ltp: 28,
    unrealizedProfit: 780, ownQty: 65,
  }]);
  // booked 650 + live MTM on remaining 65 @ 28 = (40-28)*65 = 780 → 1430
  assert.equal(pnl, 1430);
});

test('computeRowPnl falls back to broker unrealized when LTP is missing', () => {
  const pnl = computeRowPnl(100, [{
    netQty: -65, buyAvg: 0, sellAvg: 40, ltp: null,
    unrealizedProfit: 500, ownQty: 65,
  }]);
  assert.equal(pnl, 600);
});
