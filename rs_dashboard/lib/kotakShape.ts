import type { ScalperPosition, ScalperOrder, ScalperTrade } from './zerodhaShape';

// Kotak Neo -> the Dhan-shaped scalper interfaces, mirroring lib/zerodhaShape.ts.
//
// Kotak's position payload is the awkward one: it reports day (`fl*`) and
// carry-forward (`cf*`) legs separately and NEVER a net quantity, so net has to
// be computed. Getting it wrong makes an open position render as flat.

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(row: Record<string, any>, ...keys: string[]): number {
  let total = 0;
  for (const key of keys) {
    const v = Number(row[key]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

export function shapeKotakPosition(p: Record<string, any>): ScalperPosition {
  // No net-qty field exists — sum the four legs. Carry-forward first so an
  // overnight position that traded again today still nets correctly.
  const cfBuyQty = num(p, 'cfBuyQty');
  const cfSellQty = num(p, 'cfSellQty');
  const cfBuyAmt = num(p, 'cfBuyAmt');
  const cfSellAmt = num(p, 'cfSellAmt');

  const buyQty = num(p, 'cfBuyQty', 'flBuyQty');
  const sellQty = num(p, 'cfSellQty', 'flSellQty');
  const netQty = buyQty - sellQty;

  const buyAmt = num(p, 'cfBuyAmt', 'buyAmt');
  const sellAmt = num(p, 'cfSellAmt', 'sellAmt');
  const buyAvg = buyQty ? buyAmt / buyQty : 0;
  const sellAvg = sellQty ? sellAmt / sellQty : 0;

  // Never take a price from Kotak's positions payload. `stkPrc` is the option's
  // STRIKE — reading it as an LTP marks a 4.40 option at 24300 and reports lakhs
  // of phantom P&L, which the target/SL guards would then act on. And the `ltp`
  // that portfolio/v2/positions added (kotakneoapi 3.0.9) is not live: on
  // 2026-10-17 it equalled each leg's entry average, or 0 — the SDK itself
  // leaves it unused as unreliable. Trusting it made every consumer skip the
  // Dhan quote join (prices are Dhan-only). 0 means "unknown": the UI joins live
  // Dhan quotes onto the row by trading symbol.
  const lastPrice = 0;

  // Realized is the matched (round-tripped) quantity only; the open quantity's
  // mark-to-market is unrealized. Deriving realized as total-minus-unrealized
  // instead would fold the whole open leg into realized whenever LTP is unknown.
  const matchedQty = Math.min(buyQty, sellQty);
  const realized = matchedQty * (sellAvg - buyAvg);
  const unrealized = netQty === 0 || lastPrice <= 0
    ? 0
    : netQty * (lastPrice - (netQty > 0 ? buyAvg : sellAvg));

  const base: ScalperPosition = {
    tradingSymbol: String(p.trdSym ?? p.sym ?? ''),
    securityId: String(p.tok ?? ''),
    exchange: String(p.exSeg ?? 'nse_fo'),
    netQty,
    buyQty,
    sellQty,
    buyAvg,
    sellAvg,
    lastTradedPrice: lastPrice,
    realizedProfit: realized,
    unrealizedProfit: unrealized,
    productType: String(p.prod ?? p.prd ?? ''),
  };
  const lotSz = Number(p.lotSz);
  if (Number.isInteger(lotSz) && lotSz > 0) base.lotSize = lotSz;
  if (cfBuyQty > 0 || cfSellQty > 0) {
    base.cfBuyQty = cfBuyQty;
    base.cfSellQty = cfSellQty;
    base.cfBuyAmt = cfBuyAmt;
    base.cfSellAmt = cfSellAmt;
    base.carryForwardBuyQty = cfBuyQty;
    base.carryForwardSellQty = cfSellQty;
    base.carryForwardBuyValue = cfBuyAmt;
    base.carryForwardSellValue = cfSellAmt;
  }
  return base;
}

/** Kotak's single-letter transaction type -> the BUY/SELL the UI expects. */
function txnType(raw: any): string {
  const t = String(raw ?? '').trim().toUpperCase();
  if (t === 'B' || t === 'BUY') return 'BUY';
  if (t === 'S' || t === 'SELL') return 'SELL';
  return t;
}

export function shapeKotakOrder(o: Record<string, any>): ScalperOrder {
  const priceType = String(o.prcTp ?? '').toUpperCase();
  return {
    orderId: String(o.nOrdNo ?? o.orderId ?? ''),
    tradingSymbol: String(o.trdSym ?? o.sym ?? ''),
    orderStatus: String(o.ordSt ?? o.st ?? '').toUpperCase(),
    transactionType: txnType(o.trnsTp),
    quantity: Number(o.qty ?? o.ordQty) || 0,
    price: Number(o.prc ?? o.ordPrc) || 0,
    orderType: priceType === 'MKT' ? 'MARKET' : priceType === 'L' ? 'LIMIT' : priceType === 'SL' ? 'STOP_LOSS' : priceType === 'SL-M' ? 'STOP_LOSS_MARKET' : priceType,
    createTime: String(o.ordEntTm ?? o.ordDtTm ?? o.ordTm ?? o.exCfmTm ?? o.orderDateTime ?? o.orderTimestamp ?? o.createTime ?? ''),
    averagePrice: Number(o.avgPrc) || 0,
    // Only when the row carries it: an absent field must read as UNKNOWN (null downstream), never as "nothing filled".
    ...(o.fldQty != null && o.fldQty !== '' ? { filledQty: Number(o.fldQty) || 0 } : {}),
  };
}

/**
 * One Kotak order, shaped like the Dhan single-order payload (`GET /api/scalper/orders?orderId=`) so the
 * order-confirmation loops (confirmDhanOrder, fill-price re-pricing) work unchanged. Kotak's free-text
 * status is folded onto Dhan's vocabulary: TRADED / REJECTED / CANCELLED / PART_TRADED / PENDING / TRANSIT.
 */
export function shapeKotakOrderStatus(o: Record<string, any>, fallbackId = '') {
  const raw = String(o.ordSt ?? o.st ?? '').trim().toUpperCase().split(/\s+/).join(' ');
  const qty = Number(o.qty ?? o.ordQty) || 0;
  const filled = Number(o.fldQty) || 0;
  const orderStatus = classifyKotakStatus(raw, filled, qty);
  return {
    orderId: String(o.nOrdNo ?? o.orderId ?? fallbackId),
    orderStatus,
    quantity: qty,
    filledQty: orderStatus === 'TRADED' && filled === 0 ? qty : filled,
    averageTradedPrice: Number(o.avgPrc) || 0,
    reason: String(o.rejRsn ?? o.rejectionReason ?? ''),
  };
}

// Neo's order-status vocabulary, as already established by lib/kotak/responses.py (the copy-trade bridge's classifier).
// EXACT matches only: a substring test read "CANCEL PENDING" (an order still live) as cancelled.
const KOTAK_TRADED = new Set(['COMPLETE', 'COMPLETED', 'TRADED', 'EXECUTED', 'FILLED']);
const KOTAK_REJECTED = new Set(['REJECTED', 'REJECT', 'REJ']);
const KOTAK_CANCELLED = new Set(['CANCELLED', 'CANCELED', 'CAN']);
const KOTAK_PART = new Set(['PARTIALLY FILLED', 'PART TRADED']);
const KOTAK_WORKING = new Set(['OPEN', 'MODIFIED', 'TRIGGER PENDING', 'AFTER MARKET ORDER REQ RECEIVED']);

/**
 * Kotak status -> Dhan's vocabulary. An unrecognised status is TRANSIT (unsettled) unless the quantities settle it: a
 * fill equal to a positive order quantity is a fill whatever the word, while anything else must never read as filled or dead.
 */
export function classifyKotakStatus(status: string, filled: number, qty: number): string {
  if (KOTAK_TRADED.has(status)) return 'TRADED';
  if (KOTAK_REJECTED.has(status)) return 'REJECTED';
  if (KOTAK_CANCELLED.has(status)) return 'CANCELLED';
  if (KOTAK_PART.has(status)) return 'PART_TRADED';
  if (KOTAK_WORKING.has(status)) return filled > 0 && filled < qty ? 'PART_TRADED' : 'PENDING';
  if (qty > 0 && filled >= qty) return 'TRADED';
  return 'TRANSIT';   // PUT ORDER REQ RECEIVED, VALIDATION PENDING, OPEN PENDING, MODIFY/CANCEL PENDING, anything new
}

export function shapeKotakTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.trdSym ?? t.sym ?? ''),
    transactionType: txnType(t.trnsTp),
    tradedQuantity: Number(t.fldQty ?? t.qty) || 0,
    tradedPrice: Number(t.avgPrc ?? t.prc) || 0,
    createTime: String(t.flTm ?? t.exTm ?? t.trdTm ?? t.ordEntTm ?? t.ordDtTm ?? t.createTime ?? ''),
    ...(t.nOrdNo != null ? { orderId: String(t.nOrdNo) } : {}),
    ...(t.flId != null ? { tradeId: String(t.flId) } : {}),
  };
}

/**
 * Funds/limits, shaped like the Dhan funds payload the scalper's FundsView reads.
 *
 * `Net` is NOT cash. Kotak reports `Net = Collateral + CollateralValue + cash`,
 * and on a collateral-only account the whole balance is pledged-holdings value
 * after haircut — measured on a real account: Net 9,54,701.99 = Collateral
 * 9,25,581.66 + CollateralValue 29,120.33, cash 0.00, backed by ~10.3L of
 * equity holdings.
 *
 * Both collateral fields must be ADDED. Subtracting only `Collateral` reported
 * Rs 29,120 of cash on an account holding none.
 *
 * `availableBalance` stays as `Net` because that is the margin an option WRITE
 * is checked against (and it matches how the Zerodha route reports equity.net),
 * but `cashBalance` is surfaced alongside it so a collateral-only account is
 * visibly distinct from a funded one.
 */
export function shapeKotakFunds(res: Record<string, any>) {
  const net = Number(res.Net ?? res.net) || 0;
  const collateral = (Number(res.Collateral ?? 0) || 0) + (Number(res.CollateralValue ?? 0) || 0);
  const cash = Math.max(0, net - collateral);
  return {
    availableBalance: net,
    // Real money: what option premium on a BUY can be paid from. Collateral
    // cannot pay premium, so this is the ceiling on buying.
    cashBalance: cash,
    withdrawableBalance: cash,
    utilizedAmount: Number(res.MarginUsed ?? res.marginUsed) || 0,
    collateralAmount: collateral,
  };
}

/** True for a Kotak F&O position (nse_fo / bse_fo / mcx_fo / cde_fo), false for cash equity (nse_cm / bse_cm) or unknown. */
export function isKotakFnoPosition(pos: { exchange?: unknown }): boolean {
  return /_fo$/i.test(String(pos.exchange ?? '').trim());
}

const KOTAK_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A Kotak order/trade timestamp as epoch ms, read as IST. The formats lib/kotak's Python side already accepts:
 * "21-Aug-2026 10:15:22", "21-08-2026 10:15:22", "2026-08-21 10:15:22" and a bare "10:15:22" (today, IST).
 * Null when unparseable - callers must fail closed on that.
 */
export function parseKotakTime(raw: unknown, now: number = Date.now()): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = (y: string, mo: number, d: string, t: string) => {
    const v = Date.parse(`${y}-${String(mo).padStart(2, '0')}-${d.padStart(2, '0')}T${t.length === 5 ? `${t}:00` : t}+05:30`);
    return Number.isFinite(v) ? v : null;
  };
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) { const mo = KOTAK_MONTHS.indexOf(m[2].toLowerCase()); return mo >= 0 ? iso(m[3], mo + 1, m[1], m[4]) : null; }
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) return iso(m[3], Number(m[2]), m[1], m[4]);
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) return iso(m[1], Number(m[2]), m[3], m[4]);
  m = /^(\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) {
    const [y, mo, d] = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-');
    return iso(y, Number(mo), d, m[1]);
  }
  return null;
}

/**
 * The order an unanswered placement became, if Kotak booked it: same symbol, side and quantity, not rejected/cancelled,
 * entered no earlier than `since` (minus a small clock skew). Mirrors KotakChild.find_recent_matching_order in
 * scripts/tools/child_brokers.py. An unparseable timestamp never matches, and two candidates are ambiguous (null).
 */
export function findRecentKotakOrder(
  rows: Record<string, any>[],
  want: { symbol: string; side: 'BUY' | 'SELL'; qty: number; since: number },
  /** Clock-skew allowance. Small on purpose: a wider window could pick up an identical order sent just before. */
  skewMs = 2000,
): string | null {
  const { ids } = kotakOrderCandidates(rows, want, skewMs);
  return ids.length === 1 ? ids[0] || null : null;
}

/**
 * Every live-looking order that matches `want` (same symbol, side, quantity, not rejected/cancelled), split by whether its
 * timestamp could be read: `ids` entered no earlier than `since` (minus the skew), `unreadable` is how many matching rows
 * have a timestamp that could not be parsed. A caller that wants to conclude "no such order" must treat unreadable > 0 as
 * "cannot tell" - findRecentKotakOrder ignores them, which is right for adopting an order and wrong for ruling one out.
 */
export function kotakOrderCandidates(
  rows: Record<string, any>[],
  want: { symbol: string; side: 'BUY' | 'SELL'; qty: number; since: number },
  skewMs = 2000,
): { ids: string[]; unreadable: number } {
  const txn = want.side === 'BUY' ? 'B' : 'S';
  const ids: string[] = [];
  let unreadable = 0;
  for (const o of rows) {
    if (String(o.trdSym ?? '').trim() !== want.symbol) continue;
    if (String(o.trnsTp ?? '').trim().toUpperCase() !== txn) continue;
    if (Math.round(Number(o.qty ?? 0)) !== want.qty) continue;
    const st = classifyKotakStatus(String(o.ordSt ?? '').trim().toUpperCase().split(/\s+/).join(' '), Number(o.fldQty) || 0, Number(o.qty) || 0);
    if (st === 'REJECTED' || st === 'CANCELLED') continue;
    const ts = parseKotakTime(o.ordEntTm ?? o.ordDtTm ?? o.ordTm ?? o.exCfmTm);
    if (ts == null) unreadable++;
    else if (ts >= want.since - skewMs) ids.push(String(o.nOrdNo ?? ''));
  }
  return { ids, unreadable };
}

/** One Kotak holding, in the shape the equity and covered-call desks read. */
export interface KotakHolding {
  /** Plain NSE symbol (RELIANCE, NIFTYBEES). */
  symbol: string;
  /** Total quantity held. */
  qty: number;
  /** Quantity that can be sold now (excludes pledged / T1 / blocked). Falls back to qty only if Kotak sends no field for it. */
  sellableQty: number;
  avgPrice: number;
}

/**
 * Kotak's holdings rows -> KotakHolding. Field names are read defensively (displaySymbol / symbol / trdSym, quantity / qty,
 * sellableQuantity / freeQty) because this endpoint has not been seen from this app before; a row whose quantity cannot be
 * read is dropped, never treated as zero-or-more. A trading symbol's series suffix (RELIANCE-EQ) is stripped.
 */
export function shapeKotakHolding(h: Record<string, any>): KotakHolding | null {
  const rawSym = String(h.displaySymbol ?? h.symbol ?? h.trdSym ?? h.tradingSymbol ?? '').trim().toUpperCase();
  const symbol = rawSym.replace(/-(EQ|BE|BZ|BL|SM|ST)$/, '');
  const qtyRaw = h.quantity ?? h.qty ?? h.holdingsQuantity ?? h.totalQty;
  const qty = Number(qtyRaw);
  if (!symbol || qtyRaw == null || qtyRaw === '' || !Number.isFinite(qty)) return null;
  const sellRaw = h.sellableQuantity ?? h.sellableQty ?? h.freeQuantity ?? h.freeQty;
  const sellable = sellRaw == null || sellRaw === '' ? qty : Number(sellRaw);
  return {
    symbol, qty,
    sellableQty: Number.isFinite(sellable) ? Math.max(0, Math.min(sellable, qty)) : 0,
    avgPrice: Number(h.averagePrice ?? h.avgPrice ?? h.avgPrc ?? 0) || 0,
  };
}

/**
 * Shares already committed to OPEN Kotak sell orders on one cash contract + product (so a second sell cannot oversell
 * while the first is still working). A row whose status is not yet settled counts as open; quantity is what is still
 * unfilled. `product` is the dashboard's CNC / INTRADAY; Kotak writes CNC / MIS.
 */
export function kotakPendingSellQty(rows: Record<string, any>[], tradingSymbol: string, product: 'CNC' | 'INTRADAY'): number {
  const want = product === 'INTRADAY' ? 'MIS' : 'CNC';
  let total = 0;
  for (const o of rows) {
    if (String(o.trdSym ?? '').trim() !== tradingSymbol) continue;
    if (String(o.trnsTp ?? '').trim().toUpperCase() !== 'S') continue;
    if (String(o.prod ?? o.prd ?? '').trim().toUpperCase() !== want) continue;
    const qty = Number(o.qty ?? o.ordQty) || 0;
    const filled = Number(o.fldQty) || 0;
    const st = classifyKotakStatus(String(o.ordSt ?? '').trim().toUpperCase().split(/\s+/).join(' '), filled, qty);
    if (st === 'TRADED' || st === 'REJECTED' || st === 'CANCELLED' || st === 'EXPIRED') continue;
    total += Math.max(0, qty - filled);
  }
  return total;
}
