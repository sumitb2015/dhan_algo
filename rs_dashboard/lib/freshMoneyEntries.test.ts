import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedQty, classifyEntry, entryAfterFire, entryFires, entryLabel, globalFired, levelProblem, limitSide, type FmEntry, type SpotQuote,
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
  assert.deepEqual(classifyEntry('CE', 'SELL', 25350, spot), { dir: 'above', kind: 'limit' });   // the live trial: S ≥25,230
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

test('entryFires: the first NEW tick at or past the level fires; an old print, no quote or the wrong side never does', () => {
  const e = { level: 25230, dir: 'above' as const, ts: 1000 };
  assert.equal(entryFires(e, { ltp: 25230, changedMs: 1500 }), true);       // at the level, a tick after arming
  assert.equal(entryFires(e, { ltp: 25235.15, changedMs: 1500 }), true);
  assert.equal(entryFires(e, { ltp: 25229.95, changedMs: 1500 }), false);   // not there yet
  assert.equal(entryFires(e, { ltp: 25240, changedMs: 900 }), false);       // a print from before it was armed
  assert.equal(entryFires(e, { ltp: 25240, changedMs: null }), false);      // never changed since subscribing
  assert.equal(entryFires(e, null), false);
  assert.equal(entryFires({ level: 25250, dir: 'below', ts: 0 }, { ltp: 25250, changedMs: 5 }), true);
});

const base = (o: Partial<FmEntry> = {}): FmEntry => ({
  id: 'e1', ts: 1000, broker: 'dhan', underlying: 'NIFTY', expiry: '2026-11-17', strike: 25300, opt: 'CE', side: 'BUY', lots: 1,
  product: 'MIS', exitDefaults: { target: null, sl: null }, level: 25250, dir: 'below', kind: 'limit', key: 'dhan|111',
  qty: 65, lot: 65, state: 'armed', spotAtArm: 25300, ...o,
});

test('armed entries are counted per direction (an armed SELL never offsets a BUY); firing / ended ones are not', () => {
  const es = [base(), base({ id: 'e2', side: 'SELL', qty: 130 }), base({ id: 'e3', state: 'firing' }), base({ id: 'e4', key: 'dhan|222' })];
  assert.deepEqual(armedQty(es, 'dhan|111'), { buy: 65, sell: 130 });
  assert.deepEqual(armedQty(undefined, 'dhan|111'), { buy: 0, sell: 0 });
  // The review's case: 3 x 20-lot SELLs armed, then BUY clicks. With the worst case per side, the 4th BUY of 20 is the
  // one that crosses 60 (BUY side alone: 80 > 60), never the 7th.
  const lot = 1, cap = 60;
  const armed = { buy: 0, sell: 60 };
  const worst = (x: number) => Math.max(Math.abs(x + armed.buy), Math.abs(x - armed.sell));
  let held = 0, accepted = 0;
  for (let i = 0; i < 6; i++) {
    const after = held + 20;
    if (worst(after) > cap * lot && worst(after) > worst(held)) break;
    held = after; accepted++;
  }
  assert.equal(accepted, 3);
});

test('outcome of a fire: placed = sent, UNKNOWN / partial = unknown (never resent), refused / rejected = rejected', () => {
  assert.deepEqual(entryAfterFire({ kind: 'placed', orderId: 'X1' }, 5), { state: 'sent', orderId: 'X1', endedAt: 5 });
  assert.equal(entryAfterFire({ kind: 'unknown', error: 'timeout' }, 5).state, 'unknown');
  assert.equal(entryAfterFire({ kind: 'refused', error: 'stale board' }, 5).state, 'rejected');
  assert.equal(entryLabel(base()), 'B ≤25,250');
  assert.equal(entryLabel(base({ side: 'SELL', dir: 'above', level: 25400.5 })), 'S ≥25,400.5');
  assert.equal(globalFired(null), false);
  assert.equal(globalFired({ state: 'watching' }), false);
  assert.equal(globalFired({ state: 'sent' }), true);
});

// ── the tick, with fake deps ──────────────────────────────────────────────────────────────────────────────────────

function harness(entries: FmEntry[], o: {
  quotes?: (SpotQuote | null)[]; gate?: 'open' | 'close-only' | 'closed'; held?: boolean; global?: FmLedger['global'];
  fire?: () => Promise<CloseResult>;
} = {}) {
  const ledger: FmLedger = { date: '2026-11-16', orders: [], entries, ...(o.global ? { global: o.global } : {}) };
  let t = 2000;
  const quotes = [...(o.quotes ?? [])];
  const fired: FmEntry[] = [];
  const deps: EntryTickDeps = {
    now: () => t,
    readLedger: () => ledger,
    mutate: async fn => fn(ledger),
    spot: () => (quotes.length ? quotes.shift()! : null),
    gate: () => o.gate ?? 'open',
    held: () => o.held ?? false,
    fire: async e => { fired.push(e); return o.fire ? o.fire() : { kind: 'placed', orderId: 'X1' }; },
    log: () => {},
  };
  return { ledger, deps, fired, step: (ms: number) => { t += ms; } };
}

test('tick: fires on the first new tick past the level, records the order, never fires again', async () => {
  const h = harness([base()], { quotes: [{ ltp: 25260, changedMs: 1500 }, { ltp: 25248, changedMs: 1800 }, { ltp: 25240, changedMs: 2100 }] });
  await runEntryTick(h.deps);
  assert.equal(h.fired.length, 0);
  h.step(250);
  await runEntryTick(h.deps);
  assert.equal(h.fired.length, 1);
  assert.deepEqual([h.ledger.entries![0].state, h.ledger.entries![0].orderId, h.ledger.entries![0].spotAtFire], ['sent', 'X1', 25248]);
  h.step(250); await runEntryTick(h.deps);
  assert.equal(h.fired.length, 1);
});

test('tick: an old print past the level (from before arming) does not fire', async () => {
  const h = harness([base()], { quotes: [{ ltp: 25240, changedMs: 500 }] });
  await runEntryTick(h.deps);
  assert.equal(h.fired.length, 0);
  assert.equal(h.ledger.entries![0].state, 'armed');
});

test('tick: UNKNOWN and a throw are recorded as unknown and never resent; a refusal is rejected', async () => {
  const q = { ltp: 25240, changedMs: 1500 };
  const u = harness([base()], { quotes: [q, q, q], fire: async () => ({ kind: 'unknown', error: 'no reply', partial: false }) });
  await runEntryTick(u.deps); u.step(250); await runEntryTick(u.deps); u.step(250); await runEntryTick(u.deps);
  assert.equal(u.fired.length, 1);
  assert.equal(u.ledger.entries![0].state, 'unknown');
  const th = harness([base()], { quotes: [q], fire: async () => { throw new Error('boom'); } });
  await runEntryTick(th.deps);
  assert.equal(th.ledger.entries![0].state, 'unknown');
  const r = harness([base()], { quotes: [q], fire: async () => ({ kind: 'refused', error: 'stale board', http: 409 }) });
  await runEntryTick(r.deps);
  assert.deepEqual([r.ledger.entries![0].state, r.ledger.entries![0].reason], ['rejected', 'stale board']);
});

test('tick: waits (stays armed) while an order on the contract is in flight; one fire per contract per tick', async () => {
  const q = { ltp: 25240, changedMs: 1500 };
  const held = harness([base()], { quotes: [q, q], held: true });
  await runEntryTick(held.deps); held.step(250); await runEntryTick(held.deps);
  assert.equal(held.fired.length, 0);
  assert.equal(held.ledger.entries![0].state, 'armed');
  const two = harness([base(), base({ id: 'e2' })], { quotes: [q] });
  await runEntryTick(two.deps);
  assert.equal(two.fired.length, 1);
  assert.deepEqual(two.ledger.entries!.map(e => e.state), ['sent', 'armed']);
});

test('tick: the total target / SL having fired cancels every armed level and fires none (the kill switch)', async () => {
  const h = harness([base(), base({ id: 'e2', key: 'dhan|222' })], {
    quotes: [{ ltp: 25240, changedMs: 1500 }], global: { target: null, sl: 5000, armedAt: 0, state: 'sent' },
  });
  await runEntryTick(h.deps);
  assert.equal(h.fired.length, 0);
  assert.deepEqual(h.ledger.entries!.map(e => e.state), ['cancelled', 'cancelled']);
});

test('tick: an armed entry expires when its product can no longer open; a stale firing one becomes unknown', async () => {
  const h = harness([base()], { gate: 'close-only' });
  await runEntryTick(h.deps);
  assert.equal(h.ledger.entries![0].state, 'expired');
  const f = harness([base({ state: 'firing', firedAt: 0 })]);
  f.step(61_000);
  await runEntryTick(f.deps);
  assert.equal(f.ledger.entries![0].state, 'unknown');
  assert.equal(f.fired.length, 0);
});
