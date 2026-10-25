import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTick, newSignalsSince, capLog } from './straddlePnfLive.ts';
import type { Bar, PnfSignal } from './straddlePnf.ts';

const T0 = Date.UTC(2026, 9, 23, 3, 45) / 1000; // 09:15 IST, a minute start
const bar = (i: number, ce: number, pe: number): Bar => ({ t: T0 + i * 60, ce, pe, straddle: ce + pe, vol: 7 });

test('a tick inside the open minute updates only the last bar', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const { bars: out, closedIndex } = foldTick(bars, { t: T0 + 60 + 30, ce: 103, pe: 49 });
  assert.equal(closedIndex, null);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], bars[0]);
  assert.equal(out[1].ce, 103);
  assert.equal(out[1].pe, 49);
  assert.equal(out[1].straddle, 152);
  assert.equal(out[1].t, T0 + 60);
  assert.equal(bars[1].ce, 101); // input not mutated
});

test('a tick in a new minute appends a bar and reports the bar that just closed', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const { bars: out, closedIndex } = foldTick(bars, { t: T0 + 2 * 60 + 5, ce: 102, pe: 52 });
  assert.equal(closedIndex, 1);
  assert.equal(out.length, 3);
  assert.equal(out[2].t, T0 + 2 * 60);
  assert.equal(out[2].straddle, 154);
});

test('ticks with a zero leg are ignored', () => {
  const bars = [bar(0, 100, 50)];
  for (const tick of [{ t: T0 + 70, ce: 0, pe: 50 }, { t: T0 + 70, ce: 100, pe: 0 }, { t: T0 + 70, ce: NaN, pe: 50 }]) {
    const r = foldTick(bars, tick);
    assert.equal(r.closedIndex, null);
    assert.deepEqual(r.bars, bars);
  }
});

test('an out-of-order tick from an earlier minute is ignored', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const r = foldTick(bars, { t: T0 + 10, ce: 99, pe: 49 });
  assert.equal(r.closedIndex, null);
  assert.deepEqual(r.bars, bars);
});

test('the first tick on an empty chart starts a bar without closing one', () => {
  const r = foldTick([], { t: T0 + 12, ce: 100, pe: 50 });
  assert.equal(r.closedIndex, null);
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].t, T0);
});

const sig = (id: string, t: number): PnfSignal => ({ id, kind: 'DOUBLE_BOTTOM_SELL', col: 3, bar: 7, t, price: 100, belowVwap: true });

test('newSignalsSince drops seen ids and signals from before the first live bar (a reload never re-alerts)', () => {
  const history = sig('DOUBLE_BOTTOM_SELL:1', T0 + 100);
  const seen = sig('DOUBLE_TOP_BUY:2', T0 + 9000);
  const fresh = sig('DOUBLE_BOTTOM_SELL:3', T0 + 9060);
  const out = newSignalsSince([history, seen, fresh], new Set([seen.id]), T0 + 9000);
  assert.deepEqual(out.map(s => s.id), ['DOUBLE_BOTTOM_SELL:3']);
});

test('newSignalsSince keeps a signal that lands exactly on the first live bar', () => {
  assert.equal(newSignalsSince([sig('a', T0 + 60)], new Set(), T0 + 60).length, 1);
});

test('capLog keeps the newest 30, newest first', () => {
  let log: number[] = [];
  for (let i = 0; i < 35; i++) log = capLog(log, i);
  assert.equal(log.length, 30);
  assert.equal(log[0], 34);
  assert.equal(log[29], 5);
});
