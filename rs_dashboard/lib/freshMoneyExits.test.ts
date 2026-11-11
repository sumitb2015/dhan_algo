import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelsFor, breached, validateExitSpec, fmtExitSpec } from './freshMoneyExits.ts';

test('long levels in % and points', () => {
  assert.deepEqual(levelsFor(100, 'long', { value: 30, unit: 'pct' }, { value: 20, unit: 'pct' }), { targetPx: 130, slPx: 80 });
  assert.deepEqual(levelsFor(100, 'long', { value: 25, unit: 'pts' }, { value: 15, unit: 'pts' }), { targetPx: 125, slPx: 85 });
});

test('short levels mirror; a 100% short SL is premium doubling', () => {
  assert.deepEqual(levelsFor(100, 'short', { value: 30, unit: 'pct' }, { value: 100, unit: 'pct' }), { targetPx: 70, slPx: 200 });
});

test('a level at or below zero is off', () => {
  assert.equal(levelsFor(100, 'long', null, { value: 100, unit: 'pct' }).slPx, null);
  assert.equal(levelsFor(100, 'long', null, { value: 120, unit: 'pts' }).slPx, null);
  assert.equal(levelsFor(100, 'short', { value: 150, unit: 'pts' }, null).targetPx, null);
});

test('prices are rounded to 2 dp', () => {
  assert.equal(levelsFor(101.35, 'long', { value: 33, unit: 'pct' }, null).targetPx, 134.8);
});

test('breach directions; SL wins a tie', () => {
  const L = { targetPx: 130, slPx: 80 };
  assert.equal(breached(130, 'long', L), 'target');
  assert.equal(breached(80, 'long', L), 'sl');
  assert.equal(breached(100, 'long', L), null);
  const S = { targetPx: 70, slPx: 200 };
  assert.equal(breached(70, 'short', S), 'target');
  assert.equal(breached(200, 'short', S), 'sl');
  assert.equal(breached(100, 'short', S), null);
  assert.equal(breached(100, 'long', { targetPx: 90, slPx: 110 }), 'sl');
  assert.equal(breached(100, 'long', { targetPx: null, slPx: null }), null);
});

test('validation bounds', () => {
  assert.equal(validateExitSpec(null), null);
  assert.equal(validateExitSpec(undefined), null);
  assert.equal(validateExitSpec({ value: null, unit: 'pct' }), null);
  assert.deepEqual(validateExitSpec({ value: 30, unit: 'pct' }), { value: 30, unit: 'pct' });
  assert.deepEqual(validateExitSpec({ value: 1000, unit: 'pct' }), { value: 1000, unit: 'pct' });
  assert.deepEqual(validateExitSpec({ value: 100000, unit: 'pts' }), { value: 100000, unit: 'pts' });
  for (const bad of [{ value: 0, unit: 'pct' }, { value: -5, unit: 'pts' }, { value: 'abc', unit: 'pct' },
    { value: 1001, unit: 'pct' }, { value: 1e9, unit: 'pts' }, { value: 5, unit: 'rupees' }, { value: Infinity, unit: 'pct' }, 'x']) {
    const r = validateExitSpec(bad);
    assert.ok(r !== null && 'error' in r, JSON.stringify(bad));
  }
});

test('format', () => {
  assert.equal(fmtExitSpec({ value: 30, unit: 'pct' }), '30%');
  assert.equal(fmtExitSpec({ value: 20, unit: 'pts' }), '20 pts');
  assert.equal(fmtExitSpec(null), 'off');
});

// ── Task 2: exit record and per-tick decision ────────────────────────────────────────────────────────────────────
import {
  nextExitAction, exitAfterClose, CONFIRM_TICKS, STREAK_MAX_GAP_MS, FIRING_STALE_MS, REFUSED_RETRY_MS, type ExitAction, type FmExit,
} from './freshMoneyExits.ts';

const X = (p: Partial<FmExit> = {}): FmExit => ({
  key: 'dhan|1', openedAt: 0, dir: 'long', target: { value: 30, unit: 'pct' }, sl: { value: 20, unit: 'pct' },
  basis: 100, targetPx: 130, slPx: 80, state: 'watching', ...p,
});
const LONG = { netQty: 65, avgPrice: 100 };

test('constants pinned by the spec', () => {
  assert.equal(CONFIRM_TICKS, 2);
  assert.equal(STREAK_MAX_GAP_MS, 6000);
  assert.equal(FIRING_STALE_MS, 60000);
  assert.equal(REFUSED_RETRY_MS, 5000);
});

test('waiting-fill resolves once the average is known', () => {
  const w = X({ state: 'waiting-fill', basis: null, targetPx: null, slPx: null });
  assert.deepEqual(nextExitAction(w, LONG, false, 120, null, 0), { kind: 'resolve', basis: 100, levels: { targetPx: 130, slPx: 80 } });
  assert.deepEqual(nextExitAction(w, { netQty: 65, avgPrice: null }, false, 120, null, 0), { kind: 'none' });
});

test('drop when flat or flipped, but never while the contract is settling', () => {
  assert.deepEqual(nextExitAction(X(), { netQty: 0, avgPrice: null }, false, 100, null, 0), { kind: 'drop' });
  assert.deepEqual(nextExitAction(X(), null, false, 100, null, 0), { kind: 'drop' });
  assert.deepEqual(nextExitAction(X(), { netQty: 0, avgPrice: null }, true, 100, null, 0), { kind: 'none' });
  assert.deepEqual(nextExitAction(X(), { netQty: -65, avgPrice: 100 }, false, 100, null, 0), { kind: 'drop' });
  assert.deepEqual(nextExitAction(X({ state: 'waiting-fill', basis: null, targetPx: null, slPx: null }), null, true, null, null, 0), { kind: 'none' });
});

test('a breach fires on the second consecutive tick', () => {
  const a = nextExitAction(X(), LONG, false, 131, null, 1000);
  assert.deepEqual(a, { kind: 'streak', streak: { level: 'target', count: 1, at: 1000 } });
  const b = nextExitAction(X(), LONG, false, 131, (a as Extract<ExitAction, { kind: 'streak' }>).streak, 3000);
  assert.deepEqual(b, { kind: 'fire', level: 'target' });
});

test('two breaches too far apart are not consecutive', () => {
  const r = nextExitAction(X(), LONG, false, 131, { level: 'target', count: 1, at: 1000 }, 1000 + STREAK_MAX_GAP_MS + 1000);
  assert.deepEqual(r, { kind: 'streak', streak: { level: 'target', count: 1, at: 8000 } });
});

test('a breach of the other level restarts the count', () => {
  const r = nextExitAction(X(), LONG, false, 79, { level: 'target', count: 1, at: 1000 }, 3000);
  assert.deepEqual(r, { kind: 'streak', streak: { level: 'sl', count: 1, at: 3000 } });
});

test('no price, a retry wait or no breach resets the count', () => {
  const s = { level: 'target' as const, count: 1, at: 1000 };
  assert.deepEqual(nextExitAction(X(), LONG, false, null, s, 3000), { kind: 'streak', streak: null });
  assert.deepEqual(nextExitAction(X({ retryAt: 5000 }), LONG, false, 131, s, 3000), { kind: 'streak', streak: null });
  assert.deepEqual(nextExitAction(X(), LONG, false, 110, s, 3000), { kind: 'streak', streak: null });
});

test('a firing record left behind by a restart becomes unknown, never resent', () => {
  const f = X({ state: 'firing', firedAt: 0, firedBy: 'target' });
  assert.equal(nextExitAction(f, LONG, false, 131, null, FIRING_STALE_MS + 1).kind, 'mark-unknown');
  assert.deepEqual(nextExitAction(f, LONG, false, 131, null, 1000), { kind: 'none' });
  assert.deepEqual(nextExitAction(f, { netQty: 0, avgPrice: null }, false, 131, null, 1000), { kind: 'none' });
});

test('after an exit is sent: flat drops it, still open is incomplete, settling waits', () => {
  const s = X({ state: 'sent', firedBy: 'target', firedAt: 0 });
  assert.deepEqual(nextExitAction(s, { netQty: 0, avgPrice: null }, false, 131, null, 1000), { kind: 'settle', to: 'drop' });
  assert.deepEqual(nextExitAction(s, LONG, false, 131, null, 1000), { kind: 'settle', to: 'incomplete' });
  assert.deepEqual(nextExitAction(s, LONG, true, 131, null, 1000), { kind: 'none' });
});

test('unknown and incomplete are left for the user', () => {
  assert.deepEqual(nextExitAction(X({ state: 'unknown' }), LONG, false, 131, null, 1000), { kind: 'none' });
  assert.deepEqual(nextExitAction(X({ state: 'incomplete' }), LONG, false, 131, null, 1000), { kind: 'none' });
  assert.deepEqual(nextExitAction(X({ state: 'unknown' }), { netQty: 0, avgPrice: null }, false, 131, null, 1000), { kind: 'drop' });
});

test('close outcomes map to record states', () => {
  assert.deepEqual(exitAfterClose({ kind: 'placed', orderId: 'X1' }, 'target', 500), { state: 'sent', firedBy: 'target', firedAt: 500 });
  assert.deepEqual(exitAfterClose({ kind: 'refused', error: 'held', http: 409 }, 'sl', 500),
    { state: 'watching', note: 'held', retryAt: 500 + REFUSED_RETRY_MS, firedBy: undefined, firedAt: undefined });
  for (const r of [{ kind: 'unknown', error: 'timeout', partial: false }, { kind: 'partial', error: 'rest refused' }] as const) {
    const p = exitAfterClose(r, 'sl', 500);
    assert.equal(p.state, 'unknown');
    assert.match(p.note ?? '', /^exit UNKNOWN — check the broker: /);
  }
});
