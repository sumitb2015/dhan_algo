import { test } from 'node:test';
import assert from 'node:assert';
import {
  reconstructCallLedger, reconcileCallsDown, beesNiftyUnits, computeBook, suggestCoveredCall,
  fillIncrement, reservedBuyUnits, chainLegGreeks,
  type CallTrade, type PendingOrder,
} from './coveredCallEngine.ts';
import { greeksForLeg, priceOption, calculateTimeToExpiryYears, RISK_FREE_RATE } from './optionsPricing.ts';

// One pinned clock: the Greeks depend on the time to the 2026-10-27 expiry.
const NOW = Date.parse('2026-10-05T06:00:00Z');

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

test('computeBook: Greeks come from the central recipe, scale by units, short calls are negative, coverage uses Nifty units', () => {
  const calls = reconstructCallLedger([open('a', 1, 65, 100)]).open;
  const spot = 22850;
  const book = computeBook({
    beesQty: 4500, beesAvg: 260, beesLtp: 256.5, spot, callsRealized: 500, now: NOW,
    calls,
    // Dhan's own chain Greeks are deliberately absurd: they must be ignored.
    marks: { a: { ltp: 80, dte: 20, chainLeg: { last_price: 80, greeks: { delta: 0.99, gamma: 9, theta: -999, vega: 999 } } } },
  });
  const g = greeksForLeg({ type: 'CE', strike: 23500, expiry: '2026-10-27', mark: 80 }, { spot }, { now: NOW })!;
  assert.ok(Math.abs(book.callDelta - -65 * g.delta) < 1e-9);
  assert.ok(Math.abs(book.net.delta - (book.beesUnits - 65 * g.delta)) < 1e-9);
  assert.ok(book.net.theta > 0 && Math.abs(book.net.theta - -65 * g.theta) < 1e-9); // short call earns theta
  assert.ok(book.net.vega < 0 && Math.abs(book.net.vega - -65 * g.vega) < 1e-9);
  assert.ok(book.net.gamma < 0);
  assert.strictEqual(book.legs[0].deltaEstimated, false);
  assert.strictEqual(book.callsOpenPnl, 1300);
  assert.ok(Math.abs((book.beesPnl ?? 0) - -15750) < 1e-6);
  assert.ok(Math.abs((book.totalPnl ?? 0) - (-15750 + 1300 + 500)) < 1e-6);
  assert.ok(book.coverage! > 1.28 && book.coverage! < 1.29);
  assert.ok(book.uncoveredUnits > 14 && book.uncoveredUnits < 15);
});

test('computeBook rolls the monthly future to the call\'s own expiry', () => {
  const calls = reconstructCallLedger([open('a', 1, 65, 100)]).open;
  const base = { beesQty: 0, beesAvg: 0, beesLtp: 0, spot: 22850, callsRealized: 0, calls, now: NOW, marks: { a: { ltp: 80, dte: 22 } } };
  const synthetic = computeBook(base);
  const withFuture = computeBook({ ...base, future: { price: 22990, expiry: '2026-10-27' } });
  assert.ok(withFuture.callDelta !== synthetic.callDelta);           // a real future moves the forward, hence the delta
  const g = chainLegGreeks('CE', 23500, '2026-10-27', undefined, 80, { spot: 22850, future: { price: 22990, expiry: '2026-10-27' } }, NOW)!;
  assert.ok(Math.abs(withFuture.callDelta - -65 * g.delta) < 1e-9);
});

test('computeBook: a leg the recipe cannot price (no premium, no IV) is excluded from gamma/theta/vega but keeps an estimated delta', () => {
  const calls = reconstructCallLedger([open('a', 1, 65, 100)]).open;
  const book = computeBook({
    beesQty: 0, beesAvg: 0, beesLtp: 0, spot: 22850, callsRealized: 0, calls, now: NOW,
    marks: { a: { ltp: null, dte: 20 } },
  });
  assert.strictEqual(book.missingCount, 1);
  assert.strictEqual(book.net.theta, 0);
  assert.ok(book.callDelta < 0);
  assert.strictEqual(book.legs[0].deltaEstimated, true);
});

test('suggestCoveredCall picks the OTM strike nearest the target delta (model delta, not Dhan\'s) and floors covered lots', () => {
  const spot = 22850;
  const expiry = '2026-10-27';
  const T = calculateTimeToExpiryYears(expiry, NOW);
  const F = spot * Math.exp(RISK_FREE_RATE * T);
  // A chain priced at 14% vol, with Dhan's delta field deliberately wrong everywhere (0.99).
  const oc: Record<string, { ce: { last_price: number; implied_volatility: number; greeks: { delta: number } } }> = {};
  for (const k of [22800, 23000, 23200, 23400, 23600]) {
    oc[`${k}.000000`] = { ce: { last_price: priceOption('CE', F, k, T, 0.14, RISK_FREE_RATE, true), implied_volatility: 14, greeks: { delta: 0.99 } } };
  }
  const s = suggestCoveredCall(oc, spot, 50.5, 65, 0.3, 22, { expiry, now: NOW })!;
  const want = [23000, 23200, 23400, 23600]
    .map((k) => ({ k, d: greeksForLeg({ type: 'CE', strike: k, expiry, mark: oc[`${k}.000000`].ce.last_price }, { spot }, { now: NOW })!.delta }))
    .sort((x, y) => Math.abs(x.d - 0.3) - Math.abs(y.d - 0.3))[0];
  assert.strictEqual(s.strike, want.k);
  assert.ok(Math.abs(s.strikeDelta - want.d) < 0.001 && s.deltaEstimated === false);
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

import { summarizeCallTrades, callsPerformance } from './coveredCallEngine.ts';
test('summarizeCallTrades folds closes into their leg and keeps realized equal to the closes', () => {
  const D = 86_400_000;
  const trades = [
    { id: 'a', ts: 0, action: 'SELL_OPEN', strike: 100, expiry: 'x', units: 100, price: 30, securityId: '1' },
    { id: 'b', ts: 2 * D, action: 'BUY_CLOSE', strike: 100, expiry: 'x', units: 40, price: 20, securityId: '1', openLegId: 'a', realizedPnl: 400 },
    { id: 'c', ts: 3 * D, action: 'SELL_OPEN', strike: 110, expiry: 'x', units: 50, price: 10, securityId: '2' },
    { id: 'd', ts: 4 * D, action: 'BUY_CLOSE', strike: 90, expiry: 'x', units: 10, price: 5, securityId: '3', openLegId: 'gone', realizedPnl: -50 },
  ] as CallTrade[];
  const s = summarizeCallTrades(trades, { a: 300, c: null }, 5 * D);
  const a = s.rows.find((r) => r.id === 'a')!;
  assert.deepEqual([a.status, a.closedUnits, a.openUnits, a.exitPrice, a.realized, a.openMtm, a.total], ['PARTIAL', 40, 60, 20, 400, 300, 700]);
  assert.equal(s.rows.find((r) => r.id === 'c')!.status, 'OPEN');
  assert.equal(s.rows.find((r) => r.id === 'd')!.status, 'CLOSE-ONLY');
  assert.equal(s.realized, 350);
  assert.equal(s.total, 650);
});
test('callsPerformance withholds the annualised figure before 7 days', () => {
  const D = 86_400_000;
  assert.equal(callsPerformance({ callsPnl: 1000, holdingCost: 100000, holdingPnl: 500, firstTradeTs: 0, now: 3 * D }).annualisedPct, null);
  const p = callsPerformance({ callsPnl: 1000, holdingCost: 100000, holdingPnl: 500, firstTradeTs: 0, now: 10 * D });
  assert.equal(p.pctOfCost, 1);
  assert.equal(Math.round(p.annualisedPct! * 10) / 10, 36.5);
  assert.equal(p.withCalls, 1500);
});
