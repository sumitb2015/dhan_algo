import { kotakGet, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { shapeKotakPosition } from '@/lib/kotakShape';
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
  }));
}

/** Throws on a refusal or an unknown outcome; the caller notes which. A timed-out exit that Kotak did book counts as sent. */
async function sendExit(e: ExitOrder): Promise<void> {
  const r = await placeKotakOrder({
    es: e.exchange, pc: e.productRaw || 'MIS', pr: '0', pt: 'MKT', qt: String(e.qty), rt: 'DAY', ts: e.symbol,
    tt: e.side, am: 'NO', dq: '0', mp: '0', pf: 'N', tp: '0', os: 'NEOTRADEAPI',
  });
  if (r.status === 'rejected') throw new GuardExitRejected(r.error);
  if (r.status === 'unknown') throw new Error(r.error);
}

const server = createGuardServer({ key: 'kotak', isSessionValid: isKotakTokenValid, symbolMapFor: kotakSymbolMap, loadBook, sendExit });

export const readGuardState = server.readGuardState;
export const updateGuardState = server.updateGuardState;
export const startKotakGuardLoop = server.startLoop;
