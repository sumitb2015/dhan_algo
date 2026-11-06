import test from 'node:test';
import assert from 'node:assert/strict';
import { feedStale, foldLive, idsOf, liveRead, marketOf } from './pnfFeedCore.ts';
import type { Bar } from './straddlePnf.ts';

// 2026-10-30 10:00 IST
const T = Date.UTC(2026, 9, 30, 4, 30) / 1000;
const bar = (t: number, c: number): Bar => ({ t, ce: c, pe: 0, straddle: c, vol: 0 });

test('the session clock follows the contract (MCX, NSE F&O, a CAS stock, else NSE)', () => {
  assert.equal(marketOf([{ segment: 'MCX_COMM', security_id: '1' }]), 'MCX');
  assert.equal(marketOf([{ segment: 'NSE_FNO', security_id: '1' }]), 'NSE_FNO');
  assert.equal(marketOf([{ segment: 'NSE_EQ', security_id: '1' }], true), 'NSE_CAS');
  assert.equal(marketOf([{ segment: 'NSE_EQ', security_id: '1' }]), 'NSE');
  assert.equal(marketOf([]), 'NSE');
  assert.equal(idsOf([{ segment: 'NSE_FNO', security_id: '1' }, { segment: 'NSE_FNO', security_id: '2' }]), 'NSE_FNO:1,NSE_FNO:2');
});

test('a live read: nothing without a price, a wild print is never charted, outside the session it is the header only, Tick mode never folds', () => {
  const q = (ltp: number, t = T) => ({ ltp, changedMs: t * 1000, volume: null });
  assert.equal(liveRead(100, [null], 'NSE', false).kind, 'none');
  assert.equal(liveRead(100, [q(1000)], 'NSE', false).kind, 'wild');
  assert.equal(liveRead(100, [q(101, T - 3 * 3600)], 'NSE', false).kind, 'out');   // 07:00 IST
  assert.equal(liveRead(100, [q(101)], 'NSE', true).kind, 'head');
  const r = liveRead(100, [q(101)], 'NSE', false);
  assert.equal(r.kind, 'fold');
  // folded into the minute: the last bar's close moves, a new minute appends
  const bars = [bar(T - 60, 99), bar(T, 100)];
  assert.equal(foldLive(bars, { t: T + 10, ce: 101, pe: 0 }, true).at(-1)!.straddle, 101);
  assert.equal(foldLive(bars, { t: T + 70, ce: 102, pe: 0 }, true).length, 3);
  assert.deepEqual(foldLive([], { t: T, ce: 1, pe: 0 }, true), []);
});

test('stale after 180 s without a bar', () => {
  assert.equal(feedStale(undefined, T), true);
  assert.equal(feedStale(T, T + 180), false);
  assert.equal(feedStale(T, T + 181), true);
});
