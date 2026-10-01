import { test } from 'node:test';
import assert from 'node:assert';
import {
  reconstructCallLedger, reconcileCallsDown, beesNiftyUnits, computeBook, suggestCoveredCall,
  fillIncrement, reservedBuyUnits,
  type CallTrade, type PendingOrder,
} from './coveredCallEngine.ts';

const open = (id: string, ts: number, units: number, price: number, sid = '111', strike = 23500): CallTrade => ({
  id, ts, action: 'SELL_OPEN', strike, expiry: '2026-10-27', units, price, securityId: sid,
});

test('reconstructCallLedger: partial close keeps the remainder and books realized P&L', () => {
  const trades: CallTrade[] = [
    open('a', 1, 130, 100),
    { id: 'c', ts: 2, action: 'BUY_CLOSE', strike: 23500, expiry: '2026-10-27', units: 65, price: 40, securityId: '111', openLegId: 'a', realizedPnl: 3900 },
  ];
  const { open: legs, realized, premiumSold } = reconstructCallLedger(trades);
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].units, 65);
  assert.strictEqual(realized, 3900);
  assert.strictEqual(premiumSold, 13000);
});

test('reconcileCallsDown never grows a leg and shrinks the newest first', () => {
  const legs = reconstructCallLedger([open('old', 1, 65, 100), open('new', 2, 65, 90)]).open;
  const r = reconcileCallsDown(legs, { '111': 65 }, 1_000_000);
  assert.deepStrictEqual(r.legs.map((l) => l.units), [65, 0]);
  assert.strictEqual(r.clamped, true);
  const big = reconcileCallsDown(legs, { '111': 650 }, 1_000_000);
  assert.deepStrictEqual(big.legs.map((l) => l.units), [65, 65]);
});

test('reconcileCallsDown leaves the ledger alone when positions are unknown or inside the grace window', () => {
  const legs = reconstructCallLedger([open('a', 1_000, 65, 100)]).open;
  assert.strictEqual(reconcileCallsDown(legs, null, 2_000_000).legs[0].units, 65);
  assert.strictEqual(reconcileCallsDown(legs, {}, 5_000).legs[0].units, 65);
  assert.strictEqual(reconcileCallsDown(legs, {}, 2_000_000).legs[0].units, 0);
});

test('beesNiftyUnits measures the holding by value', () => {
  assert.ok(Math.abs(beesNiftyUnits(4500, 256.5, 22850) - 50.51) < 0.01);
  assert.strictEqual(beesNiftyUnits(4500, 0, 22850), 0);
});

test('computeBook: Greeks scale by units, short calls are negative, coverage uses Nifty units', () => {
  const calls = reconstructCallLedger([open('a', 1, 65, 100)]).open;
  const book = computeBook({
    beesQty: 4500, beesAvg: 260, beesLtp: 256.5, spot: 22850, callsRealized: 500,
    calls,
    marks: { a: { ltp: 80, dte: 20, chainLeg: { last_price: 80, greeks: { delta: 0.3, gamma: 0.001, theta: -5, vega: 10 } } } },
  });
  assert.ok(Math.abs(book.callDelta - -19.5) < 1e-9);
  assert.ok(Math.abs(book.net.delta - (book.beesUnits - 19.5)) < 1e-9);
  assert.ok(Math.abs(book.net.theta - 325) < 1e-9); // short call earns theta
  assert.ok(Math.abs(book.net.vega - -650) < 1e-9);
  assert.strictEqual(book.callsOpenPnl, 1300);
  assert.ok(Math.abs((book.beesPnl ?? 0) - -15750) < 1e-6);
  assert.ok(Math.abs((book.totalPnl ?? 0) - (-15750 + 1300 + 500)) < 1e-6);
  assert.ok(book.coverage! > 1.28 && book.coverage! < 1.29);
  assert.ok(book.uncoveredUnits > 14 && book.uncoveredUnits < 15);
});

test('computeBook: an all-zero-greeks leg is excluded from gamma/theta/vega but keeps an estimated delta', () => {
  const calls = reconstructCallLedger([open('a', 1, 65, 100)]).open;
  const book = computeBook({
    beesQty: 0, beesAvg: 0, beesLtp: 0, spot: 22850, callsRealized: 0, calls,
    marks: { a: { ltp: 80, dte: 20, chainLeg: { last_price: 80, greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 } } } },
  });
  assert.strictEqual(book.missingCount, 1);
  assert.strictEqual(book.net.theta, 0);
  assert.ok(book.callDelta < 0);
  assert.strictEqual(book.legs[0].deltaEstimated, true);
});

test('suggestCoveredCall picks the OTM strike nearest the target delta and floors covered lots', () => {
  const oc = {
    '22800.000000': { ce: { last_price: 300, greeks: { delta: 0.55 } } },
    '23000.000000': { ce: { last_price: 200, greeks: { delta: 0.42 } } },
    '23200.000000': { ce: { last_price: 120, greeks: { delta: 0.31 } } },
    '23400.000000': { ce: { last_price: 60, greeks: { delta: 0.18 } } },
  };
  const s = suggestCoveredCall(oc, 22850, 50.5, 65, 0.3, 20)!;
  assert.strictEqual(s.strike, 23200);
  assert.strictEqual(s.coveredLots, 0);
  assert.strictEqual(s.nearestLots, 1);
});

test('fillIncrement books only the new slice, at its own price, never at 0', () => {
  // 130 units: 65 filled @ 100 first, then the order's cumulative avg is 99 over 130.
  assert.deepStrictEqual(fillIncrement(0, 0, 65, 100), { units: 65, price: 100 });
  const inc = fillIncrement(65, 6500, 130, 99);
  assert.strictEqual(inc?.units, 65);
  assert.ok(Math.abs(inc!.price - 98) < 1e-9);
  assert.strictEqual(fillIncrement(65, 6500, 65, 100), null); // nothing new
  assert.strictEqual(fillIncrement(0, 0, 65, 0), null);       // Dhan has no avg yet
});

test('reservedBuyUnits counts only unbooked buy-backs of that leg', () => {
  const p = (id: string, side: 'BUY' | 'SELL', leg: string | undefined, units: number, booked: number): PendingOrder => ({
    id, orderId: id, side, securityId: '111', strike: 23500, expiry: '2026-10-27', tradingSymbol: 'x',
    units, openLegId: leg, bookedUnits: booked, bookedValue: 0, createdAt: 0,
  });
  const pending = [p('1', 'BUY', 'a', 130, 65), p('2', 'BUY', 'b', 65, 0), p('3', 'SELL', undefined, 65, 0)];
  assert.strictEqual(reservedBuyUnits(pending, 'a'), 65);
  assert.strictEqual(reservedBuyUnits(pending, 'c'), 0);
});

test('computeBook keeps the P&L of units the broker clamp removed', () => {
  const [leg] = reconstructCallLedger([open('a', 1, 130, 100)]).open;
  const r = reconcileCallsDown([leg], { '111': 65 }, 1_000_000);
  const book = computeBook({
    beesQty: 4500, beesAvg: 263, beesLtp: 265, spot: 23000,
    calls: r.legs, marks: { a: { ltp: 40, dte: 20 } }, callsRealized: 0,
  });
  assert.strictEqual(book.shortCallUnits, 65);
  assert.strictEqual(book.unsyncedUnits, 65);
  assert.strictEqual(book.callsUnsyncedPnl, 3900);
  assert.strictEqual(book.callsOpenPnl, 3900);
  assert.strictEqual(book.totalPnl, 9000 + 3900 + 3900);
});
