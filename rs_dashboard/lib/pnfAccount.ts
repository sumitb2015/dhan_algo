// The P&F header's account figures (read-only): available margin formatting and the day P&L of a positions book.
import { scaleBrokerPnl } from './positionPnl.ts';

export function fmtFunds(v: number): string {
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)}Cr`;
  if (v >= 100_000) return `₹${(v / 100_000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

export type Book = { total: number; realised: number; unrealised: number; unpriced: number };

/**
 * The account P&L from a positions book (rows already normalised by the broker's route). MCX rows go through scaleBrokerPnl
 * (Dhan reports MCX P&L per lot); realised is never derived as total minus unrealised. `unpriced` counts open legs with no
 * price (a Kotak leg the server could not join to a live quote): their unrealised P&L is unknown, not zero.
 */
export function bookPnl(rows: Array<Record<string, unknown>>): Book {
  let realised = 0, unrealised = 0, unpriced = 0;
  for (const raw of rows) {
    const p = scaleBrokerPnl(raw);
    const r = Number(p.realizedProfit);
    const u = Number(p.unrealizedProfit);
    realised += Number.isFinite(r) ? r : 0;
    unrealised += Number.isFinite(u) ? u : 0;
    const open = Number(p.netQty) !== 0 && Number.isFinite(Number(p.netQty));
    const ltp = Number(p.lastTradedPrice ?? p.ltp ?? p.lastPrice);
    if (open && !(ltp > 0)) unpriced++;
  }
  return { total: realised + unrealised, realised, unrealised, unpriced };
}

/**
 * Fill in the open rows a broker sent WITHOUT a price (Kotak's position book has no LTP: every open leg comes back with
 * lastTradedPrice 0 and unrealizedProfit 0, so the header's day P&L was realised only - ₹1.4k shown on a ₹2.7k day, 2026-11-04)
 * from live prices the page already has: the charts' own feeds, keyed like the book (Kotak / Zerodha trading symbol, Dhan security
 * id). Unrealised = netQty x (price - the average of the open side), in the broker's own units (Kotak quantities are units /
 * barrels, so no lot multiplier). A row that already has a price or a broker unrealised figure, or has no usable average, is left as
 * it is. Callers use it for Kotak / Zerodha books only: a Dhan row carries Dhan's own unrealised (in lots on MCX).
 */
export function priceOpenRows(rows: Array<Record<string, unknown>>, bySymbol: boolean, prices: ReadonlyMap<string, number>): Array<Record<string, unknown>> {
  if (!prices.size) return rows;
  return rows.map(r => {
    const net = Number(r.netQty);
    if (!Number.isFinite(net) || net === 0) return r;
    if (Number(r.lastTradedPrice ?? r.ltp ?? r.lastPrice) > 0) return r;
    const u = Number(r.unrealizedProfit);
    if (Number.isFinite(u) && u !== 0) return r;                      // the broker priced it (Dhan: per lot on MCX, scaled later)
    const px = prices.get(String((bySymbol ? r.tradingSymbol : r.securityId) ?? ''));
    const avg = Number(net > 0 ? r.buyAvg : r.sellAvg);
    if (!(px !== undefined && px > 0) || !(avg > 0)) return r;
    return { ...r, lastTradedPrice: px, unrealizedProfit: Math.round(net * (px - avg) * 100) / 100 };
  });
}

/**
 * The chart's own position out of a positions book: signed LOTS per leg (summed over every product the contract is held
 * under) and the P&L of just those rows. Rows match on Dhan's security id, or the trading symbol on Kotak / Zerodha
 * (they have no numeric id). `lotUnits` is the broker quantity of one lot, so units become lots.
 */
export function legPositions(rows: Array<Record<string, unknown>>, bySymbol: boolean, keys: string[], lotUnits: number[]): { lots: number[]; book: Book } {
  const keyOf = (r: Record<string, unknown>) => String((bySymbol ? r.tradingSymbol : r.securityId) ?? '');
  const mine = rows.filter(r => keys.includes(keyOf(r)));
  const lots = keys.map((k, i) => {
    const net = mine.filter(r => keyOf(r) === k).reduce((s, r) => s + (Number(r.netQty) || 0), 0);
    return lotUnits[i] > 0 ? net / lotUnits[i] : 0;
  });
  return { lots, book: bookPnl(mine) };
}
