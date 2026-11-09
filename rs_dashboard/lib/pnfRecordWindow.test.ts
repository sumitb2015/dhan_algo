import test from 'node:test';
import assert from 'node:assert/strict';
import { recordWindowOpen } from './pnfRecordWindow.ts';

const ist = (iso: string, hh: number, mm: number) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hh, mm) - 19_800_000;

test('NIFTY is recorded from 09:05 to 15:31 IST on a trading day', () => {
  const d = '2026-11-09';   // Monday
  assert.equal(recordWindowOpen(ist(d, 9, 4)), false);
  assert.equal(recordWindowOpen(ist(d, 9, 5)), true);
  assert.equal(recordWindowOpen(ist(d, 12, 0)), true);
  assert.equal(recordWindowOpen(ist(d, 15, 31)), true);
  assert.equal(recordWindowOpen(ist(d, 15, 32)), false);
});

test('nothing on a weekend with no session', () => {
  assert.equal(recordWindowOpen(ist('2026-11-14', 11, 0)), false);   // Saturday
});

test('a Muhurat session is its announced window, even on a Sunday', () => {
  const d = '2026-11-08';   // Sunday, 14:20-15:30
  assert.equal(recordWindowOpen(ist(d, 11, 0)), false);
  assert.equal(recordWindowOpen(ist(d, 14, 10)), true);
});
