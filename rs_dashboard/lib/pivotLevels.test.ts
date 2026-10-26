import test from 'node:test';
import assert from 'node:assert/strict';
import { computePivots, pivotChips } from './pivotLevels.ts';

// H 24000, L 23800, C 23900: P = 23900, range 200.
test('CPR: P, BC and TC from the previous day; TC is never below BC', () => {
  const s = computePivots(24000, 23800, 23900)!;
  assert.deepEqual([s.p, s.bc, s.tc], [23900, 23900, 23900]);   // close at the midpoint: a one-line CPR
  const down = computePivots(24000, 23800, 23820)!;             // closed near the low: 2P-BC falls under BC
  assert.deepEqual([down.p, down.bc, down.tc], [23873.33, 23846.67, 23900]);
});

test('classic: evenly spaced pivots, R and S mirrored', () => {
  const s = computePivots(24000, 23800, 23900, 'classic')!;
  assert.deepEqual([s.r1, s.r2, s.r3, s.r4], [24000, 24100, 24300, 24500]);
  assert.deepEqual([s.s1, s.s2, s.s3, s.s4], [23800, 23700, 23500, 23300]);
});

test('traditional: R3 / S3 use the high / low, R4 / S4 extend by the R2-R1 gap', () => {
  const s = computePivots(24000, 23800, 23900, 'traditional')!;
  assert.equal(s.r1, 24000); assert.equal(s.r2, 24100);
  assert.equal(s.r3, 24200);                       // H + 2(P-L) = 24000 + 200
  assert.equal(s.r4, 24300);                       // R3 + (R2-R1)
  assert.equal(s.s1, 23800); assert.equal(s.s2, 23700);
  assert.equal(s.s3, 23600);                       // L - 2(H-P)
  assert.equal(s.s4, 23500);                       // S3 - (S1-S2)
});

test('camarilla: tight levels around the close', () => {
  const s = computePivots(24000, 23800, 23900, 'camarilla')!;
  assert.equal(s.r1, 23918.33); assert.equal(s.r4, 24010);
  assert.equal(s.s1, 23881.67); assert.equal(s.s4, 23790);
});

test('invalid input gives no levels; chips follow the switches', () => {
  assert.equal(computePivots(0, 1, 1), null);
  assert.equal(computePivots(100, 200, 150), null);
  assert.equal(computePivots(NaN, 1, 1), null);
  const s = computePivots(24000, 23800, 23900);
  assert.equal(pivotChips(s, { cpr: false, pivots: false }).length, 0);
  assert.deepEqual(pivotChips(s, { cpr: true, pivots: false }).map(c => c.label), ['TC', 'P', 'BC']);
  assert.equal(pivotChips(s, { cpr: false, pivots: true }).length, 8);
  assert.equal(pivotChips(null, { cpr: true, pivots: true }).length, 0);
});

test('CRUDEOILM Nov-26 future, session of 2026-10-23 (H 9827, L 9496, C 9799): the CPR and S1 a chart showed on 2026-10-26', () => {
  const s = computePivots(9827, 9496, 9799, 'classic')!;
  assert.equal(Math.round(s.tc), 9753);
  assert.equal(Math.round(s.p), 9707);
  assert.equal(Math.round(s.bc), 9662);             // 9661.5 on the chart's rounding
  assert.equal(Math.round(s.s1), 9588);
  assert.equal(Math.round(s.r1), 9919);
});

test('traditional (the default): R1-R4 and S3 / S4 on the 2026-10-26 CRUDEOILM chart (R 9919 / 10038 / 10250 / 10369)', () => {
  const s = computePivots(9827, 9496, 9799, 'traditional')!;
  assert.deepEqual([s.r1, s.r2, s.r3, s.r4].map(Math.round), [9919, 10038, 10250, 10369]);
  assert.deepEqual([s.s1, s.s2, s.s3, s.s4].map(Math.round), [9588, 9376, 9257, 9045]);
});
