import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterListStale, shouldRefreshMasterList, MASTER_LIST_RETRY_MS } from './masterListRefreshRules.ts';

// 2026-11-18 21:00 IST = 15:30 UTC
const NOW = Date.UTC(2026, 10, 18, 15, 30);
const IST_MIDNIGHT = Date.UTC(2026, 10, 17, 18, 30);   // 2026-11-18 00:00 IST

test('stale only when written on an earlier IST day', () => {
  assert.equal(masterListStale(Date.UTC(2026, 5, 17), NOW), true);          // June: the file that broke the Renko search
  assert.equal(masterListStale(IST_MIDNIGHT - 1, NOW), true);               // 23:59:59 IST yesterday
  assert.equal(masterListStale(IST_MIDNIGHT, NOW), false);                  // 00:00 IST today
  assert.equal(masterListStale(NOW - 60_000, NOW), false);
  assert.equal(masterListStale(null, NOW), true);                           // no file
});

test('a UTC-yesterday write that is already today in IST is not stale', () => {
  // 2026-11-17 19:00 UTC = 2026-11-18 00:30 IST
  assert.equal(masterListStale(Date.UTC(2026, 10, 17, 19, 0), NOW), false);
});

test('never two at once, and a failed attempt waits before retrying', () => {
  const old = Date.UTC(2026, 5, 17);
  assert.equal(shouldRefreshMasterList(old, NOW, null, false), true);
  assert.equal(shouldRefreshMasterList(old, NOW, null, true), false);
  assert.equal(shouldRefreshMasterList(old, NOW, NOW - MASTER_LIST_RETRY_MS + 1, false), false);
  assert.equal(shouldRefreshMasterList(old, NOW, NOW - MASTER_LIST_RETRY_MS, false), true);
  assert.equal(shouldRefreshMasterList(NOW - 1000, NOW, null, false), false);   // fresh: nothing to do
});
