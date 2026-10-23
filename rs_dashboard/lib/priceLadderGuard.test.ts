import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGuards, carryRuntime, cleanGuard, evalGuard, guardKey, lockFloor, parseGuardKey, scopeMtm, type LadderGuard } from './priceLadderGuard.ts';
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
  // The exit is only queued: the guard stays on until the slice has closed, then switches off and says why.
  assert.equal(r.next.guards!['dhan:sim'].on, true);
  const done = { ...r.next, slices: r.next.slices.map(x => (x.id === 's1' ? { ...x, state: 'closed' as const } : x)) };
  const off = applyGuards(done, {}, 2).next.guards!['dhan:sim'];
  assert.equal(off.on, false);
  assert.ok(off.firedReason);
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
  assert.equal(r2.next.guards!['dhan:sim'].on, true);
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

test('a rejected exit is re-queued: the guard stays on until the slice is closed', () => {
  const s = state([slice({})], { 'dhan:real': g({ target: 500 }) });
  const real = { ...s, slices: s.slices.map(x => ({ ...x, mode: 'real' as const })) };
  const r1 = applyGuards(real, { 1: 106 }, 1);
  assert.equal(r1.next.guards!['dhan:real'].on, true);          // exit queued, slice not closed yet
  // The exit was rejected: back to open, no exitWanted (an automatic reason is not kept).
  const back = { ...r1.next, slices: r1.next.slices.map(x => ({ ...x, state: 'open' as const, exitWanted: undefined })) };
  const r2 = applyGuards(back, { 1: 99 }, 2);
  assert.match(r2.next.slices[0].exitWanted ?? '', /target/);   // queued again although the price fell back
  assert.equal(r2.next.guards!['dhan:real'].on, true);
  const closed = { ...r2.next, slices: r2.next.slices.map(x => ({ ...x, state: 'closed' as const })) };
  assert.equal(applyGuards(closed, {}, 3).next.guards!['dhan:real'].on, false);
});

test('REAL: a long (hedge) exits only after the shorts', () => {
  const short = slice({ id: 'sh', mode: 'real', side: 'SELL' });
  const hedge = slice({ id: 'hg', mode: 'real', side: 'BUY', contract: { ...(slice({}).contract as object), securityId: '2' } });
  const s = state([short, hedge], { 'dhan:real': g({ stop: 100 }) });
  const r1 = applyGuards(s, { 1: 100, 2: 1 }, 1);      // short loses: (100-? ) ensure trip below
  const forced = applyGuards({ ...s, guards: { 'dhan:real': g({ stop: 100, tripped: 'MTM stop-loss ₹100 hit' }) } }, { 1: 100, 2: 1 }, 1);
  const by = (st: LadderState, id: string) => st.slices.find(x => x.id === id)!;
  assert.ok(by(forced.next, 'sh').exitWanted);
  assert.equal(by(forced.next, 'hg').exitWanted, undefined);
  void r1;
  const shortsGone = { ...forced.next, slices: forced.next.slices.map(x => (x.id === 'sh' ? { ...x, state: 'closed' as const, exitWanted: undefined } : x)) };
  assert.ok(by(applyGuards(shortsGone, { 2: 1 }, 2).next, 'hg').exitWanted);
});

test('an exiting REAL slice with a price still counts in the MTM', () => {
  const s = state([slice({ mode: 'real', state: 'exiting' })], { 'dhan:real': g({ target: 500 }) });
  assert.ok(applyGuards(s, { 1: 106 }, 1).next.slices[0]);
  assert.equal(applyGuards(s, { 1: 106 }, 1).fired.length, 1);
});

// ── Two ladders: each guard sees and exits only the orders its own ladder placed (pane tag; untagged = ladder 1) ──

const L1 = { broker: 'dhan', mode: 'sim', pane: 1 } as const;
const L2 = { broker: 'dhan', mode: 'sim', pane: 2 } as const;
// Ladder 1 long on contract 1 (+600 at 106); ladder 2 long on contract 2 (−900 at 91); both on dhan SIM.
const twoLadders = (guards: Record<string, LadderGuard>) => state([
  slice({ id: 'a1' }),
  slice({ id: 'a1-armed', state: 'armed' }),
  slice({ id: 'b2', pane: 2, contract: { ...(slice({}).contract as object), securityId: '2' } }),
  slice({ id: 'b2-armed', pane: 2, state: 'armed' }),
], guards);
const LTPS = { 1: 106, 2: 91 };

test('guard keys: ladder 1 keeps the pre-pane key, ladder 2 adds :2, anything else is ignored', () => {
  assert.equal(guardKey('dhan', 'sim'), 'dhan:sim');
  assert.equal(guardKey('dhan', 'sim', 1), 'dhan:sim');
  assert.equal(guardKey('kotak', 'real', 2), 'kotak:real:2');
  assert.deepEqual(parseGuardKey('dhan:sim'), L1);
  assert.deepEqual(parseGuardKey('dhan:sim:2'), L2);
  for (const bad of ['dhan:sim:1', 'dhan:sim:3', 'dhan:sim:2:x', 'ibkr:sim', 'dhan:paper', 'junk']) assert.equal(parseGuardKey(bad), null, bad);
});

test('each ladder reads only its own MTM on the same broker + mode', () => {
  const s = twoLadders({});
  assert.equal(scopeMtm(s, L1, LTPS), 600);
  assert.equal(scopeMtm(s, L2, LTPS), -900);
  // A ladder with nothing of its own has no reading (no decision), even when the other ladder has positions.
  assert.equal(scopeMtm(state([slice({ id: 'a1' })], {}), L2, LTPS), null);
});

test('ladder 1 tripping exits and cancels only ladder 1; ladder 2 is untouched', () => {
  const r = applyGuards(twoLadders({ 'dhan:sim': g({ target: 500 }) }), LTPS, 1);
  const by = (id: string) => r.next.slices.find(x => x.id === id)!;
  assert.deepEqual(r.fired.map(f => [f.pane, f.broker, f.mode]), [[1, 'dhan', 'sim']]);
  assert.match(by('a1').exitWanted ?? '', /target/);
  assert.equal(by('a1-armed').state, 'cancelled');
  assert.equal(by('b2').exitWanted, undefined);
  assert.equal(by('b2-armed').state, 'armed');
  // Combined MTM is −300, so a combined guard would never have hit +500: this one read ladder 1 alone.
});

test("ladder 2's own stop trips on ladder 2's loss only, and says so", () => {
  const r = applyGuards(twoLadders({ 'dhan:sim': g({ stop: 800 }), 'dhan:sim:2': g({ stop: 800 }) }), LTPS, 1);
  const by = (id: string) => r.next.slices.find(x => x.id === id)!;
  assert.deepEqual(r.fired.map(f => f.pane), [2]);                 // ladder 1 is +600: its stop does not fire
  assert.match(by('b2').exitWanted ?? '', /stop-loss/);
  assert.equal(by('b2-armed').state, 'cancelled');
  assert.equal(by('a1').exitWanted, undefined);
  assert.equal(by('a1-armed').state, 'armed');
  assert.equal(r.next.guards!['dhan:sim'].on, true);
  assert.equal(r.next.guards!['dhan:sim'].tripped, undefined);
  assert.match(r.next.events.at(-1)!.msg, /ladder 2 · dhan SIM/);
});

test("a ladder's tripped guard switches off once ITS positions are gone, whatever the other ladder holds", () => {
  const r1 = applyGuards(twoLadders({ 'dhan:sim:2': g({ stop: 800 }) }), LTPS, 1);
  const closed = { ...r1.next, slices: r1.next.slices.map(x => (x.id === 'b2' ? { ...x, state: 'closed' as const } : x)) };
  const off = applyGuards(closed, LTPS, 2).next.guards!['dhan:sim:2'];
  assert.equal(off.on, false);                                     // ladder 1's open a1 does not keep it on
});

test('REAL: shorts-before-hedges is per ladder — a ladder 2 short does not hold back ladder 1', () => {
  const long1 = slice({ id: 'l1', mode: 'real', side: 'BUY' });
  const short2 = slice({ id: 's2', mode: 'real', side: 'SELL', pane: 2, contract: { ...(slice({}).contract as object), securityId: '2' } });
  const s = state([long1, short2], { 'dhan:real': g({ stop: 100, tripped: 'MTM stop-loss ₹100 hit' }) });
  const r = applyGuards(s, { 1: 100, 2: 100 }, 1);
  assert.ok(r.next.slices.find(x => x.id === 'l1')!.exitWanted);
  assert.equal(r.next.slices.find(x => x.id === 's2')!.exitWanted, undefined);
});

test('pairs are scoped by ladder too: an armed ladder 2 pair survives a ladder 1 trip', () => {
  const pair = { id: 'p2', broker: 'dhan', mode: 'sim', structure: 'straddle', side: 'SELL', lots: 1, qty: 100, product: 'MIS',
    state: 'armed', pane: 2, legs: { ce: { contract: slice({}).contract }, pe: { contract: slice({}).contract } }, createdAt: 0, updatedAt: 0 };
  const s = { ...twoLadders({ 'dhan:sim': g({ target: 500 }) }), pairs: [pair] as unknown as LadderState['pairs'] };
  const r = applyGuards(s, LTPS, 1);
  assert.equal(r.next.pairs![0].state, 'armed');
  const s1 = { ...s, pairs: [{ ...pair, pane: undefined }] as unknown as LadderState['pairs'] };
  assert.equal(applyGuards(s1, LTPS, 1).next.pairs![0].state, 'cancelled');
});
