import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streakStart, tradeEvents, type TradeSnapshot } from './freshMoneyChime.ts';
import type { FmPosition } from './freshMoneyTrades.ts';
import type { FmExit } from './freshMoneyExits.ts';

const pos = (key: string, netQty: number, strike = 25200, opt: 'CE' | 'PE' = 'PE') =>
  ({ key, netQty, strike, opt, underlying: 'NIFTY' } as unknown as FmPosition);
const exit = (state: FmExit['state'], extra: Partial<FmExit> = {}) => ({ key: 'k', state, ...extra } as unknown as FmExit);
const snap = (positions: FmPosition[], exits: Record<string, FmExit> = {}, global: TradeSnapshot['global'] = null): TradeSnapshot =>
  ({ positions, exits, global });

test('first poll after load is silent (history never chimes)', () => {
  assert.deepEqual(tradeEvents(null, snap([pos('a', 65)], { a: exit('sent', { firedBy: 'target' }) })), { sound: null, toasts: [] });
});

test('positions: opened / grown = entry, reduced / flat = exit, unchanged = nothing', () => {
  assert.equal(tradeEvents(snap([]), snap([pos('a', -65)])).sound, 'entry');
  assert.equal(tradeEvents(snap([pos('a', 65)]), snap([pos('a', 130)])).sound, 'entry');
  assert.equal(tradeEvents(snap([pos('a', -130)]), snap([pos('a', -65)])).sound, 'exit');
  assert.equal(tradeEvents(snap([pos('a', 65)]), snap([])).sound, 'exit');
  assert.equal(tradeEvents(snap([pos('a', 65)]), snap([pos('a', 0)])).sound, 'exit');
  assert.deepEqual(tradeEvents(snap([pos('a', 65)]), snap([pos('a', 65)])), { sound: null, toasts: [] });
});

test('server-fired exit: sent = exit + toast worded from firedBy; a problem = warn + error toast with the note', () => {
  const was = snap([pos('a', 65)], { a: exit('watching') });
  const hit = tradeEvents(was, snap([pos('a', 65)], { a: exit('sent', { firedBy: 'target' }) }));
  assert.equal(hit.sound, 'exit');
  assert.deepEqual(hit.toasts, [{ kind: 'success', title: 'Target hit — NIFTY 25200 PE closed' }]);
  assert.equal(tradeEvents(was, snap([], { a: exit('sent', { firedBy: 'sl' }) })).toasts[0].title, 'Stop-loss hit — NIFTY 25200 PE closed');
  for (const st of ['unknown', 'incomplete', 'rejected'] as const) {
    const r = tradeEvents(was, snap([pos('a', 65)], { a: exit(st, { note: 'check the broker' }) }));
    assert.equal(r.sound, 'warn');
    assert.deepEqual(r.toasts, [{ kind: 'error', title: `NIFTY 25200 PE: exit ${st.toUpperCase()}`, detail: 'check the broker' }]);
  }
  // Unchanged state: nothing, even if it is a problem state (announced once, when it changed).
  const stuck = snap([pos('a', 65)], { a: exit('unknown') });
  assert.deepEqual(tradeEvents(stuck, stuck), { sound: null, toasts: [] });
});

test('global exit: sent = exit + toast, a problem = warn', () => {
  const g = (state: 'watching' | 'sent' | 'rejected', firedBy?: 'target' | 'sl') =>
    ({ target: 1000, sl: null, armedAt: 0, state, firedBy, note: state === 'rejected' ? 'no' : undefined });
  const hit = tradeEvents(snap([], {}, g('watching')), snap([], {}, g('sent', 'target')));
  assert.equal(hit.sound, 'exit');
  assert.equal(hit.toasts[0].title, 'Total target hit — all positions closed');
  assert.equal(tradeEvents(snap([], {}, g('watching')), snap([], {}, g('rejected', 'sl'))).sound, 'warn');
});

test('priority inside one poll: warn > exit > entry', () => {
  const prev = snap([pos('a', 65), pos('b', 65)], { a: exit('watching'), c: exit('watching') });
  const cur = snap([pos('a', 0), pos('b', 130), pos('n', 65)], { a: exit('sent', { firedBy: 'sl' }), c: exit('rejected') });
  assert.equal(tradeEvents(prev, cur).sound, 'warn');
  assert.equal(tradeEvents(snap([pos('a', 65)]), snap([pos('a', 0), pos('n', 65)])).sound, 'exit');
});

test('streakStart: rings when a run of 3+ starts or turns, not while it grows', () => {
  assert.equal(streakStart(null, { dir: 1, n: 3 }), true);
  assert.equal(streakStart({ dir: 1 }, { dir: 1, n: 4 }), false);
  assert.equal(streakStart({ dir: 1 }, { dir: -1, n: 3 }), true);
  assert.equal(streakStart(null, { dir: 1, n: 2 }), false);
  assert.equal(streakStart({ dir: -1 }, null), false);
});
