// Pure Kotak rules for /index-scalper. No React, no fetch, no fs.
//
// Ownership: Kotak has no order tag the repo can read back, so the server records the order IDs this page placed each
// IST day (app/api/index-scalper/kotak-order). What this page owns on a contract is what THOSE orders filled, per
// trading symbol + product, read from Kotak's own order book: the Dhan `isx` rule, keyed by order ID instead of a tag.
// Quantity a strategy, another terminal or a manual order holds on the same contract is never counted, so never closed.

import { classifyKotakStatus } from './kotakShape.ts';
import { normTime } from './indexScalperAccount.ts';
import type { ScalperLeg } from './indexScalperPositions.ts';
import type { Underlying } from './indexScalperInstrument.ts';

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

/** Order-entry time of a shaped Kotak order row (IST wall clock) as epoch ms, or null when unreadable. */
export function kotakOrderMs(o: Record<string, unknown>): number | null {
  const t = normTime(o.createTime);
  if (!t) return null;
  const ms = Date.parse(`${t.replace(' ', 'T')}+05:30`);
  return Number.isFinite(ms) ? ms : null;
}

/** Window around an unknown outcome's send time in which its order must appear in the book to be recognised. */
const UNKNOWN_MATCH_MS = 30_000;

/** Unknown outcomes the order book has since resolved: an order on the same symbol, side and quantity, entered within
 *  30 s of the send, that no recorded order already owns. A record is resolved only by exactly ONE such order (two
 *  candidates are ambiguous and stay unknown), and each order resolves at most one record. Returns record index ->
 *  order ID. Read-time only: the book is always at hand when ownership is read, so nothing is written back. */
export function resolveUnknowns(records: KotakRecord[], book: Record<string, unknown>[]): Map<number, string> {
  const taken = recordedIds(records);
  const out = new Map<number, string>();
  records.forEach((r, i) => {
    if (!r.unknown) return;
    const cands = book.filter(o => {
      const id = String(o.orderId ?? '');
      if (!id || taken.has(id)) return false;
      if (String(o.tradingSymbol ?? '') !== r.symbol) return false;
      if (String(o.transactionType ?? '').toUpperCase() !== r.side) return false;
      if ((Number(o.quantity) || 0) !== r.qty) return false;
      const ms = kotakOrderMs(o);
      return ms !== null && Math.abs(ms - r.at) <= UNKNOWN_MATCH_MS;
    });
    if (cands.length !== 1) return;
    const id = String(cands[0].orderId);
    taken.add(id);
    out.set(i, id);
  });
  return out;
}

/** Records with every unknown the book has resolved turned into an ordinary (owned) record. */
export function withResolvedUnknowns(records: KotakRecord[], book: Record<string, unknown>[]): KotakRecord[] {
  const res = resolveUnknowns(records, book);
  if (res.size === 0) return records;
  return records.map((r, i) => {
    const id = res.get(i);
    if (!id || !r.unknown) return r;
    const row = book.find(o => String(o.orderId ?? '') === id);
    return { orderId: id, symbol: r.symbol, side: r.side, product: String(row?.productType ?? 'MIS'), at: r.at };
  });
}

/** Signed filled units per `symbol|product` over the orders this page recorded, from Kotak's shaped order book
 *  (lib/kotakShape.ts shapeKotakOrder rows). It does not gate exits (any position may be closed): it tells which rows
 *  hold quantity opened elsewhere, for Exit All's confirmation (`legsOpenedElsewhere`). A fill with no filled quantity on a TRADED order counts its quantity;
 *  a row whose fill is unknown counts nothing. The page's own exits are recorded too, so they net ownership down. */
export function ownedQtyFromKotakOrders(book: Record<string, unknown>[], recordsIn: KotakRecord[]): Map<string, number> {
  // An unknown outcome whose order has since shown up in the book is this page's order like any other.
  const records = withResolvedUnknowns(recordsIn, book);
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
export function heldByUnknown(records: KotakRecord[], symbol: string, now: number, holdMs = 60_000, book: Record<string, unknown>[] = []): boolean {
  // Once the book shows the order (resolved), its fill is counted as owned and nothing needs to wait for it.
  const resolved = resolveUnknowns(records, book);
  return records.some((r, i) => r.unknown && !resolved.has(i) && r.symbol === symbol && now - r.at < holdMs);
}

/** Order IDs this page recorded (its own orders: the only ones the panel may cancel). */
export function recordedIds(records: KotakRecord[]): Set<string> {
  const s = new Set<string>();
  for (const r of records) if (!r.unknown && r.orderId) s.add(String(r.orderId));
  return s;
}

export type KotakSymbolInfo = { expiry: string; strike: number; side: 'CE' | 'PE' | 'FUT' };

/** Kotak position rows (lib/kotakShape.ts shapeKotakPosition: no LTP) -> Scalper legs. Identity is trading
 *  symbol + product; the symbol also sits in `securityId` (the repo rule for Kotak). `priceOf` prices a leg from the
 *  Dhan live feed (null when its expiry is not on screen: never the strike, never 0). */
export function legsFromKotakPositions(
  rows: Record<string, unknown>[],
  symbols: Record<string, KotakSymbolInfo>,
  priceOf: (info: KotakSymbolInfo) => number | null,
  underlying: Underlying = 'NIFTY',
): ScalperLeg[] {
  const out: ScalperLeg[] = [];
  const seen = new Set<string>();
  const isTarget = (s: string) => (underlying === 'CRUDEOILM' ? /^CRUDEOILM\d/.test(s) : /^NIFTY\d/.test(s));
  for (const r of rows) {
    const sym = String(r.tradingSymbol ?? '');
    const info = symbols[sym];
    if (!info || !isTarget(sym)) continue;
    // For NIFTY we currently scalper options only unless futures are on screen; for CRUDEOILM we support options and FUT
    if (underlying === 'NIFTY' && info.side === 'FUT') continue;
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
      ltp: ltp !== null && ltp > 0 ? ltp : null, sim: false, mult: 1,
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
    const isMcx = sym.startsWith('CRUDEOIL');
    return {
      orderId: String(o.orderId ?? ''),
      // Kotak's contract handle is its trading symbol (a Kotak leg's securityId is the same string).
      securityId: sym,
      correlationId: ours.has(String(o.orderId ?? '')) ? 'isx-kotak' : '',
      orderStatus: status,
      transactionType: o.transactionType,
      exchangeSegment: isMcx ? 'MCX_COMM' : 'NSE_FNO',
      productType: dashProduct(o.productType),
      orderType: o.orderType,
      tradingSymbol: sym,
      quantity: qty,
      price: o.price,
      triggerPrice: o.triggerPrice,
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

/** A close of `units` cut into orders the exchange accepts: each at most the freeze quantity, rounded down to whole lots
 *  (a slice that is not a lot multiple would be rejected). One slice when the freeze quantity is unknown or not hit. */
export function freezeSlices(units: number, freezeQty: number | null, lotSize: number | null): number[] {
  if (!(units > 0)) return [];
  if (!freezeQty || units <= freezeQty) return [units];
  const lot = lotSize && lotSize > 0 ? lotSize : 1;
  const step = Math.max(lot, Math.floor(freezeQty / lot) * lot);
  const out: number[] = [];
  let left = units;
  while (left > 0) { const q = Math.min(step, left); out.push(q); left -= q; }
  return out;
}

/** The day file after recording `rec`: a file from another IST day starts over (yesterday's orders are not today's). */
export function appendRecord(file: KotakDayFile | null | undefined, day: string, rec: KotakRecord): KotakDayFile {
  return { day, records: [...todaysRecords(file, day), rec] };
}
