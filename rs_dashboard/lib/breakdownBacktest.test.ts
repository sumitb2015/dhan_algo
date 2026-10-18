import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillStart,
  classifyBuildup,
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
  assert.equal(t.vwap, 100.5);
});

test('simulateDay: enters at the next bar open after a closed breakdown and exits on the trailing stop level', () => {
  const day = scenario((m) => (m === 641 ? { o: 88, h: 120, l: 88, c: 110 } : null)); // 10:41 spike
  const r = simulateDay(day, cfg);
  const t = r.trades[0];
  assert.ok(t, 'one trade expected');
  assert.equal(t.contract, '23000PE');
  assert.equal(t.entryTime, '10:16'); // breakdown bar 10:15 closed -> fill at 10:16 open
  assert.equal(t.entryPrice, 94);
  assert.equal(t.initialSl, 117.5); // +25%
  assert.equal(t.lowestPrice, 88);
  assert.equal(t.exitKind, 'TRAIL_SL'); // trail = 88 x 1.15 = 101.2, crossed by the 10:41 high
  assert.equal(t.exitTime, '10:41');
  assert.equal(t.exitPrice, 101.2);
  assert.equal(t.gross, -468); // (94 - 101.2) x 65
  assert.ok(t.costs > 0 && t.net < t.gross);
  assert.equal(t.trendAtEntry, 'BULLISH');
  assert.equal(r.losses, 1);
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
});
