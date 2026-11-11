import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExitTick, type ExitTickDeps } from './freshMoneyExitTick.ts';
import type { CloseResult, FmExit, Streak } from './freshMoneyExits.ts';
import { RECONCILE_GRACE_MS, type FmLedger, type FmOrder } from './freshMoneyTrades.ts';

const KEY = 'dhan|111';
const T0 = 1_000_000;

const buy = (p: Partial<FmOrder> = {}): FmOrder => ({
  id: 'o1', ts: T0 - 60_000, underlying: 'CRUDEOIL', expiry: '2026-11-17', strike: 8100, opt: 'CE', securityId: '111',
  segment: 'MCX_COMM', lot: 1, mult: 100, side: 'BUY', qty: 1, close: false, correlationId: 'fmabc', orderId: 'X1',
  state: 'filled', filledQty: 1, avgPrice: 100, ...p,
});
const watching = (p: Partial<FmExit> = {}): FmExit => ({
  key: KEY, openedAt: T0 - 60_000, dir: 'long', target: { value: 30, unit: 'pct' }, sl: { value: 20, unit: 'pct' },
  basis: 100, targetPx: 130, slPx: 80, state: 'watching', ...p,
});

function harness(ledger: FmLedger, opts: { ltp?: number | null; close?: CloseResult; canExit?: boolean; refresh?: (l: FmLedger) => void } = {}) {
  let now = T0;
  let ltp = opts.ltp === undefined ? 131 : opts.ltp;
  const closes: { key: string; reason: string }[] = [];
  let priceCalls = 0;
  let refreshes = 0;
  let closeResult: CloseResult = opts.close ?? { kind: 'placed', orderId: 'C1' };
  let beforeMutate: (() => void) | null = null;
  const deps: ExitTickDeps = {
    now: () => now,
    readLedger: () => structuredClone(ledger),
    mutate: async fn => { if (beforeMutate) { const b = beforeMutate; beforeMutate = null; b(); } return fn(ledger); },
    prices: async items => { priceCalls++; return ltp === null ? {} : Object.fromEntries(items.map(i => [i.id, ltp as number])); },
    canExit: () => opts.canExit ?? true,
    close: async (key, reason) => { closes.push({ key, reason }); return closeResult; },
    log: () => {},
    refresh: async () => { refreshes++; opts.refresh?.(ledger); },
  };
  const streaks = new Map<string, Streak>();
  return {
    tick: () => runExitTick(deps, streaks),
    advance: (ms: number) => { now += ms; },
    setLtp: (v: number | null) => { ltp = v; },
    setClose: (r: CloseResult) => { closeResult = r; },
    onNextMutate: (f: () => void) => { beforeMutate = f; },
    closes, ledger, priceCalls: () => priceCalls, refreshes: () => refreshes, now: () => now,
  };
}

test('target hit on two consecutive ticks closes once', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } });
  await h.tick();
  assert.equal(h.closes.length, 0);
  h.advance(2000);
  await h.tick();
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].key, KEY);
  assert.match(h.closes[0].reason, /^Target hit/);
  assert.equal(h.ledger.exits![KEY].state, 'sent');
  assert.equal(h.ledger.exits![KEY].firedBy, 'target');
  h.advance(2000);
  await h.tick();
  assert.equal(h.closes.length, 1);
});

test('stop-loss reason names the stop-loss', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } }, { ltp: 79 });
  await h.tick(); h.advance(2000); await h.tick();
  assert.match(h.closes[0].reason, /^Stop-loss hit/);
});

test('a refused exit is retried only after the wait, and again needs two ticks', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } }, { close: { kind: 'refused', error: 'held', http: 409 } });
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.closes.length, 1);
  assert.equal(h.ledger.exits![KEY].state, 'watching');
  assert.equal(h.ledger.exits![KEY].note, 'held');
  h.setClose({ kind: 'placed', orderId: 'C2' });
  h.advance(2000); await h.tick();           // inside the 5 s wait
  assert.equal(h.closes.length, 1);
  h.advance(4000); await h.tick();           // wait over: first breach
  assert.equal(h.closes.length, 1);
  h.advance(2000); await h.tick();           // second breach
  assert.equal(h.closes.length, 2);
  assert.equal(h.ledger.exits![KEY].state, 'sent');
});

test('an UNKNOWN exit is never resent', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } }, { close: { kind: 'unknown', error: 'timeout', partial: false } });
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.ledger.exits![KEY].state, 'unknown');
  for (let i = 0; i < 5; i++) { h.advance(2000); await h.tick(); }
  assert.equal(h.closes.length, 1);
});

test('no watching record means no price read', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: {} });
  await h.tick();
  const w = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching({ state: 'unknown' }) } });
  await w.tick();
  assert.equal(h.priceCalls() + w.priceCalls(), 0);
});

test('a manual close between the two ticks prevents the exit; the record is dropped after the grace', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } });
  await h.tick();
  h.advance(2000);
  h.ledger.orders.push(buy({ id: 'o2', ts: h.now(), side: 'SELL', close: true, orderId: 'X2', avgPrice: 131 }));
  await h.tick();
  assert.equal(h.closes.length, 0);
  assert.ok(h.ledger.exits![KEY]);
  h.advance(RECONCILE_GRACE_MS + 1000);
  await h.tick();
  assert.equal(h.closes.length, 0);
  assert.equal(h.ledger.exits![KEY], undefined);
});

test('a market the page may not exit in never fires', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } }, { canExit: false });
  for (let i = 0; i < 3; i++) { await h.tick(); h.advance(2000); }
  assert.equal(h.closes.length, 0);
});

test('no price means no exit', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } }, { ltp: null });
  for (let i = 0; i < 3; i++) { await h.tick(); h.advance(2000); }
  assert.equal(h.closes.length, 0);
});

test('waiting-fill resolves to prices from the fill', async () => {
  const h = harness({ date: 'd', orders: [buy({ avgPrice: 200 })], exits: { [KEY]: watching({ state: 'waiting-fill', basis: null, targetPx: null, slPx: null }) } }, { ltp: 210 });
  await h.tick();
  const x = h.ledger.exits![KEY];
  assert.equal(x.state, 'watching');
  assert.equal(x.basis, 200);
  assert.equal(x.targetPx, 260);
  assert.equal(x.slPx, 160);
});

test('an edit between the read and the claim is not overwritten by a fire', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: { [KEY]: watching() } });
  await h.tick();
  h.advance(2000);
  // The user widens the target after this tick has read the ledger, before it claims the fire.
  h.onNextMutate(() => { h.ledger.exits![KEY] = { ...h.ledger.exits![KEY], targetPx: 150, target: { value: 50, unit: 'pct' } }; });
  await h.tick();
  assert.equal(h.closes.length, 0);
  assert.equal(h.ledger.exits![KEY].state, 'watching');
  assert.equal(h.ledger.exits![KEY].targetPx, 150);
});

test('with no tab open, the watcher confirms the opening fill itself and arms the levels', async () => {
  // The opening order is still 'pending' in the ledger: only the watcher's own refresh (broker read) confirms it.
  const h = harness({
    date: 'd', orders: [buy({ state: 'pending', filledQty: 0, avgPrice: null, ts: T0 - 1000 })],
    exits: { [KEY]: watching({ state: 'waiting-fill', basis: null, targetPx: null, slPx: null, openedAt: T0 - 1000 }) },
  }, { ltp: 105, refresh: l => Object.assign(l.orders[0], { state: 'filled', filledQty: 1, avgPrice: 100 }) });
  await h.tick();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.ledger.exits![KEY].state, 'watching');
  assert.equal(h.ledger.exits![KEY].targetPx, 130);
});

test('no exit records: no broker refresh', async () => {
  const h = harness({ date: 'd', orders: [buy()], exits: {} });
  await h.tick();
  assert.equal(h.refreshes(), 0);
});
