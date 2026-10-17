import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOp,
  legPnl,
  LedgerError,
  DEFAULT_CONFIG,
  type BreakdownPosition,
  type BreakdownStateFile,
} from './breakdownLedger.ts';

const basePos = (over: Partial<BreakdownPosition> = {}): BreakdownPosition => ({
  id: 'pos-1',
  mode: 'SIM',
  broker: 'dhan',
  underlying: 'NIFTY',
  expiry: '2026-10-20',
  option: 'PE',
  strike: 25000,
  lotSize: 65,
  qty: 65,
  entryPrice: 100,
  lowestPrice: 100,
  initialSl: 125,
  trailingSl: 115,
  targetPrice: 70,
  status: 'OPEN',
  openedAt: 1000,
  realized: 0,
  ...over,
});

const emptyFile: BreakdownStateFile = {
  rev: 0,
  mode: 'SIM',
  config: DEFAULT_CONFIG,
  positions: [],
  logs: [],
  date: '2026-10-17',
};

test('breakdownLedger: open position and duplicate rejection', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos() });
  assert.equal(f1.positions.length, 1);
  assert.equal(f1.rev, 1);

  // Attempt duplicate open of exact same contract
  assert.throws(
    () => applyOp(f1, { op: 'open', position: basePos({ id: 'pos-2' }) }),
    (err: unknown) => err instanceof LedgerError && err.status === 409,
  );
});

test('breakdownLedger: close position calculates realized P&L for short', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos() });
  // Entry = 100, Exit = 80, Qty = 65 -> Realized = (100 - 80) * 65 = +1300
  const f2 = applyOp(f1, {
    op: 'close',
    id: 'pos-1',
    exitPrice: 80,
    exitReason: 'TARGET HIT',
    at: 2000,
  });

  const p = f2.positions[0];
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.qty, 0);
  assert.equal(p.exitPrice, 80);
  assert.equal(p.realized, 1300);
});

test('breakdownLedger: updateLowsAndSl down-ratchets trailing SL', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos() });
  const f2 = applyOp(f1, {
    op: 'updateLowsAndSl',
    updates: [{ id: 'pos-1', lowestPrice: 75, trailingSl: 86.25 }],
  });

  assert.equal(f2.positions[0].lowestPrice, 75);
  assert.equal(f2.positions[0].trailingSl, 86.25);
});

test('breakdownLedger: legPnl computes live floating P&L for short position', () => {
  const p = basePos({ entryPrice: 100, qty: 65 });
  // If LTP drops to 90 -> (100 - 90) * 65 = +650
  assert.equal(legPnl(p, 90), 650);

  // If LTP rises to 110 -> (100 - 110) * 65 = -650
  assert.equal(legPnl(p, 110), -650);
});
