import { kotakGet, kotakPost, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakOrderStatus } from '@/lib/kotakShape';
import { kotakSymbolMap } from '@/lib/kotakLtpJoin';
import { createGuardServer, GuardExitRejected, istDay } from '@/lib/guardServerCore';
import type { ExitOrder, PosView } from '@/lib/kotakGuardEngine';

// The server-resident Kotak guards (P&L Guard + brackets). Everything broker-neutral - the file store
// (debug/kotak_server_guards.json), the tick loop, pricing and the cover-before-sell ordering - is in
// lib/guardServerCore.ts; this file is only Kotak's adapter.

export { istDay };

async function loadBook(): Promise<PosView[]> {
  return kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition).map(p => ({
    symbol: p.tradingSymbol, productRaw: p.productType, exchange: p.exchange || 'nse_fo', netQty: p.netQty,
    buyAvg: p.buyAvg, sellAvg: p.sellAvg, ltp: 0, realized: p.realizedProfit, unrealized: 0,
    carried: (p.cfBuyQty ?? 0) > 0 || (p.cfSellQty ?? 0) > 0,
  }));
}

/** Throws on a refusal or an unknown outcome; the caller notes which. A timed-out exit that Kotak did book counts as sent. */
async function sendExit(e: ExitOrder): Promise<void> {
  const r = await placeKotakOrder({
    es: e.exchange, pc: e.productRaw || 'MIS', pr: '0', pt: 'MKT', qt: String(e.qty), rt: 'DAY', ts: e.symbol,
    tt: e.side, am: 'NO', dq: '0', mp: '0', pf: 'N', tp: '0', os: 'NEOTRADEAPI',
  }, { bypassLock: true });   // the guard's own flatten must never be blocked by the lock it enforces
  if (r.status === 'rejected') throw new GuardExitRejected(r.error);
  if (r.status === 'unknown') throw new Error(r.error);
}

/** A resting exit the user (or another tool) already placed would fill on top of the market flatten and flip the leg: cancel
 *  the orders on this leg that trade in the exit's direction first. Any failure holds the flatten back (it is retried). */
async function prepareLockFlatten(e: ExitOrder): Promise<void> {
  let rows: Record<string, unknown>[];
  try { rows = kotakRows(await kotakGet(KOTAK_PATHS.orderBook)); }
  catch (err) { throw new GuardExitRejected(`could not read the order book to clear resting exits (${String((err as Error).message ?? err)})`); }
  const want = e.side === 'B' ? 'BUY' : 'SELL';
  const resting = rows.filter(r => {
    const o = shapeKotakOrder(r);
    if (o.tradingSymbol !== e.symbol || o.transactionType !== want) return false;
    const st = shapeKotakOrderStatus(r).orderStatus;
    return st !== 'TRADED' && st !== 'REJECTED' && st !== 'CANCELLED';
  });
  for (const r of resting) {
    try { await kotakPost(KOTAK_PATHS.cancelOrder, { on: String(shapeKotakOrder(r).orderId), am: 'NO' }); }
    catch (err) { throw new GuardExitRejected(`could not cancel a resting ${e.symbol} order (${String((err as Error).message ?? err)})`); }
  }
  if (resting.length) await new Promise(res => setTimeout(res, 800));   // let the cancel reach the exchange before the market order
}

const server = createGuardServer({ key: 'kotak', isSessionValid: isKotakTokenValid, symbolMapFor: kotakSymbolMap, loadBook, sendExit, autoArm: true, dayLock: true, prepareLockFlatten });

export const readGuardDefaults = server.readGuardDefaults;
export const writeGuardDefaults = server.writeGuardDefaults;
export const readGuardState = server.readGuardState;
export const updateGuardState = server.updateGuardState;
export const startKotakGuardLoop = server.startLoop;
