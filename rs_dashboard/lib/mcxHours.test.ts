import test from 'node:test';
import assert from 'node:assert/strict';
import { indianMarketState } from './marketStatus.ts';
import { isMcxLive } from './marketHours.ts';

// IST clock -> epoch ms (IST is UTC+5:30, no daylight saving).
const ist = (iso: string, hh: number, mm: number) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), hh, mm) - 5.5 * 3600_000;

test('MCX stays open to 23:55 once the US is off daylight saving (from 2 Nov 2026), and closes at 23:30 in the US summer', () => {
  // Tue 3 Nov 2026: winter hours
  assert.equal(indianMarketState(ist('2026-11-03', 23, 40), true, false), 'live');
  assert.equal(indianMarketState(ist('2026-11-03', 23, 54), true, false), 'live');
  assert.equal(indianMarketState(ist('2026-11-03', 23, 56), true, false), 'closed');
  assert.equal(isMcxLive(new Date(ist('2026-11-03', 23, 40))), true);
  assert.equal(isMcxLive(new Date(ist('2026-11-03', 23, 59))), false);
  // Fri 30 Oct 2026: still US summer time -> 23:30
  assert.equal(indianMarketState(ist('2026-10-30', 23, 20), true, false), 'live');
  assert.equal(indianMarketState(ist('2026-10-30', 23, 40), true, false), 'closed');
  assert.equal(isMcxLive(new Date(ist('2026-10-30', 23, 40))), false);
});

test('MCX is closed at weekends and before 09:00; NSE hours are unchanged', () => {
  assert.equal(indianMarketState(ist('2026-11-07', 12, 0), true, false), 'closed');          // Saturday
  assert.equal(indianMarketState(ist('2026-11-03', 8, 59), true, false), 'closed');
  assert.equal(indianMarketState(ist('2026-11-03', 9, 1), true, false), 'live');
  assert.equal(indianMarketState(ist('2026-11-03', 10, 0), false, false), 'live');
  assert.equal(indianMarketState(ist('2026-11-03', 15, 45), false, false), 'closed');
});
