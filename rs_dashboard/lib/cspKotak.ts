import { kotakGet, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakOrderStatus, shapeKotakPosition } from '@/lib/kotakShape';
import { kotakOptionContract } from '@/lib/kotakContracts';
import { kotakSymbolMap, underlyingPrefix } from '@/lib/kotakLtpJoin';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import type { CspBrokerRow } from '@/lib/cspReconcile';

// The Kotak twin of scripts/tools/csp_watchlist.py's order commands (place / exit / cancel / reconcile), returning the
// SAME JSON shapes so the CSP routes branch on the row's broker and nothing else. Same rules as the Python side:
//  - place: the contract comes from Kotak's own master (by symbol/expiry/strike), never from the browser;
//  - an order's outcome is its own (status, traded average), waited for up to 25 s when asked;
//  - exit sizes off the broker's live short on that contract: flat or long refuses, a smaller short clamps, and a FAILED
//    positions read falls back to the requested quantity (refusing to close a real position is the worse failure).
// On Kotak a row's `securityId` holds the Kotak trading symbol (Kotak has no numeric id) and `exchangeSegment` 'nse_fo'.

const FILL_WAIT_MS = 25_000;

export interface CspOrderOutcome {
  success: boolean; orderId?: string; status?: string; tradedPrice?: number | null;
  securityId?: string; exchangeSegment?: string; lotSize?: number;
  quantity?: number; quantityVerified?: boolean; netQty?: number; error?: string;
}

async function orderOutcome(orderId: string): Promise<{ status: string; filledQty: number; avg: number } | null> {
  const o = kotakRows(await kotakGet(KOTAK_PATHS.orderBook)).find((r) => String(r.nOrdNo ?? '') === orderId);
  if (!o) return null;
  const s = shapeKotakOrderStatus(o, orderId);
  return { status: s.orderStatus, filledQty: s.filledQty, avg: s.averageTradedPrice };
}

/** Same contract as the Python _finalize_order: PENDING until proven, success false on a dead order. */
async function finalize(orderId: string, wait: boolean): Promise<CspOrderOutcome> {
  const out: CspOrderOutcome = { success: true, orderId, status: 'PENDING', tradedPrice: null };
  if (!wait) return out;
  const deadline = Date.now() + FILL_WAIT_MS;
  for (;;) {
    try {
      const st = await orderOutcome(orderId);
      if (st) {
        out.status = st.status;
        if (st.avg > 0) out.tradedPrice = st.avg;
        if (st.status === 'TRADED' && st.avg > 0) break;
        if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(st.status)) {
          return { ...out, success: false, error: `Order ${orderId} ended ${st.status}` };
        }
      }
    } catch { /* order book unreadable this time */ }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

const kotakProduct = (p: string | undefined) => (String(p ?? 'MARGIN').toUpperCase() === 'INTRADAY' ? 'MIS' : 'NRML');

export async function kotakPlacePut(a: {
  symbol: string; expiry: string; strike: number; quantity: number; productType?: string;
  orderType?: string; price?: number; triggerPrice?: number; afterMarketOrder?: boolean; waitFill?: boolean;
}): Promise<CspOrderOutcome> {
  if (!isKotakTokenValid()) return { success: false, error: 'Kotak session is not valid - log in first' };
  const c = await kotakOptionContract(a.symbol, a.expiry, a.strike, 'PE');
  if (!c) return { success: false, error: `Option not found on Kotak: ${a.symbol} ${a.expiry} ${a.strike} PE` };
  if (!(a.quantity > 0) || a.quantity % c.lotSize !== 0) {
    return { success: false, error: `Quantity ${a.quantity} is not a whole number of Kotak ${c.lotSize}-unit lots` };
  }
  const ot = String(a.orderType ?? 'MARKET').toUpperCase();
  const isStopLimit = ot === 'STOP_LOSS';
  const isStopMarket = ot === 'STOP_LOSS_MARKET';
  const isLimit = ot === 'LIMIT' || isStopLimit;
  const tick = c.tick && c.tick > 0 ? c.tick : 0.05;
  const snap = (v: number) => (Math.round(v / tick) * tick).toFixed(2);
  if (isLimit && !(Number(a.price) > 0)) return { success: false, error: `${ot} needs a price` };
  if ((isStopLimit || isStopMarket) && !(Number(a.triggerPrice) > 0)) return { success: false, error: `${ot} needs a trigger price` };
  const r = await placeKotakOrder({
    es: c.segment, pc: kotakProduct(a.productType), pr: isLimit ? snap(Number(a.price)) : '0',
    pt: isStopLimit ? 'SL' : isStopMarket ? 'SL-M' : isLimit ? 'L' : 'MKT', qt: String(a.quantity), rt: 'DAY', ts: c.tradingsymbol,
    tt: 'S', am: a.afterMarketOrder ? 'YES' : 'NO', dq: '0', mp: '0', pf: 'N',
    tp: isStopLimit || isStopMarket ? snap(Number(a.triggerPrice)) : '0', os: 'NEOTRADEAPI',
  });
  if (r.status === 'rejected') return { success: false, error: `Kotak rejected the put: ${r.error}` };
  if (r.status === 'unknown') return { success: false, error: r.error };
  const out = await finalize(r.orderId, !!a.waitFill);
  return { ...out, securityId: c.tradingsymbol, exchangeSegment: c.segment, lotSize: c.lotSize };
}

/** Live net quantity per Kotak trading symbol for options (all products summed, as the Python side reads Dhan's). */
async function kotakOptionNets(): Promise<Map<string, { netQty: number; avgPrice: number; productType: string }>> {
  const rows = kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition);
  const out = new Map<string, { netQty: number; avgPrice: number; productType: string }>();
  for (const p of rows) {
    if (!/_fo$/i.test(p.exchange)) continue;
    const prev = out.get(p.tradingSymbol);
    // Pooled figures, exactly like the Python side's Dhan read: reconcile never writes them into a row (cspReconcile).
    const ownAvg = p.netQty < 0 ? p.sellAvg : p.netQty > 0 ? p.buyAvg : 0;
    out.set(p.tradingSymbol, {
      netQty: (prev?.netQty ?? 0) + p.netQty,
      avgPrice: ownAvg || prev?.avgPrice || 0,
      productType: prev?.productType || p.productType,
    });
  }
  return out;
}

export async function kotakExitPut(a: { tradingSymbol: string; exchangeSegment?: string; quantity: number; productType?: string; waitFill?: boolean }): Promise<CspOrderOutcome> {
  if (!isKotakTokenValid()) return { success: false, error: 'Kotak session is not valid - log in first' };
  let quantity = Math.floor(Math.abs(a.quantity));
  let verified = false;
  try {
    const net = (await kotakOptionNets()).get(a.tradingSymbol)?.netQty ?? 0;
    if (net >= 0) {
      return { success: false, netQty: net, error: `Broker shows no open short for ${a.tradingSymbol} (net qty ${net}) — nothing to exit. The tracked row is stale; reconcile before retrying.` };
    }
    verified = true;
    if (Math.abs(net) < quantity) quantity = Math.abs(net);
  } catch { /* positions unreadable: requested quantity, flagged unverified */ }
  const r = await placeKotakOrder({
    es: a.exchangeSegment || 'nse_fo', pc: kotakProduct(a.productType), pr: '0', pt: 'MKT', qt: String(quantity), rt: 'DAY',
    ts: a.tradingSymbol, tt: 'B', am: 'NO', dq: '0', mp: '0', pf: 'N', tp: '0', os: 'NEOTRADEAPI',
  });
  if (r.status === 'rejected') return { success: false, error: `Kotak rejected the exit: ${r.error}` };
  if (r.status === 'unknown') return { success: false, error: r.error };
  return { ...(await finalize(r.orderId, !!a.waitFill)), quantity, quantityVerified: verified };
}

/** Same shape as csp_watchlist.py reconcile: broker truth per tracked row, plus untracked Kotak PE shorts. */
export async function kotakReconcile(tracked: { id: string; securityId?: string; orderId?: string; needOrder?: boolean }[]): Promise<{
  rows: CspBrokerRow[];
  untracked: { securityId: string; tradingSymbol: string; symbol: string; netQty: number; avgPrice: number; strike: number; expiry: string; productType: string; exchangeSegment: string; lotSize: number }[];
}> {
  const nets = await kotakOptionNets();   // throws when unreadable: the route reports it, nothing is changed
  const book = tracked.some((t) => t.needOrder && t.orderId) ? kotakRows(await kotakGet(KOTAK_PATHS.orderBook)) : [];
  const claimed = new Set<string>();
  const rows: CspBrokerRow[] = tracked.map((t) => {
    const pos = t.securityId ? nets.get(t.securityId) : undefined;
    if (pos && t.securityId) claimed.add(t.securityId);
    const row: CspBrokerRow = { id: t.id, found: !!pos && pos.netQty !== 0, netQty: pos?.netQty ?? 0, avgPrice: pos?.avgPrice ?? 0, productType: pos?.productType ?? '' };
    if (t.needOrder && t.orderId) {
      const o = book.find((r) => String(r.nOrdNo ?? '') === t.orderId);
      const s = o ? shapeKotakOrderStatus(o, t.orderId) : null;
      row.order = s ? { status: s.orderStatus, filledQty: s.filledQty, avgPrice: s.averageTradedPrice } : null;
    }
    return row;
  });
  const untracked = [];
  for (const [sym, pos] of nets) {
    if (claimed.has(sym) || pos.netQty >= 0) continue;
    // Leading letters of the symbol. A stock whose name has '&' or '-' (M&M, BAJAJ-AUTO) does not resolve and is not
    // listed for adoption; it is still visible in the broker's own position book.
    const u = underlyingPrefix(sym);
    let info;
    try { info = (await kotakSymbolMap(u))[sym]; } catch { info = undefined; }
    if (!info || info.side !== 'PE') continue;   // only short PUTS are adoptable as cash-secured puts
    const c = await kotakOptionContract(u, info.expiry, info.strike, 'PE').catch(() => null);
    untracked.push({
      securityId: sym, tradingSymbol: sym, symbol: u, netQty: pos.netQty, avgPrice: pos.avgPrice, strike: info.strike,
      expiry: info.expiry, productType: pos.productType, exchangeSegment: 'nse_fo', lotSize: c?.lotSize ?? 0,
    });
  }
  return { rows, untracked };
}

/**
 * Kotak's working PUT orders and open PUT positions per watched underlying, in the /cash-secured-puts page's row shape
 * (csp_watchlist.py `list`). Strike/expiry come from Kotak's own master. `securityId` carries the Kotak trading symbol,
 * the handle the exit and cancel routes take for Kotak. Unrealised P&L is left 0: Kotak positions carry no price.
 */
export async function kotakCspActivity(symbols: string[]): Promise<Record<string, { activeOrders: Record<string, unknown>[]; activeTrades: Record<string, unknown>[] }>> {
  const [orders, positions] = await Promise.all([
    kotakGet(KOTAK_PATHS.orderBook).then(kotakRows),
    kotakGet(KOTAK_PATHS.positions).then((j) => kotakRows(j).map(shapeKotakPosition)),
  ]);
  const watched = new Set(symbols.map((s) => s.toUpperCase()));
  const out: Record<string, { activeOrders: Record<string, unknown>[]; activeTrades: Record<string, unknown>[] }> = {};
  for (const s of watched) out[s] = { activeOrders: [], activeTrades: [] };
  const infoOf = async (sym: string) => {
    const u = underlyingPrefix(sym);
    if (!watched.has(u)) return null;
    try { const i = (await kotakSymbolMap(u))[sym]; return i && i.side === 'PE' ? { u, ...i } : null; } catch { return null; }
  };
  for (const o of orders) {
    const sym = String(o.trdSym ?? '').trim();
    const info = await infoOf(sym);
    if (!info) continue;
    const s = shapeKotakOrderStatus(o, String(o.nOrdNo ?? ''));
    if (!['PENDING', 'TRANSIT', 'PART_TRADED'].includes(s.orderStatus)) continue;   // working orders only
    const pt = String(o.prcTp ?? '').toUpperCase();
    out[info.u].activeOrders.push({
      orderId: s.orderId, tradingSymbol: sym, transactionType: String(o.trnsTp ?? '').toUpperCase() === 'B' ? 'BUY' : 'SELL',
      strike: info.strike, expiry: info.expiry, quantity: s.quantity, price: Number(o.prc) || 0, triggerPrice: Number(o.trgPrc) || 0,
      orderType: pt === 'L' ? 'LIMIT' : pt === 'MKT' ? 'MARKET' : pt === 'SL' ? 'STOP_LOSS' : pt === 'SL-M' ? 'STOP_LOSS_MARKET' : pt,
      productType: String(o.prod ?? '').toUpperCase() === 'MIS' ? 'INTRADAY' : 'MARGIN', status: s.orderStatus,
      securityId: sym, exchangeSegment: String(o.exSeg ?? 'nse_fo'), createTime: String(o.ordEntTm ?? ''), updateTime: String(o.exCfmTm ?? ''),
      broker: 'kotak',
    });
  }
  for (const p of positions) {
    if (p.netQty === 0 || !/_fo$/i.test(p.exchange)) continue;
    const info = await infoOf(p.tradingSymbol);
    if (!info) continue;
    out[info.u].activeTrades.push({
      tradingSymbol: p.tradingSymbol, side: p.netQty < 0 ? 'SELL' : 'BUY', netQty: p.netQty, strike: info.strike, expiry: info.expiry,
      costPrice: p.netQty < 0 ? p.sellAvg : p.buyAvg, unrealizedProfit: 0, realizedProfit: p.realizedProfit,
      productType: p.productType.toUpperCase() === 'MIS' ? 'INTRADAY' : 'MARGIN', securityId: p.tradingSymbol, exchangeSegment: p.exchange,
      broker: 'kotak',
    });
  }
  return out;
}
