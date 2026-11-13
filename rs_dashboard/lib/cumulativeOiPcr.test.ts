import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedWings, spotCentredPcr } from './cumulativeOiPcr.ts';

// Strikes 100..300 step 50; every strike has CE 100, PE 200 except 250 (PE 400).
const rows = Array.from({ length: 5 }, (_, i) => 100 + i * 50).map(k => ({ strike: k, ceOI: 100, peOI: k === 250 ? 400 : 200 }));

test('recordedWings is the symmetric half-span around the locked ATM', () => {
  assert.equal(recordedWings(100, 300, 200, 50), 2);
  assert.equal(recordedWings(100, 300, 150, 50), 1);   // late-start window: the short side limits it
  assert.equal(recordedWings(200, 200, 200, 50), 1);   // never below 1
});

test('window is centred on spot and sums only its strikes', () => {
  const r = spotCentredPcr(rows, 203, 50, 1, 100, 300);     // centre 200 -> strikes 150..250
  assert.equal(r.centre, 200);
  assert.equal(r.clipped, false);
  assert.equal(r.value, (200 + 200 + 400) / 300);
});

test('a window overhanging the recorded edge is shifted inward at the same width', () => {
  const r = spotCentredPcr(rows, 290, 50, 2, 100, 300);     // wants 200..400: shifted inward to 100..300, width kept
  assert.equal(r.clipped, true);
  assert.equal(r.wings, 2);
  assert.equal(r.centre, 200);
});

test('a band narrower than the window is narrowed and flagged', () => {
  const r = spotCentredPcr(rows, 200, 50, 10, 100, 300);
  assert.equal(r.clipped, true);
  assert.equal(r.wings, 2);
  assert.equal(r.value, (200 * 4 + 400) / 500);             // all five strikes
});

test('zero call OI gives null, not Infinity', () => {
  const r = spotCentredPcr(rows.map(x => ({ ...x, ceOI: 0 })), 200, 50, 1, 100, 300);
  assert.equal(r.value, null);
});
