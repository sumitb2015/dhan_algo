import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketTickBars, foldTickRows, newTickBuild, spliceTicks, TICK_GAP_MS, type TickRow } from './pnfTicks.ts';
import type { Bar } from './straddlePnf.ts';

const OPEN = Date.UTC(2026, 9, 22, 3, 45) * 1;     // Thu 22 Oct 09:15 IST, ms
const at = (s: number) => OPEN + s * 1000;

test('a single instrument: one bar per recorded price, stamped to the ms, as ce with pe 0', () => {
  const b = foldTickRows(newTickBuild(1), [[[at(1), 100, 0], [at(1.5), 101, 0], [at(2), 102, 0]]], 'NSE');
  assert.deepEqual(b.bars.map(x => [x.t, x.ce, x.pe, x.straddle]), [[at(1) / 1000, 100, 0, 100], [at(1.5) / 1000, 101, 0, 101], [at(2) / 1000, 102, 0, 102]]);
});

test('a straddle needs both legs, then sums their latest prices; one ms on both legs is one bar', () => {
  const ce: TickRow[] = [[at(1), 50, 0], [at(3), 52, 0]];
  const pe: TickRow[] = [[at(2), 40, 0], [at(3), 39, 0]];
  const b = foldTickRows(newTickBuild(2), [ce, pe], 'NSE_FNO');
  assert.deepEqual(b.bars.map(x => [x.ce, x.pe, x.straddle]), [[50, 40, 90], [52, 39, 91]]);
});

test('carries on over later rows without touching the bars already emitted; rows already seen are ignored', () => {
  const b1 = foldTickRows(newTickBuild(1), [[[at(1), 100, 0]]], 'NSE');
  const b2 = foldTickRows(b1, [[[at(1), 100, 0], [at(2), 101, 0]]], 'NSE');
  assert.equal(b2.bars.length, 2);
  assert.equal(b2.bars[0], b1.bars[0]);
  assert.equal(foldTickRows(b2, [[]], 'NSE'), b2);
});

test('volume is the growth of the cumulative figure; the first bar and the first after a gap only set the base', () => {
  const rows: TickRow[] = [[at(1), 100, 1000], [at(2), 101, 1050], [at(3), 102, 1050], [at(3) + TICK_GAP_MS + 1000, 103, 5000], [at(3) + TICK_GAP_MS + 2000, 104, 5010]];
  const b = foldTickRows(newTickBuild(1), [rows], 'NSE');
  assert.deepEqual(b.bars.map(x => x.vol), [0, 50, 0, 0, 10]);
});

test('a bad print (10x away) and prices outside the session draw nothing', () => {
  const rows: TickRow[] = [[OPEN - 60_000, 99, 0], [at(1), 100, 0], [at(2), 1500, 0], [at(3), 101, 0]];
  const b = foldTickRows(newTickBuild(1), [rows], 'NSE');
  assert.deepEqual(b.bars.map(x => x.straddle), [100, 101]);
  // the history's last close is the reference before the first bar
  assert.equal(foldTickRows(newTickBuild(1), [[[at(1), 1000, 0]]], 'NSE', 100).bars.length, 0);
});

const minute = (t: number, p: number): Bar => ({ t, ce: p, pe: 0, straddle: p, vol: 5 });

test('splice: minute bars where there are no ticks, ticks where there are; the forming minute bar is left out', () => {
  const m = (k: number) => OPEN / 1000 + k * 60;
  const hist = [minute(m(0), 100), minute(m(1), 101), minute(m(2), 102), minute(m(3), 103), minute(m(4), 104)];
  const ticks = foldTickRows(newTickBuild(1), [[[(m(1) + 10) * 1000, 101.5, 0], [(m(3) + 5) * 1000, 103.5, 0]]], 'NSE').bars;
  const out = spliceTicks(hist, ticks, m(4) + 30);   // minute 4 is still running
  assert.deepEqual(out.map(b => b.straddle), [100, 101.5, 102, 103.5]);
  assert.equal(out[0], hist[0]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
  // no ticks yet: just the closed minutes
  assert.deepEqual(spliceTicks(hist, [], m(4) + 30).map(b => b.straddle), [100, 101, 102, 103]);
});

// ── Tick bars through the real chart build and AUTO's decision ──
import { buildConfirmedModel } from './straddlePnfModel.ts';
import { decideAuto, reversalColumn, type AutoPosition } from './pnfAuto.ts';
import { effectiveInterval, intervalLabel, intervalsFor, isTickInterval, SEC10_INTERVAL, tickBucketSec, TICK_INTERVAL } from './straddlePnfInterval.ts';
import { readSettings, serializeSettings, DEFAULT_RENKO_SETTINGS } from './straddlePnfSettings.ts';

test('Tick is offered on Renko only, labelled, and survives storage', () => {
  assert.equal(intervalsFor(false, true)[0], TICK_INTERVAL);
  assert.ok(!intervalsFor(false).includes(TICK_INTERVAL));
  assert.equal(effectiveInterval(0, false, true), 0);
  assert.equal(effectiveInterval(0, true), 1);          // the P&F page falls back to 1 min
  assert.equal(intervalLabel(0), 'Tick');
  const s = { ...DEFAULT_RENKO_SETTINGS, interval: TICK_INTERVAL };
  assert.equal(readSettings(serializeSettings(s), DEFAULT_RENKO_SETTINGS).interval, 0);
});

test('AUTO enters on a brick the moment a tick prints it, and exits on the first opposite tick brick', () => {
  // 10:00 IST onwards, a 10-point box, confirm 2 bricks: down to 990 (reversal), then up through 1010 and 1020 within seconds
  const T0 = Date.UTC(2026, 9, 22, 4, 30) * 1;
  const path = [1000, 995, 989, 985, 979, 991, 1001, 1011, 1021];
  const rows: TickRow[] = path.map((p, i) => [T0 + i * 700, p, 0]);
  const opts = { chart: 'renko' as const, interval: 0, boxMode: 'pts' as const, boxPts: 10, reversal: 2, volume: false };
  let b = foldTickRows(newTickBuild(1), [rows.slice(0, 7)], 'NSE');
  let m = buildConfirmedModel(b.bars, 'sma', opts, null);
  const nowS = (T0 + 7 * 700) / 1000;
  assert.equal(decideAuto({ model: m, position: null, watermarkT: 0, nowS, market: 'NSE' }).action, 'none');   // one up brick so far
  b = foldTickRows(b, [rows.slice(7, 8)], 'NSE');                   // 1011: the second up brick, on this very tick
  m = buildConfirmedModel(b.bars, 'sma', opts, m);
  const d = decideAuto({ model: m, position: null, watermarkT: 0, nowS: (T0 + 8 * 700) / 1000 + 0.5, market: 'NSE' });
  assert.equal(d.action, 'enter');
  assert.equal(d.action === 'enter' && d.side, 'BUY');
  assert.equal(m.lastBarT, (T0 + 7 * 700) / 1000);
  // a long entered on that tick exits on the first down brick printed after it, ticks later
  const pos: AutoPosition = { side: 'BUY', entryBarT: m.lastBarT!, entryPrice: 1010 } as AutoPosition;
  const down: TickRow[] = [[T0 + 9 * 700, 1015, 0], [T0 + 10 * 700, 989, 0]];   // 989: a full 2-box reversal under the 1000-1010 brick
  b = foldTickRows(b, [down], 'NSE');
  m = buildConfirmedModel(b.bars, 'sma', opts, m);
  assert.ok(reversalColumn(m, pos) >= 0);
  assert.equal(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: (T0 + 10 * 700) / 1000 + 0.5, market: 'NSE' }).action, 'exit');
});

test('10 sec is offered on Renko only, after Tick, and survives storage', () => {
  assert.deepEqual(intervalsFor(false, true).slice(0, 3), [TICK_INTERVAL, SEC10_INTERVAL, 1]);
  assert.ok(!intervalsFor(true).includes(SEC10_INTERVAL));
  assert.equal(effectiveInterval(-10, false), 1);
  assert.equal(intervalLabel(-10), '10 sec');
  assert.ok(isTickInterval(0) && isTickInterval(-10) && !isTickInterval(1));
  assert.equal(tickBucketSec(-10), 10);
  assert.equal(tickBucketSec(0), 0);
  assert.equal(readSettings(serializeSettings({ ...DEFAULT_RENKO_SETTINGS, interval: SEC10_INTERVAL }), DEFAULT_RENKO_SETTINGS).interval, -10);
});

test('10 sec buckets: last price, summed volume, start-stamped; emitted once over, never rewritten', () => {
  const S0 = Date.UTC(2026, 9, 22, 4, 30) / 1000;       // 10:00:00 IST, on a 10 s boundary
  const tick = (s: number, p: number, vol = 1) => ({ t: S0 + s, ce: p, pe: 0, straddle: p, vol });
  const ticks = [tick(1, 100), tick(4.5, 103), tick(9.9, 101), tick(12, 105)];
  // 10:00:12: the first bucket is over (a later tick exists); the second is still filling
  let b = bucketTickBars(null, ticks, 10, S0 + 12.5);
  assert.deepEqual(b.bars, [{ t: S0, ce: 101, pe: 0, straddle: 101, vol: 3 }]);
  const first = b.bars[0];
  // the second bucket closes on the clock (no later tick) once its end + grace has passed
  assert.equal(bucketTickBars(b, ticks, 10, S0 + 21.9).bars.length, 1);
  b = bucketTickBars(b, ticks, 10, S0 + 22);
  assert.deepEqual(b.bars.map(x => [x.t, x.straddle]), [[S0, 101], [S0 + 10, 105]]);
  assert.equal(b.bars[0], first);
  // nothing new: the same build back
  assert.equal(bucketTickBars(b, ticks, 10, S0 + 23), b);
  // a fresh tick series (new day / instrument) starts again
  assert.equal(bucketTickBars(b, [], 10, S0 + 30).bars.length, 0);
});

test('10 sec: a spike that reverses inside the bucket prints no brick; Tick prints it', () => {
  const T0 = Date.UTC(2026, 9, 22, 4, 30) * 1;
  const rows: TickRow[] = [[T0 + 1000, 1000, 0], [T0 + 3000, 1012, 0], [T0 + 6000, 1004, 0], [T0 + 12_000, 1005, 0]];
  const tb = foldTickRows(newTickBuild(1), [rows], 'NSE');
  const opts = { chart: 'renko' as const, interval: 0, boxMode: 'pts' as const, boxPts: 10, reversal: 2, volume: false };
  assert.equal(buildConfirmedModel(tb.bars, 'sma', opts, null).columns.length, 1);          // 1012 crossed 1010 on the tick
  const sec = bucketTickBars(null, tb.bars, 10, T0 / 1000 + 30).bars;
  assert.equal(buildConfirmedModel(sec, 'sma', { ...opts, interval: -10 }, null).columns.length, 0);   // closes 1004, 1005
});
