import { placePnfMarket } from '@/lib/pnfAutoOrders';
import { brokerLegs, resolvePnfLegs } from '@/lib/pnfOrderServer';
import { resolveOption } from '@/lib/pnfContracts';
import { spotInstrument, wsPrice, wsSync, wsWant, type WsPrice } from '@/lib/freshMoneyWs';
import { readBrokerOrder } from '@/lib/brokerOrderStatus';
import type { Target } from '@/lib/pnfTarget';
import type { GbLedger, GbRow } from '@/lib/gearboxLedger';
import {
  closeRowNow as closeCore, gbClientOp as clientOpCore, gbState as stateCore, gbTrade as tradeCore,
  type GbDeps, type Quote, type TradeReq,
} from '@/lib/gearboxCore';

// Gearbox Drive's server: binds the order path in lib/gearboxCore.ts to the real broker, master list and WebSocket prices.
// REAL MONEY. The core holds every rule (and is what lib/gearboxServer.test.ts drives with stubbed deps); this file only
// supplies the IO: Fresh Money's server WebSocket prices, the P&F order layer (tag 'gbx', scope 'pnf') and Dhan's order status.

export { parseTrade, pickTarget, futureTarget, legExpiry, gbSerial, saveGbLedger, FUT_FRESH_MS } from '@/lib/gearboxCore';
export type { GbDeps, TradeReq, Quote };

const quoteOf = (p: WsPrice | null, now: number): Quote | null => (p ? { ltp: p.ltp, ageMs: now - (p.changedMs ?? p.sinceMs) } : null);

export const realDeps: GbDeps = {
  now: () => Date.now(),
  price(u, optExpiry) {
    const fut = spotInstrument(u, optExpiry, true);
    if (!fut) return null;
    const key = wsWant(fut.segment, fut.securityId);
    wsSync();
    return quoteOf(wsPrice(key), Date.now());
  },
  optionPrice(t: Target) {
    if (t.kind !== 'options' || !t.expiry || !t.strike || (t.side !== 'CE' && t.side !== 'PE')) return null;
    const c = resolveOption(t.symbol, t.expiry, t.strike, t.side);
    if (!c || c.segment !== 'MCX_COMM') return null;
    const key = wsWant('MCX_COMM', c.securityId);
    wsSync();
    return quoteOf(wsPrice(key), Date.now());
  },
  place: (order, scope, tag) => placePnfMarket(order, scope, tag),
  readOrder: id => readBrokerOrder(id, 'dhan'),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async lotUnits(t) {
    const legs = resolvePnfLegs(t);
    if (typeof legs === 'string') return legs;
    const on = await brokerLegs('dhan', t, legs);
    return typeof on === 'string' ? on : on[0].lotUnits;
  },
};

export const gbState = (deps: GbDeps = realDeps) => stateCore(deps);
export const gbClientOp = (op: unknown, deps: GbDeps = realDeps) => clientOpCore(op, deps);
export const gbTrade = (req: TradeReq, deps: GbDeps = realDeps) => tradeCore(req, deps);
/** Square-off / exit of one open row. Call inside gbSerial; save the returned ledger with saveGbLedger. */
export const closeRowNow = (l: GbLedger, row: GbRow, reason: string, deps: GbDeps = realDeps) => closeCore(l, row, reason, deps);
