import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoStart, AUTO_RETRY_MS } from './crudeCollectorRules.ts';

const base = { open: 900, close: 2355, nowMin: 10 * 60, running: false, stoppedToday: false, sinceLastAttemptMs: Infinity };

test('starts during the session (from 10 min before the open), not after the last minutes', () => {
  assert.equal(shouldAutoStart({ ...base, nowMin: 8 * 60 + 49 }), false);
  assert.equal(shouldAutoStart({ ...base, nowMin: 8 * 60 + 50 }), true);
  assert.equal(shouldAutoStart({ ...base, nowMin: 23 * 60 + 49 }), true);
  assert.equal(shouldAutoStart({ ...base, nowMin: 23 * 60 + 50 }), false);
});

test('evening-only holiday opens at 17:00; a closed day never starts', () => {
  assert.equal(shouldAutoStart({ ...base, open: 1700, nowMin: 14 * 60 }), false);
  assert.equal(shouldAutoStart({ ...base, open: 1700, nowMin: 16 * 60 + 55 }), true);
  assert.equal(shouldAutoStart({ ...base, open: 2400, close: 2400 }), false);
});

test('never while one runs, never after a Stop today, and slowly after a failed start', () => {
  assert.equal(shouldAutoStart({ ...base, running: true }), false);
  assert.equal(shouldAutoStart({ ...base, stoppedToday: true }), false);
  assert.equal(shouldAutoStart({ ...base, sinceLastAttemptMs: AUTO_RETRY_MS - 1 }), false);
  assert.equal(shouldAutoStart({ ...base, sinceLastAttemptMs: AUTO_RETRY_MS }), true);
});
