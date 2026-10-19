import fs from 'fs';
import path from 'path';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { placeZerodhaOrder } from '@/lib/zerodhaPlaceOrder';
import { shapeZerodhaPosition } from '@/lib/zerodhaShape';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { createGuardServer, GuardExitRejected } from '@/lib/guardServerCore';
import type { KotakSymbolInfo } from '@/lib/kotakLtpJoin';
import type { ExitOrder, PosView } from '@/lib/kotakGuardEngine';

// The server-resident Zerodha guards (P&L Guard + brackets). Kite has no broker-side P&L exit or bracket either (a Zerodha
// stop is software), so the dashboard SERVER watches them exactly as it does for Kotak: the store, tick loop, pricing and
// cover-before-sell ordering are lib/guardServerCore.ts; this file is only Zerodha's adapter. State: debug/zerodha_server_guards.json.
//
// Prices come from Dhan (the live options bridge, else Dhan's option chain) - never from Kite's quote data. Kite is read only
// for the account's own positions and used only to send the exit.

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Underlyings zerodha_instruments_cache.py can build (it would silently produce an empty file for any other). */
const SUPPORTED = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX']);

/** tradingsymbol -> contract for one underlying, from the Zerodha instrument cache (same file and dedupe key as the symbol-lookup route). */
export async function zerodhaSymbolMap(underlying: string): Promise<Record<string, KotakSymbolInfo>> {
  if (!SUPPORTED.has(underlying)) return {};
  const file = path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_instruments.json`);
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > CACHE_MAX_AGE_MS) {
    await dedupe(`zerodha-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying], 60_000));
  }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as { tradingsymbol: string; strike: number; expiry: string; instrument_type: 'CE' | 'PE' }[];
  const map: Record<string, KotakSymbolInfo> = {};
  for (const r of rows) map[r.tradingsymbol] = { expiry: r.expiry, strike: r.strike, side: r.instrument_type };
  return map;
}

async function loadBook(): Promise<PosView[]> {
  const positions = await kiteGet('/portfolio/positions') as { net?: Record<string, unknown>[] };
  return (positions.net ?? []).map(shapeZerodhaPosition).map(p => ({
    symbol: p.tradingSymbol, productRaw: p.productType, exchange: p.exchange || 'NFO', netQty: p.netQty,
    buyAvg: p.buyAvg, sellAvg: p.sellAvg,
    ltp: 0,   // priced from Dhan by the core; Kite's last_price is deliberately not used
    realized: p.realizedProfit,   // = Kite's pnl minus the open leg's mark-to-market, so it does not depend on last_price
    unrealized: 0,
  }));
}

/** Throws on a refusal or an unknown outcome; the caller notes which. A timed-out exit that Kite did book counts as sent. */
async function sendExit(e: ExitOrder): Promise<void> {
  const r = await placeZerodhaOrder({
    tradingsymbol: e.symbol, exchange: e.exchange, transaction_type: e.side === 'B' ? 'BUY' : 'SELL',
    order_type: 'MARKET', quantity: e.qty, product: e.productRaw || 'MIS', validity: 'DAY',
    market_protection: -1,   // API market orders on options need it (-1 = automatic band)
  });
  if (r.status === 'rejected') throw new GuardExitRejected(r.error);
  if (r.status === 'unknown') throw new Error(r.error);
}

const server = createGuardServer({ key: 'zerodha', isSessionValid: isZerodhaTokenValid, symbolMapFor: zerodhaSymbolMap, loadBook, sendExit });

export const readZerodhaGuardState = server.readGuardState;
export const updateZerodhaGuardState = server.updateGuardState;
export const startZerodhaGuardLoop = server.startLoop;
