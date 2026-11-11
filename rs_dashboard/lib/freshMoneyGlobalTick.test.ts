import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGlobalTick, type GlobalTickDeps } from './freshMoneyGlobalTick.ts';
import type { CloseResult, Streak } from './freshMoneyExits.ts';
import type { FmGlobalExit } from './freshMoneyGlobalExit.ts';
import type { FmLedger, FmOrder } from './freshMoneyTrades.ts';

const T0 = 1_000_000;
const ord = (id: string, sec: string, side: 'BUY' | 'SELL', p: Partial<FmOrder> = {}): FmOrder => ({
  id, ts: T0 - 60_000, underlying: 'CRUDEOIL', expiry: '2026-11-17', strike: 8100, opt: 'CE', securityId: sec,
  segment: 'MCX_COMM', lot: 1, mult: 100, side, qty: 1, close: false, correlationId: `fm${id}`, orderId: `X${id}`,
  state: 'filled', filledQty: 1, avgPrice: 100, ...p,
});
const G = (p: Partial<FmGlobalExit> = {}): FmGlobalExit => ({ target: 2000, sl: 1000, armedAt: 1, state: 'watching', ...p });

function harness(ledger: FmLedger, ltps: Record<string, number>, results: Record<string, CloseResult> = {}) {
  let now = T0;
  const closes: string[] = [];
  const deps: GlobalTickDeps = {
    now: () => now,
    readLedger: () => structuredClone(ledger),
    mutate: async fn => fn(ledger),
    prices: async items => Object.fromEntries(items.filter(i => i.id in ltps).map(i => [i.id, ltps[i.id]])),
    canExit: () => true,
    close: async key => { closes.push(key); return results[key] ?? { kind: 'placed', orderId: `C-${key}` }; },
    log: () => {},
    refresh: async () => {},
  };
  const streak: { cur: Streak | null } = { cur: null };
  return { tick: () => runGlobalTick(deps, streak), advance: (ms: number) => { now += ms; }, closes, ledger };
}

// short 111 (sold @100), long hedge 222 (bought @100); mult 100 → P&L = (ltp-100)*100 per unit sign
const book = () => [ord('1', '111', 'SELL'), ord('2', '222', 'BUY')];

test('target: closes every position, shorts first, once, after two ticks', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 70, '222': 100 }); // short +3000
  await h.tick();
  assert.equal(h.closes.length, 0);
  h.advance(2000);
  await h.tick();
  assert.deepEqual(h.closes, ['dhan|111', 'dhan|222']);
  assert.equal(h.ledger.global!.state, 'sent');
  assert.equal(h.ledger.global!.firedBy, 'target');
  h.advance(2000);
  await h.tick();
  assert.equal(h.closes.length, 2);
});

test('stop-loss on a loss of the SL amount', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 115, '222': 100 }); // short -1500
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.ledger.global!.firedBy, 'sl');
  assert.equal(h.closes.length, 2);
});

test('inside the band nothing happens', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 100, '222': 100 });
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.closes.length, 0);
});

test('a missing price makes the total unknown: no exit', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 70 }); // 222 unpriced
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.closes.length, 0);
});

test('a refused short cover keeps the hedge and re-arms', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 115, '222': 100 },
    { 'dhan|111': { kind: 'refused', error: 'in flight', http: 409 } });
  await h.tick(); h.advance(2000); await h.tick();
  assert.deepEqual(h.closes, ['dhan|111']);
  assert.equal(h.ledger.global!.state, 'watching');
  assert.ok(h.ledger.global!.retryAt! > 0);
});

test('an UNKNOWN close is never resent', async () => {
  const h = harness({ date: 'd', orders: book(), global: G() }, { '111': 115, '222': 100 },
    { 'dhan|111': { kind: 'unknown', error: 'timeout', partial: false } });
  await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.ledger.global!.state, 'unknown');
  h.advance(10_000); await h.tick(); h.advance(2000); await h.tick();
  assert.equal(h.closes.length, 1);
});

test('no global record or no open position: nothing is sent', async () => {
  const a = harness({ date: 'd', orders: book() }, { '111': 70, '222': 100 });
  await a.tick(); a.advance(2000); await a.tick();
  assert.equal(a.closes.length, 0);
  const flat = [ord('1', '111', 'SELL', { avgPrice: 100 }), ord('3', '111', 'BUY', { close: true, avgPrice: 20 })]; // booked +8000
  const b = harness({ date: 'd', orders: flat, global: G() }, {});
  await b.tick(); b.advance(2000); await b.tick();
  assert.equal(b.closes.length, 0);
});
