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

// ── Task 4: stamp on entry, per-position edit ────────────────────────────────────────────────────────────────────
import { stampExit, parseExitDefaults, editExit } from './freshMoneyExits.ts';
import type { FmOrder, FmPosition } from './freshMoneyTrades.ts';

const KEY = 'dhan|111';
const ord4 = (p: Partial<FmOrder>): FmOrder => ({
  id: 'o1', ts: 1000, underlying: 'CRUDEOIL', expiry: '2026-11-17', strike: 8100, opt: 'CE', securityId: '111',
  lot: 1, side: 'BUY', qty: 1, close: false, correlationId: 'fmabc', orderId: 'X1', state: 'filled', filledQty: 1,
  avgPrice: 100, ...p,
});
const T30 = { value: 30, unit: 'pct' as const };
const POS = (p: Partial<FmPosition> = {}): FmPosition => ({
  key: KEY, broker: 'dhan', securityId: '111', priceId: '111', segment: 'MCX_COMM', mult: 100, underlying: 'CRUDEOIL',
  expiry: '2026-11-17', strike: 8100, opt: 'CE', lot: 1, netQty: 1, avgPrice: 100, realised: 0, ltp: 110,
  unrealised: 1000, pnl: 1000, busy: null, ...p,
});

test('stamp only on a flat contract with nothing unconfirmed', () => {
  const s = stampExit([], KEY, 'BUY', 5000, { target: T30, sl: null });
  assert.equal(s?.state, 'waiting-fill');
  assert.equal(s?.dir, 'long');
  assert.equal(s?.openedAt, 5000);
  assert.equal(stampExit([], KEY, 'SELL', 5000, { target: T30, sl: null })?.dir, 'short');
  assert.equal(stampExit([ord4({})], KEY, 'BUY', 5000, { target: T30, sl: null }), null);           // adding to a long
  assert.equal(stampExit([ord4({ state: 'pending', filledQty: 0, avgPrice: null })], KEY, 'BUY', 5000, { target: T30, sl: null }), null);
  assert.equal(stampExit([], KEY, 'BUY', 5000, { target: null, sl: null }), null);
  assert.ok(stampExit([ord4({}), ord4({ id: 'o2', ts: 2000, side: 'SELL', close: true })], KEY, 'BUY', 5000, { target: T30, sl: null }));
});

test('header defaults: blank is off, bad values refuse', () => {
  assert.deepEqual(parseExitDefaults(undefined), { target: null, sl: null });
  assert.deepEqual(parseExitDefaults({ target: T30 }), { target: T30, sl: null });
  for (const bad of [{ target: { value: 0, unit: 'pct' } }, { target: { value: 'abc', unit: 'pct' } },
    { sl: { value: 1e9, unit: 'pts' } }, 'nope']) {
    assert.ok('error' in parseExitDefaults(bad), JSON.stringify(bad));
  }
});

test('edit a position: refused while firing or flat; both null removes; levels from the current average', () => {
  const x = stampExit([], KEY, 'BUY', 0, { target: T30, sl: null })!;
  assert.ok('error' in (editExit({ ...x, state: 'firing' }, POS(), T30, null, 0) as object));
  assert.ok('error' in (editExit(x, POS({ netQty: 0 }), T30, null, 0) as object));
  assert.equal(editExit(x, POS(), null, null, 0), null);
  const e = editExit(x, POS({ avgPrice: 100 }), T30, { value: 15, unit: 'pts' }, 0) as FmExit;
  assert.equal(e.state, 'watching');
  assert.equal(e.targetPx, 130);
  assert.equal(e.slPx, 85);
  assert.equal(e.basis, 100);
  const w = editExit(undefined, POS({ avgPrice: null }), T30, null, 0) as FmExit;
  assert.equal(w.state, 'waiting-fill');
  assert.equal(w.dir, 'long');
  assert.equal((editExit(undefined, POS({ netQty: -1 }), T30, null, 0) as FmExit).dir, 'short');
  const u = editExit({ ...x, state: 'unknown', note: 'old' }, POS(), T30, null, 0) as FmExit;
  assert.equal(u.state, 'watching');
  assert.equal(u.note, undefined);
});

test('a broker rejection stops the watcher on that position (no retry loop); a pre-send refusal still retries', () => {
  const r = exitAfterClose({ kind: 'rejected', error: 'RMS: margin', http: 400 }, 'sl', 500);
  assert.equal(r.state, 'rejected');
  assert.match(r.note ?? '', /^exit REJECTED by the broker: RMS: margin/);
  assert.deepEqual(nextExitAction(X({ state: 'rejected' }), LONG, false, 79, null, 1000), { kind: 'none' });
  assert.deepEqual(nextExitAction(X({ state: 'rejected' }), { netQty: 0, avgPrice: null }, false, 79, null, 1000), { kind: 'drop' });
  assert.equal(exitAfterClose({ kind: 'refused', error: 'held', http: 409 }, 'sl', 500).state, 'watching');
});

test('opening on a flat contract replaces any leftover record, even with blank defaults', async () => {
  const { exitsOnOpen } = await import('./freshMoneyExits.ts');
  const old = { [KEY]: X({ key: KEY, state: 'watching', targetPx: 130, slPx: 80 }) };
  const flat = [ord4({}), ord4({ id: 'o2', ts: 2000, side: 'SELL', close: true })];
  // Blank header: the old levels (from an old basis) must not apply to the new position.
  assert.deepEqual(exitsOnOpen(old, flat, KEY, 'BUY', 5000, { target: null, sl: null }), {});
  // Header set: a fresh stamp replaces the old record.
  const fresh = exitsOnOpen(old, flat, KEY, 'BUY', 5000, { target: T30, sl: null });
  assert.equal(fresh[KEY].state, 'waiting-fill');
  assert.equal(fresh[KEY].openedAt, 5000);
  // Adding to an open position keeps its record untouched.
  assert.equal(exitsOnOpen(old, [ord4({})], KEY, 'BUY', 5000, { target: T30, sl: null }), old);
  // Other keys are untouched.
  const other = { ...old, 'dhan|999': X({ key: 'dhan|999' }) };
  assert.ok(exitsOnOpen(other, flat, KEY, 'BUY', 5000, { target: null, sl: null })['dhan|999']);
});

test('typed text: blank is off; anything else must be a valid number, never silently rewritten', async () => {
  const { parseExitDraft } = await import('./freshMoneyExits.ts');
  assert.equal(parseExitDraft('', 'pct'), null);
  assert.equal(parseExitDraft('   ', 'pts'), null);
  assert.deepEqual(parseExitDraft(' 30 ', 'pct'), { value: 30, unit: 'pct' });
  assert.deepEqual(parseExitDraft('12.5', 'pts'), { value: 12.5, unit: 'pts' });
  for (const bad of ['-5', '1e9', 'abc', '0', '5000', '1.2.3']) {
    const r = parseExitDraft(bad, 'pct');
    assert.ok(r !== null && 'error' in r, bad);
  }
});

test('stepper: ±1 in the current unit; off ↔ 1; capped at the limit', async () => {
  const { stepExitSpec } = await import('./freshMoneyExits.ts');
  assert.deepEqual(stepExitSpec(null, 'pct', 1), { value: 1, unit: 'pct' });          // + from off
  assert.equal(stepExitSpec(null, 'pts', -1), null);                                   // − from off stays off
  assert.deepEqual(stepExitSpec({ value: 10, unit: 'pts' }, 'pts', 1), { value: 11, unit: 'pts' });
  assert.deepEqual(stepExitSpec({ value: 10, unit: 'pts' }, 'pts', -1), { value: 9, unit: 'pts' });
  assert.equal(stepExitSpec({ value: 1, unit: 'pct' }, 'pct', -1), null);              // − from 1 = off
  assert.equal(stepExitSpec({ value: 0.5, unit: 'pct' }, 'pct', -1), null);
  assert.deepEqual(stepExitSpec({ value: 12.5, unit: 'pts' }, 'pts', 1), { value: 13.5, unit: 'pts' });
  assert.deepEqual(stepExitSpec({ value: 1000, unit: 'pct' }, 'pct', 1), { value: 1000, unit: 'pct' });   // capped
  assert.deepEqual(stepExitSpec({ value: 999.5, unit: 'pct' }, 'pct', 1), { value: 1000, unit: 'pct' });
  assert.deepEqual(stepExitSpec({ value: 100000, unit: 'pts' }, 'pts', 1), { value: 100000, unit: 'pts' });
  assert.deepEqual(stepExitSpec({ value: 0.1, unit: 'pts' }, 'pts', 1), { value: 1.1, unit: 'pts' });   // no float drift
});
