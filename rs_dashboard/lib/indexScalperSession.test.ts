import test from 'node:test';
import assert from 'node:assert/strict';
import { inNseSession } from './indexScalperSession.ts';

const ist = (iso: string) => Date.parse(`${iso}+05:30`);

test('NSE session: 09:15 to 15:30 IST on a regular trading day only', () => {
  assert.equal(inNseSession(ist('2026-11-25T09:14:59')), false);
  assert.equal(inNseSession(ist('2026-11-25T09:15:00')), true);
  assert.equal(inNseSession(ist('2026-11-25T15:29:59')), true);
  assert.equal(inNseSession(ist('2026-11-25T15:30:00')), false); // a feed still sending after the close is not "open"
  assert.equal(inNseSession(ist('2026-11-24T11:00:00')), false); // NSE holiday (Guru Nanak Jayanti)
  assert.equal(inNseSession(ist('2026-11-28T11:00:00')), false); // Saturday
});
