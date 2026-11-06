import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PNF_LOTS, MAX_PNF_SHARES, FLAT_LEG, applyPaperFill, brokerProduct, describePosition, needsRollback, orderQty,
  liveRealPnl, paperPnl, parsePnfOrder, planLegClose, planLegCloseKeeping, sendOutcome, kotakMcxFutureError, type LegResult,
} from './pnfOrderLogic.ts';

const fut = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' };
const eq = { kind: 'equity', symbol: 'RELIANCE', name: 'RELIANCE' };
const open = (extra: Record<string, unknown>) => ({ broker: 'dhan', mode: 'REAL', target: fut, action: 'BUY', lots: 2, product: 'INTRADAY', ...extra });

test('parsePnfOrder: a valid open order', () => {
  const o = parsePnfOrder(open({}));
  assert.ok(typeof o !== 'string');
  assert.equal(o.lots, 2);
  assert.equal(o.close, false);
});

test('parsePnfOrder: lot caps are 20 lots for F&O and 500 shares for equity, rejected not clamped', () => {
  assert.equal(MAX_PNF_LOTS, 20);
  assert.match(String(parsePnfOrder(open({ lots: 21 }))), /cap/);
  assert.ok(typeof parsePnfOrder(open({ target: eq, lots: 100 })) !== 'string', 'an equity order of 100 shares is allowed');
  assert.match(String(parsePnfOrder(open({ target: eq, lots: MAX_PNF_SHARES + 1 }))), /cap/);
  assert.match(String(parsePnfOrder(open({ lots: 0 }))), /positive/);
  assert.match(String(parsePnfOrder(open({ lots: 1.5 }))), /positive/);
});

test('parsePnfOrder: an index, an incomplete contract and a wrong product are refused', () => {
  assert.match(String(parsePnfOrder(open({ target: { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' } }))), /index/);
  assert.match(String(parsePnfOrder(open({ target: { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY' } }))), /complete/);
  assert.match(String(parsePnfOrder(open({ product: 'CNC' }))), /product/);
  assert.match(String(parsePnfOrder(open({ target: eq, product: 'MARGIN' }))), /product/);
  assert.match(String(parsePnfOrder(open({ broker: 'other' }))), /broker/);
});

test('parsePnfOrder: a close ignores any side, lots or product the browser sends', () => {
  const o = parsePnfOrder(open({ close: true, lots: 999, action: 'BUY', product: 'CNC' }));
  assert.ok(typeof o !== 'string');
  assert.equal(o.close, true);
  assert.equal(o.lots, 0);
});

test('brokerProduct and orderQty', () => {
  assert.equal(brokerProduct('MARGIN', 'dhan'), 'MARGIN');
  assert.equal(brokerProduct('MARGIN', 'kotak'), 'NRML');
  assert.equal(brokerProduct('INTRADAY', 'zerodha'), 'MIS');
  assert.equal(orderQty(3, 65), 195);   // NSE F&O: units
  assert.equal(orderQty(3, 1), 3);      // Dhan MCX: lots; equity: shares
});

test('planLegClose: every non-flat row of the contract, its own product, opposite side, full quantity', () => {
  const rows = [
    { key: '111', product: 'INTRADAY', net: -130 },
    { key: '111', product: 'MARGIN', net: 65 },
    { key: '111', product: 'CNC', net: 0 },
    { key: '222', product: 'INTRADAY', net: -65 },
  ];
  assert.deepEqual(planLegClose('111', rows), [
    { side: 'BUY', qty: 130, product: 'INTRADAY' },
    { side: 'SELL', qty: 65, product: 'MARGIN' },
  ]);
  assert.deepEqual(planLegClose('333', rows), []);
});

const leg = (status: LegResult['status']): LegResult => ({ label: 'x', side: 'SELL', qty: 65, product: 'INTRADAY', status });

test('straddle outcome: CE placed and PE refused needs a reversal; unknown never does; a close never does', () => {
  assert.equal(needsRollback([leg('placed'), leg('rejected')], false), true);
  assert.equal(needsRollback([leg('placed'), leg('unknown')], false), false);
  assert.equal(needsRollback([leg('placed'), leg('rejected')], true), false);
  assert.equal(sendOutcome([leg('placed'), leg('placed')]), 'placed');
  assert.equal(sendOutcome([leg('placed'), leg('rejected')]), 'partial');
  assert.equal(sendOutcome([leg('rejected'), leg('skipped')]), 'rejected');
  assert.equal(sendOutcome([leg('unknown'), leg('skipped')]), 'unknown');
});

test('paper ledger: averages adds, books reductions, flips across zero, P&L in rupees by the lot', () => {
  let l = applyPaperFill(FLAT_LEG, 1, 100, 65);
  l = applyPaperFill(l, 1, 110, 65);
  assert.equal(l.lots, 2);
  assert.equal(l.avg, 105);
  l = applyPaperFill(l, -1, 115, 65);            // book 1 lot: (115 - 105) x 65
  assert.equal(l.realised, 650);
  assert.equal(l.lots, 1);
  assert.equal(l.avg, 105);
  l = applyPaperFill(l, -3, 120, 65);            // close 1 (+975) and open 2 short at 120
  assert.equal(l.realised, 650 + 975);
  assert.equal(l.lots, -2);
  assert.equal(l.avg, 120);
  assert.equal(paperPnl([l], [118], [65]), 650 + 975 + (118 - 120) * -2 * 65);
});

test('paper P&L of a short straddle uses each leg own price, not the CE + PE sum on every leg', () => {
  const ce = applyPaperFill(FLAT_LEG, -1, 50, 65);
  const pe = applyPaperFill(FLAT_LEG, -1, 50, 65);
  assert.equal(paperPnl([ce, pe], [48, 49], [65, 65]), (2 + 1) * 65);
  assert.equal(paperPnl([ce, pe], [null, 49], [65, 65]), 65, 'a leg without a price adds only what it booked');
});

test('describePosition: lots, a matched straddle, mixed legs, flat', () => {
  assert.deepEqual(describePosition([2], ['FUT'], false), { side: 'LONG', text: 'LONG 2 lots' });
  assert.deepEqual(describePosition([-1, -1], ['CE', 'PE'], false), { side: 'SHORT', text: 'SHORT 1 lot straddle' });
  assert.equal(describePosition([1, -1], ['CE', 'PE'], false)?.side, 'MIXED');
  assert.equal(describePosition([1, -1], ['CE', 'PE'], false)?.text, 'CE +1 · PE −1');
  assert.deepEqual(describePosition([25], ['EQ'], true), { side: 'LONG', text: 'LONG 25 sh' });
  assert.equal(describePosition([0, 0], ['CE', 'PE'], false), null);
});

test('AUTO exitOwn: parsed only in REAL, positive units, 1-2 legs', async () => {
  const { parsePnfOrder } = await import('./pnfOrderLogic.ts');
  const base = { broker: 'dhan', mode: 'REAL', target: fut, source: 'auto' };
  const ok = parsePnfOrder({ ...base, exitOwn: { side: 'BUY', units: [65] } });
  assert.ok(typeof ok !== 'string' && ok.exitOwn?.side === 'BUY' && ok.source === 'auto');
  assert.match(String(parsePnfOrder({ ...base, mode: 'PAPER', exitOwn: { side: 'BUY', units: [65] } })), /REAL/);
  assert.match(String(parsePnfOrder({ ...base, exitOwn: { side: 'BUY', units: [0] } })), /units/);
  assert.match(String(parsePnfOrder({ ...base, exitOwn: { side: 'X', units: [65] } })), /side/);
});

test('planOwnExit: own units capped by the intraday row in the closing direction; other products / directions untouched', async () => {
  const { planOwnExit } = await import('./pnfOrderLogic.ts');
  const rows = [
    { key: '111', product: 'INTRADAY', net: -130 },   // two AUTO charts short the same future: 2 lots
    { key: '111', product: 'MARGIN', net: -65 },      // a manual NRML short: never AUTO's
  ];
  assert.deepEqual(planOwnExit('111', rows, 'BUY', 65, 'dhan'), { qty: 65, product: 'INTRADAY' });
  assert.deepEqual(planOwnExit('111', rows, 'BUY', 500, 'dhan'), { qty: 130, product: 'INTRADAY' }, 'capped by the broker');
  assert.equal(planOwnExit('111', rows, 'SELL', 65, 'dhan').qty, 0, 'a SELL would open a new short, not close one');
  assert.equal(planOwnExit('111', [{ key: '111', product: 'MIS', net: 75 }], 'SELL', 75, 'kotak').qty, 75);
  assert.equal(planOwnExit('222', rows, 'BUY', 65, 'dhan').qty, 0);
});

test('sendOutcome: an AUTO exit that finds every leg already flat is "flat", not a failure', async () => {
  const { sendOutcome } = await import('./pnfOrderLogic.ts');
  const l = (status: 'placed' | 'flat' | 'rejected') => ({ label: 'x', side: 'BUY' as const, qty: 1, product: 'INTRADAY', status });
  assert.equal(sendOutcome([l('flat'), l('flat')]), 'flat');
  assert.equal(sendOutcome([l('placed'), l('flat')]), 'placed');
  assert.equal(sendOutcome([l('rejected'), l('flat')]), 'rejected');
});

test('resting orders: LIMIT / SL parse with their prices; an SL-limit limit on the far side of its trigger', async () => {
  const { parsePnfOrder, checkRestingPrices } = await import('./pnfOrderLogic.ts');
  const base = { broker: 'dhan', mode: 'REAL', target: fut, action: 'BUY', lots: 1, product: 'INTRADAY' };
  const lim = parsePnfOrder({ ...base, orderType: 'LIMIT', price: 23050 });
  assert.ok(typeof lim !== 'string' && lim.orderType === 'LIMIT' && lim.price === 23050);
  const sl = parsePnfOrder({ ...base, orderType: 'SL', trigger: 23150, price: 23160 });
  assert.ok(typeof sl !== 'string' && sl.trigger === 23150);
  assert.match(String(parsePnfOrder({ ...base, orderType: 'SL', trigger: 23150, price: 23140 })), /at or above/);
  assert.match(String(parsePnfOrder({ ...base, orderType: 'LIMIT', price: -1 })), /positive/);
  assert.match(String(parsePnfOrder({ ...base, orderType: 'STOP' })), /orderType/);
  assert.equal(typeof checkRestingPrices('SELL', 'SL', 99, 100), 'object');
});

test('brokerOp modify / cancel: REAL only, a sane order id, modify needs prices', async () => {
  const { parsePnfOrder } = await import('./pnfOrderLogic.ts');
  const base = { broker: 'kotak', mode: 'REAL', target: fut, action: 'BUY', lots: 1, product: 'INTRADAY' };
  const c = parsePnfOrder({ ...base, brokerOp: { op: 'cancel', orderId: '2510301234' } });
  assert.ok(typeof c !== 'string' && c.brokerOp?.op === 'cancel');
  assert.match(String(parsePnfOrder({ ...base, brokerOp: { op: 'modify', orderId: '1' } })), /prices/);
  assert.match(String(parsePnfOrder({ ...base, brokerOp: { op: 'cancel', orderId: '../x' } })), /orderId/);
  assert.match(String(parsePnfOrder({ ...base, mode: 'PAPER', brokerOp: { op: 'cancel', orderId: '1' } })), /REAL/);
});

test('a close keeps the other page\'s AUTO quantity: only the rest of the intraday row is closed', () => {
  const rows = [{ key: 'F', product: 'INTRADAY', net: -130 }, { key: 'F', product: 'MARGIN', net: 65 }];
  // the other page's AUTO is short 65 of the -130 intraday row: close 65 of it; the MARGIN row is closed whole
  assert.deepEqual(planLegCloseKeeping('F', rows, -65, 'dhan'), [{ side: 'BUY', qty: 65, product: 'INTRADAY' }, { side: 'SELL', qty: 65, product: 'MARGIN' }]);
  // all of it is the other page's: nothing is closed on that row
  assert.deepEqual(planLegCloseKeeping('F', [{ key: 'F', product: 'INTRADAY', net: -65 }], -65, 'dhan'), []);
  // a reservation the other way (an AUTO long inside a net short) cannot be in this row: the whole row closes
  assert.deepEqual(planLegCloseKeeping('F', [{ key: 'F', product: 'INTRADAY', net: -65 }], 65, 'dhan'), [{ side: 'BUY', qty: 65, product: 'INTRADAY' }]);
  assert.deepEqual(planLegCloseKeeping('F', rows, 0, 'dhan'), planLegClose('F', rows));
});

test('Kotak MCX future: its lot size must equal the leg\'s barrels per lot (Kotak orders in barrels), unknown multiplier refused', () => {
  assert.equal(kotakMcxFutureError('CRUDEOILM19NOV26FUT', 10, 10), null);
  assert.match(kotakMcxFutureError('CRUDEOILM19NOV26FUT', 100, 10) ?? '', /lot size 100, not the expected 10/);
  assert.match(kotakMcxFutureError('X', 10, null) ?? '', /No barrels-per-lot/);
});

test('Kotak MCX option legs use the same barrels-per-lot cross-check as futures', () => {
  assert.equal(kotakMcxFutureError('CRUDEOILM17NOV265000CE', 10, 10), null);
  assert.match(kotakMcxFutureError('CRUDEOIL17NOV265000CE', 100, 10) ?? '', /not the expected 10/);
});

test('parsePnfOrder: a close may name the guarding chart (1 / 2) so the other chart\'s AUTO units are kept; anything else is refused', () => {
  const fut = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' };
  const c = parsePnfOrder({ broker: 'kotak', mode: 'REAL', target: fut, close: true, guardChart: 2 });
  assert.ok(typeof c !== 'string' && c.close && c.guardChart === 2);
  const bar = parsePnfOrder({ broker: 'kotak', mode: 'REAL', target: fut, close: true });
  assert.ok(typeof bar !== 'string' && bar.guardChart === undefined, 'a trade-bar square off names no chart');
  assert.equal(parsePnfOrder({ broker: 'kotak', mode: 'REAL', target: fut, close: true, guardChart: 3 }), 'guardChart must be 1 or 2');
});

test('NRML AUTO rows: exitOwn carries the product, planOwnExit closes only that product, a square-off keeps NRML reservations out of the NRML row', async () => {
  const { planOwnExit } = await import('./pnfOrderLogic.ts');
  const rows = [{ key: '111', product: 'INTRADAY', net: -65 }, { key: '111', product: 'MARGIN', net: -130 }];
  assert.deepEqual(planOwnExit('111', rows, 'BUY', 130, 'dhan', 'MARGIN'), { qty: 130, product: 'MARGIN' });
  assert.deepEqual(planOwnExit('111', rows, 'BUY', 130, 'dhan'), { qty: 65, product: 'INTRADAY' }, 'MIS by default');
  assert.deepEqual(planOwnExit('111', [{ key: '111', product: 'NRML', net: 20 }], 'SELL', 20, 'kotak', 'MARGIN'), { qty: 20, product: 'NRML' });
  const x = parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: fut, exitOwn: { side: 'BUY', units: [65], product: 'MARGIN' } });
  assert.ok(typeof x !== 'string' && x.exitOwn?.product === 'MARGIN' && x.product === 'MARGIN');
  const y = parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: fut, exitOwn: { side: 'BUY', units: [65] } });
  assert.ok(typeof y !== 'string' && y.exitOwn?.product === 'INTRADAY', 'an older tab without a product exits MIS');
  assert.equal(typeof parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: fut, exitOwn: { side: 'BUY', units: [65], product: 'CNC' } }), 'string');
  assert.deepEqual(planLegCloseKeeping('111', rows, 0, 'dhan', -65), [{ side: 'BUY', qty: 65, product: 'INTRADAY' }, { side: 'BUY', qty: 65, product: 'MARGIN' }]);
  assert.deepEqual(planLegCloseKeeping('111', rows, -65, 'dhan', -130), []);
});

test('a CNC stock bracket exits its CNC row (exitOwn.product CNC), never the MIS one; CNC is refused on F&O and NRML on a stock', async () => {
  const { planOwnExit } = await import('./pnfOrderLogic.ts');
  const x = parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: eq, exitOwn: { side: 'SELL', units: [10], product: 'CNC' } });
  assert.ok(typeof x !== 'string' && x.exitOwn?.product === 'CNC');
  assert.deepEqual(planOwnExit('9', [{ key: '9', product: 'CNC', net: 10 }], 'SELL', 10, 'dhan', 'CNC'), { qty: 10, product: 'CNC' });
  assert.equal(typeof parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: eq, exitOwn: { side: 'SELL', units: [10], product: 'MARGIN' } }), 'string');
  assert.equal(typeof parsePnfOrder({ broker: 'dhan', mode: 'REAL', target: fut, exitOwn: { side: 'SELL', units: [10], product: 'CNC' } }), 'string');
});

test('liveRealPnl: no move since the poll is the book total', () => {
  assert.equal(liveRealPnl(1250, [2], [8524], [8524], [10]), 1250);
});

test('liveRealPnl: MCX lots x barrels per lot, long and short', () => {
  assert.equal(liveRealPnl(0, [2], [8524], [8530], [10]), 6 * 2 * 10);
  assert.equal(liveRealPnl(-100, [-1], [8524], [8530], [10]), -100 - 60);
});

test('liveRealPnl: a straddle sums both legs; a flat leg needs no price', () => {
  assert.equal(liveRealPnl(0, [-1, -1], [100, 90], [98, 91], [65, 65]), (2 - 1) * 65);
  assert.equal(liveRealPnl(50, [0, 1], [null, 90], [null, 92], [65, 65]), 50 + 2 * 65);
});

test('liveRealPnl: a missing price on an open leg falls back to the book total', () => {
  assert.equal(liveRealPnl(300, [1, 1], [100, null], [101, 92], [65, 65]), 300);
  assert.equal(liveRealPnl(300, [1], [100], [0], [65]), 300);
});
