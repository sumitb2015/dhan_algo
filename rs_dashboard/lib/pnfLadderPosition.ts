// The open position of a P&F chart as the ladder rail shows it (entry line + live P&L chip), like the XY ladder's entry row.
// Pure (tested in lib/pnfLadderPosition.test.ts). One position per chart: a straddle counts only while both legs are open on
// the SAME side (a short straddle has both legs short); anything else is MIXED and carries no entry premium.
import { paperPnl, type PaperLeg } from './pnfOrderLogic.ts';
import { bookPnl } from './pnfAccount.ts';

export interface LadderPosition {
  side: 'LONG' | 'SHORT' | 'MIXED';
  /** Whole lots (the first leg's, a straddle's legs are always equal when not MIXED). */
  lots: number;
  /** The chart's entry price: a single leg's average, or a straddle's CE + PE averages. null when it is not known. */
  avg: number | null;
  /** Realised + open P&L in rupees on this chart's contracts; null when an open leg has no price. */
  pnl: number | null;
}

function sideOf(lots: number[]): 'LONG' | 'SHORT' | 'MIXED' | null {
  const open = lots.filter(l => l !== 0);
  if (open.length === 0) return null;
  if (open.length < lots.length) return 'MIXED';
  return open.every(l => l > 0) ? 'LONG' : open.every(l => l < 0) ? 'SHORT' : 'MIXED';
}

/** PAPER: from the page's paper ledger. `prices` are the live leg prices, `unitsPerLot` rupees per point per lot. */
export function paperPosition(legs: PaperLeg[], prices: (number | null)[], unitsPerLot: number[]): LadderPosition | null {
  const side = sideOf(legs.map(l => l.lots));
  if (!side) return null;
  const open = legs.some((l, i) => l.lots !== 0 && !(prices[i] != null && (prices[i] as number) > 0));
  return {
    side, lots: Math.abs(legs[0].lots),
    avg: side === 'MIXED' ? null : legs.reduce((s, l) => s + l.avg, 0),
    pnl: open ? null : paperPnl(legs, prices, unitsPerLot),
  };
}

/**
 * REAL: from the broker's positions book. `keys` are the chart's contracts (Dhan security id, or the trading symbol on Kotak /
 * Zerodha), `lots` the signed lots per leg (lib/pnfAccount legPositions). The entry premium is the broker's own buy / sell
 * average for the side the leg is open on.
 *
 * `chart`: the chart's own live leg prices and rupees per point per lot. Kotak's book carries no live price (lastTradedPrice 0),
 * so the broker cannot value the open legs; the P&L is then the book's realised P&L plus each open leg valued at the chart's
 * price against the broker's average. Without a price for every open leg it stays null (unknown, never a made-up 0).
 */
export function realPosition(
  rows: Array<Record<string, unknown>>, bySymbol: boolean, keys: string[], lots: number[], book: ReturnType<typeof bookPnl>,
  chart?: { prices: (number | null)[]; unitsPerLot: number[] },
): LadderPosition | null {
  const side = sideOf(lots);
  if (!side) return null;
  // Each leg's broker average for the side it is open on (null: flat, or no average reported)
  const legAvg = keys.map((k, i) => {
    if (lots[i] === 0) return null;
    const mine = rows.filter(r => String((bySymbol ? r.tradingSymbol : r.securityId) ?? '') === k);
    const a = Number(mine.find(r => (Number(r.netQty) || 0) !== 0)?.[lots[i] > 0 ? 'buyAvg' : 'sellAvg']);
    return a > 0 ? a : null;
  });
  const avg = side === 'MIXED' || legAvg.some((a, i) => lots[i] !== 0 && a === null) ? null : legAvg.reduce<number>((s, a) => s + (a ?? 0), 0);
  let pnl: number | null = book.unpriced > 0 ? null : book.total;
  if (pnl === null && chart) {
    let open = 0, priced = true;
    keys.forEach((_, i) => {
      if (lots[i] === 0) return;
      const px = chart.prices[i], a = legAvg[i], u = chart.unitsPerLot[i];
      if (px != null && px > 0 && a !== null && u > 0) open += lots[i] * u * (px - a);
      else priced = false;
    });
    if (priced) pnl = Math.round((book.realised + open) * 100) / 100;
  }
  return { side, lots: Math.abs(lots[0]), avg, pnl };
}
