import { test } from 'node:test';
import assert from 'node:assert';
import { emptyGuardState, stepGuards, type PosView, type ServerBracket, type ServerGuardState } from './kotakGuardEngine.ts';

// The engine is shared with Kotak; these pin the Zerodha spelling (Kite product MIS/NRML, exchange NFO, units quantity).
const T = '2026-10-19';
const pos = (o: Partial<PosView> = {}): PosView => ({
  symbol: 'NIFTY26O2724500CE', productRaw: 'MIS', exchange: 'NFO', netQty: -65, buyAvg: 0, sellAvg: 100, ltp: 100,
  realized: 0, unrealized: 0, ...o,
});
const br = (o: Partial<ServerBracket> = {}): ServerBracket => ({
  id: 'zb1', symbol: 'NIFTY26O2724500CE', product: 'INTRADAY', dir: -1, target: 80, sl: 120, trail: false, at: 1000, ttlMs: 180_000,
  qtyBefore: 0, state: 'pending', best: 0, entry: 0, ...o,
});
const st = (o: Partial<ServerGuardState> = {}): ServerGuardState => ({ ...emptyGuardState(T), ...o });

test('a Kite MIS short arms a pending INTRADAY bracket and exits with a BUY in the same product and exchange', () => {
  const armed = stepGuards(st({ brackets: [br()] }), [pos()], 2000, T);
  assert.strictEqual(armed.state.brackets[0].state, 'armed');
  const hit = stepGuards(armed.state, [pos({ ltp: 79 })], 3000, T);
  assert.deepStrictEqual(hit.exits.map(e => [e.side, e.qty, e.productRaw, e.exchange]), [['B', 65, 'MIS', 'NFO']]);
});

test('NRML maps to the MARGIN product and the P&L guard covers shorts before selling longs', () => {
  const guard = { profit: 0, loss: 1000, products: ['MARGIN'], date: T };
  const book = [
    pos({ symbol: 'LONGHEDGE', productRaw: 'NRML', netQty: 65, buyAvg: 10, sellAvg: 0, ltp: 5, realized: -2000 }),
    pos({ symbol: 'SHORTLEG', productRaw: 'NRML', netQty: -65, ltp: 100 }),
    pos({ symbol: 'INTRADAYLEG', productRaw: 'MIS', netQty: -65, ltp: 100 }),   // out of scope: not exited
  ];
  const r = stepGuards(st({ pnl: guard }), book, 2000, T);
  assert.deepStrictEqual(r.exits.map(e => [e.symbol, e.side]), [['SHORTLEG', 'B'], ['LONGHEDGE', 'S']]);
  assert.strictEqual(r.state.pnl, null);
});
