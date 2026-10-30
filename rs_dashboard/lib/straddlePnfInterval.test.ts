import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVALS, resample } from './straddlePnfInterval.ts';
import type { Bar } from './straddlePnf.ts';

const DAY1 = Date.UTC(2026, 9, 22, 3, 45) / 1000; // Thu 22 Oct 09:15 IST
const DAY2 = Date.UTC(2026, 9, 23, 3, 45) / 1000; // Fri 23 Oct 09:15 IST
const minutes = (start: number, n: number, price = (i: number) => 100 + i): Bar[] =>
  Array.from({ length: n }, (_, i) => ({ t: start + i * 60, ce: price(i) / 2, pe: price(i) / 2, straddle: price(i), vol: 10 }));

test('a short last bucket at the session close is a bar once it holds the closing minute (MCX 23:55)', () => {
  const lastBucket = Date.UTC(2026, 9, 22, 18, 15) / 1000;  // 23:45 IST, the start of the final 15-minute bucket
  const b = minutes(lastBucket, 10);                         // 23:45 .. 23:54, then the bell
  assert.equal(resample(b, 15).bars.length, 0);              // without the close it waits for a later bucket
  const r = resample(b, 15, 23 * 60 + 55);
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].straddle, 109);
  assert.equal(resample(b.slice(0, 9), 15, 23 * 60 + 55).bars.length, 0); // 23:53 is not the closing minute yet
});

test('the offered intervals divide the 375-minute session evenly', () => {
  assert.deepEqual([...INTERVALS], [1, 3, 5, 15]);
  for (const n of INTERVALS) assert.equal(375 % n, 0);
});

test('1 minute returns the bars untouched', () => {
  const b = minutes(DAY1, 10);
  const r = resample(b, 1);
  assert.equal(r.bars, b);
  assert.deepEqual(r.endIdx, b.map((_, i) => i));
});

test('5-minute buckets start at 09:15, take the last close and the summed volume', () => {
  const b = minutes(DAY1, 15); // 09:15 .. 09:29 = three full buckets
  const r = resample(b, 5);
  assert.equal(r.bars.length, 3);
  assert.deepEqual(r.bars.map(x => x.t), [DAY1, DAY1 + 300, DAY1 + 600]);
  assert.equal(r.bars[0].straddle, 104);       // close of the 09:19 bar
  assert.equal(r.bars[0].ce, 52);
  assert.equal(r.bars[0].vol, 50);             // 5 bars x 10
  assert.equal(r.bars[2].straddle, 114);
  assert.deepEqual(r.endIdx, [4, 9, 14]);      // index of the last 1-min bar of each bucket (VWAP is read there)
});

test('a trailing bucket that has not received all its minutes yet is not a bar (it has not closed)', () => {
  const r = resample(minutes(DAY1, 13), 5);    // 09:15 .. 09:27: the 09:25 bucket has 3 of 5 minutes
  assert.equal(r.bars.length, 2);
  assert.deepEqual(r.endIdx, [4, 9]);
});

test('a bucket with a missing minute still counts once a later bucket exists', () => {
  const b = minutes(DAY1, 12).filter((_, i) => i !== 3); // minute 09:18 missing
  const r = resample(b, 5);
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].vol, 40);
  assert.equal(r.bars[0].straddle, 104);
});

test('buckets never merge across days', () => {
  const r = resample([...minutes(DAY1, 5), ...minutes(DAY2, 5)], 5);
  assert.deepEqual(r.bars.map(x => x.t), [DAY1, DAY2]);
});

test('a full 375-minute session gives 125 / 75 / 25 bars at 3 / 5 / 15 minutes', () => {
  const day = minutes(DAY1, 375);
  assert.equal(resample(day, 3).bars.length, 125);
  assert.equal(resample(day, 5).bars.length, 75);
  assert.equal(resample(day, 15).bars.length, 25);
});

test('empty input gives no bars', () => {
  assert.deepEqual(resample([], 5), { bars: [], endIdx: [] });
});
