import { test } from 'node:test';
import assert from 'node:assert';
import { shouldAutoArm, withAutoArm, shouldSkipIdleTick, nextHealth, HEALTH_REFRESH_MS } from './guardArm.ts';
import { emptyGuardState } from './kotakGuardEngine.ts';
import { DEFAULT_GUARD_DEFAULTS } from './guardDefaults.ts';

const T = '2026-11-23';
const D = { ...DEFAULT_GUARD_DEFAULTS };

test('auto-arm: once per IST day, only with a valid session, never over a guard or a lock', () => {
  const fresh = emptyGuardState(T);
  assert.strictEqual(shouldAutoArm(fresh, D, T, true), true);
  assert.strictEqual(shouldAutoArm(fresh, D, T, false), false, 'no session, nothing to watch with');
  assert.strictEqual(shouldAutoArm(fresh, { ...D, enabled: false }, T, true), false);
  assert.strictEqual(shouldAutoArm({ ...fresh, pnl: { profit: 0, loss: 5000, products: ['MARGIN'], date: T } }, D, T, true), false, 'a manual guard wins');
  assert.strictEqual(shouldAutoArm({ ...fresh, lock: { at: 1, reason: 'x', products: ['MARGIN'] } }, D, T, true), false);
});

test('auto-arm: a manual clear later the same day is not re-armed, and the next day is', () => {
  const armed = withAutoArm(emptyGuardState(T), D, T, 1000);
  assert.deepStrictEqual([armed.pnl?.loss, armed.pnl?.products, armed.autoArmedDate], [10_000, ['INTRADAY', 'MARGIN', 'CNC'], T]);
  assert.strictEqual(armed.events.at(-1)?.kind, 'armed');
  const cleared = { ...armed, pnl: null };   // what clearPnl does
  assert.strictEqual(shouldAutoArm(cleared, D, T, true), false);
  assert.strictEqual(shouldAutoArm(cleared, D, '2026-11-24', true), true);
});

test('idle skip: only an armed default with nothing in flight waits; a lock, a bracket or an exit in flight never does', () => {
  const calm = { lock: null, brackets: [], watch: [] };
  assert.strictEqual(shouldSkipIdleTick(calm, 5000, 1000), true);
  assert.strictEqual(shouldSkipIdleTick(calm, 5000, 5000), false, 'the wait is over');
  assert.strictEqual(shouldSkipIdleTick({ ...calm, lock: { at: 1, reason: 'x', products: [] } }, 5000, 1000), false);
  assert.strictEqual(shouldSkipIdleTick({ ...calm, watch: [{ symbol: 'A', product: 'MARGIN', dir: 1, at: 1 }] }, 5000, 1000), false);
});

test('health: rewritten on change or when it goes stale, otherwise left alone', () => {
  const h = { watching: true, reason: '', at: 1000 };
  assert.strictEqual(nextHealth(h, true, '', 1000 + HEALTH_REFRESH_MS - 1), null);
  assert.deepStrictEqual(nextHealth(h, true, '', 1000 + HEALTH_REFRESH_MS), { watching: true, reason: '', at: 1000 + HEALTH_REFRESH_MS });
  assert.strictEqual(nextHealth(h, false, 'session', 2000)?.watching, false);
  assert.strictEqual(nextHealth(undefined, true, '', 2000)?.at, 2000);
});
