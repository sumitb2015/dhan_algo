// Pure Kotak rules for /index-scalper. No React, no fetch, no fs.
//
// Ownership: Kotak has no order tag the repo can read back, so the server records the order IDs this page placed each
// IST day (app/api/index-scalper/kotak-order). What this page owns on a contract is what THOSE orders filled, per
// trading symbol + product, read from Kotak's own order book: the Dhan `isx` rule, keyed by order ID instead of a tag.
// Quantity a strategy, another terminal or a manual order holds on the same contract is never counted, so never closed.

import { classifyKotakStatus } from './kotakShape.ts';
import type { ScalperLeg } from './indexScalperPositions.ts';

/** One record of the page's day file. `unknown` = Kotak did not confirm and the order may be live. */
export type KotakRecord =
  | { orderId: string; symbol: string; side: 'BUY' | 'SELL'; product: string; at: number; unknown?: false }
  | { unknown: true; symbol: string; side: 'BUY' | 'SELL'; qty: number; at: number; orderId?: undefined };

export interface KotakDayFile { day: string; records: KotakRecord[] }

/** Our dashboard product -> Kotak's (MIS / NRML); null for anything else (refused, never coerced). */
export function kotakProduct(p: unknown): 'MIS' | 'NRML' | null {
  const s = String(p ?? '').toUpperCase();
  if (s === 'INTRADAY' || s === 'MIS') return 'MIS';
  if (s === 'MARGIN' || s === 'NRML') return 'NRML';
  return null;
}

/** Kotak product -> the dashboard's vocabulary (positions / orders tables, ownership keys). */
export function dashProduct(p: unknown): string {
  const s = String(p ?? '').toUpperCase();
  return s === 'MIS' ? 'INTRADAY' : s === 'NRML' ? 'MARGIN' : s;
}

export const kotakKey = (symbol: string, product: string) => `${symbol}|${dashProduct(product)}`;

/** The day's records: a file from another IST day counts as empty (yesterday's orders are not today's book). */
export function todaysRecords(file: KotakDayFile | null | undefined, day: string): KotakRecord[] {
  return file && file.day === day && Array.isArray(file.records) ? file.records : [];
}

/** Signed filled units per `symbol|product` over the orders this page recorded, from Kotak's shaped order book
 *  (lib/kotakShape.ts shapeKotakOrder rows). A fill with no filled quantity on a TRADED order counts its quantity;
 *  a row whose fill is unknown counts nothing. The page's own exits are recorded too, so they net ownership down. */
export function ownedQtyFromKotakOrders(book: Record<string, unknown>[], records: KotakRecord[]): Map<string, number> {
  const ours = new Map<string, KotakRecord>();
  for (const r of records) if (!r.unknown && r.orderId) ours.set(String(r.orderId), r);
  const out = new Map<string, number>();
  for (const o of book) {
    const rec = ours.get(String(o.orderId ?? ''));
    if (!rec || rec.unknown) continue;
    const qty = Number(o.quantity) || 0;
    const rawFilled = o.filledQty === undefined || o.filledQty === null ? null : Number(o.filledQty);
    const status = classifyKotakStatus(String(o.orderStatus ?? ''), rawFilled ?? 0, qty);
    const filled = rawFilled !== null && Number.isFinite(rawFilled) && rawFilled > 0 ? rawFilled : status === 'TRADED' ? qty : 0;
    if (!(filled > 0)) continue;
    const side = String(o.transactionType ?? rec.side).toUpperCase();
    const k = kotakKey(String(o.tradingSymbol ?? rec.symbol), String(o.productType ?? rec.product));
    out.set(k, (out.get(k) ?? 0) + (side === 'BUY' ? filled : -filled));
  }
  return out;
}

/** An order on `symbol` whose outcome is unknown within the last `holdMs`: its exits wait (the order may still fill,
 *  and an exit sized before it lands could flip the position). */
export function heldByUnknown(records: KotakRecord[], symbol: string, now: number, holdMs = 60_000): boolean {
  return records.some(r => r.unknown && r.symbol === symbol && now - r.at < holdMs);
}

/** Order IDs this page recorded (its own orders: the only ones the panel may cancel). */
export function recordedIds(records: KotakRecord[]): Set<string> {
  const s = new Set<string>();
  for (const r of records) if (!r.unknown && r.orderId) s.add(String(r.orderId));
  return s;
}

export type KotakSymbolInfo = { expiry: string; strike: number; side: 'CE' | 'PE' | 'FUT' };

/** Kotak position rows (lib/kotakShape.ts shapeKotakPosition: no LTP) -> NIFTY option legs. Identity is trading
 *  symbol + product; the symbol also sits in `securityId` (the repo rule for Kotak). `priceOf` prices a leg from the
 *  Dhan live feed (null when its expiry is not on screen: never the strike, never 0). */
export function legsFromKotakPositions(
  rows: Record<string, unknown>[],
  symbols: Record<string, KotakSymbolInfo>,
  priceOf: (info: KotakSymbolInfo) => number | null,
): ScalperLeg[] {
  const out: ScalperLeg[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const sym = String(r.tradingSymbol ?? '');
    const info = symbols[sym];
    if (!info || info.side === 'FUT' || !/^NIFTY\d/.test(sym)) continue;
    const netQty = Number(r.netQty);
    if (!Number.isFinite(netQty) || netQty === 0) continue;
    const product = dashProduct(r.productType);
    const id = kotakKey(sym, product);
    if (seen.has(id)) continue;
    seen.add(id);
    const avgRaw = netQty > 0 ? Number(r.buyAvg) : Number(r.sellAvg);
    if (!Number.isFinite(avgRaw) || avgRaw <= 0) continue;
    const ltp = priceOf(info);
    out.push({
      id, securityId: sym, product, symbol: sym, strike: info.strike, type: info.side, netQty, avg: avgRaw,
      ltp: ltp !== null && ltp > 0 ? ltp : null, sim: false,
    });
  }
  return out;
}

/** Kotak shaped order rows -> Dhan-shaped order records, so the panel's one Orders table (lib/indexScalperAccount.ts
 *  orderRows) reads both brokers. Status is folded onto Dhan's vocabulary; this page's own orders get the `isx`
 *  correlation prefix so the panel offers Cancel on them and nothing else. */
export function kotakOrdersAsDhan(book: Record<string, unknown>[], symbols: Record<string, KotakSymbolInfo>, ours: Set<string>): Record<string, unknown>[] {
  return book.map(o => {
    const sym = String(o.tradingSymbol ?? '');
    const info = symbols[sym];
    const qty = Number(o.quantity) || 0;
    const filled = o.filledQty === undefined || o.filledQty === null ? null : Number(o.filledQty) || 0;
    const status = classifyKotakStatus(String(o.orderStatus ?? ''), filled ?? 0, qty);
    return {
      orderId: String(o.orderId ?? ''),
      correlationId: ours.has(String(o.orderId ?? '')) ? 'isx-kotak' : '',
      orderStatus: status,
      transactionType: o.transactionType,
      exchangeSegment: 'NSE_FNO',
      productType: dashProduct(o.productType),
      orderType: o.orderType,
      tradingSymbol: sym,
      quantity: qty,
      price: o.price,
      createTime: o.createTime,
      filledQty: filled ?? (status === 'TRADED' ? qty : null),
      averageTradedPrice: o.averagePrice,
      omsErrorDescription: o.reason ?? '',
      ...(info && info.side !== 'FUT'
        ? { drvExpiryDate: info.expiry, drvOptionType: info.side === 'CE' ? 'CALL' : 'PUT', drvStrikePrice: info.strike }
        : info ? { drvExpiryDate: info.expiry } : {}),
    };
  });
}
