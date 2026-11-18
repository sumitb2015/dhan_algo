import test from 'node:test';
import assert from 'node:assert/strict';
import { armNeedsGuardStop, carryAllowed, carryLapsed, dayLimitHit, dayRecord, guardStopOk, guardStopProblem, levelsHaveStop, limitsText, parseLimits } from './pnfAutoSafety.ts';
import type { AutoRow } from './pnfAutoLedger.ts';
import type { ServerGuardCfg } from './autoServerGuard.ts';
import type { Target } from './pnfTarget.ts';

const cfg = (over: Partial<ServerGuardCfg> = {}): ServerGuardCfg => ({ on: true, broker: 'dhan', mode: 'REAL', levels: { stop: 2000 }, boxPts: 10, updatedMs: 0, ...over });

test('armNeedsGuardStop: only REAL Renko armings of a rule with no stop of its own', () => {
  for (const rule of ['supertrend', 'nbrick', 'trend', undefined]) assert.equal(armNeedsGuardStop('renko', { mode: 'REAL', rule }), true, String(rule));
  for (const rule of ['twoback', 'oneback']) assert.equal(armNeedsGuardStop('renko', { mode: 'REAL', rule }), false, rule);
  assert.equal(armNeedsGuardStop('renko', { mode: 'PAPER', rule: 'supertrend' }), false, 'PAPER arms freely');
  assert.equal(armNeedsGuardStop('pnf', { mode: 'REAL' }), false, 'the P&F page is not covered');
});

test('levelsHaveStop: a rupee stop always; a box stop only on a contract chart with a known box', () => {
  assert.equal(levelsHaveStop({ stop: 500 }, { index: true, boxPts: null }), true);
  assert.equal(levelsHaveStop({ stopBoxes: 10 }, { index: false, boxPts: 5 }), true);
  assert.equal(levelsHaveStop({ stopBoxes: 10 }, { index: false, boxPts: null }), false, 'boxes the server cannot convert are not a stop');
  assert.equal(levelsHaveStop({ stopBoxes: 10 }, { index: true, boxPts: 5 }), false, 'an index chart is rupees only');
  assert.equal(levelsHaveStop({}, { index: false, boxPts: 5 }), false, 'a target or trail alone is not a stop-loss');
  assert.equal(levelsHaveStop(null, { index: false, boxPts: 5 }), false);
});

test('guardStopOk: the server copy must be on, for this broker and mode, with an enforceable stop', () => {
  const want = { broker: 'dhan', mode: 'REAL', index: false };
  assert.equal(guardStopOk(cfg(), want), true);
  assert.equal(guardStopOk(undefined, want), false);
  assert.equal(guardStopOk(cfg({ on: false }), want), false);
  assert.equal(guardStopOk(cfg({ broker: 'kotak' }), want), false);
  assert.equal(guardStopOk(cfg({ mode: 'PAPER' }), want), false);
  assert.equal(guardStopOk(cfg({ levels: { target: 3000 } }), want), false);
  assert.equal(guardStopOk(cfg({ levels: { stopBoxes: 8 }, boxPts: null }), want), false);
});

const OPT: Target = { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24', strike: 25000, side: 'CE' };
const nowS = Date.UTC(2026, 10, 18, 10, 6) / 1000;                       // 15:36 IST on 2026-11-18, before the option's expiry

test('carryAllowed: an NRML NIFTY option is carried only under a guard with a stop for its own broker and mode', () => {
  const row = { product: 'MARGIN' as const, target: OPT, broker: 'dhan', mode: 'REAL' as const };
  assert.equal(carryAllowed('renko', row, nowS, cfg()), true);
  assert.equal(carryAllowed('renko', row, nowS, undefined), false, 'no guard: the NRML end-of-day exit applies');
  assert.equal(carryAllowed('renko', row, nowS, cfg({ levels: { target: 5000 } })), false);
  assert.equal(carryAllowed('renko', { ...row, product: 'INTRADAY' }, nowS, cfg()), false, 'MIS is never carried');
  // an index chart's row holds its option: a box stop does not count there
  const ix = { product: 'MARGIN' as const, target: { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' } as Target, traded: { target: OPT }, broker: 'dhan', mode: 'REAL' as const };
  assert.equal(carryAllowed('renko', ix, nowS, cfg({ levels: { stopBoxes: 10 } })), false);
  assert.equal(carryAllowed('renko', ix, nowS, cfg({ levels: { stop: 1500 } })), true);
  // the P&F page keeps the plain carry rule (no guard needed)
  assert.equal(carryAllowed('pnf', row, nowS, undefined), true);
});

test('guardStopProblem names what is missing', () => {
  const want = { broker: 'dhan', mode: 'REAL', index: false };
  assert.equal(guardStopProblem(cfg(), want), null);
  assert.match(guardStopProblem(undefined, want) ?? '', /not on the server/);
  assert.match(guardStopProblem(cfg({ broker: 'kotak' }), want) ?? '', /for kotak REAL, not dhan REAL/);
  assert.match(guardStopProblem(cfg({ levels: { stopBoxes: 5 }, boxPts: null }), want) ?? '', /no box size/);
  assert.match(guardStopProblem(cfg({ levels: { target: 900 } }), want) ?? '', /no stop-loss/);
});

test('carryLapsed: a Renko row carried from an earlier day whose guard stop is gone, only', () => {
  const entryT = Date.UTC(2026, 10, 17, 9, 0) / 1000;                   // 14:30 IST the day before
  const row = { product: 'MARGIN' as const, target: OPT, broker: 'dhan', mode: 'REAL' as const, day: '2026-11-17', entryT };
  assert.equal(carryLapsed('renko', row, nowS, undefined), true);
  assert.equal(carryLapsed('renko', row, nowS, cfg()), false, 'still guarded');
  assert.equal(carryLapsed('renko', { ...row, day: '2026-11-18', entryT: nowS - 3600 }, nowS, undefined), false, 'opened today: the end-of-day rule decides');
  assert.equal(carryLapsed('renko', { ...row, product: 'INTRADAY' }, nowS, undefined), false, 'never a carried row');
  assert.equal(carryLapsed('pnf', row, nowS, undefined), false, 'P&F page unchanged');
});

test('parseLimits: keeps valid fields only, never a looser limit', () => {
  assert.equal(parseLimits(undefined), undefined);
  assert.equal(parseLimits({}), undefined);
  assert.deepEqual(parseLimits({ maxLoss: 5000, maxTrades: 10, maxLosses: 3 }), { maxLoss: 5000, maxTrades: 10, maxLosses: 3 });
  assert.deepEqual(parseLimits({ maxLoss: -1, maxTrades: 2.5, maxLosses: 0 }), undefined);
  assert.deepEqual(parseLimits({ maxLoss: '5000', maxTrades: 999 }), { maxLoss: 5000 });
  assert.equal(limitsText(parseLimits({ maxLoss: 5000, maxLosses: 3 })), 'max loss ₹5,000 · 3 losses in a row');
});

let n = 0;
const T0 = Date.UTC(2026, 10, 18, 5, 0) / 1000;                          // 10:30 IST on 2026-11-18
const row = (over: Partial<AutoRow>): AutoRow => ({ id: `r${++n}`, chart: 1, mode: 'REAL', day: '2026-11-18', state: 'closed', side: 'BUY', exitT: T0 + n * 60, ...over } as AutoRow);

test('dayRecord / dayLimitHit: today, this chart and mode only; refused entries do not count', () => {
  const rows = [
    row({ pnl: -1200 }), row({ pnl: 800 }), row({ pnl: -900 }), row({ pnl: -700 }),
    row({ pnl: -5000, chart: 2 }), row({ pnl: -5000, mode: 'PAPER' }), row({ pnl: -5000, day: '2026-11-17', exitT: T0 - 86400 }),
    row({ reason: 'refused', pnl: 0 }),
    row({ reason: 'resolved', neverOpened: true, pnl: 0 }),                 // resolved flat from an unknown entry: never a trade, keeps the streak
  ];
  assert.deepEqual(dayRecord(rows, 1, 'REAL', '2026-11-18'), { trades: 4, pnl: -2000, lossStreak: 2 });
  assert.equal(dayLimitHit(rows, 1, 'REAL', '2026-11-18', undefined), null);
  assert.equal(dayLimitHit(rows, 1, 'REAL', '2026-11-18', { maxLoss: 2500, maxTrades: 5, maxLosses: 3 }), null);
  assert.match(dayLimitHit(rows, 1, 'REAL', '2026-11-18', { maxLoss: 2000 }) ?? '', /daily loss limit/);
  assert.match(dayLimitHit(rows, 1, 'REAL', '2026-11-18', { maxTrades: 4 }) ?? '', /4 of 4 trades/);
  assert.match(dayLimitHit(rows, 1, 'REAL', '2026-11-18', { maxLosses: 2 }) ?? '', /2 losing trades in a row/);
  // an open trade counts toward the trade limit, not toward the loss
  const open = [...rows, row({ state: 'open', pnl: undefined })];
  assert.equal(dayRecord(open, 1, 'REAL', '2026-11-18').trades, 5);
  assert.equal(dayRecord(open, 1, 'REAL', '2026-11-18').pnl, -2000);
  // a winner ends the losing streak
  assert.equal(dayRecord([...rows, row({ pnl: 50 })], 1, 'REAL', '2026-11-18').lossStreak, 0);
  // a trade opened yesterday (carried) and closed today at a loss counts toward today's loss and streak, not today's trade count
  const carried = [...rows, row({ pnl: -8000, day: '2026-11-17' })];
  assert.deepEqual(dayRecord(carried, 1, 'REAL', '2026-11-18'), { trades: 4, pnl: -10000, lossStreak: 3 });
  assert.match(dayLimitHit(carried, 1, 'REAL', '2026-11-18', { maxLoss: 5000 }) ?? '', /daily loss limit/);
});
