// The P&F page's account books (read-only): positions, order book, trade book and the day's P&L, for the header's broker.
// Rows arrive in Dhan's field names (Dhan raw, Kotak / Zerodha already shaped by lib/kotakShape.ts / lib/zerodhaShape.ts);
// these pure helpers turn each into one display row. A missing field stays null (shown as "—"), never zero.
import { scaleBrokerPnl } from './positionPnl.ts';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const side = (v: unknown): 'BUY' | 'SELL' | '' => {
  const s = str(v).toUpperCase();
  return s === 'BUY' || s === 'B' ? 'BUY' : s === 'SELL' || s === 'S' ? 'SELL' : '';
};

/** "2026-10-30 10:12:01", "30-Oct-2026 10:12:01", an ISO stamp... -> "10:12:01" (all books are today's). */
export function clockOf(v: unknown): string {
  const m = str(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}` : '';
}

export interface PositionRow {
  symbol: string; product: string; net: number; avg: number | null; ltp: number | null;
  realised: number | null; unrealised: number | null; open: boolean;
}

/** One positions row (MCX P&L rescaled: Dhan reports it per lot). Average = the open side's average. */
export function toPositionRow(raw: Record<string, unknown>): PositionRow {
  const p = scaleBrokerPnl(raw);
  const net = num(p.netQty) ?? 0;
  const buyAvg = num(p.buyAvg), sellAvg = num(p.sellAvg), cost = num(p.costPrice);
  const avg = net > 0 ? (buyAvg || cost) : net < 0 ? (sellAvg || cost) : null;
  const ltp = num(p.lastTradedPrice ?? p.ltp ?? p.lastPrice);
  return {
    symbol: str(p.tradingSymbol), product: str(p.productType).toUpperCase(), net,
    avg: avg && avg > 0 ? avg : null, ltp: ltp && ltp > 0 ? ltp : null,
    realised: num(p.realizedProfit), unrealised: net !== 0 && !(ltp && ltp > 0) ? null : num(p.unrealizedProfit), open: net !== 0,
  };
}

export type OrderState = 'done' | 'open' | 'rejected' | 'cancelled';
export interface OrderRow {
  id: string; time: string; symbol: string; side: 'BUY' | 'SELL' | ''; qty: number; filled: number | null;
  price: number | null; avg: number | null; type: string; product: string; status: string; state: OrderState; reason: string;
}

const DONE = new Set(['TRADED', 'COMPLETE', 'COMPLETED', 'EXECUTED', 'FILLED']);
const REJ = new Set(['REJECTED', 'REJECT', 'REJ']);
const CAN = new Set(['CANCELLED', 'CANCELED', 'CAN', 'EXPIRED']);

export function orderState(status: string): OrderState {
  const s = status.trim().toUpperCase();
  if (DONE.has(s)) return 'done';
  if (REJ.has(s)) return 'rejected';
  if (CAN.has(s)) return 'cancelled';
  return 'open';                        // PENDING / TRANSIT / OPEN / PART_TRADED / TRIGGER PENDING / anything new
}

export function toOrderRow(o: Record<string, unknown>): OrderRow {
  const status = str(o.orderStatus).toUpperCase();
  const price = num(o.price), avg = num(o.averageTradedPrice ?? o.averagePrice);
  return {
    id: str(o.orderId), time: clockOf(o.createTime ?? o.updateTime), symbol: str(o.tradingSymbol), side: side(o.transactionType),
    qty: num(o.quantity) ?? 0, filled: num(o.filledQty), price: price && price > 0 ? price : null, avg: avg && avg > 0 ? avg : null,
    type: str(o.orderType).toUpperCase(), product: str(o.productType).toUpperCase(), status, state: orderState(status),
    reason: str(o.omsErrorDescription ?? o.reason),
  };
}

export interface TradeRow { id: string; orderId: string; time: string; symbol: string; side: 'BUY' | 'SELL' | ''; qty: number; price: number | null; product: string }

export function toTradeRow(t: Record<string, unknown>): TradeRow {
  const price = num(t.tradedPrice);
  return {
    id: str(t.exchangeTradeId ?? t.tradeId), orderId: str(t.orderId), time: clockOf(t.exchangeTime ?? t.createTime ?? t.updateTime),
    symbol: str(t.tradingSymbol), side: side(t.transactionType), qty: num(t.tradedQuantity) ?? 0,
    price: price && price > 0 ? price : null, product: str(t.productType).toUpperCase(),
  };
}

/** Newest first, by the clock (every book is today's); rows without a time keep their order at the end. */
export function newestFirst<T extends { time: string }>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (b.r.time || '').localeCompare(a.r.time || '') || a.i - b.i).map(x => x.r);
}

export interface DaySummary {
  realised: number; unrealised: number; total: number; unpriced: number; open: number; closed: number;
  winners: number; losers: number; trades: number; buyValue: number; sellValue: number;
  orders: { total: number; done: number; open: number; rejected: number; cancelled: number };
  /** Per symbol, worst first, so the rows that hurt are on top. */
  bySymbol: { symbol: string; realised: number; unrealised: number | null; total: number; open: boolean }[];
}

/** The day's P&L and activity from the three books. */
export function daySummary(positions: PositionRow[], orders: OrderRow[], trades: TradeRow[]): DaySummary {
  let realised = 0, unrealised = 0, unpriced = 0;
  const sym = new Map<string, { realised: number; unrealised: number | null; open: boolean }>();
  for (const p of positions) {
    realised += p.realised ?? 0;
    if (p.open && p.unrealised === null) unpriced++;
    unrealised += p.unrealised ?? 0;
    const cur = sym.get(p.symbol) ?? { realised: 0, unrealised: 0, open: false };
    cur.realised += p.realised ?? 0;
    cur.unrealised = cur.unrealised === null || (p.open && p.unrealised === null) ? null : cur.unrealised + (p.unrealised ?? 0);
    cur.open ||= p.open;
    sym.set(p.symbol, cur);
  }
  const bySymbol = [...sym].map(([symbol, v]) => ({ symbol, ...v, total: v.realised + (v.unrealised ?? 0) })).sort((a, b) => a.total - b.total);
  const closedRows = bySymbol.filter(s => !s.open);
  const count = (s: OrderState) => orders.filter(o => o.state === s).length;
  return {
    realised, unrealised, total: realised + unrealised, unpriced,
    open: positions.filter(p => p.open).length, closed: closedRows.length,
    winners: closedRows.filter(s => s.total > 0).length, losers: closedRows.filter(s => s.total < 0).length,
    trades: trades.length,
    buyValue: trades.filter(t => t.side === 'BUY').reduce((s, t) => s + t.qty * (t.price ?? 0), 0),
    sellValue: trades.filter(t => t.side === 'SELL').reduce((s, t) => s + t.qty * (t.price ?? 0), 0),
    orders: { total: orders.length, done: count('done'), open: count('open'), rejected: count('rejected'), cancelled: count('cancelled') },
    bySymbol,
  };
}
