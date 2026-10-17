import { test } from 'node:test';
import assert from 'node:assert';
import {
  emptyGuardState, stepGuards, bracketVerdict, contractPricesFromBridges, EXIT_VERIFY_MS, type PosView, type ServerBracket,
  type ServerGuardState,
} from './kotakGuardEngine.ts';

const T = '2026-10-17';
const pos = (o: Partial<PosView> = {}): PosView => ({
  symbol: 'NIFTY26OCT24500CE', productRaw: 'MIS', exchange: 'nse_fo', netQty: -75, buyAvg: 0, sellAvg: 100, ltp: 100,
  realized: 0, unrealized: 0, ...o,
});
const br = (o: Partial<ServerBracket> = {}): ServerBracket => ({
  id: 'b1', symbol: 'NIFTY26OCT24500CE', product: 'INTRADAY', dir: -1, target: 80, sl: 120, trail: false, at: 1000, ttlMs: 180_000,
  qtyBefore: 0, state: 'pending', best: 0, entry: 0, ...o,
});
const st = (o: Partial<ServerGuardState> = {}): ServerGuardState => ({ ...emptyGuardState(T), ...o });

test('a pending bracket arms once the entry shows in the book, with the entry average', () => {
  const r = stepGuards(st({ brackets: [br()] }), [pos({ sellAvg: 101.5 })], 2000, T);
  assert.strictEqual(r.state.brackets[0].state, 'armed');
  assert.strictEqual(r.state.brackets[0].entry, 101.5);
  assert.strictEqual(r.exits.length, 0);
  assert.strictEqual(r.state.events.at(-1)?.kind, 'armed');
});

test('a pending bracket does not arm on a position that did not grow, and expires after its ttl', () => {
  const already = st({ brackets: [br({ qtyBefore: -75 })] });
  assert.strictEqual(stepGuards(already, [pos()], 2000, T).state.brackets[0].state, 'pending');
  const r = stepGuards(st({ brackets: [br({ ttlMs: 1000 })] }), [], 5000, T);
  assert.strictEqual(r.state.brackets.length, 0);
  assert.strictEqual(r.state.events.at(-1)?.kind, 'expired');
});

test('an armed short bracket exits on target and on SL, once, and is removed before the exit is sent', () => {
  const armed = st({ brackets: [br({ state: 'armed', entry: 100 })] });
  const tgt = stepGuards(armed, [pos({ ltp: 79.9 })], 2000, T);
  assert.deepStrictEqual(tgt.exits.map(e => [e.symbol, e.side, e.qty, e.productRaw, e.exchange]), [['NIFTY26OCT24500CE', 'B', 75, 'MIS', 'nse_fo']]);
  assert.strictEqual(tgt.state.brackets.length, 0);
  assert.strictEqual(tgt.state.watch.length, 1);
  const sl = stepGuards(armed, [pos({ ltp: 120 })], 2000, T);
  assert.strictEqual(sl.exits.length, 1);
  assert.strictEqual(stepGuards(armed, [pos({ ltp: 100 })], 2000, T).exits.length, 0);
  // Next tick: nothing left to fire again.
  assert.strictEqual(stepGuards(tgt.state, [pos({ ltp: 70 })], 2100, T).exits.length, 0);
});

test('a long bracket mirrors it, and an unknown price never fires', () => {
  const b = br({ dir: 1, target: 120, sl: 80, state: 'armed', entry: 100 });
  const long = (ltp: number) => pos({ netQty: 75, buyAvg: 100, sellAvg: 0, ltp });
  assert.strictEqual(stepGuards(st({ brackets: [b] }), [long(121)], 2000, T).exits[0].side, 'S');
  assert.strictEqual(stepGuards(st({ brackets: [b] }), [long(79)], 2000, T).exits.length, 1);
  assert.strictEqual(stepGuards(st({ brackets: [b] }), [long(0)], 2000, T).exits.length, 0);
});

test('the trail ratchets the stop 1:1 behind the best price and never loosens it', () => {
  let b = br({ state: 'armed', entry: 100, trail: true, target: 10, sl: 110 });      // short, risk 10, far target
  let v = bracketVerdict(b, 90);   assert.strictEqual(v.hit, null);  b = { ...b, best: v.best };
  assert.strictEqual(b.best, 90);                                                    // trail SL now 100
  v = bracketVerdict(b, 95);       assert.strictEqual(v.hit, null);  b = { ...b, best: v.best };
  assert.strictEqual(b.best, 90);                                                    // best does not loosen
  v = bracketVerdict(b, 100);      assert.strictEqual(v.hit, 'Trail SL hit');
  assert.strictEqual(bracketVerdict(br({ state: 'armed', entry: 100, trail: true, target: 10, sl: 110 }), 110).hit, 'SL hit');
});

test('a bracket whose position closed by hand is dropped', () => {
  const r = stepGuards(st({ brackets: [br({ state: 'armed' })] }), [pos({ netQty: 0 })], 2000, T);
  assert.strictEqual(r.state.brackets.length, 0);
  assert.strictEqual(r.state.events.at(-1)?.kind, 'dropped');
});

test('the P&L Guard exits every in-scope leg shorts-first, disarms, and removes their brackets', () => {
  const book = [
    pos({ symbol: 'LONG1', netQty: 75, buyAvg: 50, sellAvg: 0, ltp: 20, unrealized: -2250 }),
    pos({ symbol: 'SHORT1', netQty: -75, ltp: 130, unrealized: -2250 }),
    pos({ symbol: 'NRMLONE', productRaw: 'NRML', netQty: -75, ltp: 130, unrealized: -9999 }),
  ];
  const s = st({ pnl: { profit: 0, loss: 3000, products: ['INTRADAY'], date: T }, brackets: [br({ symbol: 'SHORT1', state: 'armed' })] });
  const r = stepGuards(s, book, 2000, T);
  assert.deepStrictEqual(r.exits.map(e => [e.symbol, e.phase]), [['SHORT1', 'cover-short'], ['LONG1', 'sell-long']]);
  assert.strictEqual(r.state.pnl, null);
  assert.strictEqual(r.state.brackets.length, 0);
});

test('the P&L Guard waits on a profit target while a leg is unpriced, but a loss limit still fires', () => {
  const book = [pos({ symbol: 'A', ltp: 0, unrealized: 0, realized: 6000 }), pos({ symbol: 'B', ltp: 90, unrealized: 750 })];
  const profit = st({ pnl: { profit: 5000, loss: 0, products: ['INTRADAY'], date: T } });
  assert.strictEqual(stepGuards(profit, book, 2000, T).exits.length, 0);
  const loss = st({ pnl: { profit: 0, loss: 1000, products: ['INTRADAY'], date: T } });
  assert.strictEqual(stepGuards(loss, [pos({ symbol: 'A', ltp: 0, realized: -1500 })], 2000, T).exits.length, 1);
});

test('a leg a bracket exits this tick is not exited twice by the P&L Guard', () => {
  const s = st({
    pnl: { profit: 0, loss: 100, products: ['INTRADAY'], date: T },
    brackets: [br({ state: 'armed', entry: 100 })],
  });
  const r = stepGuards(s, [pos({ ltp: 125, unrealized: -1875 })], 2000, T);
  assert.strictEqual(r.exits.length, 1);
});

test('an exit that has not taken the position down after the verify window is reported, not retried', () => {
  const s = st({ watch: [{ symbol: 'NIFTY26OCT24500CE', product: 'INTRADAY', dir: -1, at: 1000 }] });
  assert.strictEqual(stepGuards(s, [pos()], 1000 + EXIT_VERIFY_MS - 1, T).state.watch.length, 1);
  const late = stepGuards(s, [pos()], 1000 + EXIT_VERIFY_MS, T);
  assert.strictEqual(late.exits.length, 0);
  assert.strictEqual(late.state.events.at(-1)?.kind, 'incomplete');
  assert.strictEqual(late.state.watch.length, 0);
  assert.strictEqual(stepGuards(s, [pos({ netQty: 0 })], 2000, T).state.watch.length, 0);   // it did close
});

test('a new trading day discards the previous day\'s guards', () => {
  const s = st({ date: '2026-10-16', pnl: { profit: 1, loss: 1, products: ['INTRADAY'], date: '2026-10-16' }, brackets: [br()] });
  const r = stepGuards(s, [pos()], 2000, T);
  assert.strictEqual(r.state.pnl, null);
  assert.strictEqual(r.state.brackets.length, 0);
  assert.strictEqual(r.state.date, T);
});

test('stepGuards never mutates its input', () => {
  const s = st({ brackets: [br({ state: 'armed', entry: 100 })] });
  const snapshot = JSON.stringify(s);
  stepGuards(s, [pos({ ltp: 70 })], 2000, T);
  assert.strictEqual(JSON.stringify(s), snapshot);
});

test('contract prices come from every fresh bridge file: a CRUDEOIL leg is priced from the NIFTY bridge', () => {
  const now = Date.parse('2026-10-19T10:00:05Z');
  const fresh = '2026-10-19T10:00:03Z';
  const prices = contractPricesFromBridges([
    // The NIFTY bridge, which the Advanced Scalper asked to price every open Kotak leg.
    { updated_at: fresh, contracts: { CRUDEOIL19NOV26FUT: { ltp: 9388 }, CRUDEOIL17NOV269000PE: { ltp: 355.7 }, NIFTY26OCT22500PE: { ltp: 37.05 } } },
    // A stale CRUDEOIL bridge file: ignored, never an old price.
    { updated_at: '2026-10-19T09:00:00Z', contracts: { CRUDEOIL19NOV26FUT: { ltp: 9000 } } },
  ], now, 6000);
  assert.strictEqual(prices.get('CRUDEOIL19NOV26FUT'), 9388);
  assert.strictEqual(prices.get('CRUDEOIL17NOV269000PE'), 355.7);
  assert.strictEqual(prices.get('NIFTY26OCT22500PE'), 37.05);
});

test('contract prices: nothing from a stale or undated file, and a zero or missing ltp is not a price', () => {
  const now = Date.parse('2026-10-19T10:00:05Z');
  assert.strictEqual(contractPricesFromBridges([{ updated_at: '2026-10-19T09:59:00Z', contracts: { A: { ltp: 1 } } }], now, 6000).size, 0);
  assert.strictEqual(contractPricesFromBridges([{ contracts: { A: { ltp: 1 } } }], now, 6000).size, 0);
  const p = contractPricesFromBridges([{ updated_at: '2026-10-19T10:00:04Z', contracts: { A: { ltp: 0 }, B: {}, C: { ltp: 2 } } }], now, 6000);
  assert.deepStrictEqual([...p.entries()], [['C', 2]]);
});
