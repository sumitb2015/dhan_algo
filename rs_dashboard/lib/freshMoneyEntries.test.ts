import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedQty, classifyEntry, entryAfterFire, entryLabel, entryStep, levelProblem, limitSide, ENTRY_STREAK_GAP_MS, type FmEntry,
} from './freshMoneyEntries.ts';
import { runEntryTick, type EntryTickDeps } from './freshMoneyEntryTick.ts';
import type { CloseResult } from './freshMoneyExits.ts';
import type { FmLedger } from './freshMoneyTrades.ts';

test('limit vs stop follows the XY ladder: a CE is cheaper lower, a PE higher', () => {
  assert.equal(limitSide('CE', 'BUY'), 'below');
  assert.equal(limitSide('CE', 'SELL'), 'above');
  assert.equal(limitSide('PE', 'BUY'), 'above');
  assert.equal(limitSide('PE', 'SELL'), 'below');
  const spot = 25300;
  assert.deepEqual(classifyEntry('CE', 'BUY', 25250, spot), { dir: 'below', kind: 'limit' });
  assert.deepEqual(classifyEntry('CE', 'BUY', 25350, spot), { dir: 'above', kind: 'stop' });     // breakout buy
  assert.deepEqual(classifyEntry('PE', 'BUY', 25350, spot), { dir: 'above', kind: 'limit' });
  assert.deepEqual(classifyEntry('PE', 'SELL', 25350, spot), { dir: 'above', kind: 'stop' });
  assert.deepEqual(classifyEntry('CE', 'SELL', 25350, spot), { dir: 'above', kind: 'limit' });
  assert.deepEqual(classifyEntry('PE', 'SELL', 25250, spot), { dir: 'below', kind: 'limit' });
});

test('level sanity: positive, not the price itself, within 5 % of it; no price = refused', () => {
  assert.equal(levelProblem(25250, 25300), null);
  assert.match(levelProblem(0, 25300)!, /Enter a level/);
  assert.match(levelProblem(NaN, 25300)!, /Enter a level/);
  assert.match(levelProblem(25300, 25300)!, /current price/);
  assert.match(levelProblem(23000, 25300)!, /more than 5%/);
  assert.match(levelProblem(25250, NaN)!, /No live price/);
});

test('entryStep: fires on the second breached check in a row; a gap, a miss or no price resets', () => {
  const e = { level: 25250, dir: 'below' as const };
  let s = entryStep(e, 25260, null, 0);
  assert.deepEqual(s, { streak: null, fire: false });                       // not there yet
  s = entryStep(e, 25250, null, 1000);
  assert.equal(s.fire, false);                                              // first touch (at the level counts)
  assert.equal(entryStep(e, 25240, s.streak, 3000).fire, true);             // second in a row
  assert.equal(entryStep(e, 25240, s.streak, 1000 + ENTRY_STREAK_GAP_MS + 1).fire, false);  // too far apart: restarts
  assert.deepEqual(entryStep(e, null, s.streak, 3000), { streak: null, fire: false });       // no price: reset
  const up = { level: 25350, dir: 'above' as const };
  assert.equal(entryStep(up, 25351, entryStep(up, 25350, null, 0).streak, 2000).fire, true);
});

const base = (o: Partial<FmEntry> = {}): FmEntry => ({
  id: 'e1', ts: 0, broker: 'dhan', underlying: 'NIFTY', expiry: '2026-11-17', strike: 25300, opt: 'CE', side: 'BUY', lots: 1,
  product: 'MIS', exitDefaults: { target: null, sl: null }, level: 25250, dir: 'below', kind: 'limit', key: 'dhan|111',
  qty: 65, lot: 65, state: 'armed', spotAtArm: 25300, ...o,
});

test('armed entries count toward the cap as if they fill; firing / ended ones do not', () => {
  const es = [base(), base({ id: 'e2', side: 'SELL', qty: 130 }), base({ id: 'e3', state: 'firing' }), base({ id: 'e4', key: 'dhan|222' })];
  assert.equal(armedQty(es, 'dhan|111'), 65 - 130);
  assert.equal(armedQty(undefined, 'dhan|111'), 0);
});

test('outcome of a fire: placed = sent, UNKNOWN / partial = unknown (never resent), refused / rejected = rejected', () => {
  assert.deepEqual(entryAfterFire({ kind: 'placed', orderId: 'X1' }, 5), { state: 'sent', orderId: 'X1', endedAt: 5 });
  assert.equal(entryAfterFire({ kind: 'unknown', error: 'timeout' }, 5).state, 'unknown');
  assert.equal(entryAfterFire({ kind: 'refused', error: 'stale board' }, 5).state, 'rejected');
  assert.equal(entryLabel(base()), 'B ≤25,250');
  assert.equal(entryLabel(base({ side: 'SELL', dir: 'above', level: 25400.5 })), 'S ≥25,400.5');
});

// ── the tick, with fake deps ──────────────────────────────────────────────────────────────────────────────────────

function harness(entries: FmEntry[], o: { spots?: (number | null)[]; gate?: 'open' | 'close-only' | 'closed'; held?: boolean; fire?: () => Promise<CloseResult> } = {}) {
  const ledger: FmLedger = { date: '2026-11-16', orders: [], entries };
  let t = 0;
  const spots = [...(o.spots ?? [])];
  const fired: FmEntry[] = [];
  const deps: EntryTickDeps = {
    now: () => t,
    readLedger: () => ledger,
    mutate: async fn => fn(ledger),
    spot: () => (spots.length ? spots.shift()! : null),
    gate: () => o.gate ?? 'open',
    held: () => o.held ?? false,
    fire: async e => { fired.push(e); return o.fire ? o.fire() : { kind: 'placed', orderId: 'X1' }; },
    log: () => {},
  };
  const streaks = new Map();
  return { ledger, deps, streaks, fired, step: (ms: number) => { t += ms; } };
}

test('tick: fires once on the second breached check, records the order, never fires again', async () => {
  const h = harness([base()], { spots: [25249, 25248, 25240, 25230] });
  await runEntryTick(h.deps, h.streaks);
  assert.equal(h.fired.length, 0);
  h.step(2000);
  await runEntryTick(h.deps, h.streaks);
  assert.equal(h.fired.length, 1);
  assert.equal(h.ledger.entries![0].state, 'sent');
  assert.equal(h.ledger.entries![0].orderId, 'X1');
  assert.equal(h.ledger.entries![0].spotAtFire, 25248);
  h.step(2000); await runEntryTick(h.deps, h.streaks);
  h.step(2000); await runEntryTick(h.deps, h.streaks);
  assert.equal(h.fired.length, 1);
});

test('tick: UNKNOWN and a throw are recorded as unknown and never resent; a refusal is rejected', async () => {
  const u = harness([base()], { spots: [25240, 25240, 25240, 25240], fire: async () => ({ kind: 'unknown', error: 'no reply', partial: false }) });
  await runEntryTick(u.deps, u.streaks); u.step(2000); await runEntryTick(u.deps, u.streaks);
  u.step(2000); await runEntryTick(u.deps, u.streaks);
  assert.equal(u.fired.length, 1);
  assert.equal(u.ledger.entries![0].state, 'unknown');
  const th = harness([base()], { spots: [25240, 25240], fire: async () => { throw new Error('boom'); } });
  await runEntryTick(th.deps, th.streaks); th.step(2000); await runEntryTick(th.deps, th.streaks);
  assert.equal(th.ledger.entries![0].state, 'unknown');
  const r = harness([base()], { spots: [25240, 25240], fire: async () => ({ kind: 'refused', error: 'stale board', http: 409 }) });
  await runEntryTick(r.deps, r.streaks); r.step(2000); await runEntryTick(r.deps, r.streaks);
  assert.deepEqual([r.ledger.entries![0].state, r.ledger.entries![0].reason], ['rejected', 'stale board']);
});

test('tick: a missing price between two touches resets the count', async () => {
  const h = harness([base()], { spots: [25240, null, 25240, 25240] });
  for (let i = 0; i < 3; i++) { await runEntryTick(h.deps, h.streaks); h.step(2000); }
  assert.equal(h.fired.length, 0);                       // touch, gap, touch (count 1)
  await runEntryTick(h.deps, h.streaks);
  assert.equal(h.fired.length, 1);
});

test('tick: waits while an order on the contract is in flight; one fire per contract per tick', async () => {
  const held = harness([base()], { spots: [25240, 25240, 25240], held: true });
  for (let i = 0; i < 3; i++) { await runEntryTick(held.deps, held.streaks); held.step(2000); }
  assert.equal(held.fired.length, 0);
  assert.equal(held.ledger.entries![0].state, 'armed');
  const two = harness([base(), base({ id: 'e2' })], { spots: [25240, 25240] });   // both on dhan|111, same price this tick
  await runEntryTick(two.deps, two.streaks); two.step(2000); await runEntryTick(two.deps, two.streaks);
  assert.equal(two.fired.length, 1);
});

test('tick: an armed entry expires when its product can no longer open; a stale firing one becomes unknown', async () => {
  const h = harness([base()], { gate: 'close-only' });
  await runEntryTick(h.deps, h.streaks);
  assert.equal(h.ledger.entries![0].state, 'expired');
  const f = harness([base({ state: 'firing', firedAt: 0 })]);
  f.step(61_000);
  await runEntryTick(f.deps, f.streaks);
  assert.equal(f.ledger.entries![0].state, 'unknown');
  assert.equal(f.fired.length, 0);
});
