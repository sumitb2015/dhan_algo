import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGuards, carryRuntime, cleanGuard, evalGuard, lockFloor, type LadderGuard } from './priceLadderGuard.ts';
import type { LadderState } from './priceLadder.ts';

const g = (o: Partial<LadderGuard> = {}): LadderGuard => ({ on: true, ...o });

test('target and stop', () => {
  assert.match(evalGuard(g({ target: 1000 }), 1000).reason ?? '', /target/);
  assert.equal(evalGuard(g({ target: 1000 }), 999).reason, null);
  assert.match(evalGuard(g({ stop: 500 }), -500).reason ?? '', /stop-loss/);
  assert.equal(evalGuard(g({ stop: 500 }), -499).reason, null);
});

test('off or no reading does nothing', () => {
  assert.equal(evalGuard(g({ on: false, target: 1 }), 5).reason, null);
  assert.equal(evalGuard(g({ target: 1 }), null).reason, null);
});

test('trailing gives back from the peak', () => {
  let x = g({ trailBy: 300 });
  for (const m of [100, 800, 600]) { const r = evalGuard(x, m); assert.equal(r.reason, null); x = r.guard; }
  assert.equal(x.peak, 800);
  assert.match(evalGuard(x, 500).reason ?? '', /Trailing/);
});

test('protect profit: lock appears at the trigger, steps up, never drops', () => {
  const x = g({ lockAt: 1000, lockKeep: 400, lockStepEvery: 500, lockStepKeep: 250 });
  assert.equal(lockFloor(x, 999), null);
  assert.equal(lockFloor(x, 1000), 400);
  assert.equal(lockFloor(x, 1499), 400);
  assert.equal(lockFloor(x, 1500), 650);
  let y = x;
  for (const m of [900, 1600]) y = evalGuard(y, m).guard;
  assert.equal(y.floor, 650);
  assert.equal(evalGuard(y, 700).reason, null);
  assert.match(evalGuard(y, 650).reason ?? '', /Profit protected/);
});

test('cleanGuard rejects inconsistent levels', () => {
  assert.equal(typeof cleanGuard({ on: true }), 'string');
  assert.equal(typeof cleanGuard({ on: true, lockAt: 1000 }), 'string');
  assert.equal(typeof cleanGuard({ on: true, lockAt: 1000, lockKeep: 1000 }), 'string');
  assert.equal(typeof cleanGuard({ on: true, target: 900, lockAt: 1000, lockKeep: 100 }), 'string');
  assert.equal(typeof cleanGuard({ on: true, lockAt: 1000, lockKeep: 0 }), 'object');
  assert.equal(typeof cleanGuard({ on: false }), 'object');
});

const slice = (o: Record<string, unknown>) => ({
  id: 's1', kind: 'xy', broker: 'dhan', mode: 'sim', side: 'BUY', lots: 1, qty: 100, product: 'MIS', state: 'open',
  contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '1', lotSize: 100 },
  avg: 100, filledQty: 100, createdAt: 0, updatedAt: 0, ...o,
});
const state = (slices: unknown[], guards: Record<string, LadderGuard>): LadderState => ({ date: '2026-10-22', slices: slices as LadderState['slices'], events: [], guards });

test('a trip queues every open exit, cancels armed levels, scopes by broker+mode, and switches off', () => {
  const s = state([slice({}), slice({ id: 's2', state: 'armed' }), slice({ id: 's3', mode: 'real' })], { 'dhan:sim': g({ target: 500 }) });
  const r = applyGuards(s, { 1: 106 }, 1);
  assert.equal(r.fired.length, 1);
  const by = (id: string) => r.next.slices.find(x => x.id === id)!;
  assert.match(by('s1').exitWanted ?? '', /target/);
  assert.equal(by('s2').state, 'cancelled');
  assert.equal(by('s3').exitWanted, undefined);
  assert.equal(r.next.guards!['dhan:sim'].on, false);
  assert.ok(r.next.guards!['dhan:sim'].firedReason);
});

test('no price for an open leg: no decision', () => {
  const r = applyGuards(state([slice({})], { 'dhan:sim': g({ stop: 1 }) }), {}, 1);
  assert.equal(r.fired.length, 0);
});

test('Update keeps the best MTM and the locked profit; off then on starts fresh', () => {
  const old = g({ target: 5000, peak: 10_000, floor: 6000, tripped: undefined });
  const kept = carryRuntime(g({ target: 6000 }), old);
  assert.equal(kept.peak, 10_000);
  assert.equal(kept.floor, 6000);
  assert.equal(kept.target, 6000);
  assert.equal(carryRuntime(g({ target: 6000 }), { ...old, on: false }).peak, undefined);
  assert.equal(carryRuntime({ on: false }, old).peak, undefined);
});

test('an entry in flight keeps a tripped guard on and it exits what then opens', () => {
  const s = state([slice({}), slice({ id: 's4', state: 'placing' })], { 'dhan:sim': g({ target: 500 }) });
  const r1 = applyGuards(s, { 1: 106 }, 1);
  assert.equal(r1.fired.length, 1);
  const gd = r1.next.guards!['dhan:sim'];
  assert.equal(gd.on, true);
  assert.match(gd.tripped ?? '', /target/);
  // The placing entry fills; the next tick (price now back down) still exits it and, with nothing in flight, switches off.
  const filled = { ...r1.next, slices: r1.next.slices.map(x => (x.id === 's4' ? { ...x, state: 'open' as const } : x)) };
  const r2 = applyGuards(filled, { 1: 90 }, 2);
  assert.equal(r2.fired.length, 0);
  assert.match(r2.next.slices.find(x => x.id === 's4')!.exitWanted ?? '', /target/);
  assert.equal(r2.next.guards!['dhan:sim'].on, false);
});

test('a resting REAL order keeps the guard on until it is gone', () => {
  const s = state([slice({ id: 'r1', mode: 'real', state: 'working' })], { 'dhan:real': g({ stop: 100 }) });
  // No open leg to price, so trip it directly.
  const r = applyGuards({ ...s, guards: { 'dhan:real': g({ stop: 100, tripped: 'MTM stop-loss ₹100 hit' }) } }, {}, 1);
  assert.equal(r.next.guards!['dhan:real'].on, true);
  const gone = { ...r.next, slices: r.next.slices.map(x => ({ ...x, state: 'cancelled' as const })) };
  assert.equal(applyGuards(gone, {}, 2).next.guards!['dhan:real'].on, false);
});

test('a malformed guard key is ignored', () => {
  const r = applyGuards(state([slice({})], { 'junk': g({ target: 1 }) }), { 1: 999 }, 1);
  assert.equal(r.fired.length, 0);
});
