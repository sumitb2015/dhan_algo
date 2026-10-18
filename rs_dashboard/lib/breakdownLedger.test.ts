import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOp,
  legPnl,
  istDayOf,
  normalizeConfig,
  LedgerError,
  DEFAULT_CONFIG,
  type BreakdownPosition,
  type BreakdownStateFile,
} from './breakdownLedger.ts';

const basePos = (over: Partial<BreakdownPosition> = {}): BreakdownPosition => ({
  id: 'pos-0001',
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
    () => applyOp(f1, { op: 'open', position: basePos({ id: 'pos-0002' }) }),
    (err: unknown) => err instanceof LedgerError && err.status === 409,
  );
});

test('breakdownLedger: close position calculates realized P&L for short', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos() });
  // Entry = 100, Exit = 80, Qty = 65 -> Realized = (100 - 80) * 65 = +1300
  const f2 = applyOp(f1, {
    op: 'close',
    id: 'pos-0001',
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
    updates: [{ id: 'pos-0001', lowestPrice: 75, trailingSl: 86.25 }],
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

test('breakdownLedger: updateLowsAndSl never loosens the stop or raises the low-water mark', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos({ lowestPrice: 80, trailingSl: 92 }) });
  const f2 = applyOp(f1, {
    op: 'updateLowsAndSl',
    updates: [{ id: 'pos-0001', lowestPrice: 95, trailingSl: 130 }],
  });
  assert.equal(f2.positions[0].lowestPrice, 80);
  assert.equal(f2.positions[0].trailingSl, 92);
  assert.equal(f2.rev, f1.rev, 'no change => no new revision');
});

test('breakdownLedger: open validates the position', () => {
  const bad = (over: Partial<BreakdownPosition>) =>
    assert.throws(
      () => applyOp(emptyFile, { op: 'open', position: basePos(over) }),
      (err: unknown) => err instanceof LedgerError && err.status === 400,
    );
  bad({ id: 'x' });
  bad({ qty: 0 });
  bad({ qty: 100 }); // not a multiple of the 65 lot
  bad({ qty: 65 * 21, lotSize: 65 }); // above the 20-lot cap
  bad({ entryPrice: 0 });
  bad({ underlying: 'CRUDEOILM' });
  bad({ mode: 'REAL' }); // REAL needs a security id
  bad({ mode: 'REAL', broker: 'kotak', securityId: '123' }); // Kotak orders by trading symbol
  bad({ mode: 'REAL', broker: 'zerodha', securityId: '123' });
  const ok = applyOp(emptyFile, { op: 'open', position: basePos({ mode: 'REAL', securityId: '123' }) });
  assert.equal(ok.positions.length, 1);
  const k = applyOp(emptyFile, { op: 'open', position: basePos({ mode: 'REAL', broker: 'kotak', symbol: 'NIFTY26O2025000PE' }) });
  assert.equal(k.positions[0].symbol, 'NIFTY26O2025000PE');
  const sx = applyOp(emptyFile, { op: 'open', position: basePos({ mode: 'REAL', underlying: 'SENSEX', lotSize: 20, qty: 20, securityId: '9' }) });
  assert.equal(sx.positions.length, 1);
});

test('breakdownLedger: setConfig drops malformed values and refuses out-of-order times', () => {
  const f = applyOp(emptyFile, {
    op: 'setConfig',
    config: { slPct: Number.NaN, lotsPerTrade: 500, dailyLossLimit: 'x' as unknown as number, eodExit: 'oops' },
  });
  assert.equal(f.config.slPct, DEFAULT_CONFIG.slPct);
  assert.equal(f.config.lotsPerTrade, 20, 'clamped to the lot cap');
  assert.equal(f.config.dailyLossLimit, DEFAULT_CONFIG.dailyLossLimit);
  assert.equal(f.config.hardCircuitBreaker, true, 'hardCircuitBreaker defaults to true');
  assert.equal(f.config.useSupertrend, true, 'useSupertrend defaults to true');
  assert.equal(f.config.useVwap, true, 'useVwap defaults to true');
  assert.equal(f.config.useEma, true, 'useEma defaults to true');
  assert.equal(f.config.trendUseEma, true, 'trendUseEma defaults to true');
  assert.equal(f.config.stPeriod, 10, 'stPeriod defaults to 10');
  assert.equal(f.config.stMultiplier, 2.0, 'stMultiplier defaults to 2.0');
  assert.equal(f.config.emaPeriod, 20, 'emaPeriod defaults to 20');
  assert.equal(f.config.eodExit, DEFAULT_CONFIG.eodExit);

  const off = applyOp(emptyFile, {
    op: 'setConfig',
    config: { hardCircuitBreaker: false, useSupertrend: false, useEma: false, trendUseEma: false, stPeriod: 14, stMultiplier: 3.0, emaPeriod: 50 },
  });
  assert.equal(off.config.hardCircuitBreaker, false);
  assert.equal(off.config.useSupertrend, false);
  assert.equal(off.config.useVwap, true);
  assert.equal(off.config.useEma, false);
  assert.equal(off.config.trendUseEma, false);
  assert.equal(off.config.stPeriod, 14);
  assert.equal(off.config.stMultiplier, 3.0);
  assert.equal(off.config.emaPeriod, 50);

  // The half-typed "1" case: an EOD earlier than the entry window must never land.
  assert.throws(
    () => applyOp(emptyFile, { op: 'setConfig', config: { eodExit: '01:00' } }),
    (err: unknown) => err instanceof LedgerError && err.status === 400,
  );
  const t = applyOp(emptyFile, { op: 'setConfig', config: { entryEnd: '14:45', eodExit: '15:20' } });
  assert.equal(t.config.eodExit, '15:20');
});

test('breakdownLedger: close needs a real exit price and is idempotent', () => {
  const f1 = applyOp(emptyFile, { op: 'open', position: basePos() });
  assert.throws(
    () => applyOp(f1, { op: 'close', id: 'pos-0001', exitPrice: 0, exitReason: 'x', at: 1 }),
    (err: unknown) => err instanceof LedgerError && err.status === 400,
  );
  const f2 = applyOp(f1, { op: 'close', id: 'pos-0001', exitPrice: 90, exitReason: 'x', at: 1 });
  assert.equal(applyOp(f2, { op: 'close', id: 'pos-0001', exitPrice: 50, exitReason: 'y', at: 2 }), f2);
});

test('breakdownLedger: istDayOf uses the IST calendar day', () => {
  // 2026-10-17 20:00 UTC is already 2026-10-18 01:30 IST.
  assert.equal(istDayOf(Date.UTC(2026, 9, 17, 20, 0)), '2026-10-18');
  assert.equal(istDayOf(Date.UTC(2026, 9, 17, 5, 0)), '2026-10-17');
});

test('breakdownLedger: a corrupt stored time window never blocks a non-time write (the engine halt)', () => {
  // "9:30" is what the old per-keystroke input could save; it fails HH:MM and the window check.
  const corrupt = { ...emptyFile, config: { ...DEFAULT_CONFIG, engineActive: true, entryStart: '9:30', eodExit: '1' } };
  const f = applyOp(corrupt as BreakdownStateFile, { op: 'setConfig', config: { engineActive: false } });
  assert.equal(f.config.engineActive, false);
  assert.equal(f.config.entryStart, DEFAULT_CONFIG.entryStart, 'invalid window reset to the default as a whole');
  assert.equal(f.config.eodExit, DEFAULT_CONFIG.eodExit);
});

test('breakdownLedger: normalizeConfig repairs a stored config', () => {
  const c = normalizeConfig({ slPct: 'x', lotsPerTrade: 3, entryStart: '10:00', entryEnd: '09:00', bogus: 1 });
  assert.equal(c.slPct, DEFAULT_CONFIG.slPct);
  assert.equal(c.lotsPerTrade, 3);
  assert.equal(c.entryStart, DEFAULT_CONFIG.entryStart, 'out-of-order window reset');
  assert.equal(c.entryEnd, DEFAULT_CONFIG.entryEnd);
  assert.equal((c as unknown as Record<string, unknown>).bogus, undefined);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
});

test('dataSource: sanitized, defaults to dhan, and only a breeze source changes the backtest key', async () => {
  const { backtestConfigKey } = await import('./breakdownBacktest.ts');
  assert.equal(normalizeConfig({}).dataSource, undefined);
  assert.equal((await import('./breakdownLedger.ts')).sanitizeConfigPatch({ dataSource: 'nope' }).dataSource, undefined);
  assert.equal((await import('./breakdownLedger.ts')).sanitizeConfigPatch({ dataSource: 'breeze' }).dataSource, 'breeze');
  const base = normalizeConfig({});
  assert.equal(backtestConfigKey({ ...base, dataSource: 'dhan' }), backtestConfigKey(base));
  assert.notEqual(backtestConfigKey({ ...base, dataSource: 'breeze' }), backtestConfigKey(base));
});
