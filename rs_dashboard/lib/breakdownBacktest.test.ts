import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditResults,
  backfillStart,
  backtestConfigKey,
  classifyBuildup,
  coldMinBars,
  ewmLast,
  minToHm,
  orderCost,
  sessionsToHold,
  simulateDay,
  summarize,
  trendInputsAt,
  type BtBar,
  type BtDayData,
  type BtDayResult,
} from './breakdownBacktest.ts';
import { DEFAULT_CONFIG, type BreakdownConfig } from './breakdownLedger.ts';

const DAY = '2026-09-23';
const cfg: BreakdownConfig = { ...DEFAULT_CONFIG, timeframe: 1, engineActive: true };

/** A put that sits at ~100 (small wiggle so ATR > 0), breaks down at 10:15-10:17 to 88, then follows `after`. */
function scenario(after: (m: number) => Partial<BtBar> | null): BtDayData {
  const bars: BtBar[] = [];
  for (let m = 555; m <= 929; m++) {
    const t = `${DAY} ${minToHm(m)}:00`;
    let b: BtBar;
    if (m < 615) {
      const w = m % 2 ? 0.5 : -0.5;
      b = { t, o: 100, h: 100.5, l: 99.5, c: 100 + w, v: 2000, oi: 100000 };
    } else if (m === 615) b = { t, o: 100, h: 100, l: 95, c: 95, v: 2000, oi: 101000 };
    else if (m === 616) b = { t, o: 94, h: 94, l: 90, c: 90, v: 2000, oi: 102000 };
    else if (m === 617) b = { t, o: 90, h: 90, l: 88, c: 88, v: 2000, oi: 103000 };
    else b = { t, o: 88, h: 88, l: 88, c: 88, v: 2000, oi: 103000, ...(after(m) ?? {}) };
    bars.push(b);
  }
  // Spot rising 1 point a minute: spot > VWAP and EMA9 > EMA20, so the bias is BULLISH (puts eligible).
  const spot: [string, number][] = [];
  for (let m = 555; m <= 929; m++) spot.push([minToHm(m), 23000 + (m - 555)]);
  return {
    date: DAY,
    expiry: '2026-09-29',
    source: 'db',
    lotSize: 65,
    spot,
    contracts: { '23000PE': { strike: 23000, option: 'PE', bars } },
  };
}

test('orderCost: brokerage + GST + exchange + SEBI, STT only on SELL, stamp only on BUY', () => {
  // ₹100 premium x 65 = ₹6,500 turnover.
  const sell = orderCost('SELL', 100, 65);
  const buy = orderCost('BUY', 100, 65);
  // 20 + 3.25 exch + 0.0065 sebi + 18% GST(23.2565)=4.186 + 6.5 STT = 33.94
  assert.ok(Math.abs(sell - 33.943) < 0.01, `sell ${sell}`);
  // 20 + 3.25 + 0.0065 + 4.186 + 0.195 stamp = 27.64
  assert.ok(Math.abs(buy - 27.638) < 0.01, `buy ${buy}`);
});

test('classifyBuildup mirrors the live bridge labels and dead-band', () => {
  assert.equal(classifyBuildup(-5, 3), 'SB');
  assert.equal(classifyBuildup(5, 3), 'LB');
  assert.equal(classifyBuildup(-5, -3), 'LU');
  assert.equal(classifyBuildup(5, -3), 'SC');
  assert.equal(classifyBuildup(-5, 0.2), undefined);
});

test('ewmLast matches pandas ewm(span, adjust=False)', () => {
  // span 3 -> alpha 0.5: 1, then 0.5*2+0.5*1=1.5, then 0.5*3+0.5*1.5=2.25
  assert.equal(ewmLast([1, 2, 3], 3), 2.25);
  assert.equal(ewmLast([], 9), null);
});

test('trendInputsAt only sees spot closes before the decision minute', () => {
  const spot: [string, number][] = [['09:15', 100], ['09:16', 101], ['09:17', 999]];
  const t = trendInputsAt(spot, 9 * 60 + 17, 1)!;
  assert.equal(t.spot, 101);
  assert.deepEqual(t.closes, [100, 101]);
});

test('simulateDay: enters at the next bar open after a closed breakdown and exits on the trailing stop level', () => {
  // Price drops to 74 at 10:20 (exceeding 15% threshold 14.1 pts -> steps=1, trailSl ratchets to 92), then spikes at 10:41
  const day = scenario((m) => {
    if (m === 620) return { o: 74, h: 74, l: 74, c: 74 };
    if (m === 641) return { o: 88, h: 120, l: 88, c: 110 };
    return null;
  });
  const r = simulateDay(day, cfg);
  const t = r.trades[0];
  assert.ok(t, 'one trade expected');
  assert.equal(t.contract, '23000PE');
  assert.equal(t.entryTime, '10:16'); // breakdown bar 10:15 closed -> fill at 10:16 open
  assert.equal(t.entryPrice, 94);
  assert.equal(t.initialSl, 117.5); // +25%
  assert.equal(t.lowestPrice, 74);
  assert.equal(t.exitKind, 'TRAIL_SL'); // trail ratcheted to 94 - 2 = 92, crossed by 10:41 spike
  assert.equal(t.exitTime, '10:41');
  assert.equal(t.exitPrice, 92);
  assert.equal(t.gross, 130); // (94 - 92) x 65 = +130
  assert.ok(t.costs > 0);
  assert.equal(t.trendAtEntry, 'BULLISH');
});

test('simulateDay: a position never stopped out is closed at the EOD cutoff open', () => {
  const r = simulateDay(scenario(() => null), cfg);
  const t = r.trades[0];
  assert.equal(t.exitKind, 'EOD');
  assert.equal(t.exitTime, cfg.eodExit);
  assert.equal(t.exitPrice, 88);
  assert.equal(t.gross, (94 - 88) * 65);
  assert.equal(r.trades.length, 1, 'the stale breakdown is never re-entered');
});

test('simulateDay: a bar gapping through the stop fills at the open, not at the stop level', () => {
  const r = simulateDay(scenario((m) => (m === 641 ? { o: 130, h: 131, l: 125, c: 128 } : null)), cfg);
  assert.equal(r.trades[0].exitPrice, 130);
});

test('simulateDay: no entries outside the entry window', () => {
  const r = simulateDay(scenario(() => null), { ...cfg, entryStart: '11:00', entryEnd: '14:00' });
  assert.equal(r.trades.length, 0, 'the 10:15 breakdown is 45+ bars old by 11:00');
});

test('sessionsToHold: regular sessions only, today only after the EOD-ready time', () => {
  const isRegular = (d: string) => !['2026-10-02'].includes(d) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  assert.deepEqual(sessionsToHold('2026-10-01', '2026-10-06', '15:00', isRegular), ['2026-10-01', '2026-10-05']);
  assert.deepEqual(sessionsToHold('2026-10-01', '2026-10-06', '15:40', isRegular), ['2026-10-01', '2026-10-05', '2026-10-06']);
  assert.deepEqual(sessionsToHold('2026-10-01', '2026-10-18', '15:40', isRegular, '2026-10-05'), ['2026-10-01', '2026-10-05']);
});

test('backfillStart: one week or one month back', () => {
  assert.equal(backfillStart('2026-10-18'), '2026-10-11');
  assert.equal(backfillStart('2026-10-18', 'month'), '2026-09-18');
});

test('summarize: totals, win rate and max drawdown on the cumulative daily net', () => {
  const d = (date: string, nets: number[]): BtDayResult =>
    ({
      date,
      net: nets.reduce((a, b) => a + b, 0),
      gross: 0,
      costs: 0,
      trades: nets.map((net) => ({ net, exitKind: net > 0 ? 'TARGET' : 'INITIAL_SL' })),
    }) as unknown as BtDayResult;
  const s = summarize([d('2026-10-01', [500]), d('2026-10-02', [-300, -400]), d('2026-10-03', [200])]);
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.net, 0);
  assert.equal(s.maxDrawdown, -700); // peak 500 -> trough -200
  assert.equal(s.exitMix.TARGET, 2);
  assert.equal(s.worstDay?.date, '2026-10-02');
  assert.equal(s.maxConsecWins, 1);
  assert.equal(s.maxConsecLosses, 2);
  assert.equal(s.expectancy, 0);
});

/** A put flat at ~100 that breaks down at minute `drop` (95, 90, 88) and then sits at 88 unless `after` overrides. */
function putBars(drop: number, after: (m: number) => Partial<BtBar> | null = () => null): BtBar[] {
  const bars: BtBar[] = [];
  for (let m = 555; m <= 929; m++) {
    const t = `${DAY} ${minToHm(m)}:00`;
    let b: BtBar;
    if (m < drop) b = { t, o: 100, h: 100.5, l: 99.5, c: 100 + (m % 2 ? 0.5 : -0.5), v: 2000, oi: 100000 };
    else if (m === drop) b = { t, o: 100, h: 100, l: 95, c: 95, v: 2000, oi: 101000 };
    else if (m === drop + 1) b = { t, o: 94, h: 94, l: 90, c: 90, v: 2000, oi: 102000 };
    else if (m === drop + 2) b = { t, o: 90, h: 90, l: 88, c: 88, v: 2000, oi: 103000 };
    else b = { t, o: 88, h: 88, l: 88, c: 88, v: 2000, oi: 103000 };
    bars.push({ ...b, ...(after(m) ?? {}) });
  }
  return bars;
}

test('simulateDay: a slot freed inside bar m is not reused at bar m OPEN (no same-bar look-ahead)', () => {
  // A (23000PE) enters 10:16 and is stopped on bar 10:41's HIGH. B (22950PE) is a fresh breakdown at 10:41.
  // At 10:41's open A still held the only slot, so B can fill at 10:42's open at the earliest.
  const day = scenario((m) => (m === 641 ? { o: 88, h: 120, l: 88, c: 110 } : null));
  day.contracts['22950PE'] = { strike: 22950, option: 'PE', bars: putBars(640) };
  const r = simulateDay(day, { ...cfg, maxConcurrent: 1 });
  const a = r.trades.find((t) => t.contract === '23000PE')!;
  const b = r.trades.find((t) => t.contract === '22950PE')!;
  assert.equal(a.exitKind, 'INITIAL_SL');
  assert.equal(a.exitTime, '10:41');
  assert.equal(b.entryTime, '10:42', 'B waits for the next bar open');
  assert.equal(b.entryPrice, 90);
});

test('simulateDay: a gap exit at the open frees its slot for an entry at that same open', () => {
  const day = scenario((m) => (m === 641 ? { o: 130, h: 131, l: 125, c: 128 } : null));
  day.contracts['22950PE'] = { strike: 22950, option: 'PE', bars: putBars(640) };
  const r = simulateDay(day, { ...cfg, maxConcurrent: 1 });
  assert.equal(r.trades.find((t) => t.contract === '22950PE')!.entryTime, '10:41');
});

test('simulateDay: a trail ratcheted below the bar low fills at the low, never below what traded', () => {
  // trailBy 5 > trailStep 1: the low 74 sets the stop at 94 - 5x5 = 69, below the low itself.
  const r = simulateDay(scenario((m) => (m === 620 ? { o: 88, h: 88, l: 74, c: 80 } : null)), { ...cfg, trailStepPts: 1, trailByPts: 5 });
  const t = r.trades[0];
  assert.equal(t.exitKind, 'TRAIL_SL');
  assert.equal(t.exitTime, '10:20');
  assert.equal(t.exitPrice, 74);
});

test('simulateDay: slippage sells lower and buys back higher on every fill', () => {
  const r = simulateDay(scenario(() => null), { ...cfg, slippagePts: 0.5 });
  const t = r.trades[0];
  assert.equal(t.entryPrice, 93.5);
  assert.equal(t.initialSl, 117.5, 'stops stay sized on the decision price, as the live ledger does');
  assert.equal(t.exitPrice, 88.5);
  assert.equal(t.gross, (93.5 - 88.5) * 65);
});

test('simulateDay: the recovery exit fires inside the bar, at the indicator level, as the live tick check does', () => {
  // Bar 10:30 spikes to 110 but closes at 88: the old close-only check never saw it.
  const r = simulateDay(scenario((m) => (m === 630 ? { o: 88, h: 110, l: 88, c: 88 } : null)), { ...cfg, recoveryExit: true });
  const t = r.trades[0];
  assert.equal(t.exitKind, 'RECOVERY');
  assert.equal(t.exitTime, '10:30');
  assert.ok(t.exitPrice > 88 && t.exitPrice < 110, `fills at the crossed level, got ${t.exitPrice}`);
});

test('auditResults: passes a clean run and flags a same-bar slot reuse and an untraded fill', () => {
  const day = scenario((m) => (m === 641 ? { o: 88, h: 120, l: 88, c: 110 } : null));
  day.contracts['22950PE'] = { strike: 22950, option: 'PE', bars: putBars(640) };
  const c = { ...cfg, maxConcurrent: 1, maxSameSide: 1 };
  const r = simulateDay(day, c);
  const clean = auditResults([r], c, () => day);
  assert.deepEqual(clean.checks.filter((x) => x.failures).map((x) => x.id), []);
  assert.equal(clean.trades, r.trades.length);

  // What the old engine produced: B filled at 10:41's open while A was still open, and an exit no bar traded.
  const bad = structuredClone(r);
  const b = bad.trades.find((t) => t.contract === '22950PE')!;
  Object.assign(b, { entryTime: '10:41', entryPrice: 94 });
  const a = bad.trades.find((t) => t.contract === '23000PE')!;
  a.exitPrice = 125;
  const audit = auditResults([bad], c, () => day);
  const failed = Object.fromEntries(audit.checks.map((x) => [x.id, x.failures]));
  assert.ok(failed.slots >= 1, 'slot reuse flagged');
  assert.ok(failed.exitFill >= 1, 'fill above the bar high flagged');
});

test('simulateDay: each trade records its contract\'s previous-session bars; auditResults counts cold-contract entries', () => {
  const warm = scenario(() => null);
  const prevDay = '2026-09-22';
  warm.contracts['23000PE'].bars.unshift(
    ...Array.from({ length: 30 }, (_, i): BtBar => ({ t: `${prevDay} ${minToHm(555 + i)}:00`, o: 101, h: 101, l: 101, c: 101, v: 1000, oi: 99000 })),
  );
  const rw = simulateDay(warm, cfg);
  assert.equal(rw.trades[0].warmupBars, 30);
  const rc = simulateDay(scenario(() => null), cfg);
  assert.equal(rc.trades[0].warmupBars, 0);
  // tf 1 x EMA20 = 20 bars needed: 30 is warm, 0 is cold.
  const audit = auditResults([rw, { ...rc, date: '2026-09-24' }], cfg, () => null);
  assert.equal(audit.coldEntries?.minBars, 20);
  assert.equal(audit.coldEntries?.trades, 1);
});

test('simulateDay: btWarmOnly skips a contract without enough previous-session bars, and keeps a warm one', () => {
  const cold = simulateDay(scenario(() => null), { ...cfg, btWarmOnly: true });
  assert.equal(cold.trades.length, 0, 'no previous-day bars: skipped');
  const warm = scenario(() => null);
  warm.contracts['23000PE'].bars.unshift(
    ...Array.from({ length: 30 }, (_, i): BtBar => ({ t: `2026-09-22 ${minToHm(555 + i)}:00`, o: 101, h: 101, l: 101, c: 101, v: 1000, oi: 99000 })),
  );
  assert.equal(simulateDay(warm, { ...cfg, btWarmOnly: true }).trades.length, 1);
});

test('simulateDay: daily loss limit triggers hard circuit breaker emergency square-off when hardCircuitBreaker=true (default)', () => {
  // Price jumps to 115 at 10:20 (gross loss: (94 - 115)*65 = -1365).
  // With dailyLossLimit: 1000, hard breaker triggers at 10:20's open and squares off the position.
  const day = scenario((m) => (m >= 620 ? { o: 115, h: 115, l: 115, c: 115 } : null));
  const r = simulateDay(day, { ...cfg, dailyLossLimit: 1000, hardCircuitBreaker: true });
  assert.equal(r.haltedAt, '10:20');
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.exitKind, 'CIRCUIT_BREAKER');
  assert.equal(t.exitTime, '10:20');
  assert.equal(t.exitPrice, 115);
  assert.ok(t.exitReason.includes('CIRCUIT BREAKER'));
});

test('simulateDay: daily loss limit only halts entries and keeps position open when hardCircuitBreaker=false', () => {
  // Price is 115 at 10:20 (loss -1365 breaches 1000 limit), then rises to hit Initial SL (117.5) at 10:25.
  const day = scenario((m) => {
    if (m >= 620 && m < 625) return { o: 115, h: 115, l: 115, c: 115 };
    if (m === 625) return { o: 115, h: 120, l: 115, c: 118 };
    return null;
  });
  const r = simulateDay(day, { ...cfg, dailyLossLimit: 1000, hardCircuitBreaker: false });
  assert.equal(r.haltedAt, '10:20');
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  // Position was NOT squared off at 10:20; it ran until 10:25 to hit Initial SL
  assert.equal(t.exitKind, 'INITIAL_SL');
  assert.equal(t.exitTime, '10:25');
  assert.equal(t.exitPrice, 117.5);
});

test('simulateDay: respects active indicator settings (e.g. useVwap=false allows entry when price is above VWAP)', () => {
  // Option drops to 88, but huge volume at 70 anchors VWAP below 88 (VWAP ~70.5).
  // With useVwap=true (default), price (88) is above VWAP so no breakdown.
  // With useVwap=false, price is below ST & EMA so breakdown triggers entry.
  const day = scenario(() => null);
  day.contracts['23000PE'].bars[5] = { t: `${DAY} 09:20:00`, o: 70, h: 70, l: 70, c: 70, v: 50000000, oi: 100000 };
  const rDefault = simulateDay(day, cfg);
  assert.equal(rDefault.trades.length, 0, 'price is above VWAP, so no breakdown with default useVwap=true');
  const rNoVwap = simulateDay(day, { ...cfg, useVwap: false });
  assert.ok(rNoVwap.trades.length >= 1, 'breakdown triggers when useVwap is disabled');
});

test('backtestConfigKey: changes when indicator parameters change', () => {
  const k1 = backtestConfigKey(cfg);
  const k2 = backtestConfigKey({ ...cfg, stPeriod: 14 });
  const k3 = backtestConfigKey({ ...cfg, stMultiplier: 3.0 });
  const k4 = backtestConfigKey({ ...cfg, emaPeriod: 50 });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
});

test('coldMinBars: scales dynamically with emaPeriod', () => {
  assert.equal(coldMinBars({ ...cfg, timeframe: 5, emaPeriod: 20 }), 100);
  assert.equal(coldMinBars({ ...cfg, timeframe: 5, emaPeriod: 50 }), 250);
  assert.equal(coldMinBars({ ...cfg, timeframe: 1, emaPeriod: 10 }), 10);
});


