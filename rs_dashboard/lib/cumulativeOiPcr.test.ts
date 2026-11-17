import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonStrikeBand, lockedAtm, recordedWings, snapshotBand, spotCentredPcr, sharedRun, completeSnapshots, despikeSpots, windowDrift } from './cumulativeOiPcr.ts';

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

const snap = (ts: string, lo: number, hi: number, step = 50) =>
  Array.from({ length: (hi - lo) / step + 1 }, (_, i) => ({ timestamp: ts, strike: lo + i * step }));

test('sharedRun: the whole day when every snapshot overlaps, clamped to what all of them hold', () => {
  const rows = [...snap('d 09:15:00', 24000, 26000), ...snap('d 10:00:00', 24100, 26100), ...snap('d 11:00:00', 24050, 26050)];
  assert.deepEqual(sharedRun(rows), { from: 'd 09:15:00', band: { lo: 24100, hi: 26000 }, whole: true });
  assert.equal(sharedRun([]), null);
});

test('sharedRun: a restart that shares no strike with the earlier snapshots starts the run there', () => {
  const rows = [...snap('d 09:15:00', 24000, 25000), ...snap('d 09:15:30', 24000, 25000),
    ...snap('d 12:00:00', 26000, 27000), ...snap('d 12:00:30', 26050, 27050)];
  assert.deepEqual(sharedRun(rows), { from: 'd 12:00:00', band: { lo: 26050, hi: 27000 }, whole: false });
});

test('completeSnapshots drops a half-written snapshot and one with a blank OI, keeps a real zero', () => {
  const full = (ts: string, blank?: number, zero?: number) => [100, 150, 200].map(strike => ({
    timestamp: ts, strike, ceOI: strike === blank ? null : strike === zero ? 0 : 10, peOI: 10 }));
  const rows = [...full('d 09:15:00'), ...full('d 09:15:30', 150), ...full('d 09:16:00', undefined, 150),
    ...full('d 09:16:30').slice(0, 2), ...full('d 09:00:00')];
  const ok = completeSnapshots(rows, 'd 09:15:00', 100, 200, 3);
  assert.deepEqual([...ok].sort(), ['d 09:15:00', 'd 09:16:00']);          // before `from`, blank, and partial are out
  assert.deepEqual([...completeSnapshots(rows, 'd 09:15:00', 100, 150, 2)].sort(), ['d 09:15:00', 'd 09:16:00', 'd 09:16:30']);
});

test('despikeSpots: thresholds scale with the price', () => {
  assert.deepEqual(despikeSpots([25000, 25020, 25002]), [25000, 25001, 25002]);        // NIFTY: a 20-point one-tick spike
  assert.deepEqual(despikeSpots([56000, 56020, 56002]), [56000, 56020, 56002]);        // BANKNIFTY: 20 points is a normal move
  assert.deepEqual(despikeSpots([56000, 56040, 56002]), [56000, 56001, 56002]);
  assert.deepEqual(despikeSpots([25000, 25020, 25030]), [25000, 25020, 25030]);        // a real move does not revert
  assert.deepEqual(despikeSpots([25000]), [25000]);
});

test('windowDrift: strikes from the window centre and whether spot has left the window', () => {
  assert.deepEqual(windowDrift(25010, 25000, 50, 10), { strikes: 0, outside: false });
  assert.deepEqual(windowDrift(25320, 25000, 50, 10), { strikes: 6, outside: false });
  assert.deepEqual(windowDrift(24440, 25000, 50, 10), { strikes: -11, outside: true });
});
