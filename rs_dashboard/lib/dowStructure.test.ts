import test from 'node:test';
import assert from 'node:assert/strict';
import { dowDrawings, dowKeyLevel, dowStructure } from './dowStructure.ts';
import { computeIndicator, newIndicator, type Bar } from './indexScalperIndicators.ts';

// Hand-traced through the Pine script's rules with L = R = 1 (swing: left strictly lower / higher, right lower-or-equal /
// higher-or-equal; known one bar later):
//  bar 2 confirms swing high 12 @1 (H) -> reference high
//  bar 3 confirms swing low 9.5 @2 (L); close 12.5 > 12 breaks the reference high from Range -> CHoCH up, pullback low =
//        lowest low since bar 1 = 9.5 @2
//  bar 5 confirms swing high 14 @4 (HH), the trend high -> reference high
//  bar 6 confirms swing low 11 @5 (HL); close 14.5 > 14 -> BOS up, pullback low = lowest low since bar 4 = 11 @5
//  bar 7 confirms swing high 15 @6 (HH); close 10.5 < 11 breaks the pullback low -> CHoCH down, rally high = highest
//        high since bar 5 = 15 @6
const mk = (rows: [number, number, number][]): Bar[] => rows.map(([h, l, c], i) => ({ t: 1_795_000_000 + i * 60, o: c, h, l, c }));
const BARS = mk([[10, 9, 9.5], [12, 10, 11], [11, 9.5, 10], [13, 10.5, 12.5], [14, 12, 13.5], [13, 11, 11.5], [15, 12, 14.5], [14, 10, 10.5]]);

test('pullback low / rally high: swings, CHoCH, BOS and the key level, bar by bar', () => {
  const d = dowStructure(BARS, { left: 1, right: 1 });
  assert.deepEqual(d.map(x => x.evt), [0, 0, 0, 2, 0, 0, 1, -2]);
  assert.deepEqual(d.map(x => x.dir), [0, 0, 0, 1, 1, 1, 1, -1]);
  assert.deepEqual(d.map(x => x.lvl), [null, null, null, 9.5, 9.5, 9.5, 11, 15]);
  assert.deepEqual(d.map(x => x.lvlBar), [null, null, null, 2, 2, 2, 5, 6]);
  assert.deepEqual(d.map(x => x.swH), [0, 0, 1, 0, 0, 2, 0, 2]);
  assert.deepEqual(d.map(x => x.swL), [0, 0, 0, 1, 0, 0, 2, 0]);
  assert.deepEqual([d[3].evtLv, d[3].evtFrom, d[6].evtLv, d[6].evtFrom, d[7].evtLv, d[7].evtFrom], [12, 1, 14, 4, 11, 5]);
  // the key level is drawn only while the trend and the level are unchanged from the bar before
  assert.deepEqual(dowKeyLevel(d), [null, null, null, null, 9.5, 9.5, null, null]);
  const { swings, events } = dowDrawings(BARS, d, 1);
  assert.deepEqual(swings.map(s => `${s.text}@${s.i}:${s.price}`), ['H@1:12', 'L@2:9.5', 'HH@4:14', 'HL@5:11', 'HH@6:15']);
  assert.deepEqual(events, [
    { from: 1, to: 3, level: 12, bos: false, up: true, mid: 2 },
    { from: 4, to: 6, level: 14, bos: true, up: true, mid: 5 },
    { from: 5, to: 7, level: 11, bos: false, up: false, mid: 6 },
  ]);
});

test('break by wick vs close', () => {
  const wickOnly = mk([[10, 9, 9.5], [12, 10, 11], [11, 9.5, 10], [13, 10.5, 12.5], [14, 12, 13.5], [13, 11, 11.5], [15, 12, 14.5], [14, 10.5, 11.5]]);
  assert.equal(dowStructure(wickOnly, { left: 1, right: 1 })[7].evt, 0);                       // close 11.5 holds 11
  assert.equal(dowStructure(wickOnly, { left: 1, right: 1, breakBy: 'wick' })[7].evt, -2);     // low 10.5 breaks it
});

test('a lower high broken inside an uptrend does not move the pullback low', () => {
  // up from bar 3 (pullback low 9.5, trend high 13 since the reset); bar 6 confirms a lower high 12.6 @5 (< 13) -> it does
  // not become the reference high; bar 7 closes above it: no BOS, the pullback low stays 9.5
  const b = mk([[10, 9, 9.5], [12, 10, 11], [11, 9.5, 10], [13, 10.5, 12.5], [12, 11, 11.5], [12.6, 11.2, 12], [12.4, 11.3, 11.8], [12.5, 11.4, 12.7]]);
  const d = dowStructure(b, { left: 1, right: 1 });
  assert.equal(d[4].swH, 2);   // 13 @3 is itself a swing high (HH over 12), and the reference high
  assert.equal(d[6].swH, 3);   // 12.6 @5: LH, below the trend high 13
  assert.deepEqual(d.slice(3).map(x => [x.evt, x.lvl]), [[2, 9.5], [0, 9.5], [0, 9.5], [0, 9.5], [0, 9.5]]);
  // the same bars with 12.6 above the trend high instead (bar 3 high 12.5): it is the reference, and bar 7 is a BOS
  const b2 = b.map((x, i) => (i === 3 ? { ...x, h: 12.5 } : x));
  assert.equal(dowStructure(b2, { left: 1, right: 1 })[7].evt, 1);
});

test('HH-HL / LH-LL method: up once the last two highs AND lows are higher', () => {
  const d = dowStructure(BARS, { left: 1, right: 1, method: 'hhhl' });
  // highs 12 -> 14 (higher), lows 9.5 -> 11 (higher) once bar 6 confirms the second low
  assert.equal(d[6].evt, 2);
  assert.deepEqual([d[6].dir, d[6].lvl, d[6].lvlBar, d[6].evtLv, d[6].evtFrom], [1, 11, 5, 11, 5]);
});

test('only closed bars count: a bar past lastClosedIndex changes nothing', () => {
  const all = dowStructure(BARS, { left: 1, right: 1 });
  const held = dowStructure(BARS, { left: 1, right: 1, lastClosedIndex: 6 });
  assert.deepEqual(held.slice(0, 7), all.slice(0, 7));
  assert.deepEqual([held[7].evt, held[7].dir, held[7].lvl, held[7].swH], [0, 1, 11, 0]);
});

test('chart output: a fixed set of series, labels as markers, BOS dashed, the trend on the key level axis label', () => {
  // the engine leaves the forming (last) bar out, so append one more bar to have bar 7 processed
  const out = computeIndicator([...BARS, { t: BARS[7].t + 60, o: 10.5, h: 11, l: 10, c: 10.6 }], { ...newIndicator('dow', 'd'), params: { left: 1, right: 1, hhhl: 0, wick: 0, swings: 1, events: 1, level: 1 } });
  assert.equal(out.series.length, 2 + 4 + 4 + 1);
  assert.deepEqual(out.series[0].markers!.map(m => m.text), ['H', 'HH', 'HH']);
  assert.deepEqual(out.series[1].markers!.map(m => m.text), ['L', 'HL']);
  const bos = out.series.filter(s => s.key.startsWith('bos')), choch = out.series.filter(s => s.key.startsWith('choch'));
  assert.ok(bos.every(s => s.lineStyle === 'dashed') && choch.every(s => s.lineStyle === undefined));
  assert.deepEqual(bos[0].values.slice(4, 7), [14, 14, 14]);
  assert.equal(bos[0].breaks![6], true);
  assert.deepEqual(choch.flatMap(s => s.markers!.map(m => `${m.text}@${m.i}`)), ['CHoCH@2', 'CHoCH@6']);   // two lanes: they overlap
  const lvl = out.series.at(-1)!;
  assert.equal(lvl.axisLabel, 'Down · Rally high');
  assert.equal(lvl.lineWidth, 2);
});
