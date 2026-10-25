import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEEDS, MAX_SESSIONS, msPerBar, validateSimParams, timelineOf, barsUpTo, clockLabel, valueAt, type ExpiryInfo } from './straddleSim.ts';
import type { Bar } from './straddlePnf.ts';

const EXPIRIES: ExpiryInfo[] = [
  { expiry: '2026-10-19', first: '2026-10-14', last: '2026-10-19' },
  { expiry: '2026-10-13', first: '2026-10-07', last: '2026-10-13' },
];
const base = { index: 'NIFTY', expiry: '2026-10-19', from: '2026-10-15', to: '2026-10-16', atm: 'auto' };
const TODAY = '2026-10-26';

test('speeds are 1X, 50X, 100X, 200X and one bar takes 60 s / speed', () => {
  assert.deepEqual([...SPEEDS], [1, 50, 100, 200]);
  assert.equal(msPerBar(1), 60_000);
  assert.equal(msPerBar(50), 1_200);
  assert.equal(msPerBar(100), 600);
  assert.equal(msPerBar(200), 300);
  assert.equal(MAX_SESSIONS, 6);
});

test('valid parameters pass, auto ATM stays auto and a typed ATM snaps to the 50 step', () => {
  assert.deepEqual(validateSimParams(base, EXPIRIES, TODAY), { ok: true, atm: 'auto' });
  assert.deepEqual(validateSimParams({ ...base, atm: '23030' }, EXPIRIES, TODAY), { ok: true, atm: 23050 });
});

test('SENSEX and other indices are refused with the reason: the store has NIFTY only', () => {
  const r = validateSimParams({ ...base, index: 'SENSEX' }, EXPIRIES, TODAY);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /SENSEX.*no historical option data/i);
  assert.equal(validateSimParams({ ...base, index: 'BANKNIFTY' }, EXPIRIES, TODAY).ok, false);
});

test('dates must be strictly before today (IST), in order, and well formed', () => {
  assert.equal(validateSimParams({ ...base, to: '2026-10-26' }, null, TODAY).ok, false);   // today
  assert.equal(validateSimParams({ ...base, to: '2026-10-27' }, null, TODAY).ok, false);   // future
  assert.equal(validateSimParams({ ...base, from: '2026-10-17', to: '2026-10-16' }, null, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, from: '16-10-2026' }, null, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, to: '2026-10-25' }, null, TODAY).ok, true);    // yesterday is fine without a range to check
});

test('dates must fall inside the chosen expiry\'s data range, and the expiry must exist', () => {
  assert.equal(validateSimParams({ ...base, from: '2026-10-10' }, EXPIRIES, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, to: '2026-10-20' }, EXPIRIES, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, expiry: '2026-12-01' }, EXPIRIES, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, expiry: 'soon' }, EXPIRIES, TODAY).ok, false);
});

test('an ATM that is not a positive number is refused', () => {
  assert.equal(validateSimParams({ ...base, atm: 'abc' }, EXPIRIES, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, atm: '-50' }, EXPIRIES, TODAY).ok, false);
  assert.equal(validateSimParams({ ...base, atm: '' }, EXPIRIES, TODAY).ok, false);
});

const bar = (t: number): Bar => ({ t, ce: 50, pe: 50, straddle: 100, vol: 1 });

test('the replay timeline is the sorted union of bar times from the replay start, without the preload day', () => {
  const bars = { '1': [bar(10), bar(70), bar(130)], '2': [bar(10), bar(130), bar(190)] };
  assert.deepEqual(timelineOf(bars, 70), [70, 130, 190]);
  assert.deepEqual(timelineOf({}, 70), []);
});

test('barsUpTo returns the bars at or before the replay time, as a prefix of the series', () => {
  const s = [bar(10), bar(70), bar(130)];
  assert.deepEqual(barsUpTo(s, 70).map(b => b.t), [10, 70]);
  assert.deepEqual(barsUpTo(s, 5), []);
  assert.equal(barsUpTo(s, 999).length, 3);
});

test('clockLabel reads like "Mon 12 Oct 09:15" in IST', () => {
  assert.equal(clockLabel(Date.UTC(2026, 9, 12, 3, 45) / 1000), 'Mon 12 Oct 09:15');
  assert.equal(clockLabel(Date.UTC(2026, 9, 12, 9, 59) / 1000), 'Mon 12 Oct 15:29');
});

test('valueAt gives the latest value at or before t, and null before the first', () => {
  const times = [10, 70, 130];
  const values = [1, 2, 3];
  assert.equal(valueAt(times, values, 70), 2);
  assert.equal(valueAt(times, values, 100), 2);
  assert.equal(valueAt(times, values, 999), 3);
  assert.equal(valueAt(times, values, 5), null);
  assert.equal(valueAt([], [], 5), null);
});
