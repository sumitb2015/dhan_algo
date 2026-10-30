import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PNF_LOTS, MAX_PNF_SHARES, FLAT_LEG, applyPaperFill, brokerProduct, describePosition, needsRollback, orderQty,
  paperPnl, parsePnfOrder, planLegClose, sendOutcome, type LegResult,
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
