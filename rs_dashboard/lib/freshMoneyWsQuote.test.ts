import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableQuote, WS_SETTLED_MS, WS_FILE_STALE_MS } from './freshMoneyWsQuote.ts';

const now = 1_000_000;
const file = (q: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ updated_ms: now - 500, hub_alive: true, quotes: { 'MCX_COMM:573423': q }, ...extra });

test('a changed price is usable at once', () => {
  assert.deepEqual(usableQuote(file({ ltp: 7970, changed_ms: now - 200, since_ms: now - 1000 }), 'MCX_COMM:573423', now), { ltp: 7970, changedMs: now - 200, sinceMs: now - 1000 });
});

test('an unchanged price is usable only once the subscription has settled (the replayed last tick)', () => {
  assert.equal(usableQuote(file({ ltp: 7965, changed_ms: null, since_ms: now - 2000 }), 'MCX_COMM:573423', now), null);
  assert.equal(usableQuote(file({ ltp: 7965, changed_ms: null, since_ms: now - WS_SETTLED_MS }), 'MCX_COMM:573423', now)?.ltp, 7965);
});

test('a stale file, a dead hub, a missing or zero price give null', () => {
  const q = { ltp: 7970, changed_ms: now - 200, since_ms: now - 1000 };
  assert.equal(usableQuote(file(q, { updated_ms: now - WS_FILE_STALE_MS - 1 }), 'MCX_COMM:573423', now), null);
  assert.equal(usableQuote(file(q, { hub_alive: false }), 'MCX_COMM:573423', now), null);
  assert.equal(usableQuote(file(q), 'NSE_FNO:1', now), null);
  assert.equal(usableQuote(file({ ...q, ltp: 0 }), 'MCX_COMM:573423', now), null);
  assert.equal(usableQuote(null, 'MCX_COMM:573423', now), null);
  assert.equal(usableQuote(file(q, { updated_ms: undefined }), 'MCX_COMM:573423', now), null);
});
