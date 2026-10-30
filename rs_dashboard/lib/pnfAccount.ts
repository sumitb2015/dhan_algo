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
