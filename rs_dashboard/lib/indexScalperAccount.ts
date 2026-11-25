// Pure mappers for /index-scalper's bottom account panel (Dhan-style: Positions, Closed Positions, Orders, Portfolio,
// Funds). Raw Dhan payloads in, display rows out. No React, no fetch.

import { scaleBrokerPnl, contractMultiplier } from './positionPnl.ts';
import { positionProduct } from './positionProduct.ts';

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const EXCHANGE: Record<string, string> = { NSE_FNO: 'NSE', NSE_EQ: 'NSE', BSE_FNO: 'BSE', BSE_EQ: 'BSE', MCX_COMM: 'MCX', IDX_I: 'NSE' };
const PRODUCT: Record<string, string> = { INTRADAY: 'Intraday', MIS: 'Intraday', MARGIN: 'Normal', NRML: 'Normal', CNC: 'Delivery', MTF: 'MTF', CO: 'Cover', BO: 'Bracket' };
const ORDER_TYPE: Record<string, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'SL', STOP_LOSS_MARKET: 'SL-M' };

export const exchangeLabel = (seg: unknown) => EXCHANGE[String(seg ?? '').toUpperCase()] ?? String(seg ?? '');
export const productLabel = (p: unknown) => PRODUCT[String(p ?? '').toUpperCase()] ?? String(p ?? '');

/** Dhan-style contract name: "NIFTY 01 DEC 25550 CALL", "NIFTY DEC FUT", else the trading symbol (equity: no -EQ). */
export function symbolLabel(r: Row): string {
  const ts = String(r.tradingSymbol ?? r.trading_symbol ?? '');
  // Dhan: "NIFTY-Dec2026-25550-CE"; Kotak: "NIFTY2612025550CE" (no dashes): the root is the letters before the digits.
  const under = ts.includes('-') ? ts.split('-')[0] : (/^([A-Z&]+?)(?=\d)/.exec(ts)?.[1] ?? ts);
  const exp = String(r.drvExpiryDate ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(exp);
  const strike = num(r.drvStrikePrice);
  const opt = String(r.drvOptionType ?? '').toUpperCase();
  if (m && strike !== null && strike > 0 && (opt === 'CALL' || opt === 'PUT')) {
    return `${under} ${m[3]} ${MONTHS[Number(m[2]) - 1]} ${Number.isInteger(strike) ? strike : strike.toFixed(2)} ${opt}`;
  }
  if (m && /FUT/i.test(ts)) return `${under} ${MONTHS[Number(m[2]) - 1]} FUT`;
  return ts.replace(/-EQ$/i, '');
}

/** An order time as sortable "YYYY-MM-DD HH:MM:SS": Dhan sends that already; Kotak sends "24-Nov-2026 09:47:40" (or
 *  "24/11/2026 09:47:40"). '' when unreadable or Dhan's "0001-01-01" placeholder. */
export function normTime(v: unknown): string {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return m[1] === '0001' ? '' : `${m[1]}-${m[2]}-${m[3]} ${m[4]}`;
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})[ ,]+(\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toUpperCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')} ${m[4]}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${m[4]}`;
  return '';
}

/** Order time for the panel: "24 Nov 2026, 09:47:40"; '' when unreadable. */
export function timeLabel(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(normTime(v));
  if (!m) return '';
  const mon = MONTHS[Number(m[2]) - 1];
  return `${m[3]} ${mon.charAt(0)}${mon.slice(1).toLowerCase()} ${m[1]}, ${m[4]}`;
}

export type OrderBucket = 'open' | 'executed' | 'cancelled' | 'rejected' | 'other';
export function orderBucket(status: unknown): OrderBucket {
  const s = String(status ?? '').toUpperCase();
  if (s === 'PENDING' || s === 'TRANSIT' || s === 'PART_TRADED' || s === 'TRIGGERED') return 'open';
  if (s === 'TRADED') return 'executed';
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'REJECTED') return 'rejected';
  return 'other';
}

export interface OrderRowView {
  id: string; symbol: string; exchange: string; time: string; sortKey: string; side: 'BUY' | 'SELL' | '';
  /** Contract handle: Dhan security id, or the Kotak trading symbol (kotakOrdersAsDhan sets it). '' when unknown. */
  securityId: string;
  /** An option order (CE / PE): it is priced in premium, so it belongs on that option's chart, not the underlying's. */
  isOption: boolean;
  orderType: string; product: string; qty: number | null; tradedQty: number | null;
  price: number | null; trigger: number | null; avgTraded: number | null;
  status: string; bucket: OrderBucket; reason: string;
  /** Still working at the exchange: the panel and chart may cancel it, whoever placed it (this page, the mobile app,
   *  another terminal or a strategy). */
  cancellable: boolean;
}

function isOptionOrder(o: Row): boolean {
  const opt = String(o.drvOptionType ?? '').toUpperCase();
  if (opt === 'CALL' || opt === 'PUT') return true;
  return /(CE|PE)$/.test(String(o.tradingSymbol ?? o.trading_symbol ?? '').toUpperCase());
}

export function orderRows(orders: Row[]): OrderRowView[] {
  return orders.map(o => {
    const status = String(o.orderStatus ?? '').toUpperCase();
    const bucket = orderBucket(status);
    const side = String(o.transactionType ?? '').toUpperCase();
    const price = num(o.price);
    const trigger = num(o.triggerPrice);
    const avg = num(o.averageTradedPrice);
    const time = String(o.updateTime ?? o.createTime ?? '');
    const created = normTime(o.createTime ?? o.updateTime) || String(o.createTime ?? o.updateTime ?? '');
    return {
      id: String(o.orderId ?? ''),
      securityId: String(o.securityId ?? ''),
      isOption: isOptionOrder(o),
      symbol: symbolLabel(o),
      exchange: exchangeLabel(o.exchangeSegment),
      time: timeLabel(created) || timeLabel(time),
      sortKey: created,
      side: (side === 'BUY' || side === 'SELL' ? side : '') as OrderRowView['side'],
      orderType: ORDER_TYPE[String(o.orderType ?? '').toUpperCase()] ?? String(o.orderType ?? ''),
      product: productLabel(o.productType),
      qty: num(o.quantity),
      tradedQty: num(o.filledQty),
      price: price !== null && price > 0 ? price : null,
      trigger: trigger !== null && trigger > 0 ? trigger : null,
      avgTraded: avg !== null && avg > 0 ? avg : null,
      status: status.replace(/_/g, ' '),
      bucket,
      reason: String(o.omsErrorDescription ?? '').trim(),
      cancellable: bucket === 'open',
    };
  }).sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
}

/** "All N" plus one chip per non-empty bucket, as Dhan shows them. */
export function orderCounts(rows: OrderRowView[]): { key: 'all' | OrderBucket; label: string; n: number }[] {
  const labels: Record<OrderBucket, string> = { open: 'Open', executed: 'Executed', cancelled: 'Cancelled', rejected: 'Rejected', other: 'Other' };
  const out: { key: 'all' | OrderBucket; label: string; n: number }[] = [{ key: 'all', label: 'All', n: rows.length }];
  for (const k of ['open', 'executed', 'cancelled', 'rejected', 'other'] as OrderBucket[]) {
    const n = rows.filter(r => r.bucket === k).length;
    if (n > 0) out.push({ key: k, label: labels[k], n });
  }
  return out;
}

export interface PositionRowView {
  key: string; securityId: string; symbol: string; exchange: string; product: string; productCode: string;
  netQty: number; buyQty: number | null; sellQty: number | null; buyAvg: number | null; sellAvg: number | null;
  avg: number | null; ltp: number | null; realized: number | null; unrealized: number | null; pnl: number | null;
}

/** Dhan position rows -> display rows (open AND closed). MCX P&L is rescaled first (lots, not units). The open part is
 *  marked at our live LTP when we have one (`ltpById`), else at Dhan's own unrealizedProfit. Realized is Dhan's
 *  realizedProfit: never total-minus-unrealized. */
export function positionRows(rows: Row[], prices: Map<string, number> | ((row: Row) => number | undefined)): PositionRowView[] {
  // Dhan rows are priced by security id; Kotak rows (no id the feed knows) through a resolver from their contract.
  const priceOf = typeof prices === 'function' ? prices : (row: Row) => prices.get(String(row.securityId ?? row.security_id ?? ''));
  return rows.map(raw => {
    const r = scaleBrokerPnl(raw);
    const securityId = String(r.securityId ?? r.security_id ?? '');
    const netQty = num(r.netQty) ?? 0;
    const buyAvg = num(r.buyAvg), sellAvg = num(r.sellAvg);
    // Today's average for the open side; a position carried from an earlier day has none (0), its entry is costPrice.
    const dayAvg = netQty > 0 ? buyAvg : netQty < 0 ? sellAvg : null;
    const cost = num(r.costPrice);
    const avg = netQty === 0 ? null : dayAvg !== null && dayAvg > 0 ? dayAvg : cost !== null && cost > 0 ? cost : null;
    const live = priceOf(r);
    const realized = num(r.realizedProfit);
    let unrealized: number | null = netQty === 0 ? 0 : num(r.unrealizedProfit);
    let ltp: number | null = null;
    if (netQty !== 0 && live !== undefined && live > 0 && avg !== null && avg > 0) {
      ltp = live;
      const mult = contractMultiplier(r);
      unrealized = (live - avg) * netQty * mult;
    }
    const pnl = realized === null && unrealized === null ? null : (realized ?? 0) + (unrealized ?? 0);
    return {
      key: `${securityId}|${positionProduct(r)}|${String(r.positionType ?? '')}`, securityId,
      symbol: symbolLabel(r), exchange: exchangeLabel(r.exchangeSegment), product: productLabel(r.productType), productCode: positionProduct(r),
      netQty, buyQty: num(r.buyQty), sellQty: num(r.sellQty), buyAvg, sellAvg, avg, ltp, realized, unrealized, pnl,
    };
  });
}

/** Today's position P&L: every row's realized + open P&L. `loaded` says the book was actually read: an empty book that
 *  was read is a real 0 (as Dhan shows it), one that was never read (first reply pending, or the read failed) is null.
 *  `unpriced` counts open rows whose open P&L is unknown, so a partial total is never shown as complete. */
export function dayPnl(rows: PositionRowView[], loaded = true): { pnl: number | null; unpriced: number } {
  if (!loaded) return { pnl: null, unpriced: 0 };
  if (rows.length === 0) return { pnl: 0, unpriced: 0 };
  let any = false, sum = 0, unpriced = 0;
  for (const r of rows) {
    if (r.netQty !== 0 && r.unrealized === null) unpriced++;
    if (r.pnl !== null) { any = true; sum += r.pnl; }
  }
  return { pnl: any ? sum : null, unpriced };
}

export interface HoldingRowView { key: string; symbol: string; qty: number; avg: number | null; ltp: number | null; invested: number | null; value: number | null; pnl: number | null; pnlPct: number | null }

export function holdingRows(rows: Row[]): HoldingRowView[] {
  return rows.map(h => {
    const qty = num(h.totalQty) ?? 0;
    const avg = num(h.avgCostPrice);
    const ltpRaw = num(h.lastTradedPrice);
    const ltp = ltpRaw !== null && ltpRaw > 0 ? ltpRaw : null;
    const invested = avg !== null && avg > 0 ? avg * qty : null;
    const value = ltp !== null ? ltp * qty : null;
    const pnl = invested !== null && value !== null ? value - invested : null;
    return {
      key: String(h.securityId ?? h.isin ?? h.tradingSymbol ?? ''), symbol: String(h.tradingSymbol ?? ''), qty, avg, ltp, invested, value, pnl,
      pnlPct: pnl !== null && invested ? (pnl / invested) * 100 : null,
    };
  });
}

/** Holding P&L; an empty demat that was read is a real 0 (as Dhan shows it), one never read is null. */
export function holdingPnl(rows: HoldingRowView[], loaded = true): number | null {
  if (!loaded) return null;
  if (rows.length === 0) return 0;
  let any = false, sum = 0;
  for (const r of rows) if (r.pnl !== null) { any = true; sum += r.pnl; }
  return any ? sum : null;
}

export interface FundsView { available: number | null; used: number | null; sodLimit: number | null; collateral: number | null; receivable: number | null; blockedPayout: number | null; withdrawable: number | null }

/** Dhan /fundlimit (its field really is spelled `availabelBalance`). */
export function fundsView(d: Row | null | undefined): FundsView {
  const f = d ?? {};
  return {
    available: num(f.availabelBalance ?? f.availableBalance), used: num(f.utilizedAmount), sodLimit: num(f.sodLimit),
    collateral: num(f.collateralAmount), receivable: num(f.receiveableAmount), blockedPayout: num(f.blockedPayoutAmount),
    withdrawable: num(f.withdrawableBalance),
  };
}

/** CSV of the visible table (header row + rows), for the panel's download button. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\n');
}
