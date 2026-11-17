import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBurst, OPEN_BURST_BEFORE_MS, OPEN_BURST_AFTER_MS } from './freshMoneyOpen.ts';

const OPEN = 9 * 60 + 15;
const ist = (hms: string, ms = 0) => new Date(`2026-11-17T${hms}+05:30`).getTime() + ms;

test('inactive before the window, with the exact wait to its start', () => {
  assert.deepEqual(openBurst(ist('09:14:00'), OPEN), { active: false, startsInMs: 60_000 - OPEN_BURST_BEFORE_MS });
  assert.deepEqual(openBurst(ist('09:14:54', 999), OPEN), { active: false, startsInMs: 1 });
});

test('active from 5 s before the open until 2 min after it', () => {
  assert.deepEqual(openBurst(ist('09:14:55'), OPEN), { active: true, startsInMs: 0 });
  assert.equal(openBurst(ist('09:15:00'), OPEN).active, true);
  assert.equal(openBurst(ist('09:16:59', 999), OPEN).active, true);
  assert.equal(openBurst(ist('09:17:00'), OPEN).active, false);
});

test('after the window the wait runs to tomorrow\'s window', () => {
  const r = openBurst(ist('09:17:00'), OPEN);
  assert.equal(r.startsInMs, 86_400_000 - OPEN_BURST_AFTER_MS - OPEN_BURST_BEFORE_MS);
  assert.equal(openBurst(ist('23:59:55'), OPEN).startsInMs, (9 * 60 + 15) * 60_000 - OPEN_BURST_BEFORE_MS + 5_000);
});

test('another market open (MCX 09:00) uses its own minute', () => {
  assert.equal(openBurst(ist('09:00:00'), 9 * 60).active, true);
  assert.equal(openBurst(ist('09:00:00'), OPEN).active, false);
});
