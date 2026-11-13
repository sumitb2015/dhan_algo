import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonStrikeBand, lockedAtm, recordedWings, snapshotBand, spotCentredPcr } from './cumulativeOiPcr.ts';

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

// A collector restart re-locks ATM and appends to the same file: snapshots t1-t2 recorded 24000 ±2 (step 50), the
// restarted collector then recorded 24300 ±4 (a wider band around a moved ATM).
const band = (ts: string, atm: number, n: number) =>
  Array.from({ length: 2 * n + 1 }, (_, i) => ({ timestamp: ts, strike: atm + (i - n) * 50 }));
const mixed = [...band('t1', 24000, 2), ...band('t2', 24000, 2), ...band('t3', 24300, 4), ...band('t4', 24300, 4)];

test('commonStrikeBand is what every snapshot holds, not the union', () => {
  assert.deepEqual(commonStrikeBand(mixed), { lo: 24100, hi: 24100 });             // 23900..24100 ∩ 24100..24500
  assert.deepEqual(commonStrikeBand(band('t1', 24000, 2)), { lo: 23900, hi: 24100 });
  assert.equal(commonStrikeBand([...band('a', 24000, 1), ...band('b', 25000, 1)]), null);   // disjoint
  assert.equal(commonStrikeBand([]), null);
});

test('a restarted day clamps the wings to the common band, never the union', () => {
  const b = commonStrikeBand([...band('t1', 24000, 10), ...band('t2', 24000, 10), ...band('t3', 24000, 20)])!;
  assert.equal(recordedWings(b.lo, b.hi, 24000, 50), 10);   // the ±10 snapshots limit it, not the later ±20 ones
});

test('snapshotBand reads one snapshot only', () => {
  assert.deepEqual(snapshotBand(mixed, 't3'), { lo: 24100, hi: 24500 });
  assert.equal(snapshotBand(mixed, 'nope'), null);
});

test('lockedAtm is the centre of the first snapshot, not its rounded spot', () => {
  // Collector locked 24000 ±20; the first written spot was 24026 (would round to 24050 -> 19 wings).
  const day = band('t1', 24000, 20);
  assert.equal(lockedAtm(day, 't1', 50), 24000);
  const b = commonStrikeBand(day)!;
  assert.equal(recordedWings(b.lo, b.hi, lockedAtm(day, 't1', 50)!, 50), 20);
  assert.equal(recordedWings(b.lo, b.hi, Math.round(24026 / 50) * 50, 50), 19);   // the old derivation
  assert.equal(lockedAtm(day, 'missing', 50), null);
});
