import test from 'node:test';
import assert from 'node:assert/strict';
import { planExitAll } from './priceLadderExitAll.ts';
import type { LadderState } from './priceLadder.ts';

// Only the fields planExitAll reads; the rest of a slice / pair / basket is irrelevant to it.
const slice = (id: string, state: string, o: Record<string, unknown> = {}) => ({
  id, state, broker: 'dhan', mode: 'real', side: 'SELL', filledQty: 75, contract: { securityId: `sec-${id}` }, ...o,
});
const pair = (id: string, state: string, o: Record<string, unknown> = {}) => ({ id, state, broker: 'dhan', mode: 'real', ...o });
const basket = (id: string, state: string, o: Record<string, unknown> = {}) => ({ id, state, broker: 'dhan', mode: 'real', ...o });
const ledger = (slices: unknown[] = [], pairs: unknown[] = [], baskets: unknown[] = []) =>
  ({ date: '2026-10-28', slices, events: [], pairs, baskets }) as unknown as LadderState;

test('every open position is exited, across brokers, modes and kinds', () => {
  const p = planExitAll(ledger(
    [slice('a', 'open'), slice('b', 'open', { broker: 'kotak', mode: 'sim' }), slice('c', 'open', { broker: 'zerodha' })],
    [pair('p1', 'open'), pair('p2', 'broken'), pair('p3', 'rolling')],
    [basket('k1', 'open'), basket('k2', 'broken')],
  ));
  assert.deepEqual(p.sliceIds.sort(), ['a', 'b', 'c']);
  assert.deepEqual(p.pairIds.sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(p.basketIds.sort(), ['k1', 'k2']);
  assert.equal(p.positions, 8);
});

test('slices of one contract and side count as one position', () => {
  const p = planExitAll(ledger([
    slice('a', 'open', { contract: { securityId: 'X' } }),
    slice('b', 'open', { contract: { securityId: 'X' } }), // a "+1 lot" on the same contract
    slice('c', 'open', { contract: { securityId: 'X' }, side: 'BUY' }),
  ]));
  assert.equal(p.sliceIds.length, 3); // all three are marked ...
  assert.equal(p.positions, 2);       // ... but the screen counts contract + side, like the page's own counter
});

test('already exiting, exiting-wanted and flat things are not exited again', () => {
  const p = planExitAll(ledger(
    [slice('a', 'exiting'), slice('b', 'open', { exitWanted: 'Manual exit' }), slice('c', 'closed'), slice('d', 'cancelled'), slice('e', 'rejected')],
    [pair('p1', 'exiting'), pair('p2', 'open', { exitWanted: 'Manual exit' }), pair('p3', 'closed')],
    [basket('k1', 'exiting'), basket('k2', 'open', { exitWanted: 'Manual exit' })],
  ));
  assert.deepEqual([p.sliceIds, p.pairIds, p.basketIds], [[], [], []]);
  assert.equal(p.positions, 0);
  assert.equal(p.alreadyExiting, 6);
});

test('armed and working levels are listed to cancel, separately from positions', () => {
  const p = planExitAll(ledger(
    [slice('a', 'armed'), slice('b', 'working', { orderId: '77' }), slice('c', 'open')],
    [pair('p1', 'armed')],
    [basket('k1', 'armed')],
  ));
  assert.deepEqual(p.cancelSliceIds.sort(), ['a', 'b']);
  assert.deepEqual(p.cancelPairIds, ['p1']);
  assert.deepEqual(p.cancelBasketIds, ['k1']);
  assert.deepEqual(p.sliceIds, ['c']);
});

test('UNKNOWN and in-flight entries are reported, never exited or cancelled', () => {
  const p = planExitAll(ledger(
    [slice('a', 'unknown'), slice('b', 'placing')],
    [pair('p1', 'unknown'), pair('p2', 'placing')],
    [basket('k1', 'unknown'), basket('k2', 'placing')],
  ));
  assert.equal(p.unknown, 3);
  assert.equal(p.inFlight, 3);
  assert.deepEqual([p.sliceIds, p.pairIds, p.basketIds, p.cancelSliceIds, p.cancelPairIds, p.cancelBasketIds], [[], [], [], [], [], []]);
});

test('groups summarise by broker and mode for the confirm dialog', () => {
  const p = planExitAll(ledger(
    [slice('a', 'open'), slice('b', 'armed'), slice('c', 'open', { broker: 'kotak', mode: 'sim' })],
    [pair('p1', 'open', { broker: 'kotak', mode: 'sim' })],
  ));
  const g = (b: string, m: string) => p.groups.find(x => x.broker === b && x.mode === m);
  assert.deepEqual([g('dhan', 'real')?.positions, g('dhan', 'real')?.pending], [1, 1]);
  assert.deepEqual([g('kotak', 'sim')?.positions, g('kotak', 'sim')?.pending], [2, 0]);
  assert.equal(p.groups.length, 2);
});

test('the signature changes when anything to exit or cancel changes, and not otherwise', () => {
  const base = ledger([slice('a', 'open'), slice('b', 'armed')]);
  const same = ledger([slice('b', 'armed'), slice('a', 'open')]); // order of the rows is irrelevant
  assert.equal(planExitAll(base).signature, planExitAll(same).signature);
  assert.notEqual(planExitAll(base).signature, planExitAll(ledger([slice('a', 'open'), slice('b', 'armed'), slice('c', 'open')])).signature);
  assert.notEqual(planExitAll(base).signature, planExitAll(ledger([slice('a', 'open')])).signature); // an armed level vanished
  assert.notEqual(planExitAll(base).signature, planExitAll(ledger([slice('a', 'exiting'), slice('b', 'armed')])).signature);
});

test('an empty ledger plans nothing', () => {
  const p = planExitAll(ledger());
  assert.equal(p.positions + p.unknown + p.inFlight + p.alreadyExiting, 0);
  assert.deepEqual(p.groups, []);
});
